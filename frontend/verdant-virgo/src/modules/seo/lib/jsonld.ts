// 構造化データ（JSON-LD）の組み立て（2026-11-04 に新設）。値（会社名・代表の名前）は site-content から読み、ここは形だけを持つ。
//
// 目的（Google 検索の E-E-A-T の材料を、画面に見える内容と同じ値で機械にも渡す）:
// - 記事（/blog/<slug>/）に BlogPosting を置き、書いた人（代表）・公開日・更新日・発行元（ComeGin）を明示する
// - 書いた人は Person として 1 つの @id（/about/#representative）にまとめ、トップの Organization の founder、会社概要の AboutPage、
//   記事の author がすべて同じ人を指すようにする（別々の Person を作らない）
// - 画面に無いことは書かない（構造化データだけに書いた内容は、Google のガイドラインの「ページに表示されていない内容」になる）
//
// 出典: https://developers.google.com/search/docs/appearance/structured-data/article
//      https://developers.google.com/search/docs/appearance/structured-data/organization
//      https://developers.google.com/search/docs/appearance/structured-data/sd-policies

import { author } from "@/modules/site-content/about";
import {
  ORGANIZATION,
  SITE_NAME,
  SITE_NAME_KANA,
} from "@/modules/site-content/organization";

/** 代表（記事の著者）の名前。記事の著者カード（about.ts の author）と同じ値を使う */
export const REPRESENTATIVE_NAME: string = author.name;
/** 代表の役職（会社概要の会社情報の「代表」と同じ） */
export const REPRESENTATIVE_JOB_TITLE = "代表";

/** サイトの中で共有する @id。URL の断片で区別する（Google は @id をノードの結び付けに使う） */
export function schemaIds(site: URL | string) {
  const home = new URL("/", site).href;
  const about = new URL("/about/", site).href;
  return {
    home,
    about,
    website: `${home}#website`,
    organization: `${home}#organization`,
    representative: `${about}#representative`,
  } as const;
}

/** 代表の Person ノード。会社概要（/about/）を本人の紹介ページとして url に持つ */
export function representativePerson(site: URL | string) {
  const ids = schemaIds(site);
  return {
    "@type": "Person",
    "@id": ids.representative,
    name: REPRESENTATIVE_NAME,
    jobTitle: REPRESENTATIVE_JOB_TITLE,
    url: ids.about,
    worksFor: { "@id": ids.organization },
  } as const;
}

/**
 * トップ（/）にだけ置く JSON-LD（@graph に WebSite・Organization・代表の Person）。01-content-spec.md §7.2（2026-11-03 に新設）。
 * - WebSite の name / alternateName は Google の「サイト名」の材料。**トップだけに置く**（Google の site-names の規定）
 * - Organization の alternateName は会社の別名（和名「カメギン」）。名前・ロゴ・連絡先で会社を特定させる
 * - founder は代表の Person（@id で記事の author・会社概要と同じ人に結ぶ）
 * site は astro.config.mjs の site（SITE_URL）。本番では https://comegin.com/ になる。
 */
export function homeJsonLd(site: URL | string) {
  const ids = schemaIds(site);
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": ids.website,
        name: SITE_NAME,
        alternateName: [SITE_NAME_KANA],
        url: ids.home,
        inLanguage: "ja",
        publisher: { "@id": ids.organization },
      },
      {
        "@type": "Organization",
        "@id": ids.organization,
        name: SITE_NAME,
        alternateName: SITE_NAME_KANA,
        url: ids.home,
        // 512px のフルカラーの印（§7.1 のファビコン）。Google のロゴの条件（112px 以上・クロールできる画像）を満たす
        logo: new URL("/favicon-512.png", site).href,
        email: ORGANIZATION.email,
        telephone: ORGANIZATION.telephone,
        foundingDate: ORGANIZATION.foundingDate,
        founder: { "@id": ids.representative },
        address: { "@type": "PostalAddress", ...ORGANIZATION.address },
      },
      representativePerson(site),
    ],
  };
}

export interface BlogPostingInput {
  /** 記事の canonical（末尾スラッシュ付きの絶対 URL） */
  url: string;
  headline: string;
  description: string;
  /** ISO 8601（Strapi の publishedAt・updatedAt。タイムゾーン付き） */
  datePublished: string;
  dateModified: string;
  /** アイキャッチの絶対 URL（ビルドで dist/_astro/ に取り込んだもの）。無ければ省く */
  image?: string;
  /** カテゴリ名（画面のバッジと同じ） */
  section?: string;
}

/** 記事のページに置く JSON-LD（@graph に BlogPosting と、その著者の Person） */
export function blogPostingJsonLd(site: URL | string, input: BlogPostingInput) {
  const ids = schemaIds(site);
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BlogPosting",
        "@id": `${input.url}#article`,
        mainEntityOfPage: input.url,
        headline: input.headline,
        description: input.description,
        datePublished: input.datePublished,
        dateModified: input.dateModified,
        inLanguage: "ja",
        ...(input.image ? { image: [input.image] } : {}),
        ...(input.section ? { articleSection: input.section } : {}),
        // Google の Article の推奨: author は Person と name・url。url は本人の紹介ページ（会社概要）
        author: {
          "@id": ids.representative,
          "@type": "Person",
          name: REPRESENTATIVE_NAME,
          url: ids.about,
        },
        publisher: {
          "@id": ids.organization,
          "@type": "Organization",
          name: SITE_NAME,
        },
        isPartOf: { "@id": ids.website },
      },
      representativePerson(site),
    ],
  };
}

/** 会社概要（/about/）に置く JSON-LD（AboutPage。主題は会社、代表を Person として結ぶ） */
export function aboutPageJsonLd(site: URL | string) {
  const ids = schemaIds(site);
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "AboutPage",
        "@id": `${ids.about}#webpage`,
        url: ids.about,
        inLanguage: "ja",
        isPartOf: { "@id": ids.website },
        mainEntity: { "@id": ids.organization },
        about: { "@id": ids.organization },
      },
      representativePerson(site),
    ],
  };
}

/**
 * <script type="application/ld+json"> に入れる文字列。`<` を < にして、値（記事の題名など）に `</script>` が
 * 含まれても script 要素が途中で閉じないようにする（JSON としては同じ値）。
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
