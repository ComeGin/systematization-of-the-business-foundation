// Mautic（開発環境）の設定。MySQL・PHP ビルトインサーバーの起動 → 未インストールならインストール → Webhook の設定（私設アドレスの許可・自動停止の無効化）と公開サイトからの CORS の許可・Webhook のキュー化
// → API 資格情報（画面で作る）→ カスタム項目・フォーム・セグメント。
//
// 方針（setup/lib/core.mjs の契約）:
//   - 使うのは Mautic 付属の公式のコンソール（mautic:install）と REST API だけ。DB は直接書かない。dev/reset.sh のような破壊的なものは呼ばない
//   - API 資格情報（OAuth 2、client_credentials）は画面で作る。fos:oauth-server:create-client はあるが、name と role を付けられない
//     （画面の ClientController は name と、作成者の role を保存する。role が無いクライアントは client_credentials の権限が決まらない）ので使わない
//   - 管理者パスワードは生成して状態に置く。コマンドライン引数に載せないよう、php の標準入力で mautic:install の引数を渡す
//
// 確かめた出典（このリポジトリの上流のソースと、動いている開発環境）:
//   backend/mautic-system/dev/serve.sh・dev/reset.sh・dev/configure-mailer.php（起動・インストール・メール設定の手順）
//   app/bundles/WebhookBundle/Http/Client.php・app/bundles/CoreBundle/Helper/PrivateAddressChecker.php（私設アドレスへの Webhook は、
//     webhook_allowed_private_addresses に入れたホスト名か IP だけ送る。それ以外は webhook_logs に "Access to private addresses is not allowed."）
//   app/bundles/InstallBundle/Command/InstallCommand.php（mautic:install の引数。インストール済みなら "Mautic already installed" で何もせず終わる）
//   app/AppKernel.php（未インストールなら /installer へリダイレクトする。インストール済みかの判定に使う）
//   app/bundles/ApiBundle/EventListener/ApiSubscriber.php（API が無効だと 403 api_disabled。有効で未認証なら 401）
//   app/bundles/ApiBundle/Controller/ClientController.php（画面の API 資格情報の作成。role と client_credentials の付与）
//   app/bundles/LeadBundle/Controller/Api/{FieldApiController,ListApiController}.php、app/bundles/FormBundle/Controller/Api/FormApiController.php
//   backend/mautic-mcp/src/services/mautic-client.ts（OAuth2 client_credentials のトークンの取り方）
//   設計: docs/DetailedDesign/02-public-path-flows.md の 5.3、docs/BasicDesign/DesignSpec/website/01-content-spec.md の 5.1・5.2、docs/RequirementDefinition/BA/04-business-processes.md
import { rmSync } from "node:fs";
import { join } from "node:path";

export const meta = { id: "mautic", title: "Mautic（マーケティングオートメーション。開発環境）", targets: ["dev"], after: ["host-relay"] };

const DIR = "backend/mautic-system";
const BASE_URL = "http://127.0.0.1:8000";
const SITE_URL = "http://localhost:8000"; // dev/reset.sh の SITE_URL の既定値
const MAILHOG = { host: "127.0.0.1", port: "1025" }; // 同梱の MailHog（dev/reset.sh の既定値）
// n8n の I-11 の受け口（middleware/n8n/provision の MAUTIC_WEBHOOK_TARGET の開発の既定値。dev.conf で変えたらそれに合わせる）
const DEFAULT_WEBHOOK_TARGET = "http://127.0.0.1:5678/webhook/mautic-event";
// 公開サイト（frontend/verdant-virgo）の開発のオリジン: dev サーバー・Lighthouse の preview・ngrok（astro.config.mjs の allowedHosts）。dev.conf の MAUTIC_CORS_VALID_DOMAINS で足せる
const DEFAULT_CORS_VALID_DOMAINS = "http://localhost:4321,http://localhost:4322,https://comegin-astro-dev.ngrok.app";

// API の接続先。本番のモジュール（prod/index.mjs）は ctx.mauticBase を与えて、下の API の ensure* をそのまま使う
const apiBase = (ctx) => ctx.mauticBase ?? BASE_URL;

const root = (ctx) => join(ctx.W, DIR);
const composeFile = (ctx) => join(root(ctx), "docker/compose.yaml");

