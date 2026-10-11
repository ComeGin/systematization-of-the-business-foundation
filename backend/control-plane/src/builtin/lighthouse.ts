// Lighthouse CI の実行（builtin `lighthouse`）。子プロセスを起動するのは、control-plane ではここ 1 か所だけ。
//
// 安全のための設計（セキュリティレビュー HIGH への対応）:
//   - 実行元は CONTROL_MAIN_CHECKOUT（承認済み main）。作業ツリーはエージェントが書ける場所で、そこの
//     package.json の script や lighthouserc.cjs・.npmrc を実行すると、control-plane の権限で任意のコードが動く。
//     配信されるのも承認済み main なので、計測の対象としても main が正しい（記事の中身は本番の Strapi から読む）。
//   - `pnpm install` は人が main のチェックアウトで済ませておく前提。node_modules が無ければ実行せず skipped にする。
//   - 子プロセスの HOME は実ホームにしない（~/.aws などに届かせない）。CONTROL_AGENT_HOME、無ければ使い捨ての一時ディレクトリ。
//   - env は PATH・HOME・npm_config_ignore_scripts（万一 pnpm が依存の解決に入ってもライフサイクルスクリプトを動かさない）・
//     SITE_URL（設定されていれば）だけ。
//   - 結果の JSON を作業ツリー側の .lighthouse/ に写すのは control-plane。seo-auditor は作業ツリーの中しか読めない。
//     写すのは JSON ファイルだけで、シンボリックリンクはたどらない。
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { BuiltinHandler, RunResult } from "../context.js";
import { VERDANT_VIRGO_DIR } from "../constants/paths.js";
import { logLine } from "../log.js";

const RESULT_DIR = ".lighthouse";
/** 写してよいファイル名（結果の lhr-*.json と manifest.json だけ） */
const RESULT_FILE = /^(?:lhr-[\w.-]+|manifest)\.json$/;
const MAX_RESULT_BYTES = 25 * 1024 * 1024;

/** 子プロセスの env。許可リスト。 */
export function lighthouseEnv(home: string, siteUrl: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    npm_config_ignore_scripts: "true",
  };
  if (siteUrl) env.SITE_URL = siteUrl;
  return env;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** main 側の .lighthouse/ の新しい結果（JSON）だけを、作業ツリー側の .lighthouse/ に写す。写した件数を返す。 */
async function copyResults(source: string, destination: string, since: number): Promise<number> {
  let names: string[];
  try {
    names = await readdir(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }

  // 書き込み先が（エージェントの作った）シンボリックリンクで外を指していないこと
  await mkdir(destination, { recursive: true });
  if ((await lstat(destination)).isSymbolicLink()) throw new Error("書き込み先がシンボリックリンク");
  const destinationReal = await realpath(destination);

  let copied = 0;
  for (const name of names) {
    if (!RESULT_FILE.test(name)) continue;
    const from = join(source, name);
    const info = await lstat(from);
    // シンボリックリンクはたどらない。通常のファイルで、今回の実行で更新されたものだけ
    if (!info.isFile() || info.size > MAX_RESULT_BYTES) continue;
    if (name !== "manifest.json" && info.mtimeMs < since) continue;
    const to = join(destinationReal, name);
    if (!to.startsWith(destinationReal + sep)) continue;
    try {
      if ((await lstat(to)).isSymbolicLink()) continue; // 既存の同名がシンボリックリンクなら触らない
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await copyFile(from, to);
    copied++;
  }
  return copied;
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

  // HOME: CONTROL_AGENT_HOME があればそれ、無ければ使い捨ての一時ディレクトリ（実ホームは渡さない）
  const temporaryHome = config.agentHome ? null : await mkdtemp(join(tmpdir(), "comegin-lighthouse-"));
  const home = config.agentHome ?? temporaryHome!;
  const startedAt = Date.now();

  const child = spawn("pnpm", ["lh"], {
    cwd,
    env: lighthouseEnv(home, config.siteUrl),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-400);
  });

  let timedOut = false;
  const kill = () => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutSec * 1000);
  signal.addEventListener("abort", kill, { once: true });

  const code = await new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(-1));
    child.once("close", (exitCode) => resolve(exitCode));
  });
  clearTimeout(timer);
  signal.removeEventListener("abort", kill);
  if (temporaryHome) await rm(temporaryHome, { recursive: true, force: true }).catch(() => undefined);

  if (code !== 0) {
    logLine("WARN", "lighthouse", `pnpm lh が失敗: code=${code} stderr(末尾)=${stderrTail}`, runId);
    return {
      outcome: "failure",
      summary: timedOut ? "Lighthouse CI がタイムアウトした" : `Lighthouse CI が終了コード ${code} で失敗した`,
      targetIds: [],
      failureClass: timedOut || signal.aborted ? "timeout" : code === -1 ? "unreachable" : "invalid_response",
    };
  }

  // 結果を作業ツリー側へ写す（seo-auditor は作業ツリーの中しか読めない）
  const copied = await copyResults(
    join(cwd, RESULT_DIR),
    join(config.worktree, VERDANT_VIRGO_DIR, RESULT_DIR),
    startedAt,
  );
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
