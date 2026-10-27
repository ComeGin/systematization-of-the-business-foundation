// Mautic（本番。ECS の mautic-web。https://mkt.comegin.com）の初期設定。setup/lib/core.mjs の契約に従う。--target prod だけ。
//
// 開発のモジュール（../index.mjs）の API の ensure* を、接続先（ctx.mauticBase）を差し替えてそのまま使う
// （カスタム項目 3 つ・フォーム consult・その自動返信・セグメント mql。定義の正本は開発のモジュールの定数）。
// 使うのは REST API（/api/*・/oauth/v2/token。本番の ALB の機械向けのルール 202 を通る）だけで、AWS には書き込まない。
//
// 人が行うもの（止まって案内する）。本番は ECS の中で動き、config/local.php は EFS にあるので、開発のように PHP で書き換えない:
//   - インストール（/installer。admin-auth の内側）と、設定の画面での確認（API・Webhook・CORS・メール。下の settingsSteps）
//   - 初期設定用の API 認証情報（管理者のロール。MAUTIC_SETUP_CLIENT_ID・SECRET。エージェント用の mcp-prod の認証情報とは別）
// 作ったフォーム consult の ID は prod の状態（MAUTIC_FORM_ID_CONSULT）に置く。公開サイトの本番のビルド（setup/frontend.mjs）がそれを読む。
// ECS の台数は順番があるので、2 か所で読み取りだけで確かめる（cloud/README.md の 4.10・4.11）:
//   - 最初に mautic-web の DesiredCount（親のパラメータ）が 1 か。0 ならインストールの画面が開かないので、上げる手順を案内して止まる
//   - 最後に mautic-cron の DesiredCount が 1 か。cron はインストールが終わるまで待つので、初期設定の後に上げる（2 つ動くとメールが二重になるので 1 に固定）
import { notRunningNote, raiseCountSteps, requireMainStack, serviceCounts } from "../../../../../cloud/setup/aws.mjs";
import { apiEnabled, ensureAutoReply, ensureContactFields, ensureForms, ensureSegment, fetchToken } from "../index.mjs";

export const meta = { id: "mautic-prod", title: "Mautic（本番。項目・フォーム consult・自動返信・セグメント）", targets: ["prod"], phases: ["apps"], after: [] };

const DEFAULT_BASE_URL = "https://mkt.comegin.com";
// オンプレの n8n の Webhook の受け口（WireGuard のアドレス。cloud/template.yaml の OnpremPeerAddress）。変えたら prod.conf の ONPREM_WEBHOOK_HOST
const DEFAULT_ONPREM_WEBHOOK_HOST = "10.99.0.2";
const yes = (v) => /^(yes|true|1)$/i.test(String(v ?? "").trim());

