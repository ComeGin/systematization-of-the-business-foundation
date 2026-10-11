// 和文フォント（Noto Sans JP）を、サイトで使っている字だけのサブセットに差し替える Astro インテグレーション。
// astro.config.mjs に登録する（計画書 P-5 の変更。2026-10-09 にユーザーが決定）。
//
// - ビルドの最後（astro:build:done）に dist/ の HTML と JS を走査して、使われている字を集める。
//   Strapi の記事もビルド時に HTML になっているので含まれる。記事が増えても次のビルドで作り直される
// - 400・500・700 の 3 ウェイトを、それぞれ 1 ファイルの woff2 にする（和文の 600 は 700。H-4）
// - dist/ の CSS（と HTML の <style>）にある @fontsource の Noto Sans JP の @font-face（unicode-range で約 120 個 × 3）を
//   消して 3 つに置き換え、使われなくなった @fontsource の woff2・woff を dist/ から消す
// - dev サーバーでは何もしない（@fontsource のまま。字形は同じ Noto Sans JP なので見た目は変わらない）
// - 元のフォントは @expo-google-fonts/noto-sans-jp の静的な TTF、サブセットは subset-font（harfbuzzjs の WebAssembly）。
//   Node だけで動き、Python などは要らない
// - フォントのライセンス（SIL OFL 1.1）の全文を、フォントと同じ場所に置く
// - defer: true のときは、和文フォントを最初の描画の後に読む（3 つの @font-face を別の CSS にし、小さな外部 JS が load の後に差し込む。
//   それまでは寸法を Noto Sans JP に合わせた端末のフォントで描く）。既定は false
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";
import subsetFont from "subset-font";

const require = createRequire(import.meta.url);

const FAMILY = "Noto Sans JP";
const WEIGHTS = [
  { weight: 400, file: "400Regular/NotoSansJP_400Regular.ttf" },
  { weight: 500, file: "500Medium/NotoSansJP_500Medium.ttf" },
  { weight: 700, file: "700Bold/NotoSansJP_700Bold.ttf" },
] as const;

/**
 * 走査で拾えなくても必ず入れる字。かな全部・全角の英数記号・よく使う約物
 * （JS の中で組み立てる文言や、後から足した短い文言で字が欠けないようにするため）。
 */
const ALWAYS_INCLUDED = (() => {
  const ranges: [number, number][] = [
    [0x20, 0x7e], // ASCII
    [0x3000, 0x303f], // 和文の約物（、。「」〜 など）
    [0x3040, 0x309f], // ひらがな
    [0x30a0, 0x30ff], // カタカナ
    [0xff01, 0xff5e], // 全角の英数記号
  ];
  let text = "©—–…・‐";
  for (const [from, to] of ranges)
    for (let c = from; c <= to; c++) text += String.fromCodePoint(c);
  return text;
})();

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? listFiles(full) : Promise.resolve([full]);
    }),
  );
  return files.flat();
}

/** HTML の実体参照（&amp; &#12354; &#x3042; など）を戻す */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/g, " ")
    .replace(
      /&(amp|lt|gt|quot|apos);/g,
      (m) =>
        ({
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&apos;": "'",
        })[m] ?? m,
    );
}

/** HTML から画面に出る文字（本文と、alt・title・aria-label・placeholder・value の属性）を取り出す */
function textOfHtml(html: string): string {
  const attrs = [
    ...html.matchAll(/\s(?:alt|title|aria-label|placeholder|value)="([^"]*)"/g),
  ]
    .map((m) => m[1])
    .join("");
  const body = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(body + attrs);
}

