// 記事本文（dynamic zone）の下ごしらえ。rich-text（Markdown）を HTML にし、目次（h2）を集める。
// - Markdown の中の生の HTML は文字として出す（エスケープする）。本文は Strapi の Markdown だけで書く。
// - リンクは http・https・mailto だけ、画像は http・https だけを許す（それ以外は文字として出す。保存型 XSS の防止）。
// - h2 には連番の id（section-1…）を振る（和文の見出しから安定した id を作れないため）。目次（8-4）が使う。
// - Markdown の中の画像も getImage() で取り込む（DD-05 の 1.5.2）。寸法が応答に無いので、ここだけ inferSize を使う。
// - 記事中 CTA（8-6）は「最初の h2 の直前」に置くので、そこで本文を 2 つに分ける。
import { getImage } from "astro:assets";
import { Marked, type Tokens } from "marked";
import { newTabNoticeHtml } from "@/modules/a11y";
import { NEW_TAB_NOTICE } from "@/modules/site-content/a11y";
import { mediaAlt, toAbsoluteMediaUrl } from "./media";
import type { Article, StrapiMedia } from "./types";

export interface TocItem {
  id: string;
  text: string;
}

export type PreparedBlock =
  | { kind: "html"; html: string }
  | { kind: "quote"; title: string | null; body: string }
  | { kind: "media"; media: StrapiMedia }
  | { kind: "slider"; media: StrapiMedia[] };

