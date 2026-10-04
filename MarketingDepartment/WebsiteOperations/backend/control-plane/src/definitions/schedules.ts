// 定期実行の定義（W/ops/schedules/<job-id>.yaml）の読み込み。形式は固定シート 7 節。
// 読み先は承認済み main のチェックアウト（CONTROL_MAIN_CHECKOUT）。作業ツリーからは読まない（ADR-18）。
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { Cron } from "croner";
import { parse as parseYaml } from "yaml";
import * as z from "zod/v4";
import { SCHEDULES_DIR } from "../constants/paths.js";
import type { BuiltinJob, JobDefinition } from "../contract.js";
import { logLine } from "../log.js";
import { TIMEZONE } from "../time.js";

const BUILTIN_JOBS = [
  "heartbeat",
  "i13-file",
  "miswrite-check",
  "silence-check",
  "lighthouse",
  "published-article-check",
  "runlog-flush",
] as const satisfies readonly BuiltinJob[];

const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function isValidCron(expression: string): boolean {
  if (expression.trim().split(/\s+/).length !== 5) return false; // 5 フィールドだけ許す
  try {
    new Cron(expression, { timezone: TIMEZONE, paused: true });
    return true;
  } catch {
    return false;
  }
}

const ScheduleFileSchema = z
  .object({
    id: z.string().regex(KEBAB_CASE, "kebab-case にしてください"),
    description: z.string().default(""),
    enabled: z.boolean().default(false),
    cron: z.string().refine(isValidCron, "5 フィールドの cron 式にしてください（Asia/Tokyo）"),
    kind: z.enum(["agent", "builtin"]),
    agent: z.string().regex(KEBAB_CASE).nullable().default(null),
    builtin: z.enum(BUILTIN_JOBS).nullable().default(null),
    after: z.array(z.string()).default([]),
    prompt: z.string().nullable().default(null),
    timeout_sec: z.number().int().positive().default(900),
    max_turns: z.number().int().positive().nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "agent") {
      if (!value.agent) ctx.addIssue({ code: "custom", message: "kind=agent では必須です", path: ["agent"] });
      if (!value.prompt?.trim()) ctx.addIssue({ code: "custom", message: "kind=agent では必須です", path: ["prompt"] });
    } else if (!value.builtin) {
      ctx.addIssue({ code: "custom", message: "kind=builtin では必須です", path: ["builtin"] });
    }
  });

/** 公開の JobDefinition に、内部で使う prompt を足したもの（契約の型は変えない）。 */
export interface ScheduleDefinition extends JobDefinition {
  prompt: string | null;
}

export interface LoadedSchedules {
  jobs: ScheduleDefinition[];
  /** 読めなかった定義（ファイル名と理由。値は含めない） */
  errors: { file: string; reason: string }[];
}

export async function loadSchedules(mainCheckout: string): Promise<LoadedSchedules> {
  const dir = join(mainCheckout, SCHEDULES_DIR);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".yaml")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { jobs: [], errors: [] };
    throw error;
  }

  const jobs: ScheduleDefinition[] = [];
  const errors: LoadedSchedules["errors"] = [];
  for (const file of files) {
    try {
      const parsed = ScheduleFileSchema.safeParse(parseYaml(await readFile(join(dir, file), "utf8")));
      if (!parsed.success) {
        const reason = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
        errors.push({ file, reason });
        continue;
      }
      const value = parsed.data;
      if (value.id !== basename(file, ".yaml")) {
        errors.push({ file, reason: "id がファイル名と一致しません" });
        continue;
      }
      jobs.push({
        id: value.id,
        description: value.description,
        enabled: value.enabled,
        cron: value.cron,
        kind: value.kind,
        agent: value.kind === "agent" ? value.agent : null,
        builtin: value.kind === "builtin" ? value.builtin : null,
        after: value.after,
        timeoutSec: value.timeout_sec,
        maxTurns: value.max_turns,
        prompt: value.kind === "agent" ? value.prompt : null,
      });
    } catch (error) {
      errors.push({ file, reason: error instanceof Error ? error.message : "読み込みに失敗しました" });
    }
  }

  const ids = new Set(jobs.map((job) => job.id));
  for (const job of jobs) {
    for (const dependency of job.after) {
      if (!ids.has(dependency)) logLine("WARN", "schedules", `${job.id}: after の ${dependency} が定義に無い`);
    }
  }
  for (const error of errors) logLine("WARN", "schedules", `${error.file} を読み込めない: ${error.reason}`);
  return { jobs, errors };
}
