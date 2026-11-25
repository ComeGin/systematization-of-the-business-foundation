"""音声の対話を E-12（``source: voice``）として書き出す（D12。改善ループへの接続）。

書式は ``docs/audits/_template.md`` と ``docs/audits/README.md`` に合わせる。

- 置き場: ``VOICE_AUDIT_DIR``（監視アプリの作業ツリーの ``docs/audits/voice/``）。未設定なら書かない。
- ``audit_id``: ``AUD-<西暦>-<月日>-voice-<連番 4 桁>``（日付は JST）。連番は同じ日の最大値 + 1。
  音声のセッションは同時に複数ありうるので、排他的に作成（``open(..., "x")``）し、衝突したら次の番号にする。
- ``fetch.correlation_id``: セッションの ID（ULID。``BiSessionState.session_id``）。
- 書くのは、問いの要約・使ったツール・結果 ID・回数と、W1 の outcome・区分の見出し（コードが決めたカードの題）だけ。
  **個人情報・発話の全文・ツールの引数と結果の中身（クエリ・URL・数値）・W1 の事実の本文・秘密の値は書かない**。
  数値は結果 ID で参照する（proposal-writer が E-13 の根拠に使う）。
- 音声と映像は残さない。
"""

from __future__ import annotations

import json
import logging
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING
from zoneinfo import ZoneInfo

from comegin_voice.observability.session_log import tool_summary

if TYPE_CHECKING:
    from comegin_voice.bi.briefing import BriefingResult
    from comegin_voice.bi.state import BiSessionState
    from comegin_voice.config.settings import Settings

logger = logging.getLogger(__name__)

JST = ZoneInfo("Asia/Tokyo")
SOURCE = "voice"
CREATED_BY = "agent/voice-seo-bi"

# 連番の衝突（同時に終わったセッション）で作り直す回数の上限
_MAX_CREATE_ATTEMPTS = 20
# 問いの要約は、1 件の長さと件数を絞る（全文を残さないため）
_QUESTION_MAX_CHARS = 80
_QUESTION_MAX_ITEMS = 20

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_PHONE = re.compile(r"(?:\+?\d[\d\s-]{8,}\d)")

# OpenSEO の失敗の種類 → E-12 の fetch.outcome（README の列挙に無いものは近いものへ寄せ、元の値は note に残す）
_OUTCOME_MAP: dict[str, str] = {
    "unreachable": "unreachable",
    "timeout": "timeout",
    "invalid_response": "invalid_response",
    "closed": "unreachable",
    "tool_error": "invalid_response",
    "not_allowed": "permission_denied",
    "project_not_found": "invalid_response",
    "project_ambiguous": "invalid_response",
    "rate_limited": "rate_limited",
    # 1 セッションの呼び出しの上限（MAX_TOOL_CALLS。W1＋W2 の合計）に達して、呼ばずに止めた（openseo/toolset.py）
    "limit": "rate_limited",
}

_warned_no_dir = False


def _redact(text: str) -> str:
    """メールアドレスと電話番号らしいものを伏せ、改行を詰め、長さを絞る。"""
    text = _EMAIL.sub("[メール]", text)
    text = _PHONE.sub("[電話]", text)
    text = " ".join(text.split())
    if len(text) > _QUESTION_MAX_CHARS:
        text = text[: _QUESTION_MAX_CHARS - 1] + "…"
    return text


def _yaml_str(value: str) -> str:
    # JSON の文字列は YAML のダブルクオートの文字列としてそのまま読める
    return json.dumps(value, ensure_ascii=False)


def _outcome(state: BiSessionState, outcome_hint: str | None) -> tuple[str, str]:
    """E-12 の fetch.outcome と note を決める。"""
    if outcome_hint is not None:
        mapped = _OUTCOME_MAP.get(outcome_hint, "invalid_response")
        return (
            mapped,
            f"OpenSEO のプロジェクトを決められなかった（{outcome_hint}）。数値は取得していない",
        )
    if not state.results:
        return "empty_but_ok", ""
    failed = [record for record in state.results if not record.ok]
    if len(failed) < len(state.results):
        if failed:
            return (
                "ok",
                f"{len(state.results)} 件中 {len(failed)} 件のツールの呼び出しが失敗した",
            )
        return "ok", ""
    kinds = Counter(
        str(record.summary.get("outcome", "invalid_response")) for record in failed
    )
    kind, _ = kinds.most_common(1)[0]
    return _OUTCOME_MAP.get(
        kind, "invalid_response"
    ), f"ツールの呼び出しがすべて失敗した（{kind}）"


def _next_path(directory: Path, day: str) -> tuple[str, Path]:
    prefix = f"AUD-{day}-{SOURCE}-"
    highest = 0
    # 今日の分だけを見る（README の「Glob は今日の分・日付の範囲に絞る」）
    for path in directory.glob(f"{prefix}[0-9][0-9][0-9][0-9].md"):
        try:
            highest = max(highest, int(path.stem.removeprefix(prefix)))
        except ValueError:
            continue
    audit_id = f"{prefix}{highest + 1:04d}"
    return audit_id, directory / f"{audit_id}.md"


