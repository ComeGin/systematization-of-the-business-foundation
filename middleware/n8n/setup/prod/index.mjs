// n8n（本番。オンプレ。http://127.0.0.1:5679。ADR-21）の設定。setup/lib/core.mjs の契約に従う。--target prod だけ。
//
// やること（開発のモジュール ../index.mjs の関数と、provision.mjs をそのまま使う）:
//   オーナー（未作成なら作る。パスワードは prod の状態の N8N_OWNER_PASSWORD）→ 公開 API のキー（N8N_API_KEY）→ MCP のアクセストークン
//   （N8N_PROD_TOKEN。mcp-prod が n8n-prod.env に書く）→ provision（Data Table・Mautic と Chatwoot の Webhook〈送り先は WireGuard 越しの
//   http://10.99.0.2:5680/webhook/...〉・資格情報・ワークフローの取り込みと子の公開）
// 以前は setup.mjs に入っておらず、人が middleware/n8n/provision/provision.mjs --target prod を別に実行していた（docs/runbooks/00-setup-overview.md の P9）。
//
// 人が行うもの（止まって案内する）:
//   - n8n 用の Mautic の API 認証情報（N8N_MAUTIC_CLIENT_ID・SECRET。エージェント用〈mcp-prod〉・参照専用・初期設定用とは別に作る。
//     片方を失効しても、もう片方を止めないため。setup/manual-steps.md の 8.2 と同じ考え方）
//   - Chatwoot の管理者のトークン（CHATWOOT_ADMIN_TOKEN。Webhook の作成と secret の取得に要る。chatwoot-prod と同じ値）
//   - SNS とハートビート用の IAM ユーザー（親の出力 OnpremN8nSnsUserName）のアクセスキー（AWS_ACCESS_KEY_ID・AWS_SECRET_ACCESS_KEY。
//     cloud/README.md の 4.5。このモジュールは、そのキーがこのユーザーのものかを iam list-access-keys で確かめる〈別の強い権限のキーを入れさせない〉）
//   - 親（I-11・I-12）の公開は R1 の判断（prod.conf の N8N_PUBLISH_PARENTS=true。既定は未公開）
//   - ハートビートの有効化（ops_settings の heartbeatEnabled を true にしてワークフローを公開する）は人。アラームの状態を見て警告だけ出す
// AWS には読み取りだけ（cloudformation describe-stacks・iam list-access-keys・cloudwatch describe-alarms）。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { awsJson, ENV_NAME, outputOf, REGION, requireMainStack } from "../../../../cloud/setup/aws.mjs";
import { buildConf, provision } from "../../provision/provision.mjs";
import { apiKeyWorks, ensureApiKey, ensureMcpToken, healthy, mcpWorks, openSession } from "../index.mjs";

export const meta = { id: "n8n-prod", title: "n8n（本番。オンプレ。オーナー・API キー・MCP・provision）", targets: ["prod"], phases: ["apps"], after: ["onprem", "chatwoot-prod", "mautic-prod"] };

const BASE = "http://127.0.0.1:5679";
const HEARTBEAT_ALARM = `comegin-${ENV_NAME}-onprem-n8n-schedule-heartbeat`;
// 本番に取り込むワークフロー（provision.mjs の WORKFLOWS の prod。名前の先頭で見る。ops-monitor は開発だけ）
const PROD_WORKFLOWS = ["I-21", "I-19", "I-11", "I-12", "I-18", "週次 問い合わせの棚卸し", "n8n スケジュール実行のハートビート"];
// provision に設定（prod.conf）から同じ名前で渡してよいキー（既定値の上書き）
const PASS_THROUGH = ["MAUTIC_API_URL", "MAUTIC_URL_FROM_N8N", "MAUTIC_WEBHOOK_TARGET", "CHATWOOT_API_URL", "CHATWOOT_URL_FROM_N8N", "CHATWOOT_WEBHOOK_TARGET", "CHATWOOT_N8N_API_TOKEN", "AWS_REGION"];

/** n8n 用の Mautic の API 認証情報。ほかの用途の認証情報と同じ値は失敗にする（分けた意味が無くなる） */
function mauticProblems(ctx) {
  const id = ctx.conf.N8N_MAUTIC_CLIENT_ID;
  const p = [];
  if (!id || !ctx.conf.N8N_MAUTIC_CLIENT_SECRET) p.push("N8N_MAUTIC_CLIENT_ID・N8N_MAUTIC_CLIENT_SECRET が prod.conf に無い");
  for (const other of ["MAUTIC_CLIENT_ID", "MAUTIC_RO_CLIENT_ID", "MAUTIC_SETUP_CLIENT_ID"]) if (id && id === ctx.conf[other]) p.push(`N8N_MAUTIC_CLIENT_ID が ${other} と同じ（n8n 用に別の認証情報を作る）`);
  return p;
}

