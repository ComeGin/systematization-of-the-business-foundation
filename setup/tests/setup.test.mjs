// setup.mjs を子プロセスで起動し、何も用意しない引数（--help・--list・--show・不正な引数）での終了コードと出力を確かめる。
// HOME は必ず一時ディレクトリにする。--check や apply を伴う起動はしない（--check は開発環境の 127.0.0.1 のサービスに届くため）。
// ここで子プロセスを使うのは、テストする側の都合（setup.mjs は import すると main() が動き、process.exit で終わる CLI のため）。
// テスト対象のコードが起こす子プロセス（docker など）ではない。基準 D の例外として、node:child_process をモックしない。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, removeTempDir } from "./helpers/temp-home.mjs";

const SETUP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(SETUP_DIR, "setup.mjs");

let home;
// 子プロセスの node の起動は環境によって 1 秒近くかかるので、vitest.config.mjs の testTimeout（30 秒）で待つ

beforeEach(() => {
  home = makeTempDir();
});

afterEach(() => {
  removeTempDir(home);
});

function runSetup(args) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: SETUP_DIR,
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

function moduleCount() {
  const src = readFileSync(SCRIPT, "utf8");
  const block = src.match(/const MODULES = \[([\s\S]*?)\];/)[1];
  return [...block.matchAll(/"([^"]+)"/g)].length;
}