// ---------------------------------------------------------------------------
// 起動とインストール
// ---------------------------------------------------------------------------

async function httpHead(path) {
  return fetch(`${BASE_URL}${path}`, { redirect: "manual", signal: AbortSignal.timeout(8_000) }).catch(() => null);
}

/** PHP ビルトインサーバーが応答するか。応答があればインストール済みかも返す（未インストールは /installer へリダイレクト） */
async function serverState() {
  const res = await httpHead("/s/login");
  if (!res) return { up: false };
  const location = res.headers.get("location") ?? "";
  return { up: true, installed: !(res.status >= 300 && res.status < 400 && location.includes("/installer")) };
}

async function ensureDbEnv(ctx) {
  const envFile = join(root(ctx), "docker/.env");
  if (ctx.readEnvFile(envFile).MYSQL_PASSWORD) return;
  // 初回だけ docker/.env.example から作り、DB のパスワードを生成する（dev/reset.sh の rotate_passwords と同じ。既存の .env は変えない）
  ctx.writeEnvFile(envFile, { MYSQL_ROOT_PASSWORD: ctx.randomSecret(24), MYSQL_PASSWORD: ctx.randomSecret(24) }, { template: join(root(ctx), "docker/.env.example"), onlyIfEmpty: false });
  ctx.log("docker/.env を作った（DB のパスワードを生成）");
}

async function ensureServer(ctx) {
  await ensureDbEnv(ctx);
  await ctx.run("docker", ["compose", "-f", composeFile(ctx), "up", "-d", "--wait"], { cwd: root(ctx) }); // MySQL と MailHog。冪等

  if ((await serverState()).up) {
    ctx.log("PHP ビルトインサーバーは起動済み（8000）");
    return;
  }
  // serve.sh は PHP を前面で動かし続けるので、端末から切り離して起動する（ログは設定ディレクトリへ）
  const log = join(ctx.CONFIG_DIR, "setup", "mautic-serve.log");
  await ctx.run("bash", ["-c", `setsid nohup bash dev/serve.sh >"${log}" 2>&1 </dev/null &`], { cwd: root(ctx) });
  if (!(await ctx.waitForHttp(`${BASE_URL}/s/login`, { timeoutMs: 120_000 }))) throw new Error(`Mautic が ${BASE_URL} で応答しない。ログ: ${log}`);
  ctx.log(`PHP ビルトインサーバーを起動した（ログ: ${log}。止めるときは 8000 の php を終了する）`);
}

async function ensureInstalled(ctx) {
  if ((await serverState()).installed) {
    ctx.log("インストール済み");
    return;
  }
  const email = ctx.require("ADMIN_EMAIL");
  const dbEnv = ctx.readEnvFile(join(root(ctx), "docker/.env"));
  const password = ctx.value("MAUTIC_ADMIN_PASSWORD") || `Aa1!${ctx.randomSecret(18)}`;
  ctx.state.set("MAUTIC_ADMIN_PASSWORD", password, { secret: true }); // インストールの途中で止まっても失わないよう、先に置く
  ctx.log("mautic:install を実行（管理者のパスワードは `--show MAUTIC_ADMIN_PASSWORD`）");

  // 引数（DB と管理者のパスワードを含む）は標準入力の JSON で渡し、ps に出さない。bin/console は ArgvInput で $_SERVER['argv'] を読む
  const args = [
    "mautic:install",
    SITE_URL,
    "--force",
    "--db_driver=pdo_mysql",
    "--db_host=127.0.0.1",
    `--db_port=${dbEnv.MYSQL_PORT || "3306"}`,
    `--db_name=${dbEnv.MYSQL_DATABASE || "mautic"}`,
    `--db_user=${dbEnv.MYSQL_USER || "mautic"}`,
    `--db_password=${dbEnv.MYSQL_PASSWORD}`,
    `--admin_email=${email}`,
    "--admin_username=admin",
    `--admin_password=${password}`,
  ];
  const php = `$a = json_decode(stream_get_contents(STDIN), true); $_SERVER['argv'] = $GLOBALS['argv'] = array_merge(['bin/console'], $a); require getcwd().'/bin/console';`;
  await ctx.run("php", ["-r", php], { cwd: root(ctx), input: JSON.stringify(args) });

  // メール設定（同梱の MailHog）。値は環境変数で渡す（dev/configure-mailer.php の仕様）。反映のためキャッシュを捨てる
  await ctx.run("php", ["dev/configure-mailer.php"], {
    cwd: root(ctx),
    env: { MAUTIC_MAILER_FROM_NAME: "Mautic", MAUTIC_MAILER_FROM_EMAIL: email, MAUTIC_MAILER_HOST: MAILHOG.host, MAUTIC_MAILER_PORT: MAILHOG.port },
  });
  for (const dir of ["var/cache/prod", "var/cache/dev"]) rmSync(join(root(ctx), dir), { recursive: true, force: true });
  if (!(await serverState()).installed) throw new Error("mautic:install の後も未インストールの応答が返る。dev/setup のログと、docker compose -f docker/compose.yaml ps を確かめる");
  ctx.log("インストールした");
}

