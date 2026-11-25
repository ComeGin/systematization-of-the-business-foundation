"""W1（ブリーフィング）: 接続した直後に、GSC・GA4 の要点を集める。

集計はコードで行い、モデルには事実だけを渡す（D1）。

1. OpenSEO のツールを並列で呼ぶ（無料の参照だけ。8 本）。一部が失敗しても残りで続ける。
2. ``metrics`` で指標を計算する（前期比・あと一歩の語・期待 CTR・キーイベント率〈GA4。DA-02 の CVR とは別〉・カニバリゼーション）。
3. 画面のカードを ``sink`` に送る。
4. 日本語の事実（``append_thinking`` に渡す。500 トークン以内）を返す。数値には台帳の
   ``result_id`` を付ける。計測の健全性に問題があれば、それを先頭の事実にする。

期間は「今日（JST）の 3 日前まで 28 日」と、その直前の 28 日（``metrics.comparison_windows``）。
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import date
from typing import Any, Literal

from comegin_voice.openseo.client import OpenSeoClient, OpenSeoError
from comegin_voice.visual_output.cards import (
    Card,
    CardSink,
    Cell,
    ComparePeriod,
    Period,
    make_card,
)

from . import metrics
from .presenters import cards_for_result, compress_result
from .state import BiSessionState

logger = logging.getLogger("comegin_voice.briefing")

FACTS_CHAR_LIMIT = 450
"""事実の文字数の上限。append_thinking は 500 トークンまで。日本語は 1 文字がおよそ 1 トークンなので余裕を持たせる。"""

_GSC = "get_search_console_performance"

_OUTCOME_JA = {
    "unreachable": "OpenSEO に届かない",
    "timeout": "時間切れ",
    "invalid_response": "応答の形が想定と違う",
    "tool_error": "ツールが失敗を返した",
    "not_allowed": "許可リストに無い",
    "closed": "接続を閉じた後",
}

_REASON_JA = {
    "not_connected": "Search Console が未接続",
    "gsc_not_connected": "Search Console が未接続",
    "gsc_reconnect_required": "Search Console の再接続が必要",
    "ga4_not_connected": "GA4 が未接続",
    "ga4_reconnect_required": "GA4 の再接続が必要",
    "ga4_property_inaccessible": "GA4 のプロパティに届かない",
    "gsc_oauth_not_configured": "Google の OAuth が未設定",
}


@dataclass
class BriefingResult:
    facts: str
    cards: list[Card]
    outcome: Literal["ok", "partial", "failed"]


@dataclass
class _Fetched:
    key: str
    tool: str
    args: dict[str, Any]
    result_id: str
    structured: dict[str, Any] | None
    error: OpenSeoError | None

    @property
    def ok(self) -> bool:
        return self.structured is not None


async def _fetch(
    client: OpenSeoClient,
    state: BiSessionState,
    key: str,
    tool: str,
    args: dict[str, Any],
) -> _Fetched:
    """1 本呼んで台帳に残す。例外を外に出さない（gather の一部の失敗で全体を止めない）。"""
    result_id = state.next_result_id()
    state.tool_calls += 1
    try:
        structured = await client.call(tool, args)
    except OpenSeoError as e:
        state.record(
            tool,
            args,
            ok=False,
            summary={"outcome": e.outcome, "reason": e.reason, "message": str(e)[:200]},
            result_id=result_id,
        )
        return _Fetched(key, tool, args, result_id, None, e)
    except Exception as e:  # 想定外。ブリーフィング全体は止めない
        logger.exception("ブリーフィングの取得で想定外の失敗", extra={"tool": tool})
        err = OpenSeoError("unreachable", type(e).__name__, tool=tool)
        state.record(
            tool,
            args,
            ok=False,
            summary={"outcome": err.outcome, "message": str(err)},
            result_id=result_id,
        )
        return _Fetched(key, tool, args, result_id, None, err)
    state.record(
        tool,
        args,
        ok=True,
        summary=compress_result(tool, structured),
        result_id=result_id,
    )
    return _Fetched(key, tool, args, result_id, structured, None)


def _as_number(value: Any) -> float | None:
    """数値（bool を除く）なら float に、そうでなければ None にする。

    OpenSEO の応答の 1 つの値がおかしくても（文字列・null など）、ブリーフィング全体を落とさないため。
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _n(value: Any) -> str:
    number = _as_number(value)
    if number is None:
        return "—"
    return (
        f"{number:,.0f}"
        if abs(number) >= 10 or number.is_integer()
        else f"{number:,.1f}"
    )


def _pct(value: Any) -> str:
    number = _as_number(value)
    return "—" if number is None else f"{number * 100:.1f}%"


