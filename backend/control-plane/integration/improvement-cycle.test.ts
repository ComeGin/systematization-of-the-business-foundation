// 結合テスト: 再帰的自己改善の 1 ループ（改善ループの 1 周。spec docs/superpowers/specs/2026-11-09-improvement-cycle-design.md）。
//
// 顧客のシグナル → 観測（E-12）→ 改修案（E-13）→ PR（I-13）→ R2 の承認とマージ → 作用（記事の書き直し・キャンペーン・コードの差分）
// → アイキャッチ画像 → 周の項目（OK 待ち）→ OK（確認項目）→ 人の実行（公開・マージ・配信・送信）→ システムの確かめ → 反映 → 周の締め、
// を、公開の入口（createControlPlane → runNow・getCycle・approveCycleItem・markCycleItemExecuted）だけから通す。
//
// 境界（ユーザーの条件。再帰的自己改善のシステムはオンプレ、成果物の正本はクラウド）:
//   本物     control-plane（エンジン・E-15 の SQLite・builtin・cycle）、git（main のチェックアウトと作業場）、pnpm の子プロセス、
//            開発の Strapi（1337。記事の正本）と Mautic（8000。メールとキャンペーンの正本）
//   差し替え Agent SDK（@anthropic-ai/claude-agent-sdk。台本どおりに動き、エージェントの書き込みはテストが開発の Strapi・Mautic・作業場に行う。
//            書き込みの前に control-plane の PreToolUse のフックを SDK と同じ形で呼ぶ）、OpenAI SDK（openai）、AWS SDK（S3・CloudWatch・SNS）、
//            GitHub（偽の REST API）、公開サイト（S3 ＋ CloudFront の代わりの静的なサーバー）、astro build ＋ Lighthouse CI（偽の `pnpm lh`）
//
// 開発の Strapi・Mautic には it- の名前のデータ（記事・メディア・API トークン・セグメント・メール・キャンペーン）を作り、テストの後で消す。
// キャンペーンの送信先は誰も入っていない it- のセグメントなので、テストでキャンペーンを公開しても誰にも送られない。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookJSONOutput, Options } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPlane, CycleView, RunRecord } from "../src/contract.js";
import { ControlPlaneInputError } from "../src/index.js";
import { awsError, aws, resetAws, snsPublishes } from "./helpers/aws-mock.js";
import { callPreToolUse, init, lastQuery, later, resetSdk, result, script, sdk } from "./helpers/agent-sdk.js";
import {
  CTA_AFTER,
  CTA_BEFORE,
  CTA_FILE,
  type CycleProposalOptions,
  allChecks,
  auditText,
  buildEnvRecord,
  commitAll,
  correlationIdOf,
  cycleProposalText,
  itemOf,
  jstYear,
  mondayOfThisWeekJst,
  setScores,
  setupCycleRepos,
  sha256,
} from "./helpers/cycle-fixture.js";
import {
  articleCover,
  campaignData,
  createDraftArticle,
  createMauticRecord,
  createSegment,
  createWriteToken,
  deleteApiToken,
  deleteArticle,
  deleteMauticRecord,
  deleteUploadFile,
  mauticClient,
  publishArticle,
  publishMauticRecord,
  strapiReadToken,
  templateEmailData,
  updateDraftArticle,
} from "./helpers/dev-cms.js";
import { CLOSED_PORT_URL, Cleanup, DEV, RUN_ID, itName } from "./helpers/dev-stack.js";
import { FakeGitHub, GITHUB_TOKEN, githubEnv } from "./helpers/fake-github.js";
import { DUMMY_ANTHROPIC_KEY, type Fixture, Planes, captureLogs, createFixture, e15Bytes, jstToday, waitFinished, writeAt } from "./helpers/fixtures.js";
import { imagePrompts, openai, openaiErrors, resetOpenAi } from "./helpers/openai-mock.js";
import { PublicSite } from "./helpers/public-site.js";

vi.mock("@aws-sdk/client-s3", () => import("./helpers/aws-mock.js").then((m) => m.s3Module));
vi.mock("@aws-sdk/client-cloudwatch", () => import("./helpers/aws-mock.js").then((m) => m.cloudWatchModule));
vi.mock("@aws-sdk/client-sns", () => import("./helpers/aws-mock.js").then((m) => m.snsModule));
vi.mock("@anthropic-ai/claude-agent-sdk", () => import("./helpers/agent-sdk.js").then((m) => m.sdkModule));
vi.mock("openai", () => import("./helpers/openai-mock.js").then((m) => m.openaiModule));

/** 周の起点（今日を含む週の月曜）。今日は周の 0〜6 日目になる */
const ANCHOR = mondayOfThisWeekJst();
const YEAR = jstYear();
/** 承認した人（監視アプリにログインした R2 のメール） */
const ACTOR = "r2-it@example.com";
/** OpenAI の API キー（SDK はモックなので、どこにも送られない。子プロセス・エージェントに渡っていないことを確かめる） */
const OPENAI_KEY = "sk-it-openai-dummy-key-0000000000";
const AWS_ENV = { AWS_REGION: "ap-northeast-1", RUNLOG_BUCKET: "it-comegin-runlog" };
const DEPLOY_ENV = { CONTROL_DEPLOY_BUCKET: "it-comegin-site", CONTROL_DEPLOY_DISTRIBUTION_ID: "EITCYCLE0001", CONTROL_DEPLOY_AWS_PROFILE: "it-deploy" };
const ALERT_TOPIC = "arn:aws:sns:ap-northeast-1:000000000000:it-comegin-alert";
const LINK_BASE = "http://127.0.0.1:3200";
const ZERO_REFLECTION_SUBJECT = "[ComeGin 改善ループ] この周は反映できなかった";

let fx: Fixture;
let site: PublicSite;
let github: FakeGitHub;
let planes: Planes;
let plane: ControlPlane;
let logs: () => string;
/** テストの間だけの Strapi の書き込みトークン（本番の CONTROL_STRAPI_WRITE_TOKEN と同じ権限） */
let writeToken: { id: number; accessKey: string };
const fileCleanup = new Cleanup();

beforeAll(async () => {
  writeToken = await createWriteToken(itName("cycle-write"));
  fileCleanup.add("Strapi の書き込みトークン", () => deleteApiToken(writeToken.id));
});

afterAll(async () => {
  await fileCleanup.runAll();
});

beforeEach(async () => {
  fx = createFixture("cp-it-cycle-");
  setupCycleRepos(fx);
  site = await PublicSite.start();
  github = await FakeGitHub.start();
  github.installFetch();
  github.compareIn(fx.main);
  planes = new Planes();
  logs = captureLogs();
  resetAws();
  resetSdk();
  resetOpenAi(RUN_ID);
});

afterEach(async () => {
  vi.useRealTimers();
  await planes.stopAll();
  await github.stop();
  await site.stop();
  fx.cleanup();
});

/** 設定の状況（反映 0 件の知らせの SNS）に要るファイル。中身は SNS がモックなので読まれない */
function statusEnv(): Record<string, string> {
  return {
    CONTROL_SETUP_STATUS_ENABLED: "true",
    CONTROL_STATUS_AWS_CREDENTIALS_FILE: writeAt(fx.root, "status/credentials", "[default]\naws_access_key_id = AKIAITFAKE\naws_secret_access_key = it\n"),
    CONTROL_STATUS_GITHUB_TOKEN_FILE: writeAt(fx.root, "status/github-token", "ghp_itStatusFake\n"),
    CONTROL_STATUS_ALERT_TOPIC_ARN: ALERT_TOPIC,
    CONTROL_STATUS_LINK_BASE: LINK_BASE,
  };
}

