// a11y の自動検査（builtin `a11y`）。axe と Playwright の e2e を main のチェックアウトで実行し、結果の JSON を作業ツリーに写す。
// 子プロセスの起動と結果の写しは checkout-job.ts の共通部品を使う（安全のための設計もそこに書いてある）。
//
// この builtin に固有のこと:
//   - 実行するのは `pnpm a11y:ci`（astro build && playwright test）。ビルドから検査までを 1 本で行い、古い dist を測らない。
//     weekly-lighthouse とは after で結ばない（Lighthouse の揺れで a11y の検査まで止めない）。重ならないのは cron の時刻で保つ。
//   - HOME は使い捨てなので、Playwright は既定の ~/.cache/ms-playwright を見つけられない。実ホームのその場所を
//     PLAYWRIGHT_BROWSERS_PATH で明示して渡す（HOME 自体は渡さない）。人が main のチェックアウトで
//     `pnpm exec playwright install chromium` を既定どおり実行しておく前提で、Chromium が無ければ skipped にする。
//   - axe の違反があると playwright test は終了コード 1 になる。これは観測した結果であって検査の失敗ではないので、
//     今回のレポートが読めてトップの errors が空なら success にする（違反の判断は quality-checker の項目 6）。
//     failure にすると、違反があるときに限って weekly-observe-a11y（after）が見送られてしまう。
//   - 結果は .a11y/ の直下の *.json だけを、作業ツリー側の .a11y/ に写す。quality-checker は作業ツリーの中しか読めない。
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import type { BuiltinHandler, RunResult } from "../context.js";
import { PLAYWRIGHT_BROWSERS_SUBDIR, VERDANT_VIRGO_DIR } from "../constants/paths.js";
import {
  childEnv,
  copyResults,
  exists,
  isFreshResultFile,
  logChildFailure,
  runPnpmScript,
  withChildHome,
} from "./checkout-job.js";

const SCRIPT = "a11y:ci";
const RESULT_DIR = ".a11y";
/** Playwright の JSON reporter の出力（verifier の playwright.config.ts と合わせる） */
export const A11Y_REPORT_FILE = "results.json";
/** 写してよいファイル名（.a11y/ の直下の JSON だけ） */
const RESULT_FILE = /^[\w.-]+\.json$/;
/** Chromium のディレクトリ名（ヘッドレスは chromium_headless_shell-<版> を使う版がある） */
const CHROMIUM_DIR = /^chromium(?:_headless_shell)?-\d+$/;

/** Playwright の JSON レポートのうち、判定に使うところだけ */
const ReportSchema = z.object({
  errors: z.array(z.unknown()).default([]),
  stats: z.object({
    expected: z.number().int().nonnegative(),
    unexpected: z.number().int().nonnegative(),
    flaky: z.number().int().nonnegative().default(0),
    skipped: z.number().int().nonnegative().default(0),
  }),
});
type Report = z.infer<typeof ReportSchema>;

/** 子プロセスの env。許可リスト（土台に PLAYWRIGHT_BROWSERS_PATH だけを足す）。 */
export function a11yEnv(home: string, siteUrl: string | null, browsersPath: string): NodeJS.ProcessEnv {
  return { ...childEnv(home, siteUrl), PLAYWRIGHT_BROWSERS_PATH: browsersPath };
}

async function hasChromium(browsersPath: string): Promise<boolean> {
  try {
    const entries = await readdir(browsersPath, { withFileTypes: true });
    return entries.some((entry) => entry.isDirectory() && CHROMIUM_DIR.test(entry.name));
  } catch {
    return false;
  }
}

/** 今回の実行で書かれたレポートを読む。無ければ "missing"、解釈できなければ "invalid"。 */
async function readReport(path: string, since: number): Promise<Report | "missing" | "invalid"> {
  if (!(await isFreshResultFile(path, since))) return "missing";
  try {
    const parsed = ReportSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : "invalid";
  } catch {
    return "invalid";
  }
}

