// 公開サイトから配るファイル（zip・PDF。DD-05 の 1.5.3）。
// - 公開記事の shared.media のファイルが zip か PDF なら、ビルドで Strapi から取得して dist/files/<hash>/<name> に置き、
//   ページはそのパスにリンクする（公開ページから Strapi・S3 へのリクエストを出さない。1.5.4 の検査はそのまま効く）。
// - 大きさの上限は 20 MB。ほかの mime（動画など）は従来どおり StrapiBuildError。
// - <hash> は Strapi の URL のパス（アップロードごとに変わる）から作る。取得しなくても href を決められる。
// - 取得は src/pages/files/[hash]/[name].ts の静的エンドポイントが行う（dev では要求のときに取る）。
import { createHash } from 'node:crypto';
import { StrapiBuildError, strapiDownload } from './strapi';
import type { Article, DistributionFile, StrapiMedia } from './types';

/** 1 ファイルの大きさの上限。backend/control-plane の campaign-asset-upload の MAX_ASSET_BYTES と同じ */
export const MAX_DISTRIBUTION_BYTES = 20 * 1024 * 1024;

export const DISTRIBUTION_MIMES = ['application/zip', 'application/pdf'] as const;

export function isDistributionMime(mime: string | null | undefined): mime is DistributionFile['mime'] {
  return (DISTRIBUTION_MIMES as readonly string[]).includes(mime ?? '');
}

const EXTENSION: Record<DistributionFile['mime'], string> = { 'application/zip': '.zip', 'application/pdf': '.pdf' };

/** URL の部分に使える名前にする（英数字・ピリオド・ハイフン・アンダースコアだけ）。拡張子が mime と合わなければ付ける */
function fileNameOf(media: StrapiMedia, mime: DistributionFile['mime']): string {
  const raw = media.name?.trim() || new URL(media.url, 'https://example.invalid').pathname.split('/').pop() || 'download';
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').replace(/\.{2,}/g, '.') || 'download';
  return safe.toLowerCase().endsWith(EXTENSION[mime]) ? safe : `${safe}${EXTENSION[mime]}`;
}

/**
 * zip・PDF のメディアを配布ファイルにする。大きさの上限（Strapi の size〈KB〉）を超えていれば StrapiBuildError。
 * Strapi の URL は絶対 URL にして sourceUrl に持つ（ビルドの取得にだけ使う）。
 */
export function toDistributionFile(
  media: StrapiMedia,
  mime: DistributionFile['mime'],
  where: string,
  absoluteUrl: (url: string) => string,
): DistributionFile {
  if (typeof media.size === 'number' && media.size * 1024 > MAX_DISTRIBUTION_BYTES) {
    throw new StrapiBuildError(
      `${where} のファイルが上限（${MAX_DISTRIBUTION_BYTES / 1024 / 1024} MB）を超えています（${(media.size / 1024).toFixed(1)} MB）。`,
    );
  }
  const sourceUrl = absoluteUrl(media.url);
  const hash = createHash('sha256').update(new URL(sourceUrl).pathname).digest('hex').slice(0, 16);
  const name = fileNameOf(media, mime);
  return { href: `/files/${hash}/${name}`, hash, name, mime, sizeKb: typeof media.size === 'number' ? media.size : null, sourceUrl };
}

/** 記事に添えられた配布ファイル（href で重複を除く） */
export function collectDistributionFiles(articles: readonly Article[]): DistributionFile[] {
  const byHref = new Map<string, DistributionFile>();
  for (const article of articles) {
    for (const block of article.blocks) {
      if (block.__component === 'shared.media' && block.download) byHref.set(block.download.href, block.download);
    }
  }
  return [...byHref.values()];
}

/** Strapi から配布ファイルを取得する（20 MB を超えたら StrapiBuildError） */
export function downloadDistributionFile(file: DistributionFile): Promise<Uint8Array<ArrayBuffer>> {
  return strapiDownload(file.sourceUrl, MAX_DISTRIBUTION_BYTES, `配布ファイル「${file.name}」`);
}

/** 表示用の大きさ（例: 2.3 MB・480 KB）。size が無ければ null */
export function formatFileSize(sizeKb: number | null): string | null {
  if (sizeKb === null) return null;
  return sizeKb >= 1024 ? `${(sizeKb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(sizeKb))} KB`;
}
