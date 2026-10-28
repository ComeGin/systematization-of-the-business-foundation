// 光の粒の状態機械（spec §5.2）。three に依存しない（位置は持たず、区間と進み具合 t だけを持つ。補間は scene が行う）。
// 粒は経路の区間を legMs で 1 つ進み、色（stage）は区間の始点の段の stage。最後の区間を終えたら消える。
// perf: タブの復帰などで巨大な dt が来ても、1 回の step で進むのは 1 区間まで（端数は捨てる）。復帰の瞬間に粒がワープしない。
import { FLOWS } from "./flows";
import type { FlowId, PartId, Stage } from "./types";

export interface Particle {
  id: number;
  flow: FlowId;
  /** いまいる区間（FLOWS[flow][step] → [step + 1]） */
  step: number;
  /** 区間の中の進み具合（0〜1） */
  t: number;
  stage: Stage;
}

export interface Arrival {
  flow: FlowId;
  part: PartId;
  stage: Stage;
}

export interface ParticleSystem {
  step(dtMs: number): readonly Particle[];
  spawn(flow: FlowId): void;
  /** 直前の step で区間の終点に着いた粒（承認台のうなずき・小さなサイトの書き換えの合図） */
  arrivals(): readonly Arrival[];
}

export interface ParticleOptions {
  flows?: typeof FLOWS;
  /** 1 区間にかかる時間（ms） */
  legMs: number;
  /** 流れごとの自動で生まれる間隔（ms）。実際の間隔は 1〜1.5 倍（random でゆらす） */
  spawnEveryMs: Partial<Record<FlowId, number>>;
  random?: () => number;
}

/** 段階ごとの粒の色。白＝流れ込み、ブランドの青（--color-brand-sky）＝提案、金＝承認済み */
export const STAGE_COLOR: Readonly<Record<Stage, string>> = {
  inflow: "#FFFFFF",
  proposal: "#1298E8",
  approved: "#FFD27A",
};

export function createParticleSystem({
  flows = FLOWS,
  legMs,
  spawnEveryMs,
  random = Math.random,
}: ParticleOptions): ParticleSystem {
  let nextId = 1;
  let particles: Particle[] = [];
  let lastArrivals: Arrival[] = [];
  const timers = (Object.entries(spawnEveryMs) as [FlowId, number][]).map(
    ([flow, every]) => ({
      flow,
      every,
      elapsed: 0,
      due: every * (1 + 0.5 * random()),
    }),
  );

  const spawn = (flow: FlowId) => {
    particles.push({
      id: nextId++,
      flow,
      step: 0,
      t: 0,
      stage: flows[flow][0].stage,
    });
  };

  return {
    spawn,
    arrivals: () => lastArrivals,
    step(dtMs) {
      const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
      lastArrivals = [];
      const alive: Particle[] = [];
      for (const p of particles) {
        const route = flows[p.flow];
        let { step, t } = p;
        t += dt / legMs;
        if (t >= 1) {
          lastArrivals.push({
            flow: p.flow,
            part: route[step + 1].part,
            stage: route[step].stage,
          });
          step += 1;
          t = 0;
          if (step >= route.length - 1) continue;
        }
        alive.push({ ...p, step, t, stage: route[step].stage });
      }
      particles = alive;
      for (const timer of timers) {
        timer.elapsed += dt;
        if (timer.elapsed >= timer.due) {
          timer.elapsed = 0;
          timer.due = timer.every * (1 + 0.5 * random());
          spawn(timer.flow);
        }
      }
      return particles;
    },
  };
}
