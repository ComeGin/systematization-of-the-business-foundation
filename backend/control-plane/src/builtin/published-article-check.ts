// 公開とマージの検知 → ビルドと計測 → deploy の項目（builtin `published-article-check`。spec 5.6、DD-05 の 3.2〜3.3）。
//
// 本番の Strapi の公開済みの記事の一覧を、最後に確かめた配信のスナップショット（kv）と比べ、新規・更新・消えた記事があるか、
// 最後に確かめた配信のコミットから frontend/verdant-virgo に変更があるときだけ、main のチェックアウトで `pnpm lh`（ビルド＋ Lighthouse CI）を動かす。
// 結果（コミット・dist のパス・Lighthouse の 4 指標・変更した記事の URL）を、周の deploy の項目（awaiting_review）にする。
// 配信（aws のコマンド）は人が行う。ここでは実行しない。
//
// 安全のための設計は checkout-job.ts と同じ（main のチェックアウトだけで動かす・HOME を分ける・env は許可リスト）。
//   - changes は「最後に確かめた配信」との差分（Ruling 31）。配信を待つ間に main が進んだり別の記事が公開されたりしても、
//     まだ配信を確かめていない記事が新しい項目の changes から落ちない。
//   - 項目を作ったときは、その項目のスナップショットを kv（item-snapshot:<sourceRef>）に結びつけて残す。
//     確かめた配信のスナップショット（snapshot）と deployed-sha は、ここでは書かない（deploy の項目の確認に成功したとき、確認の処理が写す）。
//   - sourceRef は deploy:<frontend/verdant-virgo を最後に変えたコミット>:<記事の一覧のハッシュ>。公開サイトに関係しないコミットで main が進んでも
//     sourceRef は変わらない（承認前の項目を毎晩ビルドし直して置き換えない。P1）。preview.commitSha は「ビルドした HEAD」（_build.json と照合するため）。
//   - 同じ差分（同じ sourceRef）の項目が既にあれば、どの状態でもビルドしない（配信を待つ間・差し戻した後に毎回ビルドしない）。
//   - 新しい項目を作ったら、承認前（preparing・awaiting_review）の古い deploy の項目を rejected にする。
//     承認の後（approved・executed・failed_check）の古い deploy の項目があるときは、新しい項目を作らずに見送る（人が実行中の配信を追い越さない）。
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { BuiltinHandler, RunResult } from "../context.js";
import { VERDANT_VIRGO_DIR } from "../constants/paths.js";
import type { CycleItem, CycleItemState } from "../contract.js";
import type { CycleStore } from "../store/cycles.js";
import { cycleOf } from "../cycle/calendar.js";
import { SYSTEM_ACTOR } from "../cycle/cycle-doc.js";
import { runGit } from "../cycle/git.js";
import { IntegrationError } from "../integrations/http.js";
import { type PublishedArticle, StrapiClient } from "../integrations/strapi.js";
import { logLine } from "../log.js";
import { toIsoJst } from "../time.js";
import {
  buildEnv,
  exists,
  isFreshResultFile,
  logChildFailure,
  runPnpmScript,
  withCheckoutBuildLease,
  withChildHome,
} from "./checkout-job.js";

/** 最後に確かめた配信のスナップショット（公開済みの記事の一覧）。deploy の項目の確認が通ったときに、その項目のスナップショットを写す */
export const SNAPSHOT_KEY = "published-article-check:snapshot";
/** 最後に確かめた配信のコミット。deploy の項目の確認が通ったときに書く */
export const DEPLOYED_SHA_KEY = "published-article-check:deployed-sha";
/** deploy の項目ごとの、項目を作った時点のスナップショット（キーの末尾は項目の sourceRef） */
const ITEM_SNAPSHOT_PREFIX = "published-article-check:item-snapshot:";

export function itemSnapshotKey(sourceRef: string): string {
  return `${ITEM_SNAPSHOT_PREFIX}${sourceRef}`;
}

/** 承認の後の（人が配信を進めている）deploy の項目の状態。これがあるあいだは新しい項目を作らない */
const IN_FLIGHT_STATES: readonly CycleItemState[] = ["approved", "executed", "failed_check"];
/** 新しい項目を作ったときに置き換える（rejected にする）、承認前の deploy の項目の状態 */
const REPLACEABLE_STATES: CycleItemState[] = ["preparing", "awaiting_review"];
/** dist の写しを消さない deploy の項目の状態（配信の対象になりうるもの） */
const LIVE_STATES: readonly CycleItemState[] = ["preparing", "awaiting_review", "approved", "executed", "failed_check"];

