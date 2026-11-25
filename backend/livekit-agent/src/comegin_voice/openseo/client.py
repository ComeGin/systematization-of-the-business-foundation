"""W1（ブリーフィング）とプロジェクトの解決に使う OpenSEO の MCP クライアント。

- 接続は Streamable HTTP（``127.0.0.1:3001/mcp``。``local_noauth`` なので認証は無い。spec の C6）。
- MCP の Python SDK v2（``livekit-agents[mcp]`` の依存）の ``streamable_http_client`` と
  ``ClientSession`` を使う。使い方は livekit-agents の ``MCPServerHTTP`` と同じ。
- **呼び出しごとに接続を張って閉じる。** W1 は数本を並列に 1 回呼ぶだけで、ループバックなので
  初期化の往復は軽い。長く張ったままにすると、OpenSEO の再起動で切れた接続の張り直しを
  自前で持つことになるため、持たない。
- 許可リスト（``allowlist.ALLOWED_TOOLS``）に無いツールは**送らずに**例外にする。
- 失敗は ``OpenSeoError`` の ``outcome`` で種類を分ける。呼び出し側はそれで話し方を変える
  （「OpenSEO に届かない」「Search Console が未接続」など）。
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Literal

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.exceptions import MCPError

from .allowlist import ALLOWED_TOOLS

logger = logging.getLogger("comegin_voice.openseo")

OpenSeoOutcome = Literal[
    "unreachable",  # OpenSEO に届かない（止まっている・ポートが違う）
    "timeout",  # 時間内に応答が無い
    "invalid_response",  # 応答の形が想定と違う（structuredContent が無いなど）
    "tool_error",  # ツールが失敗を返した（GSC・GA4 が未接続、上流のエラーなど）
    "not_allowed",  # 許可リストに無いツール（送っていない）
    "project_not_found",  # 対象のドメインのプロジェクトが無い
    "project_ambiguous",  # 対象のドメインのプロジェクトが複数ある
    "closed",  # aclose の後に呼ばれた
]


class OpenSeoError(Exception):
    """OpenSEO の呼び出しの失敗。

    ``outcome`` は失敗の種類、``reason`` は OpenSEO が返した理由のコード
    （GSC の ``not_connected``、GA4 の ``ga4_not_connected`` など。無ければ ``None``）。
    メッセージには秘密の値を含めない（OpenSEO は認証を持たないので、そもそも無い）。
    """

    def __init__(
        self,
        outcome: OpenSeoOutcome,
        message: str,
        *,
        tool: str | None = None,
        reason: str | None = None,
    ) -> None:
        super().__init__(message)
        self.outcome: OpenSeoOutcome = outcome
        self.tool = tool
        self.reason = reason

    def __str__(self) -> str:
        head = f"[{self.outcome}]"
        if self.tool:
            head += f" {self.tool}"
        if self.reason:
            head += f" ({self.reason})"
        return f"{head}: {self.args[0] if self.args else ''}"


def normalize_domain(value: object) -> str:
    """ドメインの表記をそろえる（スキーム・www・パスを落として小文字に）。setup の normalizeDomain と同じ。"""
    text = str(value or "").strip().lower()
    text = re.sub(r"^https?://", "", text)
    text = re.sub(r"^www\.", "", text)
    return re.sub(r"/.*$", "", text)


def tool_failure_reason(structured: dict[str, Any]) -> str | None:
    """structuredContent が失敗を表していれば、その理由のコードを返す。成功なら ``None``。

    OpenSEO の封筒は 2 種類ある。
    - GSC（``get_search_console_performance``・``inspect_urls``）: ``ok: false`` と ``reason``
    - GA4（``get_google_analytics_*``・``get_search_opportunities``）: ``status: "error"`` と ``error.code``
    """
    if structured.get("status") == "error":
        error = structured.get("error")
        if isinstance(error, dict):
            return str(error.get("code") or "error")
        return "error"
    if structured.get("ok") is False:
        return str(structured.get("reason") or "error")
    return None


def _walk_exceptions(exc: BaseException) -> list[BaseException]:
    """ExceptionGroup（anyio のタスクグループが投げる）をほどいて並べる。"""
    nested = getattr(exc, "exceptions", None)
    if isinstance(nested, (list, tuple)):
        out: list[BaseException] = []
        for item in nested:
            out.extend(_walk_exceptions(item))
        return out
    return [exc]


def _classify(exc: BaseException) -> OpenSeoOutcome:
    for item in _walk_exceptions(exc):
        name = type(item).__name__
        module = type(item).__module__
        if isinstance(item, TimeoutError) or "Timeout" in name:
            return "timeout"
        if isinstance(item, (ConnectionError, OSError)) or (
            module.startswith("httpx") and ("Connect" in name or "Network" in name)
        ):
            return "unreachable"
    return "unreachable"


class OpenSeoClient:
    """OpenSEO の MCP を呼ぶ。1 セッション（1 回の音声の接続）に 1 つ作る。"""

    def __init__(self, url: str, *, timeout_s: float = 20.0) -> None:
        self._url = url
        self._timeout_s = timeout_s
        self._closed = False

    @property
    def url(self) -> str:
        return self._url

    async def call(self, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        """ツールを 1 回呼び、structuredContent（dict）を返す。

        失敗（届かない・時間切れ・ツールの失敗・形の違い・許可リストに無い）はすべて
        ``OpenSeoError`` にする。ツールの失敗は ``outcome="tool_error"`` で、``reason`` に
        OpenSEO の理由のコードが入る。
        """
        if self._closed:
            raise OpenSeoError("closed", "クライアントは閉じられている", tool=tool)
        if tool not in ALLOWED_TOOLS:
            # 送る前に止める。費用の出るツール・書き込むツールを誤って呼ばないため（D3）
            raise OpenSeoError("not_allowed", "許可リストに無いツール", tool=tool)

        try:
            result = await asyncio.wait_for(
                self._call_once(tool, args), timeout=self._timeout_s
            )
        except OpenSeoError:
            raise
        except asyncio.TimeoutError as e:
            raise OpenSeoError(
                "timeout", f"{self._timeout_s:.0f} 秒以内に応答が無い", tool=tool
            ) from e
        except MCPError as e:
            # JSON-RPC のエラー（引数の検証の失敗など）。OpenSEO には届いている
            raise OpenSeoError(
                "tool_error", f"MCP のエラー: {str(e)[:300]}", tool=tool
            ) from e
        except asyncio.CancelledError:
            raise
        except Exception as e:
            outcome = _classify(e)
            logger.warning(
                "OpenSEO の呼び出しに失敗した",
                extra={"tool": tool, "outcome": outcome, "error": type(e).__name__},
            )
            raise OpenSeoError(
                outcome, f"OpenSEO に接続できない（{type(e).__name__}）", tool=tool
            ) from e

        if result.is_error:
            text = "\n".join(
                getattr(part, "text", "") for part in result.content if part
            ).strip()
            raise OpenSeoError(
                "tool_error", text[:300] or "ツールがエラーを返した", tool=tool
            )

        structured = result.structured_content
        if not isinstance(structured, dict):
            raise OpenSeoError(
                "invalid_response",
                "structuredContent が無い（OpenSEO の版が変わっていないか確かめる）",
                tool=tool,
            )

        reason = tool_failure_reason(structured)
        if reason is not None:
            message = ""
            error = structured.get("error")
            if isinstance(error, dict):
                message = str(error.get("message") or "")
            raise OpenSeoError(
                "tool_error",
                message or "ツールが失敗を返した",
                tool=tool,
                reason=reason,
            )
        return structured

    async def _call_once(self, tool: str, args: dict[str, Any]) -> Any:
        # セッションは transport の streams を使うので、transport より先に閉じる（外側から順に入る）
        async with (
            streamable_http_client(url=self._url) as streams,
            ClientSession(
                streams[0], streams[1], read_timeout_seconds=self._timeout_s
            ) as session,
        ):
            await session.initialize()
            return await session.call_tool(tool, args)

    async def resolve_project_id(self, domain: str) -> str:
        """``list_projects`` から、ドメインが一致するプロジェクトの id を 1 つ選ぶ。

        0 件は ``project_not_found``、2 件以上は ``project_ambiguous``（どれか 1 つを推測で選ばない。
        analytics-reporter・seo-auditor と同じ判断）。プロジェクトは作らない。
        """
        structured = await self.call("list_projects", {})
        projects = structured.get("projects")
        if not isinstance(projects, list):
            raise OpenSeoError(
                "invalid_response", "projects が無い", tool="list_projects"
            )
        want = normalize_domain(domain)
        matched = [
            p
            for p in projects
            if isinstance(p, dict) and normalize_domain(p.get("domain")) == want
        ]
        if not matched:
            raise OpenSeoError(
                "project_not_found",
                f"ドメイン {want} のプロジェクトが無い（{len(projects)} 件中）",
                tool="list_projects",
            )
        if len(matched) > 1:
            raise OpenSeoError(
                "project_ambiguous",
                f"ドメイン {want} のプロジェクトが {len(matched)} 件ある",
                tool="list_projects",
            )
        project_id = matched[0].get("id")
        if not isinstance(project_id, str) or not project_id:
            raise OpenSeoError(
                "invalid_response", "プロジェクトの id が無い", tool="list_projects"
            )
        return project_id

    async def aclose(self) -> None:
        """以後の呼び出しを断る。呼び出しごとに接続を閉じているので、持っている資源は無い。"""
        self._closed = True
