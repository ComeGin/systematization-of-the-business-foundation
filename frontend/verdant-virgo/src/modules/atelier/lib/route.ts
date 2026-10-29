// 道のレール（spec §5.1・§6.2）。glb の rail_NN の点列を折れ線にし、弧長で 0〜1 に割る。カメラはこの上だけを動く（置き物を通り抜けない）。
// 止まる所は、置き物の点にいちばん近いレールの位置（「前へ進む」のボタンが次に止まる所）。
// 2026-10-30（ユーザーの指示）: 右側だけでなく左側も通れるよう、道を 2 本にする（lane 0＝右の道〈glb の rail_NN〉・1＝左の道〈各点を leftDx だけ x へずらす〉）。
// t は 2 本で共通（弧長は右の道で測る）。lane が 0〜1 の間は 2 本の間の位置。2 本が大きく離れている所では道を替えない（canSwitch）。
import type { PropId } from "./types";

type Vec3 = [number, number, number];

export interface Rail {
  /** 折れ線の長さ（m） */
  length: number;
  /** lane: 0＝右の道・1＝左の道（既定 0） */
  at(t: number, lane?: number): { position: Vec3; forward: Vec3 };
  /** その t での 2 本の道の離れ（m） */
  laneGap(t: number): number;
  /** その t で道を替えてよいか（2 本の離れが LANE_SWITCH_MAX_GAP 以下。アバターのそばで替えると横切る） */
  canSwitch(t: number): boolean;
  stops: readonly { id: PropId; t: number }[];
  /** 今の t より先の止まる所。無ければ 1 */
  nextStop(t: number): number;
  /** 今の t より手前の止まる所。無ければ 0 */
  prevStop(t: number): number;
}

const EPS = 1e-6;
/** これより離れている所では道を替えない（m） */
export const LANE_SWITCH_MAX_GAP = 1.2;
/**
 * 左の道（2026-10-30 ユーザーの指示: 右側だけでなく左側も通れるように）。glb の rail_00〜rail_08 の各点を x へずらす量（m）。
 * 入口（00・01）と、展示の壁より奥（06〜08。仕切りの左は壁際まで狭く通れない）は右の道と同じ。
 * 02 はアバター（x=0）を左（x=-1.0）からよける。03〜05 は左の壁沿いの置き物（x=-3.3 付近の机）へ寄る（机の手前 1.4m 以上を空ける）
 */
export const LEFT_LANE_DX: readonly number[] = [0, 0, -2.0, -1.4, -0.9, -0.6, 0, 0, 0];
const clamp01 = (t: number) =>
  Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

export function createRail(
  points: readonly Vec3[],
  stops: readonly { id: PropId; point: Vec3 }[],
  leftDx?: readonly number[],
): Rail {
  if (points.length < 2) throw new Error("レールの点が 2 つ未満です");
  if (leftDx && leftDx.length !== points.length)
    throw new Error("左の道のずれ（leftDx）の数がレールの点の数と違います");
  const left: Vec3[] = points.map((p, i) => [p[0] + (leftDx?.[i] ?? 0), p[1], p[2]]);
  // 各区間の始まりの弧長
  const starts = [0];
  for (let i = 1; i < points.length; i++)
    starts.push(starts[i - 1] + len(sub(points[i], points[i - 1])));
  const total = starts[starts.length - 1];
  if (total <= 0) throw new Error("レールの長さが 0 です");

  const segmentAt = (s: number) => {
    let i = 0;
    while (i < points.length - 2 && starts[i + 1] <= s) i++;
    return i;
  };

  /** 1 本の道（pts）の、右の道の区間 i・割合 k の位置と向き */
  const onPath = (pts: readonly Vec3[], i: number, k: number) => {
    const a = pts[i];
    const d = sub(pts[i + 1], a);
    const l = len(d) || 1;
    return {
      position: [a[0] + d[0] * k, a[1] + d[1] * k, a[2] + d[2] * k] as Vec3,
      forward: [d[0] / l, d[1] / l, d[2] / l] as Vec3,
    };
  };
  const locate = (t: number) => {
    const s = clamp01(t) * total;
    const i = segmentAt(s);
    const l = len(sub(points[i + 1], points[i])) || 1;
    return { i, k: Math.min(1, (s - starts[i]) / l) };
  };

  const at = (t: number, lane = 0) => {
    const { i, k } = locate(t);
    const r = onPath(points, i, k);
    const w = clamp01(lane);
    if (w === 0) return r;
    const lp = onPath(left, i, k);
    const mix = (a: Vec3, b: Vec3): Vec3 => [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
    const f = mix(r.forward, lp.forward);
    const fl = len(f) || 1;
    return { position: mix(r.position, lp.position), forward: [f[0] / fl, f[1] / fl, f[2] / fl] as Vec3 };
  };
  const laneGap = (t: number) => len(sub(at(t, 1).position, at(t, 0).position));

  // 点から折れ線への最短距離の位置（弧長）
  const nearestT = (p: Vec3) => {
    let best = { dist: Infinity, s: 0 };
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const d = sub(points[i + 1], a);
      const l2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
      const ap = sub(p, a);
      const k = l2
        ? Math.min(
            1,
            Math.max(0, (ap[0] * d[0] + ap[1] * d[1] + ap[2] * d[2]) / l2),
          )
        : 0;
      const q: Vec3 = [a[0] + d[0] * k, a[1] + d[1] * k, a[2] + d[2] * k];
      const dist = len(sub(p, q));
      if (dist < best.dist) best = { dist, s: starts[i] + Math.sqrt(l2) * k };
    }
    return best.s / total;
  };

  const sorted = stops
    .map((s) => ({ id: s.id, t: nearestT(s.point) }))
    .sort((a, b) => a.t - b.t);

  return {
    length: total,
    at,
    laneGap,
    canSwitch: (t) => laneGap(t) <= LANE_SWITCH_MAX_GAP + EPS,
    stops: sorted,
    nextStop: (t) => sorted.find((s) => s.t > clamp01(t) + EPS)?.t ?? 1,
    prevStop: (t) =>
      [...sorted].reverse().find((s) => s.t < clamp01(t) - EPS)?.t ?? 0,
  };
}
