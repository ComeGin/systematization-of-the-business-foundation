/** 文字列を「分けない語」とそれ以外に切り分ける（分けない語は whitespace-nowrap で包んで出す） */
export interface TextPiece {
  text: string;
  keep: boolean;
}

/**
 * text の中の words を、ほかの部分と分けた配列にする。つなぐと text と一字一句同じになる。
 * 長い語を先に当てる（「問い合わせ」と「問い」が両方あるときに短いほうで切らない）。
 */
export function splitKeepTogether(text: string, words: readonly string[] = []): TextPiece[] {
  const targets = [...new Set(words.filter((w) => w.length > 0))].sort((a, b) => b.length - a.length);
  if (targets.length === 0) return [{ text, keep: false }];
  const pieces: TextPiece[] = [];
  let rest = text;
  while (rest.length > 0) {
    let best: { index: number; word: string } | null = null;
    for (const word of targets) {
      const index = rest.indexOf(word);
      if (index !== -1 && (best === null || index < best.index)) best = { index, word };
    }
    if (best === null) {
      pieces.push({ text: rest, keep: false });
      break;
    }
    if (best.index > 0) pieces.push({ text: rest.slice(0, best.index), keep: false });
    pieces.push({ text: best.word, keep: true });
    rest = rest.slice(best.index + best.word.length);
  }
  return pieces;
}