/** 監視アプリ（本番はオンプレ）の control-plane の環境変数。Strapi・Mautic は開発のもの、公開サイト・GitHub は偽物 */
function cycleEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const mautic = mauticClient();
  return fx.env({
    ANTHROPIC_API_KEY: DUMMY_ANTHROPIC_KEY,
    CONTROL_CYCLE_ANCHOR: ANCHOR,
    CONTROL_WORKTREE_SYNC: "false",
    SITE_URL: site.url,
    ...githubEnv(),
    CONTROL_STRAPI_URL: DEV.strapi,
    CONTROL_STRAPI_READ_TOKEN: strapiReadToken(),
    CONTROL_STRAPI_WRITE_TOKEN: writeToken.accessKey,
    OPENAI_API_KEY: OPENAI_KEY,
    // 1 回に作る枚数の上限（設定の最大）。article-cover は表紙の無い下書きを updatedAt の古い順に処理するので、
    // 開発の Strapi に元からある古い下書きが先に枠を取る。runCoverUntilReached で何回か回してテストの記事に届かせる
    CONTROL_COVER_MAX_PER_RUN: "10",
    CONTROL_MAUTIC_URL: DEV.mautic,
    CONTROL_MAUTIC_CLIENT_ID: mautic.id,
    CONTROL_MAUTIC_CLIENT_SECRET: mautic.secret,
    ...DEPLOY_ENV,
    ...AWS_ENV,
    ...statusEnv(),
    ...extra,
  });
}

function openPlane(extra: Record<string, string> = {}): ControlPlane {
  plane = planes.create(cycleEnv(extra));
  return plane;
}

/** 定期実行の定義を手動で 1 回起動し、確定まで待つ */
async function runJob(jobId: string, timeoutMs = 90_000): Promise<RunRecord> {
  const { runId } = await plane.runNow({ target: { kind: "job", jobId } });
  return waitFinished(plane, runId, timeoutMs);
}

/** 画面の操作が ControlPlaneInputError（画面に出す入力の誤り）で断られることを確かめる */
async function expectInputError(promise: Promise<unknown>, message: RegExp): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ControlPlaneInputError);
  expect((error as Error).message).toMatch(message);
}

type ViewItem = CycleView["items"][number];

/** 項目が state になるまで待つ（「実行した」の後の確かめは非同期） */
async function waitItemState(cycleId: string, itemId: string, state: ViewItem["state"], timeoutMs = 60_000): Promise<ViewItem> {
  return vi.waitFor(
    async () => {
      const item = (await plane.getCycle(cycleId)).items.find((candidate) => candidate.itemId === itemId);
      if (item?.state !== state) throw new Error(`項目が ${state} にならない（今は ${item?.state ?? "無い"}: ${item?.stateReason ?? ""}）`);
      return item;
    },
    { timeout: timeoutMs, interval: 250 },
  );
}

/** article-cover を回す回数の上限（ほかの下書きが連続 3 回の失敗で外れるまで。上限 10 件 × 3 回で外れるので、30 件程度までなら届く） */
const COVER_RUNS_MAX = 12;

/**
 * article-cover を、titles のすべての記事の画像の生成が試みられるまで回す。戻り値は回したすべての実行（最後がテストの記事に届いた実行）。
 * article-cover は表紙の無い下書きを updatedAt の古い順に上限まで処理するため、開発の Strapi に元からある古い下書きが先に枠を取る。
 * それらは OpenAI のモックが断る（画像は上がらない）ので、連続 3 回の失敗で対象から外れ（MAX_CONSECUTIVE_FAILURES。記録は
 * テストの一時ディレクトリの E-15 の kv）、数回でテストの記事に届く。本番でも、生成に失敗し続ける記事は同じく外れる。
 */
async function runCoverUntilReached(titles: string[]): Promise<RunRecord[]> {
  const runs: RunRecord[] = [];
  for (let i = 0; i < COVER_RUNS_MAX; i++) {
    runs.push(await runJob("article-cover"));
    if (titles.every((title) => imagePrompts().some((prompt) => prompt.includes(title)))) return runs;
  }
  throw new Error(`article-cover を ${COVER_RUNS_MAX} 回回してもテストの記事に届かない（最後の要約: ${runs.at(-1)?.summary ?? ""}）`);
}

/** 台本の 1 手で起きた例外（開発の Strapi・Mautic の失敗など）を、実行の後でテストの失敗として出すための入れ物 */
function stepRecorder() {
  const errors: unknown[] = [];
  const guards: { tool: string; output: HookJSONOutput }[] = [];
  return {
    errors,
    guards,
    /** 台本の手。例外は握って errors に残す（エージェントの失敗にせず、テストの失敗として出す） */
    step: (fn: (options: Options) => Promise<void>) => async (options: Options) => {
      try {
        await fn(options);
      } catch (error) {
        errors.push(error);
      }
    },
    /** エージェントがツールを呼ぶ前に、control-plane の PreToolUse のフックを SDK と同じ形で呼ぶ */
    guard: async (options: Options, tool: string, input: Record<string, unknown>): Promise<HookJSONOutput> => {
      const output = await callPreToolUse(options, tool, input);
      guards.push({ tool, output });
      return output;
    },
    assertClean(): void {
      if (errors.length > 0) throw errors[0];
    },
  };
}

/** 承認済み main の E-13（R2 が PR を承認してマージした後の版） */
function approveInMain(options: CycleProposalOptions, prNumber: number): string {
  writeAt(
    fx.main,
    `docs/proposals/${options.id}.md`,
    cycleProposalText({ ...options, state: "approved", diffRef: `PR #${prNumber}`, approvedBy: { prNumber, decidedAt: new Date().toISOString() } }),
  );
  return commitAll(fx.main, `add: ${options.id} を承認（PR #${prNumber}）`);
}

const EVIDENCE = [{ auditId: `AUD-${jstToday().auditKey}-seo-0001`, source: "seo", summary: "記事の CTR が 1.2%（同じ順位帯の中央値 2.8%）" }];