const baseOf = (ctx) => String(ctx.conf.MAUTIC_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");

/** 未認証で /api を叩いて状態を見る。未インストールは /installer への 302、API が無効は 403 api_disabled、有効は 401、それ以外（ALB の 502・503 など）は abnormal */
async function apiState(ctx) {
  const res = await fetch(`${baseOf(ctx)}/api/contacts?limit=1`, { headers: { Accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res) return "unreachable";
  if (res.status >= 300 && res.status < 400) return /installer/.test(res.headers.get("location") ?? "") ? "not-installed" : "redirect";
  const enabled = await apiEnabled({ ...ctx, mauticBase: baseOf(ctx) });
  return enabled === true ? "enabled" : enabled === false ? "disabled" : "abnormal";
}

function settingsSteps(ctx) {
  const webhookHost = ctx.value("ONPREM_WEBHOOK_HOST") || DEFAULT_ONPREM_WEBHOOK_HOST;
  const site = ctx.value("PUBLIC_SITE_URL") || "https://comegin.com";
  return [
    `${baseOf(ctx)}/installer を開いてインストールする（admin-auth の Google ログインの内側。DB の値は環境変数から入っている。管理者のパスワードは人が決め、Secrets Manager に置かない。cloud/README.md の 4.10）`,
    "設定 > システム設定 の Site URL が https:// で始まることを確かめる（派生イメージが trusted_proxies を書くので、インストールの時点で https になる見込み）",
    "設定 > API 設定 で「API を有効」を はい にする（Basic 認証は いいえ のまま。cloud/README.md の 4.13）",
    `設定 > Webhook 設定 で、キューモードを「コマンドで処理」（command_process）、私設アドレスの許可に ${webhookHost} だけ（範囲で許可しない）、失敗での自動停止は無効にしない`,
    `設定 > システム設定 > CORS 設定 で「ドメインを制限する」を はい のまま、許可するドメインに ${site} だけを入れる`,
    "設定 > メール設定 で SES の SMTP（email-smtp.ap-northeast-1.amazonaws.com・587・STARTTLS。認証情報は Secrets Manager の comegin/prod/mautic/SMTP_USERNAME・SMTP_PASSWORD）と、送信元（SES で検証済みのドメインのアドレス）を設定する",
    "設定 > API 認証情報 で、初期設定用（管理者が作る。名前 comegin-prod-setup）と、エージェント用（エージェント専用のロールのユーザー。mcp-prod）・参照専用（mcp-prod-ro）を OAuth 2 で作る。初期設定用の Public Key と Secret Key を prod.conf の MAUTIC_SETUP_CLIENT_ID=・MAUTIC_SETUP_CLIENT_SECRET= に書く（初期設定が終わったら、画面で消してよい）",
    "~/.config/comegin/setup/prod.conf に MAUTIC_PROD_SETTINGS_DONE=yes を書き、同じコマンドを実行し直す（設定は EFS の config/local.php にあり、外から確かめられないため申告制）",
  ];
}

export async function check(ctx) {
  const notes = [];
  let ok = true;
  const mark = (cond, good, bad) => {
    notes.push(cond ? good : bad);
    if (!cond) ok = false;
  };
  try {
    const main = await requireMainStack(ctx);
    for (const [svc, param] of [["mautic-web", "MauticWebDesiredCount"], ["mautic-cron", "MauticCronDesiredCount"]]) {
      const c = await serviceCounts(ctx, main, svc, param);
      mark(c.desiredParam === 1, `comegin-prod-${svc}: DesiredCount 1（動いているタスク ${c.running}）`, `comegin-prod-${svc} の DesiredCount が ${c.desiredParam}（${svc === "mautic-web" ? "インストールの前に" : "初期設定の後に"} ${param}=1 にする。cloud/README.md の 4.11）`);
      if (c.desiredParam === 1 && c.running === 0) notes.push(`! ${notRunningNote(c)}`);
    }
  } catch (e) {
    mark(false, "", `ECS の台数を確かめられない（${e.message.split("\n")[0]}）`);
  }
  const state = await apiState(ctx);
  const describe = { enabled: "インストール済みで API は有効", disabled: "API が無効（設定 > API 設定）", "not-installed": "未インストール（/installer）", redirect: "API が認証の内側に落ちている（ALB のルール 202 を確かめる）", abnormal: "API の応答が異常（mautic-web が止まっているか、ALB の 502・503。台数とアラームを見る）", unreachable: `${baseOf(ctx)} に届かない` };
  mark(state === "enabled", `本番の Mautic: ${describe[state]}`, `本番の Mautic: ${describe[state]}`);
  mark(yes(ctx.value("MAUTIC_PROD_SETTINGS_DONE")), "画面の設定（Webhook・CORS・メール・API 認証情報）は済みと申告されている", "画面の設定が済んだと申告されていない（MAUTIC_PROD_SETTINGS_DONE=yes）");
  const id = ctx.conf.MAUTIC_SETUP_CLIENT_ID;
  const secret = ctx.conf.MAUTIC_SETUP_CLIENT_SECRET;
  if (!id || !secret) mark(false, "", "MAUTIC_SETUP_CLIENT_ID・MAUTIC_SETUP_CLIENT_SECRET が prod.conf に無い");
  else if (state === "enabled") mark(Boolean(await fetchToken({ ...ctx, mauticBase: baseOf(ctx) }, id, secret)), "初期設定用の API 認証情報でトークンを取れる", "初期設定用の API 認証情報でトークンを取れない");
  for (const key of ["MAUTIC_FORM_ID_CONSULT", "MAUTIC_SEGMENT_ID_MQL"]) mark(ctx.state.has(key), `${key} は状態にある（${ctx.state.get(key)}）`, `${key} がまだ状態に無い（apply で作る）`);
  return { ok, notes };
}

export async function apply(ctx) {
  const main = await requireMainStack(ctx);
  const web = await serviceCounts(ctx, main, "mautic-web", "MauticWebDesiredCount");
  if (web.desiredParam < 1) {
    ctx.manual("ecs-web", "本番の Mautic（mautic-web）を起動する（DesiredCount が 0。インストールの画面が開かない）", raiseCountSteps([web.param], [
      "前提: cloud/README.md の 4.6 の SMTP の Secret（mautic/SMTP_USERNAME・SMTP_PASSWORD）に値を入れてある。mautic-cron は 0 のまま（インストールが終わってから上げる）",
      "移行の RunTask は要らない（公式の entrypoint が、インストール済みなら起動のたびに移行する。cloud/README.md の 4.10）",
    ]));
  }
  if (web.running === 0) ctx.warn(notRunningNote(web));

  const state = await apiState(ctx);
  if (state === "abnormal") throw new Error(`本番の Mautic（${baseOf(ctx)}/api）の応答が異常。mautic-web の DesiredCount・タスク数のアラーム・ALB のターゲットの状態を見る（cloud/README.md の 4.11）`);
  if (state === "unreachable") throw new Error(`本番の Mautic（${baseOf(ctx)}）に届かない。mautic-web の DesiredCount とアラームを見る（cloud/README.md の 4.11）`);
  if (state === "redirect") throw new Error("本番の Mautic の /api が認証の内側に落ちている。edge.yaml のルール 202 と、MktHost が合っているかを確かめる");
  const id = ctx.conf.MAUTIC_SETUP_CLIENT_ID;
  const secret = ctx.conf.MAUTIC_SETUP_CLIENT_SECRET;
  if (state !== "enabled" || !yes(ctx.value("MAUTIC_PROD_SETTINGS_DONE")) || !id || !secret) {
    ctx.manual("settings", "本番の Mautic をインストールし、画面で設定して、初期設定用の API 認証情報を prod.conf に書く", settingsSteps(ctx));
  }

  const c = { ...ctx, mauticBase: baseOf(ctx) };
  const token = await fetchToken(c, id, secret);
  if (!token) throw new Error("初期設定用の API 認証情報でトークンを取れない。MAUTIC_SETUP_CLIENT_ID・MAUTIC_SETUP_CLIENT_SECRET と、認証情報が管理者のロールで作られているかを確かめる");
  ctx.log("本番の Mautic に初期設定用の API 認証情報で認証できた");
  await ensureContactFields(c, token);
  await ensureForms(c, token);
  await ensureAutoReply(c, token);
  await ensureSegment(c, token);
  ctx.log("フォーム consult とセグメント mql の ID を prod の状態に置いた（MAUTIC_FORM_ID_CONSULT は node setup/frontend.mjs --target prod の .env.production が読む）");
  ctx.log("Mautic から n8n（I-11）への Webhook は、オンプレの本番の n8n の provision（n8n-prod）が作る（宛先 http://10.99.0.2:5680/webhook/mautic-event）");

  const cron = await serviceCounts(ctx, main, "mautic-cron", "MauticCronDesiredCount");
  if (cron.desiredParam !== 1) {
    ctx.manual("ecs-cron", `本番の Mautic の cron（mautic-cron）を起動する（DesiredCount が ${cron.desiredParam}。キャンペーン・セグメント・Webhook のキューが動かない）`, raiseCountSteps([cron.param], [
      "インストールと初期設定は済んだので、cron を上げる（1 に固定。2 つ動くとキャンペーンとメールが二重になる。cloud/README.md の 4.11）",
    ]));
  }
  if (cron.running === 0) ctx.warn(notRunningNote(cron));
}
