// 周の項目の中身（preview）を、作用のジョブの成果物から組み立てる（cycle-collect が使う）。
// - 記事は本番の Strapi の下書き、メールとキャンペーンは本番の Mautic（参照専用）から読む。
// - 画面に出す文字は PII の形（メールアドレス・電話番号）を伏せ字にする。長い本文は切る。
// - 組み立てられないとき（設定が無い・成果物が無い・見つからない）は理由の文を返す（項目は準備中のまま）。
import { createHash } from "node:crypto";
import { join } from "node:path";
import { assetFileName, FILE_KEY_PREFIX, readManifest } from "../builtin/campaign-asset-upload.js";
import { CAMPAIGN_ASSETS_DIR } from "../constants/paths.js";
import type { CycleItemPreview, RunRecord } from "../contract.js";
import type { MauticReader } from "../integrations/mautic.js";
import type { StrapiArticle, StrapiClient } from "../integrations/strapi.js";
import { redactPii } from "../pii.js";
import { CREATED_PREFIX } from "../runner/output.js";
import type { KvStore } from "../store/kv.js";
import { isSafeCodeFile } from "./commands.js";
import { runGit } from "./git.js";
import { articlePublicUrl, siteBase } from "./urls.js";

/** 画面に出す記事の本文の上限（文字数） */
const BODY_MARKDOWN_MAX = 20_000;
const DIFF_STAT_MAX = 4_000;
const GIT_TIMEOUT_MS = 15_000;

export type PreviewOutcome<P extends CycleItemPreview> = { preview: P } | { note: string };

type ArticlePreview = Extract<CycleItemPreview, { kind: "article" }>;
type CampaignPreview = Extract<CycleItemPreview, { kind: "campaign" }>;
type CodePreview = Extract<CycleItemPreview, { kind: "code" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * 実行の CREATED: の結果（種類 → 値）。output.ts が targetIds に入れた `created:<種類>=<値>` と、
 * 要約の 1 行に書かれてしまった `CREATED: <種類>=<値>` の両方から取る。
 */
export function createdOf(run: Pick<RunRecord, "targetIds" | "summary">): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (kind: string, value: string) => {
    const values = out.get(kind) ?? [];
    if (!values.includes(value)) out.set(kind, [...values, value]);
  };
  for (const id of run.targetIds) {
    if (!id.startsWith(CREATED_PREFIX)) continue;
    const [kind, ...rest] = id.slice(CREATED_PREFIX.length).split("=");
    if (kind && rest.length > 0) add(kind, rest.join("="));
  }
  for (const match of (run.summary ?? "").matchAll(/CREATED:\s*([a-z]+)=([^\s。、]+)/g)) {
    const kind = match[1]!;
    for (const value of kind === "files" ? match[2]!.split(",") : [match[2]!]) add(kind === "files" ? "file" : kind, value.trim());
  }
  return out;
}

/** Strapi のメディアの URL を絶対 URL にする（frontend/verdant-virgo の media.ts の toAbsoluteMediaUrl と同じ） */
function absoluteMediaUrl(url: string, strapiBaseUrl: string): string {
  return /^https?:\/\//.test(url) ? url : new URL(url, strapiBaseUrl).toString();
}

const DISTRIBUTION_EXT: Record<string, string> = { "application/zip": ".zip", "application/pdf": ".pdf" };

/**
 * 配布ファイル（zip・PDF）の公開サイトでのパス。frontend/verdant-virgo の blog/lib/files.ts の toDistributionFile と同じ式
 * （/files/<Strapi の URL のパスの sha256 の先頭 16 桁>/<名前>）。あちらを変えたらここも変える。
 */
export function distributionHref(media: { url: string; name: string | null; mime: string }, strapiBaseUrl: string): string | null {
  const ext = DISTRIBUTION_EXT[media.mime];
  if (!ext) return null;
  const source = absoluteMediaUrl(media.url, strapiBaseUrl);
  const pathname = new URL(source).pathname;
  const raw = media.name?.trim() || pathname.split("/").pop() || "download";
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").replace(/\.{2,}/g, ".") || "download";
  const name = safe.toLowerCase().endsWith(ext) ? safe : `${safe}${ext}`;
  const hash = createHash("sha256").update(pathname).digest("hex").slice(0, 16);
  return `/files/${hash}/${name}`;
}

