// ページ移動の形のつながり（View Transitions）で使う view-transition-name。1 ページの中で同じ名前は 1 つだけにする。
// サービスはカードの見出し → 詳細の h1 だけをつなぐ（アイコンはカードにも詳細にも無いので持たない。裁定 R13）。
// 遷移先のページは対応する要素にこの名前を静的に持ち、遷移元のページは押したカード・ボタンにだけ移動の直前に付ける（morph.ts）。
export const VT = {
  serviceTitle: "vt-service-title",
  articleTitle: "vt-article-title",
  articleMedia: "vt-article-media",
  contactTitle: "vt-contact-title",
  /** トップのアトリエ（AtelierHero の根）→ 下層ページの冒頭の静止画（AtelierStill の根）。遷移の間だけ付ける（2026-10-29） */
  atelier: "vt-atelier",
} as const;

export type VtMap = typeof VT;
export type VtName = VtMap[keyof VtMap];

/** 要素に静的に付ける style 属性の値（遷移先のページの h1・アイキャッチ） */
export const vtStyle = (name: VtName): string => `view-transition-name: ${name}`;
