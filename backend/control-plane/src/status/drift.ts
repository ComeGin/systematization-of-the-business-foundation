// 設定の状況: 設定スクリプトが確かめていない「ずれ」（spec 5.3）のうち、公開サイトの再配信・本番の n8n のワークフロー・
// 公開済みの記事の配信（deploy-drift-detection の spec 4.5）。
// 再配信と n8n は origin/main を基準にする。origin/main を新しくするのは git-fetch.ts の fetchMain（呼び出し側が先に実行する）。
// 読み取りだけ: git は log・show・rev-parse・ls-tree・merge-base だけ。本番の n8n・本番の Strapi は GET だけ。
// 根拠の文字列（evidence）は日本語の短い文で、トークン・API キーを入れない（URL は認証情報なしのものだけ）。
import type { SetupStatusLevel } from "../contract.js";
import { N8N_WORKFLOWS_DIR, VERDANT_VIRGO_DIR } from "../constants/paths.js";
import { IntegrationError, fetchJson } from "../integrations/http.js";
import { N8nClient } from "../integrations/n8n.js";
import { type PublishedArticle, StrapiClient } from "../integrations/strapi.js";
import { logLine } from "../log.js";
import { toIsoJst } from "../time.js";
import { GIT_READ_TIMEOUT_MS, readTokenOrNull, runGit } from "./git-fetch.js";

export type DriftResult = {
  id: "site-redeploy" | "n8n-workflows" | "site-articles";
  level: SetupStatusLevel;
  evidence: string;
  /** 前回の結果を引き継いだとき、その結果を確かめた時刻（JST の ISO 8601）。無ければ今回の確認の時刻 */
  checkedAt?: string;
  /** site-articles だけ: 取り下げの記事の slug → 最初に見つけた時刻（JST の ISO 8601）。次の回に引き継いで 48 時間を数える */
  firstSeen?: Record<string, string>;
};

const SITE_FETCH_TIMEOUT_MS = 15_000;
const GITHUB_FETCH_TIMEOUT_MS = 15_000;
const SHA = /^[0-9a-f]{40}$/;

const short = (sha: string) => sha.slice(0, 7);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// ---------------------------------------------------------------------------
// 公開サイトの再配信
// ---------------------------------------------------------------------------

interface LogEntry {
  sha: string;
  subject: string;
}

/** `git log --format=%H%x09%cI%x09%s` の出力（新しい順）。 */
function parseLog(stdout: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [sha, , ...subject] = line.split("\t");
    if (sha && SHA.test(sha)) entries.push({ sha, subject: subject.join("\t") });
  }
  return entries;
}

/** コミットに紐づく PR の番号。取れなければ null（コミットだけを出す）。 */
async function pullRequestOf(
  repository: string,
  sha: string,
  token: string | null,
  signal: AbortSignal,
): Promise<number | null> {
  if (token === null) return null;
  try {
    const result = await fetchJson<{ number?: unknown; merged_at?: unknown }[]>({
      upstream: "github",
      url: `https://api.github.com/repos/${repository}/commits/${sha}/pulls`,
      init: {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "comegin-control-plane",
        },
      },
      timeoutMs: GITHUB_FETCH_TIMEOUT_MS,
      signal,
    });
    if (!Array.isArray(result.data)) return null;
    const pulls = result.data.filter((pull) => typeof pull?.number === "number");
    const pick = pulls.find((pull) => pull.merged_at) ?? pulls[0];
    return pick ? (pick.number as number) : null;
  } catch {
    return null;
  }
}

