// 監視アプリ（next-js + control-plane）の設定。環境変数ファイル → pnpm install → 最初の管理者の作成。
// 出典: frontend/next-js/README.md（起動・環境変数・/setup）、dev/init-env.sh（BETTER_AUTH_SECRET の生成。冪等）、
//       frontend/next-js/lib/auth.ts（メールとパスワード・最小 12 文字・ユーザーが 1 人でもいれば新規登録は拒否）、
//       app/setup/page.tsx（ユーザー 0 人のときだけ 200、それ以外は /login へ 307）、components/AuthForm.tsx（signUp.email）、
//       node_modules/better-auth の dist/api/routes/sign-up.mjs・origin-check.mjs（POST /api/auth/sign-up/email と Origin の検査）。
// 監視アプリの起動（127.0.0.1:3200）は常駐なので、ここでは行わない。管理者の作成だけは起動中の監視アプリの HTTP API を使う。
import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

export const meta = { id: "next-js", title: "監視アプリ（環境変数・導入・最初の管理者）", targets: ["dev"], after: ["control-plane", "chatwoot-mcp", "mautic-mcp"] };

const MIN_PASSWORD_LENGTH = 12;
const DEFAULT_URL = "http://127.0.0.1:3200";
const REGISTRY = "MarketingDepartment/WebsiteOperations/ops/mcp-registry.yaml";

