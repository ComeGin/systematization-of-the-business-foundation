import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import * as z from "zod/v4";
import { logLine } from "./log.js";

// env ファイルに `VAR=` と書かれた空の値は未設定として扱う
const emptyToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

function expandHome(value: string): string {
  return value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

/** CONTROL_DATA_DIR の解決（未設定なら ~/.local/share/comegin-control）。監視アプリのログイン用 DB の置き場にも使う。 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CONTROL_DATA_DIR?.trim();
  return raw ? expandHome(raw) : join(homedir(), ".local/share/comegin-control");
}

// 相対パスは cwd 次第で作業ツリーの中を指しうる（E-15 は作業ツリーの外に置く約束）ため、任意のものも絶対パスに限る
const optionalPath = z
  .preprocess(emptyToUndefined, z.string().optional())
  .transform((value) => (value === undefined ? undefined : expandHome(value)))
  .refine((value) => value === undefined || isAbsolute(value), "絶対パスにしてください");
const requiredPath = z
  .preprocess(emptyToUndefined, z.string().min(1, "必須です").transform(expandHome))
  .refine((value) => isAbsolute(value), "絶対パスにしてください");

const RawSchema = z.object({
  // 中核（必須）
  CONTROL_DATA_DIR: optionalPath,
  CONTROL_MAIN_CHECKOUT: requiredPath,
  CONTROL_WORKTREE: requiredPath,
  CONTROL_SCHEDULER_ENABLED: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false")),
  CONTROL_AGENT_HOME: optionalPath,
  // エージェントに渡す唯一の秘密値
  ANTHROPIC_API_KEY: optionalString,
  // Lighthouse CI（builtin lighthouse）の計測対象。astro build が必須とする SITE_URL を、子プロセスに渡す
  SITE_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  // I-13（GitHub）
  GITHUB_TOKEN: optionalString,
  GITHUB_REPOSITORY: z.preprocess(
    emptyToUndefined,
    z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/repo の形にしてください").optional(),
  ),
  GITHUB_BASE_BRANCH: optionalString,
  I13_ISSUE_NUMBER: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  I13_REVIEWER: optionalString,
  // S3 への写しとハートビート
  AWS_REGION: optionalString,
  AWS_PROFILE: optionalString,
  RUNLOG_BUCKET: optionalString,
  HEARTBEAT_NAMESPACE: optionalString,
  // 誤った書き込みの突き合わせ（参照専用トークン）
  MISWRITE_CHATWOOT_BASE_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  MISWRITE_CHATWOOT_ACCOUNT_ID: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  MISWRITE_CHATWOOT_API_TOKEN: optionalString,
  MISWRITE_AGENT_USER_ID: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
});

type Raw = z.infer<typeof RawSchema>;

export interface ControlPlaneConfig {
  /** E-15 の SQLite・Better Auth の SQLite を置く場所（作業ツリーの外） */
  dataDir: string;
  /** 承認済み main の別チェックアウト（エージェント定義・ops/ をここから読む） */
  mainCheckout: string;
  /** 作業ツリー（エージェントの cwd。成果物を書く場所） */
  worktree: string;
  schedulerEnabled: boolean;
  /** SDK の子プロセスに HOME として渡すディレクトリ。null なら実ホーム */
  agentHome: string | null;
  anthropic: { apiKey: string } | null;
  /** Lighthouse CI の子プロセスに渡す SITE_URL（無ければ渡さない） */
  siteUrl: string | null;
  github: { token: string; repository: string; baseBranch: string; issueNumber: number; reviewer: string } | null;
  aws: { region: string; profile: string | null; runlogBucket: string; heartbeatNamespace: string } | null;
  miswrite: { baseUrl: string; accountId: number; apiToken: string; agentUserId: number } | null;
}

