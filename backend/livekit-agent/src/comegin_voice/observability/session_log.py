"""セッションの使用量と、ツールの呼び出しの要約をログに出す（D11）。

GPT-Live の声のモデルはセッションの時間で、裏のモデルはトークンで課金される。
声の使用量は約 1 分ごと、最後の分は閉じたときにだけ届くので、終了時のコールバックで読む
（livekit-docs ``/agents/models/realtime/gpt-live`` の Pricing and usage）。

ログには数と名前だけを出す。問いの文・ツールの引数・結果の中身・秘密の値は出さない。
"""

from __future__ import annotations

import logging
from collections import Counter
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from livekit.agents import AgentSession

    from comegin_voice.bi.state import BiSessionState

logger = logging.getLogger(__name__)


def tool_summary(state: BiSessionState) -> dict[str, Any]:
    """台帳から、ツールごとの成功・失敗の数を数える（ログと E-12 で共通に使う）。"""
    ok: Counter[str] = Counter()
    failed: Counter[str] = Counter()
    for record in state.results:
        (ok if record.ok else failed)[record.tool] += 1
    return {
        "tool_calls": state.tool_calls,
        "results_ok": sum(ok.values()),
        "results_failed": sum(failed.values()),
        "tools_ok": dict(ok),
        "tools_failed": dict(failed),
    }


def log_usage(session: AgentSession, state: BiSessionState) -> None:
    """``session.usage`` とツールの要約を stderr の構造化ログに出す。失敗しても例外を投げない。"""
    elapsed = (datetime.now(timezone.utc) - state.started_at).total_seconds()
    try:
        usages = [
            usage.model_dump(exclude_defaults=True)
            for usage in session.usage.model_usage
        ]
    except Exception:
        logger.warning("使用量を読めませんでした", exc_info=True)
        usages = []

    for usage in usages:
        logger.info(
            "モデルの使用量",
            extra={"session_id": state.session_id, "usage": usage},
        )
    logger.info(
        "セッションの要約",
        extra={
            "session_id": state.session_id,
            "project_resolved": state.project_id is not None,
            "elapsed_seconds": round(elapsed, 1),
            "questions": len(state.questions),
            **tool_summary(state),
        },
    )
