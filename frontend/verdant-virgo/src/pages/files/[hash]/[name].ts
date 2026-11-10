// 記事から配る zip・PDF（DD-05 の 1.5.3）。ビルドで Strapi から取得し、dist/files/<hash>/<name> に置く。
// 公開記事の shared.media の zip・PDF だけが対象。取得に失敗する・20 MB を超えるとビルドが止まる。
import type { APIRoute, GetStaticPaths } from "astro";
import {
  collectDistributionFiles,
  downloadDistributionFile,
  getAllArticles,
  type DistributionFile,
} from "@/modules/blog";

export const getStaticPaths = (async () => {
  const files = collectDistributionFiles(await getAllArticles());
  return files.map((file) => ({ params: { hash: file.hash, name: file.name }, props: { file } }));
}) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ props }) => {
  const file = (props as { file: DistributionFile }).file;
  return new Response(await downloadDistributionFile(file), {
    headers: {
      "Content-Type": file.mime,
    },
  });
};
