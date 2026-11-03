// 「設定の状況」の手順の一覧（カタログ）。
//
// setup/00-setup-overview.md の 3 節（P1〜P15）のチェック項目と 6 節（R1）の表の各行を、
// 「どう確かめるか」と結び付けて 1 行 1 項目で持つ。人が読む正本は 00-setup-overview.md のままで、
// ここはそれとずれないように写したもの。ずれは `node setup/status/verify-steps.mjs` が検出する
// （00-setup-overview.md を直したらここも直し、検査を通す。setup/README.md の「設定の状況のカタログ」）。
//
// このファイルは副作用のない ESM で、default を export しない。
// 監視アプリ（backend/control-plane）が承認済みの main のチェックアウトから import() して読む。
//
// 項目の形:
//   id          段階の中で一意（例 "P12.build"）
//   title       画面の見出し（00-setup-overview.md のチェック項目の要約）
//   who         "自動" | "人・端末" | "人・画面" | "人・GitHub" | "人・ブラウザ" | "判断"
//   kind        "検査"（確かめる）| "警告"（〔警告〕。止めずに警告）| "申告"（〔申告〕）| "未検査"（〔未検査〕か、確かめる手段が無い）| "判断"
//   overviewText  00-setup-overview.md の該当行に含まれる、その段階の節で 1 回だけ現れる部分文字列（検査が使う）
//   probe       確かめ方。
//                 { kind: "item", key }  モジュールの items のうち、key が一致し、step がこの段階のもの
//                 { kind: "items", keys: string[] }  1 行が複数の key にまたがるとき（空にしない）。評価は keys の項目すべてを
//                   見て、level は最も重いもの（重さの順は評価側で決める）、
//                   evidence は各項目の evidence を「／」でつなぐ
//                 { kind: "module", module, phase }  モジュールの ok・notes 全体
//                 { kind: "drift", id }  設定スクリプトが見ていない「ずれ」の確認（仕様 5.3）
//                 { kind: "none" }  ◇（未検査・申告・判断・確かめる手段が無い）
//   docs        正本の節。heading は、そのファイルの見出し（# を除いた文字列）の先頭に一致する文字列。
//               末尾が数字のときは、その後ろに数字が続く見出しには当たらない（"4.1" は "4.10" に当たらない）
//   stopId      設定スクリプトが止まるときの id（setup/manual-steps.md の早見表で引ける）

export const CATALOG_VERSION = 1;

/** 製品の API を呼ぶ（1 時間に 1 回まで）モジュール */
export const PRODUCT_API_MODULES = ["chatwoot-prod", "mautic-prod", "n8n-prod", "mcp-prod", "openseo"];

/**
 * 各モジュールの check が items で返す (key, step) の組（Task 2。setup/tests/modules/*-items.test.mjs が正）。
 * 同じ key が 2 つの段階に出るものがある（cloud.ses-production・cloud.deploy-principal）。
 * probe の { kind: "item", key } は key だけを持ち、評価は「key が一致し、step がカタログの段階と同じ」で選ぶ。
 */
export const KNOWN_ITEM_KEYS = [
  { key: "cloud.global-second", steps: ["P2"] },
  { key: "cloud.sns-subscription", steps: ["P2"] },
  { key: "cloud.ses-domain", steps: ["P4"] },
  { key: "cloud.dmarc", steps: ["P4"] },
  { key: "cloud.smtp-secrets", steps: ["P4"] },
  { key: "cloud.wireguard-ami", steps: ["P6"] },
  { key: "cloud.onprem-keys", steps: ["P6"] },
  { key: "chatwoot-prod.admin-token-checks", steps: ["P7"] },
  { key: "n8n-prod.admin-token-checks", steps: ["P9"] },
  { key: "mcp-prod.dist", steps: ["P10"] },
  { key: "mcp-prod.values", steps: ["P10"] },
  { key: "cloud.ses-production", steps: ["P12", "P15"] },
  { key: "cloud.deploy-principal", steps: ["P12", "P15"] },
  { key: "next-js-prod.checkout", steps: ["P14"] },
  { key: "next-js-prod.build", steps: ["P14"] },
  { key: "next-js-prod.principal", steps: ["P14"] },
  { key: "next-js-prod.status-principal", steps: ["P14"] },
  { key: "next-js-prod.status-github", steps: ["P14"] },
  { key: "next-js-prod.prod-values", steps: ["P14"] },
  { key: "next-js-prod.systemd", steps: ["P14"] },
  { key: "next-js-prod.respond", steps: ["P14"] },
  { key: "next-js-prod.heartbeat-alarm", steps: ["P14"] },
  { key: "next-js-prod.schedules-enabled", steps: ["P14"] },
  { key: "cloud.old-keys", steps: ["P15"] },
  { key: "cloud.setup-only-values", steps: ["P15"] },
];

// ---- 書きやすくするための部品（返すのはただのオブジェクト） ----
const CLOUD = "cloud/README.md";
const ONPREM = "onprem/README.md";
const MANUAL = "setup/manual-steps.md";
const SETUP = "setup/README.md";
const GA4 = "middleware/ga4/README.md";