/** 同じグループの変数は、全部未設定（そのグループは無効）か、全部設定のどちらか。全部設定なら true。 */
function groupIssues(
  group: string,
  env: Raw,
  names: readonly (keyof Raw)[],
  addIssue: (name: string, message: string) => void,
): boolean {
  const unset = names.filter((name) => env[name] === undefined);
  if (unset.length === names.length) return false;
  for (const name of unset) addIssue(name, `${group} の他の変数が設定されているため必須です`);
  return unset.length === 0;
}

const Schema = RawSchema.transform((env, ctx): ControlPlaneConfig => {
  const addIssue = (name: string, message: string) => ctx.addIssue({ code: "custom", message, path: [name] });

  const anthropic = env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : null;

  const githubOk = groupIssues(
    "GitHub（I-13）",
    env,
    ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "I13_ISSUE_NUMBER", "I13_REVIEWER"],
    addIssue,
  );
  const awsOk = groupIssues("AWS（写しとハートビート）", env, ["AWS_REGION", "RUNLOG_BUCKET"], addIssue);
  const miswriteOk = groupIssues(
    "誤った書き込みの突き合わせ",
    env,
    [
      "MISWRITE_CHATWOOT_BASE_URL",
      "MISWRITE_CHATWOOT_ACCOUNT_ID",
      "MISWRITE_CHATWOOT_API_TOKEN",
      "MISWRITE_AGENT_USER_ID",
    ],
    addIssue,
  );
  // AWS_PROFILE だけ設定されていて他が無いのは設定漏れの可能性が高い
  if (env.AWS_PROFILE !== undefined && env.AWS_REGION === undefined && env.RUNLOG_BUCKET === undefined) {
    addIssue("AWS_REGION", "AWS_PROFILE が設定されているため必須です");
    addIssue("RUNLOG_BUCKET", "AWS_PROFILE が設定されているため必須です");
  }

  return {
    dataDir: env.CONTROL_DATA_DIR ?? resolveDataDir({}),
    mainCheckout: env.CONTROL_MAIN_CHECKOUT,
    worktree: env.CONTROL_WORKTREE,
    schedulerEnabled: env.CONTROL_SCHEDULER_ENABLED === "true",
    agentHome: env.CONTROL_AGENT_HOME ?? null,
    anthropic,
    siteUrl: env.SITE_URL ?? null,
    github: githubOk
      ? {
          token: env.GITHUB_TOKEN!,
          repository: env.GITHUB_REPOSITORY!,
          baseBranch: env.GITHUB_BASE_BRANCH ?? "main",
          issueNumber: env.I13_ISSUE_NUMBER!,
          reviewer: env.I13_REVIEWER!,
        }
      : null,
    aws: awsOk
      ? {
          region: env.AWS_REGION!,
          profile: env.AWS_PROFILE ?? null,
          runlogBucket: env.RUNLOG_BUCKET!,
          heartbeatNamespace: env.HEARTBEAT_NAMESPACE ?? "ComeGin/Onprem",
        }
      : null,
    miswrite: miswriteOk
      ? {
          baseUrl: env.MISWRITE_CHATWOOT_BASE_URL!.replace(/\/+$/, ""),
          accountId: env.MISWRITE_CHATWOOT_ACCOUNT_ID!,
          apiToken: env.MISWRITE_CHATWOOT_API_TOKEN!,
          agentUserId: env.MISWRITE_AGENT_USER_ID!,
        }
      : null,
  };
});

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * 環境変数を zod で検証する。失敗したら変数名と理由だけを stderr に出して ConfigError を投げる（値は出さない）。
 * ライブラリなので exit(1) はせず、呼び出し側（監視アプリ）に例外で返す。
 */
export function loadControlPlaneConfig(env: NodeJS.ProcessEnv = process.env): ControlPlaneConfig {
  const result = Schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
    const message = `環境変数が不正です:\n${issues.join("\n")}`;
    logLine("ERROR", "config", message);
    throw new ConfigError(message);
  }
  return result.data;
}
