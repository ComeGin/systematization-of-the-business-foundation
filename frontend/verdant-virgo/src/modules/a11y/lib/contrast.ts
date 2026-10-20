/**
 * WCAG 2.x のコントラスト比（1.4.3・1.4.6・1.4.11 の計算式）。
 * 単体テストと、theme.css の役割トークンの組み合わせの検査に使う（計画書 P-4）。
 * 受ける色は #RGB と #RRGGBB だけ（トークンの値はすべてこの形。tokens.css）。それ以外は例外にする。
 */

/** sRGB の 1 チャンネル（0〜255）を線形の値にする。閾値は WCAG 2.2 の文書と同じ 0.04045 */
function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function parseHex(color: string): [number, number, number] {
  const hex = color.trim().replace(/^#/, "");
  const full = /^[0-9a-f]{3}$/i.test(hex)
    ? hex
        .split("")
        .map((c) => c + c)
        .join("")
    : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) {
    throw new Error(
      `contrastRatio: 色は #RGB か #RRGGBB で渡してください（受けた値: ${color}）。`,
    );
  }
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** 相対輝度（0〜1） */
export function relativeLuminance(color: string): number {
  const [r, g, b] = parseHex(color).map(linearize) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** コントラスト比（1〜21）。前景と背景を入れ替えても同じ値になる */
export function contrastRatio(fg: string, bg: string): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const [lighter, darker] = a >= b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}
