// ポインターの位置から CSS 変数の値を作る純粋な関数（Feature の光の縁と 3D Card の傾き。計画書 Task 4）。
// DOM に触らない。GlowGrid／Tilt3d の素の script が、rAF の中でこの値を style.setProperty に渡す。

export interface PointerRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** -0 を 0 にそろえる（toEqual や CSS の文字列に -0 を出さない） */
const clean = (value: number) => (Object.is(value, -0) ? 0 : value);

/** 数を小数 digits 桁に丸める。NaN・Infinity は fallback */
const round = (value: number, digits: number, fallback = 0) => {
  if (!Number.isFinite(value)) return fallback;
  const base = 10 ** digits;
  return clean(Math.round(value * base) / base);
};

/** rect の中での位置を 0〜1 に丸めて返す。幅か高さが 0（または座標が数でない）ときは null */
function ratioIn(rect: PointerRect, x: number, y: number) {
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return {
    rx: clamp((x - rect.left) / rect.width),
    ry: clamp((y - rect.top) / rect.height),
  };
}

/**
 * ポインターの位置から、カードの傾き（deg）を作る。中心で 0。
 * 右端で rotateY = +maxDeg、上端で rotateX = +maxDeg（ポインターのある側が奥へ沈む＝押される手触り）。
 * 範囲の外の座標は端の値に丸める。幅か高さが 0、座標や maxDeg が数でないときは 0。
 */
export function tiltFromPointer(
  rect: PointerRect,
  x: number,
  y: number,
  maxDeg: number,
): { rotateX: number; rotateY: number } {
  const ratio = ratioIn(rect, x, y);
  if (!ratio || !Number.isFinite(maxDeg)) return { rotateX: 0, rotateY: 0 };
  return {
    rotateY: round((ratio.rx * 2 - 1) * maxDeg, 2),
    rotateX: round((1 - ratio.ry * 2) * maxDeg, 2),
  };
}

/**
 * ポインターの位置から、光の中心（カードの中の割合）を作る。"37.5%" の形（小数 1 桁まで）。
 * 範囲の外は 0%〜100% に丸める。幅か高さが 0（座標が数でない）ときは中心の 50%。
 */
export function glowFromPointer(
  rect: PointerRect,
  x: number,
  y: number,
): { x: string; y: string } {
  const ratio = ratioIn(rect, x, y);
  if (!ratio) return { x: "50%", y: "50%" };
  return {
    x: `${round(ratio.rx * 100, 1, 50)}%`,
    y: `${round(ratio.ry * 100, 1, 50)}%`,
  };
}
