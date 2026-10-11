// 結合テストの土台: 一時ディレクトリ（E-15・ログイン用 DB・main のチェックアウトの写し・作業ツリー）、環境変数、
// 本物の Better Auth でのログイン（Google を通さずにユーザーとセッションを作る）、Route Handler の呼び出し。
//
// 開発で動いている監視アプリ（127.0.0.1:3200）と、その置き場（~/.local/share/comegin-control）には触れない。
// control-plane も Better Auth も環境変数から置き場を決めるので、最初の呼び出しより前に applyEnv() で一時ディレクトリに向ける。
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NextRequest } from "next/server";
import type { RunRecord } from "control-plane";
import { GET as getRunRoute } from "@/app/api/runs/[runId]/route";
import { ensureAuthSchema, getAuth } from "@/lib/auth";
import { requestScope } from "./request-scope";

export const BASE_URL = "http://127.0.0.1:3200";
const HOST = "127.0.0.1:3200";

/** 1 回の実行（ファイル単位）で 1 つ。Chatwoot など開発スタックに作るデータの名前に付ける */
export const RUN_ID = `it-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
export const itName = (label: string): string => `${RUN_ID}-${label}`;
export const itEmail = (label: string): string => `${RUN_ID}-${label}@example.com`.toLowerCase();

/** 許可リストに入れるメール（Workspace のドメイン comegin.com）。Google には問い合わせない */
export const ADMIN_EMAIL = "it-admin@comegin.com";

/** W の中の相対パス（control-plane の constants/paths.ts と同じ）。main のチェックアウトはリポジトリのルートの形で作る */
export const SCHEDULES_DIR = "ops/schedules";
export const PROPOSALS_DIR = "docs/proposals";
export const AGENTS_DIR = ".claude/agents";

// テストが書き換える環境変数。最初に全部消してから入れる（シェルに残った本物の値を拾わない）
const MANAGED_KEYS = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_HOSTED_DOMAIN",
  "CONTROL_ADMIN_EMAILS",
  "CONTROL_DATA_DIR",
  "CONTROL_MAIN_CHECKOUT",
  "CONTROL_WORKTREE",
  "CONTROL_SCHEDULER_ENABLED",
  "CONTROL_AGENT_HOME",
  "ANTHROPIC_API_KEY",
  "SITE_URL",
  "GITHUB_TOKEN",
  "GITHUB_REPOSITORY",
  "GITHUB_BASE_BRANCH",
  "I13_ISSUE_NUMBER",
  "I13_REVIEWER",
  "AWS_REGION",
  "AWS_PROFILE",
  "RUNLOG_BUCKET",
  "HEARTBEAT_NAMESPACE",
  "MISWRITE_CHATWOOT_BASE_URL",
  "MISWRITE_CHATWOOT_ACCOUNT_ID",
  "MISWRITE_CHATWOOT_API_TOKEN",
  "MISWRITE_AGENT_USER_ID",
  "CONTROL_N8N_EXPORT_URL",
  "CONTROL_N8N_EXPORT_API_KEY",
] as const;

const savedEnv = new Map<string, string | undefined>();

/** 環境変数を入れる（undefined は消す）。元の値は restoreEnv() で戻す */
export function applyEnv(values: Record<string, string | undefined>): void {
  for (const key of new Set([...MANAGED_KEYS, ...Object.keys(values)])) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
}

export interface Sandbox {
  root: string;
  dataDir: string;
  mainCheckout: string;
  worktree: string;
  agentHome: string;
  /** 監視アプリの環境変数（control-plane と Better Auth の分）。overrides で足す・消す */
  env(overrides?: Record<string, string | undefined>): Record<string, string | undefined>;
  dispose(): void;
}

export function createSandbox(label: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), `next-js-it-${label}-`));
  const dataDir = join(root, "data");
  const mainCheckout = join(root, "main");
  const worktree = join(root, "worktree");
  const agentHome = join(root, "agent-home");
  for (const dir of [mainCheckout, worktree]) mkdirSync(dir, { recursive: true });
  // 開発の監視アプリの置き場を指していないことを先に確かめる（指していたら何も始めない）
  if (dataDir.startsWith(join(homedir(), ".local/share"))) throw new Error("CONTROL_DATA_DIR が開発の置き場を指している");
  const secret = randomBytes(32).toString("base64url");
  const blank = Object.fromEntries(MANAGED_KEYS.map((key) => [key, undefined]));
  return {
    root,
    dataDir,
    mainCheckout,
    worktree,
    agentHome,
    env: (overrides = {}) => ({
      ...blank,
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: BASE_URL,
      CONTROL_ADMIN_EMAILS: ADMIN_EMAIL,
      CONTROL_DATA_DIR: dataDir,
      CONTROL_MAIN_CHECKOUT: mainCheckout,
      CONTROL_WORKTREE: worktree,
      CONTROL_SCHEDULER_ENABLED: "false",
      CONTROL_AGENT_HOME: agentHome,
      // Agent SDK は差し替えるので、どこにも送られないダミー
      ANTHROPIC_API_KEY: "it-dummy-anthropic-key",
      ...overrides,
    }),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function writeAt(root: string, relative: string, text: string): string {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
  return file;
}

/** エージェント定義（.claude/agents/<name>.md。Claude Code のサブエージェント形式） */
export function agentDefinition(name: string, tools = "Read, Grep, Glob"): string {
  return `---\nname: ${name}\ndescription: 結合テスト用のエージェント\ntools: ${tools}\n---\n\n結合テスト用の本文。\n`;
}

/** 定期実行の定義（ops/schedules/<id>.yaml） */
export function scheduleYaml(fields: Record<string, string | number | boolean | null>): string {
  return `${Object.entries(fields)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? JSON.stringify(value) : String(value)}`)
    .join("\n")}\n`;
}

