// 記事の OGP 画像（2026-11-04 に新設）。アイキャッチ（Strapi のメディア）を、ビルド時に 1200×630 の JPEG へ切り出して dist/_astro/ に置く。
// - それまで記事も全画面共通の /og.png だった。SNS・チャットに貼られたときに記事ごとの絵が出るようにする
// - 取り込みは StrapiImage と同じく astro:assets（getImage）。dist/ に Strapi・S3 の URL を残さない（ADR-11・comeginStrapiGuard）
// - JPEG にするのは、OGP を読む側（SNS・チャットのクローラー）で WebP を読めないものがあるため
// - アイキャッチが無い記事は undefined（BaseLayout の既定の /og.png を使う）
import { getImage } from "astro:assets";
import { toAbsoluteMediaUrl, type StrapiMedia } from "@/modules/blog";

export const OG_IMAGE_SIZE = { width: 1200, height: 630 } as const;

/** アイキャッチから OGP 画像を作り、サイトの中のパス（/_astro/….jpg）を返す */
export async function articleOgImage(
  cover: StrapiMedia | null,
): Promise<string | undefined> {
  if (!cover) return undefined;
  const image = await getImage({
    src: toAbsoluteMediaUrl(cover.url),
    // 出力の幅と高さを両方渡すので、元の寸法（inferSize）は要らない
    width: OG_IMAGE_SIZE.width,
    height: OG_IMAGE_SIZE.height,
    fit: "cover",
    format: "jpeg",
    quality: 80,
  });
  return image.src;
}
