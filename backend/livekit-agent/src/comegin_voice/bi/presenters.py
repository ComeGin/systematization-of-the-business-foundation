"""OpenSEO の結果（structuredContent）を 2 つに分ける（D4）。

- ``compress_result``: モデル（裏の Responses）に返す、圧縮した事実の dict。
  大きな表は上位の行だけにし、割り当て（quota）・URL などの解釈に要らない項目を落とす。
- ``cards_for_result``: 画面に送るカード。数値はすべて結果からそのまま写す。

どちらも純粋関数（I/O を持たない）。
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Any

from comegin_voice.visual_output.cards import (
    Card,
    Cell,
    ComparePeriod,
    Period,
    make_card,
)

from . import metrics

MODEL_TOP_ROWS = 10
"""モデルに返す表の行数（W2）。全行は画面のカードと台帳の args から取り直せる。"""
CARD_ROWS = 50
"""カードに載せる行数の上限（15 KB の制限の前に絞る）。"""

_GSC_TOOL = "get_search_console_performance"


# ---------------------------------------------------------------------------
# 共通
# ---------------------------------------------------------------------------


def _round(value: Any, digits: int) -> Any:
    if isinstance(value, float):
        return round(value, digits)
    return value


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _range(value: Any) -> dict[str, str] | None:
    d = _dict(value)
    start, end = d.get("startDate"), d.get("endDate")
    if isinstance(start, str) and isinstance(end, str):
        return {"start": start, "end": end}
    return None


def _cell(value: Any) -> Cell:
    if value is None or isinstance(value, str):
        return value
    if isinstance(value, bool):
        return str(value)
    if isinstance(value, (int, float)):
        return _round(value, 4) if isinstance(value, float) else value
    return str(value)


def _snapshot_period(today: date) -> Period:
    day = today.isoformat()
    return Period(start=day, end=day)


# ---------------------------------------------------------------------------
# GSC
# ---------------------------------------------------------------------------


def _gsc_row(row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "keys": row.get("keys"),
        "clicks": row.get("clicks"),
        "impressions": row.get("impressions"),
        "ctr": _round(row.get("ctr"), 3),
        "position": _round(row.get("position"), 1),
    }


def _compress_gsc(structured: dict[str, Any]) -> dict[str, Any]:
    rows = [r for r in _list(structured.get("rows")) if isinstance(r, dict)]
    dims = [str(d) for d in _list(structured.get("dimensions"))] or ["query"]
    totals = metrics.gsc_totals(rows)
    out: dict[str, Any] = {
        "site": structured.get("siteUrl"),
        "period": {
            "start": structured.get("startDate"),
            "end": structured.get("endDate"),
        },
        "period_note": "GSC の日付は太平洋時間。直近 2〜3 日は未確定",
        "dimensions": dims,
        "row_count": len(rows),
        "has_more": bool(structured.get("hasMore")),
        "totals_of_returned_rows": {
            "clicks": totals.clicks,
            "impressions": totals.impressions,
            "ctr": metrics.round_or_none(totals.ctr, 3),
            "position_weighted": metrics.round_or_none(totals.position, 1),
        },
        "top_rows_by_clicks": [_gsc_row(r) for r in rows[:MODEL_TOP_ROWS]],
    }
    if dims[0] == "query" and len(dims) == 1:
        striking = metrics.striking_distance_queries(rows, limit=5)
        out["striking_distance_4_20"] = [
            {
                "query": s.query,
                "impressions": s.impressions,
                "clicks": s.clicks,
                "position": round(s.position, 1),
            }
            for s in striking
        ]
    if dims[0] == "page" and len(dims) == 1:
        gaps = metrics.ctr_underperformers(rows, limit=5)
        out["ctr_below_benchmark"] = [
            {
                "page": g.key,
                "impressions": g.impressions,
                "ctr": round(g.ctr, 3),
                "benchmark_ctr": round(g.expected_ctr, 3),
                "position": round(g.position, 1),
            }
            for g in gaps
        ]
        if gaps:
            out["benchmark_note"] = (
                "benchmark_ctr は公開調査を丸めた目安で、Google の値ではない"
            )
    if dims[:2] == ["query", "page"]:
        cannibal = metrics.cannibalization(rows, limit=5)
        out["multiple_pages_per_query"] = [
            {
                "query": c.query,
                "impressions": c.total_impressions,
                "pages": [
                    {
                        "page": p.page,
                        "impressions": p.impressions,
                        "position": metrics.round_or_none(p.position, 1),
                    }
                    for p in c.pages[:3]
                ],
            }
            for c in cannibal
        ]
    if out["has_more"]:
        out["note"] = (
            "行は clicks の多い順に打ち切られている（startRow で続きを取れる）"
        )
    return out


def _gsc_cards(structured: dict[str, Any], result_id: str) -> list[Card]:
    rows = [r for r in _list(structured.get("rows")) if isinstance(r, dict)]
    dims = [str(d) for d in _list(structured.get("dimensions"))] or ["query"]
    start, end = structured.get("startDate"), structured.get("endDate")
    if not isinstance(start, str) or not isinstance(end, str):
        return []
    period = Period(start=start, end=end)
    if dims == ["date"]:
        series = sorted(rows, key=lambda r: str((r.get("keys") or [""])[0]))
        return [
            make_card(
                kind="line",
                title="Search Console の日ごとの推移",
                period=period,
                source_tool=_GSC_TOOL,
                result_id=result_id,
                columns=["日付", "クリック", "表示回数"],
                rows=[
                    [
                        _cell((r.get("keys") or [""])[0]),
                        _cell(r.get("clicks")),
                        _cell(r.get("impressions")),
                    ]
                    for r in series
                ],
            )
        ]
    columns = [*dims, "クリック", "表示回数", "CTR", "平均掲載順位"]
    table_rows: list[list[Cell]] = []
    for r in rows[:CARD_ROWS]:
        keys = _list(r.get("keys"))
        table_rows.append(
            [
                *[_cell(keys[i]) if i < len(keys) else None for i in range(len(dims))],
                _cell(r.get("clicks")),
                _cell(r.get("impressions")),
                _cell(r.get("ctr")),
                _cell(r.get("position")),
            ]
        )
    return [
        make_card(
            kind="table",
            title=f"Search Console（{' × '.join(dims)}）",
            period=period,
            source_tool=_GSC_TOOL,
            result_id=result_id,
            columns=columns,
            rows=table_rows,
        )
    ]


# ---------------------------------------------------------------------------
# inspect_urls
# ---------------------------------------------------------------------------


def _inspect_rows(structured: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for item in _list(structured.get("results")):
        if not isinstance(item, dict):
            continue
        result = _dict(item.get("result"))
        index = _dict(result.get("indexStatusResult"))
        out.append(
            {
                "url": item.get("url"),
                "error": item.get("error"),
                "verdict": index.get("verdict"),
                "coverage": index.get("coverageState"),
                "indexing_state": index.get("indexingState"),
                "last_crawl": index.get("lastCrawlTime"),
                "google_canonical": index.get("googleCanonical"),
                "user_canonical": index.get("userCanonical"),
                "robots_txt": index.get("robotsTxtState"),
            }
        )
    return out


def _inspect_cards(
    structured: dict[str, Any], result_id: str, today: date
) -> list[Card]:
    rows = _inspect_rows(structured)
    columns = [
        "URL",
        "判定",
        "カバレッジ",
        "最終クロール",
        "Google が選んだ canonical",
        "エラー",
    ]
    return [
        make_card(
            kind="table",
            title="URL 検査（Search Console）",
            period=_snapshot_period(today),
            source_tool="inspect_urls",
            result_id=result_id,
            columns=columns,
            rows=[
                [
                    _cell(r["url"]),
                    _cell(r["verdict"]),
                    _cell(r["coverage"]),
                    _cell(r["last_crawl"]),
                    _cell(r["google_canonical"]),
                    _cell(r["error"]),
                ]
                for r in rows
            ],
        )
    ]


# ---------------------------------------------------------------------------
# GA4
# ---------------------------------------------------------------------------


def _report_columns(structured: dict[str, Any]) -> list[str]:
    request = _dict(structured.get("request"))
    dims = [str(d) for d in _list(request.get("dimensions"))]
    mets = [str(m) for m in _list(request.get("metrics"))]
    if dims or mets:
        return [*dims, *mets]
    rows = _list(structured.get("rows"))
    first = rows[0] if rows and isinstance(rows[0], dict) else {}
    return list(first.keys())


def _ga4_meta(structured: dict[str, Any]) -> dict[str, Any]:
    meta = _dict(structured.get("reportMetadata"))
    out: dict[str, Any] = {}
    if meta.get("hasLimitedData"):
        out["limited_data"] = "Google がしきい値・サンプリングで一部を省いている"
    warnings = _list(structured.get("warnings"))
    if warnings:
        out["warnings"] = warnings
    diagnostics = _list(structured.get("diagnostics"))
    if diagnostics:
        out["diagnostics"] = diagnostics[:5]
    return out


def _compress_ga4_report(structured: dict[str, Any]) -> dict[str, Any]:
    request = _dict(structured.get("request"))
    columns = _report_columns(structured)
    rows = [r for r in _list(structured.get("rows")) if isinstance(r, dict)]
    out: dict[str, Any] = {
        "property": _dict(structured.get("source")).get("propertyDisplayName"),
        "period": _range(request.get("resolvedDateRange")),
        "channel": request.get("channel"),
        "row_count": structured.get("rowCount"),
        "total_row_count": structured.get("totalRowCount"),
        "columns": columns,
        "top_rows": [
            [_round(r.get(c), 4) for c in columns] for r in rows[:MODEL_TOP_ROWS]
        ],
        **_ga4_meta(structured),
    }
    comparison = _dict(structured.get("comparison"))
    if comparison:
        out["previous_period"] = _range(comparison.get("previousDateRange"))
        # 行は {dimensions: {...}, metrics: {name: {current, previous, absoluteChange, percentChange}}}
        comp_rows = [r for r in _list(comparison.get("rows")) if isinstance(r, dict)]
        out["comparison_top_rows"] = [
            {
                "dimensions": _dict(r.get("dimensions")),
                "metrics": {
                    k: {
                        "current": _round(_dict(v).get("current"), 4),
                        "previous": _round(_dict(v).get("previous"), 4),
                        "change_ratio": _round(_dict(v).get("percentChange"), 3),
                    }
                    for k, v in _dict(r.get("metrics")).items()
                },
            }
            for r in comp_rows[:MODEL_TOP_ROWS]
        ]
        if not _dict(comparison.get("coverage")).get("complete", True):
            out["comparison_note"] = "前期比は取得した行の範囲だけ（全行ではない）"
    if request.get("reportKind") == "landing_pages" or "landingPage" in columns:
        low = metrics.low_conversion_landing_pages(rows, limit=5)
        if low:
            out["low_key_event_rate_pages"] = [
                {
                    "page": p.page,
                    "sessions": p.sessions,
                    "key_events": p.key_events,
                    "rate": metrics.round_or_none(p.key_event_rate, 3),
                    "site_rate": metrics.round_or_none(p.site_rate, 3),
                }
                for p in low
            ]
    return out


def _ga4_report_cards(
    tool: str, structured: dict[str, Any], result_id: str, today: date
) -> list[Card]:
    request = _dict(structured.get("request"))
    rng = _range(request.get("resolvedDateRange"))
    period = (
        Period(start=rng["start"], end=rng["end"]) if rng else _snapshot_period(today)
    )
    columns = _report_columns(structured)
    rows = [r for r in _list(structured.get("rows")) if isinstance(r, dict)]
    kind = "line" if columns[:1] == ["date"] else "table"
    return [
        make_card(
            kind=kind,
            title=_GA4_TITLES.get(tool, "Google Analytics"),
            period=period,
            source_tool=tool,
            result_id=result_id,
            columns=columns,
            rows=[[_cell(r.get(c)) for c in columns] for r in rows[:CARD_ROWS]],
        )
    ]


_GA4_TITLES = {
    "get_google_analytics_organic_landing_pages": "GA4 自然検索のランディングページ",
    "get_google_analytics_page_performance": "GA4 ページの成果",
    "get_google_analytics_traffic_acquisition": "GA4 集客（チャネル）",
    "get_google_analytics_key_events": "GA4 キーイベント",
    "get_google_analytics_audience_breakdown": "GA4 ユーザーの内訳",
}

OVERVIEW_LABELS = {
    "sessions": "セッション",
    "activeUsers": "アクティブユーザー",
    "engagedSessions": "エンゲージのあったセッション",
    "engagementRate": "エンゲージメント率",
    "keyEvents": "キーイベント",
    "transactions": "トランザクション",
    "purchaseRevenue": "収益",
}


def _compress_overview(structured: dict[str, Any]) -> dict[str, Any]:
    request = _dict(structured.get("request"))
    comparison = _dict(structured.get("comparison"))
    trend = [r for r in _list(structured.get("trend")) if isinstance(r, dict)]
    return {
        "property": _dict(structured.get("source")).get("propertyDisplayName"),
        "channel": "organic_search",
        "period": _range(request.get("resolvedDateRange")),
        "previous_period": _range(request.get("previousDateRange")),
        "metrics": {
            k: {
                "current": _round(_dict(v).get("current"), 4),
                "previous": _round(_dict(v).get("previous"), 4),
                "change_ratio": _round(_dict(v).get("percentChange"), 3),
            }
            for k, v in comparison.items()
        },
        "trend_granularity": request.get("trend"),
        "trend": trend[-12:],
        **_ga4_meta(structured),
    }


def _overview_cards(
    structured: dict[str, Any], result_id: str, today: date
) -> list[Card]:
    request = _dict(structured.get("request"))
    cur = _range(request.get("resolvedDateRange"))
    prev = _range(request.get("previousDateRange"))
    if not cur:
        return []
    period = Period(
        start=cur["start"],
        end=cur["end"],
        compare=ComparePeriod(start=prev["start"], end=prev["end"]) if prev else None,
    )
    comparison = _dict(structured.get("comparison"))
    kpi_rows: list[list[Cell]] = []
    for key, label in OVERVIEW_LABELS.items():
        v = _dict(comparison.get(key))
        if not v:
            continue
        kpi_rows.append(
            [
                label,
                _cell(v.get("current")),
                _cell(v.get("previous")),
                _cell(v.get("percentChange")),
            ]
        )
    cards = [
        make_card(
            kind="kpi",
            title="GA4 自然検索の概要（前期比）",
            period=period,
            source_tool="get_google_analytics_organic_overview",
            result_id=result_id,
            columns=["指標", "今期", "前期", "増減率"],
            rows=kpi_rows,
        )
    ]
    trend = [r for r in _list(structured.get("trend")) if isinstance(r, dict)]
    if trend:
        x = "yearWeek" if request.get("trend") == "weekly" else "date"
        cards.append(
            make_card(
                kind="line",
                title="GA4 自然検索のセッションの推移",
                period=Period(start=cur["start"], end=cur["end"]),
                source_tool="get_google_analytics_organic_overview",
                result_id=result_id,
                columns=[
                    "週" if x == "yearWeek" else "日付",
                    "セッション",
                    "キーイベント",
                ],
                rows=[
                    [
                        _cell(r.get(x)),
                        _cell(r.get("sessions")),
                        _cell(r.get("keyEvents")),
                    ]
                    for r in trend
                ],
            )
        )
    return cards


def _compress_health(structured: dict[str, Any]) -> dict[str, Any]:
    streams = [s for s in _list(structured.get("webStreams")) if isinstance(s, dict)]
    key_events = [e for e in _list(structured.get("keyEvents")) if isinstance(e, dict)]
    return {
        "property": _dict(structured.get("source")).get("propertyDisplayName"),
        "summary": _dict(structured.get("summary")),
        "issues": _list(structured.get("issues")),
        "issues_ja": metrics.measurement_issues(structured),
        "web_streams": [
            {"uri": s.get("defaultUri"), "measurement_id": s.get("measurementId")}
            for s in streams[:5]
        ],
        "key_events": [e.get("eventName") for e in key_events[:20]],
    }


def _health_cards(
    structured: dict[str, Any], result_id: str, today: date
) -> list[Card]:
    summary = _dict(structured.get("summary"))
    issues = metrics.measurement_issues(structured)
    rows: list[list[Cell]] = [
        ["Web のデータストリーム", _cell(summary.get("webStreamCount"))],
        ["キーイベント", _cell(summary.get("keyEventCount"))],
        ["検出した問題", _cell(summary.get("issueCount"))],
    ]
    rows.extend([["問題", issue] for issue in issues])
    return [
        make_card(
            kind="table",
            title="GA4 計測の健全性",
            period=_snapshot_period(today),
            source_tool="get_google_analytics_measurement_health",
            result_id=result_id,
            columns=["項目", "値"],
            rows=rows,
        )
    ]


def _opportunity_row(r: Mapping[str, Any]) -> dict[str, Any]:
    ga4 = _dict(r.get("ga4"))
    return {
        "page": r.get("page"),
        "score": r.get("score"),
        "clicks": r.get("clicks"),
        "impressions": r.get("impressions"),
        "ctr": _round(r.get("ctr"), 3),
        "position": _round(r.get("position"), 1),
        "ga4_sessions": ga4.get("sessions"),
        "ga4_key_events": ga4.get("keyEvents"),
        "joined": r.get("joinStatus") == "joined",
    }


def _compress_opportunities(structured: dict[str, Any]) -> dict[str, Any]:
    request = _dict(structured.get("request"))
    rows = [r for r in _list(structured.get("rows")) if isinstance(r, dict)]
    scoring = _dict(structured.get("scoring"))
    return {
        "period": _range(request.get("dateRange")),
        "row_count": structured.get("rowCount"),
        "total_candidate_rows": structured.get("totalCandidateRows"),
        "coverage": _dict(structured.get("coverage")),
        "business_value_metric": scoring.get("businessValueMetric"),
        "engagement_fallback": scoring.get("engagementFallback"),
        "top_rows": [_opportunity_row(r) for r in rows[:MODEL_TOP_ROWS]],
        "note": "順位 4〜20 位の GSC のページを GA4 の LP と結合して点数を付けたもの。joined=false は GA4 と結び付かなかったページ",
        **_ga4_meta(structured),
    }


def _opportunity_cards(
    structured: dict[str, Any], result_id: str, today: date
) -> list[Card]:
    request = _dict(structured.get("request"))
    rng = _range(request.get("dateRange"))
    period = (
        Period(start=rng["start"], end=rng["end"]) if rng else _snapshot_period(today)
    )
    rows = [
        _opportunity_row(r)
        for r in _list(structured.get("rows"))
        if isinstance(r, dict)
    ]
    columns = [
        "ページ",
        "点数",
        "クリック",
        "表示回数",
        "CTR",
        "平均掲載順位",
        "GA4 セッション",
        "GA4 キーイベント",
    ]
    keys = [
        "page",
        "score",
        "clicks",
        "impressions",
        "ctr",
        "position",
        "ga4_sessions",
        "ga4_key_events",
    ]
    return [
        make_card(
            kind="table",
            title="伸びしろ（順位 4〜20 位 × GA4）",
            period=period,
            source_tool="get_search_opportunities",
            result_id=result_id,
            columns=columns,
            rows=[[_cell(r.get(k)) for k in keys] for r in rows[:CARD_ROWS]],
        )
    ]


def _compress_project_context(structured: dict[str, Any]) -> dict[str, Any]:
    def brief(items: Any, keys: tuple[str, ...], n: int) -> list[dict[str, Any]]:
        out = []
        for item in _list(items)[:n]:
            if isinstance(item, dict):
                out.append(
                    {
                        k: (str(item.get(k))[:300] if item.get(k) is not None else None)
                        for k in keys
                    }
                )
        return out

    return {
        "sections": brief(structured.get("sections"), ("key", "title", "content"), 10),
        "missing_sections": _list(structured.get("missingSections")),
        "competitors": brief(structured.get("competitors"), ("domain", "note"), 10),
        "key_pages": brief(structured.get("keyPages"), ("url", "note"), 10),
        "recent_research": brief(structured.get("researchLog"), ("date", "summary"), 5),
    }


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

_GA4_REPORT_TOOLS = frozenset(_GA4_TITLES)


def compress_result(tool: str, structured: dict[str, Any]) -> dict[str, Any]:
    """モデルに返す、圧縮した事実。知らないツールは主要なキーだけを残す。"""
    if tool == _GSC_TOOL:
        return _compress_gsc(structured)
    if tool == "inspect_urls":
        return {"site": structured.get("siteUrl"), "results": _inspect_rows(structured)}
    if tool == "get_google_analytics_organic_overview":
        return _compress_overview(structured)
    if tool == "get_google_analytics_measurement_health":
        return _compress_health(structured)
    if tool == "get_search_opportunities":
        return _compress_opportunities(structured)
    if tool == "get_project_context":
        return _compress_project_context(structured)
    if tool in _GA4_REPORT_TOOLS:
        return _compress_ga4_report(structured)
    return {k: v for k, v in structured.items() if k not in ("meta", "quota")}


def cards_for_result(
    tool: str, structured: dict[str, Any], result_id: str, *, today: date
) -> list[Card]:
    """画面に送るカード。カードにしないツール（project_context）は空。"""
    if tool == _GSC_TOOL:
        return _gsc_cards(structured, result_id)
    if tool == "inspect_urls":
        return _inspect_cards(structured, result_id, today)
    if tool == "get_google_analytics_organic_overview":
        return _overview_cards(structured, result_id, today)
    if tool == "get_google_analytics_measurement_health":
        return _health_cards(structured, result_id, today)
    if tool == "get_search_opportunities":
        return _opportunity_cards(structured, result_id, today)
    if tool in _GA4_REPORT_TOOLS:
        return _ga4_report_cards(tool, structured, result_id, today)
    return []