/** 提案（E-13）の frontmatter。control-plane の単体テストの見本と同じ形 */
export function proposalText(options: { id: string; state?: string; identifier?: string; createdAt?: string }): string {
  const { id, state = "draft", identifier = "url_path=/", createdAt = "2026-10-01T07:00:00+09:00" } = options;
  return `---
proposal_id: ${id}
created_at: ${createdAt}
created_by: agent/proposal-writer
agent_run_id: 01K6PZ3T8Q4M2N7R9S5V1W3X6Y
evidence:
  - audit_id: AUD-2026-1004-lighthouse-0001
    source: lighthouse
    ref: docs/audits/lighthouse/AUD-2026-1004-lighthouse-0001.md
    summary: "要旨"
target:
  entity: E-10
  identifier: "${identifier}"
  also_affects: []
change:
  kind: technical_seo
  description: "変更の説明"
  diff_ref: null
expectation:
  metric: LH-performance
  baseline: 0.99
  target: 1.0
  judge_after: 2026-11-03
  judge_by: R3
risk:
  level: low
  description: "悪影響"
  blast_radius: "範囲"
approval:
  state: ${state}
  approver: null
  decided_at: null
  record_ref: null
applied_at: null
verification:
  state: pending
  verified_at: null
  result: null
  audit_ref: null
rollback:
  procedure: "手順"
  reversible: true
  deadline: 2026-12-03
---

# 結合テストの提案
`;
}

// ---- ログイン（本物の Better Auth。ユーザーとセッションの作成は databaseHooks の許可リストを通る） ----

/** Better Auth の Cookie と同じ署名（HMAC-SHA256、base64）を付けたセッション Cookie */
export async function sessionCookie(token: string): Promise<string> {
  const ctx = await getAuth().$context;
  const signature = createHmac("sha256", ctx.secret).update(token).digest("base64");
  return `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`;
}

/** Google のログインの後と同じく、ユーザーとセッションを作る（許可リストに無ければ Better Auth が FORBIDDEN を投げる） */
export async function createUserAndSession(email: string): Promise<{ userId: string; token: string; cookie: string }> {
  await ensureAuthSchema();
  const ctx = await getAuth().$context;
  // source は Google のコールバック（oauth2/link-account）が渡すものと同じ形
  const user = await ctx.internalAdapter.createUser(
    { email, name: "it", emailVerified: true },
    { method: "oauth", oauth: { providerId: "google" } },
  );
  const session = await ctx.internalAdapter.createSession(user.id, false);
  return { userId: user.id, token: session.token, cookie: await sessionCookie(session.token) };
}

// ---- Route Handler の呼び出し ----

export interface RequestOptions {
  method?: string;
  cookie?: string;
  /** オブジェクトなら JSON にする。文字列はそのまま */
  body?: unknown;
  /** 状態を変える要求の Origin。null なら付けない（既定は同じオリジン） */
  origin?: string | null;
}

export function apiRequest(path: string, options: RequestOptions = {}): NextRequest {
  const { method = "GET", cookie, body, origin = BASE_URL } = options;
  const headers: Record<string, string> = { host: HOST };
  if (cookie) headers.cookie = cookie;
  if (method !== "GET" && method !== "HEAD") {
    if (origin !== null) headers.origin = origin;
    headers["content-type"] = "application/json";
  }
  const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  return new NextRequest(`${BASE_URL}${path}`, { method, headers, body: payload });
}

export interface ApiResult<T> {
  status: number;
  text: string;
  json: T;
}

/** Route Handler を要求 1 つで呼ぶ。headers()（next/headers の差し替え）には、その要求のヘッダーを渡す */
export async function callRoute<T = Record<string, unknown>, C extends unknown[] = []>(
  handler: (request: NextRequest, ...context: C) => Promise<Response>,
  request: NextRequest,
  ...context: C
): Promise<ApiResult<T>> {
  requestScope.headers = new Headers(request.headers);
  const response = await handler(request, ...context);
  const text = await response.text();
  return { status: response.status, text, json: (text ? JSON.parse(text) : null) as T };
}

/** /api/runs/[runId] の第 2 引数 */
export function runContext(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

/** 実行（完了を待たずに返る）が終わるまで、GET /api/runs/[runId] を見に行く */
export async function waitForRun(
  cookie: string,
  runId: string,
  until: (run: RunRecord) => boolean = (run) => run.status === "finished",
  timeoutMs = 30_000,
): Promise<RunRecord> {
  const deadline = Date.now() + timeoutMs;
  let last: RunRecord | undefined;
  for (;;) {
    const res = await callRoute<{ run?: RunRecord }, [ReturnType<typeof runContext>]>(
      getRunRoute,
      apiRequest(`/api/runs/${runId}`, { cookie }),
      runContext(runId),
    );
    last = res.json.run;
    if (last && until(last)) return last;
    if (Date.now() >= deadline) throw new Error(`run ${runId} の完了を ${timeoutMs}ms 待ったが届かなかった（最後: ${last?.status ?? "無し"}）`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** control-plane のインスタンス（globalThis に 1 つ）を捨てる。次の要求で、その時点の環境変数から作り直される */
export function resetControlPlane(): void {
  globalThis.__comeginControlPlane = undefined;
}

/** 要求の応答に、内部の詳細（パス・SQLite の文・秘密値）が出ていないこと */
export function leakedFragments(text: string, fragments: string[]): string[] {
  return fragments.filter((fragment) => fragment && text.includes(fragment));
}
