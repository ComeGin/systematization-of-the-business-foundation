// Chatwoot（本番。ECS の chatwoot-web。https://chat.comegin.com）の初期設定。setup/lib/core.mjs の契約に従う。--target prod だけ。
//
// 開発のモジュール（../index.mjs）の ensure* を、接続先（ctx.chatwootBase）と FAQ ボットの送り先（ctx.faqBotUrl）を差し替えてそのまま使う
// （受信箱・解決後は新しいチャット・受信箱のメンバー・FAQ のラベル・FAQ ボットと受信箱への接続・マクロ・引き継ぎのメール通知）。
// どれも Application API（/api/v1/accounts/*・/api/v1/profile。本番の ALB の機械向けのルール 201 を通る）だけで、AWS には書き込まない。
//
// 人が行うもの（止まって案内する）:
//   - 最初の管理者とアカウント（画面の onboarding。本番は rails runner を使わない）と、管理者のアクセストークンを prod.conf に書く
//   - エージェント専用ユーザー（担当者の権限。招待メールで確認する）とそのトークン（mcp-prod と同じ CHATWOOT_AGENT_TOKEN）
//   - FAQ ボットの access_token と secret を Secrets Manager に入れる（AWS への書き込み。cloud/README.md の 4.17）
// 作った受信箱の website_token は prod の状態（CHATWOOT_WEBSITE_TOKEN）に置く。公開サイトの本番のビルド（setup/frontend.mjs の verdant-virgo）がそれを読む。
import { ASK_RESOLVED_MACRO, FAQ_LABELS, HANDOFF_EMAIL_FLAG, ensureAskResolvedMacro, ensureFaqBot, ensureHandoffNotification, ensureInbox, ensureLabels, profile } from "../index.mjs";

export const meta = { id: "chatwoot-prod", title: "Chatwoot（本番。受信箱・FAQ ボット・ラベル・マクロ）", targets: ["prod"], after: [] };

const DEFAULT_BASE_URL = "https://chat.comegin.com";
const yes = (v) => /^(yes|true|1)$/i.test(String(v ?? "").trim());

