"""SEO の指標（純粋関数。I/O を持たない）。

入力は OpenSEO の structuredContent の行（dict）をそのまま受ける。
- GSC: ``{"keys": [...], "clicks", "impressions", "ctr"(0〜1), "position"(1 始まり)}``
- GA4（organic_landing_pages）: ``{"hostName", "landingPage", "sessions", "keyEvents",
  "sessionKeyEventRate", ...}``

しきい値は既定値を引数にしてある。サイトはまだ小さい（表示回数が数十〜数百）ので、
既定値は小さめにしてある。
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

# ---------------------------------------------------------------------------
# 期間
# ---------------------------------------------------------------------------

GSC_LAG_DAYS = 3
"""GSC は 2〜3 日遅れる（日付は太平洋時間）。終端を今日（JST）の 3 日前にする。"""


@dataclass(frozen=True)
class DateWindow:
    start: date
    end: date

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1

    def as_args(self) -> dict[str, str]:
        """OpenSEO のツールの ``startDate`` / ``endDate`` 引数。"""
        return {"startDate": self.start.isoformat(), "endDate": self.end.isoformat()}


@dataclass(frozen=True)
class ComparisonWindows:
    current: DateWindow
    previous: DateWindow
    """current の直前の、同じ長さの期間。"""


def comparison_windows(
    today: date, *, days: int = 28, lag_days: int = GSC_LAG_DAYS
) -> ComparisonWindows:
    """今期（終端は today の lag_days 日前、長さ days 日）と、直前の同じ長さの前期。

    28 日は曜日の偏りを打ち消すため（4 週ちょうど）。夜の観測（analytics-reporter）は 35 日だが、
    対話では GA4 のツールの既定（直近 28 日）と揃えたほうが、モデルが呼び直したときの数値と一致する。
    """
    end = today - timedelta(days=lag_days)
    start = end - timedelta(days=days - 1)
    prev_end = start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=days - 1)
    return ComparisonWindows(
        current=DateWindow(start, end), previous=DateWindow(prev_start, prev_end)
    )


# ---------------------------------------------------------------------------
# 前期比
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Change:
    current: float | None
    previous: float | None

    @property
    def absolute(self) -> float | None:
        if self.current is None or self.previous is None:
            return None
        return self.current - self.previous

    @property
    def ratio(self) -> float | None:
        """増減率（0.1 = +10%）。前期が 0・欠けているなら None（「前期なし」として扱う）。"""
        if self.absolute is None or not self.previous:
            return None
        return self.absolute / self.previous


def period_change(current: float | None, previous: float | None) -> Change:
    return Change(current=current, previous=previous)


def format_ratio(ratio: float | None) -> str:
    """増減率を「+12%」「-3.5%」の形にする。None は「前期比なし」。"""
    if isinstance(ratio, bool) or not isinstance(ratio, (int, float)):
        return "前期比なし"
    pct = ratio * 100
    return f"{pct:+.0f}%" if abs(pct) >= 10 else f"{pct:+.1f}%"


def _num(row: Mapping[str, Any], key: str) -> float | None:
    value = row.get(key)
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _key(row: Mapping[str, Any], index: int = 0) -> str:
    keys = row.get("keys")
    if isinstance(keys, list) and len(keys) > index:
        return str(keys[index])
    return ""


@dataclass(frozen=True)
class GscTotals:
    clicks: float
    impressions: float
    ctr: float | None
    """clicks / impressions。"""
    position: float | None
    """表示回数で重み付けした平均掲載順位。"""


def gsc_totals(rows: Iterable[Mapping[str, Any]]) -> GscTotals:
    """GSC の行を合計する。page の次元の行を渡すと、サイト全体に近い合計になる
    （query の次元は匿名化されたクエリが落ちるので、合計が小さく出る）。"""
    clicks = impressions = weighted = 0.0
    weight = 0.0
    for row in rows:
        c = _num(row, "clicks") or 0.0
        i = _num(row, "impressions") or 0.0
        p = _num(row, "position")
        clicks += c
        impressions += i
        if p is not None and i > 0:
            weighted += p * i
            weight += i
    return GscTotals(
        clicks=clicks,
        impressions=impressions,
        ctr=(clicks / impressions) if impressions > 0 else None,
        position=(weighted / weight) if weight > 0 else None,
    )


@dataclass(frozen=True)
class Mover:
    key: str
    current_clicks: float
    previous_clicks: float
    current_impressions: float
    previous_impressions: float

    @property
    def delta_clicks(self) -> float:
        return self.current_clicks - self.previous_clicks


def gsc_movers(
    current_rows: Iterable[Mapping[str, Any]],
    previous_rows: Iterable[Mapping[str, Any]],
    *,
    limit: int = 5,
) -> tuple[list[Mover], list[Mover]]:
    """先頭の次元（page・query）ごとのクリックの増減。(落ちた順, 伸びた順) を返す。"""
    cur: dict[str, tuple[float, float]] = {}
    prev: dict[str, tuple[float, float]] = {}
    for rows, bucket in ((current_rows, cur), (previous_rows, prev)):
        for row in rows:
            k = _key(row)
            if not k:
                continue
            c, i = bucket.get(k, (0.0, 0.0))
            bucket[k] = (
                c + (_num(row, "clicks") or 0.0),
                i + (_num(row, "impressions") or 0.0),
            )
    movers = [
        Mover(
            key=k,
            current_clicks=cur.get(k, (0.0, 0.0))[0],
            previous_clicks=prev.get(k, (0.0, 0.0))[0],
            current_impressions=cur.get(k, (0.0, 0.0))[1],
            previous_impressions=prev.get(k, (0.0, 0.0))[1],
        )
        for k in set(cur) | set(prev)
    ]
    losers = sorted(
        (m for m in movers if m.delta_clicks < 0), key=lambda m: m.delta_clicks
    )
    gainers = sorted(
        (m for m in movers if m.delta_clicks > 0), key=lambda m: -m.delta_clicks
    )
    return losers[:limit], gainers[:limit]


# ---------------------------------------------------------------------------
# あと一歩の語（順位 4〜20 位で表示回数が多いクエリ）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StrikingQuery:
    query: str
    impressions: float
    clicks: float
    ctr: float | None
    position: float


def striking_distance_queries(
    rows: Iterable[Mapping[str, Any]],
    *,
    min_position: float = 4.0,
    max_position: float = 20.0,
    min_impressions: float = 10.0,
    limit: int = 10,
) -> list[StrikingQuery]:
    """順位 4〜20 位で表示回数が多い順。GSC は順位で絞れないので、取った行をここで絞る。"""
    out: list[StrikingQuery] = []
    for row in rows:
        p = _num(row, "position")
        i = _num(row, "impressions") or 0.0
        q = _key(row)
        if not q or p is None or not (min_position <= p <= max_position):
            continue
        if i < min_impressions:
            continue
        out.append(
            StrikingQuery(
                query=q,
                impressions=i,
                clicks=_num(row, "clicks") or 0.0,
                ctr=_num(row, "ctr"),
                position=p,
            )
        )
    out.sort(key=lambda s: (-s.impressions, s.position))
    return out[:limit]


# ---------------------------------------------------------------------------
# 掲載順位に対する期待 CTR を下回るページ
# ---------------------------------------------------------------------------

# 掲載順位ごとの CTR の目安（自然検索・デスクトップとモバイルの合算の公開調査を丸めた値）。
# Google が公表する値ではない。SERP の機能（AI による概要・広告・強調スニペット）で大きく変わるので、
# 「目安の半分を下回る」ほど大きく外れたものだけを拾い、話すときも「目安」と言う。
_EXPECTED_CTR_BY_POSITION: tuple[float, ...] = (
    0.28,  # 1 位
    0.15,
    0.11,
    0.08,
    0.07,
    0.05,
    0.04,
    0.03,
    0.03,
    0.025,  # 10 位
)
_EXPECTED_CTR_PAGE_2 = 0.01  # 11〜20 位
_EXPECTED_CTR_BEYOND = 0.005  # 21 位以降


def expected_ctr(position: float) -> float:
    """掲載順位（平均。小数）に対する CTR の目安。間の順位は線形に補う。"""
    if position <= 1:
        return _EXPECTED_CTR_BY_POSITION[0]
    if position <= 10:
        lower = int(position)
        frac = position - lower
        a = _EXPECTED_CTR_BY_POSITION[lower - 1]
        b = (
            _EXPECTED_CTR_BY_POSITION[lower]
            if lower < len(_EXPECTED_CTR_BY_POSITION)
            else _EXPECTED_CTR_PAGE_2
        )
        return a + (b - a) * frac
    if position <= 20:
        return _EXPECTED_CTR_PAGE_2
    return _EXPECTED_CTR_BEYOND


@dataclass(frozen=True)
class CtrGap:
    key: str
    impressions: float
    clicks: float
    ctr: float
    expected_ctr: float
    position: float

    @property
    def ratio_to_expected(self) -> float:
        return self.ctr / self.expected_ctr if self.expected_ctr > 0 else 0.0


def ctr_underperformers(
    rows: Iterable[Mapping[str, Any]],
    *,
    threshold_ratio: float = 0.5,
    min_impressions: float = 50.0,
    max_position: float = 10.0,
    limit: int = 10,
) -> list[CtrGap]:
    """期待 CTR の ``threshold_ratio`` 倍を下回る行（page の次元を想定）。

    11 位以降は 2 ページ目でクリックされにくいのが当然なので、``max_position`` で外す
    （そちらは「あと一歩の語」で拾う）。表示回数が多い順。
    """
    out: list[CtrGap] = []
    for row in rows:
        p = _num(row, "position")
        i = _num(row, "impressions") or 0.0
        c = _num(row, "clicks") or 0.0
        k = _key(row)
        if not k or p is None or p > max_position or i < min_impressions:
            continue
        actual = _num(row, "ctr")
        if actual is None:
            actual = c / i if i > 0 else 0.0
        exp = expected_ctr(p)
        if actual < exp * threshold_ratio:
            out.append(
                CtrGap(
                    key=k,
                    impressions=i,
                    clicks=c,
                    ctr=actual,
                    expected_ctr=exp,
                    position=p,
                )
            )
    out.sort(key=lambda g: -g.impressions)
    return out[:limit]


# ---------------------------------------------------------------------------
# 自然検索の流入があるのにキーイベントが少ない LP
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LowConversionPage:
    page: str
    sessions: float
    key_events: float
    key_event_rate: float | None
    """sessionKeyEventRate（0〜1）。"""
    site_rate: float | None
    """比べた全体の率（LP の合計のキーイベント ÷ 合計のセッション）。"""


def low_conversion_landing_pages(
    rows: Iterable[Mapping[str, Any]],
    *,
    min_sessions: float = 10.0,
    relative_threshold: float = 0.5,
    limit: int = 10,
) -> list[LowConversionPage]:
    """セッションが ``min_sessions`` 以上で、キーイベントの率が全体の ``relative_threshold`` 倍を下回る LP。

    全体のキーイベントが 0 のとき（キーイベント未設定・計測の不具合の疑い）は、どの LP も
    「低い」と言えないので、セッションが多い LP をキーイベント 0 として返す。その場合の解釈は
    計測の健全性（measurement_health）と合わせて行う。
    """
    materialized = list(rows)
    total_sessions = sum(_num(r, "sessions") or 0.0 for r in materialized)
    total_events = sum(_num(r, "keyEvents") or 0.0 for r in materialized)
    site_rate = (total_events / total_sessions) if total_sessions > 0 else None

    out: list[LowConversionPage] = []
    for row in materialized:
        sessions = _num(row, "sessions") or 0.0
        if sessions < min_sessions:
            continue
        events = _num(row, "keyEvents") or 0.0
        rate = _num(row, "sessionKeyEventRate")
        if rate is None:
            rate = events / sessions if sessions > 0 else None
        page = f"{row.get('hostName') or ''}{row.get('landingPage') or ''}"
        if not page:
            continue
        low = (
            events == 0
            if not site_rate
            else (rate is not None and rate < site_rate * relative_threshold)
        )
        if low:
            out.append(
                LowConversionPage(
                    page=page,
                    sessions=sessions,
                    key_events=events,
                    key_event_rate=rate,
                    site_rate=site_rate,
                )
            )
    out.sort(key=lambda p: -p.sessions)
    return out[:limit]


# ---------------------------------------------------------------------------
# 1 つのクエリに複数のページ（カニバリゼーション）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CannibalPage:
    page: str
    impressions: float
    clicks: float
    position: float | None


@dataclass(frozen=True)
class Cannibalization:
    query: str
    total_impressions: float
    pages: tuple[CannibalPage, ...]
    """表示回数が多い順。"""


def cannibalization(
    query_page_rows: Iterable[Mapping[str, Any]],
    *,
    min_query_impressions: float = 20.0,
    min_share: float = 0.1,
    limit: int = 10,
) -> list[Cannibalization]:
    """``dimensions=["query","page"]`` の行から、表示回数の ``min_share`` 以上を持つページが
    2 つ以上あるクエリを返す（表示回数が多い順）。"""
    by_query: dict[str, list[CannibalPage]] = defaultdict(list)
    for row in query_page_rows:
        q = _key(row, 0)
        page = _key(row, 1)
        if not q or not page:
            continue
        by_query[q].append(
            CannibalPage(
                page=page,
                impressions=_num(row, "impressions") or 0.0,
                clicks=_num(row, "clicks") or 0.0,
                position=_num(row, "position"),
            )
        )
    out: list[Cannibalization] = []
    for q, pages in by_query.items():
        total = sum(p.impressions for p in pages)
        if total < min_query_impressions:
            continue
        significant = [
            p for p in pages if total > 0 and p.impressions / total >= min_share
        ]
        if len(significant) < 2:
            continue
        significant.sort(key=lambda p: -p.impressions)
        out.append(
            Cannibalization(query=q, total_impressions=total, pages=tuple(significant))
        )
    out.sort(key=lambda c: -c.total_impressions)
    return out[:limit]


# ---------------------------------------------------------------------------
# 計測の健全性
# ---------------------------------------------------------------------------

MEASUREMENT_ISSUE_LABELS: dict[str, str] = {
    "no_web_stream": "Web のデータストリームが無い",
    "enhanced_measurement_disabled": "拡張計測が無効",
    "site_search_measurement_disabled": "サイト内検索の計測が無効",
    "no_key_events_configured": "キーイベントが 1 つも設定されていない",
}

# サイト内検索の計測はこのサイトでは使っていない（DA-02 の指標に無い）ので、解釈を止める問題に数えない
_IGNORABLE_ISSUES = frozenset({"site_search_measurement_disabled"})


def measurement_issues(health: Mapping[str, Any]) -> list[str]:
    """measurement_health の ``issues`` のうち、数値の解釈より先に伝えるべきもの（日本語）。"""
    issues = health.get("issues")
    if not isinstance(issues, list):
        return []
    return [
        MEASUREMENT_ISSUE_LABELS.get(str(code), str(code))
        for code in issues
        if str(code) not in _IGNORABLE_ISSUES
    ]


def round_or_none(value: float | None, digits: int = 1) -> float | None:
    return None if value is None else round(value, digits)


def top(rows: Sequence[Any], n: int) -> list[Any]:
    return list(rows[: max(n, 0)])
