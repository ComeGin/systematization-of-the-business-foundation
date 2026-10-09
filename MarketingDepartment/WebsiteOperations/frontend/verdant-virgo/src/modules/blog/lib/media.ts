// Strapi のメディアの URL（DD-05 の 1.5.1）。
// 開発の Strapi は相対パス（/uploads/...）、本番は S3 の絶対 URL を返す。どちらも絶対 URL にしてから
// <Image>／getImage() に渡し、ビルド時に dist/_astro/ へ取り込む（ADR-11）。
import { strapiOrigin } from './strapi';

export function toAbsoluteMediaUrl(url: string): string {
  if (/^https?:\/\//.test(url)) return url;
  return new URL(url, strapiOrigin()).toString();
}

/** alt。空なら装飾扱いで alt="" にし、件数をビルドログに出す（DD-05 の 1.5.2） */
let emptyAltCount = 0;
export function mediaAlt(alternativeText: string | null | undefined, context: string): string {
  const alt = alternativeText?.trim() ?? '';
  if (!alt) {
    emptyAltCount += 1;
    console.warn(`[blog] alt が空の画像（${context}）。装飾として alt="" で出します（累計 ${emptyAltCount} 件）。`);
  }
  return alt;
}
