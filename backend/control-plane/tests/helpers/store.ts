// store/・definitions/ のテストの共有部品（基盤側の担当）。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../../src/store/migrations.js";

/** マイグレーション済みの :memory: の E-15。 */
export function memoryE15(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  return db;
}

/** os.tmpdir() の下に一時ディレクトリを作る。cleanup で消す。 */
export function makeTempDir(prefix = "cp-test-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** root からの相対パスにファイルを置く（途中のディレクトリも作る）。 */
export function putFile(root: string, relativePath: string, content: string): string {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  return file;
}

/** リポジトリのルート（実在の定義を読むテスト用）。.claude/agents が見つからなければ null。 */
export function repositoryRoot(): string | null {
  const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
  return existsSync(join(root, ".claude/agents")) ? root : null;
}