export async function checkSiteRedeploy(opts: {
  checkout: string;
  siteUrl: string;
  repository: string;
  tokenFile: string;
  signal: AbortSignal;
}): Promise<DriftResult> {
  const id = "site-redeploy" as const;
  const { checkout, signal } = opts;

  // 1. 配信中のビルドの情報（AWS の権限は要らない。公開サイトから HTTPS で読む）
  const url = `${opts.siteUrl.replace(/\/+$/, "")}/build-info.json`;
  const fetched = await fetchJson<{ commit?: unknown; builtAt?: unknown }>({
    upstream: "other",
    url,
    init: { method: "GET", headers: { Accept: "application/json" }, cache: "no-store" },
    timeoutMs: SITE_FETCH_TIMEOUT_MS,
    signal,
  });
  if (fetched.status === 404) {
    return { id, level: "action", evidence: "配信中のビルドにビルドの情報が無い。この機能より前のビルド" };
  }
  if (fetched.status === null) {
    return { id, level: "unknown", evidence: `公開サイトの build-info.json に届かない（${fetched.failureClass}）` };
  }
  const info = fetched.data;
  if (fetched.failureClass !== "ok" || info === null || typeof info !== "object") {
    return {
      id,
      level: "unknown",
      evidence: `公開サイトの build-info.json を読めない（${fetched.failureClass}${fetched.status ? `、HTTP ${fetched.status}` : ""}）`,
    };
  }
  const builtAt = typeof info.builtAt === "string" ? info.builtAt : "日時不明";
  if (typeof info.commit !== "string" || !SHA.test(info.commit)) {
    return {
      id,
      level: "unknown",
      evidence: `配信中のビルド（${builtAt}）にコミットの情報が無い。ビルドのときに git を読めなかった`,
    };
  }
  const commit = info.commit;

  // 2. 配信中のコミットが origin/main の履歴にあること（無ければ、ブランチからのビルドなどで比べられない）
  const ancestor = await runGit(checkout, ["merge-base", "--is-ancestor", commit, "origin/main"], {
    signal,
    timeoutMs: GIT_READ_TIMEOUT_MS,
  });
  if (ancestor.aborted) return { id, level: "unknown", evidence: "打ち切られた" };
  if (ancestor.code !== 0) {
    const why = ancestor.code === 1 ? "origin/main の履歴に無い（main 以外からのビルド？）" : "チェックアウトに無いか、origin/main を読めない";
    return { id, level: "unknown", evidence: `配信中のビルド（${short(commit)}）が${why}` };
  }

  // 3. そのコミットより後に、公開サイトを変えたコミット
  const log = await runGit(
    checkout,
    ["log", "--format=%H%x09%cI%x09%s", `${commit}..origin/main`, "--", VERDANT_VIRGO_DIR],
    { signal, timeoutMs: GIT_READ_TIMEOUT_MS },
  );
  if (log.aborted) return { id, level: "unknown", evidence: "打ち切られた" };
  if (log.code !== 0) return { id, level: "unknown", evidence: "git log で origin/main との差を読めない" };
  const entries = parseLog(log.stdout);
  if (entries.length === 0) {
    return { id, level: "ok", evidence: `配信中のビルド ${builtAt}（${short(commit)}）以降、公開サイトの変更なし` };
  }

  // 新しい順なので、最初のコミット = 末尾、最後のコミット = 先頭
  const first = entries[entries.length - 1]!;
  const last = entries[0]!;
  const token = await readTokenOrNull(opts.tokenFile);
  const describe = async (entry: LogEntry) => {
    const pull = await pullRequestOf(opts.repository, entry.sha, token, signal);
    return `${short(entry.sha)} ${clip(entry.subject, 50)}${pull === null ? "" : `（PR #${pull}）`}`;
  };
  const firstText = await describe(first);
  const lastText = entries.length === 1 ? null : await describe(last);
  const range = lastText === null ? firstText : `最初 ${firstText} 〜 最後 ${lastText}`;
  return {
    id,
    level: "action",
    evidence: `配信中のビルド ${builtAt}（${short(commit)}）の後に、公開サイトの変更が ${entries.length} 件: ${range}`,
  };
}

// ---------------------------------------------------------------------------
// 本番の n8n のワークフロー
// ---------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isObject(value: unknown): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** キーの順を固定する（配列の順序は意味があるので変えない）。 */
function sortDeep(value: unknown): Json {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!isObject(value)) return (value ?? null) as Json;
  const sorted: { [key: string]: Json } = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortDeep(value[key]);
  return sorted;
}

interface Comparable {
  nodes: Map<string, { type: string; typeVersion: string; parameters: string }>;
  connections: string;
}

/**
 * 取り込み（middleware/n8n/provision/provision.mjs）で書き換わる値を、比べる前にそろえる。
 * 子のワークフローを呼ぶノード（executeWorkflow）の workflowId.value は、取り込みのときに本番の id に付け替わる
 * （リポジトリの JSON には書き出し元＝開発の id が入っている）。ので、名前（cachedResultName）だけで比べる。
 */
