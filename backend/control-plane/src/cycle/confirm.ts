// 「実行した」の後に、システムが結果を確かめる（spec 5.3 の表の右端の列）。
//   article:  Strapi の公開版の publishedAt が、下書きを取り込んだ後の時刻で入った
//   campaign: 記事の URL と配布ファイルの URL が公開サイトで 200、Mautic のメールとキャンペーンがどちらも isPublished
//   code:     GitHub で PR がマージされた（開いたままなら pending として executed のまま次回に確かめ直す）
//   deploy:   公開サイトの /_build.json の commit が項目と一致し、changes の URL が 200
//             （確かめたら kv の deployed-sha と「確かめた配信のスナップショット」を、この項目のものにする。Ruling 31）
//   manual:   常に ok（人の申告）
// 外部の設定が無いときは、その項目だけを確かめられない理由つきで返す（ジョブ全体は止めない）。
import type { EngineContext } from "../context.js";
import type { CycleItem } from "../contract.js";
import { DEPLOYED_SHA_KEY, SNAPSHOT_KEY, itemSnapshotKey } from "../builtin/published-article-check.js";
import { GitHubClient } from "../integrations/github.js";
import { IntegrationError } from "../integrations/http.js";
import { MauticReader } from "../integrations/mautic.js";
import { StrapiClient } from "../integrations/strapi.js";
import type { KvStore } from "../store/kv.js";
import { toIsoJst } from "../time.js";
import { articleBaseTime, isAtOrAfterBase, siteBase, withoutQuery } from "./urls.js";

const URL_CHECK_TIMEOUT_MS = 15_000;

export type ConfirmResult = { ok: true } | { ok: false; reason: string; pending?: boolean };

export interface ConfirmDeps {
  siteUrl: string | null;
  strapi: StrapiClient | null;
  mautic: MauticReader | null;
  github: GitHubClient | null;
  issueNumber: number | null;
  kv: Pick<KvStore, "get" | "set" | "delete">;
  signal: AbortSignal;
  /** URL の HTTP ステータス（届かなければ null）。既定は GET（テストで差し替える） */
  httpStatus?: (url: string, signal: AbortSignal) => Promise<number | null>;
  /** 公開サイトの /_build.json の commit（読めなければ null）。既定は GET（テストで差し替える） */
  buildCommit?: (siteUrl: string, signal: AbortSignal) => Promise<string | null>;
}

/** URL を GET してステータスだけを返す（本文は読まずに捨てる）。キャッシュを避けるため no-store */
export async function defaultHttpStatus(url: string, signal: AbortSignal): Promise<number | null> {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(URL_CHECK_TIMEOUT_MS)]),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status;
  } catch {
    return null;
  }
}

/** 公開サイトのビルドの印（dist/_build.json の commit）。CloudFront のキャッシュを避けるため問い合わせごとにクエリを変える */
export async function defaultBuildCommit(siteUrl: string, signal: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(`${siteBase(siteUrl)}/_build.json?t=${Date.now()}`, {
      cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(URL_CHECK_TIMEOUT_MS)]),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const data: unknown = await response.json();
    const commit = typeof data === "object" && data !== null ? (data as { commit?: unknown }).commit : null;
    return typeof commit === "string" ? commit : null;
  } catch {
    return null;
  }
}

/** 設定から確認に使う連携を組み立てる。設定が無い連携は null（その種類の項目だけが確かめられない） */
export function buildConfirmDeps(ctx: EngineContext, signal: AbortSignal): ConfirmDeps {
  const { config } = ctx;
  return {
    siteUrl: config.siteUrl,
    strapi: config.strapi ? new StrapiClient(config.strapi.baseUrl, config.strapi.readToken, null) : null,
    mautic: config.mautic ? new MauticReader(config.mautic, signal) : null,
    github: config.github ? new GitHubClient(config.github, signal) : null,
    issueNumber: config.github?.issueNumber ?? null,
    kv: ctx.kv,
    signal,
  };
}

function fail(reason: string): ConfirmResult {
  return { ok: false, reason };
}

/** URL のうち 200 を返さないもの */
async function notOk(urls: string[], deps: ConfirmDeps): Promise<string[]> {
  const status = deps.httpStatus ?? defaultHttpStatus;
  const bad: string[] = [];
  for (const url of urls) {
    if ((await status(url, deps.signal)) !== 200) bad.push(url);
  }
  return bad;
}

async function confirmArticle(item: CycleItem, deps: ConfirmDeps): Promise<ConfirmResult> {
  if (item.preview.kind !== "article") return fail("項目の中身がまだ無い");
  if (!deps.strapi) return fail("Strapi の読み取りの設定（CONTROL_STRAPI_URL・CONTROL_STRAPI_READ_TOKEN）が無いため確かめられない");
  const published = await deps.strapi.getArticle(item.preview.documentId, "published", deps.signal);
  if (!published?.publishedAt) return fail("記事の公開版が無い（まだ公開されていない）");
  // 既に公開済みの記事の書き直しでは、古い公開版の publishedAt が残っている。確認した下書き（項目を作ったときの下書きの updatedAt）
  // 以後の公開だけを数える（Ruling 35。項目の createdAt を基準にすると、集約より前に公開した記事が確かめられない）。
  // Strapi 5 の公開で下書きの updatedAt が進みうるため、基準から許容幅（BASE_TIME_TOLERANCE_MS）を引いて比べる
  if (!isAtOrAfterBase(published.publishedAt, articleBaseTime(item))) {
    return fail("公開版が、下書きを取り込む前の版のまま（書き直した版がまだ公開されていない）");
  }
  return { ok: true };
}

