// OpenSEO（開発環境）の設定。環境変数ファイルの作成 → 起動 → /api/health の確認 → Google Search Console の接続（画面）。
//
// 方針（setup/lib/core.mjs の契約）:
//   - open-seo-main は上流の取り込み。独自の追加は dev/setup/ の中だけ。上流の compose.yaml は変えずに、そのまま docker compose up -d する
//   - compose.yaml は env_file で同じディレクトリの環境変数ファイルを丸ごと渡す。ひな形は上流の環境変数のテンプレート（.env.example。全部コメントアウト）。
//     既に値があるキーは変えない（BETTER_AUTH_SECRET は保存済みの Google の OAuth トークンの暗号鍵なので、変えると接続が切れる）。
//     設定（dev.conf）の値は、変わったら環境変数ファイルにも反映する（上流の環境変数ファイルにだけ値がある場合は、それを使う）
//   - 認証は AUTH_MODE=local_noauth（Docker の自前運用の上流の既定。127.0.0.1 だけにバインドされ、画面にも MCP にも認証が無い）。トンネルを張らない
//   - OpenSEO の費用が出るツール（DataForSEO を呼ぶもの）はここでは呼ばない。確かめるのは /api/health だけ（無認証・無料・値を返さない）
//   - Google Search Console の接続は、Google の同意画面を通るので画面の操作（ctx.manual）。接続の有無はアプリの DB の中にあり、
//     /api/health には出ない（health の gsc は「環境変数が揃っているか」だけ）。済んだことは設定の OPENSEO_GSC_CONNECTED=yes で知らせる
//
// 設定のキー（~/.config/comegin/setup/dev.conf。雛形は setup/setup.conf.example）:
//   DATAFORSEO_API_KEY            DataForSEO の login:password を base64 にした値（ダッシュボードの API キーそのものではない）
//   OPENSEO_GOOGLE_CLIENT_ID / OPENSEO_GOOGLE_CLIENT_SECRET   Search Console 用の OAuth クライアント。無ければ GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET（admin-auth と共用）
//   OPENROUTER_API_KEY            任意。アプリ内の AI エージェント（SAM）を使うときだけ
//   OPENSEO_GSC_CONNECTED=yes     画面で Google の接続を済ませたら書く
//   OPENSEO_SKIP_GSC=yes          Search Console を使わないと決めたら書く（接続の案内をしない）
//   OPEN_SEO_IMAGE                任意。イメージの上書き（既定は下の PINNED_IMAGE。版を上げるときは定数を変えるのが正）
//
// 確かめた出典（middleware/open-seo-main のソース。動いているコンテナは health の version が 0.1.8）:
//   compose.yaml（env_file: .env。ポートは 127.0.0.1:${PORT:-3001}、AUTH_MODE は local_noauth 固定。BETTER_AUTH_SECRET・GOOGLE_CLIENT_ID・GOOGLE_CLIENT_SECRET・DATAFORSEO_API_KEY・OPENROUTER_API_KEY を渡す）
//   .env.example（環境変数のテンプレート。全部コメントアウト）、docs/SELF_HOSTING_DOCKER.md（`.env` を変えたら --force-recreate。初回起動はコンテナ内のビルドで 1〜2 分）
//   src/routes/api/health.ts・src/server/lib/setup-status.ts・src/lib/selfhost-preflight.ts
//     （GET /api/health は無認証。{ status: "ok"|"issues", version, authMode, checks: { auth, dataforseo, gsc, ai, database } }。各 check は { status: "ok"|"warn"|"error", detail? }。
//       dataforseo は未設定・不正なら warn、gsc は環境変数が揃うと detail が "Configured"、無ければ "Not configured (optional)..."（どちらも status は ok）、database は DB に問い合わせて失敗なら error）
//   docs/SELF_HOSTING_GOOGLE_SEARCH_CONSOLE.md（GOOGLE_CLIENT_ID・GOOGLE_CLIENT_SECRET・BETTER_AUTH_SECRET〈32 文字以上〉の 3 つが要る。
//     リダイレクト URI は http://localhost:3001/api/gsc/oauth/callback。接続は画面の Integrations の Connect with Google）
//   docs/DATAFORSEO_API_KEY.md（DATAFORSEO_API_KEY は base64 の login:password）
import { join } from "node:path";

export const meta = { id: "openseo", title: "OpenSEO（SEO のデータ・Search Console。開発環境）", targets: ["dev"], after: [] };

const DIR = "middleware/open-seo-main";
const BASE_URL = "http://127.0.0.1:3001";
const REDIRECT_URI = "http://localhost:3001/api/gsc/oauth/callback";
// イメージは版とダイジェストで固定する（上流の compose の既定は :latest。compose.yaml の image は ${OPEN_SEO_IMAGE:-...} なので、環境変数ファイルで差し替える）。
// 出典: docker buildx imagetools inspect ghcr.io/every-app/open-seo:0.1.8（:v0.1.8・2026-10-06 時点の :latest と同じダイジェスト）
const PINNED_IMAGE = "ghcr.io/every-app/open-seo:0.1.8@sha256:79f19fb7100e71133effa43898a2ba1ad4702075f3127e6ca91cd076e1101538";