function normalizeParameters(type: string, parameters: unknown): Json {
  if (type === "n8n-nodes-base.executeWorkflow" && isObject(parameters) && isObject(parameters.workflowId)) {
    return sortDeep({ ...parameters, workflowId: { cachedResultName: parameters.workflowId.cachedResultName ?? null } });
  }
  return sortDeep(parameters ?? {});
}

/**
 * 比べる項目だけを取り出す: ノード（名前・型・typeVersion・パラメータ。スケジュールのトリガーの規則はノードのパラメータ）と接続。
 * id・位置・updatedAt・資格情報の id・active などは比べない（見た目や実行のたびの変化で「ずれ」にしない）。
 */
function comparable(workflow: unknown): Comparable {
  const root = isObject(workflow) ? workflow : {};
  const nodes = new Map<string, { type: string; typeVersion: string; parameters: string }>();
  for (const raw of Array.isArray(root.nodes) ? root.nodes : []) {
    if (!isObject(raw) || typeof raw.name !== "string") continue;
    const type = typeof raw.type === "string" ? raw.type : "";
    nodes.set(raw.name, {
      type,
      typeVersion: JSON.stringify(raw.typeVersion ?? null),
      parameters: JSON.stringify(normalizeParameters(type, raw.parameters)),
    });
  }
  return { nodes, connections: JSON.stringify(sortDeep(root.connections ?? {})) };
}

/** 違いの短い説明。同じなら null。 */
function differences(repo: Comparable, prod: Comparable): string | null {
  const added = [...repo.nodes.keys()].filter((name) => !prod.nodes.has(name));
  const removed = [...prod.nodes.keys()].filter((name) => !repo.nodes.has(name));
  if (added.length > 0 || removed.length > 0) return "ノードの追加・削除";
  const changed = [...repo.nodes.entries()].filter(([name, node]) => {
    const other = prod.nodes.get(name)!;
    return node.type !== other.type || node.typeVersion !== other.typeVersion || node.parameters !== other.parameters;
  });
  if (changed.length > 0) return `ノード「${clip(changed[0]![0], 20)}」${changed.length > 1 ? `ほか ${changed.length - 1} 件` : ""}の設定`;
  if (repo.connections !== prod.connections) return "ノードの接続";
  return null;
}

const MAX_LISTED = 5;
/** 本番に取り込むワークフローの表。provision.mjs もこのファイルを読む（実行せずに読めるよう JSON） */
const N8N_PROVISION_TABLE = "middleware/n8n/provision/workflows.json";
/** 表の file として受け付ける名前（ディレクトリをたどらせない） */
const FILE_NAME = /^[^/\\\0]+\.json$/;

