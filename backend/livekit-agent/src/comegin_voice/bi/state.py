"""1 セッション（1 回の音声の接続）の BI の状態。

状態はコードが持つ（D1）。モデルの記憶に頼らず、ツールの結果は台帳（``results``）に
``result_id`` 付きで残す。画面のカードと E-12（``source: voice``）は、この ``result_id`` で
数値の出どころを指す。

1 つのイベントループの中だけで使う（ロックは持たない）。
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def new_ulid() -> str:
    """ULID（26 文字。先頭 48 ビットがミリ秒の時刻、残り 80 ビットが乱数）を作る。

    依存を増やさないため自前で作る。E-12 の ``fetch.correlation_id`` に使う。
    """
    value = (int(time.time() * 1000) & ((1 << 48) - 1)) << 80
    value |= int.from_bytes(os.urandom(10), "big")
    chars = []
    for _ in range(26):
        chars.append(_CROCKFORD[value & 0x1F])
        value >>= 5
    return "".join(reversed(chars))


@dataclass
class ToolResultRecord:
    """台帳の 1 行。数値の出どころ（どのツールを、どの引数で、いつ呼んだか）。"""

    result_id: str
    tool: str
    args: dict[str, Any]
    ok: bool
    summary: dict[str, Any]
    """圧縮した事実（モデルに返したものと同じ。大きな表は上位の行だけ）。失敗なら outcome と reason。"""
    at: datetime


@dataclass
class BiSessionState:
    session_id: str
    """ULID。E-12 の ``fetch.correlation_id`` に使う。"""
    project_id: str | None
    started_at: datetime
    results: list[ToolResultRecord] = field(default_factory=list)
    questions: list[str] = field(default_factory=list)
    tool_calls: int = 0
    """OpenSEO を呼んだ回数（W1 と W2 の合計。D11 の上限 ``max_tool_calls`` と比べる）。"""
    _result_seq: int = field(default=0, repr=False)

    @classmethod
    def create(cls, project_id: str | None = None) -> BiSessionState:
        """新しいセッションの状態を作る（session_id は ULID、started_at は UTC の今）。"""
        return cls(
            session_id=new_ulid(),
            project_id=project_id,
            started_at=datetime.now(timezone.utc),
        )

    def next_result_id(self) -> str:
        """台帳の次の ID（``res_001`` から順に振る。セッションの中で一意）。"""
        self._result_seq += 1
        return f"res_{self._result_seq:03d}"

    def record(
        self,
        tool: str,
        args: dict[str, Any],
        *,
        ok: bool,
        summary: dict[str, Any],
        result_id: str | None = None,
    ) -> ToolResultRecord:
        """台帳に 1 行を足して返す。``result_id`` を省くと新しく振る。"""
        record = ToolResultRecord(
            result_id=result_id or self.next_result_id(),
            tool=tool,
            args=dict(args),
            ok=ok,
            summary=summary,
            at=datetime.now(timezone.utc),
        )
        self.results.append(record)
        return record

    def find(self, result_id: str) -> ToolResultRecord | None:
        for record in self.results:
            if record.result_id == result_id:
                return record
        return None
