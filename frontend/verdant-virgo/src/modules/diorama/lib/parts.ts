// 模型の部品と実際の仕組みの対応表（spec §5.1）。部品は実際の仕組みと 1 対 1 で対応させる（アンチゴール 1）。
// 名前・説明の文言は site-content/diorama.ts が持つ（部品は文言を持たない。H-16）。ここに書くのは製品名と構造だけ。
import type { PartDef, PartId } from "./types";

const part = (
  id: PartId,
  kind: PartDef["kind"],
  products: readonly string[],
  touchable: boolean,
  hasShadow = true,
): PartDef => ({
  id,
  kind,
  products,
  touchable,
  node: `part_${id}`,
  anchor: `anchor_${id}`,
  shadow: hasShadow ? `shadow_${id}` : null,
});

export const PARTS: Readonly<Record<PartId, PartDef>> = {
  // 土台は模型全体が載る台（基盤一式）。押せない。接地影は持たない（台そのものが地）
  base: part("base", "system", ["AWS", "オンプレ"], false, false),
  shelf: part("shelf", "system", ["Strapi"], true),
  // 窓口は訪問者が入ってくる受付。データの持ち主は Chatwoot だけ（フォームの送信は窓口を通り抜けて名簿〈Mautic〉へ入る）
  desk: part("desk", "system", ["Chatwoot"], true),
  roster: part("roster", "system", ["Mautic"], true),
  pipe: part("pipe", "system", ["n8n"], true),
  gauge: part("gauge", "system", ["GA4", "PostHog", "Search Console"], true),
  agents: part(
    "agents",
    "system",
    ["監視アプリ", "エージェント（12 本）"],
    true,
  ),
  // 承認台は「人の承認すべて」の象徴（spec §5.1 の ★）
  approval: part(
    "approval",
    "system",
    ["GitHub の PR", "Strapi（公開の判断）", "配信の承認", "n8n（有効化）"],
    true,
  ),
  // 配信の口: ビルドと S3・CloudFront への配信（人の承認の後だけ。DD-05 §3・DD-06 §1.5）
  shipping: part("shipping", "system", ["S3", "CloudFront"], true),
  site: part("site", "system", ["Astro"], true),
  workshop: part("workshop", "work", [], true),
  drafting: part("drafting", "work", [], true),
  bridge: part("bridge", "work", [], true),
  // 値札（「1 人分」の札）。料金のページの静止画の主題。押せない
  priceTag: part("priceTag", "prop", [], false, false),
};