export async function checkN8nWorkflows(opts: {
  checkout: string;
  n8n: { baseUrl: string; apiKey: string } | null;
  signal: AbortSignal;
}): Promise<DriftResult> {
  const id = "n8n-workflows" as const;
  const { checkout, signal } = opts;
  // キーが無いのは障害ではなく判断待ち（daily-n8n-export の扱いが決まるまで本番の n8n の API キーを置かない）。
  // ? にすると「確かめられない」の知らせが出続ける（または黙る）ので、◇ 人が確かめるにする
  if (opts.n8n === null) {
    return {
      id,
      level: "manual",
      evidence:
        "本番の n8n の API キー（CONTROL_N8N_EXPORT_*）が無いので比べない（daily-n8n-export の判断待ち。setup/00-setup-overview.md の 6 節）",
    };
  }

  // 1. 本番に取り込むワークフローの表（provision の workflows.json。targets に prod を含むものだけ）。
  //    ops-monitor のように開発だけのものは本番に取り込まれないので、比べない
  const table = await runGit(checkout, ["show", `origin/main:${N8N_PROVISION_TABLE}`], { signal, timeoutMs: GIT_READ_TIMEOUT_MS });
  if (table.aborted) return { id, level: "unknown", evidence: "打ち切られた" };
  if (table.code !== 0) {
    return { id, level: "unknown", evidence: `origin/main から本番に取り込むワークフローの表（${N8N_PROVISION_TABLE}）を読めない` };
  }
  let files: string[];
  try {
    const parsed: unknown = JSON.parse(table.stdout);
    if (!Array.isArray(parsed)) throw new Error("配列ではない");
    files = parsed
      .filter((entry): entry is { file: string; targets: string[] } => isObject(entry) && typeof entry.file === "string" && Array.isArray(entry.targets))
      .filter((entry) => entry.targets.includes("prod") && FILE_NAME.test(entry.file))
      .map((entry) => entry.file)
      .sort();
  } catch {
    return { id, level: "unknown", evidence: `本番に取り込むワークフローの表（${N8N_PROVISION_TABLE}）が JSON として読めない` };
  }

  const repoWorkflows = new Map<string, Comparable>();
  for (const file of files) {
    const shown = await runGit(checkout, ["show", `origin/main:${N8N_WORKFLOWS_DIR}/${file}`], { signal, timeoutMs: GIT_READ_TIMEOUT_MS });
    if (shown.aborted) return { id, level: "unknown", evidence: "打ち切られた" };
    if (shown.code !== 0) return { id, level: "unknown", evidence: `origin/main の ${file} を読めない` };
    try {
      const parsed = JSON.parse(shown.stdout) as { name?: unknown };
      if (typeof parsed.name === "string") repoWorkflows.set(parsed.name.normalize("NFC"), comparable(parsed));
    } catch {
      // 壊れた JSON は比べる対象にしない（n8n-export と同じ扱い）
      logLine("WARN", "setup-status", `${file} を JSON として読めない（n8n の比較に使わない）`);
    }
  }
  if (repoWorkflows.size === 0) {
    return { id, level: "ok", evidence: "本番に取り込むワークフローの JSON が origin/main に無く、比べるものが無い" };
  }

  // 2. 本番の n8n（名前で対応づける。アーカイブ済みは無いものとして扱う）
  const n8n = new N8nClient(opts.n8n, signal);
  const differing: string[] = [];
  try {
    const summaries = (await n8n.listWorkflows()).filter((workflow) => !workflow.isArchived);
    for (const [name, repo] of [...repoWorkflows].sort(([a], [b]) => a.localeCompare(b))) {
      if (signal.aborted) return { id, level: "unknown", evidence: "打ち切られた" };
      const candidates = summaries
        .filter((summary) => summary.name.normalize("NFC") === name)
        .sort((a, b) => a.id.localeCompare(b.id));
      if (candidates.length === 0) {
        differing.push(`${clip(name, 30)}（本番に無い）`);
        continue;
      }
      // 同じ名前が複数あれば、どれか 1 つが一致していればよい。一致しなければ先頭の違いを出す
      const reasons: (string | null)[] = [];
      for (const candidate of candidates) reasons.push(differences(repo, comparable(await n8n.getWorkflow(candidate.id))));
      const reason = reasons.includes(null) ? null : reasons[0]!;
      if (reason !== null) differing.push(`${clip(name, 30)}（${reason}）`);
    }
  } catch (error) {
    if (signal.aborted) return { id, level: "unknown", evidence: "打ち切られた" };
    const failureClass = error instanceof IntegrationError ? error.failureClass : "invalid_response";
    logLine("WARN", "setup-status", `本番の n8n を読めない: ${failureClass}`);
    return { id, level: "unknown", evidence: `本番の n8n を読めない（${failureClass}）` };
  }

  if (differing.length === 0) {
    return { id, level: "ok", evidence: `origin/main の ${repoWorkflows.size} 件のワークフローが、本番の n8n と一致` };
  }
  const listed = differing.slice(0, MAX_LISTED).join("、");
  const rest = differing.length > MAX_LISTED ? `、ほか ${differing.length - MAX_LISTED} 件` : "";
  return {
    id,
    level: "action",
    evidence: `本番の n8n が origin/main のワークフローと違う（${differing.length} 件）: ${listed}${rest}`,
  };
}

// ---------------------------------------------------------------------------
// 公開済みの記事の配信（spec 4.5）
// ---------------------------------------------------------------------------

