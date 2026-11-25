"""画面のカード（エージェント ⇔ 監視アプリ ``/voice`` の契約。spec の 5.5）。

カードの数値は、すべて OpenSEO のツールの実際の結果から作る（D4。モデルが数値を作って描くツールは無い）。
``result_id`` は台帳（``BiSessionState.results``）の行を指す。

``data`` の読み方（画面の ``BiCardList`` と揃える。知らない ``kind`` は表として描く）:

- ``kpi``: ``columns = ["指標", "今期", "前期", "増減率"]``。1 行が 1 つの指標。
  増減率は 0.1 = +10% の数値（前期が無ければ null）。
- ``table``: 先頭の列から順に表にする。
- ``line``: 先頭の列が横軸（日付・週）、2 列目以降が系列。
- ``bar``: 先頭の列が分類、2 列目以降が系列。

セルは文字列・数値・null だけ。CTR・率は 0〜1 の小数のまま送り、表示の形は画面が決める。

送信は text stream（topic ``comegin.bi.card``。``room.local_participant.send_text``）。
1 枚は 15 KB まで。超えるときは行を上位 20 行に切って ``truncated: true`` を付ける。
"""

from __future__ import annotations

import logging
import uuid
from typing import TYPE_CHECKING, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field

if TYPE_CHECKING:
    from livekit import rtc

logger = logging.getLogger("comegin_voice.cards")

CARD_TOPIC = "comegin.bi.card"
CARD_MAX_BYTES = 15 * 1024
CARD_TRUNCATED_ROWS = 20

CardKind = Literal["kpi", "table", "line", "bar"]
Cell = str | int | float | None


class ComparePeriod(BaseModel):
    model_config = ConfigDict(frozen=True)

    start: str
    """YYYY-MM-DD"""
    end: str


class Period(BaseModel):
    model_config = ConfigDict(frozen=True)

    start: str
    """YYYY-MM-DD"""
    end: str
    compare: ComparePeriod | None = None


class CardData(BaseModel):
    model_config = ConfigDict(frozen=True)

    columns: list[str]
    rows: list[list[Cell]] = Field(default_factory=list)


class Card(BaseModel):
    model_config = ConfigDict(frozen=True)

    v: Literal[1] = 1
    id: str
    kind: CardKind
    title: str
    period: Period
    source_tool: str
    result_id: str
    data: CardData
    truncated: bool = False

    def to_json(self) -> str:
        # compare が無いときは送らない（画面は compare の有無で前期の表示を切り替える）
        return self.model_dump_json(exclude_none=True)


def new_card_id() -> str:
    return f"crd_{uuid.uuid4().hex[:12]}"


def make_card(
    *,
    kind: CardKind,
    title: str,
    period: Period,
    source_tool: str,
    result_id: str,
    columns: list[str],
    rows: list[list[Cell]],
) -> Card:
    """カードを作り、15 KB に収める。"""
    card = Card(
        id=new_card_id(),
        kind=kind,
        title=title,
        period=period,
        source_tool=source_tool,
        result_id=result_id,
        data=CardData(columns=columns, rows=rows),
    )
    return fit_card(card)


def _size(card: Card) -> int:
    return len(card.to_json().encode("utf-8"))


def fit_card(card: Card) -> Card:
    """15 KB に収める。超えるときは上位 20 行に切り、それでも超えるなら行を半分ずつ減らす。"""
    if _size(card) <= CARD_MAX_BYTES:
        return card
    rows = card.data.rows[:CARD_TRUNCATED_ROWS]
    while True:
        fitted = card.model_copy(
            update={
                "data": CardData(columns=card.data.columns, rows=rows),
                "truncated": True,
            }
        )
        if _size(fitted) <= CARD_MAX_BYTES or not rows:
            return fitted
        rows = rows[: len(rows) // 2]


class CardSink(Protocol):
    async def send(self, card: Card) -> None: ...


class RoomCardSink:
    """ルームの全員にカードを送る。送れなくても例外を投げずにログだけ出す。

    カードは補助の出力で、送れなくても音声の対話は続けられるため（数値は声でも伝わる）。
    """

    def __init__(self, room: rtc.Room) -> None:
        self._room = room

    async def send(self, card: Card) -> None:
        try:
            await self._room.local_participant.send_text(
                card.to_json(), topic=CARD_TOPIC
            )
        except Exception as e:
            logger.warning(
                "カードを送れなかった",
                extra={
                    "card_id": card.id,
                    "result_id": card.result_id,
                    "error": type(e).__name__,
                },
            )


class NullCardSink:
    """何も送らない（画面が無いときの差し替え用）。"""

    async def send(self, card: Card) -> None:
        return None
