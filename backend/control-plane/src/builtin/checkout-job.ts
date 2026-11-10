// main のチェックアウトで pnpm のスクリプトを動かす builtin（lighthouse・a11y）の共通部品。
// 子プロセスを起動するのは、control-plane ではここ 1 か所だけ。
//
// 安全のための設計（セキュリティレビュー HIGH への対応）:
//   - 実行元は CONTROL_MAIN_CHECKOUT（承認済み main）。作業ツリーはエージェントが書ける場所で、そこの
//     package.json の script や設定ファイル・.npmrc を実行すると、control-plane の権限で任意のコードが動く。
//   - `pnpm install` は人が main のチェックアウトで済ませておく前提。node_modules が無ければ実行せず skipped にする（各 builtin）。
//   - 子プロセスの HOME は実ホームにしない（~/.aws などに届かせない）。CONTROL_AGENT_HOME、無ければ使い捨ての一時ディレクトリ。
//   - env は許可リスト（childEnv）。各 builtin が足すのも、秘密値でない決まった変数だけ。
//   - 結果の JSON を作業ツリー側に写すのは control-plane。観測エージェントは作業ツリーの中しか読めない。
//     写すのは決まった名前の JSON ファイルだけで、シンボリックリンクはたどらない。
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { RunResult } from "../context.js";
import { logLine } from "../log.js";
import type { LeaseStore } from "../store/leases.js";

const MAX_RESULT_BYTES = 25 * 1024 * 1024;
const STDERR_TAIL_CHARS = 400;

/**
 * main のチェックアウトで build する builtin（lighthouse・a11y・published-article-check）が共有するリースのキー。
 * どれも同じ dist/ と .lighthouse/・.a11y/ を作り直すので、同時に動かさない（別の build が dist/ を差し替えると、測った結果と配る dist がずれる）。
 */
export const CHECKOUT_BUILD_LEASE = "checkout-build";
const LEASE_GRACE_MS = 60_000;

/**
 * 共有のリースを取ってから fn を動かし、終わったら（失敗しても）手放す。取れなければ（別の build が動いている）fn を動かさず skipped を返す。
 * ttl は timeoutSec + 60 秒。持ち主のプロセスが死んでいれば奪える（LeaseStore）。
 */
export async function withCheckoutBuildLease(
  leases: LeaseStore,
  runId: string,
  timeoutSec: number,
  fn: () => Promise<RunResult>,
): Promise<RunResult> {
  if (!leases.acquire(CHECKOUT_BUILD_LEASE, runId, timeoutSec * 1000 + LEASE_GRACE_MS)) {
    const reason = "main のチェックアウトで別のビルドが動いている";
    return { outcome: "skipped", summary: reason, targetIds: [], skipReason: reason };
  }
  try {
    return await fn();
  } finally {
    leases.release(CHECKOUT_BUILD_LEASE, runId);
  }
}

/** 子プロセスの env の土台。許可リスト。 */
export function childEnv(home: string, siteUrl: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    // 万一 pnpm が依存の解決に入っても、ライフサイクルスクリプトを動かさない
    npm_config_ignore_scripts: "true",
  };
  if (siteUrl) env.SITE_URL = siteUrl;
  return env;
}

/**
 * 配信用のビルド（published-article-check の `pnpm lh`）の子プロセスの env。childEnv に、記事を読む Strapi の接続先とコミットを足す。
 * 足すのは決まった 4 つだけ。STRAPI_API_TOKEN は読み取り専用の API トークン（書き込みトークンは渡さない）。
 * BUILD_TARGET=production は、STRAPI_URL が開発の Strapi を指していたらビルドを止める歯止め（blog の integration）を効かせる。
 */
export function buildEnv(
  home: string,
  input: { siteUrl: string; strapiUrl: string; strapiReadToken: string; commitSha: string },
): NodeJS.ProcessEnv {
  return {
    ...childEnv(home, input.siteUrl),
    STRAPI_URL: input.strapiUrl,
    STRAPI_API_TOKEN: input.strapiReadToken,
    BUILD_COMMIT_SHA: input.commitSha,
    BUILD_TARGET: "production",
  };
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** HOME: CONTROL_AGENT_HOME があればそれ、無ければ使い捨ての一時ディレクトリ（実ホームは渡さない）。終わったら一時ディレクトリを消す。 */
export async function withChildHome<T>(agentHome: string | null, prefix: string, fn: (home: string) => Promise<T>): Promise<T> {
  const temporaryHome = agentHome ? null : await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(agentHome ?? temporaryHome!);
  } finally {
    if (temporaryHome) await rm(temporaryHome, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface PnpmScriptRun {
  /** 終了コード。シグナルで終わったら null、起動できなければ -1 */
  code: number | null;
  timedOut: boolean;
  /** stderr の末尾（ログ用。E-15 の summary には入れない） */
  stderrTail: string;
}

/** `pnpm <script>` を起動し、終わるまで待つ。timeout と停止要求では SIGTERM、5 秒後に SIGKILL。 */
export async function runPnpmScript(options: {
  cwd: string;
  script: string;
  env: NodeJS.ProcessEnv;
  timeoutSec: number;
  signal: AbortSignal;
}): Promise<PnpmScriptRun> {
  const child = spawn("pnpm", [options.script], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
  });

  let timedOut = false;
  const kill = () => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, options.timeoutSec * 1000);
  options.signal.addEventListener("abort", kill, { once: true });

  const code = await new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(-1));
    child.once("close", (exitCode) => resolve(exitCode));
  });
  clearTimeout(timer);
  options.signal.removeEventListener("abort", kill);
  return { code, timedOut, stderrTail };
}

/** 失敗した子プロセスのログ。stderr は末尾だけを出す。 */
export function logChildFailure(tag: string, script: string, run: PnpmScriptRun, runId: string): void {
  logLine("WARN", tag, `pnpm ${script} が失敗: code=${run.code} stderr(末尾)=${run.stderrTail}`, runId);
}

export interface CopyRule {
  /** 写してよいファイル名 */
  accept: RegExp;
  /** 今回の実行より古くても写すファイル名（Lighthouse の manifest.json など） */
  alwaysFresh?: (name: string) => boolean;
}

/** main 側の結果のディレクトリから、今回の実行で更新された JSON だけを作業ツリー側へ写す。写した件数を返す。 */
export async function copyResults(source: string, destination: string, since: number, rule: CopyRule): Promise<number> {
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
    if (!rule.accept.test(name)) continue;
    const from = join(source, name);
    const info = await lstat(from);
    // シンボリックリンクはたどらない。通常のファイルで、今回の実行で更新されたものだけ
    if (!info.isFile() || info.size > MAX_RESULT_BYTES) continue;
    if (!rule.alwaysFresh?.(name) && info.mtimeMs < since) continue;
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

/** 結果のファイルが、今回の実行で更新された通常のファイル（シンボリックリンクでない・上限以内）か。 */
export async function isFreshResultFile(path: string, since: number): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && info.size <= MAX_RESULT_BYTES && info.mtimeMs >= since;
  } catch {
    return false;
  }
}
