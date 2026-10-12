// faq.json（I-33）。faq-bot（Chatwoot の FAQ ボット）が 10 分ごとに読む。ビルドで dist/faq.json になる。
// sitemap には載らない（.json のエンドポイントは @astrojs/sitemap の対象外）
import type { APIRoute } from "astro";
import { buildFaqExport } from "@/modules/faq-export";

export const GET: APIRoute = ({ site }) => {
  if (!site) throw new Error("site が未設定（astro.config.mjs の site）");
  return new Response(JSON.stringify(buildFaqExport(site)), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