async function confirmCampaign(item: CycleItem, deps: ConfirmDeps): Promise<ConfirmResult> {
  if (item.preview.kind !== "campaign") return fail("項目の中身がまだ無い");
  const preview = item.preview;
  if (!deps.mautic) return fail("Mautic の読み取りの設定（CONTROL_MAUTIC_*）が無いため確かめられない");
  const unattached = preview.assets.filter((asset) => asset.url === null);
  if (unattached.length > 0) return fail(`配布ファイルが記事に結ばれていない（${unattached.length} 件）`);
  const bad = await notOk([withoutQuery(preview.linkUrl), ...preview.assets.map((asset) => asset.url!)], deps);
  if (bad.length > 0) return fail(`公開サイトで 200 を返さない URL がある（${bad.join("・")}）`);
  const [email, campaign] = [await deps.mautic.getEmail(preview.emailId), await deps.mautic.getCampaign(preview.campaignId)];
  if (!email) return fail(`Mautic にメール（id ${preview.emailId}）が無い`);
  if (!campaign) return fail(`Mautic にキャンペーン（id ${preview.campaignId}）が無い`);
  const unpublished = [email.isPublished ? null : "メール", campaign.isPublished ? null : "キャンペーン"].filter((x) => x !== null);
  if (unpublished.length > 0) return fail(`Mautic で ${unpublished.join("と")} がまだ公開されていない（両方を公開すると送信が始まる）`);
  return { ok: true };
}

async function confirmCode(item: CycleItem, deps: ConfirmDeps): Promise<ConfirmResult> {
  if (item.preview.kind !== "code") return fail("項目の中身がまだ無い");
  if (!deps.github || deps.issueNumber === null) return fail("GitHub の設定（GITHUB_TOKEN・I13_ISSUE_NUMBER など）が無いため確かめられない");
  const branch = `${deps.issueNumber}-feature-${item.preview.proposalId}`;
  const number = await deps.github.findPullRequest(branch);
  if (number === null) return fail(`ブランチ ${branch} の PR が見つからない`);
  const pull = await deps.github.getPullRequest(number);
  if (!pull) return fail(`PR #${number} が見つからない`);
  if (pull.merged) return { ok: true };
  if (pull.state === "closed") return fail(`PR #${number} がマージされずに閉じられた`);
  return { ok: false, reason: `PR #${number} はまだマージされていない（次の確認で確かめ直す）`, pending: true };
}

async function confirmDeploy(item: CycleItem, deps: ConfirmDeps): Promise<ConfirmResult> {
  if (item.preview.kind !== "deploy") return fail("項目の中身がまだ無い");
  const preview = item.preview;
  if (preview.blocked) return fail(`配信できない項目（${preview.blocked}）`);
  if (!deps.siteUrl) return fail("SITE_URL が無いため確かめられない");
  const commit = await (deps.buildCommit ?? defaultBuildCommit)(deps.siteUrl, deps.signal);
  if (commit === null) return fail("公開サイトの /_build.json を読めなかった");
  if (commit !== preview.commitSha) {
    return fail(`公開サイトの /_build.json のコミット（${commit.slice(0, 7)}）が項目のコミット（${preview.commitSha.slice(0, 7)}）と違う`);
  }
  const bad = await notOk(preview.changes, deps);
  if (bad.length > 0) return fail(`公開サイトで 200 を返さない記事の URL がある（${bad.join("・")}）`);
  // 配信を確かめたコミットと記事の一覧を残す（published-article-check が次に差分を作る基準。Ruling 31）。
  // 項目のスナップショットが無い（この仕組みの前に作った項目）ときは、記事の一覧の基準は変えない
  deps.kv.set(DEPLOYED_SHA_KEY, preview.commitSha);
  const snapshot = deps.kv.get(itemSnapshotKey(item.sourceRef));
  if (snapshot !== null) {
    deps.kv.set(SNAPSHOT_KEY, snapshot);
    deps.kv.delete(itemSnapshotKey(item.sourceRef));
  }
  return { ok: true };
}

/** 項目を確かめる。外部の失敗は理由つきの ok: false にする（例外にしない） */
export async function confirmItem(item: CycleItem, deps: ConfirmDeps): Promise<ConfirmResult> {
  try {
    switch (item.kind) {
      case "article":
        return await confirmArticle(item, deps);
      case "campaign":
        return await confirmCampaign(item, deps);
      case "code":
        return await confirmCode(item, deps);
      case "deploy":
        return await confirmDeploy(item, deps);
      case "manual":
        return { ok: true };
      case "proposal":
        return fail("改修案は GitHub の PR の承認とマージで進む（実行の確認は無い）");
    }
  } catch (error) {
    if (error instanceof IntegrationError) return { ok: false, reason: `確かめる途中で外部の呼び出しに失敗した（${error.failureClass}。次の確認で確かめ直す）`, pending: true };
    throw error;
  }
}

/**
 * executed の項目を確かめて、状態を進める（cycle-collect と画面の「実行した」が使う）。
 *   ok → confirmed（campaign はこの時点で反映済み）／ ok: false → failed_check（pending なら executed のまま理由だけ更新）
 * executed でない項目には何もしない。結果を返す。
 */
export async function confirmExecutedItem(ctx: EngineContext, item: CycleItem, deps: ConfirmDeps): Promise<ConfirmResult | null> {
  if (item.state !== "executed") return null;
  const result = await confirmItem(item, deps);
  if (result.ok) {
    if (ctx.cycles.transition(item.itemId, ["executed"], "confirmed", "確かめた") && item.kind === "campaign") {
      ctx.cycles.setReflected(item.itemId, toIsoJst());
    }
  } else if (result.pending) {
    ctx.cycles.transition(item.itemId, ["executed"], "executed", result.reason);
  } else {
    ctx.cycles.transition(item.itemId, ["executed"], "failed_check", result.reason);
  }
  return result;
}
