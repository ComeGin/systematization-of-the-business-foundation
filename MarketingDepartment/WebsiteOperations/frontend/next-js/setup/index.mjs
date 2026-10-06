// 監視アプリ（next-js + control-plane）の設定。環境変数ファイル → pnpm install → Google ログインの設定の確認。
// 出典: frontend/next-js/README.md（起動・環境変数）、dev/init-env.sh（BETTER_AUTH_SECRET の生成。冪等）、
//       frontend/next-js/lib/auth.ts（Google だけ。hd・email_verified・許可リスト CONTROL_ADMIN_EMAILS の 3 段。ADR-23）、
//       node_modules/better-auth の dist/api/routes/sign-in.mjs（POST /api/auth/sign-in/social が Google の認可 URL を返す）・
//       dist/api/middlewares/origin-check.mjs（Origin は BETTER_AUTH_URL と同じオリジンでないと 403）。
// 監視アプリの起動（127.0.0.1:3200）は常駐なので、ここでは行わない。ログインは人がブラウザで Google を通して行う（ユーザーはそのとき作られる）。
// 要求は常に手元（127.0.0.1:3200）へ送り、Origin だけを BETTER_AUTH_URL（開発では ngrok の URL のこともある）のオリジンにする。
import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

export const meta = { id: "next-js", title: "監視アプリ（環境変数・導入・Google ログイン）", targets: ["dev"], after: ["control-plane", "chatwoot-mcp", "mautic-mcp"] };

const LOCAL_URL = "http://127.0.0.1:3200";
const DEFAULT_HOSTED_DOMAIN = "comegin.com";
const REGISTRY = "MarketingDepartment/WebsiteOperations/ops/mcp-registry.yaml";

// 設定（~/.config/comegin/setup/dev.conf）にあれば環境変数ファイルに書く任意の値。
// CONTROL_SCHEDULER_ENABLED は開発で誤って定期実行しないよう、触らない（dev/init-env.sh が false にする）
const OPTIONAL_KEYS = [
  "ANTHROPIC_API_KEY", "SITE_URL", "CONTROL_DATA_DIR", "CONTROL_AGENT_HOME",
  "GITHUB_TOKEN", "GITHUB_REPOSITORY", "GITHUB_BASE_BRANCH", "I13_ISSUE_NUMBER", "I13_REVIEWER",
  "AWS_REGION", "AWS_PROFILE", "RUNLOG_BUCKET", "HEARTBEAT_NAMESPACE",
  "MISWRITE_CHATWOOT_BASE_URL", "MISWRITE_CHATWOOT_ACCOUNT_ID", "MISWRITE_CHATWOOT_API_TOKEN", "MISWRITE_AGENT_USER_ID",
  "GOOGLE_HOSTED_DOMAIN",
];
// 「1 つでも設定したら全部必須」のグループ（backend/control-plane の .env.example）
const GROUPS = {
  "I-13 の起票": ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "I13_ISSUE_NUMBER", "I13_REVIEWER"],
  "S3 への写し": ["AWS_REGION", "RUNLOG_BUCKET"],
  "誤った書き込みの突き合わせ": ["MISWRITE_CHATWOOT_BASE_URL", "MISWRITE_CHATWOOT_ACCOUNT_ID", "MISWRITE_CHATWOOT_API_TOKEN", "MISWRITE_AGENT_USER_ID"],
};

const dirOf = (ctx) => join(ctx.W, "frontend/next-js");
const planeDirOf = (ctx) => join(ctx.W, "backend/control-plane");
const envPathOf = (ctx) => join(dirOf(ctx), ".env");

/** ブラウザで開く URL（= BETTER_AUTH_URL）。末尾の / は落とす。以前の既定（localhost:3000。以前は Umami と衝突していた）は 3200 とみなす */
function publicUrlOf(env) {
  const raw = (env.BETTER_AUTH_URL || LOCAL_URL).replace(/\/+$/, "");
  return raw === "http://localhost:3000" ? LOCAL_URL : raw;
}