const SCRIPT = "lh";
const RESULT_DIR = ".lighthouse";
const MANIFEST = "manifest.json";
/** 配るための dist の写しの置き場（<dataDir>/deploy/<sha 12 桁>-<スナップショットのハッシュ 12 桁>/dist）。残すのは新しい順にこの件数 */
const DEPLOY_COPIES_DIR = "deploy";
const DEPLOY_COPY_NAME = /^[0-9a-f]{12}-[0-9a-f]{12}$/;
const KEEP_DEPLOY_COPIES = 3;

export interface Scores {
  performance: number;
  accessibility: number;
  bestPractices: number;
  seo: number;
}

export interface ArticleDiff {
  added: PublishedArticle[];
  updated: PublishedArticle[];
  removed: PublishedArticle[];
}

/** documentId の昇順にそろえる（スナップショットのハッシュを、Strapi の返す順に依らず安定させる） */
export function normalizeSnapshot(articles: PublishedArticle[]): PublishedArticle[] {
  return [...articles]
    .map(({ documentId, slug, publishedAt, updatedAt }) => ({ documentId, slug, publishedAt, updatedAt }))
    .sort((a, b) => (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0));
}

/** 前回との差。前回が無ければ（null）現在の記事すべてが新規。 */
export function diffArticles(previous: PublishedArticle[] | null, current: PublishedArticle[]): ArticleDiff {
  const before = new Map((previous ?? []).map((article) => [article.documentId, article]));
  const now = new Map(current.map((article) => [article.documentId, article]));
  const added: PublishedArticle[] = [];
  const updated: PublishedArticle[] = [];
  for (const article of current) {
    const old = before.get(article.documentId);
    if (!old) added.push(article);
    else if (old.updatedAt !== article.updatedAt || old.publishedAt !== article.publishedAt || old.slug !== article.slug) updated.push(article);
  }
  const removed = (previous ?? []).filter((article) => !now.has(article.documentId));
  return { added, updated, removed };
}

export function parseSnapshot(raw: string | null): PublishedArticle[] | null {
  if (raw === null) return null;
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return null;
    const out: PublishedArticle[] = [];
    for (const row of data) {
      if (typeof row !== "object" || row === null) return null;
      const { documentId, slug, publishedAt, updatedAt } = row as Record<string, unknown>;
      if (![documentId, slug, publishedAt, updatedAt].every((v) => typeof v === "string")) return null;
      out.push({ documentId, slug, publishedAt, updatedAt } as PublishedArticle);
    }
    return out;
  } catch {
    // 壊れたスナップショットは「前回なし」として扱う（全記事が新規になるだけで、取りこぼしは無い）
    return null;
  }
}

/**
 * Lighthouse CI の manifest.json から 4 指標を取る。
 * URL ごとの代表の実行（isRepresentativeRun。5 回の中央値）の、指標ごとの最小値を採る（1 ページでも SEO が落ちたら配信を止めるため）。
 * 代表の実行が 1 つも無ければ、全実行の中央値。取れなければ null。
 */
export function scoresFromManifest(manifest: unknown): Scores | null {
  if (!Array.isArray(manifest)) return null;
  type Entry = { representative: boolean; summary: Record<string, number> };
  const entries: Entry[] = [];
  for (const row of manifest) {
    if (typeof row !== "object" || row === null) continue;
    const { isRepresentativeRun, summary } = row as { isRepresentativeRun?: unknown; summary?: unknown };
    if (typeof summary !== "object" || summary === null) continue;
    const s = summary as Record<string, unknown>;
    if (!["performance", "accessibility", "best-practices", "seo"].every((k) => typeof s[k] === "number")) continue;
    entries.push({ representative: isRepresentativeRun === true, summary: s as Record<string, number> });
  }
  if (entries.length === 0) return null;
  const representative = entries.filter((entry) => entry.representative);
  const pick = (key: string): number => {
    if (representative.length > 0) return Math.min(...representative.map((entry) => entry.summary[key]!));
    const sorted = entries.map((entry) => entry.summary[key]!).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  };
  return {
    performance: pick("performance"),
    accessibility: pick("accessibility"),
    bestPractices: pick("best-practices"),
    seo: pick("seo"),
  };
}