/** 公開・更新・取り下げから配信までの猶予（ユーザーの決定）。ちょうど 48 時間は過ぎたものとして数える */
export const ARTICLE_GRACE_MS = 48 * 60 * 60 * 1000;

const ARTICLE_FIX = "直し方: 周の承認画面の配信の項目を承認して配信する（無ければ毎日 00:00 に作られる）";

interface DeployedArticle {
  slug: string;
  publishedAt: string;
  updatedAt: string;
}

type PendingKind = "公開" | "更新" | "取り下げ";

interface PendingArticle {
  slug: string;
  kind: PendingKind;
  /** 数え始めの時刻（ミリ秒）。読めない日時は -Infinity（猶予を与えず、取りこぼさない側に倒す） */
  since: number;
}

/** build-info.json の articles を読む。形が違えば null */
function parseDeployedArticles(value: unknown): DeployedArticle[] | null {
  if (!Array.isArray(value)) return null;
  const articles: DeployedArticle[] = [];
  for (const entry of value) {
    if (!isObject(entry)) return null;
    const { slug, publishedAt, updatedAt } = entry;
    if (typeof slug !== "string" || typeof publishedAt !== "string" || typeof updatedAt !== "string") return null;
    articles.push({ slug, publishedAt, updatedAt });
  }
  return articles;
}

const parseTime = (text: string) => {
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
};

/** 同じ時刻か（書き方の違い〈ミリ秒の有無など〉では差にしない） */
function sameTime(a: string, b: string): boolean {
  const ma = Date.parse(a);
  const mb = Date.parse(b);
  return Number.isNaN(ma) || Number.isNaN(mb) ? a === b : ma === mb;
}

function listPending(pending: PendingArticle[]): string {
  const listed = pending
    .slice(0, MAX_LISTED)
    .map((entry) => `${clip(entry.slug, 40)}（${entry.kind}）`)
    .join("、");
  const rest = pending.length > MAX_LISTED ? `、ほか ${pending.length - MAX_LISTED} 件` : "";
  return `${listed}${rest}`;
}