/** JS（island の文言・エラー文など）の非 ASCII の字。\uXXXX と \u{XXXXX} の書き方も戻す */
function textOfJs(js: string): string {
  const unescaped = js
    .replace(/\\u\{([0-9a-f]+)\}/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  return [...unescaped].filter((ch) => ch.codePointAt(0)! > 0x7f).join("");
}


/** Noto Sans JP そのもの（"Noto Sans JP Fallback" は含まない）の @font-face か */
const NOTO_FACE = /font-family:\s*["']?Noto Sans JP["']?\s*[;}]/;
/** 遅らせて読むときの、端末のフォントの代わりの @font-face の名前 */
const FALLBACK_FAMILY = `${FAMILY} Fallback`;

/** @font-face のうち Noto Sans JP のものを、置き換えの CSS に差し替える（最初の 1 つの位置に入れ、残りは消す） */
function rewriteFontFaces(
  css: string,
  replacement: string,
  removedUrls: Set<string>,
): { css: string; count: number } {
  let count = 0;
  const out = css.replace(/@font-face\s*\{[^}]*\}/g, (rule) => {
    const isFallback = rule.includes(FALLBACK_FAMILY);
    if (!NOTO_FACE.test(rule) && !isFallback) return rule;
    if (!isFallback)
      for (const m of rule.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g))
        removedUrls.add(m[1]);
    count += 1;
    return count === 1 ? replacement : "";
  });
  return { css: out, count };
}

/**
 * 書体の並び（font-family と --font-sans など）の "Noto Sans JP" の直後に "Noto Sans JP Fallback" を足す。
 * @font-face の中は触らない。2 回当てても重ならない
 */
