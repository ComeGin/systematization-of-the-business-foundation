// 数え上げ（CountUp）の途中の文字を作る純粋な関数。DOM にも React にも依存しない。
// 最終値の文字（"72.2%"・"1,234人"）の数字の部分だけを progress（0〜1）で比例させ、小数の桁・3 桁区切り・前後の文字を保つ。

// 数字の連なり。カンマは 3 桁区切り（1,234）のときだけ数字の一部にする（"10, 20" の数字の直後のカンマは前後の文字として残す）。
// 符号は扱わない（最終値は 0 以上の数を前提にする）
const NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/** progress を 0〜1 に丸める。数でない（NaN）ときは 0 */
function clamp01(progress: number): number {
  if (Number.isNaN(progress)) return 0;
  return Math.min(1, Math.max(0, progress));
}

/**
 * finalText の数字を progress 倍にした文字を返す。数字が無ければ finalText のまま。
 * 数字が複数あれば（"10〜20人"）それぞれを比例させる。小数の桁数は最終値と同じ（"0.0%"）、カンマがあれば 3 桁区切りも保つ。
 */
export function formatCount(finalText: string, progress: number): string {
  const ratio = clamp01(progress);
  return finalText.replace(NUMBER, (match) => {
    const grouped = match.includes(",");
    const dot = match.indexOf(".");
    const decimals = dot === -1 ? 0 : match.length - dot - 1;
    const value = Number(match.replace(/,/g, "")) * ratio;
    if (grouped) {
      return value.toLocaleString("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
    }
    return value.toFixed(decimals);
  });
}
