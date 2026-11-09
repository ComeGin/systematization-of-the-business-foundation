// 改善ループの項目が指す、公開サイトの URL（記事は /blog/<slug>/。published-article-check の changes と同じ形）。
import type { CycleItem } from "../contract.js";

export function siteBase(siteUrl: string): string {
  return siteUrl.replace(/\/+$/, "");
}

/** 記事の公開後の URL（末尾の / 付き。URL はスラッシュ付きが正） */
export function articlePublicUrl(siteUrl: string, slug: string): string {
  return `${siteBase(siteUrl)}/blog/${slug}/`;
}

/** URL からクエリと断片を除く（メールのリンクの UTM を外して、配信の changes と比べる） */
export function withoutQuery(url: string): string {
  return url.replace(/[?#].*$/, "");
}

/** 項目が公開サイトに出す記事の URL。article は slug から、campaign はメールのリンク先（UTM を除く）。それ以外・中身が無いときは null */
export function itemArticleUrl(item: CycleItem, siteUrl: string | null): string | null {
  const preview = item.preview;
  if (preview.kind === "article") return siteUrl && preview.slug ? articlePublicUrl(siteUrl, preview.slug) : null;
  if (preview.kind === "campaign") return preview.linkUrl ? withoutQuery(preview.linkUrl) : null;
  return null;
}

/**
 * 記事の公開・配信を数える基準の時刻（Ruling 35）。article は項目を作ったときの下書きの updatedAt（preview の draftUpdatedAt）、
 * それが無い（この欄を足す前に作った項目・article 以外）ときは項目の createdAt。
 * 公開版の publishedAt と、反映に数える deploy の createdAt がこれ以後なら、確認した下書きの公開・配信とみなす。
 */
export function articleBaseTime(item: CycleItem): string {
  return item.preview.kind === "article" && item.preview.draftUpdatedAt ? item.preview.draftUpdatedAt : item.createdAt;
}

/**
 * 基準の時刻との比較に入れる許容幅（ミリ秒。P6）。Strapi 5 の公開は下書きの updatedAt も進めうるため、
 * publishedAt と下書きの updatedAt のミリ秒の差で、公開済みの確認・反映の数えが外れないようにする。
 * 比較は「基準 − この幅」以上
 */
export const BASE_TIME_TOLERANCE_MS = 5_000;

/** 時刻 at が基準 base の許容幅つきで基準以後か（at・base は ISO 8601。読めない値は false） */
export function isAtOrAfterBase(at: string, base: string): boolean {
  const t = Date.parse(at);
  const b = Date.parse(base);
  return Number.isFinite(t) && Number.isFinite(b) && t >= b - BASE_TIME_TOLERANCE_MS;
}

/** 確かめ済み（confirmed）の deploy の項目に含まれる記事の URL すべて（campaign の手順 ③ を出す条件） */
export function deployConfirmedUrls(items: readonly CycleItem[]): Set<string> {
  const urls = new Set<string>();
  for (const item of items) {
    if (item.kind !== "deploy" || item.state !== "confirmed" || item.preview.kind !== "deploy") continue;
    for (const url of item.preview.changes) urls.add(url);
  }
  return urls;
}
