// 画面のカード（エージェント ⇔ 画面の契約。spec の 5.5）。エージェント側の visual_output/cards.py と同じ形。
// エージェントが OpenSEO の MCP の結果から作り、text stream（topic comegin.bi.card）で送る。
// 画面の数値はすべてツールの実際の結果から来る（モデルが数値を作って描くツールは無い。D4）。
// 届いたものは信用せずに検証してから描く。kind が知らない値なら表として描く。
// data の読み方の正本は cards.py の docstring（2026-11-21 に seo-bi と照合）:
//  - columns は見出しの文字列の配列（{key,label,unit} の形も念のため受ける）。rows はその順のセル（文字列・数値・null）
//  - kpi: columns は ["指標","今期","前期","増減率"]。増減率は 0.1 = +10% の比率（前期が 0 か無ければ null）
//  - line: 1 列目が横軸（日付か GA4 の yearWeek）、bar: 1 列目が分類。2 列目以降が系列
//  - CTR・率は 0〜1 の小数のまま届く（% への変換は画面）。period.compare は前期比のあるカードだけに付く

/** カードの text stream の topic（エージェントの CARD_TOPIC と同じ） */
export const CARD_TOPIC = "comegin.bi.card";

export type KnownCardKind = "kpi" | "table" | "line" | "bar";

export type CellValue = string | number | boolean | null;

export interface CardColumn {
  /** 列の識別子（文字列で送られてきたときは見出しと同じ） */
  key: string;
  /** 見出し */
  label: string;
  /** 単位（任意。例: "%"・"件"） */
  unit?: string;
}

export interface CardPeriod {
  start: string;
  end: string;
  compare?: { start: string; end: string };
}

export interface BiCard {
  v: 1;
  id: string;
  /** 知らない値もそのまま持つ（描くときに表へ倒す） */
  kind: KnownCardKind | (string & {});
  title: string;
  period: CardPeriod | null;
  source_tool: string;
  result_id: string;
  data: { columns: CardColumn[]; rows: CellValue[][] };
  /** 上位 20 行に切ったか（1 枚 15 KB を超えたとき） */
  truncated: boolean;
}

/** 1 枚の上限（エージェント側は 15 KB に収める）。これを大きく超えるものは描かない */
const MAX_CARD_CHARS = 64 * 1024;
const MAX_ROWS = 200;
const MAX_COLUMNS = 30;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 500): string | null => (typeof v === "string" && v.length <= max ? v : null);

function parseColumns(raw: unknown): CardColumn[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_COLUMNS) return null;
  const columns: CardColumn[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      columns.push({ key: entry, label: entry });
    } else if (isRecord(entry)) {
      const key = str(entry.key, 200) ?? str(entry.name, 200);
      const label = str(entry.label, 200) ?? key;
      if (!key || !label) return null;
      const unit = str(entry.unit, 20) ?? undefined;
      columns.push(unit ? { key, label, unit } : { key, label });
    } else {
      return null;
    }
  }
  return columns;
}

function parseCell(v: unknown): CellValue | undefined {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return v.length <= 2000 ? v : `${v.slice(0, 2000)}…`;
  return undefined;
}

/** 行を読む。上限（200 行・30 列）で切ったら cut を立てる（カードの truncated に足す） */
function parseRows(raw: unknown): { rows: CellValue[][]; cut: boolean } | null {
  if (!Array.isArray(raw)) return null;
  let cut = raw.length > MAX_ROWS;
  const rows: CellValue[][] = [];
  for (const row of raw.slice(0, MAX_ROWS)) {
    if (!Array.isArray(row)) return null;
    if (row.length > MAX_COLUMNS) cut = true;
    const cells = row.slice(0, MAX_COLUMNS).map(parseCell);
    if (cells.some((c) => c === undefined)) return null;
    rows.push(cells as CellValue[]);
  }
  return { rows, cut };
}

function parsePeriod(raw: unknown): CardPeriod | null {
  if (!isRecord(raw)) return null;
  const start = str(raw.start, 40);
  const end = str(raw.end, 40);
  if (!start || !end) return null;
  if (isRecord(raw.compare)) {
    const cs = str(raw.compare.start, 40);
    const ce = str(raw.compare.end, 40);
    if (cs && ce) return { start, end, compare: { start: cs, end: ce } };
  }
  return { start, end };
}

/**
 * text stream の本文（JSON）をカードにする。形が契約に合わなければ null（描かない）。
 * 受信の途中（JSON が閉じていない）も null になる。
 */
export function parseCard(text: string): BiCard | null {
  if (text.length > MAX_CARD_CHARS) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.v !== 1) return null;
  const id = str(raw.id, 200);
  const kind = str(raw.kind, 40);
  const title = str(raw.title);
  if (!id || !kind || title === null) return null;
  if (!isRecord(raw.data)) return null;
  const columns = parseColumns(raw.data.columns);
  const parsedRows = parseRows(raw.data.rows);
  if (!columns || !parsedRows) return null;
  return {
    v: 1,
    id,
    kind,
    title,
    period: parsePeriod(raw.period),
    source_tool: str(raw.source_tool, 200) ?? "",
    result_id: str(raw.result_id, 200) ?? "",
    data: { columns, rows: parsedRows.rows },
    truncated: raw.truncated === true || parsedRows.cut,
  };
}

/** 数値に読める値を数値にする（グラフ用）。読めなければ null */
export function toNumber(v: CellValue): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/[,%\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
