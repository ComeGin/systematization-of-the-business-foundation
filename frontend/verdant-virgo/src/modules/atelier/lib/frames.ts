// 実績の展示の壁の額（spec §8）。額の枠は最大数（自社 4 ＋ 3 社）を先に置き、空きは無地の額（null）にして構図を崩さない。
// 他社の額は掲載許可が granted の件だけ（publishedCases を通す）。移り先はトップの 1-8 導入事例の節（外部へ直接は飛ばさない）。
// 自社の額で移り先を持つのは、裏付けるページがある jis だけ。agents は環境構築のワークステーションと移り先が重なるので飾り。
import { publishedCases, type CaseStudy } from "@/modules/site-content/cases";
import type { FrameDef } from "./types";

export const SELF_FRAMES: readonly FrameDef[] = [
  { id: "experience", kind: "self", href: null, still: null },
  { id: "jis", kind: "self", href: "/accessibility/", still: "accessibility" },
  { id: "lighthouse", kind: "self", href: null, still: null },
  { id: "agents", kind: "self", href: null, still: null },
];

export const FRAME_SLOTS = 7;

/** 壁の額を左から順に。長さは常に FRAME_SLOTS。空きは null */
export function wallFrames(
  cases: readonly CaseStudy[],
): readonly (FrameDef | null)[] {
  const caseFrames: FrameDef[] = publishedCases(cases).map((c) => ({
    id: `case:${c.id}`,
    kind: "case",
    // トップの 1-8（実績）の見出し（index.astro の SectionHeading id="top-cases"）
    href: "/#top-cases",
    still: null,
  }));
  const frames = [...SELF_FRAMES, ...caseFrames].slice(0, FRAME_SLOTS);
  return [
    ...frames,
    ...Array.from({ length: FRAME_SLOTS - frames.length }, () => null),
  ];
}
