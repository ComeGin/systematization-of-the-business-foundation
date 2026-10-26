// 監視アプリの E2E（pnpm e2e）のサンドボックス。開発で動いている監視アプリ（127.0.0.1:3200）と、その置き場
// （~/.local/share/comegin-control）・Google の資格情報・ANTHROPIC_API_KEY には触れない。
//
// E2E 専用のインスタンスを 3201 で起動し（Next の distDir は .next/e2e。3200 の .next/dev のロックと分ける）、
// control-plane の置き場（E-15・ログイン用の SQLite）・承認済み main のチェックアウト・作業ツリーを一時ディレクトリに作る。
// 境界（2026-10-25 にユーザーが決めた）: オンプレの開発スタック（Chatwoot）は本物に繋ぎ、オンプレの外（Google・Anthropic・AWS・GitHub）は
// 設定を空にして繋がない。エージェントの起動は ANTHROPIC_API_KEY が無いので「設定が無いため見送った」になる（engine.ts）。
//
// node e2e/support/sandbox.mjs prepare … webServer のコマンドが Next の起動の前に呼ぶ（前回の残りを消して作り直す）
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 3200 は開発の監視アプリ。E2E は 3201（CLAUDE.md のポートの表）
export const PORT = 3201;
export const BASE_URL = `http://127.0.0.1:${PORT}`;

/** 実行のたびに作り直す置き場（決まった場所にして、設定ファイル・ワーカー・準備のスクリプトで同じ場所を指す） */
export const SANDBOX_DIR = join(tmpdir(), "comegin-next-js-e2e");
export const DATA_DIR = join(SANDBOX_DIR, "data");
export const MAIN_CHECKOUT = join(SANDBOX_DIR, "main");
export const WORKTREE = join(SANDBOX_DIR, "worktree");
export const AGENT_HOME = join(SANDBOX_DIR, "agent-home");

/** E2E だけで使う Better Auth の secret（サンドボックスの SQLite のセッションの署名にだけ使う。秘密値ではない） */
export const AUTH_SECRET = "e2e-only-better-auth-secret-not-for-real-use-0000";

/** 許可リストに入れるメール（Workspace のドメイン comegin.com）と、ドメインは同じでも許可リストに無いメール */
export const ADMIN_EMAIL = "e2e-admin@comegin.com";
export const OUTSIDER_EMAIL = "e2e-outsider@comegin.com";

/** Google の OAuth クライアントの形だけの値（Google には届かない。認可の画面へ向かう URL を E2E が捕まえて止める） */
export const GOOGLE_CLIENT_ID = "e2e-client-id.apps.googleusercontent.com";

/** サンドボックスの承認済み main に置く定義 */
export const AGENT = "e2e-probe";
export const JOBS = {
  /** builtin published-article-check。実行すると「未実装のため見送った」（skipped）で終わる */
  published: "e2e-published-check",
  /** builtin heartbeat。AWS の設定が無いので起動の前に見送る */
  heartbeat: "e2e-heartbeat",
  /** builtin miswrite-check。開発の Chatwoot（本物）を読み、成功で終わる */
  miswrite: "e2e-miswrite",
  /** エージェント e2e-probe。ANTHROPIC_API_KEY が無いので起動の前に見送る */
  agent: "e2e-agent-job",
};

const STATE_FILE = join(homedir(), ".config/comegin/setup/dev.state.json");

/** 設定スクリプトの状態ファイルの値（秘密値は返すだけ。例外の文にはキーの名前だけを出す） */
export function stateValue(key) {
  let values = {};
  try {
    values = JSON.parse(readFileSync(STATE_FILE, "utf8")).values ?? {};
  } catch {
    // 下で「無い」として扱う
  }
  const value = values[key];
  if (value === undefined || value === "") {
    throw new Error(`${key} が ${STATE_FILE} に無い（node setup/setup.mjs --target dev を先に済ませる）`);
  }
  return String(value);
}

/**
 * E2E のインスタンスに渡す環境変数。Next は既に process.env にあるキーを .env で上書きしないので（@next/env）、
 * 開発の .env の値を使わせたくないものは空文字で渡す（control-plane は空を未設定として扱う）。
 */
