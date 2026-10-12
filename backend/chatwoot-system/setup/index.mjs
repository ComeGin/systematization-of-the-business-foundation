// Chatwoot（開発環境）の設定。環境変数の用意 → DB の準備 → 起動 → Webhook の私設アドレスへの送信の許可 → 管理者・アカウント → エージェント専用ユーザー → Web サイトの受信箱
// （解決後は新しいチャット・管理者もメンバー）→ FAQ ボット（ラベル・エージェントボット・受信箱への接続）→ マクロ「解決の確認を送る」→ 担当者への引き継ぎのメール通知（管理者）。
//
// 方針（setup/lib/core.mjs の契約）:
//   - 使うのは Chatwoot の公式の API（Application API）と、製品のモデルを通した rails runner だけ。SQL は書かない・画面は操作しない
//   - rails runner を使うのは、API では作れない 2 つだけ（どちらも `ENABLE_ACCOUNT_SIGNUP=false` の自己ホストでは画面〈/installation/onboarding〉か console でしかできない）
//       1. 最初の管理者（スーパー管理者）とアカウントの作成 … 画面の onboarding と同じ AccountBuilder を呼ぶ
//       2. エージェント専用ユーザーの確認済み化とパスワードの設定 … 招待メール（MailHog）を開かずにログインできるようにする
//   - 秘密値は rails runner の標準入力（JSON）で渡し、コマンドライン・ログには出さない。トークンは API のログインとプロフィールから取る
//
// 確かめた出典（動いているコンテナ chatwoot/chatwoot:v4.18.0 の中のソース）:
//   /app/config/routes.rb（/api、/auth/sign_in、/api/v1/profile、agents・inboxes・inbox_members、installation/onboarding）
//   /app/app/builders/account_builder.rb（管理者とアカウントの作成。onboarding 画面と同じ）
//   /app/app/controllers/installation/onboarding_controller.rb（終わったら Redis のキー CHATWOOT_INSTALLATION_ONBOARDING を消す）
//   /app/app/controllers/api/v1/accounts/{agents,inboxes,inbox_members}_controller.rb
//   /app/app/views/api/v1/models/_user.json.jbuilder（ログインとプロフィールの応答に access_token が入る）
//   /app/app/views/api/v1/models/_inbox.json.jbuilder（受信箱の応答に website_token が入る）
//   /app/lib/tasks/db_enhancements.rake（db:chatwoot_prepare）
//   /app/app/controllers/api/v1/accounts/agent_bots_controller.rb・views/api/v1/models/_agent_bot.json.jbuilder（管理者にだけ access_token と secret を返す）
//   /app/app/controllers/api/v1/accounts/inboxes_controller.rb（agent_bot・set_agent_bot）、views/api/v1/accounts/labels/index.json.jbuilder（payload）
//   /app/app/controllers/api/v1/accounts/macros_controller.rb・app/models/macro.rb（マクロ。一覧は payload、動作は ACTIONS_ATTRS の add_label）
import { join } from "node:path";

export const meta = { id: "chatwoot", title: "Chatwoot（問い合わせ窓口。開発環境）", targets: ["dev"], after: ["host-relay"] };

const DIR = "backend/chatwoot-system";
const BASE_URL = "http://127.0.0.1:3100"; // docker-compose.yaml の CHATWOOT_PORT 既定値（CLAUDE.md のポート表）
const DEFAULT_SITE_URL = "http://localhost:4321"; // 開発の公開サイト（Astro dev）
const INBOX_NAME = "Web サイト";
const AGENT_NAME = "AI エージェント";
const RESULT_MARK = "@@RESULT@@";
const FAQ_BOT_NAME = "FAQ ボット";
// faq-bot の開発サーバー（127.0.0.1:3107。backend/faq-bot の pnpm dev）に、host-relay 経由で届く
const FAQ_BOT_URL = "http://host.docker.internal:3107/webhook";
// FAQ ボットが会話に付けるラベル（docs/superpowers/specs/2026-10-11-faq-bot-design.md の 7.2）。conversation-triage の集計に使う
const FAQ_LABELS = [
  { title: "faq-answered", description: "FAQ ボットが FAQ で答えた会話", color: "#2E7D32" },
  { title: "faq-unmatched", description: "FAQ ボットが答えられず、担当者に引き継いだ会話", color: "#C62828" },
  { title: "faq-handoff", description: "訪問者が担当者への相談を選んだ会話", color: "#EF6C00" },
  { title: "faq-ask-resolved", description: "担当者が解決の確認を送るときに付ける（マクロ「解決の確認を送る」用。ボットがすぐ外して［解決しました］ボタンを送る）", color: "#1565C0" },
];
// 担当者が管理画面から［解決しました］ボタンを出すためのマクロ（docs/superpowers/specs/2026-10-12-faq-bot-ask-resolved-design.md）。中身はラベルを付けるだけ
const ASK_RESOLVED_MACRO = { name: "解決の確認を送る", visibility: "global", actions: [{ action_name: "add_label", action_params: ["faq-ask-resolved"] }] };
// ボットからの引き継ぎで Chatwoot が担当者に作る通知の種類（notification.rb の conversation_creation）のメールのフラグ
const HANDOFF_EMAIL_FLAG = "email_conversation_creation";