describe("--help", () => {
  describe("正常系", () => {
    it("使い方を表示して 0 で終わる。--target が無くてもよい", async () => {
      const r = await runSetup(["--help"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("使い方:");
      expect(r.stdout).toContain("--target");
      expect(r.stderr).toBe("");
    });

    it("-h でも同じ", async () => {
      const r = await runSetup(["-h"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("使い方:");
    });

    it("ホームディレクトリに何も作らない", async () => {
      await runSetup(["--help"]);
      expect(existsSync(join(home, ".config"))).toBe(false);
    });
  });
});

describe("不正な引数", () => {
  describe("異常系", () => {
    it("入力: 知らない引数は、その引数を示して 1 で終わる", async () => {
      const r = await runSetup(["--target", "dev", "--bogus"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("不明な引数: --bogus");
    });

    it("空入力: --target が無いと 1 で終わる", async () => {
      const r = await runSetup([]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--target dev か --target prod を指定する");
    });

    it("空入力: --target の値が無い（最後の引数が --target）と 1 で終わる", async () => {
      const r = await runSetup(["--target"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--target dev か --target prod を指定する");
    });

    it("入力: --target が dev・prod 以外だと 1 で終わる", async () => {
      const r = await runSetup(["--target", "staging"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--target dev か --target prod を指定する");
    });

    it("入力: --from に無い id を渡すと、どのモジュールも実行せずに 1 で終わる", async () => {
      const r = await runSetup(["--target", "dev", "--from", "no-such-module"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--from の no-such-module が見つからない");
      expect(r.stdout).not.toContain("■");
    });

    // 以下の --only・--show・--from・--config の検査が壊れていると、モジュールの apply（docker compose up など）が走る。
    // 万一に備えて、検査が壊れていても止まるように、--only か --from に無い id を添えて起動する（その場合は文言の検査で落ちる）
    it("入力: --only に無い id を渡すと、どのモジュールも実行せずに、見つからない id を示して 1 で終わる", async () => {
      const r = await runSetup(["--target", "dev", "--only", "n8n,no-such-module", "--from", "no-such-module"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--only の no-such-module が見つからない");
      expect(r.stdout).not.toContain("■");
      expect(r.stdout).not.toContain("すべて終わった");
    });

    it("入力: --only にこの target では動かない id（dev の onprem）を渡しても、見つからないとして 1 で終わる", async () => {
      const r = await runSetup(["--target", "dev", "--only", "onprem", "--from", "no-such-module"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--only の onprem が見つからない");
      expect(r.stdout).not.toContain("■");
    });

    it("空入力: --show の後にキーが無い（--target dev --show）と、何も用意せずに 1 で終わる", async () => {
      const r = await runSetup(["--target", "dev", "--only", "no-such-module", "--show"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--show の後に値が要る");
      expect(r.stdout).toBe("");
    });

    it("空入力: --show の値が空文字・空白だけでも、何も用意せずに 1 で終わる", async () => {
      for (const empty of ["", "  "]) {
        const r = await runSetup(["--target", "dev", "--only", "no-such-module", "--show", empty]);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("--show の後に値が要る");
        expect(r.stdout).toBe("");
      }
    });

    it("入力: --show の値の代わりに次のオプションが来ても（--show --check）、それをキーとみなさずに 1 で終わる", async () => {
      const r = await runSetup(["--target", "dev", "--only", "no-such-module", "--show", "--check"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--show の後に値が要る");
    });

    it("空入力: --only・--from・--config の値が無い・空文字なら、何も用意せずに 1 で終わる", async () => {
      const cases = [
        [["--from", "no-such-module", "--only"], "--only の後に値が要る"],
        [["--from", "no-such-module", "--only", ""], "--only の後に値が要る"],
        [["--only", "no-such-module", "--from"], "--from の後に値が要る"],
        [["--only", "no-such-module", "--from", ""], "--from の後に値が要る"],
        [["--only", "no-such-module", "--config"], "--config の後に値が要る"],
        [["--only", "no-such-module", "--config", "", "--check"], "--config の後に値が要る"],
      ];
      for (const [args, message] of cases) {
        const r = await runSetup(["--target", "dev", ...args]);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain(message);
        expect(r.stdout).toBe("");
      }
    });

    it("入力: --config に存在しないファイルを明示すると、空の設定で進まずに 1 で終わる", async () => {
      const r = await runSetup(["--target", "dev", "--only", "no-such-module", "--config", "/nonexistent/comegin/dev.conf"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--config の /nonexistent/comegin/dev.conf が無い");
      expect(r.stdout).not.toContain("■");
    });

    it("入力: --only の id に空のもの（n8n,,strapi）があれば 1 で終わる", async () => {
      const r = await runSetup(["--target", "dev", "--from", "no-such-module", "--only", "n8n,,strapi"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--only の id に空のものがある");
      expect(r.stdout).toBe("");
    });
  });
});

describe("--list", () => {
  describe("正常系", () => {
    it("全モジュールを順番に並べ、target で動かないものに × を付けて 0 で終わる", async () => {
      const r = await runSetup(["--target", "dev", "--list"]);
      expect(r.code).toBe(0);
      const lines = r.stdout.trimEnd().split("\n");
      expect(lines).toHaveLength(moduleCount());
      expect(lines[0]).toMatch(/^ {2}○ {2}host-relay\s/);
      expect(lines.at(-1)).toMatch(/^ {2}× {2}mcp-prod\s.*（dev では動かない）$/);
      expect(r.stdout).not.toContain("未実装");
    });

    it("prod では dev だけのモジュールに × が付く", async () => {
      const r = await runSetup(["--target", "prod", "--list"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/× {2}chatwoot\s.*（prod では動かない）/);
      expect(r.stdout).toMatch(/○ {2}admin-auth\s/);
      expect(r.stdout).toMatch(/○ {2}onprem\s/);
    });

    it("Umami（ADR-25 で廃止）は並ばず、GA4 と OpenSEO が mautic の後・strapi の前に並ぶ", async () => {
      const r = await runSetup(["--target", "dev", "--list"]);
      const ids = r.stdout.trimEnd().split("\n").map((l) => l.trim().split(/\s+/)[1]);
      expect(ids).not.toContain("umami");
      expect(ids.slice(ids.indexOf("mautic"), ids.indexOf("strapi") + 1)).toEqual(["mautic", "ga4", "openseo", "strapi"]);
    });
  });
});

describe("--show", () => {
  const writeState = (data) => {
    const dir = join(home, ".config/comegin/setup");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "dev.state.json"), JSON.stringify(data), { mode: 0o600 });
  };

  describe("正常系", () => {
    it("状態ファイルの値を 1 つだけ、伏せずに表示する（秘密値でも）", async () => {
      writeState({ values: { N8N_OWNER_PASSWORD: "owner-password-1", OTHER: "x" }, secrets: ["N8N_OWNER_PASSWORD"] });
      const r = await runSetup(["--target", "dev", "--show", "N8N_OWNER_PASSWORD"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("owner-password-1\n");
    });
  });

  describe("異常系", () => {
    it("入力: 無いキーは、状態ファイルの場所を添えて 1 で終わる", async () => {
      const r = await runSetup(["--target", "dev", "--show", "MISSING"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("MISSING は状態ファイルに無い");
      expect(r.stderr).toContain(join(home, ".config/comegin/setup/dev.state.json"));
    });

    it("空入力: 値が空文字のキーは「無い」とみなして 1 で終わる", async () => {
      writeState({ values: { EMPTY: "" }, secrets: [] });
      const r = await runSetup(["--target", "dev", "--show", "EMPTY"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("EMPTY は状態ファイルに無い");
    });

    it("入力: 状態ファイルが JSON でなければ 1 で終わり、中身を表示しない", async () => {
      const dir = join(home, ".config/comegin/setup");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "dev.state.json"), "{ broken secret-in-file-xyz", { mode: 0o600 });
      const r = await runSetup(["--target", "dev", "--show", "ANY"]);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).not.toContain("secret-in-file-xyz");
    });
  });
});