export async function checkSiteArticles(opts: {
  siteUrl: string;
  strapi: { baseUrl: string; readToken: string } | null;
  previous: DriftResult | undefined;
  now: Date;
  signal: AbortSignal;
}): Promise<DriftResult> {
  const id = "site-articles" as const;
  const { signal, now } = opts;
  // 確かめられなかった回も、取り下げの最初の時刻は捨てない（捨てると 48 時間を数え直してしまう）
  const previousFirstSeen = opts.previous?.firstSeen;
  const keep = previousFirstSeen && Object.keys(previousFirstSeen).length > 0 ? { firstSeen: previousFirstSeen } : {};
  // 読み取りのトークンが無いのは障害ではなく設定の選択（改善ループの Strapi を使わない構成）。n8n-workflows と同じく ◇
  if (!opts.strapi) {
    return {
      id,
      level: "manual",
      evidence: "本番の Strapi の読み取りの設定（CONTROL_STRAPI_URL・CONTROL_STRAPI_READ_TOKEN）が無いので比べない",
    };
  }

  // 1. 配信中のビルドが取り込んだ記事の一覧（build-info.json の articles）
  const url = `${opts.siteUrl.replace(/\/+$/, "")}/build-info.json`;
  const fetched = await fetchJson<{ builtAt?: unknown; articles?: unknown }>({
    upstream: "other",
    url,
    init: { method: "GET", headers: { Accept: "application/json" }, cache: "no-store" },
    timeoutMs: SITE_FETCH_TIMEOUT_MS,
    signal,
  });
  if (fetched.status === 404) {
    return { id, level: "action", evidence: `配信中のビルドに記事の一覧の記録が無い（この機能より前のビルド）。次の配信で消える。${ARTICLE_FIX}` };
  }
  if (fetched.status === null) {
    return { id, level: "unknown", evidence: `公開サイトの build-info.json に届かない（${fetched.failureClass}）`, ...keep };
  }
  const info = fetched.data;
  if (fetched.failureClass !== "ok" || info === null || typeof info !== "object") {
    return {
      id,
      level: "unknown",
      evidence: `公開サイトの build-info.json を読めない（${fetched.failureClass}${fetched.status ? `、HTTP ${fetched.status}` : ""}）`,
      ...keep,
    };
  }
  const builtAt = typeof info.builtAt === "string" ? info.builtAt : "日時不明";
  if (!("articles" in info)) {
    return {
      id,
      level: "action",
      evidence: `配信中のビルド（${builtAt}）に記事の一覧の記録が無い（この機能より前のビルド）。次の配信で消える。${ARTICLE_FIX}`,
    };
  }
  if (info.articles === null) {
    return {
      id,
      level: "unknown",
      evidence: `配信中のビルド（${builtAt}）が記事の一覧を記録していない。ビルドのときに Strapi を読めなかった`,
      ...keep,
    };
  }
  const deployed = parseDeployedArticles(info.articles);
  if (deployed === null) {
    return { id, level: "unknown", evidence: `配信中のビルド（${builtAt}）の記事の一覧の形が想定と違う`, ...keep };
  }

  // 2. 本番の Strapi の公開済みの記事（読み取りのトークンだけを使う）
  let published: PublishedArticle[];
  try {
    published = await new StrapiClient(opts.strapi.baseUrl, opts.strapi.readToken, null).listPublishedArticles(signal);
  } catch (error) {
    if (signal.aborted) return { id, level: "unknown", evidence: "打ち切られた", ...keep };
    const failureClass = error instanceof IntegrationError ? error.failureClass : "invalid_response";
    logLine("WARN", "setup-status", `本番の Strapi を読めない: ${failureClass}`);
    return { id, level: "unknown", evidence: `本番の Strapi を読めない（${failureClass}）`, ...keep };
  }

  // 3. slug で比べる。足りない = 公開、updatedAt が違う = 更新、余っている = 取り下げ
  const deployedBySlug = new Map(deployed.map((article) => [article.slug, article]));
  const publishedSlugs = new Set(published.map((article) => article.slug));
  const pending: PendingArticle[] = [];
  for (const article of published) {
    const live = deployedBySlug.get(article.slug);
    if (live && sameTime(live.updatedAt, article.updatedAt)) continue;
    pending.push({
      slug: article.slug,
      kind: live ? "更新" : "公開",
      since: Math.max(parseTime(article.publishedAt), parseTime(article.updatedAt)),
    });
  }
  // 取り下げの時刻は Strapi から取れないので、最初に見つけた時刻（前回の結果から引き継ぐ。無ければ今）から数える
  const firstSeen: Record<string, string> = {};
  for (const article of deployed) {
    if (publishedSlugs.has(article.slug)) continue;
    const seen = previousFirstSeen?.[article.slug] ?? toIsoJst(now);
    firstSeen[article.slug] = seen;
    pending.push({ slug: article.slug, kind: "取り下げ", since: parseTime(seen) });
  }
  const carry = Object.keys(firstSeen).length > 0 ? { firstSeen } : {};

  if (pending.length === 0) {
    return { id, level: "ok", evidence: `配信中のビルド ${builtAt} の記事 ${deployed.length} 件が、本番の Strapi の公開済みの記事と一致` };
  }

  // 古い順（猶予の期限が近い順）。同じ時刻なら slug の順
  pending.sort((a, b) => a.since - b.since || a.slug.localeCompare(b.slug));
  const overdue = pending.filter((entry) => now.getTime() - entry.since >= ARTICLE_GRACE_MS);
  const waiting = pending.filter((entry) => now.getTime() - entry.since < ARTICLE_GRACE_MS);
  if (overdue.length === 0) {
    const deadline = toIsoJst(new Date(waiting[0]!.since + ARTICLE_GRACE_MS));
    return {
      id,
      level: "ok",
      evidence: `配信待ち ${waiting.length} 件（猶予中。最も古いものの期限 ${deadline}）: ${listPending(waiting)}`,
      ...carry,
    };
  }
  const alsoWaiting = waiting.length > 0 ? `。ほかに猶予中が ${waiting.length} 件` : "";
  return {
    id,
    level: "action",
    evidence:
      `公開・更新・取り下げから 48 時間を過ぎても配信されていない記事が ${overdue.length} 件: ${listPending(overdue)}${alsoWaiting}。` +
      ARTICLE_FIX,
    ...carry,
  };
}
