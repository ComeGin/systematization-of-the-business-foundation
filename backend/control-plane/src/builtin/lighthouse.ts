// Lighthouse CI の実行（builtin `lighthouse`）。子プロセスの起動と結果の写しは checkout-job.ts の共通部品を使う
// （安全のための設計もそこに書いてある）。
//
// この builtin に固有のこと:
//   - 配信されるのも承認済み main なので、計測の対象としても main が正しい（記事の中身は本番の Strapi から読む）。
//   - env は PATH・HOME・npm_config_ignore_scripts・SITE_URL（設定されていれば）だけ。
//   - 結果の JSON を作業ツリー側の .lighthouse/ に写す。seo-auditor は作業ツリーの中しか読めない。
import { join } from "node:path";
import type { BuiltinHandler, RunResult } from "../context.js";
import { VERDANT_VIRGO_DIR } from "../constants/paths.js";
import { childEnv, copyResults, exists, logChildFailure, runPnpmScript, withChildHome } from "./checkout-job.js";

const SCRIPT = "lh";
const RESULT_DIR = ".lighthouse";
/** 写してよいファイル名（結果の lhr-*.json と manifest.json だけ） */
const RESULT_FILE = /^(?:lhr-[\w.-]+|manifest)\.json$/;

/** 子プロセスの env。許可リスト。 */
export function lighthouseEnv(home: string, siteUrl: string | null): NodeJS.ProcessEnv {
  return childEnv(home, siteUrl);
}

export const lighthouse: BuiltinHandler = async ({ ctx, runId, signal, timeoutSec }): Promise<RunResult> => {
  const { config } = ctx;
  const cwd = join(config.mainCheckout, VERDANT_VIRGO_DIR);
  if (!(await exists(join(cwd, "node_modules")))) {
    return {
      outcome: "skipped",
      summary: "Lighthouse CI を見送った（dependencies not installed。main のチェックアウトで pnpm install が要る）",
      targetIds: [],
      skipReason: "dependencies not installed",
    };
  }

  const startedAt = Date.now();
  const run = await withChildHome(config.agentHome, "comegin-lighthouse-", (home) =>
    runPnpmScript({ cwd, script: SCRIPT, env: lighthouseEnv(home, config.siteUrl), timeoutSec, signal }),
  );

  if (run.code !== 0) {
    logChildFailure("lighthouse", SCRIPT, run, runId);
    return {
      outcome: "failure",
      summary: run.timedOut ? "Lighthouse CI がタイムアウトした" : `Lighthouse CI が終了コード ${run.code} で失敗した`,
      targetIds: [],
      failureClass: run.timedOut || signal.aborted ? "timeout" : run.code === -1 ? "unreachable" : "invalid_response",
    };
  }

  // 結果を作業ツリー側へ写す（seo-auditor は作業ツリーの中しか読めない）
  const copied = await copyResults(join(cwd, RESULT_DIR), join(config.worktree, VERDANT_VIRGO_DIR, RESULT_DIR), startedAt, {
    accept: RESULT_FILE,
    alwaysFresh: (name) => name === "manifest.json",
  });
  return {
    outcome: copied > 0 ? "success" : "partial",
    summary:
      copied > 0
        ? `Lighthouse CI を main のチェックアウトで実行し、結果の JSON ${copied} 件を作業ツリーに写した`
        : "Lighthouse CI は終了したが、写すべき結果の JSON が見つからなかった",
    targetIds: [],
    failureClass: copied > 0 ? null : "empty_but_ok",
  };
};