export function serverEnv() {
  return {
    COMEGIN_NEXT_DIST_DIR: ".next/e2e",
    NEXT_TELEMETRY_DISABLED: "1",
    BETTER_AUTH_SECRET: AUTH_SECRET,
    BETTER_AUTH_URL: BASE_URL,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: "e2e-client-secret",
    GOOGLE_HOSTED_DOMAIN: "comegin.com",
    CONTROL_ADMIN_EMAILS: ADMIN_EMAIL,
    CONTROL_DATA_DIR: DATA_DIR,
    CONTROL_MAIN_CHECKOUT: MAIN_CHECKOUT,
    CONTROL_WORKTREE: WORKTREE,
    CONTROL_SCHEDULER_ENABLED: "false",
    CONTROL_AGENT_HOME: AGENT_HOME,
    // オンプレの外（Anthropic・GitHub・AWS・本番の n8n）には繋がない
    ANTHROPIC_API_KEY: "",
    SITE_URL: "",
    GITHUB_TOKEN: "",
    GITHUB_REPOSITORY: "",
    GITHUB_BASE_BRANCH: "",
    I13_ISSUE_NUMBER: "",
    I13_REVIEWER: "",
    AWS_REGION: "",
    AWS_PROFILE: "",
    RUNLOG_BUCKET: "",
    HEARTBEAT_NAMESPACE: "",
    CONTROL_N8N_EXPORT_URL: "",
    CONTROL_N8N_EXPORT_API_KEY: "",
    // 誤った書き込みの突き合わせは、開発の Chatwoot（オンプレ）を本物として読む。
    // 開発では参照専用のトークンを分けていないため、管理者のトークンで読む（control-plane は GET しか送らない。結合テストと同じ）
    MISWRITE_CHATWOOT_BASE_URL: "http://127.0.0.1:3100",
    MISWRITE_CHATWOOT_ACCOUNT_ID: stateValue("CHATWOOT_ACCOUNT_ID"),
    MISWRITE_CHATWOOT_API_TOKEN: stateValue("CHATWOOT_ADMIN_TOKEN"),
    MISWRITE_AGENT_USER_ID: stateValue("CHATWOOT_AGENT_USER_ID"),
  };
}

function writeAt(relative, text) {
  const file = join(MAIN_CHECKOUT, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

function schedule(fields) {
  return `${Object.entries(fields)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? JSON.stringify(value) : Array.isArray(value) ? "[]" : String(value)}`)
    .join("\n")}\n`;
}

/** 前回の残りを消し、サンドボックスを作り直す（テスト用の定義 4 本とエージェント定義 1 本） */
export function prepareSandbox() {
  if (!SANDBOX_DIR.startsWith(tmpdir()) || !SANDBOX_DIR.endsWith("comegin-next-js-e2e")) {
    throw new Error("サンドボックスの置き場が想定と違う");
  }
  rmSync(SANDBOX_DIR, { recursive: true, force: true });
  for (const dir of [DATA_DIR, WORKTREE, AGENT_HOME]) mkdirSync(dir, { recursive: true });

  writeAt(
    `.claude/agents/${AGENT}.md`,
    `---\nname: ${AGENT}\ndescription: E2E 用のエージェント（起動はしない）\ntools: Read, Grep, Glob\n---\n\nE2E 用の本文。\n`,
  );
  const base = { enabled: false, cron: "0 3 * * *", after: [], timeout_sec: 120 };
  writeAt(
    `ops/schedules/${JOBS.published}.yaml`,
    schedule({ id: JOBS.published, description: "E2E: 公開された記事の確認（未実装のため見送る）", ...base, kind: "builtin", agent: null, builtin: "published-article-check" }),
  );
  writeAt(
    `ops/schedules/${JOBS.heartbeat}.yaml`,
    schedule({ id: JOBS.heartbeat, description: "E2E: ハートビート（AWS の設定が無いので見送る）", ...base, enabled: true, cron: "*/5 * * * *", kind: "builtin", agent: null, builtin: "heartbeat" }),
  );
  writeAt(
    `ops/schedules/${JOBS.miswrite}.yaml`,
    schedule({ id: JOBS.miswrite, description: "E2E: 誤った書き込みの突き合わせ（開発の Chatwoot を読む）", ...base, kind: "builtin", agent: null, builtin: "miswrite-check" }),
  );
  writeAt(
    `ops/schedules/${JOBS.agent}.yaml`,
    `${schedule({ id: JOBS.agent, description: "E2E: エージェントの定期実行（ANTHROPIC_API_KEY が無いので見送る）", ...base, kind: "agent", agent: AGENT, builtin: null })}prompt: "E2E の確認です。何もしないでください。"\nmax_turns: 2\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "prepare") prepareSandbox();
