// キャンペーンの配布物（builtin `campaign-asset-upload`。spec 5.8・5.8.1）。
//
// 作業ツリーの `campaign-assets/<proposal_id>/` に `campaign-planner` が書いた原稿（`manifest.yaml` ＋ `plugin/`・`summary.md`）を、
// 配布物（Plugin の zip・1 次資料のまとめの PDF）にまとめて本番の Strapi のメディアライブラリへ上げ、キャンペーンの記事の下書きに結ぶ。
//   - 対象は `manifest.yaml` があり、kv の `campaign-asset-upload:done:<proposal_id>` が無い proposal。全ファイルを上げて結べたら done を残す。
//   - zip にする前に、`plugin/plugin.json` を Agent Plugins 1.0.0 のスキーマ（承認済み main の写し。ADR-18。ネットワークから取らない）で検証する。
//     違反があれば、その proposal は 1 つもアップロードしない（失敗として項目の理由に出す）。
//   - PDF は playwright-core の Chromium（実ホームの ~/.cache/ms-playwright）で、summary.md を最小の HTML にして印刷する。
//     Chromium が無ければ PDF だけ見送る（zip は続ける。その proposal は done にせず、次回に PDF だけ再試行する）。
//   - 1 ファイル 20 MB を超えたらアップロードしない。
//   - アップロード済みのファイルは kv（`file:`・`attached:`）に覚え、やり直しても二重にアップロード・添付しない。
//   - 原稿は作業ツリーにあり、エージェントが書ける場所なので、manifest.yaml は zod で厳密に検証し、シンボリックリンクはたどらない。
//   - Strapi のトークン・ファイルのバイト列はログにも結果にも出さない。
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import * as z from "zod/v4";
import type { BuiltinHandler, RunResult } from "../context.js";
import type { FailureClass } from "../contract.js";
import { AGENT_PLUGINS_SCHEMA_FILE, CAMPAIGN_ASSETS_DIR, PLAYWRIGHT_BROWSERS_SUBDIR } from "../constants/paths.js";
import { IntegrationError } from "../integrations/http.js";
import { StrapiClient } from "../integrations/strapi.js";
import { logLine } from "../log.js";

/** 1 ファイルの大きさの上限（公開サイトのビルドが取り込む上限と同じ。frontend/verdant-virgo の blog/lib/articles.ts） */
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;
/** plugin/ の下のファイル数の上限（想定外に大きい・深いものを拒む） */
const MAX_PLUGIN_FILES = 2000;
const MAX_PLUGIN_DEPTH = 8;

export const DONE_KEY_PREFIX = "campaign-asset-upload:done:";
/** アップロード済みのファイルの印（値は Strapi のファイルの id）。`<pid>:<name>` */
export const FILE_KEY_PREFIX = "campaign-asset-upload:file:";
/** 記事に結べた印。`<pid>:<name>` */
export const ATTACHED_KEY_PREFIX = "campaign-asset-upload:attached:";

const PROPOSAL_DIR = /^PRP-\d{4}-\d{4}$/;
const MANIFEST_FILE = "manifest.yaml";
const PLUGIN_SOURCE = "plugin";
const SUMMARY_SOURCE = "summary.md";
/** zip の中のファイルの更新日時（再現できる zip にするため固定） */
const ZIP_MTIME = new Date("2026-01-01T00:00:00Z");

const PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const CHROMIUM_DIR = /^chromium(?:_headless_shell)?-\d+$/;

/** 原稿の誤り（manifest・plugin・大きさ）。失敗の分類は invalid_response */
export class AssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetError";
  }
}

// ---------- manifest ----------

const FileName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "name は英数字・ピリオド・ハイフン・アンダースコアの 1〜64 文字にしてください")
  .refine((value) => !value.includes(".."), "name に .. を含めないでください");

