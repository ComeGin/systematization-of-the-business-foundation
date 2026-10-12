import { QUESTION_SUFFIXES } from "../constants.js";

// 空白・句読点・記号（Unicode の P と S。絵文字を含む）
const STRIP = /[\s\p{P}\p{S}]/gu;
const SUFFIXES = [...QUESTION_SUFFIXES].sort((a, b) => b.length - a.length);

/** 照合用の正規化。NFKC → 小文字 → 空白・句読点・記号を削る → 末尾の定型句を削る（文が丸ごと消えるときは削らない） */
export function normalize(text: string): string {
  let out = text.normalize("NFKC").toLowerCase().replace(STRIP, "");
  for (let changed = true; changed; ) {
    changed = false;
    for (const suffix of SUFFIXES) {
      if (out.length > suffix.length && out.endsWith(suffix)) {
        out = out.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** 文字 n-gram の集合。サロゲートペアを 1 文字として数える */
export function grams(text: string, n: 1 | 2): Set<string> {
  const chars = Array.from(text);
  const out = new Set<string>();
  if (n === 1) {
    for (const c of chars) out.add(c);
    return out;
  }
  for (let i = 0; i + 1 < chars.length; i++) out.add(`${chars[i]}${chars[i + 1]}`);
  return out;
}

/** Dice 係数 2|A∩B| / (|A|+|B|)。どちらかが空なら 0 */
export function dice(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const g of a) if (b.has(g)) common++;
  return (2 * common) / (a.size + b.size);
}

export interface IndexedEntry<T> {
  readonly item: T;
  readonly g1: ReadonlySet<string>;
  readonly g2: ReadonlySet<string>;
}

export function buildIndex<T>(items: readonly T[], key: (item: T) => string): IndexedEntry<T>[] {
  return items.map((item) => {
    const norm = normalize(key(item));
    return { item, g1: grams(norm, 1), g2: grams(norm, 2) };
  });
}

export interface Ranked<T> {
  readonly item: T;
  readonly score: number;
}

/** 質問に近い順に並べる。1 文字の質問は 1-gram で比べる。正規化して空なら [] */
export function rank<T>(query: string, index: readonly IndexedEntry<T>[]): Ranked<T>[] {
  const q = normalize(query);
  const length = Array.from(q).length;
  if (length === 0) return [];
  const unigram = length < 2;
  const qg = grams(q, unigram ? 1 : 2);
  return index
    .map((entry, position) => ({ item: entry.item, score: dice(qg, unigram ? entry.g1 : entry.g2), position }))
    .sort((a, b) => b.score - a.score || a.position - b.position)
    .map(({ item, score }) => ({ item, score }));
}