// ---------------------------------------------------------------------------
// Webhook の設定（開発だけ。I-11 の送り先が 127.0.0.1 のため。setup/README.md の「Webhook の送り先と SSRF 対策」）
// ---------------------------------------------------------------------------

/** 許可が要るホスト（Webhook の送り先のホストだけ。範囲では許可しない） */
const webhookHost = (ctx) => new URL(ctx.value("MAUTIC_WEBHOOK_TARGET") || DEFAULT_WEBHOOK_TARGET).hostname;

/** config/local.php の Webhook の設定 2 つ（秘密値を含むファイルなので、この 2 つだけを取り出す） */
async function webhookConfig(ctx) {
  const php = `$parameters = []; require 'config/local.php'; echo json_encode(['allowed' => array_values((array) ($parameters['webhook_allowed_private_addresses'] ?? [])), 'disableAutoUnpublish' => (bool) ($parameters['disable_auto_unpublish'] ?? false)]);`;
  const out = await ctx.run("php", ["-r", php], { cwd: root(ctx) }).catch(() => "");
  try {
    return JSON.parse(out.trim().split("\n").pop() || "");
  } catch {
    return { allowed: [], disableAutoUnpublish: false };
  }
}

/** dev/ の php で config/local.php を書く。変えたら true（最後の行が "changed"） */
async function writeConfig(ctx, script, env = {}) {
  const out = await ctx.run("php", [script], { cwd: root(ctx), env });
  return out.trim().split("\n").pop() === "changed";
}

async function ensureWebhookConfig(ctx) {
  const host = webhookHost(ctx);
  // 1. 送り先の私設アドレスの許可（WebhookBundle/Http/Client.php の PrivateAddressChecker）
  const allowedNow = await writeConfig(ctx, "dev/allow-webhook-private-addresses.php", { MAUTIC_WEBHOOK_ALLOWED_PRIVATE_ADDRESSES: host });
  ctx.log(allowedNow ? `Webhook の送り先 ${host} を私設アドレスとして許可した（webhook_allowed_private_addresses）` : `Webhook の送り先 ${host} は私設アドレスとして許可済み`);
  // 2. 失敗しても Webhook を自動で非公開にしない（開発では I-11 が未公開〈404〉なのが既定で、止められると通しの確認ができない）。本番は false のまま
  const keptNow = await writeConfig(ctx, "dev/disable-webhook-auto-unpublish.php");
  ctx.log(keptNow ? "送信に失敗した Webhook を自動で非公開にしないようにした（disable_auto_unpublish）" : "送信に失敗した Webhook は自動で非公開にならない（設定済み）");
  // 3. 公開サイト（Astro）のオリジンからのフォーム送信の CORS（app/middlewares/CORSMiddleware.php）。無いと画面は応答を読めず「送信できませんでした」になる
  const origins = ctx.value("MAUTIC_CORS_VALID_DOMAINS") || DEFAULT_CORS_VALID_DOMAINS;
  const corsNow = await writeConfig(ctx, "dev/allow-cors-domains.php", { MAUTIC_CORS_VALID_DOMAINS: origins });
  ctx.log(corsNow ? `公開サイトのオリジン ${origins} からの CORS を許可した（cors_valid_domains）` : `公開サイトのオリジン ${origins} からの CORS は許可済み`);
  // 4. Webhook をキューに積み、dev/serve.sh の定期実行（mautic:webhooks:process）で送る。要求の中で n8n を待たない（dev/queue-webhooks.php）
  const queuedNow = await writeConfig(ctx, "dev/queue-webhooks.php");
  ctx.log(queuedNow ? "Webhook をキューに積んで後から送るようにした（queue_mode = command_process）" : "Webhook はキューに積んで後から送る（設定済み）");
  if (!allowedNow && !keptNow && !corsNow && !queuedNow) return;

  // パラメーターは Symfony のコンテナのキャッシュに焼き込まれるので、捨てて次の要求で作り直させる（ensureInstalled と同じ）
  for (const dir of ["var/cache/prod", "var/cache/dev"]) rmSync(join(root(ctx), dir), { recursive: true, force: true });
  // 作り直しの最初の要求は数十秒かかる。後の API の確認（8 秒で打ち切る）が「API が無効」と誤るので、応答が戻るまで待つ
  if (!(await ctx.waitForHttp(`${BASE_URL}/s/login`, { timeoutMs: 180_000 }))) throw new Error(`キャッシュを捨てた後、Mautic が ${BASE_URL} で応答しない`);
  ctx.log("キャッシュを捨てて設定を反映した");
}

