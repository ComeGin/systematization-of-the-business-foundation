// サーバ側の障害（Valkey・PostgreSQL が応答しない）を、開発スタックのコンテナを一時停止して起こす。
// docker pause は SIGSTOP 相当で、接続は張られたまま応答だけが止まる（タイムアウトの経路を通る）。
// 必ず withPaused の中で使い、テストが失敗しても unpause まで戻す。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await run("docker", args, { timeout: 30_000 });
  return stdout.trim();
}

/** コンテナの状態（running・paused・exited など）。無ければ undefined */
export async function containerState(name: string): Promise<string | undefined> {
  try {
    return await docker("inspect", "-f", "{{.State.Status}}", name);
  } catch {
    return undefined;
  }
}

/** 一時停止して fn を実行し、成否にかかわらず再開する。始める前から running でなければ失敗にする（壊れた状態の上で試さない） */
export async function withPaused<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const before = await containerState(name);
  if (before !== "running") throw new Error(`${name} が running ではない（${before ?? "存在しない"}）`);
  await docker("pause", name);
  try {
    return await fn();
  } finally {
    await docker("unpause", name);
  }
}

/** コンテナの中でコマンドを実行する（host-relay の到達性の確認に使う）。終了コードが 0 以外なら例外 */
export async function execIn(name: string, command: string[]): Promise<string> {
  return docker("exec", name, ...command);
}