function mauticSteps(ctx, problems) {
  return [
    `足りないもの: ${problems.join("／")}`,
    `本番の Mautic（${ctx.conf.MAUTIC_BASE_URL || "https://mkt.comegin.com"}）に管理者でログインし、設定 > API 認証情報 > 新規 で OAuth 2 の認証情報を作る（名前 comegin-prod-n8n。リダイレクト URI は http://localhost。上流の権限は作った管理者のものになる。setup/manual-steps.md の 2・8.2）`,
    "Public Key と Secret Key を ~/.config/comegin/setup/prod.conf の N8N_MAUTIC_CLIENT_ID=・N8N_MAUTIC_CLIENT_SECRET= に書く（エージェント用の MAUTIC_CLIENT_*・参照専用の MAUTIC_RO_CLIENT_*・初期設定用の MAUTIC_SETUP_CLIENT_* とは別の値）",
    "同じコマンドを実行し直す",
  ];
}

/** SNS とハートビート用のキーが、そのための IAM ユーザーのもので有効か。問題があれば文を返す */
async function awsKeyProblem(ctx, main) {
  const user = outputOf(main, "OnpremN8nSnsUserName");
  if (!ctx.conf.AWS_ACCESS_KEY_ID || !ctx.conf.AWS_SECRET_ACCESS_KEY) return `AWS_ACCESS_KEY_ID・AWS_SECRET_ACCESS_KEY が prod.conf に無い（IAM ユーザー ${user} のキー）`;
  const keys = (await awsJson(ctx, ["iam", "list-access-keys", "--user-name", user]))?.AccessKeyMetadata ?? [];
  const key = keys.find((k) => k.AccessKeyId === ctx.conf.AWS_ACCESS_KEY_ID);
  if (!key) return `prod.conf の AWS_ACCESS_KEY_ID は IAM ユーザー ${user} のキーではない（n8n には SNS への発行とハートビートだけの権限のキーを入れる）`;
  if (key.Status !== "Active") return `prod.conf の AWS_ACCESS_KEY_ID は ${user} のキーだが ${key.Status}（有効なキーを入れる）`;
  return null;
}

function awsKeySteps(main, problem) {
  const user = outputOf(main, "OnpremN8nSnsUserName");
  return [
    problem,
    `人が自分の端末でキーを発行する（AWS への書き込み。画面に出さずファイルに直接書く）: ( umask 077; aws iam create-access-key --user-name ${user} --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text > ~/n8n-sns.key )（リポジトリの外に作る。cloud/README.md の 4.5）`,
    "中身（アクセスキー ID<タブ>シークレット）を ~/.config/comegin/setup/prod.conf の AWS_ACCESS_KEY_ID=・AWS_SECRET_ACCESS_KEY= にエディタで写し、shred -u ~/n8n-sns.key で消す",
    "同じコマンドを実行し直す（provision が n8n の資格情報「AWS SNS 発行（アクセスキー）」に入れる）",
  ];
}

async function heartbeatState(ctx) {
  const r = await awsJson(ctx, ["cloudwatch", "describe-alarms", "--region", REGION, "--alarm-names", HEARTBEAT_ALARM]);
  return r?.MetricAlarms?.[0]?.StateValue ?? null;
}

const HEARTBEAT_HINT = `n8n の画面（${BASE}）で Data Table ops_settings の heartbeatEnabled を true にし、「n8n スケジュール実行のハートビート」を公開する（middleware/n8n/workflows/GUIDE.md の 9.7）→ アラーム ${HEARTBEAT_ALARM} が OK に戻り、復旧の通知が comegin-ops-alert に届くことを確かめる（cloud/README.md の 4.10）`;

async function workflowNames(ctx, apiKey) {
  const list = await ctx.http("本番の n8n", `${BASE}/api/v1/workflows?limit=250`, { headers: { "X-N8N-API-KEY": apiKey } }).catch(() => null);
  return (list?.data ?? []).filter((w) => !w.isArchived).map((w) => w.name);
}