// ---------------------------------------------------------------------------
// API（OAuth2 client_credentials）
// ---------------------------------------------------------------------------

/** 未認証で /api を叩いて、API が有効かを見る（無効は 403 api_disabled、有効なら 401） */
export async function apiEnabled(ctx) {
  const res = await fetch(`${apiBase(ctx)}/api/contacts?limit=1`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) }).catch(() => null);
  if (!res) return null;
  const body = await res.json().catch(() => null);
  return body?.errors?.[0]?.type !== "api_disabled";
}

export async function fetchToken(ctx, clientId, clientSecret) {
  try {
    const body = await ctx.http("Mautic トークン", `${apiBase(ctx)}/oauth/v2/token`, { method: "POST", form: { grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret } });
    return body.access_token;
  } catch (e) {
    if (e.status === 400 || e.status === 401) return null;
    throw e;
  }
}

function manualCredentials(ctx, enabled) {
  // 画面の表記は Mautic の言語（開発環境は en_US）。出典: ApiBundle/Translations/en_US/messages.ini、Client/list.html.twig
  const steps = [];
  if (enabled === false) steps.push(`${BASE_URL} に管理者でログイン（ユーザー名 admin、メールは ADMIN_EMAIL。パスワードは \`node setup/setup.mjs --target dev --show MAUTIC_ADMIN_PASSWORD\`。インストール済みの環境では自分のパスワード）。右上の歯車 → Configuration → API Settings タブで「API enabled?」を Yes にして Save & Close`);
  else steps.push(`${BASE_URL} に管理者でログインする（API は有効になっている）`);
  steps.push(
    "右上の歯車 → API Credentials（/s/credentials）→ New を開く",
    "Authorization Protocol は OAuth 2、Name は comegin-dev、Redirect URI は http://localhost（必須だが client_credentials では使わない）にして Save & Close（管理者が作ると client_credentials が使える）",
    "一覧の Public Key（＝クライアント ID）と Secret Key（＝クライアントシークレット）を控える（列はウィンドウが広いときだけ出る）",
    "~/.config/comegin/setup/dev.conf に MAUTIC_CLIENT_ID=<Public Key> と MAUTIC_CLIENT_SECRET=<Secret Key> を書く（chmod 600）",
    "同じコマンドを実行し直す（手順は setup/manual-steps.md の 2 節にもある）",
  );
  ctx.manual("api-credentials", "Mautic の API 認証情報（OAuth 2）を作る", steps);
}

async function api(ctx, token, label, path, { method = "GET", json } = {}) {
  return ctx.http(label, `${apiBase(ctx)}/api${path}`, { method, headers: { Authorization: `Bearer ${token}` }, json });
}

const list = (body, key) => Object.values(body?.[key] ?? {});

// ---------------------------------------------------------------------------
// 定義（設計: 02-public-path-flows.md の 5.3、01-content-spec.md の 5.1）
// ---------------------------------------------------------------------------

// コンタクトのカスタム項目 3 つ（フォームの同意の記録に使う）
export const CONTACT_FIELDS = [
  { alias: "privacy_consent_at", label: "プライバシーポリシーへの同意日時", type: "datetime" },
  { alias: "privacy_consent_version", label: "同意したプライバシーポリシーの版（最終改定日）", type: "text" },
  { alias: "email_optin", label: "お知らせメールの受信の希望", type: "boolean", properties: { no: "いいえ", yes: "はい" } },
];

