// HOME を一時ディレクトリに向けてから lib/core.mjs を読み直す。
// core.mjs は import 時に homedir() から CONFIG_DIR を決めるので、必ずこの順（stubEnv → resetModules → import）で読む。
// 実際の ~/.config/comegin には絶対に書かない。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

export function makeTempDir(prefix = "comegin-setup-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeTempDir(dir) {
  if (dir && dir.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true });
}

/** HOME を一時ディレクトリにして core.mjs を新しく読み込む。秘密値の登録（モジュール内の Set）も空から始まる */
export async function importCoreWithTempHome() {
  const home = makeTempDir();
  vi.stubEnv("HOME", home);
  vi.resetModules();
  const core = await import("../../lib/core.mjs");
  if (!core.CONFIG_DIR.startsWith(home)) throw new Error(`CONFIG_DIR が一時ディレクトリを向いていない: ${core.CONFIG_DIR}`);
  return { home, core };
}
