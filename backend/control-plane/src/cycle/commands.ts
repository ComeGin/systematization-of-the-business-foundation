// deploy の項目に出す配信のコマンド（cloud/README.md の 4.14 の「同期 → 無効化」と同じ順）。
// 出すだけで、control-plane は実行しない（aws sso login はブラウザでの人の操作が要り、配信は人が行う。spec 5.6）。
// 値は設定（CONTROL_DEPLOY_*）と dist のパスで、シェルに渡る文字列なので、安全な文字だけを許す。
import type { CycleItem } from "../contract.js";
import { articlePublicUrl, deployConfirmedUrls, withoutQuery } from "./urls.js";

export interface DeployCommandsInput {
  /** ビルドした dist/ の絶対パス（末尾の / は付けても付けなくてもよい） */
  distPath: string;
  bucket: string;
  distributionId: string;
  awsProfile: string;
}

const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/;
const SAFE_PATH = /^\/[A-Za-z0-9._\-/@+~]+$/;

function check(name: string, value: string, pattern: RegExp): void {
  if (!pattern.test(value)) throw new Error(`${name} に使えない文字がある（シェルに渡るため）`);
}

/** 4 本のコマンド。1 本目は SSO のログイン、2 本目は _astro の長期キャッシュ、3 本目はそれ以外（--delete はこの 1 本だけ）、4 本目は無効化。 */
export function deployCommands(input: DeployCommandsInput): string[] {
  check("バケット名", input.bucket, SAFE_TOKEN);
  check("ディストリビューション ID", input.distributionId, SAFE_TOKEN);
  check("aws のプロファイル", input.awsProfile, SAFE_TOKEN);
  check("dist のパス", input.distPath, SAFE_PATH);
  const dist = input.distPath.replace(/\/+$/, "");
  const { bucket, distributionId, awsProfile: profile } = input;
  return [
    `aws sso login --profile ${profile}`,
    `aws s3 sync "${dist}/" s3://${bucket} --exclude '*' --include '_astro/*' --cache-control 'public,max-age=31536000,immutable' --profile ${profile}`,
    `aws s3 sync "${dist}/" s3://${bucket} --exclude '_astro/*' --delete --cache-control 'public,max-age=0,must-revalidate' --profile ${profile}`,
    `aws cloudfront create-invalidation --distribution-id ${distributionId} --paths '/*' --profile ${profile}`,
  ];
}

// ---- 項目の種類ごとの「OK の後に表示する手順」（spec 5.3 の表） ----
// 手順は画面に出すだけで、control-plane は実行しない。コマンドは人が自分の端末で実行する。
// エージェントが書いた値（題・ファイル名）をコマンドに埋めるので、許す文字を絞り、単一引用符で囲む。

export interface CycleStep {
  text: string;
  /** コピーできるコマンド。人が画面で行う操作なら null */
  command: string | null;
}

export interface StepsContext {
  siteUrl: string | null;
  /** 本番の Strapi の管理画面（`${strapi.baseUrl}/admin`。Ruling 2） */
  strapiAdminUrl: string | null;
  /** 本番の Mautic の管理画面（`${mautic.baseUrl}/s`。Ruling 2） */
  mauticAdminUrl: string | null;
  deploy: { bucket: string; distributionId: string; awsProfile: string } | null;
  worktree: string;
  issueNumber: number | null;
  /** 確かめ済みの deploy に含まれる記事の URL（campaign の ③ を出す条件） */
  deployConfirmedUrls: Set<string>;
}