const mapped = (field) => ({ mappedObject: "contact", mappedField: field });
const text = (alias, label, extra = {}) => ({ type: "text", alias, label, isRequired: false, ...extra });
const hidden = (alias, label, extra = {}) => ({ type: "hidden", alias, label, ...extra });
const button = { type: "button", alias: "submit", label: "送信", properties: { type: "submit" } };

// 同意の 3 項目と、DA-03 の hidden field（distinct_id）、CTA の識別（page_url・cta_id）。
// umami_session_id は ADR-25 で廃止（Umami をやめ、代わりの識別子は足さない）。作成済みのフォームには項目が残るが、送られなくなるだけで害は無い
const CONSENT_FIELDS = [
  hidden("privacy_consent_at", "同意日時", mapped("privacy_consent_at")),
  hidden("privacy_consent_version", "同意した版", mapped("privacy_consent_version")),
  hidden("email_optin", "お知らせメールの受信", { ...mapped("email_optin"), defaultValue: "0" }),
];
const TRACKING_FIELDS = [
  hidden("page_url", "CTA を押したページ"),
  hidden("cta_id", "CTA の ID"),
  hidden("distinct_id", "PostHog の distinct_id"),
];

// フォームの名前と alias は設計の正本（consult）に合わせる。alias は Mautic のフォームの結果の表の名前に入るため、英数字と _ だけにする。
// 無料 DL のフォーム（source_dl）は 2026-10-20 に公開サイトから消したので作らない（どのページも「ソースコードを無料 DL」の CTA で、メールを受け取らない）。
// 以前の版で作ったフォームは Mautic に残る。消すかは画面（フォーム一覧）で決める（送信の結果も一緒に消える）
export const FORMS = [
  {
    stateKey: "MAUTIC_FORM_ID_CONSULT",
    name: "consult",
    description: "無料相談（旧デモ予約）。会社名・氏名・メール・相談内容と同意の記録",
    fields: [
      text("company", "会社名", { isRequired: true, ...mapped("company") }),
      text("lastname", "姓", { isRequired: true, ...mapped("lastname") }),
      text("firstname", "名", { isRequired: true, ...mapped("firstname") }),
      { type: "email", alias: "email", label: "メールアドレス", isRequired: true, ...mapped("email") },
      { type: "textarea", alias: "message", label: "ご相談内容", isRequired: true },
      hidden("service_interest", "相談の対象のサービス"),
      ...TRACKING_FIELDS,
      ...CONSENT_FIELDS,
      button,
    ],
  },
];

// BA-04: 累計ポイントが 50 以上でセグメント mql に追加（50 は暫定値）
export const SEGMENT_MQL = {
  stateKey: "MAUTIC_SEGMENT_ID_MQL",
  name: "mql",
  alias: "mql",
  description: "累計ポイントが 50 以上（BA-04。しきい値は暫定）",
  filters: [{ glue: "and", field: "points", object: "lead", type: "number", operator: "gte", properties: { filter: 50 } }],
};

// 無料相談の自動返信（01-content-spec.md の 6'-1a が文面の正本。C16 は 2026-10-11 に「送る」で解決）。
// 入力の値（氏名・会社名・相談内容）は差し込まない。宛先は検証していない入力なので、差し込むと他人のアドレスへ任意の文を送らせる踏み台になる
export const CONSULT_AUTO_REPLY = {
  stateKey: "MAUTIC_EMAIL_ID_CONSULT_AUTO_REPLY",
  formStateKey: "MAUTIC_FORM_ID_CONSULT",
  name: "consult_auto_reply",
  subject: "【ComeGin】無料相談のお申し込みを受け付けました",
  // 差出人のアドレスは環境ごとのメールの設定（mailer_from_email）のまま。名前だけ固定する（既定は "Mautic"）
  fromName: "ComeGin",
  replyToAddress: "kamegin4@comegin.com",
  // 段落ごと。plainText は空行でつなぎ、customHtml は段落を <p> にする（固定の文なのでエスケープは要らない）
  paragraphs: [
    ["ComeGin の無料相談にお申し込みいただき、ありがとうございます。", "お申し込みを受け付けました。"],
    ["担当者から 3営業日以内に、このメールアドレスへご連絡します。", "オンライン面談の日時は、お申し込みの後に表示された画面からお選びいただけます。"],
    ["このメールにお心当たりがない場合は、お手数ですが破棄してください。", "ご不明な点は kamegin4@comegin.com までご連絡ください。"],
    ["ComeGin"],
  ],
};
const autoReplyPlainText = (def) => def.paragraphs.map((p) => p.join("\n")).join("\n\n");
const autoReplyHtml = (def) =>
  `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>${def.subject}</title></head><body style="font-family: sans-serif; line-height: 1.75; color: #1a2b3c;">${def.paragraphs.map((p) => `<p>${p.join("<br>")}</p>`).join("")}</body></html>`;