describe("改善ループの 1 周（結合）", () => {
  describe("正常系", () => {
    it(
      "シグナル → E-12 → E-13 → PR の承認 → 下書き・差分・キャンペーン → アイキャッチ → OK → 公開・マージ・配信・送信 → 反映 3 件で周を閉じる",
      async () => {
        const local = new Cleanup();
        try {
          const today = jstToday();
          const seoAudit = `AUD-${today.auditKey}-seo-0001`;
          const conversationAudit = `AUD-${today.auditKey}-conversations-0001`;
          const ids = { content: `PRP-${YEAR}-0001`, campaign: `PRP-${YEAR}-0002`, code: `PRP-${YEAR}-0003` };

          // 書き直した後の記事 A のタイトル（アイキャッチのプロンプトに入る）
          const titleA = `${RUN_ID} 介護記録の電子化で二重入力をなくす`;

          // ---- 前提: 公開サイトにある記事（シグナルの対象）と、キャンペーンの送信先のセグメント（開発の Strapi・Mautic） ----
          const slugA = `${RUN_ID}-rewrite`;
          const slugC = `${RUN_ID}-campaign`;
          const titleC = `${RUN_ID} 運営指導に備える記録の電子化（1 次資料のまとめ）`;
          const articleA = await createDraftArticle({ title: `${RUN_ID} 介護記録の電子化`, slug: slugA, description: "介護記録の電子化の手順", body: "旧版の本文" });
          local.add(`記事 ${articleA}`, () => deleteArticle(articleA));
          await publishArticle(articleA);
          const segmentName = itName("cycle-segment");
          const segmentId = await createSegment(segmentName);
          local.add(`セグメント ${segmentId}`, () => deleteMauticRecord("segments", segmentId));

          openPlane();

          // ---- 周を開く（cycle-open） ----
          const opened = await runJob("cycle-open");
          expect(opened).toMatchObject({ outcome: "success", builtin: "cycle-open", trigger: "manual" });
          const cycleId = opened.targetIds[0]!;
          expect(cycleId).toBe(`C-${ANCHOR}`);
          expect(opened.summary).toContain("作業場の合わせは無効");

          // ---- ① データ取得: 観測エージェントがシグナルを E-12 にする（GSC の実績と、Chatwoot の問い合わせ） ----
          const observeSeo = stepRecorder();
          script([
            init(),
            observeSeo.step(async (options) => {
              const runId = correlationIdOf(lastQuery().prompt);
              const path = `docs/audits/seo/${seoAudit}.md`;
              const body = auditText({ auditId: seoAudit, source: "seo", createdBy: "agent/seo-auditor", correlationId: runId, body: `/blog/${slugA}/ の CTR が低い` });
              await observeSeo.guard(options, "Write", { file_path: join(fx.worktree, path), content: body });
              writeAt(fx.worktree, path, body);
            }),
            result(`SUMMARY: GSC の実績を E-12 にした（1 件）\nTARGET_IDS: ${seoAudit}`),
          ]);
          const seoRun = await runJob("daily-observe-seo");
          observeSeo.assertClean();
          expect(seoRun).toMatchObject({ outcome: "success", agentName: "seo-auditor" });

          const observeConversations = stepRecorder();
          script([
            init(),
            observeConversations.step(async (options) => {
              const runId = correlationIdOf(lastQuery().prompt);
              const path = `docs/audits/conversations/${conversationAudit}.md`;
              const body = auditText({
                auditId: conversationAudit,
                source: "conversations",
                createdBy: "agent/conversation-triage",
                correlationId: runId,
                body: "記録の電子化と運営指導の準備についての問い合わせが 7 件",
              });
              await observeConversations.guard(options, "Write", { file_path: join(fx.worktree, path), content: body });
              writeAt(fx.worktree, path, body);
            }),
            result(`SUMMARY: 未解決の会話を集計して E-12 にした（1 件）\nTARGET_IDS: ${conversationAudit}`),
          ]);
          const conversationRun = await runJob("daily-observe-conversations");
          observeConversations.assertClean();
          expect(conversationRun.outcome).toBe("success");

          // 実行と、その実行が書いた E-12 が結びつく（画面の「この実行が書いた観測」）
          const [seoObservations] = await plane.listRunObservations([seoRun.runId]);
          expect(seoObservations!.written.map((o) => o.auditId)).toEqual([seoAudit]);

          // ---- ② 解析と改修案: proposal-writer が E-13 を 3 件（記事の書き直し・キャンペーン・コード）起票し、I-13 が PR にする ----
          const proposals: Record<keyof typeof ids, CycleProposalOptions> = {
            content: {
              id: ids.content,
              kind: "content_rewrite",
              entity: "E-04",
              identifier: `documentId=${articleA}`,
              description: "記事の導入で読み手の課題（記録の二重入力）を先に示し、title と description を検索意図に合わせる",
              evidence: [{ auditId: seoAudit, source: "seo", summary: "記事の CTR が 1.2%（同じ順位帯の中央値 2.8%）" }],
            },
            campaign: {
              id: ids.campaign,
              kind: "email_campaign",
              entity: "E-09",
              identifier: `segment:${segmentName}#${slugC}`,
              description: "介護事業所向けに、運営指導に備える記録の電子化の 1 次資料のまとめを記事にし、メールで案内する",
              evidence: [{ auditId: conversationAudit, source: "conversations", summary: "記録の電子化についての問い合わせが 7 件" }],
              metric: "MA-form-submissions",
            },
            code: {
              id: ids.code,
              kind: "accessibility",
              entity: "E-05",
              identifier: "url_path=/",
              description: "CTA のリンクに目的の分かる名前を付ける",
              evidence: [{ auditId: seoAudit, source: "seo", summary: "CTA のクリック率が低い" }],
              metric: "LH-accessibility",
            },
          };
          const propose = stepRecorder();
          script([
            init(),
            propose.step(async (options) => {
              for (const proposal of Object.values(proposals)) {
                const path = `docs/proposals/${proposal.id}.md`;
                const text = cycleProposalText(proposal);
                await propose.guard(options, "Write", { file_path: join(fx.worktree, path), content: text });
                writeAt(fx.worktree, path, text);
              }
            }),
            result(`SUMMARY: 起票前チェック 15 項目を通した改善提案を 3 件起票した\nTARGET_IDS: ${Object.values(ids).join(",")}`),
          ]);
          const proposeRun = await runJob("daily-propose");
          propose.assertClean();
          expect(proposeRun).toMatchObject({ outcome: "success", agentName: "proposal-writer" });

          const i13 = await runJob("daily-i13-file");
          expect(i13.outcome).toBe("success");
          const prOf = (id: string) => {
            const pull = github.pulls.find((candidate) => candidate.head.endsWith(id));
            if (!pull) throw new Error(`${id} の PR が無い`);
            return pull.number;
          };

          // 周の項目に改修案が並ぶ（PR のリンク付き。OK は GitHub の PR で行う）
          const collected1 = await runJob("cycle-collect");
          expect(collected1.outcome).toBe("success");
          let view = await plane.getCycle(cycleId);
          for (const id of Object.values(ids)) {
            const item = itemOf(view, "proposal", id);
            expect(item).toMatchObject({ state: "awaiting_review", stage: "propose" });
            expect(item.preview).toEqual({ kind: "proposal", prNumber: prOf(id), prState: "open", prUrl: `https://github.com/kamegin4-aws/it-fake-repo/pull/${prOf(id)}` });
          }

          // R2 が PR を承認してマージする（承認済みの E-13 が main に入る）
          for (const proposal of Object.values(proposals)) {
            const number = prOf(proposal.id);
            github.approvePull(number);
            github.mergePull(number, approveInMain(proposal, number));
          }
          expect((await runJob("cycle-collect")).outcome).toBe("success");
          view = await plane.getCycle(cycleId);
          for (const id of Object.values(ids)) expect(itemOf(view, "proposal", id).state).toBe("confirmed");

          // ---- ③ 下書き・差分: 作用のジョブが承認済みの E-13 を 1 件ずつ受け取る（選ぶのはエンジン） ----
          // 記事の書き直し（content-writer。本番の Strapi には下書きまで）
          const content = stepRecorder();
          script([
            init(),
            content.step(async () => {
              await updateDraftArticle(articleA, {
                title: titleA,
                description: "記録の二重入力をなくす電子化の手順と、運営指導への備え",
                body: "## 二重入力が起きる理由\n\n新しい本文",
              });
            }),
            result(`SUMMARY: ${ids.content} の仕様で記事の下書きを書き直した\nCREATED: article=${articleA}\nTARGET_IDS: ${ids.content}`),
          ]);
          const contentRun = await runJob("cycle-apply-content");
          content.assertClean();
          expect(contentRun).toMatchObject({ outcome: "success", trigger: "proposal", agentName: "content-writer" });
          expect(lastQuery().prompt).toContain(`PRP: ${ids.content}`);
          expect(lastQuery().prompt).toContain(`SITE_URL: ${site.url}`);

          // キャンペーン一式（campaign-planner。記事の下書き・未公開のメールとキャンペーン）
          const campaign = stepRecorder();
          const created: { article?: string; email?: number; campaign?: number } = {};
          const articleUrlC = `${site.url}/blog/${slugC}/`;
          script([
            init(),
            campaign.step(async (options) => {
              const article = { title: titleC, slug: slugC, description: "運営指導に備える記録の電子化", body: "## 出典\n\n- 厚生労働省" };
              await campaign.guard(options, "mcp__strapi-prod__create_article", { data: { title: article.title, slug: article.slug, description: article.description } });
              created.article = await createDraftArticle(article);
              const articleId = created.article;
              local.add(`記事 ${articleId}`, () => deleteArticle(articleId));

              const email = templateEmailData({
                name: itName("cycle-email"),
                subject: "運営指導に備える記録の電子化",
                html: `<p>記録の電子化の要点をまとめました。</p><p><a href="${articleUrlC}?utm_source=mautic&utm_medium=email&utm_campaign=${ids.campaign}">記事を読む</a></p>`,
              });
              await campaign.guard(options, "mcp__mautic-prod__mautic_create_record", { resource: "emails", data: email });
              created.email = await createMauticRecord("emails", email);
              const emailId = created.email;
              local.add(`メール ${emailId}`, () => deleteMauticRecord("emails", emailId));

              const record = campaignData({ name: itName("cycle-campaign"), segmentId, emailId });
              await campaign.guard(options, "mcp__mautic-prod__mautic_create_record", { resource: "campaigns", data: record });
              created.campaign = await createMauticRecord("campaigns", record);
              const campaignId = created.campaign;
              local.add(`キャンペーン ${campaignId}`, () => deleteMauticRecord("campaigns", campaignId));
            }),
            // 結果の文は、作ったものの id が分かってから組み立てる
            later(() =>
              result(
                `SUMMARY: ${ids.campaign} のキャンペーン一式を未公開で作った。メールとキャンペーンの両方を公開すると送信が始まる\n` +
                  `CREATED: article=${created.article}\nCREATED: email=${created.email}\nCREATED: campaign=${created.campaign}\nTARGET_IDS: ${ids.campaign}`,
              ),
            ),
          ]);
          const campaignRun = await runJob("cycle-campaign");
          campaign.assertClean();
          expect(campaignRun).toMatchObject({ outcome: "success", trigger: "proposal", agentName: "campaign-planner" });
          // エージェントの作成は、未公開・template のメール・email.send だけのキャンペーン・下書きの記事なので、どれもフックを通る
          expect(campaign.guards.map((g) => [g.tool, g.output])).toEqual([
            ["mcp__strapi-prod__create_article", {}],
            ["mcp__mautic-prod__mautic_create_record", {}],
            ["mcp__mautic-prod__mautic_create_record", {}],
          ]);
          const articleC = created.article!;

          // コードの差分（design-implementer。作業場の frontend/verdant-virgo/src に未コミットの差分を作る）
          const code = stepRecorder();
          script([
            init(),
            code.step(async (options) => {
              await code.guard(options, "Edit", { file_path: join(fx.worktree, CTA_FILE), old_string: CTA_BEFORE, new_string: CTA_AFTER });
              writeAt(fx.worktree, CTA_FILE, CTA_AFTER);
            }),
            result(`SUMMARY: ${ids.code} の仕様で CTA に名前を付けた\nCREATED: files=${CTA_FILE}\nTARGET_IDS: ${ids.code}`),
          ]);
          const codeRun = await runJob("cycle-apply-code");
          code.assertClean();
          expect(codeRun).toMatchObject({ outcome: "success", trigger: "proposal", agentName: "design-implementer" });
          for (const recorder of [observeSeo, observeConversations, propose, code]) {
            for (const { output } of recorder.guards) expect(output).toEqual({});
          }

          // アイキャッチ画像（article-cover。OpenAI で作り、Strapi に上げて下書きの cover に結ぶ）
          const coverRuns = await runCoverUntilReached([titleA, titleC]);
          // テストの記事に届いた実行では、テストの記事は結べる。同じ実行でほかの下書き（モックが断る）を試みていれば partial になる
          expect(["success", "partial"]).toContain(coverRuns.at(-1)!.outcome);
          // テストの記事の生成は 1 回ずつだけ（結べた記事は表紙の無い下書きの一覧から消える）
          expect(imagePrompts().filter((prompt) => prompt.includes(RUN_ID))).toHaveLength(2);
          // OpenAI のキーは control-plane だけが持ち、再試行しない（1 回ごとに課金されるため）
          expect(openai.clients.every((client) => client.apiKey === OPENAI_KEY && client.maxRetries === 0)).toBe(true);
          for (const documentId of [articleA, articleC]) {
            const coverFile = await articleCover(documentId, "draft");
            expect(coverFile, `${documentId} の下書きに cover が結ばれていない`).not.toBeNull();
            local.add(`メディア ${coverFile!.id}`, () => deleteUploadFile(coverFile!.id));
          }

          // ---- 周の項目が OK 待ちになる（シグナル → E-12 → E-13 → 下書き・差分のつながりが見える） ----
          expect((await runJob("cycle-collect")).outcome).toBe("success");
          view = await plane.getCycle(cycleId);
          expect(view.reason).toBeNull();
          const article = itemOf(view, "article", ids.content);
          expect(article).toMatchObject({ state: "awaiting_review", stage: "draft", proposalId: ids.content });
          expect(article.evidence).toEqual([{ auditId: seoAudit, summary: "記事の CTR が 1.2%（同じ順位帯の中央値 2.8%）" }]);
          expect(article.preview).toMatchObject({ kind: "article", documentId: articleA, slug: slugA, titleText: titleA });
          expect(article.preview.kind === "article" && article.preview.coverUrl).toBeTruthy();
          const campaignItem = itemOf(view, "campaign", ids.campaign);
          expect(campaignItem).toMatchObject({ state: "awaiting_review", stage: "draft" });
          expect(campaignItem.evidence.map((e) => e.auditId)).toEqual([conversationAudit]);
          expect(campaignItem.preview).toMatchObject({
            kind: "campaign",
            articleDocumentId: articleC,
            linkUrl: `${articleUrlC}?utm_source=mautic&utm_medium=email&utm_campaign=${ids.campaign}`,
            emailId: created.email,
            emailSubject: "運営指導に備える記録の電子化",
            campaignId: created.campaign,
            segmentName,
            segmentCount: 0,
            assets: [],
          });
          const codeItem = itemOf(view, "code", ids.code);
          expect(codeItem).toMatchObject({ state: "awaiting_review", stage: "evaluate" });
          expect(codeItem.preview).toMatchObject({ kind: "code", proposalId: ids.code, files: [CTA_FILE] });
          expect(codeItem.preview.kind === "code" && codeItem.preview.diffStat).toContain("Cta.astro");
          expect(view.summary).toEqual({ proposals: 3, reflected: 0, awaiting: 3, rejected: 0, stuck: 0, keywordReflected: 0 });
          // 周の要約は作業場の docs/cycles に書き出す（次の周の proposal-writer が読む）
          expect(existsSync(join(fx.worktree, "docs/cycles", `${cycleId}.md`))).toBe(true);

          // ---- ④ 承認: 確認項目（法務など）をすべて入れて OK ----
          for (const item of [article, campaignItem, codeItem]) {
            expect(item.checklist.length).toBeGreaterThan(0);
            view = await plane.approveCycleItem(item.itemId, allChecks(item), ACTOR, item.updatedAt);
            const approved = view.items.find((candidate) => candidate.itemId === item.itemId)!;
            expect(approved.state).toBe("approved");
            expect(approved.approvals).toEqual([expect.objectContaining({ action: "approve", actor: ACTOR, checked: allChecks(item) })]);
          }

          // ---- ⑤ 公開・送信の手順の表示と、人の実行 ----
          // 記事: 画面の手順（Strapi の管理画面で公開する）のとおりに公開 →「実行した」→ システムが Strapi の公開版を確かめる
          const articleSteps = itemOf(view, "article", ids.content).steps.map((s) => s.text).join("\n");
          expect(articleSteps).toContain(`${DEV.strapi}/admin/content-manager/collection-types/api::article.article/${articleA}`);
          await publishArticle(articleA);
          expect(await plane.markCycleItemExecuted(article.itemId, ACTOR)).toEqual({ accepted: true });
          await waitItemState(cycleId, article.itemId, "confirmed");

          // コード: 画面の手順（ブランチ・コミット・PR）→ R2 がレビューしてマージ（main に入る）→「実行した」→ PR のマージを確かめる
          const codeCommands = itemOf(view, "code", ids.code).steps.map((s) => s.command ?? "").join("\n");
          const branch = `13-feature-${ids.code}`;
          expect(codeCommands).toContain(`git switch -c ${branch} origin/main`);
          expect(codeCommands).toContain(`gh pr create --base main --head ${branch}`);
          writeAt(fx.main, CTA_FILE, CTA_AFTER);
          const mergeSha = commitAll(fx.main, `mod: ${ids.code} CTA に名前を付ける`);
          const codePr = github.addPull({ head: branch, base: "main", title: `mod: ${ids.code}`, body: "改善ループの code の項目", state: "open" });
          github.approvePull(codePr);
          github.mergePull(codePr, mergeSha);
          await plane.markCycleItemExecuted(codeItem.itemId, ACTOR);
          await waitItemState(cycleId, codeItem.itemId, "confirmed");

          // キャンペーン: 手順 ①（記事の公開）だけを先に行う。③（Mautic の公開）は、配信でリンク先が出るまで表示されない
          const campaignStepsBefore = itemOf(view, "campaign", ids.campaign).steps.map((s) => s.text);
          expect(campaignStepsBefore.some((text) => text.startsWith("①"))).toBe(true);
          expect(campaignStepsBefore.some((text) => text.startsWith("③"))).toBe(false);
          await publishArticle(articleC);

          // ---- ⑦ ビルドと配信: 公開とマージを検知して、本番の値でビルドと計測を行い、配信の項目にする ----
          const check = await runJob("published-article-check", 240_000);
          expect(check).toMatchObject({ outcome: "success", builtin: "published-article-check" });
          view = await plane.getCycle(cycleId);
          const deploy = itemOf(view, "deploy");
          expect(deploy.state).toBe("awaiting_review");
          expect(deploy.preview).toMatchObject({ kind: "deploy", commitSha: mergeSha, blocked: null, lighthouse: { seo: 1, accessibility: 1 } });
          const deployPreview = deploy.preview.kind === "deploy" ? deploy.preview : null;
          expect(deployPreview!.changes).toEqual(expect.arrayContaining([`${site.url}/blog/${slugA}/`, articleUrlC]));
          expect(deployPreview!.distPath.startsWith(join(fx.dataDir, "deploy"))).toBe(true);
          // ビルドには読み取りトークンだけを渡す（書き込みトークン・GitHub・OpenAI・Anthropic・Mautic の秘密値を渡さない）
          const buildEnv = buildEnvRecord(fx);
          expect(buildEnv).toMatchObject({ strapiUrl: DEV.strapi, siteUrl: site.url, buildTarget: "production", commit: mergeSha, strapiTokenSha256: sha256(strapiReadToken()) });
          for (const secret of [writeToken.accessKey, GITHUB_TOKEN, OPENAI_KEY, DUMMY_ANTHROPIC_KEY, mauticClient().secret]) {
            expect(buildEnv.valueHashes).not.toContain(sha256(secret));
          }

          // 配信の OK → 手順（aws のコマンド）→ 人が配信 →「実行した」→ 公開サイトのビルドの印と記事の URL を確かめる
          view = await plane.approveCycleItem(deploy.itemId, allChecks(deploy), ACTOR, deploy.updatedAt);
          const deployCommands = itemOf(view, "deploy").steps.map((s) => s.command).filter((c): c is string => c !== null);
          expect(deployCommands.some((c) => c.includes(`aws s3 sync "${deployPreview!.distPath}/" s3://it-comegin-site`) && c.includes("--delete"))).toBe(true);
          expect(deployCommands.some((c) => c.includes("aws cloudfront create-invalidation --distribution-id EITCYCLE0001"))).toBe(true);
          site.deploy(deployPreview!.distPath);
          expect(site.buildCommit()).toBe(mergeSha);
          await plane.markCycleItemExecuted(deploy.itemId, ACTOR);
          await waitItemState(cycleId, deploy.itemId, "confirmed");

          // 確かめた配信に含まれた記事とコードを、反映済みにする（コードは PR のマージのコミットが配信のコミットに含まれるか）
          expect((await runJob("cycle-collect")).outcome).toBe("success");
          view = await plane.getCycle(cycleId);
          // 反映の時刻は、その配信を確かめた時刻（deploy の項目の updatedAt）
          const confirmedDeploy = itemOf(view, "deploy");
          expect(itemOf(view, "article", ids.content).reflectedAt).toBe(confirmedDeploy.updatedAt);
          expect(itemOf(view, "code", ids.code).reflectedAt).toBe(confirmedDeploy.updatedAt);
          // 反映を確かめた項目には、E-13 の applied_at を記録する手順が出る（記録は配信した人。ADR-16）
          expect(itemOf(view, "article", ids.content).steps.some((s) => s.text.includes(`docs/proposals/${ids.content}.md の applied_at`))).toBe(true);

          // キャンペーン: リンク先が公開サイトに出たので、手順 ③（Mautic で両方を公開）が出る → 公開 →「実行した」→ 送信の開始を確かめる
          const campaignStepsAfter = itemOf(view, "campaign", ids.campaign).steps.map((s) => s.text);
          expect(campaignStepsAfter.some((text) => text.startsWith("③") && text.includes(segmentName))).toBe(true);
          await publishMauticRecord("emails", created.email!);
          await publishMauticRecord("campaigns", created.campaign!);
          await plane.markCycleItemExecuted(campaignItem.itemId, ACTOR);
          const reflectedCampaign = await waitItemState(cycleId, campaignItem.itemId, "confirmed");
          expect(reflectedCampaign.reflectedAt).not.toBeNull();

          // ---- 周のまとめ: シグナル由来の改修案 3 件がすべて反映された ----
          view = await plane.getCycle(cycleId);
          expect(view.summary).toEqual({ proposals: 3, reflected: 3, awaiting: 0, rejected: 0, stuck: 0, keywordReflected: 0 });
          expect(view.stages.map((s) => [s.stage, s.status])).toEqual([
            ["collect", "done"],
            ["propose", "done"],
            ["draft", "done"],
            ["review", "done"],
            ["publish", "done"],
            ["evaluate", "done"],
            ["deploy", "done"],
          ]);
          expect(view.stages.find((s) => s.stage === "deploy")!.jobIds).toEqual(["published-article-check"]);

          // ---- 周の締め（期間が終わった後の cycle-close）: 反映 3 件なので知らせは出さない ----
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(new Date(Date.parse(view.cycle!.endsAt) + 5 * 60_000));
          const closed = await runJob("cycle-close");
          vi.useRealTimers();
          expect(closed).toMatchObject({ outcome: "success", builtin: "cycle-close" });
          expect(closed.summary).toContain(`${cycleId} を閉じた（反映 E-13 由来 3・キーワード由来 0`);
          const row = (await plane.listCycles()).find((candidate) => candidate.cycleId === cycleId)!;
          expect(row.closedAt).not.toBeNull();
          expect(row.close).toMatchObject({ reflectedFromProposals: 3, reflectedFromKeywords: 0 });
          expect(snsPublishes()).toEqual([]);

          // E-15・ログに秘密値が残らない
          for (const text of [e15Bytes(fx), logs()]) {
            for (const secret of [writeToken.accessKey, strapiReadToken(), OPENAI_KEY, GITHUB_TOKEN, mauticClient().secret]) expect(text).not.toContain(secret);
          }
        } finally {
          await local.runAll();
        }
      },
      600_000,
    );
  });

  describe("異常系", () => {
    /** 承認済み main の config_change（人が手で行う作業。cycle-collect が manual の項目にする。開発の Strapi を使わずに OK 待ちの項目を作れる） */
    async function manualItem(): Promise<{ cycleId: string; item: ViewItem }> {
      writeAt(
        fx.main,
        `docs/proposals/PRP-${YEAR}-0101.md`,
        cycleProposalText({
          id: `PRP-${YEAR}-0101`,
          kind: "config_change",
          identifier: "ga4:key_event=generate_lead",
          description: "GA4 のキーイベントに generate_lead を足す",
          evidence: EVIDENCE,
          state: "approved",
          diffRef: "PR #91",
          approvedBy: { prNumber: 91, decidedAt: new Date().toISOString() },
        }),
      );
      openPlane();
      const collected = await runJob("cycle-collect");
      const cycleId = collected.targetIds[0]!;
      return { cycleId, item: itemOf(await plane.getCycle(cycleId), "manual", `PRP-${YEAR}-0101`) };
    }

    /** 承認済み main の E-13（作用のジョブが受け取る） */
    function approvedProposal(id: string, kind: CycleProposalOptions["kind"], identifier = "url_path=/"): void {
      writeAt(
        fx.main,
        `docs/proposals/${id}.md`,
        cycleProposalText({ id, kind, identifier, description: `${kind} の改修`, evidence: EVIDENCE, state: "approved", diffRef: "PR #92", approvedBy: { prNumber: 92, decidedAt: new Date().toISOString() } }),
      );
    }

    /** 作用のジョブを、台本どおりの結果で 1 回動かす */
    async function runAction(jobId: string, resultText: string): Promise<RunRecord> {
      script([init(), result(resultText)]);
      return runJob(jobId);
    }

    /** 公開済みの記事の一覧から配信の項目を作る（開発の Strapi の公開済みの記事を読むだけ。書き込まない） */
    async function deployItem(): Promise<{ cycleId: string; item: ViewItem; check: RunRecord }> {
      openPlane();
      const check = await runJob("published-article-check", 240_000);
      expect(check.outcome).toBe("success");
      const view = await plane.getCycle();
      return { cycleId: view.cycle!.cycleId, item: itemOf(view, "deploy"), check };
    }

    it("入力: 周の ID・項目の ID・操作した人が不正なら ControlPlaneInputError で断り、何も作らない", async () => {
      openPlane();
      await expectInputError(plane.getCycle("2026-11-16"), /周の ID が不正/);
      await expectInputError(plane.approveCycleItem("not-a-ulid", [], ACTOR, "x"), /項目の ID が不正/);
      await expectInputError(plane.approveCycleItem("01K6PZ3T8Q4M2N7R9S5V1W3X6Y", [], ACTOR, "x"), /項目が見つからない/);
      await expectInputError(plane.markCycleItemExecuted("01K6PZ3T8Q4M2N7R9S5V1W3X6Y", "   "), /操作した人が空/);
      await expectInputError(plane.startCycle(""), /操作した人が空/);
      expect(await plane.listCycles()).toEqual([]);
      // 開いていない周は、画面に理由だけを出す
      expect(await plane.getCycle(`C-${ANCHOR}`)).toMatchObject({ cycle: null, reason: `C-${ANCHOR} はまだ開かれていない`, items: [] });
    });

    it("入力: 確認項目の不足・重複・定義に無い id、画面で見た後に更新された項目では OK できず、OK 待ちのまま承認の記録も残らない", async () => {
      const { cycleId, item } = await manualItem();
      const checks = allChecks(item);
      expect(checks).toEqual(["change-done", "rollback-ready"]);
      await expectInputError(plane.approveCycleItem(item.itemId, checks.slice(1), ACTOR, item.updatedAt), /確認項目が足りない（残り 1 件）/);
      await expectInputError(plane.approveCycleItem(item.itemId, [...checks, checks[0]!], ACTOR, item.updatedAt), /確認項目の id が重複している/);
      await expectInputError(plane.approveCycleItem(item.itemId, [...checks, "legal-ok"], ACTOR, item.updatedAt), /定義に無い確認項目/);
      await expectInputError(plane.approveCycleItem(item.itemId, checks, ACTOR, "2000-01-01T00:00:00.000+09:00"), /項目が更新された/);
      await expectInputError(plane.approveCycleItem(item.itemId, checks, ACTOR, ""), /expectedUpdatedAt/);
      const after = itemOf(await plane.getCycle(cycleId), "manual");
      expect(after).toMatchObject({ state: "awaiting_review", approvals: [] });
    });

    it("入力: 改修案（proposal）の項目は、画面から OK・差し戻し・「実行した」ができない（GitHub の PR で進む）", async () => {
      const id = `PRP-${YEAR}-0102`;
      writeAt(fx.worktree, `docs/proposals/${id}.md`, cycleProposalText({ id, kind: "technical_seo", identifier: "url_path=/", description: "canonical を直す", evidence: EVIDENCE, diffRef: "PR #1" }));
      github.addPull({ number: 1, head: `13-feature-proposal-${id}`, base: "main", title: "t", body: "b", state: "open" });
      openPlane();
      const collected = await runJob("cycle-collect");
      const item = itemOf(await plane.getCycle(collected.targetIds[0]), "proposal", id);
      expect(item).toMatchObject({ state: "awaiting_review", checklist: [] });
      expect(item.preview).toMatchObject({ kind: "proposal", prNumber: 1, prState: "open" });
      await expectInputError(plane.approveCycleItem(item.itemId, [], ACTOR, item.updatedAt), /GitHub の PR で行う/);
      await expectInputError(plane.rejectCycleItem(item.itemId, "不要", ACTOR), /GitHub の PR で行う/);
      await expectInputError(plane.markCycleItemExecuted(item.itemId, ACTOR), /GitHub の PR の承認とマージで進む/);
    });

    it("入力: OK 待ちに「実行した」は押せない。差し戻しの理由は空・501 文字を拒み、メール・電話番号を伏せ字にして docs/cycles に書き出す", async () => {
      const { cycleId, item } = await manualItem();
      await expectInputError(plane.markCycleItemExecuted(item.itemId, ACTOR), /「実行した」を押せる状態ではない/);
      await expectInputError(plane.rejectCycleItem(item.itemId, "   ", ACTOR), /差し戻しの理由が空/);
      await expectInputError(plane.rejectCycleItem(item.itemId, "あ".repeat(501), ACTOR), /500 文字まで/);

      const view = await plane.rejectCycleItem(item.itemId, "担当 r2-it@example.com（090-1234-5678）と相談し、今回は見送る", ACTOR);
      const rejected = itemOf(view, "manual");
      expect(rejected.state).toBe("rejected");
      expect(rejected.stateReason).toBe("担当 [redacted:email]（[redacted:phone]）と相談し、今回は見送る");
      expect(rejected.approvals).toEqual([expect.objectContaining({ action: "reject", actor: ACTOR, reason: rejected.stateReason })]);
      // 差し戻した後は、OK も「実行した」もできない
      await expectInputError(plane.approveCycleItem(item.itemId, allChecks(item), ACTOR, rejected.updatedAt), /OK を押せる状態ではない/);

      expect((await runJob("cycle-collect")).outcome).toBe("success");
      const doc = readFileSync(join(fx.worktree, "docs/cycles", `${cycleId}.md`), "utf8");
      expect(doc).toContain("[redacted:email]");
      expect(doc).not.toContain("r2-it@example.com");
      expect(doc).not.toContain("090-1234-5678");
    });

    it("入力: アイキャッチ画像がまだ無い記事の項目は OK できない（表紙に結ぶまで待つ）", async () => {
      const id = `PRP-${YEAR}-0103`;
      const documentId = await createDraftArticle({ title: `${RUN_ID} 表紙の無い記事`, slug: `${RUN_ID}-nocover`, description: "表紙の無い記事", body: "本文" });
      try {
        approvedProposal(id, "content_rewrite", `documentId=${documentId}`);
        openPlane();
        expect(await runAction("cycle-apply-content", `SUMMARY: 下書きを作った\nCREATED: article=${documentId}\nTARGET_IDS: ${id}`)).toMatchObject({ outcome: "success", trigger: "proposal" });
        const collected = await runJob("cycle-collect");
        const item = itemOf(await plane.getCycle(collected.targetIds[0]), "article", id);
        expect(item).toMatchObject({ state: "awaiting_review", preview: { kind: "article", documentId, coverUrl: null } });
        await expectInputError(plane.approveCycleItem(item.itemId, allChecks(item), ACTOR, item.updatedAt), /アイキャッチ画像がまだ無い/);
      } finally {
        await deleteArticle(documentId);
      }
    });

    it("入力: campaign-planner がメールを公開状態で作る・セグメントを作る・記事を公開状態で作る呼び出しは、PreToolUse のフックが拒否する", async () => {
      const id = `PRP-${YEAR}-0104`;
      approvedProposal(id, "email_campaign", "segment:it-segment#it-slug");
      openPlane();
      const recorder = stepRecorder();
      script([
        init(),
        recorder.step(async (options) => {
          await recorder.guard(options, "mcp__mautic-prod__mautic_create_record", {
            resource: "emails",
            data: { ...templateEmailData({ name: "it", subject: "s", html: "<p>b</p>" }), isPublished: true },
          });
          await recorder.guard(options, "mcp__mautic-prod__mautic_create_record", { resource: "segments", data: { name: "it", isPublished: false } });
          await recorder.guard(options, "mcp__mautic-prod__mautic_create_record", { resource: "emails", data: { ...templateEmailData({ name: "it", subject: "s", html: "<p>b</p>" }), emailType: "list", lists: [1] } });
          await recorder.guard(options, "mcp__strapi-prod__create_article", { data: { title: "t", publishedAt: new Date().toISOString() } });
          await recorder.guard(options, "mcp__strapi-prod__publish_article", { documentId: "abc" });
        }),
        result(`SUMMARY: 守りに止められたため止めた\nTARGET_IDS: ${id}`),
      ]);
      const run = await runJob("cycle-campaign");
      recorder.assertClean();
      expect(run).toMatchObject({ trigger: "proposal", agentName: "campaign-planner" });
      const decisions = recorder.guards.map(({ output }) => (output as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput);
      expect(decisions.map((d) => d?.permissionDecision)).toEqual(["deny", "deny", "deny", "deny", "deny"]);
      expect(decisions[0]!.permissionDecisionReason).toMatch(/isPublished false/);
      expect(decisions[1]!.permissionDecisionReason).toMatch(/only emails and campaigns/);
      expect(decisions[2]!.permissionDecisionReason).toMatch(/emailType template/);
      expect(decisions[3]!.permissionDecisionReason).toMatch(/drafts/);
      expect(decisions[4]!.permissionDecisionReason).toMatch(/publishing or deleting/);
    });

    it("入力: 承認済みで未着手の E-13 が無ければ、作用のジョブはエージェントを起動せずに見送る", async () => {
      openPlane();
      const { runId, accepted } = await plane.runNow({ target: { kind: "job", jobId: "cycle-apply-content" } });
      expect(accepted).toBe(false);
      expect(await waitFinished(plane, runId)).toMatchObject({ outcome: "skipped", skipReason: "承認済みで未着手の E-13 が無い" });
      expect(sdk.query).not.toHaveBeenCalled();
    });

    it("サーバ: 作用のジョブのエージェントが異常終了すると、準備中の項目は確かめられなかった（failed_check）になり、差し戻すと同じ E-13 は選び直されない", async () => {
      const id = `PRP-${YEAR}-0105`;
      approvedProposal(id, "content_rewrite");
      openPlane();
      script([init()], { throwAfter: new Error("it: claude の子プロセスが異常終了した") });
      const failed = await runJob("cycle-apply-content");
      expect(failed).toMatchObject({ outcome: "failure", trigger: "proposal" });

      const collected = await runJob("cycle-collect");
      const item = itemOf(await plane.getCycle(collected.targetIds[0]), "article", id);
      expect(item.state).toBe("failed_check");
      expect(item.stateReason).toMatch(/作用のジョブが「失敗」で終わった/);
      await expectInputError(plane.markCycleItemExecuted(item.itemId, ACTOR), /中身がまだ無い項目/);
      expect(itemOf(await plane.rejectCycleItem(item.itemId, "作り直さない", ACTOR), "article", id).state).toBe("rejected");

      const { runId, accepted } = await plane.runNow({ target: { kind: "job", jobId: "cycle-apply-content" } });
      expect(accepted).toBe(false);
      expect(await waitFinished(plane, runId)).toMatchObject({ outcome: "skipped", skipReason: "承認済みで未着手の E-13 が無い" });
      expect(sdk.query).toHaveBeenCalledTimes(1);
    });

    it("サーバ: Strapi に届かないと、cycle-collect は partial（unreachable）で記事の項目は準備中のまま。ほかの項目は集める", async () => {
      const id = `PRP-${YEAR}-0106`;
      approvedProposal(id, "content_rewrite");
      writeAt(
        fx.main,
        `docs/proposals/PRP-${YEAR}-0107.md`,
        cycleProposalText({ id: `PRP-${YEAR}-0107`, kind: "config_change", identifier: "x", description: "設定を変える", evidence: EVIDENCE, state: "approved", approvedBy: { prNumber: 93, decidedAt: new Date().toISOString() } }),
      );
      openPlane({ CONTROL_STRAPI_URL: CLOSED_PORT_URL });
      expect((await runAction("cycle-apply-content", `SUMMARY: 下書きを作った\nCREATED: article=itNoSuchDocument01\nTARGET_IDS: ${id}`)).outcome).toBe("success");

      const collected = await runJob("cycle-collect", 120_000);
      expect(collected).toMatchObject({ outcome: "partial", failureClass: "unreachable" });
      const view = await plane.getCycle(collected.targetIds[0]);
      expect(itemOf(view, "article", id)).toMatchObject({ state: "preparing", preview: { kind: "pending" } });
      expect(itemOf(view, "manual", `PRP-${YEAR}-0107`).state).toBe("awaiting_review");
    });

    it("サーバ: Mautic に届かないと、キャンペーンの項目は準備中のまま（cycle-collect は partial）", async () => {
      const id = `PRP-${YEAR}-0108`;
      const documentId = await createDraftArticle({ title: `${RUN_ID} キャンペーンの記事`, slug: `${RUN_ID}-nomautic`, description: "キャンペーンの記事", body: "本文" });
      try {
        approvedProposal(id, "email_campaign", "segment:it-segment#it-slug");
        openPlane({ CONTROL_MAUTIC_URL: CLOSED_PORT_URL });
        const run = await runAction("cycle-campaign", `SUMMARY: 一式を作った\nCREATED: article=${documentId}\nCREATED: email=999999\nCREATED: campaign=999999\nTARGET_IDS: ${id}`);
        expect(run.outcome).toBe("success");
        const collected = await runJob("cycle-collect", 120_000);
        expect(collected).toMatchObject({ outcome: "partial", failureClass: "unreachable" });
        expect(itemOf(await plane.getCycle(collected.targetIds[0]), "campaign", id)).toMatchObject({ state: "preparing", preview: { kind: "pending" } });
      } finally {
        await deleteArticle(documentId);
      }
    });

    it("サーバ: GitHub が 5xx を返すあいだは改修案の項目を作らず（partial）、戻れば次の cycle-collect で作る", async () => {
      const id = `PRP-${YEAR}-0109`;
      writeAt(fx.worktree, `docs/proposals/${id}.md`, cycleProposalText({ id, kind: "technical_seo", identifier: "url_path=/", description: "canonical を直す", evidence: EVIDENCE, diffRef: "PR #1" }));
      github.addPull({ number: 1, head: `13-feature-proposal-${id}`, base: "main", title: "t", body: "b", state: "open" });
      github.fail((request) => request.method === "GET" && request.path === "/pulls/1", { status: 502 });
      openPlane();
      const failed = await runJob("cycle-collect", 120_000);
      expect(failed.outcome).toBe("partial");
      expect(failed.failureClass).not.toBeNull();
      expect((await plane.getCycle(failed.targetIds[0])).items.filter((item) => item.kind === "proposal")).toEqual([]);

      github.clearFaults();
      expect((await runJob("cycle-collect")).outcome).toBe("success");
      expect(itemOf(await plane.getCycle(failed.targetIds[0]), "proposal", id).preview).toMatchObject({ prNumber: 1, prState: "open" });
    });

    it("サーバ: 公開サイトが配信の前・前のビルドのまま・障害のあいだは配信を確かめられず（failed_check）、配信し直して押し直すと確かめられる", async () => {
      const { cycleId, item } = await deployItem();
      const preview = item.preview.kind === "deploy" ? item.preview : null;
      await plane.approveCycleItem(item.itemId, allChecks(item), ACTOR, item.updatedAt);

      // 配信の前（何も置いていない）
      await plane.markCycleItemExecuted(item.itemId, ACTOR);
      expect((await waitItemState(cycleId, item.itemId, "failed_check")).stateReason).toMatch(/_build\.json を読めなかった/);

      // 前のビルドのまま（ビルドの印のコミットが違う）
      const stale = join(fx.root, "stale-dist");
      writeAt(stale, "_build.json", JSON.stringify({ commit: "0".repeat(40) }));
      site.deploy(stale);
      await plane.markCycleItemExecuted(item.itemId, ACTOR);
      expect((await waitItemState(cycleId, item.itemId, "failed_check")).stateReason).toMatch(/0000000）が項目のコミット/);

      // 公開サイトの障害（503）
      site.deploy(preview!.distPath);
      site.fail(503);
      await plane.markCycleItemExecuted(item.itemId, ACTOR);
      expect((await waitItemState(cycleId, item.itemId, "failed_check")).stateReason).toMatch(/_build\.json を読めなかった/);
      // failed_check の配信の項目には、差し戻さずに押し直す案内が出る
      expect(itemOf(await plane.getCycle(cycleId), "deploy").steps[0]!.text).toMatch(/差し戻さずに（failed_check のまま）/);

      // 戻った後に押し直すと確かめられる
      site.fail(null);
      await plane.markCycleItemExecuted(item.itemId, ACTOR);
      await waitItemState(cycleId, item.itemId, "confirmed");
      expect(itemOf(await plane.getCycle(cycleId), "deploy").approvals.map((a) => a.action)).toEqual(["approve", "execute", "execute", "execute", "execute"]);
    });

    it("サーバ: Lighthouse の SEO が 1.0 未満なら、配信の項目は配信できない（OK を拒み、配信のコマンドを出さない）", async () => {
      setScores(fx, { performance: 0.9, accessibility: 1, "best-practices": 1, seo: 0.92 });
      const { item, check } = await deployItem();
      expect(check.summary).toContain("SEO 0.92。配信を止める");
      expect(item).toMatchObject({ state: "awaiting_review", steps: [] });
      expect(item.preview).toMatchObject({ kind: "deploy", blocked: "SEO が 0.92（1.0 未満）のため、配信の手順を出さない", lighthouse: { seo: 0.92 } });
      await expectInputError(plane.approveCycleItem(item.itemId, allChecks(item), ACTOR, item.updatedAt), /配信できない項目は承認できない/);
      // OK できないので、配信のコマンド（aws s3 sync）は画面に出ない
      expect(itemOf(await plane.getCycle(), "deploy")).toMatchObject({ state: "awaiting_review", approvals: [], steps: [] });
    });

    it("サーバ: OpenAI が 429 を返すと、article-cover は rate_limited で失敗し、Strapi に画像を上げない（再試行もしない）", async () => {
      const title = `${RUN_ID} 生成に失敗する記事`;
      const documentId = await createDraftArticle({ title, slug: `${RUN_ID}-ratelimit`, description: "生成に失敗する記事", body: "本文" });
      try {
        openai.generate.mockImplementation(async () => {
          throw new openaiErrors.APIError(429, "Rate limit reached");
        });
        openPlane();
        const runs = await runCoverUntilReached([title]);
        // どの実行も、生成が 1 枚も成功しないので failure（rate_limited）
        for (const run of runs) expect(run).toMatchObject({ outcome: "failure", failureClass: "rate_limited" });
        expect(runs.at(-1)!.summary).toMatch(/結んだ 0・結び待ち 0/);
        expect(openai.clients.every((client) => client.maxRetries === 0)).toBe(true);
        expect(await articleCover(documentId, "draft")).toBeNull();
        expect(e15Bytes(fx)).not.toContain("Rate limit reached");
      } finally {
        await deleteArticle(documentId);
      }
    });

    it("サーバ: 反映 0 件で期間が終わった周は、cycle-close が止まった場所を SNS で知らせて閉じる（期間の途中では閉じない）", async () => {
      const id = `PRP-${YEAR}-0110`;
      writeAt(fx.worktree, `docs/proposals/${id}.md`, cycleProposalText({ id, kind: "technical_seo", identifier: "url_path=/", description: "canonical を直す", evidence: EVIDENCE }));
      openPlane();
      const cycleId = (await runJob("cycle-collect")).targetIds[0]!;
      expect(itemOf(await plane.getCycle(cycleId), "proposal", id).state).toBe("awaiting_review");

      // 期間の途中: 手で起動しても閉じない（閉じると取り消せない）
      expect(await runJob("cycle-close")).toMatchObject({ outcome: "skipped" });
      expect((await plane.listCycles())[0]).toMatchObject({ cycleId, closedAt: null });

      const view = await plane.getCycle(cycleId);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(Date.parse(view.cycle!.endsAt) + 5 * 60_000));
      const closed = await runJob("cycle-close");
      vi.useRealTimers();
      expect(closed.outcome).toBe("success");
      expect(closed.summary).toContain("反映 0 件の知らせを送った");
      expect(snsPublishes()).toEqual([
        expect.objectContaining({
          TopicArn: ALERT_TOPIC,
          Subject: ZERO_REFLECTION_SUBJECT,
          Message: expect.stringMatching(new RegExp(`PR が承認されていない: 1[\\s\\S]*画面: ${LINK_BASE}/cycle/${cycleId}`)),
        }),
      ]);
      const row = (await plane.listCycles()).find((candidate) => candidate.cycleId === cycleId)!;
      expect(row.closedAt).not.toBeNull();
      expect(row.close).toEqual({
        reflectedFromProposals: 0,
        reflectedFromKeywords: 0,
        stuck: { no_proposal: 0, pr_not_approved: 1, awaiting_review: 0, not_executed: 0, not_deployed: 0 },
      });
    });

    it("サーバ: 反映 0 件の知らせを SNS に送れなくても周は閉じ、送れなかったことを要約に残す", async () => {
      aws.snsSend.mockImplementation(async () => {
        throw awsError("AuthorizationErrorException", 403);
      });
      openPlane();
      const view = await plane.startCycle(ACTOR);
      const cycleId = view.cycle!.cycleId;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(Date.parse(view.cycle!.endsAt) + 5 * 60_000));
      const closed = await runJob("cycle-close");
      vi.useRealTimers();
      expect(closed.outcome).toBe("success");
      expect(closed.summary).toMatch(/反映 0 件の知らせを送れなかった/);
      expect(aws.snsSend).toHaveBeenCalledTimes(1);
      const row = (await plane.listCycles()).find((candidate) => candidate.cycleId === cycleId)!;
      expect(row.closedAt).not.toBeNull();
      expect(row.close?.stuck.no_proposal).toBe(1);
    });
  });
});