/** prod.conf の値。足りないキーは missing に入れる */
function values(ctx) {
  const missing = [];
  const req = (key, hint) => {
    const v = ctx.conf[key];
    if (!v) missing.push(`${key}（${hint}）`);
    return v;
  };
  return {
    base: String(ctx.conf.CHATWOOT_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    adminToken: req("CHATWOOT_ADMIN_TOKEN", "本番の Chatwoot の管理者のアクセストークン〈プロフィール設定〉"),
    accountId: req("CHATWOOT_ACCOUNT_ID", "本番の Chatwoot のアカウントの数値 ID"),
    agentToken: req("CHATWOOT_AGENT_TOKEN", "エージェント専用ユーザー〈担当者の権限〉のアクセストークン。mcp-prod と同じ値"),
    siteUrl: req("PUBLIC_SITE_URL", "本番の公開サイトの URL。受信箱の website_url になる"),
    faqBotUrl: req("FAQ_BOT_WEBHOOK_URL", "親スタックの出力 FaqBotFunctionUrl の末尾に webhook を付けた URL"),
    missing,
  };
}

function problems(v) {
  const p = [];
  if (!/^https:\/\//.test(v.base)) p.push(`CHATWOOT_BASE_URL（${v.base}）が https ではない`);
  if (v.accountId && !/^\d+$/.test(v.accountId)) p.push("CHATWOOT_ACCOUNT_ID が数字ではない");
  if (v.siteUrl && !/^https:\/\//.test(v.siteUrl)) p.push(`PUBLIC_SITE_URL（${v.siteUrl}）が https ではない`);
  if (v.faqBotUrl && !/^https:\/\/[^/]+\.lambda-url\.[a-z0-9-]+\.on\.aws\/webhook$/.test(v.faqBotUrl))
    p.push("FAQ_BOT_WEBHOOK_URL が Lambda の関数 URL＋webhook（https://<id>.lambda-url.<region>.on.aws/webhook）の形ではない");
  return p;
}

function onboardingSteps(v) {
  return [
    `https://<ChatHost>（既定 ${v.base}）を開く。admin-auth（Google）でログインした後、Chatwoot の onboarding で最初の管理者とアカウントを作る（cloud/README.md の 4.10 で db:chatwoot_prepare を済ませ、chatwoot-web を起動してから）`,
    "管理者のプロフィール設定（左下のアバター → プロフィール設定）のアクセストークンを、~/.config/comegin/setup/prod.conf の CHATWOOT_ADMIN_TOKEN= に書く（chmod 600）。アカウントの数値 ID（URL の /app/accounts/<数字>/）を CHATWOOT_ACCOUNT_ID= に書く",
    "設定 → エージェント で、エージェント専用ユーザー（名前 AI エージェント、担当者の権限。メールは管理者の + 付きなど）を招待し、招待メールからパスワードを決めてログインする。そのユーザーのアクセストークンを CHATWOOT_AGENT_TOKEN= に書く（mcp-prod と同じ値。ADR-17）",
    "親スタックの出力 FaqBotFunctionUrl の末尾に webhook を付けた URL を FAQ_BOT_WEBHOOK_URL= に、本番の公開サイトの URL を PUBLIC_SITE_URL= に書く",
    "同じコマンドを実行し直す",
  ];
}

/** 本番の文脈。開発のモジュールの ensure* が読む状態のキーに、prod.conf の値を置く（prod の状態ファイル。600） */
async function prepare(ctx, v) {
  const admin = await profile({ ...ctx, chatwootBase: v.base }, v.adminToken);
  if (!admin) throw new Error("CHATWOOT_ADMIN_TOKEN で本番の Chatwoot に認証できない（401）。管理者のプロフィール設定のトークンを書き直す");
  const adminRole = (admin.accounts ?? []).find((a) => String(a.id) === String(v.accountId))?.role;
  if (adminRole !== "administrator") throw new Error(`CHATWOOT_ADMIN_TOKEN のユーザーはアカウント ${v.accountId} の管理者ではない（role=${adminRole ?? "所属なし"}）`);
  const agent = await profile({ ...ctx, chatwootBase: v.base }, v.agentToken);
  if (!agent) throw new Error("CHATWOOT_AGENT_TOKEN で本番の Chatwoot に認証できない（401）");
  const agentRole = (agent.accounts ?? []).find((a) => String(a.id) === String(v.accountId))?.role;
  if (agentRole !== "agent") throw new Error(`CHATWOOT_AGENT_TOKEN のユーザーはアカウント ${v.accountId} の担当者（agent）ではない（role=${agentRole ?? "所属なし"}。ADR-17）`);

  ctx.state.set("CHATWOOT_ACCOUNT_ID", String(v.accountId));
  ctx.state.set("CHATWOOT_ADMIN_TOKEN", v.adminToken, { secret: true });
  ctx.state.set("CHATWOOT_AGENT_USER_ID", String(agent.id));
  return { ...ctx, chatwootBase: v.base, faqBotUrl: v.faqBotUrl };
}

function secretsSteps() {
  const put = (key, secret) =>
    `node setup/setup.mjs --target prod --show ${key} | tr -d '\\n' | aws secretsmanager put-secret-value --region ap-northeast-1 --secret-id comegin/prod/faq-bot/${secret} --secret-string file:///dev/stdin`;
  return [
    "FAQ ボットの access_token と secret を Secrets Manager に入れる（人が自分の端末で実行する。値は画面に出さず、パイプで渡す。--show は末尾に改行を付けるので tr で落とす。cloud/README.md の 4.17 の 3）:",
    put("CHATWOOT_FAQ_BOT_TOKEN", "CHATWOOT_BOT_TOKEN"),
    put("CHATWOOT_FAQ_BOT_SECRET", "CHATWOOT_BOT_SECRET"),
    "faq-bot は起動時に Secret を読む。入れた後の最初の呼び出しから使われる（コールドスタートのたびに読む）",
    "~/.config/comegin/setup/prod.conf に FAQ_BOT_SECRETS_STORED=yes を書き、同じコマンドを実行し直す",
  ];
}

export async function check(ctx) {
  const v = values(ctx);
  const notes = [];
  let ok = true;
  const mark = (cond, good, bad) => {
    notes.push(cond ? good : bad);
    if (!cond) ok = false;
  };
  mark(v.missing.length === 0, "prod.conf に本番の Chatwoot の値がそろっている", `prod.conf に無いキー: ${v.missing.join("・")}`);
  for (const p of problems(v)) mark(false, "", p);
  if (!ok) return { ok, notes };

  const c = { ...ctx, chatwootBase: v.base };
  const headers = { headers: { "api-access-token": v.adminToken } };
  const base = `${v.base}/api/v1/accounts/${v.accountId}`;
  try {
    const admin = await profile(c, v.adminToken);
    mark(Boolean(admin), "管理者のトークンは有効", "管理者のトークンが無効（401）");
    const inboxId = ctx.state.get("CHATWOOT_INBOX_ID");
    mark(Boolean(inboxId && ctx.state.has("CHATWOOT_WEBSITE_TOKEN")), `受信箱「Web サイト」がある（ID ${inboxId}）`, "受信箱「Web サイト」がまだ状態に無い（apply で作る）");
    if (inboxId) {
      const inbox = await ctx.http("本番の Chatwoot 受信箱", `${base}/inboxes/${inboxId}`, headers).catch(() => null);
      mark(inbox?.allow_messages_after_resolved === false, "解決後の書き込みは新しいチャットになる", "allow_messages_after_resolved が false でない");
      const bot = await ctx.http("本番の Chatwoot 受信箱のボット", `${base}/inboxes/${inboxId}/agent_bot`, headers).catch(() => null);
      mark(String(bot?.agent_bot?.id ?? "") === String(ctx.state.get("CHATWOOT_FAQ_BOT_ID") ?? "-"), "FAQ ボットは受信箱に接続済み", "FAQ ボットが受信箱に接続されていない");
      mark(bot?.agent_bot?.outgoing_url === v.faqBotUrl, "FAQ ボットの送り先は本番の faq-bot", `FAQ ボットの送り先が FAQ_BOT_WEBHOOK_URL と違う（${bot?.agent_bot?.outgoing_url ?? "不明"}）`);
    }
    const labels = await ctx.http("本番の Chatwoot ラベル一覧", `${base}/labels`, headers).catch(() => null);
    const titles = new Set((labels?.payload ?? []).map((l) => l.title));
    const missingLabels = FAQ_LABELS.map((l) => l.title).filter((t) => !titles.has(t));
    mark(missingLabels.length === 0, `FAQ のラベル ${FAQ_LABELS.length} つがある`, `FAQ のラベルが無い: ${missingLabels.join("・")}`);
    const macros = await ctx.http("本番の Chatwoot マクロ一覧", `${base}/macros`, headers).catch(() => null);
    mark((macros?.payload ?? []).some((m) => m.name === ASK_RESOLVED_MACRO.name), `マクロ「${ASK_RESOLVED_MACRO.name}」がある`, `マクロ「${ASK_RESOLVED_MACRO.name}」が無い`);
    const settings = await ctx.http("本番の Chatwoot 通知設定", `${base}/notification_settings`, headers).catch(() => null);
    mark((settings?.selected_email_flags ?? []).includes(HANDOFF_EMAIL_FLAG), "引き継ぎのメール通知は管理者に有効", "管理者の「新しい会話」のメール通知が無効（ほかの担当者は各自のプロフィールで有効にする）");
  } catch (e) {
    mark(false, "", e.status === 0 ? `本番の Chatwoot に届かない（${e.message}）` : e.message);
  }
  mark(yes(ctx.value("FAQ_BOT_SECRETS_STORED")), "FAQ ボットのトークンと secret は Secrets Manager に入れたと申告されている", "FAQ ボットのトークンと secret を Secrets Manager に入れたと申告されていない（FAQ_BOT_SECRETS_STORED=yes）");
  return { ok, notes };
}

export async function apply(ctx) {
  const v = values(ctx);
  if (v.missing.length) {
    ctx.warn(`prod.conf に無いキー: ${v.missing.join("・")}`);
    ctx.manual("onboarding", "本番の Chatwoot の管理者・エージェント専用ユーザーを作り、トークンと URL を prod.conf に書く", onboardingSteps(v));
  }
  const p = problems(v);
  if (p.length) throw new Error(`本番の Chatwoot の値に問題がある: ${p.join("／")}`);

  const c = await prepare(ctx, v);
  ctx.log(`本番の Chatwoot に管理者とエージェント専用ユーザーで認証できた（アカウント ${v.accountId}）`);
  await ensureInbox(c);
  await ensureLabels(c);
  await ensureFaqBot(c);
  await ensureAskResolvedMacro(c);
  await ensureHandoffNotification(c);
  ctx.log("受信箱の website_token を prod の状態に置いた（CHATWOOT_WEBSITE_TOKEN。node setup/frontend.mjs --target prod の .env.production が読む）");

  if (!yes(ctx.value("FAQ_BOT_SECRETS_STORED"))) ctx.manual("faq-bot-secrets", "FAQ ボットの access_token と secret を Secrets Manager に入れる", secretsSteps());
  ctx.log("FAQ ボットのトークンと secret は Secrets Manager に入れたと申告されている。ほかの担当者は、各自のプロフィールで「新しい会話が作成されたとき」のメール通知を有効にする（cloud/README.md の 4.17 の 7）");
}