export async function ensureContactFields(ctx, token) {
  const existing = list(await api(ctx, token, "Mautic 項目一覧", "/fields/contact?limit=1000"), "fields").map((f) => f.alias);
  for (const f of CONTACT_FIELDS) {
    if (existing.includes(f.alias)) continue;
    await api(ctx, token, `Mautic 項目作成（${f.alias}）`, "/fields/contact/new", { method: "POST", json: { ...f, group: "core", isPublished: true } });
    ctx.log(`カスタム項目を作った: ${f.alias}`);
  }
}

export async function ensureForms(ctx, token) {
  const existing = list(await api(ctx, token, "Mautic フォーム一覧", "/forms?limit=1000"), "forms");
  for (const def of FORMS) {
    const alias = def.name.replace(/[^0-9a-z_]/gi, "").toLowerCase();
    let form = existing.find((f) => f.name === def.name || f.alias === alias);
    if (!form) {
      const body = await api(ctx, token, `Mautic フォーム作成（${def.name}）`, "/forms/new", {
        method: "POST",
        json: { name: def.name, alias, description: def.description, formType: "standalone", isPublished: true, postAction: "message", postActionProperty: "送信しました", fields: def.fields },
      });
      form = body.form;
      ctx.log(`フォームを作った: ${def.name}（ID ${form.id}、alias ${form.alias}）`);
    }
    ctx.state.set(def.stateKey, String(form.id));
  }
}

// 自動返信のメールを作り、フォーム consult の送信の後に送るアクション（email.send.lead）を付ける。
// アクションの追加は PATCH（FormApiController は PUT のときだけ、要求に無い既存のアクションを消す）
export async function ensureAutoReply(ctx, token) {
  const def = CONSULT_AUTO_REPLY;
  const emails = list(await api(ctx, token, "Mautic メール一覧", `/emails?search=${encodeURIComponent(def.name)}&limit=100`), "emails");
  let email = emails.find((e) => e.name === def.name);
  // 文面の正本は仕様書なので、作成済みでも中身が違えば合わせる（画面で直した分は上書きされる）
  const content = { subject: def.subject, fromName: def.fromName, replyToAddress: def.replyToAddress, customHtml: autoReplyHtml(def), plainText: autoReplyPlainText(def) };
  if (!email) {
    const body = await api(ctx, token, `Mautic メール作成（${def.name}）`, "/emails/new", {
      method: "POST",
      json: { name: def.name, emailType: "template", language: "ja", isPublished: true, ...content },
    });
    email = body.email;
    ctx.log(`自動返信のメールを作った: ${def.name}（ID ${email.id}）`);
  } else if (Object.entries(content).some(([k, v]) => (email[k] ?? "") !== v)) {
    await api(ctx, token, `Mautic メール更新（${def.name}）`, `/emails/${email.id}/edit`, { method: "PATCH", json: content });
    ctx.log(`自動返信のメールを仕様書の文面に合わせた: ${def.name}（ID ${email.id}）`);
  }
  ctx.state.set(def.stateKey, String(email.id));

  const formId = ctx.state.get(def.formStateKey);
  const { form } = await api(ctx, token, "Mautic フォーム取得（consult）", `/forms/${formId}`);
  const attached = (form.actions ?? []).some((a) => a.type === "email.send.lead" && Number(a.properties?.email) === Number(email.id));
  if (attached) {
    ctx.log("フォーム consult の送信の後に自動返信を送る（設定済み）");
    return;
  }
  await api(ctx, token, "Mautic フォームのアクション追加（consult）", `/forms/${formId}/edit`, {
    method: "PATCH",
    json: { actions: [{ name: "自動返信（受付確認）", type: "email.send.lead", order: 1, properties: { email: email.id } }] },
  });
  ctx.log(`フォーム consult の送信の後に自動返信（メール ID ${email.id}）を送るようにした`);
}