const doc = (file, heading) => ({ file, heading });
const cloud = (...hs) => hs.map((h) => doc(CLOUD, h));
const onprem = (...hs) => hs.map((h) => doc(ONPREM, h));
const manual = (...hs) => hs.map((h) => doc(MANUAL, h));

const item = (key) => ({ kind: "item", key });
const items = (...keys) => ({ kind: "items", keys });
const mod = (module, phase) => ({ kind: "module", module, phase });
const drift = (id) => ({ kind: "drift", id });
const NONE = { kind: "none" };

// onprem/README.md の見出し（同じ名前の見出しが 2 つあるものは、使う側を決めて書く）
const ON_STRAPI = "2. Strapi";
const ON_N8N_BOOT = "3. n8n";
const ON_BOOT_ORDER = "起動の順番";
const ON_SYSTEMD = "常駐させる（systemd）";
const ON_CONTROL_SYSTEMD = "常駐させる（監視アプリ）";
const ON_OPEN = "開く（監視アプリ）";
const ON_STATUS = "設定の状況を有効にする";
const ON_N8N_PROD = "本番の n8n";
const ON_MCP = "本番の MCP";
const ON_MCP_DIST = "MCP サーバの dist";
const ON_WEBHOOK_TEST = "本番の Webhook の試し送信（I-11・I-12）";
const ON_SCHEDULES = "5. 定期実行を段階的に有効にする";
const ON_IMPACT = "止まったときの影響";