export async function check(ctx) {
  const notes = [];
  let ok = true;
  const mark = (cond, good, bad) => {
    notes.push(cond ? good : bad);
    if (!cond) ok = false;
  };
  const up = await healthy(ctx, BASE);
  mark(up, `本番の n8n（${BASE}/healthz）が応答している`, `本番の n8n（${BASE}/healthz）が応答しない（onprem の手順で WireGuard → Strapi → n8n の順に上げる。onprem/README.md）`);
  if (!up) return { ok, notes };
  const settings = await ctx.http("本番の n8n", `${BASE}/rest/settings`).catch(() => null);
  mark(settings?.data?.userManagement?.showSetupOnFirstLoad === false, "オーナー: 作成済み", "オーナー: まだ（apply で作る）");
  const apiKey = ctx.value("N8N_API_KEY");
  const apiOk = await apiKeyWorks(ctx, apiKey, BASE);
  mark(apiOk, "N8N_API_KEY（公開 API）: 使える", `N8N_API_KEY（公開 API）: ${apiKey ? "使えない（apply で作り直す）" : "まだ"}`);
  const mcpOk = await mcpWorks(ctx, ctx.value("N8N_PROD_TOKEN"), BASE);
  mark(mcpOk, "N8N_PROD_TOKEN（MCP）: 使える", `N8N_PROD_TOKEN（MCP）: ${ctx.value("N8N_PROD_TOKEN") ? "使えない（apply で作り直す）" : "まだ"}`);
  if (apiOk) {
    const names = await workflowNames(ctx, apiKey);
    const lack = PROD_WORKFLOWS.filter((p) => !names.some((n) => n.startsWith(p)));
    mark(lack.length === 0, `ワークフロー: ${PROD_WORKFLOWS.length} 本が取り込み済み`, `ワークフロー: ${lack.join("・")} が無い（apply で provision する）`);
  }
  for (const p of mauticProblems(ctx)) mark(false, "", p);
  mark(Boolean(ctx.conf.CHATWOOT_ADMIN_TOKEN), "CHATWOOT_ADMIN_TOKEN がある（Webhook の作成に使う）", "CHATWOOT_ADMIN_TOKEN が prod.conf に無い（provision が Chatwoot の Webhook を作る・そろえるのに要る）");
  if (!ctx.conf.CHATWOOT_N8N_API_TOKEN) notes.push("! CHATWOOT_N8N_API_TOKEN が空（週次の棚卸しに管理者のトークンが入る。会話を読むだけのユーザーのトークンを勧める）");
  try {
    const main = await requireMainStack(ctx);
    const p = await awsKeyProblem(ctx, main);
    mark(!p, "SNS とハートビート用の IAM のキーは、そのユーザーの有効なキー", p);
    const hb = await heartbeatState(ctx);
    if (hb !== "OK") notes.push(`! アラーム ${HEARTBEAT_ALARM} が ${hb ?? "見つからない"}（ハートビートが届いていない。${HEARTBEAT_HINT}）`);
  } catch (e) {
    mark(false, "", `AWS を確かめられない（${e.message.split("\n")[0]}）`);
  }
  if (ctx.conf.N8N_PUBLISH_PARENTS !== "true") notes.push("親（I-11・I-12）は未公開のまま取り込む（公開は R1 の判断。prod.conf の N8N_PUBLISH_PARENTS=true）");
  return { ok, notes };
}

