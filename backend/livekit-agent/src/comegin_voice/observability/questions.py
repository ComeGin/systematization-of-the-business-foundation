"""E-12 の「問い（要約）」を作る（Wave 3 のリードの判断。2026-11-21）。

E-12 は git に入るので、発話をそのまま書かない。

1. 会話中は、利用者の確定した発話（``conversation_item_added`` の role が user の ``ChatMessage``）を
   **メモリだけ**に溜める（50 件・各 300 字まで）。ログには出さない。GPT-Live では、利用者の発話の確定した書き起こしが
   ``ChatMessage(role="user")`` として会話に足され、このイベントが出る（livekit-agents 1.8.8 の
   ``voice/agent_activity.py`` の書き起こしの処理）。画面のチャット欄の文も同じ経路で入る。
2. 終了時に、溜めた発話を OpenAI Responses に 1 回だけ渡し、SEO・アクセス解析の話題を短い句で最大 10 個にまとめさせる。
   人名・会社名・メール・電話・URL のクエリ文字列は含めさせない。
3. 失敗したら空のまま返し、警告を 1 回出すだけにする（E-12 の書き出しは止めない）。

最後に ``audit.py`` の ``_redact``（メール・電話を伏せ、長さを絞る）がかかる。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import TYPE_CHECKING

from livekit.agents import ConversationItemAddedEvent, llm
from openai import AsyncOpenAI

if TYPE_CHECKING:
    from livekit.agents import AgentSession

    from comegin_voice.config.settings import Settings

logger = logging.getLogger(__name__)

MAX_UTTERANCES = 50
MAX_UTTERANCE_CHARS = 300
MAX_TOPICS = 10
_TOPIC_MAX_CHARS = 60
_TIMEOUT_SECONDS = 15.0

_INSTRUCTIONS = """\
あなたは、音声の対話の記録から、話題の一覧だけを取り出す担当です。
入力は、SEO とアクセス解析について担当者が話した発話の列（JSON の文字列の配列）です。
出力の決まり:
- SEO・検索の実績・アクセス解析・サイトの改善に関する話題だけを、短い日本語の句（体言止め。30 字以内）で最大 10 個にまとめます。
- 人名・会社名（自社の名前も含む）・メールアドレス・電話番号・URL のクエリ文字列を含めません。
- 発話を引用せず、要約した句にします。数値は含めません。
- 話題が無ければ空の配列にします。
- 出力は JSON の文字列の配列だけにします。説明・前置き・コードの囲みを付けません。
"""

# 句に紛れ込んではいけないもの（モデルが決まりを破ったときに落とす）
_FORBIDDEN = re.compile(r"@|https?://|www\.|\?[^\s]*=|\d{2,4}-\d{2,4}-\d{3,4}")
_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$")


class UtteranceBuffer:
    """利用者の確定した発話を、メモリだけに溜める。中身はログに出さない。"""

    def __init__(self) -> None:
        self._items: list[str] = []

    def attach(self, session: AgentSession) -> None:
        session.on("conversation_item_added", self._on_item_added)

    def _on_item_added(self, ev: ConversationItemAddedEvent) -> None:
        item = ev.item
        if not isinstance(item, llm.ChatMessage) or item.role != "user":
            return
        if len(self._items) >= MAX_UTTERANCES:
            return
        text = " ".join((item.text_content or "").split())
        if text:
            self._items.append(text[:MAX_UTTERANCE_CHARS])

    @property
    def items(self) -> list[str]:
        return list(self._items)


def _parse_topics(text: str) -> list[str]:
    """モデルの出力を JSON の文字列の配列として読む。形が違えば ValueError。"""
    data = json.loads(_FENCE.sub("", text.strip()))
    if not isinstance(data, list) or not all(isinstance(v, str) for v in data):
        raise ValueError("JSON の文字列の配列ではない")
    topics: list[str] = []
    for value in data:
        topic = " ".join(value.split())
        if not topic or _FORBIDDEN.search(topic):
            continue
        topics.append(topic[:_TOPIC_MAX_CHARS])
        if len(topics) >= MAX_TOPICS:
            break
    return topics


async def summarize_questions(utterances: list[str], settings: Settings) -> list[str]:
    """発話の列を、話題の短い句（最大 10 個）にまとめる。失敗したら警告を 1 回出して空を返す。"""
    if not utterances:
        return []
    try:
        async with AsyncOpenAI(
            api_key=settings.openai_api_key.get_secret_value(),
            timeout=_TIMEOUT_SECONDS,
            max_retries=0,
        ) as client:
            response = await asyncio.wait_for(
                client.responses.create(
                    model=settings.backend_model,
                    instructions=_INSTRUCTIONS,
                    input=json.dumps(utterances, ensure_ascii=False),
                    reasoning={"effort": "low"},
                    store=False,
                ),
                timeout=_TIMEOUT_SECONDS,
            )
        return _parse_topics(response.output_text)
    except Exception as exc:
        # 発話の中身・応答の中身は出さない（例外の種類だけ）
        logger.warning(
            "問いの要約を作れなかったため、E-12 の問いは空にします",
            extra={"error": type(exc).__name__},
        )
        return []