function addFallbackToStacks(css: string): string {
  return css
    .split(/(@font-face\s*\{[^}]*\})/g)
    .map((part) =>
      part.startsWith("@font-face")
        ? part
        : part.replace(/(["'])Noto Sans JP\1(?!\s*,\s*["']Noto Sans JP Fallback)/g, `$1${FAMILY}$1,"${FALLBACK_FAMILY}"`),
    )
    .join("");
}

/**
 * 遅らせて読む間に使う、端末の和文フォントの @font-face。Noto Sans JP の縦の寸法（ascent 1.16em・descent 0.288em・
 * line gap 0）に合わせて、差し替えの前後で文字の上下の位置が動かないようにする。和文の字は全角で幅がどの書体でも 1em
 * なので、折り返しの位置も変わらない（欧文は Poppins が受け持つ）。
 * local() は、端末にある順に Noto Sans JP（入っていれば）→ ヒラギノ（Mac・iOS）→ 游ゴシック・メイリオ（Windows）→ Noto Sans CJK（Android・Linux）。
 */
const FALLBACK_LOCALS: Record<400 | 500 | 700, string[]> = {
  400: ["Noto Sans JP", "NotoSansJP-Regular", "Hiragino Sans W3", "HiraginoSans-W3", "Hiragino Kaku Gothic ProN W3", "Yu Gothic Regular", "YuGothic-Regular", "Meiryo", "Noto Sans CJK JP Regular", "NotoSansCJKjp-Regular"],
  500: ["Noto Sans JP Medium", "NotoSansJP-Medium", "Hiragino Sans W5", "HiraginoSans-W5", "Yu Gothic Medium", "YuGothic-Medium", "Meiryo", "Noto Sans CJK JP Medium", "NotoSansCJKjp-Medium"],
  700: ["Noto Sans JP Bold", "NotoSansJP-Bold", "Hiragino Sans W6", "HiraginoSans-W6", "Hiragino Kaku Gothic ProN W6", "Yu Gothic Bold", "YuGothic-Bold", "Meiryo Bold", "Noto Sans CJK JP Bold", "NotoSansCJKjp-Bold"],
};
const FALLBACK_FACES = WEIGHTS.map(
  ({ weight }) =>
    `@font-face{font-family:"${FALLBACK_FAMILY}";font-style:normal;font-weight:${weight};` +
    `src:${FALLBACK_LOCALS[weight].map((name) => `local("${name}")`).join(",")};` +
    `size-adjust:100%;ascent-override:116%;descent-override:28.8%;line-gap-override:0%}`,
).join("");

/**
 * 遅らせて読むときに、フォントの CSS を差し込む小さな JS（CSP でインラインの onload を使わないため外部ファイルにする）。
 * 初めての訪問はページの load の後に差し込む（最初の描画とフォントの取得を取り合わない）。
 * 同じタブで一度読み込んだら（sessionStorage）、2 ページ目からは HTML を読み終えた時点で差し込む（キャッシュから来るので速い）。
 */
function loaderScript(cssHref: string): string {
  return `(()=>{const k="comegin-font-loaded",h=${JSON.stringify(cssHref)};let s=!1;try{s=sessionStorage.getItem(k)==="1"}catch{}const a=()=>{if(document.querySelector('link[data-comegin-font]'))return;const l=document.createElement("link");l.rel="stylesheet";l.href=h;l.dataset.comeginFont="";l.addEventListener("load",()=>{try{sessionStorage.setItem(k,"1")}catch{}});document.head.append(l)};if(s||document.readyState==="complete")a();else addEventListener("load",a,{once:!0})})();\n`;
}

const shortHash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex").slice(0, 8);

export interface FontSubsetOptions {
  /**
   * <link rel="preload"> で先に読み込むウェイト（例 [400]）。既定は無し。
   * 1 ファイルが約 180KB あり、CSS・画像と帯域を取り合うので、Lighthouse で比べてから決める
   */
  preload?: readonly (400 | 500 | 700)[];
  /**
   * 和文フォントを最初の描画の後に読む（既定は false）。true なら 3 つの @font-face を別の CSS に出し、
   * 小さな外部 JS がページの load の後にその CSS を差し込む。それまでは端末の和文フォント（寸法を合わせた fallback）で描く。
   * JS が動かない環境のために <noscript> でも同じ CSS を読む
   */
  defer?: boolean;
}

export interface FontSubsetResult {
  chars: number;
  files: string[];
  totalBytes: number;
  replacedFaces: number;
  removedFiles: number;
}

/** dist/ の中で、和文フォントのサブセットを作って差し替える（integration の本体。ビルドの外でも dist の写しに当てられる） */
export async function subsetNotoSansJp(
  distDir: string,
  { base = "/", assetsDir = "_astro", preload = [], defer = false }: FontSubsetOptions & { base?: string; assetsDir?: string } = {},
): Promise<FontSubsetResult> {
  const preloadWeights = new Set(preload);
  const files = await listFiles(distDir);
  const htmlFiles = files.filter((f) => f.endsWith(".html"));
  const jsFiles = files.filter((f) => /\.(m?js)$/.test(f));
  const cssFiles = files.filter((f) => f.endsWith(".css"));
  const assetUrl = (name: string) => `${base}${assetsDir}/${name}`;

  // 1. 使われている字を集める
  const chars = new Set<string>(ALWAYS_INCLUDED);
  for (const f of htmlFiles) for (const ch of textOfHtml(await readFile(f, "utf8"))) chars.add(ch);
  for (const f of jsFiles) for (const ch of textOfJs(await readFile(f, "utf8"))) chars.add(ch);
  const text = [...chars].filter((ch) => ch.codePointAt(0)! >= 0x20).join("");

  // 2. ウェイトごとにサブセットを作る
  const pkgDir = path.dirname(require.resolve("@expo-google-fonts/noto-sans-jp/package.json"));
  const outDir = path.join(distDir, assetsDir);
  await mkdir(outDir, { recursive: true });
  const faces: string[] = [];
  const preloadLinks: string[] = [];
  const written = new Set<string>();
  let totalBytes = 0;
  for (const { weight, file } of WEIGHTS) {
    const source = await readFile(path.join(pkgDir, file));
    const subset = await subsetFont(source, text, { targetFormat: "woff2" });
    const name = `noto-sans-jp-${weight}.${shortHash(subset)}.woff2`;
    await writeFile(path.join(outDir, name), subset);
    written.add(name);
    totalBytes += subset.length;
    if (preloadWeights.has(weight)) {
      preloadLinks.push(`<link rel="preload" href="${assetUrl(name)}" as="font" type="font/woff2" crossorigin>`);
    }
    faces.push(
      `@font-face{font-family:"${FAMILY}";font-style:normal;font-display:swap;font-weight:${weight};src:url(${assetUrl(name)}) format("woff2")}`,
    );
  }

  // defer のときは、3 つの @font-face を別の CSS と、それを差し込む JS に出す。本体の CSS には fallback だけを置く
  let headTags = preloadLinks.join("");
  let replacement = faces.join("");
  if (defer) {
    const fontCss = faces.join("") + "\n";
    const cssName = `noto-sans-jp.${shortHash(fontCss)}.css`;
    await writeFile(path.join(outDir, cssName), fontCss);
    const js = loaderScript(assetUrl(cssName));
    const jsName = `noto-sans-jp-loader.${shortHash(js)}.js`;
    await writeFile(path.join(outDir, jsName), js);
    written.add(cssName).add(jsName);
    headTags += `<script src="${assetUrl(jsName)}" defer></script><noscript><link rel="stylesheet" href="${assetUrl(cssName)}"></noscript>`;
    replacement = FALLBACK_FACES;
  }

  // 3. CSS と HTML の <style> の @font-face を差し替える
  const removedUrls = new Set<string>();
  let replaced = 0;
  const rewrite = (css: string) => {
    const r = rewriteFontFaces(css, replacement, removedUrls);
    replaced += r.count;
    return { css: defer && r.count > 0 ? addFallbackToStacks(r.css) : r.css, changed: r.count > 0 };
  };
  for (const f of cssFiles) {
    if (written.has(path.basename(f))) continue;
    let { css, changed } = rewrite(await readFile(f, "utf8"));
    if (!changed && defer && css.includes(`"${FAMILY}"`)) {
      // @font-face の無い CSS でも、書体の並びに fallback を足す
      const added = addFallbackToStacks(css);
      changed = added !== css;
      css = added;
    }
    if (changed) await writeFile(f, css);
  }
  for (const f of htmlFiles) {
    const html = await readFile(f, "utf8");
    let changed = false;
    let out = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (whole, open: string, css: string, close: string) => {
      const r = rewrite(css);
      if (!r.changed) return whole;
      changed = true;
      return open + r.css + close;
    });
    // 先に読むフォントと、遅らせて読む JS は <title> の直前（CSS より前）に置く
    if (headTags && out.includes("<title>")) {
      out = out.replace("<title>", headTags + "<title>");
      changed = true;
    }
    if (changed) await writeFile(f, out);
  }
  if (replaced === 0) {
    // 差し替える相手が無い＝@fontsource の読み込み方が変わった。黙って全部の分割フォントを配らないよう止める
    throw new Error(`[comegin-font-subset] dist/ に ${FAMILY} の @font-face が見つかりませんでした（fonts.css の読み込みを確かめてください）。`);
  }

  // 4. 使われなくなった Noto Sans JP のフォントのファイルを消す（いま書いたものは残す）
  let removedFiles = 0;
  for (const url of removedUrls) {
    const file = path.join(distDir, decodeURIComponent(url.replace(/^\//, "").replace(base.replace(/^\//, ""), "")));
    const name = path.basename(file);
    if (/noto-sans-jp/i.test(name) && !written.has(name)) {
      await unlink(file).then(
        () => (removedFiles += 1),
        () => undefined,
      );
    }
  }

  // 5. ライセンス（SIL OFL 1.1）をフォントと同じ場所に置く
  const license = await readFile(path.join(path.dirname(require.resolve("@fontsource/noto-sans-jp/package.json")), "LICENSE"), "utf8");
  await writeFile(path.join(outDir, "NotoSansJP-OFL.txt"), license);

  return { chars: chars.size, files: [...written], totalBytes, replacedFaces: replaced, removedFiles };
}

export function comeginFontSubset(options: FontSubsetOptions = {}): AstroIntegration {
  let base = "/";
  let assetsDir = "_astro";

  return {
    name: "comegin-font-subset",
    hooks: {
      "astro:config:done": ({ config }) => {
        base = config.base.endsWith("/") ? config.base : `${config.base}/`;
        assetsDir = config.build.assets;
      },
      "astro:build:done": async ({ dir, logger }) => {
        const r = await subsetNotoSansJp(fileURLToPath(dir), { ...options, base, assetsDir });
        logger.info(
          `${FAMILY}: ${r.chars} 字 × ${WEIGHTS.length} ウェイト → ${WEIGHTS.length} ファイル（計 ${(r.totalBytes / 1024).toFixed(0)}KB）。` +
            `@font-face ${r.replacedFaces} 個を置き換え、分割フォント ${r.removedFiles} ファイルを削除` +
            (options.defer ? "。和文フォントは最初の描画の後に読む（defer）" : ""),
        );
      },
    },
  };
}