def _pos(value: Any) -> str:
    """平均掲載順位（小数 1 桁）。数値でなければ「—」。"""
    number = _as_number(value)
    return "—" if number is None else f"{number:.1f}"


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _safe_cards(
    tool: str, structured: dict[str, Any], result_id: str, today: date
) -> list[Card]:
    """カードを作る。作れなくても（応答の形の違い）事実とほかのカードは残す。"""
    try:
        return cards_for_result(tool, structured, result_id, today=today)
    except Exception:
        logger.exception(
            "カードを作れなかった", extra={"tool": tool, "result_id": result_id}
        )
        return []


def _failure_text(f: _Fetched) -> str:
    assert f.error is not None
    reason = _REASON_JA.get(f.error.reason or "", f.error.reason or "")
    base = _OUTCOME_JA.get(f.error.outcome, f.error.outcome)
    return f"{base}（{reason}）" if reason else base


def _rows(structured: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not structured:
        return []
    rows = structured.get("rows")
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


async def run_briefing(
    client: OpenSeoClient, state: BiSessionState, sink: CardSink, *, today: date
) -> BriefingResult:
    """W1 の集計。``today`` は JST の今日。"""
    project_id = state.project_id
    if not project_id:
        return BriefingResult(
            facts="OpenSEO のプロジェクトが決まっていないため、GSC・GA4 の数値を取得していない。数値を話さない。",
            cards=[],
            outcome="failed",
        )

    w = metrics.comparison_windows(today)
    cur, prev = w.current.as_args(), w.previous.as_args()
    pid = {"projectId": project_id}
    plan: list[tuple[str, str, dict[str, Any]]] = [
        ("health", "get_google_analytics_measurement_health", dict(pid)),
        (
            "overview",
            "get_google_analytics_organic_overview",
            {**pid, **cur, "trend": "weekly"},
        ),
        ("page_cur", _GSC, {**pid, **cur, "dimensions": ["page"], "rowLimit": 1000}),
        ("page_prev", _GSC, {**pid, **prev, "dimensions": ["page"], "rowLimit": 1000}),
        ("query_cur", _GSC, {**pid, **cur, "dimensions": ["query"], "rowLimit": 1000}),
        (
            "query_page",
            _GSC,
            {**pid, **cur, "dimensions": ["query", "page"], "rowLimit": 1000},
        ),
        (
            "landing",
            "get_google_analytics_organic_landing_pages",
            {**pid, **cur, "limit": 200},
        ),
        ("opportunities", "get_search_opportunities", {**pid, **cur, "limit": 20}),
    ]
    fetched_list = await asyncio.gather(
        *(_fetch(client, state, key, tool, args) for key, tool, args in plan)
    )
    f = {x.key: x for x in fetched_list}

    period = Period(
        start=w.current.start.isoformat(),
        end=w.current.end.isoformat(),
        compare=ComparePeriod(
            start=w.previous.start.isoformat(), end=w.previous.end.isoformat()
        ),
    )
    period_cur = Period(
        start=w.current.start.isoformat(), end=w.current.end.isoformat()
    )

    # 事実は優先度の順に並べ、上限の文字数まで詰める（足りなければ後ろから落ちる）
    lines: list[str] = []
    cards: list[Card] = []

    # P0: 計測の健全性（問題があれば解釈より先に）
    health = f["health"]
    if health.ok and health.structured is not None:
        issues = metrics.measurement_issues(health.structured)
        if issues:
            lines.append(
                f"【先に伝える】GA4 の計測に問題: {'・'.join(issues)}[{health.result_id}]。GA4 の数値の解釈は割り引く。"
            )
        cards.extend(
            _safe_cards(health.tool, health.structured, health.result_id, today)
        )
    else:
        lines.append(
            f"【先に伝える】GA4 の計測の健全性を確かめられない: {_failure_text(health)}[{health.result_id}]。"
        )

    # P1: 期間と取れなかったもの
    lines.append(
        f"期間 {w.current.start:%m/%d}〜{w.current.end:%m/%d}（28 日）を直前の 28 日と比較。GSC は太平洋時間で直近 3 日を除く。"
    )
    failed = [x for x in fetched_list if not x.ok and x.key != "health"]
    if failed:
        names = "・".join(f"{_LABEL[x.key]}={_failure_text(x)}" for x in failed)
        lines.append(f"取得できなかった: {names}。その部分は推測で話さない。")

    # P2: GSC の前期比（page の次元の合計。query は匿名化で欠けるため）
    page_cur, page_prev = f["page_cur"], f["page_prev"]
    if page_cur.ok:
        t_cur = metrics.gsc_totals(_rows(page_cur.structured))
        t_prev = (
            metrics.gsc_totals(_rows(page_prev.structured)) if page_prev.ok else None
        )
        clicks = metrics.period_change(t_cur.clicks, t_prev.clicks if t_prev else None)
        imps = metrics.period_change(
            t_cur.impressions, t_prev.impressions if t_prev else None
        )
        ids = page_cur.result_id + (f",{page_prev.result_id}" if page_prev.ok else "")
        lines.append(
            f"GSC: クリック {_n(t_cur.clicks)}（{metrics.format_ratio(clicks.ratio)}）、表示 {_n(t_cur.impressions)}（{metrics.format_ratio(imps.ratio)}）、"
            f"平均順位 {_n(t_cur.position)}（前期 {_n(t_prev.position) if t_prev else '—'}）[{ids}]。"
        )
        kpi_rows: list[list[Cell]] = [
            ["クリック", t_cur.clicks, t_prev.clicks if t_prev else None, clicks.ratio],
            [
                "表示回数",
                t_cur.impressions,
                t_prev.impressions if t_prev else None,
                imps.ratio,
            ],
            [
                "CTR",
                metrics.round_or_none(t_cur.ctr, 4),
                metrics.round_or_none(t_prev.ctr, 4) if t_prev else None,
                metrics.period_change(t_cur.ctr, t_prev.ctr if t_prev else None).ratio,
            ],
            [
                "平均掲載順位",
                metrics.round_or_none(t_cur.position, 1),
                metrics.round_or_none(t_prev.position, 1) if t_prev else None,
                metrics.period_change(
                    t_cur.position, t_prev.position if t_prev else None
                ).ratio,
            ],
        ]
        cards.append(
            make_card(
                kind="kpi",
                title="Search Console（前期比。ページ単位の合計）",
                period=period if page_prev.ok else period_cur,
                source_tool=_GSC,
                result_id=page_cur.result_id,
                columns=["指標", "今期", "前期", "増減率"],
                rows=kpi_rows,
            )
        )
        if page_prev.ok:
            losers, _gainers = metrics.gsc_movers(
                _rows(page_cur.structured), _rows(page_prev.structured), limit=10
            )
            if losers:
                cards.append(
                    make_card(
                        kind="bar",
                        title="クリックが落ちたページ（前期比）",
                        period=period,
                        source_tool=_GSC,
                        result_id=page_cur.result_id,
                        columns=["ページ", "今期のクリック", "前期のクリック"],
                        rows=[
                            [m.key, m.current_clicks, m.previous_clicks] for m in losers
                        ],
                    )
                )

    # P3: GA4 自然検索の概要
    overview = f["overview"]
    if overview.ok and overview.structured is not None:
        comparison = _dict(overview.structured.get("comparison"))
        sessions = _dict(comparison.get("sessions"))
        key_events = _dict(comparison.get("keyEvents"))
        if sessions:
            lines.append(
                f"GA4 自然検索: セッション {_n(sessions.get('current'))}（{metrics.format_ratio(_as_number(sessions.get('percentChange')))}）、"
                f"キーイベント {_n(key_events.get('current'))}（前期 {_n(key_events.get('previous'))}）[{overview.result_id}]。"
            )
        else:
            lines.append(f"GA4 自然検索: この期間の行が無い[{overview.result_id}]。")
        cards.extend(
            _safe_cards(overview.tool, overview.structured, overview.result_id, today)
        )

    # P4: あと一歩の語
    query_cur = f["query_cur"]
    if query_cur.ok:
        striking = metrics.striking_distance_queries(
            _rows(query_cur.structured), limit=10
        )
        if striking:
            top3 = "、".join(
                f"「{s.query}」{s.position:.1f}位・表示{_n(s.impressions)}"
                for s in striking[:3]
            )
            lines.append(
                f"あと一歩（4〜20 位で表示が多い語）: {top3}[{query_cur.result_id}]。"
            )
            cards.append(
                make_card(
                    kind="table",
                    title="あと一歩の語（順位 4〜20 位・表示回数の多い順）",
                    period=period_cur,
                    source_tool=_GSC,
                    result_id=query_cur.result_id,
                    columns=["クエリ", "平均掲載順位", "表示回数", "クリック", "CTR"],
                    rows=[
                        [s.query, round(s.position, 1), s.impressions, s.clicks, s.ctr]
                        for s in striking
                    ],
                )
            )

    # P5: 期待 CTR を下回るページ
    if page_cur.ok:
        gaps = metrics.ctr_underperformers(_rows(page_cur.structured), limit=10)
        if gaps:
            top2 = "、".join(
                f"{g.key} CTR{_pct(g.ctr)}（目安{_pct(g.expected_ctr)}・{g.position:.1f}位）"
                for g in gaps[:2]
            )
            lines.append(f"順位の割に CTR が低い: {top2}[{page_cur.result_id}]。")
            cards.append(
                make_card(
                    kind="table",
                    title="掲載順位の割に CTR が低いページ（目安の半分未満）",
                    period=period_cur,
                    source_tool=_GSC,
                    result_id=page_cur.result_id,
                    columns=["ページ", "平均掲載順位", "表示回数", "CTR", "CTR の目安"],
                    rows=[
                        [
                            g.key,
                            round(g.position, 1),
                            g.impressions,
                            g.ctr,
                            round(g.expected_ctr, 4),
                        ]
                        for g in gaps
                    ],
                )
            )

    # P6: 流入はあるのにキーイベントが少ない LP
    landing = f["landing"]
    if landing.ok:
        low = metrics.low_conversion_landing_pages(_rows(landing.structured), limit=10)
        if low:
            top2 = "、".join(
                f"{p.page} セッション{_n(p.sessions)}・キーイベント{_n(p.key_events)}"
                for p in low[:2]
            )
            lines.append(
                f"流入の割にキーイベントが少ない LP: {top2}[{landing.result_id}]。"
            )
            cards.append(
                make_card(
                    kind="table",
                    title="自然検索の流入の割にキーイベントが少ない LP",
                    period=period_cur,
                    source_tool=landing.tool,
                    result_id=landing.result_id,
                    columns=[
                        "ランディングページ",
                        "セッション",
                        "キーイベント",
                        "キーイベント率",
                        "全体の率",
                    ],
                    rows=[
                        [
                            p.page,
                            p.sessions,
                            p.key_events,
                            p.key_event_rate,
                            p.site_rate,
                        ]
                        for p in low
                    ],
                )
            )

    # P7: カニバリゼーション
    query_page = f["query_page"]
    if query_page.ok:
        cannibal = metrics.cannibalization(_rows(query_page.structured), limit=10)
        if cannibal:
            c = cannibal[0]
            lines.append(
                f"1 つの語に複数のページ: 「{c.query}」に {len(c.pages)} ページ（{len(cannibal)} 語）[{query_page.result_id}]。"
            )
            cards.append(
                make_card(
                    kind="table",
                    title="1 つのクエリに複数のページ（カニバリゼーションの候補）",
                    period=period_cur,
                    source_tool=_GSC,
                    result_id=query_page.result_id,
                    columns=[
                        "クエリ",
                        "ページ",
                        "表示回数",
                        "クリック",
                        "平均掲載順位",
                    ],
                    rows=[
                        [
                            c.query,
                            p.page,
                            p.impressions,
                            p.clicks,
                            metrics.round_or_none(p.position, 1),
                        ]
                        for c in cannibal
                        for p in c.pages
                    ],
                )
            )

    # P8: 伸びしろ（GSC × GA4 の点数）
    opportunities = f["opportunities"]
    if opportunities.ok and opportunities.structured is not None:
        rows = _rows(opportunities.structured)
        scored = [r for r in rows if r.get("score") is not None]
        if scored:
            top2 = "、".join(
                f"{r.get('page')} 点数{r.get('score')}・{_pos(r.get('position'))}位"
                for r in scored[:2]
            )
            lines.append(f"伸びしろの上位: {top2}[{opportunities.result_id}]。")
        cards.extend(
            _safe_cards(
                opportunities.tool,
                opportunities.structured,
                opportunities.result_id,
                today,
            )
        )

    facts = _fit_lines(lines, FACTS_CHAR_LIMIT)

    for card in cards:
        await sink.send(card)

    ok_count = sum(1 for x in fetched_list if x.ok)
    if ok_count == 0:
        outcome: Literal["ok", "partial", "failed"] = "failed"
    elif ok_count < len(fetched_list):
        outcome = "partial"
    else:
        outcome = "ok"
    logger.info(
        "ブリーフィングを集計した",
        extra={
            "outcome": outcome,
            "ok": ok_count,
            "total": len(fetched_list),
            "cards": len(cards),
        },
    )
    return BriefingResult(facts=facts, cards=cards, outcome=outcome)


_LABEL = {
    "health": "計測の健全性",
    "overview": "GA4 概要",
    "page_cur": "GSC ページ（今期）",
    "page_prev": "GSC ページ（前期）",
    "query_cur": "GSC クエリ",
    "query_page": "GSC クエリ×ページ",
    "landing": "GA4 LP",
    "opportunities": "伸びしろ",
}


def _fit_lines(lines: list[str], limit: int) -> str:
    """上から順に、上限の文字数に収まるところまで詰める。先頭の行は長くても切って入れる。"""
    out: list[str] = []
    used = 0
    for i, line in enumerate(lines):
        cost = len(line) + (1 if out else 0)
        if used + cost <= limit:
            out.append(line)
            used += cost
        elif i == 0:
            out.append(line[: limit - 1] + "…")
            used = limit
        else:
            continue  # 短い後続の行は入るかもしれないので続ける
    return "\n".join(out)