/** Google の資格情報。監視アプリ専用（CONTROL_GOOGLE_*）を優先し、無ければ admin-auth と共用の GOOGLE_* を使う */
function googleFromConf(ctx) {
  const id = ctx.conf.CONTROL_GOOGLE_CLIENT_ID || ctx.conf.GOOGLE_CLIENT_ID;
  const secret = ctx.conf.CONTROL_GOOGLE_CLIENT_SECRET || ctx.conf.GOOGLE_CLIENT_SECRET;
  return id && secret ? { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret } : null;
}

async function ensureTooling(ctx) {
  let v;
  try {
    v = (await ctx.run("pnpm", ["--version"])).trim();
  } catch {
    throw new Error("pnpm が使えない。pnpm 11 以上を入れる（corepack enable && corepack prepare pnpm@latest --activate など）");
  }
  // pnpm-workspace.yaml の minimumReleaseAge などは pnpm 11 未満では効かない（黙って無効になる）
  if (Number(v.split(".")[0]) < 11) throw new Error(`pnpm ${v} は古い。pnpm 11 以上が要る（供給網対策の設定が pnpm 11 未満では効かない）`);
}

/** 手元の監視アプリが動いているか（/login が 200）。down = 起動していない */
async function probe(ctx) {
  let res;
  try {
    // 開発サーバーは初回の要求でコンパイルするため、待ちを長めにする
    res = await ctx.http("監視アプリ", `${LOCAL_URL}/login`, { raw: true, timeoutMs: 90_000, headers: { Accept: "text/html" } });
  } catch (e) {
    if (e.status === 0) return "down";
    throw e;
  }
  await res.body?.cancel();
  if (res.status === 200 || (res.status >= 300 && res.status < 400)) return "up";
  throw new Error(`監視アプリの /login が HTTP ${res.status} を返した。dev サーバーのログを見る（control-plane の設定不正は画面に出るが、ログイン用 DB を開けないと 500 になる）`);
}

/**
 * 起動中の監視アプリが Google ログインを始められるか。POST /api/auth/sign-in/social が返す Google の認可 URL を読み、
 * hd（Workspace のドメイン）とリダイレクト URI（<BETTER_AUTH_URL>/api/auth/callback/google）を確かめる。ログインそのものはしない
 */