/** main のチェックアウトの HEAD（40 桁）。シェルを通さず、env を最小にしてフックを止めた git で読む（Ruling 20） */
async function headSha(checkout: string, signal: AbortSignal): Promise<string | null> {
  const result = await runGit(checkout, ["rev-parse", "HEAD"], { timeoutMs: 10_000, signal });
  const sha = result.stdout.trim();
  return result.ok && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * 最後に確かめた配信のコミットから、公開サイトのコード（frontend/verdant-virgo）が変わったか（Ruling 31）。
 * まだ配信を確かめていない・同じコミット・差分を読めない（配信のコミットがチェックアウトに無いなど）ときの扱い:
 *   配信を確かめていない → 変わった／同じコミット → 変わっていない／読めない → 変わった（取りこぼさない側に倒す）
 */
async function verdantVirgoChanged(checkout: string, deployedSha: string | null, head: string, signal: AbortSignal): Promise<boolean> {
  if (deployedSha === null) return true;
  if (deployedSha === head) return false;
  if (!/^[0-9a-f]{40}$/.test(deployedSha)) return true;
  const result = await runGit(checkout, ["diff", "--name-only", deployedSha, head, "--", VERDANT_VIRGO_DIR], { timeoutMs: 30_000, signal });
  return !result.ok || result.stdout.trim() !== "";
}

/**
 * 公開サイトのコード（frontend/verdant-virgo）を最後に変えたコミット（40 桁）。sourceRef の commit の部分に使う（P1）。
 * 読めなければ（履歴が浅いなど）HEAD にする（無関係なコミットで置き換わることはあるが、取りこぼさない側に倒す）
 */
async function lastCodeCommit(checkout: string, head: string, signal: AbortSignal): Promise<string> {
  const result = await runGit(checkout, ["log", "-1", "--format=%H", "HEAD", "--", VERDANT_VIRGO_DIR], { timeoutMs: 30_000, signal });
  const sha = result.stdout.trim();
  return result.ok && /^[0-9a-f]{40}$/.test(sha) ? sha : head;
}

/**
 * ビルドした dist/ を、配るための置き場へ写す。main のチェックアウトの dist/ は、配信を待つ間に weekly-lighthouse・weekly-a11y の
 * astro build（Strapi の接続先もコミットの印も無い）が作り直すため、そのまま配ると公開記事を消しうる（--delete 付きの sync）。
 * シンボリックリンクはたどらずそのまま写し（dereference: false）、写した先の _build.json の commit が head と一致するときだけ、その絶対パスを返す。
 * 一致しなければ写しを消して null。
 */
async function copyDistForDelivery(options: { sourceDist: string; dataDir: string; refDir: string; head: string }): Promise<string | null> {
  const root = join(options.dataDir, DEPLOY_COPIES_DIR);
  const copyDir = join(root, options.refDir);
  const target = join(copyDir, "dist");
  if (!(await lstat(options.sourceDist)).isDirectory()) return null;
  await mkdir(root, { recursive: true, mode: 0o700 });
  // 同じ名前（同じコミット・同じ記事の一覧）の古い写しがあれば、作り直す
  await rm(copyDir, { recursive: true, force: true });
  await mkdir(copyDir, { mode: 0o700 });
  await cp(options.sourceDist, target, { recursive: true, dereference: false, errorOnExist: true, force: false });
  try {
    const mark: unknown = JSON.parse(await readFile(join(target, "_build.json"), "utf8"));
    if (typeof mark === "object" && mark !== null && (mark as { commit?: unknown }).commit === options.head) return target;
  } catch {
    // 読めない・JSON でない: 下で消して null
  }
  await rm(copyDir, { recursive: true, force: true });
  return null;
}

/** deploy の項目の dist の写しのディレクトリ名（<dataDir>/deploy/<名前>/dist の <名前>）。形が違えば null */
function copyNameOf(item: CycleItem): string | null {
  if (item.preview.kind !== "deploy") return null;
  const name = basename(dirname(item.preview.distPath));
  return DEPLOY_COPY_NAME.test(name) ? name : null;
}

/**
 * 古い写しを消す。残すのは keep（今回の写し）・配信の対象になりうる deploy の項目（LIVE_STATES）が指す写しと、
 * それ以外は新しい順に合わせて KEEP_DEPLOY_COPIES 件まで。消すのは deploy/ の直下の、決まった形の名前のディレクトリだけ。
 */
async function pruneDeployCopies(dataDir: string, keep: string, referenced: ReadonlySet<string>): Promise<void> {
  const root = join(dataDir, DEPLOY_COPIES_DIR);
  const entries = await readdir(root, { withFileTypes: true });
  const copies: { name: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    // Dirent.isDirectory() はシンボリックリンクを false にする（たどらない）
    if (!entry.isDirectory() || !DEPLOY_COPY_NAME.test(entry.name)) continue;
    copies.push({ name: entry.name, mtimeMs: (await stat(join(root, entry.name))).mtimeMs });
  }
  const newest = copies.sort((a, b) => b.mtimeMs - a.mtimeMs).map((copy) => copy.name);
  const kept = new Set([keep, ...referenced]);
  for (const name of newest) {
    if (kept.size >= KEEP_DEPLOY_COPIES) break;
    kept.add(name);
  }
  for (const name of newest) {
    if (!kept.has(name)) await rm(join(root, name), { recursive: true, force: true });
  }
}

/**
 * 項目の sourceRef を決める。base（deploy:<HEAD>:<スナップショットのハッシュ>）の項目が無ければ base。
 * 同じ sourceRef の項目があれば、どの状態でも作り直さない（配信を待つ間・人が差し戻した後に毎回ビルドしない）。
 * ただし、それが置き換えられた（rejected）か確かめ済み（confirmed）で、より新しい deploy の項目があるときは、
 * 「前と同じ差分に戻った」ので、base:<n> の形の別の sourceRef で作る。
 */
function resolveSourceRef(cycles: CycleStore, base: string): { sourceRef: string } | { existing: CycleItem } {
  const latest = cycles.latestItemOfKind("deploy");
  for (let n = 1; ; n++) {
    const ref = n === 1 ? base : `${base}:${n}`;
    const found = cycles.findItem("deploy", ref);
    if (!found) return { sourceRef: ref };
    const superseded = (found.state === "rejected" || found.state === "confirmed") && latest !== null && latest.itemId !== found.itemId;
    if (!superseded) return { existing: found };
  }
}

/** 承認の後の（人が配信を進めている）deploy の項目のうち、sourceRef が違うもの。あれば新しい項目を作らない */
function inFlightDeploy(cycles: CycleStore, sourceRef: string): CycleItem | null {
  return cycles.listItemsByKind("deploy", [...IN_FLIGHT_STATES]).find((item) => item.sourceRef !== sourceRef) ?? null;
}

function inFlightSkip(item: CycleItem): RunResult {
  const sha = item.preview.kind === "deploy" ? item.preview.commitSha.slice(0, 7) : item.sourceRef;
  // failed_check は人が差し戻すまで残る。残るあいだは新しい項目を作らない。差し戻さずに「実行した」を押し直せば同じ差分を配信し直せる。
  // 差し戻した後は、差分が変わらなければ作らない（同じ sourceRef の項目は最新なら再ビルドしない）。これを理由に出す（P2。画面の手順にも同じ案内が出る）
  const next =
    item.state === "failed_check"
      ? "この項目は確かめられなかった（failed_check）。同じ差分を配信し直すなら、差し戻さずに（failed_check のまま）この項目で「実行した」を押し直す。差し戻した場合は、新しい記事の公開か公開サイト（frontend/verdant-virgo）の変更があったときだけ、次の夜に新しい配信の項目が作られる（変更が無いあいだは作られない）。"
      : "確かめ終えるか差し戻すと、次の実行で作る";
  return skipped(`人が進めている配信（${sha}。${item.state}）があるため、新しい deploy の項目を作らない。${next}`);
}

function skipped(reason: string): RunResult {
  return { outcome: "skipped", summary: `公開された記事の確認を見送った（${reason}）`, targetIds: [], skipReason: reason };
}

function countsText(diff: ArticleDiff): string {
  return `新規 ${diff.added.length}・更新 ${diff.updated.length}・削除 ${diff.removed.length}`;
}

export const publishedArticleCheck: BuiltinHandler = async ({ ctx, runId, signal, timeoutSec }): Promise<RunResult> => {
  const { config, kv, cycles } = ctx;
  if (!config.strapi) return skipped("CONTROL_STRAPI_URL・CONTROL_STRAPI_READ_TOKEN が無い");
  if (!config.siteUrl) return skipped("SITE_URL が無い");
  // 周を決められないなら、ビルドしても項目を置く場所が無い。ビルドの前に見送る
  const cycleAnchor = config.cycleAnchor;
  if (!cycleAnchor) return skipped("CONTROL_CYCLE_ANCHOR が無い");
  const siteUrl = config.siteUrl;
  const strapi = config.strapi;

  const cwd = join(config.mainCheckout, VERDANT_VIRGO_DIR);
  if (!(await exists(join(cwd, "node_modules")))) return skipped("dependencies not installed。main のチェックアウトで pnpm install が要る");

  const head = await headSha(config.mainCheckout, signal);
  if (!head) {
    return { outcome: "failure", summary: "main のチェックアウトの HEAD を読めなかった", targetIds: [], failureClass: "invalid_response" };
  }

  const client = new StrapiClient(config.strapi.baseUrl, config.strapi.readToken, config.strapi.writeToken);
  let published: PublishedArticle[];
  try {
    published = normalizeSnapshot(await client.listPublishedArticles(signal));
  } catch (error) {
    if (error instanceof IntegrationError) {
      return { outcome: "failure", summary: `Strapi の公開済みの記事を読めなかった（${error.failureClass}）`, targetIds: [], failureClass: error.failureClass };
    }
    throw error;
  }

  // 差分は「最後に確かめた配信」との比較（Ruling 31）。配信を確かめるまで、前の項目の記事も changes に残り続ける
  const diff = diffArticles(parseSnapshot(kv.get(SNAPSHOT_KEY)), published);
  const articlesChanged = diff.added.length + diff.updated.length + diff.removed.length > 0;
  const codeChanged = await verdantVirgoChanged(config.mainCheckout, kv.get(DEPLOYED_SHA_KEY), head, signal);
  if (!articlesChanged && !codeChanged) {
    return { outcome: "success", summary: "最後に確かめた配信と同じ記事の一覧で、公開サイトのコードにも変更が無いため、何もしなかった", targetIds: [] };
  }

  const snapshotJson = JSON.stringify(published);
  // sourceRef の commit は「公開サイトのコードを最後に変えたコミット」（P1）。ビルドは今の HEAD で行う
  const codeCommit = await lastCodeCommit(config.mainCheckout, head, signal);
  const resolved = resolveSourceRef(cycles, `deploy:${codeCommit}:${createHash("sha256").update(snapshotJson).digest("hex").slice(0, 12)}`);
  if ("existing" in resolved) {
    return { outcome: "success", summary: `この差分の deploy の項目は作成済み（${resolved.existing.state}）のため、ビルドしなかった`, targetIds: [] };
  }
  const { sourceRef } = resolved;
  // 人が進めている配信を追い越さない（ビルドの前に見る。ビルドの後にもう一度見る）
  const inFlight = inFlightDeploy(cycles, sourceRef);
  if (inFlight) return inFlightSkip(inFlight);

  return withCheckoutBuildLease(ctx.leases, runId, timeoutSec, async () => {
    const startedAt = Date.now();
    const run = await withChildHome(config.agentHome, "comegin-deploy-build-", (home) =>
      runPnpmScript({
        cwd,
        script: SCRIPT,
        env: buildEnv(home, {
          siteUrl,
          strapiUrl: strapi.baseUrl,
          strapiReadToken: strapi.readToken,
          commitSha: head,
        }),
        timeoutSec,
        signal,
      }),
    );
    if (run.timedOut || signal.aborted || run.code === -1) {
      logChildFailure("published-article-check", SCRIPT, run, runId);
      return {
        outcome: "failure",
        summary: run.timedOut ? "配信用のビルドと計測がタイムアウトした" : "配信用のビルドと計測を起動できなかった・停止された",
        targetIds: [],
        failureClass: run.timedOut || signal.aborted ? "timeout" : "unreachable",
      };
    }

    // lhci autorun は、しきい値の検査（assert）が落ちても結果を書いてから終了コード 1 で終わる。
    // 終了コードが 0 でなくても、今回書かれた manifest があれば 4 指標を読む（ビルドが落ちたときは manifest が古いので読まない）
    const manifestPath = join(cwd, RESULT_DIR, MANIFEST);
    let scores: Scores | null = null;
    if (await isFreshResultFile(manifestPath, startedAt)) {
      try {
        scores = scoresFromManifest(JSON.parse(await readFile(manifestPath, "utf8")));
      } catch {
        scores = null;
      }
    }
    const sourceDist = join(cwd, "dist");
    if (!scores || !(await exists(sourceDist))) {
      logChildFailure("published-article-check", SCRIPT, run, runId);
      return {
        outcome: "failure",
        summary: run.code === 0 ? "ビルドは終わったが、Lighthouse の結果か dist/ が見つからなかった" : `配信用のビルドと計測が終了コード ${run.code} で失敗した`,
        targetIds: [],
        failureClass: "invalid_response",
      };
    }

    // 配信を待つ間に dist/ が作り直されても配る中身が変わらないよう、写しを作ってそちらを配信の対象にする
    const refDir = `${head.slice(0, 12)}-${sourceRef.split(":")[2]}`;
    let distPath: string | null = null;
    try {
      distPath = await copyDistForDelivery({ sourceDist, dataDir: config.dataDir, refDir, head });
    } catch (error) {
      logLine("WARN", "published-article-check", `dist の写しに失敗: ${error instanceof Error ? error.message : String(error)}`, runId);
    }
    if (!distPath) {
      return {
        outcome: "failure",
        summary: "配信用の dist の写しを作れなかった（写せなかったか、写しの _build.json のコミットが main の HEAD と一致しない）",
        targetIds: [],
        failureClass: "invalid_response",
      };
    }

    const cycle = cycleOf(new Date(), cycleAnchor);
    const base = siteUrl.replace(/\/+$/, "");
    const changes = [...diff.added, ...diff.updated].map((article) => `${base}/blog/${article.slug}/`).sort();
    const blocked = scores.seo < 1 ? `SEO が ${scores.seo}（1.0 未満）のため、配信の手順を出さない` : null;
    const summary = [
      `記事（最後に確かめた配信から）: ${countsText(diff)}`,
      codeChanged ? "公開サイトのコードの変更を含む（最後に確かめた配信から frontend/verdant-virgo が変わった）" : "コードの変更なし",
      run.code !== 0 ? `Lighthouse のしきい値未達あり（終了コード ${run.code}）` : null,
    ]
      .filter((line) => line !== null)
      .join("。");

    // ここから項目の作成・古い項目の置き換えまでは await を挟まない（同じプロセスの画面の承認と入れ違わないように）。
    // ビルドの間に人が古い項目を OK にしていたら、新しい項目は作らない
    const inFlightNow = inFlightDeploy(cycles, sourceRef);
    if (inFlightNow) return inFlightSkip(inFlightNow);
    cycles.openCycle(cycle.cycleId, cycle.startsAt, cycle.endsAt, false);
    const created = cycles.upsertItem({
      cycleId: cycle.cycleId,
      kind: "deploy",
      stage: "deploy",
      sourceRef,
      proposalId: null,
      title: `配信: ${head.slice(0, 7)}`,
      summary,
      evidence: [],
      preview: { kind: "deploy", commitSha: head, distPath, lighthouse: scores, changes, blocked },
      state: "awaiting_review",
    });
    // 項目のスナップショット。確認が通ったら、確認の処理が「確かめた配信のスナップショット」に写す
    kv.set(itemSnapshotKey(sourceRef), snapshotJson);
    // 承認前の古い deploy の項目は、この項目に置き換える（古い項目を承認して新しい記事を --delete で消さないため）
    let replaced = 0;
    for (const old of cycles.listItemsByKind("deploy", REPLACEABLE_STATES)) {
      if (old.itemId === created.itemId) continue;
      // 置き換えの差し戻しは actor を system にして記録する（docs/cycles の差し戻しの節から除くため。P4）
      const reason = `新しい配信 ${head.slice(0, 7)} に置き換えた`;
      if (
        cycles.transitionWithApproval(old.itemId, REPLACEABLE_STATES, "rejected", reason, {
          itemId: old.itemId,
          action: "reject",
          actor: SYSTEM_ACTOR,
          checked: [],
          reason,
          at: toIsoJst(),
        })
      ) {
        kv.delete(itemSnapshotKey(old.sourceRef));
        replaced++;
      }
    }
    // 古い写しの掃除は項目を作った後（失敗しても項目は有効）。配信の対象になりうる項目の写しは消さない
    const referenced = new Set(
      cycles
        .listItemsByKind("deploy", [...LIVE_STATES])
        .map(copyNameOf)
        .filter((name): name is string => name !== null),
    );
    await pruneDeployCopies(config.dataDir, refDir, referenced).catch((error: unknown) =>
      logLine("WARN", "published-article-check", `古い dist の写しの掃除に失敗: ${error instanceof Error ? error.message : String(error)}`, runId),
    );

    return {
      outcome: "success",
      summary: `deploy の項目を作った（${head.slice(0, 7)}。${countsText(diff)}。SEO ${scores.seo}${blocked ? "。配信を止める" : ""}${replaced > 0 ? `。承認前の古い配信の項目 ${replaced} 件を置き換えた` : ""}）`,
      targetIds: [],
    };
  });
};