export async function apply(ctx) {
  if (!(await healthy(ctx, BASE))) throw new Error(`本番の n8n（${BASE}/healthz）が応答しない。先に onprem の手順で WireGuard → Strapi → n8n の順に上げる（onprem/README.md の「起動の順番」）`);
  ctx.log("本番の n8n が応答している");

  // 1. 値の確かめ（ログインやキーの作成より前に、人が書く値を全部そろえてもらう）
  const mp = mauticProblems(ctx);
  if (mp.length) ctx.manual("mautic-api-credentials", "n8n 用の Mautic の API 認証情報を作って prod.conf に書く", mauticSteps(ctx, mp));
  if (!ctx.conf.CHATWOOT_ADMIN_TOKEN) {
    ctx.manual("chatwoot-admin-token", "Chatwoot の管理者のトークンを prod.conf に書く（provision が Webhook を作る・そろえるのに要る）", [
      "本番の Chatwoot の管理者のプロフィール設定のアクセストークンを ~/.config/comegin/setup/prod.conf の CHATWOOT_ADMIN_TOKEN= に書く（chatwoot-prod の初期設定の後に消した場合は、この実行の間だけ戻す）",
      "任意: 週次の棚卸し用に、会話を読むだけのユーザーのトークンを CHATWOOT_N8N_API_TOKEN= に書く（空なら管理者のトークンが n8n に入る）",
      "同じコマンドを実行し直す",
    ]);
  }
  const main = await requireMainStack(ctx);
  const keyProblem = await awsKeyProblem(ctx, main);
  if (keyProblem) ctx.manual("aws-key", "SNS とハートビート用の IAM ユーザーのアクセスキーを prod.conf に書く", awsKeySteps(main, keyProblem));

  // 2. オーナー・公開 API のキー・MCP のトークン（状態か設定に値があって通るなら、ログインしない）
  let apiKey = ctx.value("N8N_API_KEY");
  let mcpToken = ctx.value("N8N_PROD_TOKEN");
  const apiOk = await apiKeyWorks(ctx, apiKey, BASE);
  const mcpOk = await mcpWorks(ctx, mcpToken, BASE);
  let session;
  const restSession = async () => (session ??= await openSession(ctx, BASE));
  if (!apiOk) apiKey = await ensureApiKey(ctx, await restSession(), BASE);
  if (!mcpOk) mcpToken = await ensureMcpToken(ctx, await restSession(), { base: BASE, tokenKey: "N8N_PROD_TOKEN", envFile: "n8n-prod.env" });
  ctx.state.set("N8N_API_KEY", apiKey, { secret: true });
  ctx.state.set("N8N_PROD_TOKEN", mcpToken, { secret: true });
  ctx.log(`N8N_API_KEY と N8N_PROD_TOKEN: ${apiOk && mcpOk ? "使える状態" : "用意した（prod の状態。N8N_PROD_TOKEN は mcp-prod が n8n-prod.env に書く）"}`);
  if (!mcpOk && existsSync(join(ctx.CONFIG_DIR, "mcp", "n8n-prod.env"))) ctx.warn("MCP のトークンが変わった。mcp-prod が n8n-prod.env を書き直すまで、本番の n8n の MCP は前のトークンのまま（続けて実行すれば書き直す）");

  // 3. provision（SNS のトピックは本番スタックの出力から）
  const values = {
    N8N_BASE_URL: BASE,
    N8N_API_KEY: apiKey,
    MAUTIC_CLIENT_ID: ctx.conf.N8N_MAUTIC_CLIENT_ID,
    MAUTIC_CLIENT_SECRET: ctx.conf.N8N_MAUTIC_CLIENT_SECRET,
    CHATWOOT_API_ACCESS_TOKEN: ctx.conf.CHATWOOT_ADMIN_TOKEN,
    CHATWOOT_ACCOUNT_ID: ctx.require("CHATWOOT_ACCOUNT_ID", "chatwoot-prod の値（prod.conf）。先に chatwoot-prod を済ませる"),
    AWS_ACCESS_KEY_ID: ctx.conf.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: ctx.conf.AWS_SECRET_ACCESS_KEY,
    SNS_TOPIC_ARN_LEAD: outputOf(main, "LeadAlertTopicArn"),
    SNS_TOPIC_ARN_OPS: outputOf(main, "OpsAlertTopicArn"),
  };
  // Mautic の既定の接続先は provision の既定（https://mkt.comegin.com）。prod.conf の MAUTIC_BASE_URL を変えているなら合わせる
  if (ctx.conf.MAUTIC_BASE_URL) values.MAUTIC_API_URL = values.MAUTIC_URL_FROM_N8N = ctx.conf.MAUTIC_BASE_URL;
  if (ctx.conf.CHATWOOT_BASE_URL) values.CHATWOOT_API_URL = values.CHATWOOT_URL_FROM_N8N = ctx.conf.CHATWOOT_BASE_URL;
  for (const k of PASS_THROUGH) if (ctx.conf[k]) values[k] = ctx.conf[k];
  const publish = ctx.conf.N8N_PUBLISH_PARENTS === "true";
  await provision({ target: "prod", conf: buildConf("prod", values), publish, restSession, io: { log: (m) => ctx.log(m.replace(/^\n/, "")), warn: ctx.warn } });
  if (!publish) ctx.log("親（I-11・I-12）は未公開。公開は R1 の判断（prod.conf に N8N_PUBLISH_PARENTS=true を書いて再実行するか、n8n の画面で Publish）");

  // 4. ハートビート（止めない。有効にするのは人）
  const hb = await heartbeatState(ctx);
  if (hb !== "OK") ctx.warn(`アラーム ${HEARTBEAT_ALARM} が ${hb ?? "見つからない"}。${HEARTBEAT_HINT}`);
  ctx.log("Mautic・Chatwoot の管理画面から Webhook を試し送信し、オンプレの n8n の Executions に届くことを確かめる（親を公開してから。onprem/README.md の「疎通の確かめ方」）");
}
