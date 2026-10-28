// 遅い端末の判定（spec §8）。島が最初の数秒のフレーム時間（ms）を集めて渡す。
// フレーム時間の中央値が 20ms 以下（50fps 以上）なら上限の解像度、40ms 以下なら解像度 1、それより遅ければポスターのまま止める（カクついたまま動き続けない）。
// 平均ではなく中央値を使う: 測っている間に、ほかの部品の読み込み（アバターの VRM の解析・計測のタグなど）で 1 回だけ長く止まっても、
// 速い端末をそのセッションの間ずっとポスターにしない（最終レビュー I-3。計画は「平均」と書いていた）。

export interface Quality {
  /** 描画解像度（devicePixelRatio の代わりに渡す値） */
  dpr: number;
  /** false ならポスターに戻して rAF を止める */
  live: boolean;
}

const DPR_CAP = { desktop: 2, mobile: 1.5 } as const;
const SMOOTH_MS = 20;
const USABLE_MS = 40;

export function decideQuality(
  frameTimesMs: readonly number[],
  { mobile, deviceDpr }: { mobile: boolean; deviceDpr: number },
): Quality {
  const top = Math.min(mobile ? DPR_CAP.mobile : DPR_CAP.desktop, deviceDpr);
  const valid = frameTimesMs.filter((ms) => Number.isFinite(ms) && ms >= 0);
  if (valid.length === 0) return { dpr: top, live: true };
  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  if (median <= SMOOTH_MS) return { dpr: top, live: true };
  if (median <= USABLE_MS) return { dpr: Math.min(1, top), live: true };
  return { dpr: Math.min(1, top), live: false };
}