export interface PreparedBody {
  /** 最初の h2 より前（リード文） */
  lead: PreparedBlock[];
  /** 最初の h2 から後。h2 が無ければ空 */
  rest: PreparedBlock[];
  toc: TocItem[];
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * リンク・画像の URL の許可リスト。本文はエージェントも書くので、javascript: などを静的 HTML に焼き込まない
 * （保存型 XSS の防止）。相対 URL は https として解釈されるので通る。
 */
function safeUrl(href: string, protocols: readonly string[]): string | null {
  try {
    return protocols.includes(new URL(href, "https://example.invalid").protocol)
      ? href.trim()
      : null;
  } catch {
    return null;
  }
}
const LINK_PROTOCOLS = ["http:", "https:", "mailto:"] as const;
const IMAGE_PROTOCOLS = ["http:", "https:"] as const;

async function processImages(
  tokens: ReturnType<Marked["lexer"]>,
  marked: Marked,
  slug: string,
) {
  const sources = new Map<string, string>();
  marked.walkTokens(tokens, (token) => {
    if (
      token.type === "image" &&
      safeUrl((token as Tokens.Image).href, IMAGE_PROTOCOLS)
    )
      sources.set((token as Tokens.Image).href, "");
  });
  const rendered = new Map<string, string>();
  for (const href of sources.keys()) {
    const image = await getImage({
      src: toAbsoluteMediaUrl(href),
      inferSize: true,
      format: "webp",
      widths: [360, 720, 1440],
    });
    // loading・decoding は下で付けるので除き、値の無い属性（fetchpriority など）は出さない
    const attrs = Object.entries(image.attributes)
      .filter(
        ([key, value]) =>
          value !== undefined &&
          value !== null &&
          !["loading", "decoding"].includes(key),
      )
      .map(([key, value]) => `${key}="${escapeHtml(String(value))}"`)
      .join(" ");
    rendered.set(
      href,
      `<img src="${escapeHtml(image.src)}" srcset="${escapeHtml(image.srcSet.attribute)}" sizes="(min-width: 768px) 720px, 100vw" ${attrs} loading="lazy" decoding="async"`,
    );
  }
  return (href: string, alt: string) => {
    const image = rendered.get(href);
    // 許可しない URL の画像は描かず、代替テキストだけを文字として出す
    if (!image) return escapeHtml(alt);
    return `${image} alt="${escapeHtml(mediaAlt(alt, `記事「${slug}」の本文`))}">`;
  };
}

/** 本文の見出しの段の記録。rich-text のブロックをまたいで持つ（直前の見出しの段。最初は記事のタイトルの h1） */
interface Outline {
  level: number;
}

/**
 * 見出しの段を、前の見出しから 1 段ずつ下がる形にそろえる（1.3.1。04-accessibility-spec.md）。
 * h1 は記事のタイトルだけなので本文の # は h2 にし、h2 の次に #### が来ても h3 にする。上がる方向（h4 → h2）はそのまま。
 */
function normalizeLevel(depth: number, outline: Outline): number {
  const level = Math.min(Math.max(depth, 2), outline.level + 1);
  outline.level = level;
  return level;
}

/** rich-text を HTML にし、最初の h2 の手前で分ける */
async function renderRichText(
  markdown: string,
  slug: string,
  toc: TocItem[],
  outline: Outline,
): Promise<{ before: string; after: string | null }> {
  const marked = new Marked({ gfm: true });
  const tokens = marked.lexer(markdown);
  const image = await processImages(tokens, marked, slug);
  const SPLIT = "\u0000split\u0000";
  marked.use({
    renderer: {
      html: ({ text }) => escapeHtml(text),
      image: ({ href, text }) => image(href, text),
      link({ href, title, tokens: inline }) {
        const text = this.parser.parseInline(inline);
        const safe = safeUrl(href, LINK_PROTOCOLS);
        if (!safe) return text;
        // 外部のサイトへのリンクは新しいタブで開く（legal の RichText と同じ扱い）。リンクの名前の末尾で告知する（§12 の S-2）
        const external = /^https?:\/\//i.test(safe);
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
        const targetAttr = external ? ' target="_blank" rel="noopener"' : "";
        const notice = external ? newTabNoticeHtml(NEW_TAB_NOTICE) : "";
        return `<a href="${escapeHtml(safe)}"${titleAttr}${targetAttr}>${text}${notice}</a>`;
      },
      heading({ tokens: inline, depth }) {
        const content = this.parser.parseInline(inline);
        // h1 は記事のタイトルだけ（1 画面に 1 つ。§7）。本文の # は h2 として扱い、段は前の見出しから 1 段ずつにそろえる
        const level = normalizeLevel(depth, outline);
        if (level !== 2) return `<h${level}>${content}</h${level}>\n`;
        const id = `section-${toc.length + 1}`;
        toc.push({
          id,
          text: inline
            .map((token) => token.raw)
            .join("")
            .replace(/[*_`]/g, ""),
        });
        return `${toc.length === 1 ? SPLIT : ""}<h2 id="${id}">${content}</h2>\n`;
      },
    },
  });
  const html = marked.parser(tokens);
  const index = html.indexOf(SPLIT);
  if (index < 0) return { before: html, after: null };
  return {
    before: html.slice(0, index),
    after: html.slice(index + SPLIT.length),
  };
}

export async function prepareArticleBody(
  article: Article,
): Promise<PreparedBody> {
  const toc: TocItem[] = [];
  const outline: Outline = { level: 1 };
  const lead: PreparedBlock[] = [];
  const rest: PreparedBlock[] = [];
  for (const block of article.blocks) {
    const target = toc.length > 0 ? rest : lead;
    switch (block.__component) {
      case "shared.rich-text": {
        if (!block.body?.trim()) break;
        const hadHeading = toc.length > 0;
        const { before, after } = await renderRichText(
          block.body,
          article.slug,
          toc,
          outline,
        );
        if (hadHeading || after === null)
          target.push({ kind: "html", html: before });
        else {
          if (before.trim()) lead.push({ kind: "html", html: before });
          rest.push({ kind: "html", html: after });
        }
        break;
      }
      case "shared.quote":
        if (block.body?.trim())
          target.push({
            kind: "quote",
            title: block.title?.trim() || null,
            body: block.body,
          });
        break;
      case "shared.media":
        if (block.file) target.push({ kind: "media", media: block.file });
        break;
      case "shared.slider":
        if (block.files?.length)
          target.push({ kind: "slider", media: block.files });
        break;
    }
  }
  return { lead, rest, toc };
}