const ManifestFileSchema = z
  .strictObject({
    name: FileName,
    description: z.string().min(1).max(500),
    format: z.enum(["zip", "pdf"]),
    source: z.string().min(1).max(100),
  })
  .superRefine((file, ctx) => {
    // source は決まった 2 つだけ。パスの組み立てに manifest の値を使わないので、.. や絶対パスはここで落ちる
    const expected = file.format === "zip" ? [PLUGIN_SOURCE, `${PLUGIN_SOURCE}/`] : [SUMMARY_SOURCE];
    if (!expected.includes(file.source)) {
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: file.format === "zip" ? "zip の source は plugin/ だけ" : "pdf の source は summary.md だけ",
      });
    }
  });

const ManifestSchema = z
  .strictObject({
    proposal_id: z.string().regex(/^PRP-\d{4}-\d{4}$/),
    article_document_id: z.string().regex(/^[A-Za-z0-9]{1,64}$/, "article_document_id は英数字だけ"),
    files: z.array(ManifestFileSchema).min(1).max(10),
  })
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    manifest.files.forEach((file, index) => {
      const key = `${file.name}.${file.format}`;
      if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["files", index, "name"], message: `${key} が重複している` });
      seen.add(key);
    });
  });
export type Manifest = z.infer<typeof ManifestSchema>;

function zodMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join(" / ");
}

/** 通常のファイルか（シンボリックリンクはたどらない）。無ければ null、通常のファイルでなければ "other" */
async function fileKind(path: string): Promise<"file" | "dir" | "symlink" | "other" | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "dir";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** `<dir>/manifest.yaml` を読んで検証する。`dir` は `campaign-assets/<proposal_id>/`。違反は AssetError */
export async function readManifest(dir: string): Promise<Manifest> {
  const path = join(dir, MANIFEST_FILE);
  const kind = await fileKind(path);
  if (kind !== "file") throw new AssetError(`${MANIFEST_FILE} が通常のファイルとして無い`);
  const raw = await readFile(path, "utf8");
  if (raw.length > 64 * 1024) throw new AssetError(`${MANIFEST_FILE} が大きすぎる`);
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch {
    throw new AssetError(`${MANIFEST_FILE} を YAML として読めない`);
  }
  const parsed = ManifestSchema.safeParse(data);
  if (!parsed.success) throw new AssetError(`${MANIFEST_FILE} の形が違う（${zodMessage(parsed.error)}）`);
  return parsed.data;
}

// ---------- plugin の検証 ----------

interface TreeEntry {
  /** dir からの相対パス（/ 区切り） */
  rel: string;
  abs: string;
}

/** 公開してはいけない名前（ファイルでもディレクトリでも）。環境変数のファイル（.example・.sample・.template は除く）・.git・node_modules・secrets・samconfig.toml */
const ENV_TEMPLATE_SUFFIXES = new Set(["example", "sample", "template"]);
const FORBIDDEN_NAMES = new Set([".git", "node_modules", "secrets", "samconfig.toml"]);

export function isForbiddenPublishName(name: string): boolean {
  const lower = name.toLowerCase();
  if (FORBIDDEN_NAMES.has(lower)) return true;
  if (lower === ".env") return true;
  if (lower.startsWith(".env.")) return !ENV_TEMPLATE_SUFFIXES.has(lower.slice(".env.".length));
  return false;
}

/**
 * dir の下のファイルを列挙する。シンボリックリンク・通常のファイルとディレクトリ以外は problems に入れ、たどらない。
 * 公開してはいけない名前（isForbiddenPublishName）も problems に入れ、そのディレクトリの中には入らない。
 */
async function walkTree(dir: string, problems: string[]): Promise<TreeEntry[]> {
  const files: TreeEntry[] = [];
  const visit = async (abs: string, rel: string, depth: number): Promise<void> => {
    if (depth > MAX_PLUGIN_DEPTH) {
      problems.push(`${rel}: ディレクトリが深すぎる（${MAX_PLUGIN_DEPTH} 階層まで）`);
      return;
    }
    const entries = await readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const childAbs = join(abs, entry.name);
      if (isForbiddenPublishName(entry.name)) problems.push(`公開してはいけないファイル: ${childRel}`);
      else if (entry.isSymbolicLink()) problems.push(`${childRel}: シンボリックリンクは入れられない`);
      else if (entry.isDirectory()) await visit(childAbs, childRel, depth + 1);
      else if (entry.isFile()) {
        files.push({ rel: childRel, abs: childAbs });
        if (files.length > MAX_PLUGIN_FILES) throw new AssetError(`ファイルが ${MAX_PLUGIN_FILES} 個を超えている`);
      } else problems.push(`${childRel}: 通常のファイルでもディレクトリでもない`);
    }
  };
  await visit(dir, "", 0);
  return files;
}

