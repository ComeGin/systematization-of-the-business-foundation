// 動きの区分（設計書 2026-10-19-aceternity-motion-design.md）。ページごとに BaseLayout の motionZone で決め、<html data-motion-zone> に出す。
//   vivid（A）… トップ・サービスの一覧と詳細 4 本。動きとアバターを最も強く出す
//   calm（B） … A・C 以外のすべて。控えめな動きだけ
//   none（C） … 規約・ポリシー。動き・アバター・形のつながりを一切出さず、JS も読まない
export type MotionZone = "vivid" | "calm" | "none";

/** 動きを出す区分（none を除く） */
export type LiveZone = Exclude<MotionZone, "none">;
