// 会社名とその読み、会社の情報（トップの構造化データの値）。01-content-spec.md §7.2（2026-11-03 に新設）。JSON-LD の形は seo モジュール（2026-11-04 に移した）。
//
// 目的: 欧文の社名「ComeGin」を、和名（読み）の「カメギン」でも同じ会社・同じサイトだと Google に認識させる。
// - WebSite の name / alternateName は Google の「サイト名」の材料。**トップだけに置く**（Google の site-names の規定）
// - Organization の alternateName は会社の別名。名前・ロゴ・連絡先で会社を特定させる（Google の organization の規定）
// - 構造化データだけでは足りないので、画面に見える文字（トップの title・description、会社概要の会社名、
//   特商法の事業者名、全画面のフッター）にも「ComeGin（カメギン）」を出して食い違わせない
// - 値は about.ts の会社情報（§4.5 の 5-6）と同じにする。片方だけ直さない

/** 正式な表記（ロゴ・og:site_name・title の末尾と同じ） */
export const SITE_NAME = "ComeGin";
/** 和名（読み）。サイト名の別名として最初に挙げる */
export const SITE_NAME_KANA = "カメギン";
/** 本文で読みを添えるときの書き方（初出や会社名の欄で使う） */
export const SITE_NAME_WITH_KANA = `${SITE_NAME}（${SITE_NAME_KANA}）`;

/**
 * 会社の情報（トップの Organization の構造化データの値）。about.ts の会社情報（§4.5 の 5-6）と同じにする。片方だけ直さない。
 * JSON-LD の形（WebSite・Organization・代表の Person の結び付け）は seo モジュール（src/modules/seo/lib/jsonld.ts の homeJsonLd）が組む。
 */
export const ORGANIZATION = {
  email: "kamegin4@comegin.com",
  telephone: "+81-80-5257-9787",
  foundingDate: "2026-09-27",
  address: {
    addressCountry: "JP",
    addressRegion: "大阪府",
    addressLocality: "大阪市城東区",
    streetAddress: "蒲生4-19-3 ロイヤルアシュリー蒲生502",
  },
} as const;