// 設定（~/.config/comegin/setup/dev.conf）にあれば環境変数ファイルに書く任意の値。
// CONTROL_SCHEDULER_ENABLED は開発で誤って定期実行しないよう、触らない（dev/init-env.sh が false にする）
const OPTIONAL_KEYS = [
  "ANTHROPIC_API_KEY", "SITE_URL", "CONTROL_DATA_DIR", "CONTROL_AGENT_HOME",
  "GITHUB_TOKEN", "GITHUB_REPOSITORY", "GITHUB_BASE_BRANCH", "I13_ISSUE_NUMBER", "I13_REVIEWER",
  "AWS_REGION", "AWS_PROFILE", "RUNLOG_BUCKET", "HEARTBEAT_NAMESPACE",
  "MISWRITE_CHATWOOT_BASE_URL", "MISWRITE_CHATWOOT_ACCOUNT_ID", "MISWRITE_CHATWOOT_API_TOKEN", "MISWRITE_AGENT_USER_ID",
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

/** /setup の応答から、監視アプリの状態を読む。open = 管理者がまだいない、closed = 作成済み、down = 起動していない */
async function probe(ctx, baseUrl) {
  let res;
  try {
    // 開発サーバーは初回の要求でコンパイルするため、待ちを長めにする
    res = await ctx.http("監視アプリ", `${baseUrl}/setup`, { raw: true, timeoutMs: 90_000, headers: { Accept: "text/html" } });
  } catch (e) {
    if (e.status === 0) return "down";
    throw e;
  }
  await res.body?.cancel();
  if (res.status === 200) return "open";
  if (res.status >= 300 && res.status < 400) return "closed";
  throw new Error(`監視アプリの /setup が HTTP ${res.status} を返した。別のサービスが ${baseUrl} に応答している可能性がある（3000 は Umami）。監視アプリなら dev サーバーのログを見る（control-plane の設定不正は画面に出るが、ログイン用 DB を開けないと 500 になる）`);
}

async function signIn(ctx, baseUrl, email, password) {
  // Origin は trustedOrigins（BETTER_AUTH_URL）と同じにする。Better Auth の検査は Origin が違うと 403
  await ctx.http("監視アプリのログイン確認", `${baseUrl}/api/auth/sign-in/email`, { method: "POST", headers: { Origin: baseUrl }, json: { email, password } });
}

function validateGroups(values) {
  for (const [label, keys] of Object.entries(GROUPS)) {
    const set = keys.filter((k) => values[k]);
    if (set.length > 0 && set.length < keys.length) {
      throw new Error(`${label} の設定が中途半端。1 つでも設定したら全部要る（足りないキー: ${keys.filter((k) => !values[k]).join("・")}）。設定ファイルに足すか、全部消す`);
    }
  }
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
  const env = ctx.readEnvFile(envPath); // 表示するのはキー名だけ。値は出さない
  const need = ["BETTER_AUTH_SECRET", "CONTROL_MAIN_CHECKOUT", "CONTROL_WORKTREE"];
  const missing = need.filter((k) => !env[k]);
  mark(missing.length === 0, `環境変数ファイルに ${need.join("・")} がある`, `環境変数ファイルに無いキー: ${missing.join("・")}`);
  if (!env.ANTHROPIC_API_KEY) notes.push("ANTHROPIC_API_KEY が空（エージェントの起動は skipped になる。画面からの手動の指示も動かない）");
  try {
    validateGroups(env);
  } catch (e) {
    mark(false, "", e.message);
  }

  // 以前の既定（http://localhost:3000）のままだと Umami（3000）に当たる。apply の dev/init-env.sh が 3200 に直す
  const urlOk = !env.BETTER_AUTH_URL || env.BETTER_AUTH_URL === DEFAULT_URL;
  mark(urlOk, "BETTER_AUTH_URL は 3200", "BETTER_AUTH_URL が http://127.0.0.1:3200 でない（apply の dev/init-env.sh が、以前の既定のときだけ直す）");
  const stale = env.BETTER_AUTH_URL === "http://localhost:3000";
  const baseUrl = urlOk || stale ? DEFAULT_URL : env.BETTER_AUTH_URL.replace(/\/+$/, "");
  const state = await probe(ctx, baseUrl).catch((e) => {
    mark(false, "", e.message);
    return null;
  });
  if (state === "down") mark(false, "", `監視アプリが起動していない（${baseUrl}）。管理者の有無は未確認（cd ${dir} && pnpm dev）`);
  else if (state === "open") mark(false, "", "最初の管理者がまだいない");
  else if (state === "closed") {
    notes.push("最初の管理者は作成済み（新規登録は閉じている）");
    if (!ctx.state.has("NEXT_ADMIN_PASSWORD")) notes.push("NEXT_ADMIN_PASSWORD が状態に無い（手で作った管理者なら正常）");
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
        "例: git worktree add ~/ComeGin/main-checkout main を人が実行し、~/.config/comegin/setup/dev.conf に CONTROL_MAIN_CHECKOUT=<そのパス> と書いて再実行する",
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
  validateGroups({ ...env, ...values });

  const changed = ctx.writeEnvFile(envPath, values, { template: join(dir, ".env.example") });
  ctx.log(`${envPath} を用意した（600。今回書いたキー: ${changed.join("・") || "なし"}）`);
  if (!ctx.readEnvFile(envPath).ANTHROPIC_API_KEY) ctx.warn("ANTHROPIC_API_KEY が空。エージェントの起動は skipped になる。使うなら設定ファイルに ANTHROPIC_API_KEY を書いて再実行する");

  // 2. 依存の導入（control-plane は link: で dist/ を読む）
  ctx.log("pnpm install（lockfile 固定）");
  await ctx.run("pnpm", ["install", "--frozen-lockfile"], { cwd: dir });

  // 3. 最初の管理者。起動中の監視アプリの /api/auth/sign-up/email を呼ぶ（DB を直接書かない）
  const baseUrl = (ctx.readEnvFile(envPath).BETTER_AUTH_URL || DEFAULT_URL).replace(/\/+$/, "");
  const email = ctx.require("ADMIN_EMAIL", "~/.config/comegin/setup/dev.conf に ADMIN_EMAIL=<管理者のメールアドレス> を書く");
  const state = await probe(ctx, baseUrl);

  if (state === "down") {
    ctx.manual("start-app", `監視アプリを起動する（${baseUrl}）`, [
      `別のターミナルで起動する: cd ${dir} && pnpm dev（127.0.0.1:3200 にだけ開く。常駐させるのでこのスクリプトは起動しない）`,
      "初回は画面のコンパイルに時間がかかる。Ready と出たら次へ",
      "control-plane の設定が不正でもサーバーは起動し、画面に原因（変数名と理由だけ）を出す",
      "同じコマンドを実行し直す（最初の管理者を作る。環境変数や依存は済んでいるので飛ばされる）",
    ]);
  }

  if (state === "open") {
    const password = ctx.value("NEXT_ADMIN_PASSWORD") || ctx.randomSecret(24);
    if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`NEXT_ADMIN_PASSWORD は ${MIN_PASSWORD_LENGTH} 文字以上にする（監視アプリの minPasswordLength）`);
    // 作る前に状態へ置く。途中で止まっても、作られたパスワードを失わない
    ctx.state.set("NEXT_ADMIN_PASSWORD", password, { secret: true });
    await ctx.http("監視アプリの最初の管理者の作成", `${baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { Origin: baseUrl },
      json: { name: ctx.conf.NEXT_ADMIN_NAME || "管理者", email, password },
    });
    await signIn(ctx, baseUrl, email, password);
    ctx.log(`最初の管理者（${email}）を作り、ログインできることを確かめた。以後は新規登録が閉じる`);
    ctx.log("パスワードは状態に置いた。見るとき: node setup/setup.mjs --target dev --show NEXT_ADMIN_PASSWORD");
  } else if (ctx.state.has("NEXT_ADMIN_PASSWORD")) {
    try {
      await signIn(ctx, baseUrl, email, ctx.state.get("NEXT_ADMIN_PASSWORD"));
      ctx.log("最初の管理者は作成済みで、状態のパスワードでログインできる");
    } catch (e) {
      if (e.status === 401) throw new Error(`管理者は作成済みだが、状態の NEXT_ADMIN_PASSWORD と ADMIN_EMAIL（${email}）でログインできない。手でパスワードやメールを変えたなら、状態を合わせる（監視アプリには新規登録の口が無い）`);
      throw e;
    }
  } else {
    ctx.warn("最初の管理者は作成済みだが、このスクリプトが作ったものではない（NEXT_ADMIN_PASSWORD が状態に無い）。ログインは手で作ったパスワードで行う");
  }

  if (changed.length > 0) ctx.warn("環境変数を書き換えた。起動中の dev サーバーは再起動しないと反映されない");
  ctx.log(`ログイン: ${baseUrl}/login（127.0.0.1 だけ）。起動: cd ${dir} && pnpm dev。定期実行は CONTROL_SCHEDULER_ENABLED=false のまま（手動の起動・ハートビート・写しの再送は動く）`);
}