/** @type {Array<{ id: string; title: string; items: any[] }>} */
export const STEPS = [
  {
    id: "P1",
    title: "段階 env: 道具と設定ファイル",
    items: [
      { id: "P1.tools", title: "AWS CLI・SAM CLI・Docker・pnpm を入れて認証する", who: "人・端末", kind: "検査",
        overviewText: "AWS CLI・SAM CLI 1.154 以上", probe: mod("cloud", "env"), docs: cloud("2"), stopId: "cloud:env" },
      { id: "P1.samconfig", title: "cloud/samconfig.toml を作る（600）", who: "人・端末", kind: "検査",
        overviewText: "cp cloud/samconfig.toml.example", probe: mod("cloud", "env"), docs: cloud("2"), stopId: "cloud:env" },
      { id: "P1.google-client", title: "admin-auth（本番）の Google の OAuth クライアントを作る", who: "人・画面", kind: "検査",
        overviewText: "admin-auth（本番）の OAuth クライアントを作る", probe: mod("cloud", "env"), docs: cloud("4.6"), stopId: "cloud:env" },
      { id: "P1.samconfig-values", title: "samconfig.toml に必須の値を書く", who: "人・端末", kind: "検査",
        overviewText: "`samconfig.toml` に `RunLogAdminPrincipalArns`", probe: mod("cloud", "env"), docs: cloud("2"), stopId: "cloud:env" },
      { id: "P1.lambda-limit", title: "Lambda の同時実行数の上限が 121 以上か", who: "人・端末", kind: "未検査",
        overviewText: "Lambda の同時実行数の上限が 121 以上か", probe: NONE, docs: cloud("2") },
    ],
  },
  {
    id: "P2",
    title: "段階 deploy: スタックを作る",
    items: [
      { id: "P2.global", title: "global（us-east-1）をデプロイする", who: "人・端末", kind: "検査",
        overviewText: "`cd cloud && sam deploy --config-env global`", probe: mod("cloud", "deploy"), docs: cloud("4.1"), stopId: "cloud:global" },
      { id: "P2.cert-arns", title: "CertificateArn・WebAclArn を samconfig.toml に書く", who: "人・端末", kind: "検査",
        overviewText: "`CertificateArn`・`WebAclArn`", probe: mod("cloud", "deploy"), docs: cloud("4.1"), stopId: "cloud:cloudfront-params" },
      { id: "P2.sam-deploy", title: "sam build && sam deploy で本番スタックを作る", who: "人・端末", kind: "検査",
        overviewText: "`sam build && sam deploy`（`sam build` は省けない", probe: mod("cloud", "deploy"), docs: cloud("4.2"), stopId: "cloud:sam-deploy" },
      { id: "P2.secret", title: "Secret admin-auth/GOOGLE_CLIENT_SECRET に値を入れる", who: "人・端末", kind: "検査",
        overviewText: "GOOGLE_CLIENT_SECRET` に値を入れる", probe: mod("cloud", "deploy"), docs: cloud("4.6"), stopId: "cloud:secrets" },
      { id: "P2.global-second", title: "global の 2 回目（フラットレートプランの購読）", who: "人・端末", kind: "警告",
        overviewText: "global の 2 回目: 出力の", probe: item("cloud.global-second"), docs: cloud("4.3") },
      { id: "P2.sns", title: "SNS の 2 トピックをメールで購読し確認する", who: "人・端末", kind: "警告",
        overviewText: "SNS の 2 トピック", probe: item("cloud.sns-subscription"), docs: cloud("4.4") },
    ],
  },
  {
    id: "P3",
    title: "段階 images: 派生イメージ",
    items: [
      { id: "P3.push", title: "Chatwoot・Mautic の派生イメージをビルドして ECR にプッシュする", who: "人・端末", kind: "検査",
        overviewText: "派生イメージを `--platform linux/amd64`", probe: mod("cloud", "images"), docs: cloud("4.7"), stopId: "cloud:push" },
      { id: "P3.tags", title: "イメージのタグを samconfig.toml に書いて sam deploy する", who: "人・端末", kind: "検査",
        overviewText: "タグ（`ChatwootImageTag`・`MauticImageTag`）を", probe: mod("cloud", "images"), docs: cloud("4.7"), stopId: "cloud:push" },
    ],
  },
  {
    id: "P4",
    title: "データ層の仕上げ（cloud の段階 apps）",
    items: [
      { id: "P4.db-init", title: "DB とアプリ用ユーザーを作る（db-init）", who: "人・端末", kind: "検査",
        overviewText: "DB とアプリ用ユーザーを作る", probe: mod("cloud", "apps"), docs: cloud("4.8"), stopId: "cloud:db-init" },
      { id: "P4.smtp", title: "SES の SMTP 認証情報を Mautic 用・Chatwoot 用に別々に発行し Secret に入れる", who: "人・画面", kind: "警告",
        overviewText: "SES の SMTP 認証情報を **Mautic 用と Chatwoot 用で別々に**", probe: item("cloud.smtp-secrets"), docs: cloud("4.9.3", "4.9.4") },
      { id: "P4.dkim-dmarc", title: "DKIM・MAIL FROM を SUCCESS にし、apex に DMARC を足す", who: "人・画面", kind: "警告",
        overviewText: "DKIM と MAIL FROM が `SUCCESS` になるのを待ち", probe: items("cloud.ses-domain", "cloud.dmarc"), docs: cloud("4.9.1", "4.9.6") },
    ],
  },
  {
    id: "P5",
    title: "admin-auth（管理画面の関門）",
    items: [
      { id: "P5.migrate", title: "admin-auth-ops で migrate と register-alb-client を実行する", who: "人・端末", kind: "検査",
        overviewText: "運用の Lambda（`admin-auth-ops`）に", probe: mod("admin-auth", "apps"), docs: cloud("4.19", "7.2"), stopId: "admin-auth:prod-migrate" },
      { id: "P5.login", title: "管理画面を開き、Google でログインして戻れることを確かめる", who: "人・画面", kind: "未検査",
        overviewText: "Google でログインして戻ってこられることを確かめる", probe: NONE, docs: [] },
      { id: "P5.ready-flag", title: "prod.conf に ADMIN_AUTH_PROD_READY=yes", who: "人・端末", kind: "申告",
        overviewText: "`ADMIN_AUTH_PROD_READY=yes`", probe: NONE, docs: cloud("7.2") },
    ],
  },
  {
    id: "P6",
    title: "オンプレの本番（WireGuard → Strapi → n8n）",
    items: [
      { id: "P6.wireguard", title: "WireGuard を立ち上げる（鍵・wg0.conf・疎通）", who: "人・端末", kind: "検査",
        overviewText: "WireGuard: 鍵を作る", probe: mod("onprem", "apps"), docs: cloud("4.2.1"), stopId: "onprem:onprem-bringup" },
      { id: "P6.ami", title: "WireGuard の AMI を固定する", who: "人・端末", kind: "警告",
        overviewText: "WireGuard の AMI を固定する", probe: item("cloud.wireguard-ami"), docs: cloud("4.2.1") },
      { id: "P6.keys", title: "IAM ユーザー 2 つのアクセスキーを発行する", who: "人・端末", kind: "警告",
        overviewText: "IAM ユーザー 2 つのアクセスキーを発行する", probe: item("cloud.onprem-keys"), docs: cloud("4.5") },
      { id: "P6.rds-env", title: "RDS のパスワードとエンドポイントを onprem の .env に写す", who: "人・端末", kind: "検査",
        overviewText: "RDS の `strapi`・`n8n` のパスワード", probe: mod("onprem", "apps"), docs: [...cloud("4.8"), ...onprem(ON_BOOT_ORDER)], stopId: "onprem:onprem-bringup" },
      { id: "P6.strapi", title: "Strapi を起動する（/_health が 204）", who: "人・端末", kind: "検査",
        overviewText: "Strapi: `./dev/init-env.sh`", probe: mod("onprem", "apps"), docs: onprem(ON_STRAPI), stopId: "onprem:onprem-bringup" },
      { id: "P6.n8n", title: "n8n を起動する（/healthz）", who: "人・端末", kind: "検査",
        overviewText: "n8n: `./dev/init-env.sh`", probe: mod("onprem", "apps"), docs: onprem(ON_N8N_BOOT), stopId: "onprem:onprem-bringup" },
      { id: "P6.systemd", title: "systemd のユニットを置く", who: "人・端末", kind: "検査",
        overviewText: "systemd のユニットを置く", probe: mod("onprem", "apps"), docs: onprem(ON_SYSTEMD), stopId: "onprem:onprem-bringup" },
      { id: "P6.strapi-tokens", title: "本番の Strapi で最初の管理者を作り、トークンを 2 つ発行する", who: "人・画面", kind: "未検査",
        overviewText: "最初の管理者を作り、トークンを 2 つ発行する", probe: NONE, docs: onprem(ON_MCP) },
    ],
  },
  {
    id: "P7",
    title: "Chatwoot（chatwoot-prod）",
    items: [
      { id: "P7.chatwoot-prepare", title: "db:chatwoot_prepare を RunTask で実行する", who: "人・端末", kind: "未検査",
        overviewText: "`db:chatwoot_prepare` を RunTask で実行する", probe: NONE, docs: cloud("4.10"), stopId: "chatwoot-prod:ecs" },
      { id: "P7.desired-count", title: "ChatwootWebDesiredCount・ChatwootWorkerDesiredCount を 1 にする", who: "人・端末", kind: "検査",
        overviewText: "`ChatwootWebDesiredCount=1`", probe: mod("chatwoot-prod", "apps"), docs: cloud("4.11"), stopId: "chatwoot-prod:ecs" },
      { id: "P7.onboarding", title: "onboarding で最初の管理者とアカウントを作り、トークンと ID を書く", who: "人・画面", kind: "検査",
        overviewText: "onboarding で最初の管理者とアカウントを作る", probe: mod("chatwoot-prod", "apps"), docs: cloud("7.3"), stopId: "chatwoot-prod:onboarding" },
      { id: "P7.agent-user", title: "エージェント専用ユーザー（担当者の権限）を招待し、トークンを書く", who: "人・画面", kind: "検査",
        overviewText: "エージェント専用ユーザー（担当者の権限）を招待", probe: mod("chatwoot-prod", "apps"), docs: cloud("7.3"), stopId: "chatwoot-prod:onboarding" },
      { id: "P7.faq-bot-setup", title: "FAQ ボットの送り先を書いて再実行する（受信箱・ラベル・FAQ ボット・マクロ・通知）", who: "人・端末", kind: "検査",
        overviewText: "出力 `FaqBotFunctionUrl`", probe: item("chatwoot-prod.admin-token-checks"), docs: [] },
      { id: "P7.faq-bot-secrets", title: "FAQ ボットの access_token と secret を Secrets Manager に入れる", who: "人・端末", kind: "申告",
        overviewText: "FAQ ボットの access_token と secret を Secrets Manager に入れる", probe: NONE, docs: cloud("7.3", "4.17"), stopId: "chatwoot-prod:faq-bot-secrets" },
    ],
  },
  {
    id: "P8",
    title: "Mautic（mautic-prod）",
    items: [
      { id: "P8.web-count", title: "MauticWebDesiredCount を 1 にして sam deploy", who: "人・端末", kind: "検査",
        overviewText: "`MauticWebDesiredCount=1` を書いて", probe: mod("mautic-prod", "apps"), docs: cloud("4.11"), stopId: "mautic-prod:ecs-web" },
      { id: "P8.installer", title: "/installer で Mautic をインストールする", who: "人・画面", kind: "検査",
        overviewText: "`https://mkt.comegin.com/installer` でインストールする", probe: mod("mautic-prod", "apps"), docs: cloud("4.10") },
      { id: "P8.settings", title: "管理画面の Configuration（Site URL・API・Webhook・メール）を設定する", who: "人・画面", kind: "検査",
        overviewText: "管理者でログインし、右上の歯車 → Configuration で設定する", probe: mod("mautic-prod", "apps"), docs: cloud("4.10", "4.9.5", "7.4"), stopId: "mautic-prod:settings" },
      { id: "P8.setup-client", title: "初期設定用の API 認証情報を作り、MAUTIC_PROD_SETTINGS_DONE=yes", who: "人・画面", kind: "申告",
        overviewText: "初期設定用の API 認証情報を作る", probe: NONE, docs: cloud("7.4"), stopId: "mautic-prod:settings" },
      { id: "P8.apply", title: "mautic-prod を実行する（カスタム項目・フォーム consult・自動返信・セグメント mql）", who: "人・端末", kind: "検査",
        overviewText: "`node setup/setup.mjs --target prod --only mautic-prod`", probe: mod("mautic-prod", "apps"), docs: [] },
      { id: "P8.cron-count", title: "MauticCronDesiredCount を 1 にして sam deploy", who: "人・端末", kind: "検査",
        overviewText: "`MauticCronDesiredCount=1`", probe: mod("mautic-prod", "apps"), docs: cloud("4.11"), stopId: "mautic-prod:ecs-cron" },
    ],
  },
  {
    id: "P9",
    title: "本番の n8n（n8n-prod）",
    items: [
      { id: "P9.mautic-credentials", title: "本番の Mautic で n8n 用の API 認証情報を作り、N8N_MAUTIC_CLIENT_* に書く", who: "人・画面", kind: "検査",
        overviewText: "本番の Mautic で **n8n 用の** API 認証情報を作り", probe: mod("n8n-prod", "apps"), docs: onprem(ON_N8N_PROD), stopId: "n8n-prod:mautic-api-credentials" },
      { id: "P9.chatwoot-token", title: "CHATWOOT_ADMIN_TOKEN と、任意で棚卸し専用のトークンを書く", who: "人・端末", kind: "検査",
        overviewText: "`CHATWOOT_ADMIN_TOKEN`（P7 と同じ）と、任意で棚卸し専用", probe: item("n8n-prod.admin-token-checks"), docs: onprem(ON_N8N_PROD), stopId: "n8n-prod:chatwoot-admin-token" },
      { id: "P9.aws-key", title: "onprem-n8n-sns のキーを AWS_ACCESS_KEY_ID・AWS_SECRET_ACCESS_KEY に書く", who: "人・端末", kind: "検査",
        overviewText: "P6 で発行した `onprem-n8n-sns` のキー", probe: mod("n8n-prod", "apps"), docs: onprem(ON_N8N_PROD), stopId: "n8n-prod:aws-key" },
      { id: "P9.apply", title: "再実行する（オーナー・API キー・MCP のトークン・provision）", who: "自動", kind: "検査",
        overviewText: "再実行で **自動**（オーナー・API キー・MCP のトークン", probe: mod("n8n-prod", "apps"), docs: [] },
      { id: "P9.publish-parents", title: "親（I-11・I-12）の公開を決める", who: "判断", kind: "判断",
        overviewText: "親（I-11・I-12）の公開は R1 が決める", probe: NONE, docs: onprem(ON_IMPACT) },
      { id: "P9.heartbeat", title: "ハートビートを有効にする（ops_settings の heartbeatEnabled）", who: "人・画面", kind: "警告",
        overviewText: "ハートビートを有効にする", probe: mod("n8n-prod", "apps"), docs: cloud("4.10") },
      { id: "P9.webhook-test", title: "フォームとチャットの本物のイベントがオンプレの n8n に届くことを確かめる", who: "人・画面", kind: "未検査",
        overviewText: "公開サイトのフォームの送信とチャットで本物のイベントを起こし", probe: NONE, docs: [...onprem(ON_WEBHOOK_TEST), ...cloud("4.13")] },
    ],
  },
  {
    id: "P10",
    title: "本番の MCP（mcp-prod）",
    items: [
      { id: "P10.tokens", title: "エージェント専用のトークンと API 認証情報を発行して prod.conf に書く", who: "人・画面", kind: "検査",
        overviewText: "エージェント専用のアカウントでトークンを発行して `prod.conf` に書く", probe: item("mcp-prod.values"), docs: onprem(ON_MCP), stopId: "mcp-prod:prod-values" },
      { id: "P10.build", title: "チェックアウトを合わせて chatwoot-mcp・mautic-mcp の dist をビルドする", who: "人・端末", kind: "検査",
        overviewText: "`checkout --detach origin/main` で合わせ、`backend/chatwoot-mcp`", probe: item("mcp-prod.dist"), docs: onprem(ON_MCP_DIST), stopId: "mcp-prod:finish" },
      { id: "P10.merge", title: "修正がまだ origin/main に入っていないなら、PR で main にマージする", who: "人・GitHub", kind: "検査",
        overviewText: "「修正がまだ origin/main に入っていない」と出たら", probe: mod("mcp-prod", "apps"), docs: onprem(ON_MCP_DIST), stopId: "mcp-prod:finish" },
      { id: "P10.apply", title: "再実行する（env ファイル 6 つ・読み取りだけの確認）", who: "自動", kind: "検査",
        overviewText: "再実行で **自動**（env ファイル 6 つ", probe: mod("mcp-prod", "apps"), docs: [] },
    ],
  },
  {
    id: "P11",
    title: "公開サイトの値（setup/frontend.mjs --target prod）",
    items: [
      { id: "P11.calcom", title: "Cal.com に完了画面で予約させるイベント「オンライン面談」を作る", who: "人・画面", kind: "検査",
        overviewText: "Cal.com（SaaS。ADR-24）に完了画面で予約させるイベント", probe: mod("verdant-virgo", "apps"), docs: [], stopId: "verdant-virgo:prod-values" },
      { id: "P11.values", title: "prod.conf に CALCOM_LINK・SITE_BUILD_CHECKOUT・PUBLIC_SITE_URL などを書く", who: "人・端末", kind: "検査",
        overviewText: "`prod.conf` に `CALCOM_LINK`（上で控えた", probe: mod("verdant-virgo", "apps"), docs: [doc(SETUP, "フロントエンド全体")], stopId: "verdant-virgo:prod-values" },
      { id: "P11.apply", title: "再実行する（.env.production を書く）", who: "自動", kind: "検査",
        overviewText: "再実行で **自動**（`.env.production` を書く", probe: mod("verdant-virgo", "apps"), docs: [] },
    ],
  },
  {
    id: "P12",
    title: "ビルドと配信〔未検査〕",
    items: [
      { id: "P12.strapi-content", title: "本番の Strapi にカテゴリ 3 つと公開済みの記事が 1 本以上ある", who: "人・画面", kind: "未検査",
        overviewText: "カテゴリ 3 つ（slug は", probe: NONE, docs: cloud("4.14") },
      { id: "P12.build", title: "承認済みの main のチェックアウトの frontend/verdant-virgo でビルドする", who: "人・端末", kind: "検査",
        overviewText: "**承認済みの main のチェックアウト**（`SITE_BUILD_CHECKOUT`。空なら", probe: drift("site-redeploy"), docs: cloud("4.14") },
      { id: "P12.rebuild", title: "PR をマージするたび、チェックアウトを合わせてビルドし直す", who: "人・端末", kind: "検査",
        overviewText: "**PR をマージするたび**", probe: drift("site-redeploy"), docs: cloud("4.14") },
      { id: "P12.predeploy-checks", title: "同期の前に、dist に開発の接続先が無く本番の受け口が焼き込まれていることを確かめる", who: "人・端末", kind: "未検査",
        overviewText: "同期の前に、`dist` に開発の接続先", probe: NONE, docs: cloud("4.14") },
      { id: "P12.deploy-principal", title: "初回だけ: 配信用の主体（許可セット ComeginProdDeploy）を作る", who: "人・端末", kind: "警告",
        overviewText: "初回だけ: 配信用の主体を作る", probe: item("cloud.deploy-principal"), docs: cloud("4.5.1") },
      { id: "P12.sync", title: "dist を S3 へ同期し、CloudFront を無効化する", who: "人・端末", kind: "未検査",
        overviewText: "スタックをデプロイした主体（`comegin-prod-admin`）でバケット名", probe: NONE, docs: cloud("4.14") },
      { id: "P12.post-checks", title: "デプロイ後の確認（訪問者向けは 200・管理画面は 302・許可リストの外は 404）", who: "人・端末", kind: "未検査",
        overviewText: "デプロイ後の確認（訪問者向けは 200", probe: NONE, docs: cloud("4.13") },
      { id: "P12.faq-check", title: "FAQ ボットの確認（faq.json・回答・担当者への引き継ぎ）", who: "人・画面", kind: "未検査",
        overviewText: "FAQ ボットの確認（`/faq.json` が返る", probe: NONE, docs: cloud("4.17") },
      { id: "P12.ses-request", title: "配信したらすぐ、SES の本番アクセスを申請する", who: "人・画面", kind: "警告",
        overviewText: "SES の**本番アクセスを申請する**", probe: item("cloud.ses-production"), docs: cloud("4.9.2") },
    ],
  },
  {
    id: "P13",
    title: "段階 google（公開サイトが Route 53 から配信された後）",
    items: [
      { id: "P13.ga4", title: "GA4 の本番のプロパティと Web ストリームを作り、ID を書く", who: "人・画面", kind: "検査",
        overviewText: "GA4 の本番のプロパティと Web ストリームを作り", probe: mod("ga4", "google"), docs: manual("7.5"), stopId: "ga4:property" },
      { id: "P13.gsc", title: "Search Console にドメインプロパティを登録し、Route 53 に TXT を足す", who: "人・画面", kind: "検査",
        overviewText: "Search Console にドメインプロパティ `comegin.com` を登録し", probe: mod("verdant-virgo", "google"), docs: manual("7.4"), stopId: "verdant-virgo:gsc-domain" },
      { id: "P13.openseo-client", title: "OpenSEO 用の OAuth クライアントを作り、OPENSEO_GOOGLE_CLIENT_* に書く", who: "人・画面", kind: "検査",
        overviewText: "OpenSEO 用の OAuth クライアント（Search Console API", probe: mod("openseo", "google"), docs: manual("7.4", "7.5") },
      { id: "P13.openseo-project", title: "OpenSEO のプロジェクトの Domain を comegin.com にする（1 つだけ）", who: "人・画面", kind: "検査",
        overviewText: "`openseo:project` `http://localhost:3001` のプロジェクトの Domain", probe: mod("openseo", "google"), docs: manual("7.4", "7.6"), stopId: "openseo:project" },
      { id: "P13.openseo-connect", title: "そのプロジェクトで Search Console と GA4（本番のプロパティ）に接続する", who: "人・画面", kind: "検査",
        overviewText: "そのプロジェクトの Project settings → Integrations で Search Console", probe: mod("openseo", "google"), docs: manual("7.4", "7.5"), stopId: "openseo:gsc-connect" },
      { id: "P13.google-phase", title: "frontend.mjs --phase google を実行して .env.production に測定 ID を書き直す", who: "人・端末", kind: "検査",
        overviewText: "を（`--check` ではなく）実行して", probe: mod("verdant-virgo", "google"), docs: [] },
      { id: "P13.rebuild-deploy", title: "測定 ID 入りでビルドし直して配信する", who: "人・端末", kind: "未検査",
        overviewText: "測定 ID 入りでビルドし直して、P12 と同じ手順で配信する", probe: NONE, docs: [...cloud("4.14"), doc(GA4, "5.1")] },
      { id: "P13.consent-check", title: "同意の前に googletagmanager.com へのリクエストが無く、同意の後に GA4 のリアルタイムに出る", who: "人・画面", kind: "未検査",
        overviewText: "配信の後、同意の前に `googletagmanager.com`", probe: NONE, docs: [doc(GA4, "5.1")] },
      { id: "P13.sitemap", title: "Search Console にサイトマップを送信し、成功することを確かめる", who: "人・画面", kind: "未検査",
        overviewText: "**サイトマップ** に", probe: NONE, docs: manual("7.4") },
    ],
  },
  {
    id: "P14",
    title: "段階 operate: 改善ループ（監視アプリ）を本番で動かす",
    items: [
      { id: "P14.checkout", title: "チェックアウトを origin/main に合わせる", who: "人・端末", kind: "検査",
        overviewText: "`next-js-prod:checkout` チェックアウトを", probe: item("next-js-prod.checkout"), docs: manual("6"), stopId: "next-js-prod:checkout" },
      { id: "P14.build", title: "チェックアウトで backend/control-plane → frontend/next-js の順にビルドする", who: "人・端末", kind: "検査",
        overviewText: "`next-js-prod:build` チェックアウトで", probe: item("next-js-prod.build"), docs: [], stopId: "next-js-prod:build" },
      { id: "P14.principal", title: "IAM ユーザー comegin-prod-control-plane を作り、キーを資格情報ファイルに書く", who: "人・端末", kind: "検査",
        overviewText: "`next-js-prod:principal` IAM ユーザー", probe: item("next-js-prod.principal"), docs: cloud("4.5.2"), stopId: "next-js-prod:principal" },
      { id: "P14.status-principal", title: "IAM ユーザー comegin-prod-status-reader を作り、キーを資格情報ファイルに書く（設定の状況の主体）", who: "人・端末", kind: "検査",
        overviewText: "`next-js-prod:status-principal` IAM ユーザー", probe: item("next-js-prod.status-principal"), docs: [...cloud("4.5.3"), ...onprem(ON_STATUS)], stopId: "next-js-prod:status-principal" },
      { id: "P14.status-github", title: "参照専用の GitHub のトークンをファイルに書く（設定の状況用）", who: "人・端末", kind: "検査",
        overviewText: "`next-js-prod:status-github` 参照専用の GitHub のトークン", probe: item("next-js-prod.status-github"), docs: [...onprem(ON_STATUS), ...cloud("4.5.3")], stopId: "next-js-prod:status-github" },
      { id: "P14.prod-values", title: "prod.conf に ANTHROPIC_API_KEY などを書く", who: "人・端末", kind: "検査",
        overviewText: "`next-js-prod:prod-values` `prod.conf` に", probe: item("next-js-prod.prod-values"), docs: onprem(ON_OPEN), stopId: "next-js-prod:prod-values" },
      { id: "P14.systemd", title: "comegin-control.service を置いて enable --now する", who: "人・端末", kind: "検査",
        overviewText: "`next-js-prod:systemd`・`systemd-dir`・`restart`", probe: item("next-js-prod.systemd"), docs: onprem(ON_CONTROL_SYSTEMD), stopId: "next-js-prod:systemd" },
      { id: "P14.login", title: "http://127.0.0.1:3200 を開き、Google でログインできる", who: "人・ブラウザ", kind: "検査",
        overviewText: "`http://127.0.0.1:3200` を開き、Google でログインできる", probe: item("next-js-prod.respond"), docs: onprem(ON_OPEN), stopId: "next-js-prod:start" },
      { id: "P14.openseo", title: "OpenSEO が常駐し、本番のプロジェクトと Search Console・GA4 の接続が揃っている", who: "人・端末", kind: "警告",
        overviewText: "OpenSEO（`127.0.0.1:3001`）が常駐している", probe: mod("openseo", "operate"), docs: [...onprem("常駐させる（OpenSEO）"), ...manual("7.6")] },
      { id: "P14.heartbeat-alarm", title: "アラーム comegin-prod-onprem-heartbeat が OK に戻る", who: "自動", kind: "警告",
        overviewText: "アラーム `comegin-prod-onprem-heartbeat` が OK に戻る", probe: item("next-js-prod.heartbeat-alarm"), docs: cloud("4.13") },
      { id: "P14.schedules", title: "ops/schedules/*.yaml の有効な定期実行が 1 本以上ある", who: "人・GitHub", kind: "警告",
        overviewText: "有効な定期実行が 0 本のうちは警告が出る", probe: item("next-js-prod.schedules-enabled"), docs: onprem(ON_SCHEDULES) },
      { id: "P14.first-run", title: "最初の定期実行の後、success・skipped の理由を見る", who: "人・画面", kind: "未検査",
        overviewText: "最初の定期実行の後、監視アプリの画面", probe: NONE, docs: onprem(ON_SCHEDULES) },
      { id: "P14.night", title: "オンプレのマシンが夜（0〜8 時）も動いている", who: "人・端末", kind: "未検査",
        overviewText: "オンプレのマシン（VM ならホストも）が夜", probe: NONE, docs: onprem(ON_SCHEDULES) },
      { id: "P14.n8n-schedule", title: "本番の n8n のスケジュールをリポジトリの JSON に合わせる", who: "人・端末", kind: "検査",
        overviewText: "本番の n8n のスケジュール（週次の棚卸しは月曜 07:00）", probe: drift("n8n-workflows"), docs: onprem(ON_SCHEDULES) },
    ],
  },
  {
    id: "P15",
    title: "段階 operate: 運用開始の仕上げ",
    items: [
      { id: "P15.deploy-principal", title: "配信用の主体（許可セット ComeginProdDeploy）がある", who: "人・端末", kind: "警告",
        overviewText: "配信用の主体（許可セット `ComeginProdDeploy`）がある", probe: item("cloud.deploy-principal"), docs: cloud("4.5.1") },
      { id: "P15.old-keys", title: "IAM ユーザーの有効なアクセスキーが 1 つだけ（古いキーを消す）", who: "人・端末", kind: "警告",
        overviewText: "IAM ユーザー（`onprem-strapi-media`・`onprem-n8n-sns`・`control-plane`）の有効なキーが 1 つだけ", probe: item("cloud.old-keys"), docs: cloud("4.5") },
      { id: "P15.setup-only", title: "初期設定用の値（CHATWOOT_ADMIN_TOKEN・MAUTIC_SETUP_CLIENT_*）を prod.conf から消す", who: "人・端末", kind: "警告",
        overviewText: "初期設定が終わったら、`prod.conf` から `CHATWOOT_ADMIN_TOKEN`", probe: item("cloud.setup-only-values"), docs: cloud("7.3", "7.4") },
      { id: "P15.ses-approved", title: "SES の本番アクセス（P12 で申請したもの）が承認されている", who: "人・画面", kind: "警告",
        overviewText: "SES の本番アクセス（P12 で申請したもの）が承認されている", probe: item("cloud.ses-production"), docs: cloud("4.9.2") },
      { id: "P15.members", title: "ほかの担当者を Chatwoot の受信箱「Web サイト」のメンバーにし、メール通知を有効にする", who: "人・画面", kind: "未検査",
        overviewText: "ほかの担当者を Chatwoot の受信箱「Web サイト」のメンバーにし", probe: NONE, docs: cloud("4.17", "7.3") },
      { id: "P15.r1", title: "6 節（R1）の判断の項目", who: "判断", kind: "判断",
        overviewText: "[6 節](#6-判断が残っている項目r1)の項目", probe: NONE, docs: [] },
    ],
  },
  {
    id: "R1",
    title: "判断が残っている項目（6 節）",
    items: [
      { id: "R1.db", title: "DB をサーバーレスのままにするか、クラスター（プロビジョンド）にするか", who: "判断", kind: "判断",
        overviewText: "**DB をサーバーレスのままにするか", probe: NONE, docs: cloud("6") },
      { id: "R1.waf", title: "WAF の Common ルールを Count から Block に", who: "判断", kind: "判断",
        overviewText: "WAF の Common ルールを Count から Block に", probe: NONE, docs: cloud("4.16") },
      { id: "R1.n8n-parents", title: "n8n の親（I-11・I-12）の公開", who: "判断", kind: "判断",
        overviewText: "n8n の親（I-11・I-12）の公開", probe: NONE, docs: [doc("middleware/n8n/provision/README.md", "provision")] },
      { id: "R1.n8n-export", title: "daily-n8n-export の API キーを監視アプリの env に置き続けるか", who: "判断", kind: "判断",
        overviewText: "`daily-n8n-export`（本番の n8n のワークフローの書き出し）の API キー", probe: NONE,
        docs: [doc("backend/control-plane/README.md", "n8n-export"), doc("ops/README.md", "定期実行の定義")] },
      { id: "R1.ses-tls", title: "SES の TLS を必須のままにするか", who: "判断", kind: "判断",
        overviewText: "SES の TLS を必須のままにするか", probe: NONE, docs: cloud("4.9") },
      { id: "R1.bounce", title: "バウンス・苦情を Mautic に返す Lambda（ADR-30）をいつ作るか", who: "判断", kind: "判断",
        overviewText: "バウンス・苦情を Mautic に返す Lambda", probe: NONE, docs: [doc("docs/RequirementDefinition/AA/05-application-decisions.md", "ADR-30")] },
      { id: "R1.mail-type", title: "SES の Mail type を Marketing に改めるか", who: "判断", kind: "判断",
        overviewText: "SES の Mail type を Marketing に改めるか", probe: NONE, docs: cloud("4.9.2") },
      { id: "R1.cost", title: "費用を下げる手段（Savings Plans・Fargate の ARM など）", who: "判断", kind: "判断",
        overviewText: "費用を下げる手段", probe: NONE, docs: cloud("3.1") },
      { id: "R1.csp", title: "公開サイトの CSP をどこで付けるか", who: "判断", kind: "判断",
        overviewText: "公開サイトの CSP をどこで付けるか", probe: NONE, docs: cloud("5") },
    ],
  },
];
