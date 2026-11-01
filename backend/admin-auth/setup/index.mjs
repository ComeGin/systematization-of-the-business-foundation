// admin-auth（Better Auth を OIDC Provider にして、ALB の authenticate-oidc の IdP にする。http://127.0.0.1:3103）の設定。
// setup/lib/core.mjs の契約に従う。
//
// 確かめた出典: backend/admin-auth/dev/init-env.sh（BETTER_AUTH_SECRET・DATABASE_PASSWORD・ALB_CLIENT_ID・ALB_CLIENT_SECRET を生成する。冪等）、
// compose.yml（postgres → migrate（一度だけ）→ admin-auth）、README.md の「起動（ローカル）」
// （Google の ID とシークレットが空でも discovery と JWKS は返る。ログインはできない）。
//
// 本番（prod。ADR-26 で ALB 配下の Lambda）: DB の移行と ALB のクライアント登録は、運用の Lambda（admin-auth-ops）に
// {"action":"migrate"}・{"action":"register-alb-client"} を送って行う（cloud/README.md の 4.19）。AWS への書き込みになるので、
// このスクリプトは呼ばずに手順を案内して止まる。check と apply は、本番の discovery（ALB のルール 300 経由）を読むだけ。
// 済んだことは prod.conf の ADMIN_AUTH_PROD_READY=yes で知らせる（移行の有無は DB の中で、外から読み取りだけでは確かめられない）。
// 開発環境では ALB が無いので、register-alb-client は呼ばない。
import { join } from "node:path";

export const meta = { id: "admin-auth", title: "admin-auth（Better Auth の OIDC Provider）", targets: ["dev", "prod"], phases: ["apps"], after: [] };

const DIR = "backend/admin-auth";
const BASE = "http://127.0.0.1:3103";
const DISCOVERY = `${BASE}/.well-known/openid-configuration`;
const PROD_AUTH_HOST = "auth.comegin.com"; // cloud/template.yaml の AuthHost の既定。違うなら prod.conf の AUTH_HOST

const prodDiscoveryUrl = (ctx) => `https://${ctx.value("AUTH_HOST") || PROD_AUTH_HOST}/.well-known/openid-configuration`;
const prodReady = (ctx) => /^(yes|true|1)$/i.test(String(ctx.value("ADMIN_AUTH_PROD_READY") ?? "").trim());

/** 本番の discovery を読む（読み取りだけ）。応答が無い・形が違うときは null */
async function prodDiscovery(ctx) {
  try {
    const doc = await ctx.http("本番の admin-auth（discovery）", prodDiscoveryUrl(ctx), { timeoutMs: 10_000 });
    return doc?.issuer && doc?.jwks_uri ? doc : null;
  } catch {
    return null;
  }
}

function prodSteps() {
  const ops = `OPS=$(aws cloudformation describe-stacks --region ap-northeast-1 --stack-name comegin-prod --query "Stacks[0].Outputs[?OutputKey=='AdminAuthOpsFunctionName'].OutputValue" --output text)`;
  const invoke = (action) => `aws lambda invoke --region ap-northeast-1 --function-name "$OPS" --cli-binary-format raw-in-base64-out --payload '{"action":"${action}"}' /dev/stdout（結果が {"ok":true,…} であること）`;
  return [
    "前提（cloud/README.md）: 4.6 の Secret admin-auth/GOOGLE_CLIENT_SECRET、デプロイの設定ファイル（2 節）のパラメータ GoogleClientId と AdminBootstrapEmails（空のまま migrate すると誰もログインできない）、4.8 の DB とアプリ用ユーザーの作成",
    `人が自分の端末で実行する（AWS への書き込み）: ${ops}`,
    invoke("migrate"),
    invoke("register-alb-client"),
    "管理画面（https://chat.comegin.com/app/ など）を開き、auth. で Google ログインして戻ってこられることを確かめる（cloud/README.md の 4.19 の 4）",
    "~/.config/comegin/setup/prod.conf に ADMIN_AUTH_PROD_READY=yes を書き、同じコマンドを実行し直す",
  ];
}

async function discovery(ctx) {
  try {
    return await ctx.http("admin-auth", DISCOVERY, { timeoutMs: 5_000 });
  } catch {
    return null;
  }
}