def _render(
    *,
    audit_id: str,
    state: BiSessionState,
    settings: Settings,
    ended_at: datetime,
    outcome: str,
    note: str,
    briefing: BriefingResult | None,
) -> str:
    summary = tool_summary(state)
    elapsed = max(0, int((ended_at - state.started_at).total_seconds()))
    questions = [_redact(q) for q in state.questions if q.strip()][:_QUESTION_MAX_ITEMS]
    ended_jst = ended_at.astimezone(JST).isoformat(timespec="seconds")
    started_jst = state.started_at.astimezone(JST).isoformat(timespec="seconds")
    project = state.project_id or ""
    target = f"OpenSEO project={project or '(未解決)'} domain={settings.openseo_project_domain}"

    lines = [
        "---",
        f"audit_id: {audit_id}",
        f"source: {SOURCE}",
        f"created_by: {CREATED_BY}",
        f"target_ref: {_yaml_str(target)}",
        f"measured_at: {ended_jst}",
        "metrics:",
        f"  VOICE-session-seconds: {elapsed}",
        f"  VOICE-tool-calls: {summary['tool_calls']}",
        f"  VOICE-tool-errors: {summary['results_failed']}",
        f"  VOICE-questions: {len(questions)}",
        "fetch:",
        f"  outcome: {outcome}",
        "  attempts: 1",
        f"  correlation_id: {state.session_id}",
        f"  measured_at: {ended_jst}",
        f"  note: {_yaml_str(note)}",
        "raw_ref: ''",
        "---",
        "",
        "# 音声の対話の記録",
        "",
        f"- セッションの開始: {started_jst}（長さ {elapsed // 60} 分 {elapsed % 60} 秒）",
        f"- 対象: {target}",
        "- 音声・映像・発話の全文は残していない。数値は下の結果 ID で参照する（ツールの結果は台帳にだけあり、ここには写さない）。",
        "",
        "## 問い（要約）",
        "",
    ]
    if questions:
        lines.extend(f"- {q}" for q in questions)
    else:
        lines.append("記録された問いはない。")

    lines += ["", "## 使ったツールと結果 ID", ""]
    if state.results:
        lines += ["| 結果 ID | ツール | 結果 |", "|---|---|---|"]
        for record in state.results:
            status = (
                "成功"
                if record.ok
                else f"失敗（{record.summary.get('outcome', '不明')}）"
            )
            lines.append(f"| `{record.result_id}` | `{record.tool}` | {status} |")
    else:
        lines.append("ツールは呼んでいない。")

    if briefing is not None:
        # 事実の本文（クエリ・URL・数値）は書かない。コードが決めた区分の名前（カードの見出し）と出どころだけ
        lines += [
            "",
            "## ブリーフィング（W1）",
            "",
            f"- 結果: {briefing.outcome}",
        ]
        if briefing.cards:
            lines += ["", "| 区分 | ツール | 結果 ID |", "|---|---|---|"]
            for card in briefing.cards:
                heading = _redact(card.title).replace("|", "／")
                lines.append(
                    f"| {heading} | `{card.source_tool}` | `{card.result_id}` |"
                )
    lines.append("")
    return "\n".join(lines)


def write_voice_audit(
    state: BiSessionState,
    settings: Settings,
    *,
    outcome_hint: str | None = None,
    briefing: BriefingResult | None = None,
    ended_at: datetime | None = None,
) -> Path | None:
    """E-12 を 1 件書いてパスを返す。``VOICE_AUDIT_DIR`` が未設定なら書かずに None を返す。

    W1 のタスクが止まってから呼ぶ（``state.results`` が書き出しの途中で増えないように）。

    Args:
        state: セッションの状態。
        settings: 設定。
        outcome_hint: プロジェクトを決められなかったときの ``OpenSeoError.outcome``（縮退したセッション）。
        briefing: W1 の結果。書くのは outcome とカードの見出し・ツール名・結果 ID だけで、事実の本文は書かない。
        ended_at: 終わった時刻。省略時は今。
    """
    global _warned_no_dir
    directory = settings.voice_audit_dir
    if directory is None:
        if not _warned_no_dir:
            logger.warning(
                "VOICE_AUDIT_DIR が未設定のため、E-12（source: voice）を書きません"
            )
            _warned_no_dir = True
        return None

    ended = ended_at or datetime.now(timezone.utc)
    day = ended.astimezone(JST).strftime("%Y-%m%d")
    outcome, note = _outcome(state, outcome_hint)
    directory.mkdir(exist_ok=True)

    for _ in range(_MAX_CREATE_ATTEMPTS):
        audit_id, path = _next_path(directory, day)
        content = _render(
            audit_id=audit_id,
            state=state,
            settings=settings,
            ended_at=ended,
            outcome=outcome,
            note=note,
            briefing=briefing,
        )
        try:
            with path.open("x", encoding="utf-8") as handle:
                handle.write(content)
        except FileExistsError:
            continue  # 同時に終わった別のセッションが同じ番号を取った
        logger.info(
            "E-12 を書きました",
            extra={
                "session_id": state.session_id,
                "audit_id": audit_id,
                "outcome": outcome,
            },
        )
        return path

    logger.error(
        "E-12 の連番が取れませんでした", extra={"session_id": state.session_id}
    )
    return None