/** 設定と項目から StepsContext を組み立てる（画面と cycle-collect が同じものを使う） */
export function buildStepsContext(
  config: {
    siteUrl: string | null;
    strapi: { baseUrl: string } | null;
    mautic: { baseUrl: string } | null;
    deploy: StepsContext["deploy"];
    worktree: string;
    github: { issueNumber: number } | null;
  },
  items: readonly CycleItem[],
): StepsContext {
  return {
    siteUrl: config.siteUrl,
    strapiAdminUrl: config.strapi ? `${config.strapi.baseUrl}/admin` : null,
    mauticAdminUrl: config.mautic ? `${config.mautic.baseUrl}/s` : null,
    deploy: config.deploy,
    worktree: config.worktree,
    issueNumber: config.github?.issueNumber ?? null,
    deployConfirmedUrls: deployConfirmedUrls(items),
  };
}

/** 単一引用符で囲む（中の ' は '\'' にする）。改行・制御文字は空白にする */
export function shellQuote(value: string): string {
  const flat = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ");
  return `'${flat.replace(/'/g, `'\\''`)}'`;
}

/** 作業ツリーの中の相対パスとして許すもの（.. を含まない・先頭が / でない・frontend/verdant-virgo の下） */
const CODE_FILE = /^[A-Za-z0-9._\-/@+~[\]]+$/;
export function isSafeCodeFile(path: string): boolean {
  return CODE_FILE.test(path) && !path.startsWith("/") && !path.split("/").includes("..") && path.startsWith("frontend/verdant-virgo/");
}

const COMMIT_TITLE_MAX = 72;

function strapiArticleAdmin(ctx: StepsContext, documentId: string): string | null {
  return ctx.strapiAdminUrl ? `${ctx.strapiAdminUrl}/content-manager/collection-types/api::article.article/${encodeURIComponent(documentId)}` : null;
}

function coverStep(ctx: StepsContext, documentId: string, fileId: number | null | undefined): CycleStep[] {
  if (typeof fileId !== "number") return [];
  const admin = strapiArticleAdmin(ctx, documentId);
  return [
    {
      text: `表紙に結ぶ: Strapi の管理画面で記事の下書きを開き、cover にメディアライブラリのファイル（id ${fileId}。article-cover が上げた画像、または公開版の cover）を選んで保存する${admin ? `（${admin}）` : ""}`,
      command: null,
    },
  ];
}

function appliedAtSteps(item: CycleItem): CycleStep[] {
  if (!item.proposalId || !item.reflectedAt) return [];
  return [
    {
      text: `反映を確かめた。docs/proposals/${item.proposalId}.md の applied_at に "${item.reflectedAt}" を書き、PR で残す（記録は配信した人。ADR-16）`,
      command: null,
    },
  ];
}

function articleSteps(item: CycleItem, ctx: StepsContext): CycleStep[] {
  if (item.preview.kind !== "article") return [];
  const { documentId, slug } = item.preview;
  const admin = strapiArticleAdmin(ctx, documentId);
  const url = ctx.siteUrl && slug ? articlePublicUrl(ctx.siteUrl, slug) : null;
  return [
    ...coverStep(ctx, documentId, item.preview.coverPendingFileId),
    {
      text: `Strapi の管理画面で記事を公開する${admin ? `（${admin}）` : "（CONTROL_STRAPI_URL が無いため管理画面の URL を出せない）"}。公開の前に、本文・description・アイキャッチ・内部リンクが確認したものと同じかを見る`,
      command: null,
    },
    {
      text: `公開の後、配信（deploy の項目）を待つ。配信を確かめると反映済みになる${url ? `（公開後の URL: ${url}）` : ""}`,
      command: null,
    },
    ...appliedAtSteps(item),
  ];
}

function campaignSteps(item: CycleItem, ctx: StepsContext): CycleStep[] {
  if (item.preview.kind !== "campaign") return [];
  const preview = item.preview;
  const admin = strapiArticleAdmin(ctx, preview.articleDocumentId);
  const articleUrl = withoutQuery(preview.linkUrl);
  const steps: CycleStep[] = [...coverStep(ctx, preview.articleDocumentId, preview.coverPendingFileId)];
  // segmentCount が負のときは件数を読めなかった（Mautic の統計を読めない）
  const count = preview.segmentCount < 0 ? "件数不明" : `${preview.segmentCount} 件`;
  if (preview.segmentCount < 0) {
    steps.push({ text: `送信先のセグメント「${preview.segmentName}」の件数を読めなかった。Mautic で件数を確かめてから公開する`, command: null });
  }
  if (preview.segmentCount === 0) {
    steps.push({
      text: `送信先のセグメント「${preview.segmentName}」が 0 件。Mautic でセグメントを作る・条件を直す（エージェントはセグメントを作らない。spec 5.11 の 3）`,
      command: null,
    });
  }
  for (const asset of preview.assets.filter((a) => a.url === null)) {
    steps.push({
      text: `配布ファイル「${asset.name}」が記事にまだ結ばれていない。campaign-asset-upload の実行を待つか、Strapi の管理画面で記事の下書きの末尾に media ブロックを足して結ぶ${admin ? `（${admin}）` : ""}`,
      command: null,
    });
  }
  steps.push(
    {
      text: `① Strapi の管理画面でキャンペーンの記事を公開する${admin ? `（${admin}）` : "（CONTROL_STRAPI_URL が無いため管理画面の URL を出せない）"}`,
      command: null,
    },
    {
      text: `② 配信（deploy の項目）を待つ。配信を確かめて、公開サイトで ${articleUrl} が出るまで ③ は表示しない`,
      command: null,
    },
  );
  if (ctx.deployConfirmedUrls.has(articleUrl)) {
    const email = ctx.mauticAdminUrl ? `${ctx.mauticAdminUrl}/emails/view/${preview.emailId}` : `メール id ${preview.emailId}`;
    const campaign = ctx.mauticAdminUrl ? `${ctx.mauticAdminUrl}/campaigns/view/${preview.campaignId}` : `キャンペーン id ${preview.campaignId}`;
    steps.push({
      text: `③ Mautic でメールとキャンペーンを両方公開する（メール: ${email}／キャンペーン: ${campaign}）。メールだけを公開しても送られない。キャンペーンを公開した時点で、セグメント「${preview.segmentName}」（${count}）への送信が始まる`,
      command: null,
    });
  }
  steps.push(...appliedAtSteps(item));
  return steps;
}

function codeSteps(item: CycleItem, ctx: StepsContext): CycleStep[] {
  if (item.preview.kind !== "code") return [];
  const { proposalId, files } = item.preview;
  if (!SAFE_PATH.test(ctx.worktree)) {
    return [{ text: "作業場（CONTROL_WORKTREE）のパスに使えない文字があるため、コマンドを出せない", command: null }];
  }
  const worktree = shellQuote(ctx.worktree);
  const app = shellQuote(`${ctx.worktree}/frontend/verdant-virgo`);
  const safeFiles = files.filter(isSafeCodeFile);
  const steps: CycleStep[] = [
    { text: "作業場で公開サイトをビルドして Lighthouse を測る（SEO が 1.0 か）", command: `cd ${app} && pnpm lh` },
    { text: "作業場で a11y の自動検査を行う（重大〈serious 以上〉の違反が 0 か）", command: `cd ${app} && pnpm a11y:ci` },
  ];
  if (ctx.issueNumber === null) {
    steps.push({ text: "Issue 番号（I13_ISSUE_NUMBER）が無いため、ブランチ名を決められない。Issue を決めてから手でブランチを作る", command: null });
    return [...steps, ...appliedAtSteps(item)];
  }
  const branch = `${ctx.issueNumber}-feature-${proposalId}`;
  const title = Array.from(item.title.replace(/\s+/g, " ").trim()).slice(0, COMMIT_TITLE_MAX).join("");
  steps.push({ text: `ブランチ ${branch} を origin/main から作る（作業場の差分はそのまま持ち越す）`, command: `cd ${worktree} && git fetch origin && git switch -c ${branch} origin/main` });
  if (safeFiles.length === 0) {
    steps.push({ text: "項目のファイルが無い（または使えない文字を含む）ため、git add のコマンドを出せない。差分を見て手で add する", command: null });
  } else {
    steps.push({ text: "項目のファイルだけを add する", command: `cd ${worktree} && git add -- ${safeFiles.map(shellQuote).join(" ")}` });
  }
  if (safeFiles.length < files.length) {
    steps.push({ text: `${files.length - safeFiles.length} 件のファイルは、パスに使えない文字があるか公開サイトの外のため手順に含めなかった`, command: null });
  }
  steps.push(
    { text: "コミットする", command: `cd ${worktree} && git commit -m ${shellQuote(`mod: ${title}`)}` },
    {
      text: "push して PR を作る（PR がマージされると確かめられる）",
      command: `cd ${worktree} && git push -u origin ${branch} && gh pr create --base main --head ${branch} --title ${shellQuote(`mod: ${title}`)} --body ${shellQuote(`改善提案 ${proposalId} の差分（改善ループの code の項目）`)}`,
    },
    {
      // cycle-open は名前のあるブランチにいる作業場を合わせない（Ruling 34）。戻さないと次の周の作業場が古いまま
      text: "PR を作ったら、作業場を origin/main に戻す（ブランチにいる間は、周の始まりに作業場を合わせない）",
      command: `cd ${worktree} && git switch --detach origin/main`,
    },
    ...appliedAtSteps(item),
  );
  return steps;
}

const PROPOSAL_ID_IN_TEXT = /PRP-\d{4}-\d{4}/g;

/** failed_check の deploy の項目に出す案内（P2）。差し戻さないと、新しい配信の項目が作られない */
const DEPLOY_FAILED_CHECK_NOTE =
  "同じ差分を配信し直すなら、差し戻さずに（failed_check のまま）この項目で「実行した」を押し直す。差し戻した場合は、新しい記事の公開か公開サイト（frontend/verdant-virgo）の変更があったときだけ、次の夜に新しい配信の項目が作られる（変更が無いあいだは作られない）。この項目が残るあいだは、新しい配信の項目は作られない";

function deploySteps(item: CycleItem, ctx: StepsContext): CycleStep[] {
  const steps = deployStepsBody(item, ctx);
  return item.state === "failed_check" && item.preview.kind === "deploy" ? [{ text: DEPLOY_FAILED_CHECK_NOTE, command: null }, ...steps] : steps;
}

function deployStepsBody(item: CycleItem, ctx: StepsContext): CycleStep[] {
  if (item.preview.kind !== "deploy") return [];
  const preview = item.preview;
  if (preview.blocked) return [{ text: `配信できない: ${preview.blocked}`, command: null }];
  if (!ctx.deploy) {
    return [{ text: "配信の設定（CONTROL_DEPLOY_BUCKET・CONTROL_DEPLOY_DISTRIBUTION_ID・CONTROL_DEPLOY_AWS_PROFILE）が無いため、コマンドを出せない", command: null }];
  }
  let commands: string[];
  try {
    commands = deployCommands({ distPath: preview.distPath, ...ctx.deploy });
  } catch (error) {
    return [{ text: `配信のコマンドを組み立てられない（${error instanceof Error ? error.message : "不明"}）`, command: null }];
  }
  const labels = [
    "配信の主体で SSO にログインする（ブラウザが開く）",
    "_astro/ の下を長期キャッシュで同期する（先に）",
    "それ以外を同期し、無くなったファイルを消す（後で。--delete はこの 1 本だけ）",
    "CloudFront のキャッシュを無効化する",
  ];
  const steps: CycleStep[] = commands.map((command, index) => ({ text: labels[index] ?? "", command }));
  // 確かめた後: 含まれる E-13 の applied_at を記録する（確認のときに理由へ書いた proposal_id。spec 5.6）
  const included = item.state === "confirmed" ? [...new Set(item.stateReason?.match(PROPOSAL_ID_IN_TEXT) ?? [])] : [];
  steps.push({
    text:
      included.length > 0
        ? `配信を確かめた後、含まれる E-13 の applied_at を記録する: ${included.map((id) => `docs/proposals/${id}.md`).join("・")} の applied_at に "${item.updatedAt}" を書き、PR で残す（記録は配信した人。ADR-16）`
        : "配信を確かめた後、この配信で反映済みになった E-13（画面の各項目に出る）の docs/proposals/<proposal_id>.md の applied_at に配信を確かめた時刻を書き、PR で残す（記録は配信した人。ADR-16）",
    command: null,
  });
  return steps;
}

/**
 * 差し戻した code の項目の手順（P10）。作業場の frontend/verdant-virgo/src に差分が残っていると、cycle-apply-code は次の E-13 に進めない
 * （前の差分の上に重ねると、項目のファイルと PR がずれるため）。人がコミットするか、差分を捨ててから次に進む（捨てるのは人。表示だけ）
 */
function codeRejectedSteps(ctx: StepsContext): CycleStep[] {
  if (!SAFE_PATH.test(ctx.worktree)) return [];
  const worktree = shellQuote(ctx.worktree);
  return [
    {
      text: "差し戻した code の項目の差分が作業場に残っていれば、人がコミットするか、次の 2 本で捨てる（cycle-apply-code は作業場の frontend/verdant-virgo/src に未コミットの差分があると、次の E-13 に進まない）",
      command: null,
    },
    { text: "追跡済みのファイルの差分を捨てる", command: `git -C ${worktree} restore --source=HEAD --staged --worktree -- frontend/verdant-virgo/src` },
    { text: "未追跡のファイルを消す（先に -n を付けて消す対象を確かめてもよい）", command: `git -C ${worktree} clean -fd -- frontend/verdant-virgo/src` },
  ];
}

/** OK の前（準備中・OK 待ち）に出す手順。article・campaign の記事のアイキャッチが結び待ちなら「表紙に結ぶ」だけ（I6。結ぶまで OK できない） */
function preApprovalSteps(item: CycleItem, ctx: StepsContext): CycleStep[] {
  if (item.preview.kind === "article") return item.preview.coverUrl ? [] : coverStep(ctx, item.preview.documentId, item.preview.coverPendingFileId);
  if (item.preview.kind === "campaign") {
    return item.preview.coverUrl ? [] : coverStep(ctx, item.preview.articleDocumentId, item.preview.coverPendingFileId);
  }
  return [];
}

/**
 * 表示する手順。OK の前（準備中・OK 待ち）は preApprovalSteps だけ、OK の後は種類ごとの手順。
 * proposal は PR の承認だけなので、PR を見る案内だけ
 */
export function stepsFor(item: CycleItem, ctx: StepsContext): CycleStep[] {
  // 差し戻した項目は、code だけ作業場の差分の後始末を案内する（ほかの種類は、差し戻した後に行うことが無い）
  if (item.kind !== "proposal" && item.state === "rejected") return item.kind === "code" ? codeRejectedSteps(ctx) : [];
  if (item.kind !== "proposal" && (item.state === "preparing" || item.state === "awaiting_review")) return preApprovalSteps(item, ctx);
  switch (item.kind) {
    case "article":
      return articleSteps(item, ctx);
    case "campaign":
      return campaignSteps(item, ctx);
    case "code":
      return codeSteps(item, ctx);
    case "deploy":
      return deploySteps(item, ctx);
    case "proposal": {
      const pr = item.preview.kind === "proposal" ? item.preview.prNumber : null;
      return [{ text: pr === null ? "PR はまだ作られていない（daily-i13-file が起票する）" : `GitHub で PR #${pr} を確かめて承認する（OK は押さない。承認とマージで進む）`, command: null }];
    }
    case "manual":
      return [
        {
          text: `人が手で行う: ${item.preview.kind === "manual" ? item.preview.description : item.title}。行ったら「実行した」を押す（反映の数には入らない）`,
          command: null,
        },
      ];
  }
}
