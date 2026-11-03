// 設定の状況: 承認済み main のチェックアウトの設定スクリプトを、読み取り（--check --json）で子プロセスとして動かす（spec の 5.1）。
//
// 守ること:
//   - 動かすのは `node <mainCheckout>/<script> --target prod --check --json --phase all [--skip …]` だけ（--check を付けない実行はしない）。
//   - 子プロセスの env は許可リストだけ（呼び出し元の env は引き継がない）。AWS は状況の確認専用の主体の資格情報ファイルだけを使わせ、
//     AWS_CONFIG_FILE=/dev/null で手元の SSO のプロファイルなどを読ませない。GitHub のトークンは渡さない（fetch は git-fetch.ts が行う）。
//   - 標準出力の最後の空でない行を結果の JSON として zod で検証する。標準エラー（人向けの表示）は捨てる
//     （失敗したときだけ、伏せた末尾をログに出す）。
//   - 上限 5 分。超えたら子プロセスを殺す。
import { execFile } from "node:child_process";
import { join } from "node:path";
import * as z from "zod/v4";
import type { ControlPlaneConfig } from "../config.js";
import type { SetupStatusLevel } from "../contract.js";
import { logLine } from "../log.js";

export const SETUP_SCRIPTS = ["setup/setup.mjs", "setup/frontend.mjs"] as const;
export type SetupScript = (typeof SETUP_SCRIPTS)[number];
export type StatusConfig = NonNullable<ControlPlaneConfig["status"]>;

/** 1 本の設定スクリプトの確認の上限（spec 5.4） */
export const SETUP_CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUFFER = 32 * 1024 * 1024;

const LEVELS = ["ok", "action", "warn", "manual", "unknown"] as const satisfies readonly SetupStatusLevel[];
const LevelSchema = z.enum(LEVELS);

export interface StatusItem {
  key: string;
  step: string;
  level: SetupStatusLevel;
  title: string;
  evidence: string;
  stopId?: string;
}

/**
 * モジュールの items の 1 つ。key・step が文字列でないものは捨てる（カタログと対応づけられない）。
 * level が 5 種類のどれでもなければ unknown にする（報告全体は捨てない）。
 */
function normalizeItem(raw: unknown): StatusItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== "string" || r.key === "" || typeof r.step !== "string" || r.step === "") return null;
  const level = LevelSchema.safeParse(r.level);
  const evidence = typeof r.evidence === "string" ? r.evidence : "";
  return {
    key: r.key,
    step: r.step,
    level: level.success ? level.data : "unknown",
    title: typeof r.title === "string" ? r.title : "",
    evidence: level.success ? evidence : `モジュールが知らない level を返した${evidence ? `: ${evidence}` : ""}`,
    ...(typeof r.stopId === "string" && r.stopId !== "" ? { stopId: r.stopId } : {}),
  };
}

const ResultSchema = z.object({
  moduleId: z.string().min(1),
  phase: z.string().nullable(),
  ok: z.boolean(),
  notes: z.array(z.string()),
  items: z
    .array(z.unknown())
    .default([])
    .transform((items) => items.map(normalizeItem).filter((item): item is StatusItem => item !== null)),
  error: z.string().nullable(),
  skipped: z.boolean(),
});

const ReportSchema = z.object({
  version: z.literal(1),
  target: z.literal("prod"),
  script: z.enum(SETUP_SCRIPTS),
  startedAt: z.string(),
  finishedAt: z.string(),
  results: z.array(ResultSchema),
});

/** setup/README.md の「--json の結果」と同じ形（items は検証して正規化したもの）。 */
export type SetupCheckReport = z.infer<typeof ReportSchema>;

/** 標準出力の最後の空でない行を、結果の JSON として検証する。 */
export function parseReport(stdout: string, script: SetupScript): SetupCheckReport | { error: string } {
  const last = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1);
  if (last === undefined) return { error: `${script} が結果の JSON を出さなかった` };
  let json: unknown;
  try {
    json = JSON.parse(last);
  } catch {
    return { error: `${script} の結果が JSON として読めない` };
  }
  const parsed = ReportSchema.safeParse(json);
  if (!parsed.success) {
    // 場所だけを出す（値は出さない）
    const where = parsed.error.issues
      .slice(0, 3)
      .map((issue) => issue.path.join(".") || "(root)")
      .join("・");
    return { error: `${script} の結果の形が不正（${where}）` };
  }
  if (parsed.data.script !== script) return { error: `${script} の結果の script が ${parsed.data.script} になっている` };
  return parsed.data;
}

/** 子プロセスの env。許可リストだけ。 */
export function setupCheckEnv(worktree: string, status: StatusConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "LANG"] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    AWS_SHARED_CREDENTIALS_FILE: status.awsCredentialsFile,
    AWS_PROFILE: status.awsProfile,
    AWS_REGION: status.region,
    // 手元の ~/.aws/config（SSO のプロファイルなど広い権限）を読ませない
    AWS_CONFIG_FILE: "/dev/null",
    SETUP_WORKTREE: worktree,
  };
}

export function setupCheckArgs(mainCheckout: string, script: SetupScript, skip: readonly string[]): string[] {
  const args = [join(mainCheckout, script), "--target", "prod", "--check", "--json", "--phase", "all"];
  if (skip.length > 0) args.push("--skip", skip.join(","));
  return args;
}

/**
 * 設定スクリプトを 1 本、読み取りで動かして結果を返す。投げずに { error } を返す（error に値・標準エラーは入れない）。
 * redact を渡すと、失敗したときにログに出す標準エラーの末尾を伏せてから出す。
 */
export function runSetupCheck(opts: {
  mainCheckout: string;
  worktree: string;
  status: StatusConfig;
  script: SetupScript;
  skip: string[];
  signal: AbortSignal;
  redact?: (text: string) => string;
  timeoutMs?: number;
}): Promise<SetupCheckReport | { error: string }> {
  const { script, signal } = opts;
  const timeoutMs = opts.timeoutMs ?? SETUP_CHECK_TIMEOUT_MS;
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ error: "打ち切られた" });
      return;
    }
    execFile(
      process.execPath,
      setupCheckArgs(opts.mainCheckout, script, opts.skip),
      {
        cwd: opts.mainCheckout,
        env: setupCheckEnv(opts.worktree, opts.status),
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        signal,
        maxBuffer: MAX_BUFFER,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === "string" ? stdout : "";
        const logTail = () => {
          const mask = opts.redact ?? (() => "（伏せる関数が無いため出さない）");
          const tail = mask(typeof stderr === "string" ? stderr : "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(-300);
          logLine("WARN", "setup-status", `${script} の確認が失敗: stderr(末尾)=${tail}`);
        };
        if (error) {
          const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
          if (signal.aborted || failure.name === "AbortError") {
            resolve({ error: "打ち切られた" });
            return;
          }
          if (failure.killed === true) {
            logTail();
            resolve({ error: `${script} の確認が ${Math.round(timeoutMs / 1000)} 秒で終わらなかった` });
            return;
          }
          // 終了コードが 0 以外でも、結果の JSON が出ていれば使う（モジュールの失敗は results の error に載る）
          const parsed = parseReport(out, script);
          if (!("error" in parsed)) {
            resolve(parsed);
            return;
          }
          logTail();
          const code = typeof failure.code === "number" ? failure.code : typeof failure.code === "string" ? failure.code : "なし";
          resolve({ error: `${script} の確認が失敗した（終了コード ${code}）` });
          return;
        }
        const parsed = parseReport(out, script);
        if ("error" in parsed) logTail();
        resolve(parsed);
      },
    );
  });
}
