// 人形（lib/figure.ts）が読む資産の URL（2026-10-28。2026-10-29 にアトリエの身ぶり 6 本を足した。atelier spec §6.4）。
// ほかのモジュール（atelier）は avatar の index.ts を通してこれを読む。
import modelUrl from "../assets/avatar.vrm?url";
import idleUrl from "../assets/motions/idle.json?url";
import greetingUrl from "../assets/motions/greeting.json?url";
import nodUrl from "../assets/motions/nod.json?url";
import peaceUrl from "../assets/motions/peace.json?url";
import pointUrl from "../assets/motions/point.json?url";
import showFullBodyUrl from "../assets/motions/show-full-body.json?url";
import thinkUrl from "../assets/motions/think.json?url";

export const AVATAR_FIGURE_ASSETS = {
  modelUrl,
  idleUrl,
  clipUrls: {
    greeting: greetingUrl,
    nod: nodUrl,
    peace: peaceUrl,
    point: pointUrl,
    "show-full-body": showFullBodyUrl,
    think: thinkUrl,
  },
} as const;
