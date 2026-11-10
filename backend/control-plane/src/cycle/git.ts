// control-plane が作業場・main のチェックアウトで git を起動するときの共通の形（Ruling 20）。
// - シェルを通さない（execFile）。env は最小（PATH・HOME と GIT_TERMINAL_PROMPT=0）で、監視アプリの秘密値を渡さない
// - `-c core.hooksPath=/dev/null` でリポジトリのフックを動かさない（作業場はエージェントが書ける場所）
// - builtin の AbortSignal を渡し、停止要求で子プロセスを止める
// - stderr（リモートの URL を含みうる）は返さない・ログに出さない
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitResult {
  ok: boolean;
  stdout: string;
}

export async function runGit(
  cwd: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal; maxBuffer?: number },
): Promise<GitResult> {
  try {
    const { stdout } = await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], {
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
      signal: options.signal,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}