/** 下書きの blocks から、画面に出す本文（Markdown）を組み立てる */
function bodyOf(article: StrapiArticle, strapiBaseUrl: string): string {
  const parts: string[] = [];
  for (const block of article.blocks) {
    const component = str(block.__component);
    if (component === "shared.rich-text") {
      const body = str(block.body);
      if (body) parts.push(body.trim());
    } else if (component === "shared.quote") {
      const lines = [str(block.title), str(block.body)].filter((line): line is string => !!line);
      if (lines.length > 0) parts.push(lines.map((line) => `> ${line}`).join("\n"));
    } else if (component === "shared.media" && isRecord(block.file)) {
      const url = str(block.file.url);
      const name = str(block.file.name) ?? "ファイル";
      if (url) parts.push(str(block.file.mime)?.startsWith("image/") ? `![${name}](${absoluteMediaUrl(url, strapiBaseUrl)})` : `[配布ファイル: ${name}]`);
    }
  }
  const text = parts.join("\n\n");
  return redactPii(text.length > BODY_MARKDOWN_MAX ? `${text.slice(0, BODY_MARKDOWN_MAX - 1)}…` : text).text;
}

export interface PreviewSources {
  strapi: StrapiClient | null;
  strapiBaseUrl: string | null;
  mautic: MauticReader | null;
  siteUrl: string | null;
  worktree: string;
  kv: Pick<KvStore, "get">;
  /** article-cover の cover-pending の印（documentId → ファイル ID） */
  coverPending: Map<string, number>;
  /** campaign-asset-upload の asset の印（proposal_id → ファイル ID） */
  uploadedAssets: Map<string, Set<number>>;
  signal: AbortSignal;
}

/** 記事の下書きから article の中身を作る */
export async function articlePreview(documentId: string, src: PreviewSources): Promise<PreviewOutcome<ArticlePreview> & { article?: StrapiArticle }> {
  if (!src.strapi || !src.strapiBaseUrl) return { note: "Strapi の読み取りの設定が無いため、記事の中身を読めない" };
  const article = await src.strapi.getArticle(documentId, "draft", src.signal);
  if (!article) return { note: `記事の下書き（${documentId}）が Strapi に無い` };
  return {
    article,
    preview: {
      kind: "article",
      documentId,
      slug: article.slug ?? "",
      titleText: redactPii(article.title ?? "").text,
      description: redactPii(article.description ?? "").text,
      coverUrl: article.cover?.url ? absoluteMediaUrl(article.cover.url, src.strapiBaseUrl) : null,
      bodyMarkdown: bodyOf(article, src.strapiBaseUrl),
      coverPendingFileId: article.cover ? null : (src.coverPending.get(documentId) ?? null),
      draftUpdatedAt: article.updatedAt,
    },
  };
}

/** 記事に結ばれた配布ファイルと、まだ結ばれていない（原稿・アップロード済み）ものの一覧 */
async function campaignAssets(proposalId: string, article: StrapiArticle, src: PreviewSources): Promise<CampaignPreview["assets"]> {
  const base = src.strapiBaseUrl!;
  const attached = new Map<number, { name: string; url: string | null }>();
  for (const block of article.blocks) {
    if (str(block.__component) !== "shared.media" || !isRecord(block.file) || typeof block.file.id !== "number") continue;
    const url = str(block.file.url);
    const mime = str(block.file.mime) ?? "";
    const href = url ? distributionHref({ url, name: str(block.file.name), mime }, base) : null;
    if (href) attached.set(block.file.id, { name: str(block.file.name) ?? href.split("/").pop()!, url: src.siteUrl ? `${siteBase(src.siteUrl)}${href}` : null });
  }
  const assets = [...attached.values()];
  const listed = new Set(attached.keys());
  // 原稿（manifest.yaml）にあって、まだ記事に結ばれていないファイル
  try {
    const manifest = await readManifest(join(src.worktree, CAMPAIGN_ASSETS_DIR, proposalId));
    for (const file of manifest.files) {
      const name = assetFileName(file);
      const fileId = Number(src.kv.get(`${FILE_KEY_PREFIX}${proposalId}:${name}`));
      if (Number.isInteger(fileId) && fileId > 0 && listed.has(fileId)) continue;
      assets.push({ name, url: null });
      if (Number.isInteger(fileId) && fileId > 0) listed.add(fileId);
    }
  } catch {
    // 原稿が無い（配布ファイルを作らないキャンペーン）・読めないときは、記事に結ばれたものとアップロードの印だけで出す
  }
  for (const fileId of src.uploadedAssets.get(proposalId) ?? []) {
    if (!listed.has(fileId)) assets.push({ name: `ファイル id ${fileId}`, url: null });
  }
  return assets;
}