export async function ensureSegment(ctx, token) {
  const existing = list(await api(ctx, token, "Mautic セグメント一覧", "/segments?limit=1000"), "lists");
  let segment = existing.find((s) => s.alias === SEGMENT_MQL.alias);
  if (!segment) {
    const { stateKey, ...json } = SEGMENT_MQL;
    const body = await api(ctx, token, "Mautic セグメント作成（mql）", "/segments/new", { method: "POST", json: { ...json, isPublished: true, isGlobal: true } });
    segment = body.list;
    ctx.log(`セグメントを作った: mql（ID ${segment.id}）`);
  }
  ctx.state.set(SEGMENT_MQL.stateKey, String(segment.id));
}

// ---------------------------------------------------------------------------
// 契約
// ---------------------------------------------------------------------------

export async function check(ctx) {
  const notes = [];
  const s = await serverState();
  notes.push(s.up ? `Mautic は応答している（${s.installed ? "インストール済み" : "未インストール"}）` : `Mautic が ${BASE_URL} で応答しない（dev/serve.sh で起動する）`);
  let ok = s.up && s.installed;

  if (s.up && s.installed) {
    const host = webhookHost(ctx);
    const config = await webhookConfig(ctx);
    const allowed = config.allowed.includes(host);
    notes.push(allowed ? `Webhook の送り先 ${host} は私設アドレスとして許可済み` : `webhook_allowed_private_addresses に ${host} が無い（n8n の I-11 に Webhook が届かない）`);
    notes.push(config.disableAutoUnpublish ? "送信に失敗した Webhook は自動で非公開にならない（disable_auto_unpublish）" : "disable_auto_unpublish が true でない（I-11 が未公開の間に「n8n I-11」が止まる）");
    if (!allowed || !config.disableAutoUnpublish) ok = false;
    const enabled = await apiEnabled(ctx);
    notes.push(enabled ? "API は有効" : "API が無効（設定 > API 設定 で有効にする）");
    if (!enabled) ok = false;
    const id = ctx.value("MAUTIC_CLIENT_ID");
    const secret = ctx.value("MAUTIC_CLIENT_SECRET");
    if (!id || !secret) {
      notes.push("MAUTIC_CLIENT_ID・MAUTIC_CLIENT_SECRET が設定に無い（画面で作って dev.conf に書く）");
      ok = false;
    } else if (enabled) {
      const token = await fetchToken(ctx, id, secret);
      notes.push(token ? "API 資格情報でトークンを取れる" : "API 資格情報でトークンを取れない（ID かシークレットが違う）");
      if (!token) ok = false;
    }
  }
  for (const key of ["MAUTIC_FORM_ID_CONSULT", "MAUTIC_SEGMENT_ID_MQL"]) {
    if (!ctx.state.has(key)) {
      notes.push(`${key} がまだ状態に無い`);
      ok = false;
    }
  }
  return { ok, notes };
}

export async function apply(ctx) {
  await ensureServer(ctx);
  await ensureInstalled(ctx);
  await ensureWebhookConfig(ctx);

  const enabled = await apiEnabled(ctx);
  const clientId = ctx.value("MAUTIC_CLIENT_ID");
  const clientSecret = ctx.value("MAUTIC_CLIENT_SECRET");
  if (!enabled || !clientId || !clientSecret) manualCredentials(ctx, enabled);

  const token = await fetchToken(ctx, clientId, clientSecret);
  if (!token) throw new Error("Mautic の API 資格情報でトークンを取れない。MAUTIC_CLIENT_ID・MAUTIC_CLIENT_SECRET を確かめる（画面の API 認証情報のクライアントに client_credentials が付いているか）");
  ctx.log("API 資格情報でトークンを取れた");

  await ensureContactFields(ctx, token);
  await ensureForms(ctx, token);
  await ensureAutoReply(ctx, token);
  await ensureSegment(ctx, token);
  ctx.log("終わった。フォームとセグメントの ID は状態に置いた（--show MAUTIC_FORM_ID_CONSULT など）");
}
