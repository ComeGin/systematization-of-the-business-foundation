// 空と時間帯（spec §5.3）。時間帯は訪問者の端末の現地時刻で、ページを開いた時に決める。
// 1 回の訪問の中では sessionStorage の atelier:phase で固定する（境目をまたいでも絵が変わらない。§9 の 5）。
// 同じ規則を BaseLayout.astro の head の inline script も持つ（最初の描画の前に <html data-atelier-phase> を付けるため）。
import type { Phase } from "./types";

/** 各時間帯の始まり（時。以上・未満）。朝 5・昼 10・夕方 16・夜 19 */
export const PHASE_BOUNDS: readonly { phase: Phase; from: number }[] = [
  { phase: "morning", from: 5 },
  { phase: "day", from: 10 },
  { phase: "dusk", from: 16 },
  { phase: "night", from: 19 },
];

export const PHASE_STORAGE_KEY = "atelier:phase";
const PHASES: readonly Phase[] = ["morning", "day", "dusk", "night"];

export function phaseAt(date: Date): Phase {
  const h = date.getHours() + date.getMinutes() / 60;
  let phase: Phase = "night";
  for (const b of PHASE_BOUNDS) if (h >= b.from) phase = b.phase;
  return phase;
}

/** この訪問の時間帯。最初の呼び出しで決めて残し、以後は同じ値を返す。storage が使えなければ今の時刻 */
export function visitPhase(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  now: Date,
): Phase {
  try {
    const saved = storage?.getItem(PHASE_STORAGE_KEY);
    if (saved && (PHASES as readonly string[]).includes(saved))
      return saved as Phase;
  } catch {
    // 読めないときは今の時刻で決める
  }
  const phase = phaseAt(now);
  try {
    storage?.setItem(PHASE_STORAGE_KEY, phase);
  } catch {
    // 書けなくても、この描画は今の時刻の時間帯で続ける
  }
  return phase;
}

export interface PhaseLight {
  /** renderer.toneMappingExposure */
  exposure: number;
  hemi: { sky: string; ground: string; intensity: number };
  /** 天窓から差す光。無い時間帯は null */
  sun: {
    color: string;
    intensity: number;
    dir: [number, number, number];
  } | null;
  /** lamp_NN に置く点光源の強さ（0 なら置かない） */
  lamps: number;
  /** 星空を three で描く（夜だけ） */
  starfield: boolean;
  /** 空の画像（equirect）の時間帯。夜は null */
  skyUrlKey: Phase | null;
}

// 値は Task 3 の見た目の確認で直してよい（テストは構造だけを固定する）。
export const PHASE_LIGHTS: Readonly<Record<Phase, PhaseLight>> = {
  morning: {
    exposure: 1.0,
    hemi: { sky: "#cfe0f2", ground: "#8a7660", intensity: 1.1 },
    sun: { color: "#ffe2bf", intensity: 2.2, dir: [0.6, -1, -0.4] },
    lamps: 0,
    starfield: false,
    skyUrlKey: "morning",
  },
  day: {
    exposure: 1.0,
    hemi: { sky: "#dceaf7", ground: "#8f7a62", intensity: 1.3 },
    sun: { color: "#fff6ea", intensity: 3.0, dir: [0.2, -1, -0.2] },
    lamps: 0,
    starfield: false,
    skyUrlKey: "day",
  },
  dusk: {
    exposure: 0.95,
    hemi: { sky: "#e8a77f", ground: "#5a4232", intensity: 0.8 },
    sun: { color: "#ff9a5c", intensity: 1.6, dir: [-0.8, -0.6, -0.3] },
    lamps: 6,
    starfield: false,
    skyUrlKey: "dusk",
  },
  night: {
    exposure: 0.9,
    hemi: { sky: "#1c2a4a", ground: "#20180f", intensity: 0.35 },
    sun: null,
    lamps: 10,
    starfield: true,
    skyUrlKey: null,
  },
};