async function verifyGoogle(ctx, publicUrl, domain) {
  let body;
  try {
    body = await ctx.http("監視アプリの Google ログインの確認", `${LOCAL_URL}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { Origin: new URL(publicUrl).origin },
      json: { provider: "google", callbackURL: "/", disableRedirect: true },
    });
  } catch (e) {
    if (e.status === 403) throw new Error(`監視アプリが ${new URL(publicUrl).origin} を信頼していない。起動中の dev サーバーが古い BETTER_AUTH_URL を持っている可能性がある（dev サーバーを起動し直す）`);
    if (e.status === 404 || e.status === 400) return { ok: false, reason: "起動中の dev サーバーが Google の資格情報を読み込んでいない（環境変数を書いた後に dev サーバーを起動し直していない）" };
    throw e;
  }
  if (typeof body?.url !== "string") return { ok: false, reason: "応答に Google の認可 URL が無い" };
  const url = new URL(body.url);
  const redirect = url.searchParams.get("redirect_uri");
  const expected = `${publicUrl}/api/auth/callback/google`;
  if (url.hostname !== "accounts.google.com") return { ok: false, reason: `認可 URL が Google ではない（${url.hostname}）` };
  if (url.searchParams.get("hd") !== domain) return { ok: false, reason: `認可 URL の hd が ${domain} ではない` };
  if (redirect !== expected) return { ok: false, reason: `リダイレクト URI が ${redirect}（期待: ${expected}。BETTER_AUTH_URL とブラウザで開く URL をそろえ、dev サーバーを起動し直す）` };
  return { ok: true, redirect };
}

function validateGroups(values) {
  for (const [label, keys] of Object.entries(GROUPS)) {
    const set = keys.filter((k) => values[k]);
    if (set.length > 0 && set.length < keys.length) {
      throw new Error(`${label} の設定が中途半端。1 つでも設定したら全部要る（足りないキー: ${keys.filter((k) => !values[k]).join("・")}）。設定ファイルに足すか、全部消す`);
    }
  }
}

function googleClientSteps(publicUrl) {
  return [
    "Google Cloud Console（comegin.com の Workspace の管理者）で、Google Auth Platform → Branding が未設定なら Get started（Audience は Internal）",
    "Google Auth Platform → Clients → Create Client。Application type は Web application、Name は comegin-control-dev",
    `Authorized redirect URIs → Add URI に ${publicUrl}/api/auth/callback/google を入れて Create`,
    "表示されたクライアント ID とシークレットを ~/.config/comegin/setup/dev.conf に CONTROL_GOOGLE_CLIENT_ID=… と CONTROL_GOOGLE_CLIENT_SECRET=… として書く（chmod 600）。admin-auth と同じクライアントを使うなら、そのクライアントにこのリダイレクト URI を足し、GOOGLE_CLIENT_ID・GOOGLE_CLIENT_SECRET に書いてもよい",
    "同じコマンドを実行し直す（手順は setup/manual-steps.md の 7.2 にもある）",
  ];
}

export async function check(ctx) {
  const dir = dirOf(ctx);
  const notes = [];
  let ok = true;
  const mark = (cond, good, bad) => {
    notes.push(cond ? good : bad);
    if (!cond) ok = false;
  };
  mark(existsSync(join(planeDirOf(ctx), "dist/index.js")), "control-plane のビルド済み（dist/）", "control-plane が未ビルド（control-plane モジュール）");
  mark(existsSync(join(dir, "node_modules")), "依存は導入済み", "依存が未導入（pnpm install）");

  const envPath = envPathOf(ctx);
  if (!existsSync(envPath)) {
    notes.push("環境変数ファイル（.env）がまだ無い");
    return { ok: false, notes };
  }
  mark((statSync(envPath).mode & 0o077) === 0, "環境変数ファイルの権限は 600 系", "環境変数ファイルがほかのユーザーにも読める（chmod 600）");
  const env = ctx.readEnvFile(envPath); // 表示するのはキー名と URL だけ。秘密値は出さない
  const need = ["BETTER_AUTH_SECRET", "CONTROL_MAIN_CHECKOUT", "CONTROL_WORKTREE", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "CONTROL_ADMIN_EMAILS"];
  const missing = need.filter((k) => !env[k]);
  mark(missing.length === 0, `環境変数ファイルに ${need.join("・")} がある`, `環境変数ファイルに無いキー: ${missing.join("・")}`);
  if (!env.ANTHROPIC_API_KEY) notes.push("ANTHROPIC_API_KEY が空（エージェントの起動は skipped になる。画面からの手動の指示も動かない）");
  try {
    validateGroups(env);
  } catch (e) {
    mark(false, "", e.message);
  }

  const publicUrl = publicUrlOf(env);
  notes.push(`ブラウザで開く URL（BETTER_AUTH_URL）: ${publicUrl}`);
  const state = await probe(ctx).catch((e) => {
    mark(false, "", e.message);
    return null;
  });
  if (state === "down") mark(false, "", `監視アプリが起動していない（${LOCAL_URL}）。cd ${dir} && pnpm dev`);
  else if (state === "up") notes.push(`監視アプリは起動している（${LOCAL_URL}）`);
  if (state === "up" && env.GOOGLE_CLIENT_ID) {
    const r = await verifyGoogle(ctx, publicUrl, env.GOOGLE_HOSTED_DOMAIN || DEFAULT_HOSTED_DOMAIN).catch((e) => ({ ok: false, reason: e.message }));
    mark(r.ok, `Google ログインを始められる（リダイレクト URI ${r.redirect}）`, `Google ログインの確認: ${r.reason}`);
  }
  return { ok, notes };
}

export async function apply(ctx) {
  const dir = dirOf(ctx);
  const envPath = envPathOf(ctx);

  if (!existsSync(join(planeDirOf(ctx), "dist/index.js"))) {
    throw new Error("control-plane が未ビルド（dist/ が無い）。先に control-plane モジュールを実行する: node setup/setup.mjs --target dev --only control-plane");
  }
  await ensureTooling(ctx);

  // 1. 環境変数ファイル。BETTER_AUTH_SECRET の生成と既定値は既存の dev/init-env.sh に任せる（冪等。値は表示しない）
  await ctx.run("bash", ["dev/init-env.sh"], { cwd: dir });
  const env = ctx.readEnvFile(envPath);

  const main = env.CONTROL_MAIN_CHECKOUT || ctx.value("CONTROL_MAIN_CHECKOUT");
  if (!main) {
    throw new Error(
      "CONTROL_MAIN_CHECKOUT が無い。承認済み main の別チェックアウト（絶対パス）が要る。エージェント定義と ops/ はここから読む（ADR-18）。" +
        "例: git fetch origin && git worktree add --detach ~/ComeGin/main-checkout origin/main（origin/main に ops/mcp-registry.yaml がまだ無いときは、origin/main の代わりにそれを含むブランチ）を人が実行し、~/.config/comegin/setup/dev.conf に CONTROL_MAIN_CHECKOUT=<そのパス> と書いて再実行する（setup/manual-steps.md の 6 節）",
    );
  }
  if (!main.startsWith("/")) throw new Error("CONTROL_MAIN_CHECKOUT は絶対パスにする");
  if (!existsSync(join(main, REGISTRY))) throw new Error(`CONTROL_MAIN_CHECKOUT（${main}）に ${REGISTRY} が無い。main のチェックアウトか確かめる`);
  const worktree = env.CONTROL_WORKTREE || ctx.value("CONTROL_WORKTREE") || ctx.REPO;
  if (realpathSync(main) === realpathSync(worktree)) {
    ctx.warn("CONTROL_MAIN_CHECKOUT と CONTROL_WORKTREE が同じ場所。作業ツリーで書き換えた定義が次の実行に効いてしまう（ADR-18 の分離が働かない）。別のチェックアウトにする");
  }

  const values = { CONTROL_MAIN_CHECKOUT: main, CONTROL_WORKTREE: worktree };
  for (const k of OPTIONAL_KEYS) if (ctx.conf[k]) values[k] = ctx.conf[k];
  // 誤った書き込みの突き合わせ: 設定に無ければ、chatwoot モジュールの状態（エージェント専用ユーザー）から全部そろうときだけ埋める
  const miswrite = {
    MISWRITE_CHATWOOT_BASE_URL: ctx.conf.CHATWOOT_BASE_URL || "http://127.0.0.1:3100",
    MISWRITE_CHATWOOT_ACCOUNT_ID: ctx.state.get("CHATWOOT_ACCOUNT_ID"),
    MISWRITE_CHATWOOT_API_TOKEN: ctx.state.get("CHATWOOT_AGENT_TOKEN"),
    MISWRITE_AGENT_USER_ID: ctx.state.get("CHATWOOT_AGENT_USER_ID"),
  };
  if (Object.values(miswrite).every(Boolean)) {
    for (const [k, v] of Object.entries(miswrite)) values[k] ??= String(v);
  }
  // ログインを許すメール。環境変数ファイルで空なら管理者のメールアドレス（設定で明示したときは下の override で書き換える）
  values.CONTROL_ADMIN_EMAILS = ctx.require("ADMIN_EMAIL", "~/.config/comegin/setup/dev.conf に ADMIN_EMAIL=<管理者のメールアドレス> を書く");
  validateGroups({ ...env, ...values });

  const changed = ctx.writeEnvFile(envPath, values, { template: join(dir, ".env.example") });
  // 設定で明示した値は、既にある値より優先して書き換える（ブラウザで開く URL・Google の資格情報・許可リスト）
  const override = { ...(googleFromConf(ctx) ?? {}) };
  if (ctx.conf.CONTROL_ADMIN_EMAILS) override.CONTROL_ADMIN_EMAILS = ctx.conf.CONTROL_ADMIN_EMAILS;
  if (ctx.conf.CONTROL_PUBLIC_URL) override.BETTER_AUTH_URL = ctx.conf.CONTROL_PUBLIC_URL.replace(/\/+$/, "");
  changed.push(...ctx.writeEnvFile(envPath, override, { onlyIfEmpty: false }));
  ctx.log(`${envPath} を用意した（600。今回書いたキー: ${changed.join("・") || "なし"}）`);

  const written = ctx.readEnvFile(envPath);
  const publicUrl = publicUrlOf(written);
  const domain = written.GOOGLE_HOSTED_DOMAIN || DEFAULT_HOSTED_DOMAIN;
  if (!written.ANTHROPIC_API_KEY) ctx.warn("ANTHROPIC_API_KEY が空。エージェントの起動は skipped になる。使うなら設定ファイルに ANTHROPIC_API_KEY を書いて再実行する");
  const outside = written.CONTROL_ADMIN_EMAILS.split(",").map((s) => s.trim()).filter((s) => s && !s.toLowerCase().endsWith(`@${domain}`));
  if (outside.length) ctx.warn(`許可リストに ${domain} 以外のメールがある（${outside.length} 件）。Google の hd の検査で通らない`);

  // 2. 依存の導入（control-plane は link: で dist/ を読む）
  ctx.log("pnpm install（lockfile 固定）");
  await ctx.run("pnpm", ["install", "--frozen-lockfile"], { cwd: dir });

  // 3. Google ログイン。資格情報（OAuth クライアント）は人が Google Cloud Console で作る
  if (!written.GOOGLE_CLIENT_ID || !written.GOOGLE_CLIENT_SECRET) {
    ctx.manual("google-client", "監視アプリの Google ログイン用の OAuth クライアントを作る", googleClientSteps(publicUrl));
  }

  const startSteps = (why) => [
    `${why}: 別のターミナルで cd ${dir} && pnpm dev（127.0.0.1:3200 にだけ開く。常駐させるのでこのスクリプトは起動しない。動いていれば Ctrl+C で止めてから起動し直す）`,
    "初回は画面のコンパイルに時間がかかる。Ready と出たら次へ",
    "同じコマンドを実行し直す（環境変数や依存は済んでいるので飛ばされる）",
  ];
  if ((await probe(ctx)) === "down") ctx.manual("start-app", `監視アプリを起動する（${LOCAL_URL}）`, startSteps("起動する"));
  const google = await verifyGoogle(ctx, publicUrl, domain);
  if (!google.ok) {
    if (changed.length > 0) ctx.manual("restart-app", "監視アプリを起動し直す（環境変数を書き換えたため）", startSteps(`起動し直す（${google.reason}）`));
    throw new Error(`監視アプリの Google ログインを始められない: ${google.reason}`);
  }
  ctx.log(`Google ログインを始められることを確かめた（hd ${domain}、リダイレクト URI ${google.redirect}）`);
  if (changed.length > 0) ctx.warn("環境変数を書き換えた。起動中の dev サーバーが古い値で動いていないか、ログインで確かめる（おかしければ起動し直す）");
  ctx.log(`ログイン: ${publicUrl}/login を開き「Google でログイン」。通るのは ${domain} のアカウントで、CONTROL_ADMIN_EMAILS にあるメールだけ（ユーザーは初回のログインで作られる）`);
  ctx.log("定期実行は CONTROL_SCHEDULER_ENABLED=false のまま（手動の起動・ハートビート・写しの再送は動く）");
}