const root = (ctx) => join(ctx.W, DIR);
const envPath = (ctx) => join(root(ctx), ".env");
const templatePath = (ctx) => join(root(ctx), ".env.example");
const yes = (v) => /^(yes|true|1)$/i.test(String(v ?? "").trim());

// ---------------------------------------------------------------------------
// 設定の値（設定ファイル → 環境変数ファイルの今の値の順）
// ---------------------------------------------------------------------------

function googleClient(ctx) {
  return {
    id: ctx.conf.OPENSEO_GOOGLE_CLIENT_ID || ctx.conf.GOOGLE_CLIENT_ID || undefined,
    secret: ctx.conf.OPENSEO_GOOGLE_CLIENT_SECRET || ctx.conf.GOOGLE_CLIENT_SECRET || undefined,
  };
}

/** 設定の値を環境変数ファイルに書く。値が変わったら上書きする（設定が正）。書いたキーの名前を返す */
function syncFromConf(ctx) {
  const google = googleClient(ctx);
  return ctx.writeEnvFile(
    envPath(ctx),
    {
      AUTH_MODE: "local_noauth",
      OPEN_SEO_IMAGE: ctx.conf.OPEN_SEO_IMAGE || PINNED_IMAGE,
      DATAFORSEO_API_KEY: ctx.conf.DATAFORSEO_API_KEY || undefined,
      GOOGLE_CLIENT_ID: google.id,
      GOOGLE_CLIENT_SECRET: google.secret,
      OPENROUTER_API_KEY: ctx.conf.OPENROUTER_API_KEY || undefined,
    },
    { template: templatePath(ctx), onlyIfEmpty: false },
  );
}

/** 生成する秘密値。既にあれば変えない（保存済みの OAuth トークンの暗号鍵。変えると Search Console の接続が切れる） */
function ensureGenerated(ctx) {
  return ctx.writeEnvFile(envPath(ctx), { BETTER_AUTH_SECRET: ctx.randomSecret(32) }, { template: templatePath(ctx), onlyIfEmpty: true });
}

// ---------------------------------------------------------------------------
// /api/health
// ---------------------------------------------------------------------------

/** health の本体。応答が無ければ null */
async function readHealth(ctx) {
  try {
    return await ctx.http("OpenSEO health", `${BASE_URL}/api/health`);
  } catch (e) {
    if (e.status === 0) return null;
    throw e;
  }
}

/** 各 check を 1 行にする */
function describeChecks(health) {
  return Object.entries(health.checks ?? {}).map(([name, c]) => `${name}: ${c.status}${c.detail ? `（${c.detail}）` : ""}`);
}

const gscConfigured = (health) => String(health.checks?.gsc?.detail ?? "").startsWith("Configured");

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

async function ensureStack(ctx, envChanged) {
  // .env を変えたときは、コンテナを作り直さないと反映されない（上流の docs/SELF_HOSTING_DOCKER.md）
  const args = envChanged ? ["compose", "up", "-d", "--force-recreate", "open-seo"] : ["compose", "up", "-d"];
  await ctx.run("docker", args, { cwd: root(ctx) });
  // 初回はコンテナの中でアプリをビルドしてから待ち受けるので長めに待つ
  if (!(await ctx.waitForHttp(`${BASE_URL}/api/health`, { timeoutMs: 300_000 }))) {
    throw new Error(`OpenSEO が ${BASE_URL} で応答しない。docker compose logs open-seo を見る（${DIR}。起動時の検査が [FAIL] で止めている場合がある）`);
  }
  ctx.log("起動している（127.0.0.1:3001。認証なし＝local_noauth なので、トンネルを張らない）");
}

// ---------------------------------------------------------------------------
// 画面の操作
// ---------------------------------------------------------------------------

function dataForSeoSteps() {
  return [
    "DataForSEO の API 認証情報を用意する（アカウントが無ければ作る。新規は 1 ドル分の無料クレジットがある。費用が出るのはこのキーで OpenSEO がデータを取るとき）",
    "https://app.dataforseo.com/api-access を開き、「Send by email」で認証情報を取り寄せ、「Base64」と書かれた長いほうの値を控える（login:password を base64 にした値。ダッシュボードの API キーではない）",
    "~/.config/comegin/setup/dev.conf に DATAFORSEO_API_KEY=<その値> を書く（chmod 600。エディタで書く）",
  ];
}

