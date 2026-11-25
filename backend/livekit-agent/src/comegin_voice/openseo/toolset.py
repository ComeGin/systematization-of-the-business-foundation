"""W2（質疑）でモデルに渡す OpenSEO の MCPToolset。

- ``MCPServerHTTP(allowed_tools=MODEL_TOOLS)`` で、モデルに見せるツールを許可リストの 11 本に絞る（D2・D3）。
- ``tool_result_resolver`` が結果ごとに次の 3 つを行う（D4）。
  1. 台帳（``BiSessionState.results``）に ``result_id`` 付きで記録する。
  2. 画面のカードを作って ``sink`` に送る（数値は結果からそのまま写す）。
  3. モデルには圧縮した事実の JSON を返す（大きな表は上位の行だけ）。
- 呼び出しの回数（W1 と合わせて 1 セッション ``max_tool_calls`` 回まで。D11）は、
  **呼ぶ前に**数えて止める。resolver は呼んだ後にしか動かず、それでは GA4 の割り当てを
  使ってしまうため、``MCPServerHTTP`` の ``_call_tool`` を包む（下の注意）。

注意: ``_call_tool(self, name, arguments, *, progress_callback=None)`` は livekit-agents の
非公開のメソッドである（1.8.8 と 1.8.13 のソースで、同じ署名であることと、``is_error`` の結果では
resolver が呼ばれないことを確かめた。2026-11-21）。版を上げて名前が
変わると包みが効かなくなるので、その場合は resolver が回数を数えて（呼んだ後に）エラーの文字列を
返す。包みが効いているかは ``_GuardedOpenSeoServer.guard_active`` で分かる。起動時（
``build_openseo_toolset``）に ``_call_tool`` の署名を確かめ、違えば logger.error を出す（止めはしない）。

projectId は包みの中で、セッションの開始時に決めたもの（``state.project_id``）に強制する。
モデルが別の ID を渡すと、別のサイトの数値を comegin.com の数値として話してしまうため。
"""

from __future__ import annotations

import inspect
import json
import logging
from datetime import datetime
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from livekit.agents import mcp
from livekit.agents.llm import ToolError

from comegin_voice.bi.presenters import cards_for_result, compress_result
from comegin_voice.bi.state import BiSessionState
from comegin_voice.visual_output.cards import CardSink

from .allowlist import MODEL_TOOLS
from .client import tool_failure_reason

if TYPE_CHECKING:
    from mcp.types import CallToolResult

    from comegin_voice.config.settings import Settings

logger = logging.getLogger("comegin_voice.openseo.toolset")

TOOLSET_ID = "openseo"
MODEL_RESULT_CHAR_LIMIT = 6000
"""モデルに返す JSON の文字数の上限。超えるときは表の行を半分ずつ減らす。"""
CALL_TIMEOUT_S = 30.0
"""1 回の呼び出しの待ち時間（GA4 の概要は 3 本のレポートを内部で並列に呼ぶので、既定の 5 秒では足りない）。"""

_JST = ZoneInfo("Asia/Tokyo")

LIMIT_MESSAGE = (
    "このセッションで OpenSEO を呼べる回数の上限（{max} 回）に達した。"
    "これ以上ツールを呼ばず、ここまでの結果（result_id の付いた数値）だけで答える。"
    "足りない分は「今回は取得の上限に達した」と伝え、推測で数値を言わない。"
)
FAILURE_INSTRUCTION = "この結果の数値は無い。失敗したことを一度だけ伝え、推測で数値を言わない。代わりの見方を提案してよい。"

_REDUCIBLE_LISTS = (
    "top_rows_by_clicks",
    "top_rows",
    "comparison_top_rows",
    "results",
    "trend",
    "striking_distance_4_20",
    "ctr_below_benchmark",
    "multiple_pages_per_query",
    "low_key_event_rate_pages",
    "sections",
)


def _dumps(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, default=str, separators=(",", ":"))


