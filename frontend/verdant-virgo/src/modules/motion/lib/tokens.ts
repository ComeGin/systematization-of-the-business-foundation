// モーションのトークン（動きの規則 7）。値は src/styles/theme.css の --motion-* と同じ。部品ごとに数値を書かない。
// CSS で書けるところは CSS 変数（var(--motion-duration-medium) など）を使い、JS（WebGL・rAF）の側だけここを使う。
// reduced-motion のときは、JS で動かす部品そのものを静止させる（a11y の prefersReducedMotion）。ここで時間を 0 にはしない。

/** 時間（ms）。theme.css の --motion-duration-{micro,small,medium,large,ambient,glow} */
export const DURATION = {
  micro: 120,
  small: 200,
  medium: 320,
  large: 600,
  /** ゆっくり漂う動き（背景の光線・スポットライトなど）の 1 周。--motion-duration-ambient */
  ambient: 8000,
  /** 光の明るさ（光の縁・ピンの光）の 1 周。1 秒以上（点滅は 1 秒に 3 回まで。2.3.1）。--motion-duration-glow */
  glow: 2400,
} as const;

/** 緩急（cubic-bezier の 4 つの値）。theme.css の --motion-ease-{standard,emphasized} */
export const EASE = {
  standard: [0.2, 0, 0, 1],
  emphasized: [0.05, 0.7, 0.1, 1],
} as const;

export type DurationName = keyof typeof DURATION;
export type EaseName = keyof typeof EASE;

/** 回り続ける形（送信中の弧）の 1 周の時間。large の 2 倍（新しい値を足さない） */
export const SPIN_PERIOD = DURATION.large * 2;

/**
 * cubic-bezier(x1, y1, x2, y2) を 0〜1 の進み → 0〜1 の値の関数にする（CSS と同じ曲線を JS の tween で使う）。
 * x から t をニュートン法で求め、収束しなければ二分法に切り替える。
 */
export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  const solve = (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const error = sampleX(t) - x;
      if (Math.abs(error) < 1e-6) return t;
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= error / slope;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    while (hi - lo > 1e-6) {
      if (sampleX(t) < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };

  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return sampleY(solve(x));
  };
}

/** トークンの名前から緩急の関数を作る */
export function easing(name: EaseName): (x: number) => number {
  const [x1, y1, x2, y2] = EASE[name];
  return cubicBezier(x1, y1, x2, y2);
}

/**
 * 色の CSS 変数（役割トークン・パレット）を、計算後の #rrggbb にする。WebGL の部品は #hex しか読めないものがあるため。
 * ブラウザでだけ呼ぶ。解決できなければ fallback を返す（呼び出し側は必ずトークン名で渡し、色の値を直書きしない）。
 */
export function cssColor(
  variable: `--${string}`,
  fallback = "#000000",
): string {
  if (typeof document === "undefined") return fallback;
  const probe = document.createElement("span");
  probe.style.color = `var(${variable})`;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(computed);
  if (!match) return fallback;
  return `#${match
    .slice(1, 4)
    .map((value) => Number(value).toString(16).padStart(2, "0"))
    .join("")}`;
}