function googleClientSteps() {
  return [
    "Google Cloud Console（https://console.cloud.google.com/）でプロジェクトを選ぶか作り、「Google Search Console API」を有効にする",
    "「APIs & Services → OAuth consent screen」で、Workspace 内だけなら Internal、そうでなければ External を選ぶ。External のまま Testing なら、接続する Google アカウントを Test users に足す（足さないと access_denied）",
    `「Credentials → Create credentials → OAuth client ID」で、種類を Web application にし、Authorized redirect URI に ${REDIRECT_URI} を入れる（スキーム・ホスト・ポートが完全に一致していること。末尾にスラッシュを付けない）`,
    "表示された Client ID と Client secret を ~/.config/comegin/setup/dev.conf に書く（chmod 600。エディタで書く）。OpenSEO 専用にするなら OPENSEO_GOOGLE_CLIENT_ID= と OPENSEO_GOOGLE_CLIENT_SECRET=、admin-auth と同じクライアントを使うなら GOOGLE_CLIENT_ID= と GOOGLE_CLIENT_SECRET=（その場合はクライアントに上のリダイレクト URI も足す）",
    "Search Console を使わないと決めたなら、代わりに OPENSEO_SKIP_GSC=yes を書く",
  ];
}

function gscConnectSteps() {
  return [
    "ブラウザで http://localhost:3001 を開く（127.0.0.1 ではなく localhost。リダイレクト URI と合わせる）",
    "Integrations を開き、「Connect with Google」を押して、Search Console で認証済みのプロパティを持つ Google アカウントで同意する",
    "プロジェクトに紐付けるプロパティを選ぶ",
    "~/.config/comegin/setup/dev.conf に OPENSEO_GSC_CONNECTED=yes を書く（接続の有無は OpenSEO の DB の中にあり、このスクリプトからは確かめられない）",
  ];
}

// ---------------------------------------------------------------------------
// 契約
// ---------------------------------------------------------------------------

export async function check(ctx) {
  const health = await readHealth(ctx);
  if (!health) return { ok: false, notes: [`OpenSEO が ${BASE_URL} で応答しない`] };

  const notes = [`OpenSEO ${health.version ?? "?"}（status: ${health.status}、authMode: ${health.authMode}）`, ...describeChecks(health).map((l) => `  ${l}`)];
  let ok = health.status === "ok" && health.authMode === "local_noauth" && health.checks?.database?.status === "ok";
  if (health.authMode !== "local_noauth") notes.push("authMode が local_noauth ではない（トンネルを張らない前提が崩れる）");

  if (health.checks?.dataforseo?.status !== "ok") ok = false;

  if (yes(ctx.value("OPENSEO_SKIP_GSC"))) {
    notes.push("Search Console は使わない（OPENSEO_SKIP_GSC）");
  } else if (!gscConfigured(health)) {
    notes.push("Search Console の環境変数（Google の OAuth クライアントと BETTER_AUTH_SECRET）が揃っていない");
    ok = false;
  } else if (yes(ctx.value("OPENSEO_GSC_CONNECTED"))) {
    notes.push("Search Console の接続は済みと申告されている（OPENSEO_GSC_CONNECTED。アプリの DB の中なので、ここからは確かめられない）");
  } else {
    notes.push("Search Console の接続（画面の操作）が済んだと申告されていない（OPENSEO_GSC_CONNECTED=yes）");
    ok = false;
  }
  return { ok, notes };
}

export async function apply(ctx) {
  if (!(await ctx.commandExists("docker"))) throw new Error("docker が無い。Docker Engine（と Compose）を入れてから実行し直す");

  const changed = [...syncFromConf(ctx), ...ensureGenerated(ctx)];
  if (changed.length) ctx.log(`環境変数ファイルに書いた: ${changed.join(", ")}（${DIR}/.env。権限 600）`);

  await ensureStack(ctx, changed.length > 0);
  const health = await readHealth(ctx);
  ctx.log(`health: ${describeChecks(health).join(" / ")}`);

  if (health.checks?.database?.status !== "ok") throw new Error("OpenSEO のデータベースが使えない（health の database が ok ではない）。docker compose logs open-seo を見る");
  if (health.authMode !== "local_noauth") throw new Error(`OpenSEO の authMode が local_noauth ではない（${health.authMode}）。環境変数ファイルの AUTH_MODE を確かめる`);

  if (health.checks?.dataforseo?.status !== "ok") ctx.manual("dataforseo-key", "DataForSEO の API キーを設定に書く", dataForSeoSteps());

  if (yes(ctx.value("OPENSEO_SKIP_GSC"))) {
    ctx.log("Search Console は使わない設定（OPENSEO_SKIP_GSC）。接続は案内しない");
    return;
  }
  if (!gscConfigured(health)) ctx.manual("google-oauth-client", "Search Console 用の Google の OAuth クライアントを作って設定に書く", googleClientSteps());
  if (!yes(ctx.value("OPENSEO_GSC_CONNECTED"))) ctx.manual("gsc-connect", "OpenSEO の画面で Google Search Console に接続する", gscConnectSteps());

  ctx.log("Search Console は接続済みと申告されている（OPENSEO_GSC_CONNECTED）");
  ctx.log(`終わった。画面: ${BASE_URL}（認証なし。ループバックだけ）`);
}