def fit_payload(payload: dict[str, Any], limit: int = MODEL_RESULT_CHAR_LIMIT) -> str:
    """JSON を上限の文字数に収める。表の行を半分ずつ減らし、それでも超えるなら切る。"""
    text = _dumps(payload)
    if len(text) <= limit:
        return text
    shrunk = dict(payload)
    for _ in range(8):
        changed = False
        for key in _REDUCIBLE_LISTS:
            value = shrunk.get(key)
            if isinstance(value, list) and len(value) > 1:
                shrunk[key] = value[: len(value) // 2]
                changed = True
        shrunk["rows_reduced"] = (
            "応答を短くするため表の行を減らした。全体は画面のカードにある"
        )
        text = _dumps(shrunk)
        if len(text) <= limit or not changed:
            break
    if len(text) > limit:
        text = (
            text[: limit - 20] + '…"}'
        )  # JSON としては壊れるが、モデルが読む文字列として扱う
    return text


class _GuardedOpenSeoServer(mcp.MCPServerHTTP):
    """呼ぶ前に許可リストと回数の上限を確かめ、失敗も台帳に残す MCPServerHTTP。"""

    def __init__(
        self,
        url: str,
        *,
        state: BiSessionState,
        max_tool_calls: int,
        resolver: mcp.MCPToolResultResolver,
    ) -> None:
        super().__init__(
            url,
            transport_type="streamable_http",
            allowed_tools=list(MODEL_TOOLS),
            client_session_timeout_seconds=CALL_TIMEOUT_S,
            tool_result_resolver=resolver,
        )
        self._state = state
        self._max_tool_calls = max_tool_calls
        self.guard_active = False
        self._project_override_warned = False

    def _enforce_project_id(self, name: str, arguments: dict[str, Any]) -> None:
        """arguments の projectId をセッションの projectId に置き換える（無ければ足す）。

        許可リストの 11 本はすべて projectId を取る。台帳と resolver が同じ dict を見るよう、
        その場で書き換える。
        """
        project_id = self._state.project_id
        if not project_id:
            # projectId が決まっていないセッションには、そもそも toolset を渡さない（agent.py）
            self._record_failure(
                name, arguments, "not_allowed", "projectId が決まっていない"
            )
            raise ToolError(
                "OpenSEO のプロジェクトが決まっていないため、ツールを呼べない。数値を言わない。"
            )
        given = arguments.get("projectId")
        if given != project_id:
            if given is not None and not self._project_override_warned:
                self._project_override_warned = True
                logger.warning(
                    "モデルが別の projectId を渡したので、セッションの projectId に置き換えた",
                    extra={"tool": name},
                )
            arguments["projectId"] = project_id

    def _record_failure(
        self, name: str, arguments: dict[str, Any], outcome: str, message: str
    ) -> str:
        record = self._state.record(
            name,
            arguments,
            ok=False,
            summary={"outcome": outcome, "message": message[:300]},
        )
        return record.result_id

    async def _call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        *,
        progress_callback: Any = None,
    ) -> CallToolResult:
        self.guard_active = True
        if name not in MODEL_TOOLS:
            # allowed_tools で一覧から外しているので来ないはず。来たら送らない
            self._record_failure(
                name, arguments, "not_allowed", "許可リストに無いツール"
            )
            raise ToolError(f"ツール {name} は使えない（許可リストに無い）。")
        self._enforce_project_id(name, arguments)
        if self._state.tool_calls >= self._max_tool_calls:
            self._record_failure(name, arguments, "limit", "呼び出しの上限")
            logger.warning(
                "OpenSEO の呼び出しの上限に達した",
                extra={"tool": name, "max_tool_calls": self._max_tool_calls},
            )
            raise ToolError(LIMIT_MESSAGE.format(max=self._max_tool_calls))
        self._state.tool_calls += 1
        try:
            result = await super()._call_tool(
                name, arguments, progress_callback=progress_callback
            )
        except ToolError as e:
            rid = self._record_failure(name, arguments, "tool_error", str(e))
            raise ToolError(f"[{rid}] {e} {FAILURE_INSTRUCTION}") from e
        except Exception as e:
            rid = self._record_failure(name, arguments, "unreachable", type(e).__name__)
            logger.warning(
                "OpenSEO の呼び出しに失敗した",
                extra={"tool": name, "error": type(e).__name__},
            )
            raise ToolError(
                f"[{rid}] OpenSEO から結果を取得できなかった（{type(e).__name__}）。{FAILURE_INSTRUCTION}"
            ) from e
        if result.is_error:
            # is_error のときは resolver が呼ばれない（ToolError になる）ので、ここで台帳に残す
            text = " ".join(getattr(p, "text", "") for p in result.content).strip()
            rid = self._record_failure(
                name, arguments, "tool_error", text or "is_error"
            )
            raise ToolError(f"[{rid}] {text[:300]} {FAILURE_INSTRUCTION}")
        return result


