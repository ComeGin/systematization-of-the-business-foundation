// 進む・止まるの加減速（spec §6.2）。速さを線形に加減速し、レールの位置 t（0〜1）を speed × dt だけ進める。
// 急に止まらない（アンチゴール 2）。dt は 0〜0.1 秒に収める（タブの復帰などで 1 フレームが長くても飛ばない）。

export interface Walker {
  /** レールの位置（0〜1） */
  t: number;
  /** 1 秒あたりの t の変化（負なら戻る） */
  speed: number;
  /** intent: 1 進む・0 止まる・-1 戻る。新しい t を返す */
  step(dtSec: number, intent: -1 | 0 | 1): number;
  jumpTo(t: number): void;
}

const MAX_DT = 0.1;
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

export function createWalker(opts: {
  maxSpeed: number;
  accelSec: number;
  decelSec: number;
  start?: number;
}): Walker {
  const accel = opts.maxSpeed / opts.accelSec;
  const decel = opts.maxSpeed / opts.decelSec;
  const w: Walker = {
    t: clamp01(opts.start ?? 0),
    speed: 0,
    step(dtSec, intent) {
      const dt = Number.isFinite(dtSec)
        ? Math.min(MAX_DT, Math.max(0, dtSec))
        : 0;
      if (dt === 0) return w.t;
      const target = intent * opts.maxSpeed;
      // 向きを変える・止まるときは減速の強さ、同じ向きへ速めるときは加速の強さ
      const rate =
        Math.abs(target) > Math.abs(w.speed) &&
        Math.sign(target) !== -Math.sign(w.speed)
          ? accel
          : decel;
      const diff = target - w.speed;
      w.speed += Math.sign(diff) * Math.min(Math.abs(diff), rate * dt);
      const next = clamp01(w.t + w.speed * dt);
      if ((next === 1 && w.speed > 0) || (next === 0 && w.speed < 0))
        w.speed = 0;
      w.t = next;
      return w.t;
    },
    jumpTo(t) {
      w.t = clamp01(Number.isFinite(t) ? t : 0);
      w.speed = 0;
    },
  };
  return w;
}