/** campaign-planner の成果物（記事・メール・キャンペーン）から campaign の中身を作る */
export async function campaignPreview(
  proposalId: string,
  created: Map<string, string[]>,
  segmentHint: string | null,
  src: PreviewSources,
): Promise<PreviewOutcome<CampaignPreview>> {
  const documentId = created.get("article")?.[0];
  const emailId = Number(created.get("email")?.[0]);
  const campaignId = Number(created.get("campaign")?.[0]);
  if (!documentId || !Number.isInteger(emailId) || !Number.isInteger(campaignId)) {
    return { note: "作用のジョブの結果に記事・メール・キャンペーンの ID がそろっていない（CREATED: の行が無い）" };
  }
  if (!src.mautic) return { note: "Mautic の読み取りの設定（CONTROL_MAUTIC_*）が無いため、メールとキャンペーンの中身を読めない" };
  if (!src.siteUrl) return { note: "SITE_URL が無いため、メールのリンク先を組み立てられない" };
  const article = await articlePreview(documentId, src);
  if ("note" in article) return article;
  if (!article.preview.slug) return { note: "キャンペーンの記事に slug が無い" };
  const [email, campaign] = [await src.mautic.getEmail(emailId), await src.mautic.getCampaign(campaignId)];
  if (!email) return { note: `Mautic にメール（id ${emailId}）が無い` };
  if (!campaign) return { note: `Mautic にキャンペーン（id ${campaignId}）が無い` };
  // 承認するのは、キャンペーンが送るメール（email.send のイベントの properties.email）が作ったメールと同じときだけ（I4）。
  // イベントが無い・別のメールを送るイベントがあるときは、画面で確かめたメールと送られるメールがずれるので中身を作らない
  const sends = campaign.emailSendIds ?? [];
  if (sends.length === 0) return { note: `キャンペーン（id ${campaignId}）にメールを送るイベント（email.send）が無い` };
  const others = [...new Set(sends.filter((id) => id !== emailId))];
  if (others.length > 0) {
    const ids = others.map((id) => (id < 0 ? "不明" : String(id))).join("・");
    return { note: `キャンペーン（id ${campaignId}）が、作ったメール（id ${emailId}）以外のメール（id ${ids}）を送る` };
  }
  const segments = [];
  for (const id of campaign.segmentIds ?? []) {
    const segment = await src.mautic.getSegment(id);
    if (segment) segments.push(segment);
  }
  const counted = segments.filter((segment) => typeof segment.count === "number");
  const utm = new URLSearchParams({ utm_source: "mautic", utm_medium: "email", utm_campaign: proposalId });
  return {
    preview: {
      kind: "campaign",
      articleDocumentId: documentId,
      linkUrl: `${articlePublicUrl(src.siteUrl, article.preview.slug)}?${utm.toString()}`,
      emailId,
      emailSubject: redactPii(email.subject ?? "").text,
      emailBody: email.bodyText ?? "",
      campaignId,
      segmentName: segments.map((segment) => segment.name).filter((name) => !!name).join("・") || segmentHint || "（不明）",
      // 件数を読めないときは -1（画面で「不明」と出す。0 件と取り違えない）
      segmentCount: counted.length > 0 ? counted.reduce((sum, segment) => sum + segment.count!, 0) : -1,
      assets: await campaignAssets(proposalId, article.article!, src),
      coverPendingFileId: article.preview.coverPendingFileId ?? null,
      coverUrl: article.preview.coverUrl,
    },
  };
}

/** design-implementer の成果物（変えたファイル）から code の中身を作る。差分の要約は作業ツリーの git diff --stat（参照だけ） */
export async function codePreview(proposalId: string, files: string[], worktree: string, signal: AbortSignal): Promise<PreviewOutcome<CodePreview>> {
  const safe = [...new Set(files)].filter(isSafeCodeFile);
  if (safe.length === 0) return { note: "作用のジョブの結果に、公開サイトのファイル（CREATED: files=）が無い" };
  const run = (args: string[]) => runGit(worktree, args, { timeoutMs: GIT_TIMEOUT_MS, signal, maxBuffer: 1024 * 1024 });
  const stat = await run(["diff", "--stat", "HEAD", "--", ...safe]);
  const status = await run(["status", "--porcelain", "--", ...safe]);
  let diffStat: string;
  if (!stat.ok || !status.ok) {
    diffStat = "作業場の差分を読めなかった";
  } else {
    const untracked = status.stdout.split("\n").filter((line) => line.startsWith("??")).length;
    diffStat =
      [stat.stdout.trim(), untracked > 0 ? `新規（未追跡）のファイル ${untracked} 件` : null].filter((line) => !!line).join("\n") ||
      "差分が見つからない（コミット済みか、ファイルが無い）";
  }
  return { preview: { kind: "code", proposalId, files: safe, diffStat: diffStat.slice(0, DIFF_STAT_MAX) } };
}

/** 承認済みの E-13 の target.identifier（`segment:<名前>#<slug>`。Ruling 6）からセグメントの名前 */
export function segmentNameOf(identifier: string): string | null {
  const match = /^segment:([^#]+)(?:#.*)?$/.exec(identifier);
  return match?.[1]?.trim() || null;
}