/** migrate が DB のパスワード違いで落ちたか（docker compose logs migrate の最後の行を見る。秘密値は出ない） */
async function passwordMismatch(ctx, dir) {
  const out = await ctx.run("docker", ["compose", "logs", "--no-color", "--tail", "20", "migrate"], { cwd: dir }).catch(() => "");
  return /password authentication failed/i.test(out);
}

/**
 * DB のユーザーのパスワードを、postgres コンテナの環境変数 POSTGRES_PASSWORD（compose が環境変数ファイルの DATABASE_PASSWORD から渡す）にそろえる。
 * コンテナの中のソケット接続は trust（公式イメージの pg_hba.conf）なので、今のパスワードは要らない。
 * パスワードはコンテナの中の環境変数から psql の \getenv（PostgreSQL 15 以降）で読み、標準入力の SQL で渡す（コマンドラインにもログにも出ない）
 */
async function syncDbPassword(ctx, dir) {
  const sql = ["\\getenv u POSTGRES_USER", "\\getenv pw POSTGRES_PASSWORD", "ALTER ROLE :\"u\" PASSWORD :'pw';", ""].join("\n");
  await ctx.run("docker", ["compose", "exec", "-T", "postgres", "sh", "-c", 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"'], { cwd: dir, input: sql });
  ctx.log("DB のユーザーのパスワードを環境変数ファイルの値にそろえた（データはそのまま）");
}

export async function check(ctx) {
  if (ctx.target === "prod") {
    const doc = await prodDiscovery(ctx);
    return {
      ok: Boolean(doc) && prodReady(ctx),
      notes: [
        `本番の discovery（${prodDiscoveryUrl(ctx)}）: ${doc ? `応答あり（issuer ${doc.issuer}）` : "応答なし（sam deploy の前か、ALB・Lambda の不調）"}`,
        prodReady(ctx) ? "移行と ALB の登録は済みと申告されている（ADMIN_AUTH_PROD_READY）" : "移行と ALB の登録（運用の Lambda）が済んだと申告されていない（ADMIN_AUTH_PROD_READY=yes）",
      ],
    };
  }
  const env = ctx.readEnvFile(join(ctx.W, DIR, ".env"));
  const doc = await discovery(ctx);
  const google = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  return {
    ok: Boolean(env.BETTER_AUTH_SECRET && env.DATABASE_PASSWORD) && Boolean(doc?.issuer),
    notes: [
      `環境変数ファイルの秘密値: ${env.BETTER_AUTH_SECRET && env.DATABASE_PASSWORD ? "入っている" : "まだ（apply で dev/init-env.sh）"}`,
      `GET /.well-known/openid-configuration: ${doc?.issuer ? `応答あり（issuer ${doc.issuer}）` : "応答なし（apply で compose up）"}`,
      `Google ログインの資格情報: ${google ? "入っている" : "空（discovery は返るが、ログインはできない）"}／管理者の許可リスト: ${env.ADMIN_BOOTSTRAP_EMAILS ? "入っている" : "空"}`,
    ],
  };
}

export async function apply(ctx) {
  if (ctx.target === "prod") {
    const doc = await prodDiscovery(ctx);
    if (!doc) {
      ctx.manual("prod-deploy", `本番の admin-auth が応答しない（${prodDiscoveryUrl(ctx)}）`, [
        "先に段階 deploy を済ませる: node setup/setup.mjs --target prod --phase deploy（cloud/README.md の 4.2。faq-bot・consent-api・admin-auth の Lambda は sam build でまとめる。ECR は使わない）",
        "済んでいて応答しないなら、ロググループ /aws/lambda/comegin-prod-admin-auth と、アラーム admin-auth-errors・admin-auth-target-5xx を見る",
        "同じコマンドを実行し直す",
      ]);
    }
    ctx.log(`本番の discovery に応答あり（issuer ${doc.issuer}）`);
    if (!prodReady(ctx)) ctx.manual("prod-migrate", "運用の Lambda（admin-auth-ops）で DB を移行し、ALB のクライアントを登録する", prodSteps());
    ctx.log("移行と ALB の登録は済みと申告されている（ADMIN_AUTH_PROD_READY）");
    return;
  }
  const dir = join(ctx.W, DIR);
  const envPath = join(dir, ".env");

  // 1. 秘密値の生成（空のキーだけ書く。既存の値は変えない）
  await ctx.run("bash", ["dev/init-env.sh"], { cwd: dir });
  ctx.log("dev/init-env.sh: 済み");

  // 2. 人が入れる値。設定（dev.conf）に書かれていれば写す。Google の値は明示した値を優先して書き換える。
  //    許可リストの初期値は、設定になければ管理者のメールアドレス（起動時に表へ足すだけで、削除はしない）
  const google = {};
  for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) if (ctx.conf[k]) google[k] = ctx.conf[k];
  const changed = [
    ...ctx.writeEnvFile(envPath, google, { onlyIfEmpty: false }),
    ...ctx.writeEnvFile(envPath, { ADMIN_BOOTSTRAP_EMAILS: ctx.conf.ADMIN_BOOTSTRAP_EMAILS || ctx.value("ADMIN_EMAIL"), GOOGLE_HOSTED_DOMAIN: ctx.conf.GOOGLE_HOSTED_DOMAIN }),
  ];
  if (changed.length) ctx.log(`環境変数ファイルに書いた: ${changed.join(", ")}`);

  // 3. 起動（postgres → migrate → admin-auth。イメージのビルドも compose が行う）
  try {
    await ctx.run("docker", ["compose", "up", "-d", "--build"], { cwd: dir });
  } catch (e) {
    if (!(await passwordMismatch(ctx, dir))) throw e;
    // POSTGRES_PASSWORD は DB ボリュームの初期化時にしか反映されない。ボリュームを作った後に環境変数ファイルの
    // DATABASE_PASSWORD が変わると、migrate が "password authentication failed" で落ちる。データを消さずに、
    // DB のユーザーのパスワードを環境変数ファイルの値（= 作り直された postgres コンテナの POSTGRES_PASSWORD）にそろえる
    ctx.warn("DB のパスワードが環境変数ファイルと食い違っている（ボリュームの作成後に DATABASE_PASSWORD が変わった）。DB 側を環境変数ファイルの値にそろえて起動し直す");
    await syncDbPassword(ctx, dir);
    await ctx.run("docker", ["compose", "up", "-d", "--build"], { cwd: dir });
  }

  // 4. discovery と JWKS の確認
  if (!(await ctx.waitForHttp(DISCOVERY, { timeoutMs: 180_000 }))) {
    throw new Error(`admin-auth が ${DISCOVERY} に応答しない。cd ${DIR} && docker compose logs migrate admin-auth を見る`);
  }
  const doc = await ctx.http("admin-auth（discovery）", DISCOVERY);
  if (!doc?.issuer || !doc?.jwks_uri) throw new Error("admin-auth の discovery に issuer か jwks_uri が無い");
  const jwks = await ctx.http("admin-auth（JWKS）", `${BASE}/api/auth/jwks`);
  if (!jwks?.keys?.length) throw new Error("admin-auth の JWKS に鍵が無い");
  ctx.log(`discovery と JWKS を確認した（issuer ${doc.issuer}。署名鍵 ${jwks.keys.length} 本）`);

  // 5. Google ログイン。無くても discovery と JWKS は返るので、止めずに案内だけ出す（ログインを試すときに要る）
  const env = ctx.readEnvFile(envPath);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    ctx.warn("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が空。ログインを試すときだけ要る（discovery と JWKS には不要）。用意する手順:");
    ctx.warn("  1. Google Cloud Console → API とサービス → 認証情報 → OAuth クライアント ID（ウェブアプリケーション）を作る。同意画面のユーザータイプは「内部」");
    ctx.warn(`  2. 承認済みのリダイレクト URI に ${env.BETTER_AUTH_URL || "http://localhost:3103"}/api/auth/callback/google を入れる`);
    ctx.warn("  3. ~/.config/comegin/setup/dev.conf に GOOGLE_CLIENT_ID=… と GOOGLE_CLIENT_SECRET=… を書き、再実行する");
  }
}