function frontmatterOf(text: string): Record<string, unknown> | null {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  try {
    const data = parseYaml(match[1] ?? "");
    return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/**
 * Plugin のディレクトリ（`plugin/`）の違反の一覧。空なら通過。
 *   - `plugin.json` が Agent Plugins 1.0.0 のスキーマ（`schema`。2020-12）に合う
 *   - `name` が 1〜64 文字・小文字の英数字・ハイフン・ピリオド・両端は英数字・`--` と `..` を含まない
 *   - `skills/*` の `SKILL.md` の frontmatter に `name`・`description` がある
 *   - `LICENSE` がある
 *   - シンボリックリンク・特殊ファイルが無い
 */
export async function validatePlugin(dir: string, schema: object): Promise<string[]> {
  const problems: string[] = [];
  const rootKind = await fileKind(dir);
  if (rootKind !== "dir") return [`plugin/ がディレクトリとして無い（${rootKind ?? "無い"}）`];

  // 木全体: シンボリックリンクを入れさせない
  await walkTree(dir, problems);

  // plugin.json
  const manifestPath = join(dir, "plugin.json");
  const manifestKind = await fileKind(manifestPath);
  if (manifestKind !== "file") {
    problems.push("plugin.json が通常のファイルとして無い");
  } else {
    let data: unknown = null;
    try {
      data = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      problems.push("plugin.json を JSON として読めない");
    }
    if (data !== null) {
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      const validate = ajv.compile(schema);
      const valid = validate(data);
      const nameValue = typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>).name : undefined;
      if (!valid) {
        for (const error of validate.errors ?? []) {
          // name はあとで個別に書く（同じ指摘を 2 回出さない）
          if (error.instancePath === "/name") continue;
          const where = error.instancePath === "" ? "plugin.json" : `plugin.json の ${error.instancePath}`;
          const extra =
            error.keyword === "additionalProperties" && typeof error.params?.additionalProperty === "string"
              ? `（${error.params.additionalProperty}）`
              : error.keyword === "required" && typeof error.params?.missingProperty === "string"
                ? `（${error.params.missingProperty}）`
                : "";
          problems.push(`${where}: ${error.message ?? "スキーマに合わない"}${extra}`);
        }
      }
      if (typeof nameValue !== "string") problems.push("plugin.json の name が文字列でない");
      else {
        if (nameValue.length < 1 || nameValue.length > 64) problems.push("plugin.json の name は 1〜64 文字にしてください");
        if (!PLUGIN_NAME.test(nameValue)) {
          problems.push(
            "plugin.json の name は小文字の英数字・ハイフン・ピリオドだけで、両端は英数字、-- と .. を含めないでください",
          );
        }
      }
    }
  }

  // LICENSE
  if ((await fileKind(join(dir, "LICENSE"))) !== "file") problems.push("LICENSE が通常のファイルとして無い");

  // skills/*/SKILL.md
  const skillsKind = await fileKind(join(dir, "skills"));
  if (skillsKind === "dir") {
    const skills = (await readdir(join(dir, "skills"), { withFileTypes: true })).filter((entry) => entry.isDirectory());
    for (const skill of skills) {
      const rel = `skills/${skill.name}/SKILL.md`;
      const path = join(dir, "skills", skill.name, "SKILL.md");
      if ((await fileKind(path)) !== "file") {
        problems.push(`${rel} が通常のファイルとして無い`);
        continue;
      }
      const meta = frontmatterOf(await readFile(path, "utf8"));
      if (!meta) {
        problems.push(`${rel} に YAML の frontmatter が無い`);
        continue;
      }
      if (!nonEmptyString(meta.name)) problems.push(`${rel} の frontmatter に name が無い`);
      if (!nonEmptyString(meta.description)) problems.push(`${rel} の frontmatter に description が無い`);
    }
  } else if (skillsKind !== null) {
    problems.push("skills がディレクトリでない");
  }

  return problems;
}

// ---------- markdown → 最小の HTML ----------

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** 行の中の記法（`code`・**太字**・[リンク](http(s)://…)）。先にすべてエスケープし、許す記法だけをタグにする */
function inline(text: string): string {
  return text
    .split("`")
    .map((part, index) => {
      const escaped = escapeHtml(part);
      if (index % 2 === 1) return `<code>${escaped}</code>`;
      return escaped
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
    })
    .join("");
}

/** 見出し・段落・箇条書き・番号付きの箇条書き・コードブロック・引用・表だけを扱う、最小の Markdown の変換。外部の資源を読み込まない。 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  let quote: string[] = [];
  let table: string[][] = [];
  const flush = () => {
    if (paragraph.length > 0) out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    if (list) out.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.tag}>`);
    if (quote.length > 0) out.push(`<blockquote><p>${inline(quote.join(" "))}</p></blockquote>`);
    if (table.length > 0) {
      const [head, ...rows] = table;
      const cells = (row: string[], tag: string) => row.map((cell) => `<${tag}>${inline(cell)}</${tag}>`).join("");
      out.push(
        `<table><thead><tr>${cells(head ?? [], "th")}</tr></thead><tbody>${rows.map((row) => `<tr>${cells(row, "td")}</tr>`).join("")}</tbody></table>`,
      );
    }
    paragraph = [];
    list = null;
    quote = [];
    table = [];
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (index++; index < lines.length && !/^\s*```/.test(lines[index] ?? ""); index++) code.push(lines[index] ?? "");
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      const tag = bullet ? "ul" : "ol";
      if (!list || list.tag !== tag) {
        flush();
        list = { tag, items: [] };
      }
      list.items.push((bullet ?? ordered)![1] ?? "");
      continue;
    }
    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (quoted) {
      if (paragraph.length > 0 || list || table.length > 0) flush();
      quote.push(quoted[1] ?? "");
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (paragraph.length > 0 || list || quote.length > 0) flush();
      // 区切りの行（|---|---|）は捨てる
      if (!/^\s*\|[\s:|-]+\|\s*$/.test(line)) {
        table.push(line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
      }
      continue;
    }
    if (list || quote.length > 0 || table.length > 0) flush();
    paragraph.push(line.trim());
  }
  flush();
  return out.join("\n");
}

const PDF_STYLE = `
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: "Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif; font-size: 10.5pt; line-height: 1.7; color: #1a1a1a; }
  h1 { font-size: 20pt; margin: 0 0 12pt; } h2 { font-size: 14pt; margin: 18pt 0 6pt; border-bottom: 1px solid #bbb; padding-bottom: 2pt; }
  h3 { font-size: 12pt; margin: 14pt 0 4pt; } p, ul, ol, table, blockquote, pre { margin: 6pt 0; }
  code { font-family: monospace; font-size: 9.5pt; background: #f2f2f2; padding: 0 2pt; } pre { background: #f2f2f2; padding: 6pt; white-space: pre-wrap; }
  blockquote { border-left: 3px solid #bbb; margin-left: 0; padding-left: 10pt; color: #444; }
  table { border-collapse: collapse; } th, td { border: 1px solid #bbb; padding: 3pt 6pt; text-align: left; }
  a { color: #0b57d0; word-break: break-all; }
`;

export function summaryHtml(markdown: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>1 次資料のまとめ</title><style>${PDF_STYLE}</style></head><body>${markdownToHtml(markdown)}</body></html>`;
}

// ---------- PDF ----------

async function hasChromium(browsersPath: string): Promise<boolean> {
  try {
    return (await readdir(browsersPath, { withFileTypes: true })).some((entry) => entry.isDirectory() && CHROMIUM_DIR.test(entry.name));
  } catch {
    return false;
  }
}

/**
 * PDF を作れなかった理由（呼び出し側は PDF だけ見送り、zip は続ける）。
 *   - no_chromium: ブラウザの置き場に Chromium が無い（人が playwright install chromium を実行する）
 *   - import_failed: playwright-core を読み込めない（監視アプリのバンドルで解決できない場合など）
 *   - launch_failed: Chromium の起動・印刷に失敗した（版が合わない・依存のライブラリが無いなど）
 * detail は原因のエラーメッセージ（秘密値を含まない）。
 */
export type PdfSkipKind = "no_chromium" | "import_failed" | "launch_failed";
export interface PdfSkip {
  skip: PdfSkipKind;
  detail: string;
}

/** HTML を PDF にする。作れなければ理由（PdfSkip）を返す。 */
export type PdfRenderer = (html: string) => Promise<Uint8Array | PdfSkip>;

const isPdfSkip = (value: Uint8Array | PdfSkip): value is PdfSkip => !(value instanceof Uint8Array);

/** 実ホームの ~/.cache/ms-playwright の Chromium で印刷する。JavaScript と外部への通信は止める。 */
export function chromiumPdfRenderer(browsersPath: string = join(homedir(), PLAYWRIGHT_BROWSERS_SUBDIR)): PdfRenderer {
  return async (html) => {
    if (!(await hasChromium(browsersPath))) return { skip: "no_chromium", detail: `${browsersPath} に Chromium が無い` };
    // playwright-core はブラウザの置き場を読み込み時の環境変数で決める
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= browsersPath;
    let chromium: typeof import("playwright-core").chromium;
    try {
      // 文字列リテラルのまま（webpackIgnore は付けない。監視アプリのバンドルに任せる）
      ({ chromium } = await import("playwright-core"));
    } catch (error) {
      return { skip: "import_failed", detail: errorText(error) };
    }
    // ブラウザの env は許可リスト（control-plane の環境にある秘密値を渡さない）。HOME は使い捨て
    const home = await mkdtemp(join(tmpdir(), "campaign-pdf-"));
    try {
      const browser = await chromium.launch({ env: { PATH: process.env.PATH ?? "", HOME: home }, timeout: 30_000 });
      try {
        const context = await browser.newContext({ javaScriptEnabled: false });
        await context.route("**/*", (route) => route.abort());
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
        return new Uint8Array(await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true }));
      } finally {
        await browser.close();
      }
    } catch (error) {
      // 起動できない（版が合わない・依存のライブラリが無いなど）ときも PDF だけを見送る
      return { skip: "launch_failed", detail: errorText(error) };
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  };
}

// ---------- パッケージ ----------

export interface PackagedAsset {
  name: string;
  mime: "application/zip" | "application/pdf";
  data: Uint8Array;
}

export interface PackageOptions {
  /** 作らないファイル（`<name>.<format>`）。アップロード済みのもの */
  skip?: ReadonlySet<string>;
  /** PDF を作る手段。既定は chromiumPdfRenderer() */
  renderPdf?: PdfRenderer;
  /** PDF を作れなかったときの通知（理由つき）。zip は続ける */
  onPdfSkip?: (fileName: string, skip: PdfSkip) => void;
  maxBytes?: number;
}

/** 配布ファイルの名前（Strapi に上げる名前）。`<name>.zip`・`<name>.pdf` */
export const assetFileName = (file: { name: string; format: "zip" | "pdf" }): string => `${file.name}.${file.format}`;

async function zipPlugin(dir: string, rootName: string, maxBytes: number): Promise<Uint8Array> {
  const problems: string[] = [];
  const files = await walkTree(dir, problems);
  if (problems.length > 0) throw new AssetError(`plugin/ に入れられないものがある（${problems.slice(0, 3).join("、")}）`);
  const entries: Record<string, [Uint8Array, { mtime: Date; level: 6 }]> = {};
  let total = 0;
  for (const file of files) {
    // 列挙から読むまでの間にすり替えられても、シンボリックリンクはたどらない
    if ((await fileKind(file.abs)) !== "file") throw new AssetError(`${file.rel}: 通常のファイルでなくなった`);
    const data = new Uint8Array(await readFile(file.abs));
    total += data.length;
    if (total > maxBytes) throw new AssetError(`plugin/ の合計が上限（${Math.floor(maxBytes / 1024 / 1024)} MB）を超えている`);
    entries[`${rootName}/${file.rel}`] = [data, { mtime: ZIP_MTIME, level: 6 }];
  }
  const zipped = zipSync(entries);
  if (zipped.length > maxBytes) throw new AssetError(`${rootName}.zip が上限（${Math.floor(maxBytes / 1024 / 1024)} MB）を超えている`);
  return zipped;
}

/**
 * `dir`（`campaign-assets/<proposal_id>/`）の manifest.yaml に従って、配布物を作る。zip は plugin/、PDF は summary.md から。
 * 作った分だけを返す（options.skip のもの・Chromium が無くて作れなかった PDF は含まない）。
 * manifest・原稿の誤りと、1 ファイル 20 MB（options.maxBytes）の超過は AssetError。シンボリックリンクはたどらない。
 */
export async function packageAssets(dir: string, options: PackageOptions = {}): Promise<PackagedAsset[]> {
  const maxBytes = options.maxBytes ?? MAX_ASSET_BYTES;
  const manifest = await readManifest(dir);
  const renderPdf = options.renderPdf ?? chromiumPdfRenderer();
  const assets: PackagedAsset[] = [];
  for (const file of manifest.files) {
    const fileName = assetFileName(file);
    if (options.skip?.has(fileName)) continue;
    if (file.format === "zip") {
      const pluginDir = join(dir, PLUGIN_SOURCE);
      if ((await fileKind(pluginDir)) !== "dir") throw new AssetError("plugin/ がディレクトリとして無い");
      assets.push({ name: fileName, mime: "application/zip", data: await zipPlugin(pluginDir, file.name, maxBytes) });
    } else {
      const summaryPath = join(dir, SUMMARY_SOURCE);
      if ((await fileKind(summaryPath)) !== "file") throw new AssetError(`${SUMMARY_SOURCE} が通常のファイルとして無い`);
      const markdown = await readFile(summaryPath, "utf8");
      if (Buffer.byteLength(markdown) > maxBytes) throw new AssetError(`${SUMMARY_SOURCE} が上限を超えている`);
      const pdf = await renderPdf(summaryHtml(markdown));
      if (isPdfSkip(pdf)) {
        options.onPdfSkip?.(fileName, pdf);
        continue;
      }
      if (pdf.length > maxBytes) throw new AssetError(`${fileName} が上限（${Math.floor(maxBytes / 1024 / 1024)} MB）を超えている`);
      assets.push({ name: fileName, mime: "application/pdf", data: pdf });
    }
  }
  return assets;
}

// ---------- builtin ----------

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureClassOf(error: unknown): FailureClass {
  return error instanceof IntegrationError ? error.failureClass : "invalid_response";
}

/** 作業ツリーの campaign-assets/ の下の、manifest.yaml のある proposal のディレクトリ名（昇順） */
async function listProposalDirs(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const names: string[] = [];
  for (const entry of entries) {
    // シンボリックリンクのディレクトリは isDirectory() が false になるので入らない
    if (!entry.isDirectory() || !PROPOSAL_DIR.test(entry.name)) continue;
    if ((await fileKind(join(root, entry.name, MANIFEST_FILE))) === null) continue;
    names.push(entry.name);
  }
  return names.sort();
}

/** PDF を見送ったときの案内（理由ごと。原因の詳しい文言はログにだけ残す） */
const PDF_SKIP_NOTES: Record<PdfSkipKind, string> = {
  no_chromium: "PDF を作れなかった（Chromium が無い。人が main のチェックアウトで playwright install chromium を実行する）",
  import_failed: "PDF を作れなかった（playwright-core を読み込めない。監視アプリのバンドルで解決できていない可能性がある。ログを見る）",
  launch_failed: "PDF を作れなかった（Chromium の起動か印刷に失敗した。版や依存のライブラリを確かめる。ログを見る）",
};

export const campaignAssetUpload: BuiltinHandler = async ({ ctx, runId, signal }): Promise<RunResult> => {
  const { config, kv } = ctx;
  const skipped = (reason: string): RunResult => ({
    outcome: "skipped",
    summary: `配布物のアップロードを見送った（${reason}）`,
    targetIds: [],
    skipReason: reason,
  });
  if (!config.strapi) return skipped("CONTROL_STRAPI_URL・CONTROL_STRAPI_READ_TOKEN が無い");
  if (!config.strapi.writeToken) return skipped("CONTROL_STRAPI_WRITE_TOKEN が無い（アップロードできない）");

  const root = join(config.worktree, CAMPAIGN_ASSETS_DIR);
  const dirs = (await listProposalDirs(root)).filter((name) => !kv.get(`${DONE_KEY_PREFIX}${name}`));
  if (dirs.length === 0) {
    return { outcome: "success", summary: "アップロードする配布物の原稿は無かった", targetIds: [] };
  }

  // スキーマは承認済み main の写しから読む。作業ツリーのものは使わない
  let schema: object;
  try {
    schema = JSON.parse(await readFile(join(config.mainCheckout, AGENT_PLUGINS_SCHEMA_FILE), "utf8")) as object;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return skipped(`${AGENT_PLUGINS_SCHEMA_FILE} が main のチェックアウトに無い`);
    logLine("ERROR", "campaign-asset-upload", `スキーマを読めなかった: ${errorText(error)}`, runId);
    return { outcome: "failure", summary: "plugin.json のスキーマを読めなかった", targetIds: [], failureClass: "invalid_response" };
  }

  const strapi = new StrapiClient(config.strapi.baseUrl, config.strapi.readToken, config.strapi.writeToken);
  const renderPdf = chromiumPdfRenderer();
  const targetIds: string[] = [];
  const notes: string[] = [];
  let done = 0;
  let failed = 0;
  let pdfSkipped = 0;
  const pdfSkipKinds = new Set<PdfSkipKind>();
  let firstFailureClass: FailureClass | null = null;
  let fatalClass: FailureClass | null = null;

  const fail = (proposalId: string, reason: string, failureClass: FailureClass) => {
    failed++;
    firstFailureClass ??= failureClass;
    // 項目の理由に出す（個人情報を含まない。原稿の中身ではなく、違反の種類だけ）
    notes.push(`${proposalId}: ${reason}`);
    logLine("WARN", "campaign-asset-upload", `${proposalId}: ${reason}`, runId);
  };

  for (const proposalId of dirs) {
    if (signal.aborted || fatalClass) break;
    const dir = join(root, proposalId);
    let manifest: Manifest;
    try {
      manifest = await readManifest(dir);
      if (manifest.proposal_id !== proposalId) throw new AssetError("manifest の proposal_id がディレクトリ名と違う");
    } catch (error) {
      fail(proposalId, errorText(error), "invalid_response");
      continue;
    }

    // 1. アップロードの前に、原稿の検証とパッケージをすべて済ませる（違反があれば 1 つも上げない）
    const uploadedNames = new Set(
      manifest.files.map(assetFileName).filter((fileName) => kv.get(`${FILE_KEY_PREFIX}${proposalId}:${fileName}`) !== null),
    );
    let assets: PackagedAsset[];
    try {
      if (manifest.files.some((file) => file.format === "zip" && !uploadedNames.has(assetFileName(file)))) {
        const violations = await validatePlugin(join(dir, PLUGIN_SOURCE), schema);
        if (violations.length > 0) {
          fail(proposalId, `plugin/ が検証に通らない（${violations.slice(0, 5).join(" / ")}）。アップロードしなかった`, "invalid_response");
          continue;
        }
      }
      assets = await packageAssets(dir, {
        skip: uploadedNames,
        renderPdf,
        onPdfSkip: (fileName, skip) => {
          pdfSkipped++;
          // 実際の原因をログに残す（案内は理由ごとに変える。見送りの note は理由の種類ごとに 1 回だけ）
          logLine("WARN", "campaign-asset-upload", `${proposalId}: ${fileName} の PDF を作れなかった（${skip.skip}: ${skip.detail}）`, runId);
          const note = PDF_SKIP_NOTES[skip.skip];
          if (!pdfSkipKinds.has(skip.skip)) {
            pdfSkipKinds.add(skip.skip);
            notes.push(`${proposalId}: ${note}`);
          }
        },
      });
    } catch (error) {
      fail(proposalId, `${errorText(error)}。アップロードしなかった`, "invalid_response");
      continue;
    }

    // 2. アップロードして記事に結ぶ。アップロード済み・結べた分は kv に覚え、やり直しても二重にしない
    let proposalFailed = false;
    for (const asset of assets) {
      if (signal.aborted) {
        proposalFailed = true;
        break;
      }
      let fileId: number;
      try {
        ({ id: fileId } = await strapi.uploadFile({ name: asset.name, mime: asset.mime, data: asset.data }, signal));
      } catch (error) {
        const failureClass = failureClassOf(error);
        fail(proposalId, `${asset.name} のアップロードに失敗した（${failureClass}）`, failureClass);
        if (failureClass === "auth_failed" || failureClass === "permission_denied") fatalClass = failureClass;
        proposalFailed = true;
        break;
      }
      kv.set(`${FILE_KEY_PREFIX}${proposalId}:${asset.name}`, String(fileId));
      targetIds.push(`asset:${proposalId}:${fileId}`);
      uploadedNames.add(asset.name);
    }
    if (proposalFailed) continue;

    // 結べていないファイルを、記事の下書きの blocks の末尾に足す
    for (const file of manifest.files) {
      const fileName = assetFileName(file);
      const fileId = kv.get(`${FILE_KEY_PREFIX}${proposalId}:${fileName}`);
      if (fileId === null || kv.get(`${ATTACHED_KEY_PREFIX}${proposalId}:${fileName}`) !== null) continue;
      if (signal.aborted) {
        proposalFailed = true;
        break;
      }
      try {
        await strapi.attachArticleFile(manifest.article_document_id, Number(fileId), signal);
        kv.set(`${ATTACHED_KEY_PREFIX}${proposalId}:${fileName}`, "1");
      } catch (error) {
        const failureClass = failureClassOf(error);
        fail(proposalId, `${fileName} を記事に結べなかった（${failureClass}）。アップロードは済んでいる`, failureClass);
        if (failureClass === "auth_failed" || failureClass === "permission_denied") fatalClass = failureClass;
        proposalFailed = true;
        break;
      }
    }
    if (proposalFailed) continue;

    const allDone = manifest.files.every((file) => {
      const fileName = assetFileName(file);
      return kv.get(`${ATTACHED_KEY_PREFIX}${proposalId}:${fileName}`) !== null;
    });
    if (allDone) {
      kv.set(`${DONE_KEY_PREFIX}${proposalId}`, "1");
      done++;
    }
  }

  const aborted = signal.aborted && !fatalClass;
  const summary = [
    `配布物のアップロード: 完了 ${done}・失敗 ${failed}・PDF を見送った ${pdfSkipped}（対象 ${dirs.length} 件）`,
    ...notes,
    aborted ? "停止要求かタイムアウトで残りは次回に回した" : null,
  ]
    .filter((line) => line !== null)
    .join("。");
  // 完了が 1 つも無くて失敗があれば failure、一部なら partial。PDF の見送りだけ（失敗なし）も partial（次回に再試行する）
  const outcome = failed > 0 && done === 0 && targetIds.length === 0 ? "failure" : failed > 0 || pdfSkipped > 0 || aborted ? "partial" : "success";
  return {
    outcome,
    summary,
    targetIds,
    failureClass: fatalClass ?? (failed === 0 ? null : firstFailureClass),
  };
};