const skipped = (reason: string, hint: string): RunResult => ({
  outcome: "skipped",
  summary: `a11y の検査を見送った（${reason}。${hint}）`,
  targetIds: [],
  skipReason: reason,
});

const failed = (summary: string, failureClass: RunResult["failureClass"]): RunResult => ({
  outcome: "failure",
  summary,
  targetIds: [],
  failureClass,
});

export const a11y: BuiltinHandler = async ({ ctx, runId, signal, timeoutSec }): Promise<RunResult> => {
  const { config } = ctx;
  const cwd = join(config.mainCheckout, VERDANT_VIRGO_DIR);
  if (!(await exists(join(cwd, "node_modules")))) {
    return skipped("dependencies not installed", "main のチェックアウトで pnpm install が要る");
  }
  const browsersPath = join(homedir(), PLAYWRIGHT_BROWSERS_SUBDIR);
  if (!(await hasChromium(browsersPath))) {
    return skipped("chromium not installed", "main のチェックアウトで pnpm exec playwright install chromium が要る");
  }

  const startedAt = Date.now();
  const run = await withChildHome(config.agentHome, "comegin-a11y-", (home) =>
    runPnpmScript({ cwd, script: SCRIPT, env: a11yEnv(home, config.siteUrl, browsersPath), timeoutSec, signal }),
  );

  if (run.timedOut || signal.aborted) {
    logChildFailure("a11y", SCRIPT, run, runId);
    return failed("a11y の検査がタイムアウトした", "timeout");
  }
  if (run.code === -1) {
    logChildFailure("a11y", SCRIPT, run, runId);
    return failed("a11y の検査を起動できなかった", "unreachable");
  }
  if (run.code !== 0 && run.code !== 1) {
    logChildFailure("a11y", SCRIPT, run, runId);
    return failed(`a11y の検査が終了コード ${run.code} で失敗した`, "invalid_response");
  }

  const report = await readReport(join(cwd, RESULT_DIR, A11Y_REPORT_FILE), startedAt);
  if (report === "missing") {
    if (run.code === 0) {
      return {
        outcome: "partial",
        summary: "a11y の検査は終了したが、写すべき結果の JSON が見つからなかった",
        targetIds: [],
        failureClass: "empty_but_ok",
      };
    }
    // build が先に走るので、レポートが無いまま終了コード 1 なら、検査の前（ビルド）で止まった
    logChildFailure("a11y", SCRIPT, run, runId);
    return failed("a11y の検査の前にビルドが失敗した（検査のレポートが作られなかった）", "invalid_response");
  }
  if (report === "invalid") {
    logChildFailure("a11y", SCRIPT, run, runId);
    return failed("a11y の検査のレポートを解釈できなかった", "invalid_response");
  }
  if (report.errors.length > 0) {
    // テストの外のエラー（webServer の起動失敗・設定の誤りなど）。検査が走っていないので結果として扱わない
    logChildFailure("a11y", SCRIPT, run, runId);
    return failed(`a11y の検査を始められなかった（Playwright のエラー ${report.errors.length} 件）`, "invalid_response");
  }

  // 結果を作業ツリー側へ写す（quality-checker は作業ツリーの中しか読めない）
  const copied = await copyResults(join(cwd, RESULT_DIR), join(config.worktree, VERDANT_VIRGO_DIR, RESULT_DIR), startedAt, {
    accept: RESULT_FILE,
  });
  const { expected, unexpected } = report.stats;
  return {
    outcome: copied > 0 ? "success" : "partial",
    summary:
      copied > 0
        ? `a11y の検査を main のチェックアウトで実行し、結果の JSON ${copied} 件を作業ツリーに写した（不合格 ${unexpected} 件・合格 ${expected} 件）`
        : "a11y の検査は終了したが、写すべき結果の JSON が見つからなかった",
    targetIds: [],
    failureClass: copied > 0 ? null : "empty_but_ok",
  };
};
