// 押せる部品の点（canvas の上に重ねる <button>）の置き方。DioramaTouch が毎フレーム・大きさの変化のたびに呼ぶ。
// a11y: 点どうしを minGap 以上離す（WCAG 2.5.8 ターゲットの大きさ。32px の点が重ならない）。
//       枠の外に出た部品も隠さず、枠の内側（margin）に寄せる（隠すと Tab で届かない時ができる。2.1.1）。
// 近すぎる組は、互いの中心を結ぶ向きに半分ずつ押し離す（数回くり返す）。同じ位置の組は、順番で決めた向きに離す。

export interface MarkerPoint {
  id: string;
  x: number;
  y: number;
}

export interface MarkerLayoutOptions {
  width: number;
  height: number;
  margin: number;
  minGap: number;
}

const ROUNDS = 6;

export function layoutMarkers(
  points: readonly MarkerPoint[],
  { width, height, margin, minGap }: MarkerLayoutOptions,
): MarkerPoint[] {
  const clampX = (x: number) =>
    Math.min(
      width - margin,
      Math.max(margin, Number.isFinite(x) ? x : width / 2),
    );
  const clampY = (y: number) =>
    Math.min(
      height - margin,
      Math.max(margin, Number.isFinite(y) ? y : height / 2),
    );
  const out = points.map((p) => ({ id: p.id, x: clampX(p.x), y: clampY(p.y) }));
  for (let round = 0; round < ROUNDS; round++) {
    let moved = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i];
        const b = out[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= minGap) continue;
        if (d < 0.01) {
          const angle = ((i + j) * Math.PI) / 3;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          d = 1;
        } else {
          dx /= d;
          dy /= d;
        }
        const push = (minGap - Math.max(d, 0)) / 2 + 0.01;
        a.x = clampX(a.x - dx * push);
        a.y = clampY(a.y - dy * push);
        b.x = clampX(b.x + dx * push);
        b.y = clampY(b.y + dy * push);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return out;
}