_EXPECTED_CALL_TOOL_PARAMS: tuple[tuple[str, inspect._ParameterKind], ...] = (
    ("self", inspect.Parameter.POSITIONAL_OR_KEYWORD),
    ("name", inspect.Parameter.POSITIONAL_OR_KEYWORD),
    ("arguments", inspect.Parameter.POSITIONAL_OR_KEYWORD),
    ("progress_callback", inspect.Parameter.KEYWORD_ONLY),
)


def check_call_tool_signature() -> bool:
    """包む先の ``MCPServerHTTP._call_tool`` が想定の署名か確かめる。違えば logger.error を出して False。"""
    method = getattr(mcp.MCPServerHTTP, "_call_tool", None)
    try:
        params = (
            tuple(
                (p.name, p.kind) for p in inspect.signature(method).parameters.values()
            )
            if method is not None
            else ()
        )
    except (TypeError, ValueError):
        params = ()
    if params != _EXPECTED_CALL_TOOL_PARAMS:
        logger.error(
            "MCPServerHTTP._call_tool の署名が想定と違う。上限・許可リスト・projectId の包みが効かない可能性がある"
            "（livekit-agents の版を確かめ、openseo/toolset.py を直す）",
            extra={"found": [name for name, _ in params]},
        )
        return False
    return True


def build_openseo_toolset(
    settings: Settings, state: BiSessionState, sink: CardSink
) -> mcp.MCPToolset:
    """W2 用の MCPToolset を作る。``Agent(tools=[...])`` に渡す。"""
    check_call_tool_signature()
    max_tool_calls = settings.max_tool_calls
    server: _GuardedOpenSeoServer | None = None

    async def resolve(ctx: mcp.MCPToolResultContext) -> str:
        if server is not None and not server.guard_active:
            # 包みが効いていない（livekit-agents の版の違い）。呼んだ後に数える
            state.tool_calls += 1
            if state.tool_calls > max_tool_calls:
                state.record(
                    ctx.tool_name,
                    ctx.arguments,
                    ok=False,
                    summary={"outcome": "limit", "message": "呼び出しの上限"},
                )
                return LIMIT_MESSAGE.format(max=max_tool_calls)

        structured = ctx.result.structured_content
        if not isinstance(structured, dict):
            record = state.record(
                ctx.tool_name,
                ctx.arguments,
                ok=False,
                summary={
                    "outcome": "invalid_response",
                    "message": "structuredContent が無い",
                },
            )
            return _dumps(
                {
                    "result_id": record.result_id,
                    "ok": False,
                    "reason": "invalid_response",
                    "instruction": FAILURE_INSTRUCTION,
                }
            )

        reason = tool_failure_reason(structured)
        if reason is not None:
            error = structured.get("error")
            message = str(error.get("message") or "") if isinstance(error, dict) else ""
            record = state.record(
                ctx.tool_name,
                ctx.arguments,
                ok=False,
                summary={
                    "outcome": "tool_error",
                    "reason": reason,
                    "message": message[:300],
                },
            )
            return _dumps(
                {
                    "result_id": record.result_id,
                    "ok": False,
                    "reason": reason,
                    "message": message[:300],
                    "instruction": FAILURE_INSTRUCTION,
                }
            )

        summary = compress_result(ctx.tool_name, structured)
        record = state.record(ctx.tool_name, ctx.arguments, ok=True, summary=summary)
        today = datetime.now(_JST).date()
        try:
            cards = cards_for_result(
                ctx.tool_name, structured, record.result_id, today=today
            )
        except Exception:
            # カードは補助。作れなくても事実はモデルに返す
            logger.exception("カードを作れなかった", extra={"tool": ctx.tool_name})
            cards = []
        for card in cards:
            await sink.send(card)

        payload: dict[str, Any] = {
            "result_id": record.result_id,
            "ok": True,
            "tool": ctx.tool_name,
            "cards_shown_on_screen": len(cards),
            **summary,
        }
        return fit_payload(payload)

    server = _GuardedOpenSeoServer(
        settings.openseo_mcp_url,
        state=state,
        max_tool_calls=max_tool_calls,
        resolver=resolve,
    )
    return mcp.MCPToolset(id=TOOLSET_ID, mcp_server=server)
