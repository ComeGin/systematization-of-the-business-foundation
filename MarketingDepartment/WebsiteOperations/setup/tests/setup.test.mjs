// setup.mjs を子プロセスで起動し、何も用意しない引数（--help・--list・--show・不正な引数）での終了コードと出力を確かめる。
// HOME は必ず一時ディレクトリにする。--check や apply を伴う起動はしない。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir, removeTempDir } from "./helpers/temp-home.mjs";

const SETUP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(SETUP_DIR, "setup.mjs");

let home;
// 子プロセスの node の起動は環境によって 1 秒近くかかるので、既定の 5 秒より長く待つ
vi.setConfig({ testTimeout: 20_000 });

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

describe("不正な引数", () => {
  it("知らない引数は、その引数を示して 1 で終わる", async () => {
    const r = await runSetup(["--target", "dev", "--bogus"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("不明な引数: --bogus");
  });

  it("--target が無いと 1 で終わる", async () => {
    const r = await runSetup([]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--target dev か --target prod を指定する");
  });

  it("--target が dev・prod 以外だと 1 で終わる", async () => {
    const r = await runSetup(["--target", "staging"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--target dev か --target prod を指定する");
  });

  it("--from に無い id を渡すと、どのモジュールも実行せずに 1 で終わる", async () => {
    const r = await runSetup(["--target", "dev", "--from", "no-such-module"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--from の no-such-module が見つからない");
    expect(r.stdout).not.toContain("■");
  });
});

describe("--list", () => {
  it("全モジュールを順番に並べ、target で動かないものに × を付けて 0 で終わる", async () => {
    const r = await runSetup(["--target", "dev", "--list"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(moduleCount());
    expect(lines[0]).toMatch(/^ {2}○ {2}host-relay\s/);
    expect(lines.at(-1)).toMatch(/^ {2}× {2}onprem\s.*（dev では動かない）$/);
    expect(r.stdout).not.toContain("未実装");
  });

  it("prod では dev だけのモジュールに × が付く", async () => {
    const r = await runSetup(["--target", "prod", "--list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/× {2}chatwoot\s.*（prod では動かない）/);
    expect(r.stdout).toMatch(/○ {2}admin-auth\s/);
    expect(r.stdout).toMatch(/○ {2}onprem\s/);
  });
});

describe("--show", () => {
  const writeState = (data) => {
    const dir = join(home, ".config/comegin/setup");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "dev.state.json"), JSON.stringify(data), { mode: 0o600 });
  };

  it("状態ファイルの値を 1 つだけ、伏せずに表示する（秘密値でも）", async () => {
    writeState({ values: { N8N_OWNER_PASSWORD: "owner-password-1", OTHER: "x" }, secrets: ["N8N_OWNER_PASSWORD"] });
    const r = await runSetup(["--target", "dev", "--show", "N8N_OWNER_PASSWORD"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("owner-password-1\n");
  });

  it("無いキーは、状態ファイルの場所を添えて 1 で終わる", async () => {
    const r = await runSetup(["--target", "dev", "--show", "MISSING"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("MISSING は状態ファイルに無い");
    expect(r.stderr).toContain(join(home, ".config/comegin/setup/dev.state.json"));
  });
});