const cwd = (ctx) => join(ctx.W, DIR);
const compose = (ctx, args, opts = {}) => ctx.run("docker", ["compose", ...args], { cwd: cwd(ctx), ...opts });

const siteUrl = (ctx) => ctx.value("PUBLIC_SITE_URL") || DEFAULT_SITE_URL;
const agentEmail = (ctx) => {
  const explicit = ctx.value("CHATWOOT_AGENT_EMAIL");
  if (explicit) return explicit;
  const adminEmail = ctx.require("ADMIN_EMAIL");
  const at = adminEmail.lastIndexOf("@");
  return `${adminEmail.slice(0, at)}+ai-agent${adminEmail.slice(at)}`; // 管理者のメールの + 付き（同じ受信箱に届く）
};

// ---------------------------------------------------------------------------
// Chatwoot の API
// ---------------------------------------------------------------------------

const withToken = (token) => ({ headers: { api_access_token: token } });

async function apiOk() {
  const res = await fetch(`${BASE_URL}/api`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
  if (!res?.ok) return null;
  return res.json().catch(() => null);
}

/** トークンが有効ならプロフィールを返す。無効（401）なら null */
async function profile(ctx, token) {
  try {
    return await ctx.http("Chatwoot プロフィール", `${BASE_URL}/api/v1/profile`, withToken(token));
  } catch (e) {
    if (e.status === 401) return null;
    throw e;
  }
}

/** メールとパスワードでログインし、そのユーザーの access_token（api_access_token）を返す。失敗したら null */
async function signIn(ctx, email, password) {
  try {
    const body = await ctx.http("Chatwoot ログイン", `${BASE_URL}/auth/sign_in`, { method: "POST", json: { email, password } });
    const data = body?.data;
    if (!data?.access_token) throw new Error("Chatwoot ログイン: 応答に access_token が無い（アカウントの API が有効か確かめる）");
    return { token: data.access_token, userId: data.id, accountId: data.account_id };
  } catch (e) {
    if (e.status === 401) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// rails runner（製品のモデルを通す。入力は標準入力の JSON、結果は @@RESULT@@ の行）
// ---------------------------------------------------------------------------

// onboarding 画面（Installation::OnboardingController#create）と同じ AccountBuilder で、スーパー管理者とアカウントを作る
const ADMIN_RUBY = `
require 'json'
input = JSON.parse($stdin.read)
user = User.from_email(input['email'])
status = 'exists'
if user.nil?
  user, _account = AccountBuilder.new(
    account_name: input['account_name'], user_full_name: input['name'], email: input['email'],
    user_password: input['password'], super_admin: true, confirmed: true
  ).perform
  status = 'created'
elsif input['reset_password']
  user.update!(password: input['password'], password_confirmation: input['password'])
  status = 'password_reset'
end
# 画面の onboarding は、終わると誰でも管理者を作れる状態を閉じる（finish_onboarding）。同じ処理を、ユーザーがいるときは必ず行う
Redis::Alfred.delete(Redis::Alfred::CHATWOOT_INSTALLATION_ONBOARDING)
account_user = user.account_users.administrator.order(:account_id).first
puts "${RESULT_MARK}" + JSON.generate(status: status, user_id: user.id, account_id: account_user&.account_id)
`;

// API で作ったエージェントを確認済みにし、パスワードを設定する（招待メールの確認を経ずにログインできるようにする）
const AGENT_RUBY = `
require 'json'
input = JSON.parse($stdin.read)
user = User.from_email(input['email'])
raise 'エージェント専用ユーザーが見つからない' if user.nil?
account_user = AccountUser.find_by!(account_id: input['account_id'], user_id: user.id)
raise 'エージェント専用ユーザーが管理者になっている（agent の権限にする）' unless account_user.agent?
user.confirm unless user.confirmed?
user.update!(password: input['password'], password_confirmation: input['password'])
puts "${RESULT_MARK}" + JSON.generate(user_id: user.id)
`;

async function runner(ctx, ruby, input) {
  const out = await compose(ctx, ["exec", "-T", "rails", "bundle", "exec", "rails", "runner", ruby], { input: JSON.stringify(input) });
  const line = out.split("\n").find((l) => l.startsWith(RESULT_MARK));
  if (!line) throw new Error("rails runner の結果が読み取れない（スクリプトが途中で終わった。docker compose logs rails を見る）");
  return JSON.parse(line.slice(RESULT_MARK.length));
}

// ---------------------------------------------------------------------------
// 手順
// ---------------------------------------------------------------------------

async function composeImage(ctx) {
  const out = await compose(ctx, ["config", "--images"]);
  return out.split("\n").map((l) => l.trim()).find((l) => l.startsWith("chatwoot/chatwoot:")) ?? "unknown";
}

async function ensureStack(ctx) {
  await ctx.run("bash", [join(cwd(ctx), "dev/init-env.sh")], { cwd: cwd(ctx) }); // 冪等。値は表示しない

  // 初回とイメージ更新後は db:chatwoot_prepare が必須（entrypoint がマイグレーションしない）。済みの判定は「準備した時のイメージ」を状態に覚える
  const image = await composeImage(ctx);
  if (ctx.state.get("CHATWOOT_DB_PREPARED_IMAGE") !== image) {
    ctx.log(`db:chatwoot_prepare を実行（${image}）`);
    await compose(ctx, ["run", "--rm", "-T", "rails", "bundle", "exec", "rails", "db:chatwoot_prepare"]);
    ctx.state.set("CHATWOOT_DB_PREPARED_IMAGE", image);
  } else {
    ctx.log(`db:chatwoot_prepare は済み（${image}）`);
  }

  await compose(ctx, ["up", "-d"]);
  if (!(await ctx.waitForHttp(`${BASE_URL}/api`, { timeoutMs: 240_000 }))) throw new Error(`Chatwoot が ${BASE_URL} で応答しない。docker compose logs rails を見る（${DIR}）`);
  const info = await apiOk();
  if (info?.data_services !== "ok" || info?.queue_services !== "ok") throw new Error(`Chatwoot の DB か Redis に繋がっていない（/api の応答: data_services=${info?.data_services}, queue_services=${info?.queue_services}）`);
  ctx.log(`起動している（v${info.version}）`);
}

/** 動いている sidekiq（Webhook を送るジョブ）が、私設アドレスへの送信を許されているか */
async function privateNetworkAllowed(ctx) {
  const value = await compose(ctx, ["exec", "-T", "sidekiq", "printenv", "SAFE_FETCH_ALLOW_PRIVATE_NETWORK"]).catch(() => "");
  return value.trim() === "true";
}

// n8n の I-12 への Webhook（http://host.docker.internal:5678）は私設アドレスで、Chatwoot の SafeFetch（lib/safe_fetch.rb）は
// SAFE_FETCH_ALLOW_PRIVATE_NETWORK が true でないと送らずに終わる（Sidekiq のログに "has no public ip addresses"。再送もしない）。
// dev/init-env.sh が開発の既定値として .env に true を書く。環境変数は起動時にしか読まれないので、動いているコンテナが古い値のままなら作り直す
async function ensureWebhookEgress(ctx) {
  if (await privateNetworkAllowed(ctx)) {
    ctx.log("Webhook の私設アドレスへの送信は許可済み（SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true）");
    return;
  }
  ctx.log("rails と sidekiq を作り直す（SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true を反映する）");
  await compose(ctx, ["up", "-d", "--force-recreate", "rails", "sidekiq"]);
  if (!(await ctx.waitForHttp(`${BASE_URL}/api`, { timeoutMs: 240_000 }))) throw new Error(`Chatwoot が ${BASE_URL} で応答しない。docker compose logs rails を見る（${DIR}）`);
  if (!(await privateNetworkAllowed(ctx))) throw new Error(`sidekiq に SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true が入らない。${DIR}/.env の値を確かめる（dev/init-env.sh は値が空か false のときだけ書く）`);
  ctx.log("Webhook の私設アドレスへの送信を許可した");
}

async function ensureAdmin(ctx) {
  const email = ctx.require("ADMIN_EMAIL");
  const known = ctx.value("CHATWOOT_ADMIN_PASSWORD");

  // トークンが有効なら、管理者・アカウントは用意できている
  if (ctx.state.has("CHATWOOT_ADMIN_TOKEN") && ctx.state.has("CHATWOOT_ACCOUNT_ID")) {
    const me = await profile(ctx, ctx.state.get("CHATWOOT_ADMIN_TOKEN"));
    if (me) {
      ctx.log("管理者のトークンは有効");
      return;
    }
    ctx.warn("状態の管理者トークンが無効。ログインし直して取り直す");
  }

  const reset = String(ctx.value("CHATWOOT_RESET_ADMIN_PASSWORD") ?? "").toLowerCase() === "yes";
  const password = known || `1!aA${ctx.randomSecret(24)}`; // devise-secure_password: 大文字・小文字・数字・記号を各 1 以上
  const result = await runner(ctx, ADMIN_RUBY, {
    email,
    name: ctx.value("CHATWOOT_ADMIN_NAME") || "管理者",
    account_name: ctx.value("CHATWOOT_ACCOUNT_NAME") || "ComeGin",
    password,
    reset_password: !known && reset,
  });

  if (result.status === "created" || result.status === "password_reset") {
    ctx.state.set("CHATWOOT_ADMIN_PASSWORD", password, { secret: true });
    ctx.log(result.status === "created" ? "管理者とアカウントを作った（パスワードは `--show CHATWOOT_ADMIN_PASSWORD`）" : "管理者のパスワードを作り直した（`--show CHATWOOT_ADMIN_PASSWORD`）");
  } else if (!known) {
    // ユーザーはいるが、パスワードが分からない
    ctx.manual("admin-password", `Chatwoot に ${email} の管理者が既にいるが、そのパスワードをこのスクリプトが知らない`, [
      "管理者のパスワードを知っている場合: ~/.config/comegin/setup/dev.conf に CHATWOOT_ADMIN_PASSWORD=<そのパスワード> を書く（600）",
      "知らない、または作り直してよい場合: dev.conf に CHATWOOT_RESET_ADMIN_PASSWORD=yes を書く（管理者のパスワードを生成した値に変える。ほかの設定は変わらない）",
      "どちらかを書いたら、同じコマンドを実行し直す",
    ]);
  }

  // 設定に書いたパスワード（既存の管理者）か、上で状態に置いたパスワード（作成・作り直し）でログインする。設定が優先
  const login = await signIn(ctx, email, ctx.value("CHATWOOT_ADMIN_PASSWORD"));
  if (!login) throw new Error(`Chatwoot にログインできない（${email}）。設定の CHATWOOT_ADMIN_PASSWORD が違う可能性がある（分からなければ、その行を消して CHATWOOT_RESET_ADMIN_PASSWORD=yes）`);
  const accountId = result.account_id ?? login.accountId;
  if (!accountId) throw new Error(`${email} が管理者になっているアカウントが無い。Chatwoot の画面でアカウントを確かめる`);
  ctx.state.set("CHATWOOT_ADMIN_TOKEN", login.token, { secret: true });
  ctx.state.set("CHATWOOT_ACCOUNT_ID", String(accountId));
  ctx.log(`管理者のトークンを取った（アカウント ID ${accountId}）`);
}

async function ensureAgent(ctx) {
  const accountId = ctx.state.get("CHATWOOT_ACCOUNT_ID");
  const adminToken = ctx.state.get("CHATWOOT_ADMIN_TOKEN");
  const email = agentEmail(ctx);
  const base = `${BASE_URL}/api/v1/accounts/${accountId}`;

  // 既にトークンが有効で、ユーザーが一致していれば終わり
  if (ctx.state.has("CHATWOOT_AGENT_TOKEN") && ctx.state.has("CHATWOOT_AGENT_USER_ID")) {
    const me = await profile(ctx, ctx.state.get("CHATWOOT_AGENT_TOKEN"));
    if (me && String(me.id) === ctx.state.get("CHATWOOT_AGENT_USER_ID")) {
      ctx.log("エージェント専用ユーザーのトークンは有効");
      return;
    }
    ctx.warn("状態のエージェントのトークンが無効。取り直す");
  }

  const agents = await ctx.http("Chatwoot エージェント一覧", `${base}/agents`, withToken(adminToken));
  let agent = agents.find((a) => a.email?.toLowerCase() === email.toLowerCase());
  if (!agent) {
    agent = await ctx.http("Chatwoot エージェント作成", `${base}/agents`, { method: "POST", ...withToken(adminToken), json: { name: AGENT_NAME, email, role: "agent" } });
    ctx.log(`エージェント専用ユーザーを作った（${email}）`);
  } else if (agent.role !== "agent") {
    throw new Error(`${email} は agent の権限ではない（role=${agent.role}）。エージェント専用ユーザーは agent の権限にする（ADR-17）`);
  }

  // 確認済みにしてパスワードを設定 → ログインして access_token を取る。パスワードは使い捨て（状態に残さない）
  const password = `1!aA${ctx.randomSecret(24)}`;
  await runner(ctx, AGENT_RUBY, { email, account_id: Number(accountId), password });
  const login = await signIn(ctx, email, password);
  if (!login) throw new Error(`エージェント専用ユーザー（${email}）でログインできない`);
  ctx.state.set("CHATWOOT_AGENT_USER_ID", String(agent.id));
  ctx.state.set("CHATWOOT_AGENT_TOKEN", login.token, { secret: true });
  ctx.log(`エージェント専用ユーザーのトークンを取った（ユーザー ID ${agent.id}）`);
}

async function ensureInbox(ctx) {
  const accountId = ctx.state.get("CHATWOOT_ACCOUNT_ID");
  const adminToken = ctx.state.get("CHATWOOT_ADMIN_TOKEN");
  const agentId = Number(ctx.state.get("CHATWOOT_AGENT_USER_ID"));
  const base = `${BASE_URL}/api/v1/accounts/${accountId}`;
  const url = siteUrl(ctx);

  const list = await ctx.http("Chatwoot 受信箱一覧", `${base}/inboxes`, withToken(adminToken));
  const widgets = (list.payload ?? []).filter((i) => i.channel_type === "Channel::WebWidget");
  let inbox = widgets.find((i) => String(i.id) === ctx.state.get("CHATWOOT_INBOX_ID")) ?? widgets.find((i) => i.website_url === url) ?? widgets.find((i) => i.name === INBOX_NAME);
  if (!inbox) {
    inbox = await ctx.http("Chatwoot 受信箱作成", `${base}/inboxes`, { method: "POST", ...withToken(adminToken), json: { name: INBOX_NAME, channel: { type: "web_widget", website_url: url } } });
    ctx.log(`Web サイトの受信箱を作った（${url}）`);
  } else {
    ctx.log(`Web サイトの受信箱は既にある（ID ${inbox.id}）`);
  }
  ctx.state.set("CHATWOOT_INBOX_ID", String(inbox.id));
  ctx.state.set("CHATWOOT_WEBSITE_TOKEN", inbox.website_token);

  // 解決した会話に訪問者が書き込んでも同じ会話を開き直さず、ウィジェットに「新しいチャットを開始する」を出して新しい会話にする
  // （Chatwoot の既定は true。widget/messages_controller.rb の prevent_reply_to_resolved_conversation と ChatFooter.vue の hideReplyBox）
  if (inbox.allow_messages_after_resolved !== false) {
    await ctx.http("Chatwoot 受信箱の更新", `${base}/inboxes/${inbox.id}`, { method: "PATCH", ...withToken(adminToken), json: { allow_messages_after_resolved: false } });
    ctx.log("解決した会話への書き込みを止めた（ウィジェットに「新しいチャットを開始する」が出る）");
  }

  // 受信箱のメンバーにする:
  //   - エージェント専用ユーザー … agent の権限のユーザーは、所属した受信箱の会話しか見えない
  //   - 管理者（人の担当者）… ボットが担当者に引き継いだとき（pending → open）の Chatwoot の通知は、受信箱のメンバーにだけ届く
  //     （notification_listener.rb の conversation_bot_handoff は inbox.members に通知を作る。管理者でもメンバーでなければ届かない）
  const adminId = (await profile(ctx, adminToken))?.id;
  if (!adminId) throw new Error("管理者のトークンでプロフィールを読めない");
  const members = await ctx.http("Chatwoot 受信箱のメンバー", `${base}/inbox_members/${inbox.id}`, withToken(adminToken));
  const memberIds = (members.payload ?? members).map((m) => m.id);
  const missing = [agentId, adminId].filter((id) => !memberIds.includes(id));
  if (missing.length > 0) {
    // inbox_members の create は渡した user_ids を「追加」する（update は置き換え）
    await ctx.http("Chatwoot 受信箱のメンバー追加", `${base}/inbox_members`, { method: "POST", ...withToken(adminToken), json: { inbox_id: inbox.id, user_ids: missing } });
    ctx.log(`受信箱のメンバーに入れた（ユーザー ID ${missing.join("・")}）`);
  }
}

/**
 * ボットが担当者に引き継いだ会話（faq-handoff・faq-unmatched）を、担当者（管理者）にメールで知らせる。
 * 引き継ぎ（pending → open）で Chatwoot が作る通知は「新しい会話」（conversation_creation）なので、管理者のその通知のメールを有効にする。
 * 開発では Chatwoot の SMTP（MailHog）に届く。本番は各担当者がプロフィールの通知設定で有効にする（docs の手順）
 */
async function ensureHandoffNotification(ctx) {
  const url = `${BASE_URL}/api/v1/accounts/${ctx.state.get("CHATWOOT_ACCOUNT_ID")}/notification_settings`;
  const adminToken = ctx.state.get("CHATWOOT_ADMIN_TOKEN");
  const current = await ctx.http("Chatwoot 通知設定", url, withToken(adminToken));
  const email = current.selected_email_flags ?? [];
  if (email.includes(HANDOFF_EMAIL_FLAG)) {
    ctx.log("担当者への引き継ぎのメール通知は有効");
    return;
  }
  // update は email と push の両方を置き換えるので、今の値に足して送る
  await ctx.http("Chatwoot 通知設定の更新", url, {
    method: "PATCH",
    ...withToken(adminToken),
    json: { notification_settings: { selected_email_flags: [...email, HANDOFF_EMAIL_FLAG], selected_push_flags: current.selected_push_flags ?? [] } },
  });
  ctx.log("担当者への引き継ぎ（新しい会話）のメール通知を有効にした（開発は MailHog に届く）");
}

async function ensureLabels(ctx) {
  const base = `${BASE_URL}/api/v1/accounts/${ctx.state.get("CHATWOOT_ACCOUNT_ID")}`;
  const adminToken = ctx.state.get("CHATWOOT_ADMIN_TOKEN");
  const list = await ctx.http("Chatwoot ラベル一覧", `${base}/labels`, withToken(adminToken));
  const existing = new Set((list?.payload ?? []).map((label) => label.title));
  for (const label of FAQ_LABELS) {
    if (existing.has(label.title)) continue;
    await ctx.http("Chatwoot ラベル作成", `${base}/labels`, { method: "POST", ...withToken(adminToken), json: { ...label, show_on_sidebar: true } });
    ctx.log(`ラベル ${label.title} を作った`);
  }
}

/** エージェントボット「FAQ ボット」を作り（送り先は faq-bot の開発サーバー）、Web サイトの受信箱に接続する。トークンと secret は状態ファイルにだけ置く */
async function ensureFaqBot(ctx) {
  const base = `${BASE_URL}/api/v1/accounts/${ctx.state.get("CHATWOOT_ACCOUNT_ID")}`;
  const adminToken = ctx.state.get("CHATWOOT_ADMIN_TOKEN");

  const list = await ctx.http("Chatwoot エージェントボット一覧", `${base}/agent_bots`, withToken(adminToken));
  const own = (Array.isArray(list) ? list : (list?.payload ?? [])).filter((bot) => !bot.system_bot);
  let bot = own.find((b) => String(b.id) === ctx.state.get("CHATWOOT_FAQ_BOT_ID")) ?? own.find((b) => b.name === FAQ_BOT_NAME);
  if (!bot) {
    bot = await ctx.http("Chatwoot エージェントボット作成", `${base}/agent_bots`, {
      method: "POST",
      ...withToken(adminToken),
      json: { name: FAQ_BOT_NAME, description: "Web サイトの FAQ に答えるボット（backend/faq-bot）", outgoing_url: FAQ_BOT_URL },
    });
    ctx.log(`エージェントボット「${FAQ_BOT_NAME}」を作った`);
  } else if (bot.outgoing_url !== FAQ_BOT_URL) {
    bot = await ctx.http("Chatwoot エージェントボット更新", `${base}/agent_bots/${bot.id}`, { method: "PATCH", ...withToken(adminToken), json: { outgoing_url: FAQ_BOT_URL } });
    ctx.log(`エージェントボットの送り先を ${FAQ_BOT_URL} にした`);
  }
  // access_token と secret は管理者にだけ返る（_agent_bot.json.jbuilder）。表示しない
  if (!bot.access_token || !bot.secret) throw new Error("エージェントボットの access_token・secret が応答に無い（管理者のトークンで呼んでいるか確かめる）");
  ctx.state.set("CHATWOOT_FAQ_BOT_ID", String(bot.id));
  ctx.state.set("CHATWOOT_FAQ_BOT_TOKEN", bot.access_token, { secret: true });
  ctx.state.set("CHATWOOT_FAQ_BOT_SECRET", bot.secret, { secret: true });

  // 受信箱にボットを付けると、新しい会話は pending で始まり、ボットが先に答える。faq-bot が止まっていれば、Chatwoot が会話をすぐ open にする
  const inboxId = ctx.state.get("CHATWOOT_INBOX_ID");
  const current = await ctx.http("Chatwoot 受信箱のボット", `${base}/inboxes/${inboxId}/agent_bot`, withToken(adminToken));
  if (String(current?.agent_bot?.id ?? "") !== String(bot.id)) {
    await ctx.http("Chatwoot 受信箱にボットを接続", `${base}/inboxes/${inboxId}/set_agent_bot`, { method: "POST", ...withToken(adminToken), json: { agent_bot: bot.id } });
    ctx.log("Web サイトの受信箱に FAQ ボットを接続した（新しい会話は pending で始まる）");
  } else {
    ctx.log("FAQ ボットは Web サイトの受信箱に接続済み");
  }
}

/** マクロ「解決の確認を送る」を作る（名前で探し、あれば作らない）。管理者が作るので全員で使える（visibility: global） */
async function ensureAskResolvedMacro(ctx) {
  const base = `${BASE_URL}/api/v1/accounts/${ctx.state.get("CHATWOOT_ACCOUNT_ID")}`;
  const adminToken = ctx.state.get("CHATWOOT_ADMIN_TOKEN");
  const list = await ctx.http("Chatwoot マクロ一覧", `${base}/macros`, withToken(adminToken));
  if ((list?.payload ?? []).some((macro) => macro.name === ASK_RESOLVED_MACRO.name)) {
    ctx.log(`マクロ「${ASK_RESOLVED_MACRO.name}」は既にある`);
    return;
  }
  await ctx.http("Chatwoot マクロ作成", `${base}/macros`, { method: "POST", ...withToken(adminToken), json: ASK_RESOLVED_MACRO });
  ctx.log(`マクロ「${ASK_RESOLVED_MACRO.name}」を作った（ラベル faq-ask-resolved を付ける。ボットが［解決しました］ボタンを送る）`);
}

// ---------------------------------------------------------------------------
// 契約
// ---------------------------------------------------------------------------

export async function check(ctx) {
  const notes = [];
  const info = await apiOk();
  notes.push(info ? `Chatwoot は起動している（v${info.version}、data_services=${info.data_services}）` : `Chatwoot が ${BASE_URL} で応答しない`);
  let ok = Boolean(info?.data_services === "ok");

  const checkToken = async (key, label) => {
    if (!ctx.state.has(key)) {
      notes.push(`${label}がまだ状態に無い`);
      return (ok = false);
    }
    if (!info) return (ok = false);
    const me = await profile(ctx, ctx.state.get(key));
    notes.push(me ? `${label}は有効（ユーザー ID ${me.id}）` : `${label}が無効`);
    if (!me) ok = false;
  };
  await checkToken("CHATWOOT_ADMIN_TOKEN", "管理者のトークン");
  await checkToken("CHATWOOT_AGENT_TOKEN", "エージェント専用ユーザーのトークン");

  if (info) {
    const allowed = await privateNetworkAllowed(ctx);
    notes.push(allowed ? "Webhook の私設アドレスへの送信は許可済み" : "SAFE_FETCH_ALLOW_PRIVATE_NETWORK が true でない（n8n の I-12 に Webhook が届かない）");
    if (!allowed) ok = false;
  }

  for (const key of ["CHATWOOT_ACCOUNT_ID", "CHATWOOT_INBOX_ID", "CHATWOOT_WEBSITE_TOKEN", "CHATWOOT_AGENT_USER_ID", "CHATWOOT_FAQ_BOT_ID"]) {
    if (!ctx.state.has(key)) {
      notes.push(`${key} がまだ状態に無い`);
      ok = false;
    }
  }
  if (info && ctx.state.has("CHATWOOT_FAQ_BOT_ID") && ctx.state.has("CHATWOOT_INBOX_ID") && ctx.state.has("CHATWOOT_ADMIN_TOKEN")) {
    const base = `${BASE_URL}/api/v1/accounts/${ctx.state.get("CHATWOOT_ACCOUNT_ID")}`;
    const current = await ctx
      .http("Chatwoot 受信箱のボット", `${base}/inboxes/${ctx.state.get("CHATWOOT_INBOX_ID")}/agent_bot`, withToken(ctx.state.get("CHATWOOT_ADMIN_TOKEN")))
      .catch(() => null);
    const attached = String(current?.agent_bot?.id ?? "") === ctx.state.get("CHATWOOT_FAQ_BOT_ID");
    notes.push(attached ? "FAQ ボットは Web サイトの受信箱に接続済み" : "FAQ ボットが Web サイトの受信箱に接続されていない");
    if (!attached) ok = false;

    const adminToken = ctx.state.get("CHATWOOT_ADMIN_TOKEN");
    const inboxId = ctx.state.get("CHATWOOT_INBOX_ID");
    const inbox = await ctx.http("Chatwoot 受信箱", `${base}/inboxes/${inboxId}`, withToken(adminToken)).catch(() => null);
    const newChat = inbox?.allow_messages_after_resolved === false;
    notes.push(newChat ? "解決後の書き込みは新しいチャットになる" : "解決した会話に書き込むと同じ会話が開き直される（allow_messages_after_resolved が false でない）");
    if (!newChat) ok = false;

    const adminId = (await profile(ctx, adminToken))?.id;
    const members = await ctx.http("Chatwoot 受信箱のメンバー", `${base}/inbox_members/${inboxId}`, withToken(adminToken)).catch(() => null);
    const isMember = Boolean(adminId) && (members?.payload ?? members ?? []).some((m) => m.id === adminId);
    const settings = await ctx.http("Chatwoot 通知設定", `${base}/notification_settings`, withToken(adminToken)).catch(() => null);
    const mailOn = (settings?.selected_email_flags ?? []).includes(HANDOFF_EMAIL_FLAG);
    notes.push(isMember && mailOn ? "担当者への引き継ぎは管理者にメールで届く" : "担当者への引き継ぎのメールが管理者に届かない（受信箱のメンバーでないか、新しい会話のメール通知が無効）");
    if (!isMember || !mailOn) ok = false;

    const macros = await ctx.http("Chatwoot マクロ一覧", `${base}/macros`, withToken(adminToken)).catch(() => null);
    const hasMacro = (macros?.payload ?? []).some((macro) => macro.name === ASK_RESOLVED_MACRO.name);
    notes.push(hasMacro ? `マクロ「${ASK_RESOLVED_MACRO.name}」がある` : `マクロ「${ASK_RESOLVED_MACRO.name}」が無い`);
    if (!hasMacro) ok = false;

    // ラベルが無くても Chatwoot は付けられるが、色・説明・サイドバーの表示のため FAQ のラベルがすべてあることを確かめる
    const labels = await ctx.http("Chatwoot ラベル一覧", `${base}/labels`, withToken(adminToken)).catch(() => null);
    const titles = new Set((labels?.payload ?? []).map((label) => label.title));
    const missingLabels = FAQ_LABELS.map((label) => label.title).filter((title) => !titles.has(title));
    notes.push(missingLabels.length === 0 ? `FAQ のラベル ${FAQ_LABELS.length} つがある` : `FAQ のラベルが無い: ${missingLabels.join("・")}`);
    if (missingLabels.length > 0) ok = false;
  }
  return { ok, notes };
}

export async function apply(ctx) {
  ctx.require("ADMIN_EMAIL");
  await ensureStack(ctx);
  await ensureWebhookEgress(ctx);
  await ensureAdmin(ctx);
  await ensureAgent(ctx);
  await ensureInbox(ctx);
  await ensureLabels(ctx);
  await ensureFaqBot(ctx);
  await ensureAskResolvedMacro(ctx);
  await ensureHandoffNotification(ctx);
  ctx.log(`終わった。管理者のパスワード: --show CHATWOOT_ADMIN_PASSWORD／画面: ${BASE_URL}`);
}
