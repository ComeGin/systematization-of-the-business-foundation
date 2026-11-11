// lib/runner.mjs の「!」の確認（2026-11-10）の単体テスト。ctx.confirm で yes が入力されなかったときの止まり方と、
// 設定ファイルの権限の確認を確かめる。runner-json.test.mjs と同じく、偽のモジュールを呼ぶ偽の親スクリプトを node の子プロセスで起動する
// （親スクリプトは import すると main() が動き、process.exit で終わる CLI のため。テスト対象が起こす子プロセスではないので node:child_process はモックしない）。
// 子プロセスの標準入力は端末ではない（ignore）ので、ctx.confirm は聞かずに止まる。yes で進む側は tests/lib/core.test.mjs で入力を差し替えて確かめる。
// 実際のコンテナ・AWS・HTTP には触れない。HOME は一時ディレクトリにする。
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, removeTempDir } from "./helpers/temp-home.mjs";

const SETUP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(SETUP_DIR, "..");
const RUNNER_URL = pathToFileURL(join(SETUP_DIR, "lib/runner.mjs")).href;

let home;
let work;

beforeEach(() => {
  home = makeTempDir();
  work = makeTempDir("comegin-setup-confirm-");
  mkdirSync(join(home, ".config/comegin/setup"), { recursive: true });
});

afterEach(() => {
  removeTempDir(home);
  removeTempDir(work);
});

/** 偽のモジュールを書く（dev・prod の両方で動く。prod の段階は env）。applyBody は apply の本体（文字列） */
function fakeModule(id, applyBody) {
  const file = join(work, `${id}.mjs`);
  writeFileSync(
    file,
    `export const meta = { id: ${JSON.stringify(id)}, title: ${JSON.stringify(`偽 ${id}`)}, targets: ["dev", "prod"], phases: ["env"] };
export async function check() { return { ok: true, notes: [] }; }
export async function apply(ctx) { ${applyBody} }
`,
  );
  return file;
}

/** 偽のモジュールを呼ぶ親スクリプト（lib/runner.mjs の runSetup を呼ぶだけ）を書く */
function fakeParent(moduleFiles) {
  const entry = join(work, "entry.mjs");
  const rels = moduleFiles.map((f) => relative(REPO, f));
  writeFileSync(entry, `import { runSetup } from ${JSON.stringify(RUNNER_URL)};\nrunSetup({ title: "偽の親", script: "setup/setup.mjs", modules: ${JSON.stringify(rels)} });\n`);
  return entry;
}

function runNode(script, args) {
  return new Promise((done, fail) => {
    const env = { ...process.env, HOME: home };
    delete env.SETUP_WORKTREE;
    const child = spawn(process.execPath, [script, ...args], { cwd: SETUP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

/** 設定ファイルを書く（mode で権限を明示する。umask に左右されないように chmod もする） */
function writeConf(target, text, mode) {
  const file = join(home, ".config/comegin/setup", `${target}.conf`);
  writeFileSync(file, text);
  chmodSync(file, mode);
  return file;
}

describe("ctx.confirm（apply の「!」）", () => {
  describe("正常系", () => {
    it("ctx.warn（削除の注意）だけのモジュールは止まらずに進み、0 で終わる", async () => {
      const a = fakeModule("warn-only", `ctx.warn("prod.conf に古い値が残っている（削除の注意。止めずに進む）");`);
      const b = fakeModule("after", `ctx.log("後ろのモジュールが動いた");`);
      const r = await runNode(fakeParent([a, b]), ["--target", "dev"]);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("[warn-only] ! prod.conf に古い値が残っている");
      expect(r.stdout).toContain("後ろのモジュールが動いた");
      expect(r.stdout).toContain("すべて終わった");
    });

    it("空入力: 手順の無い ctx.confirm でも、題名だけを出して止まる", async () => {
      const a = fakeModule("no-steps", `await ctx.confirm("x", "題名だけ");`);
      const r = await runNode(fakeParent([a]), ["--target", "dev"]);
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("[no-steps] ! 題名だけ");
      expect(r.stdout).toContain("確認が必要（yes が入力されなかったので止めた）: 題名だけ（no-steps:x）");
    });
  });

  describe("異常系", () => {
    it("入力: 端末でない（yes を入力できない）と、題名と番号付きの手順を出して 3 で止まり、後ろのモジュールを動かさない", async () => {
      const a = fakeModule("asks", `ctx.log("前半"); await ctx.confirm("sns", "SNS を購読していない", ["購読する", "確かめる"]); ctx.log("確認の後ろ");`);
      const b = fakeModule("after", `ctx.log("後ろのモジュールが動いた");`);
      const r = await runNode(fakeParent([a, b]), ["--target", "dev"]);
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("[asks] ! SNS を購読していない");
      expect(r.stderr).toContain("[asks]     1. 購読する");
      expect(r.stderr).toContain("[asks]     2. 確かめる");
      expect(r.stdout).toContain("前半");
      expect(r.stdout).toContain("確認が必要（yes が入力されなかったので止めた）: SNS を購読していない（asks:sns）");
      expect(r.stdout).toContain("node setup/setup.mjs --target dev");
      expect(r.stdout).not.toContain("確認の後ろ");
      expect(r.stdout).not.toContain("後ろのモジュールが動いた");
      expect(r.stdout).not.toContain("画面での操作が必要");
      expect(r.stdout).not.toContain("✗");
    });

    it("入力: --only・--phase を付けて実行したなら、再実行の案内にもそのまま付ける", async () => {
      const a = fakeModule("asks", `await ctx.confirm("x", "題名", ["手順"]);`);
      const r = await runNode(fakeParent([a]), ["--target", "prod", "--phase", "env", "--only", "asks"]);
      expect(r.code).toBe(3);
      expect(r.stdout).toContain("node setup/setup.mjs --target prod --phase env --only asks");
    });

    it("入力: --check では apply を呼ばないので、ctx.confirm で止まらない（0 で終わる）", async () => {
      const a = fakeModule("asks", `await ctx.confirm("x", "題名", ["手順"]);`);
      const r = await runNode(fakeParent([a]), ["--target", "dev", "--check"]);
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain("確認が必要");
    });

    it("サーバ: ctx.confirm の題名に状態の秘密値が入っても、止まったときの表示では伏せる", async () => {
      writeFileSync(join(home, ".config/comegin/setup/dev.state.json"), JSON.stringify({ values: { T: "secret-token-0123456789" }, secrets: ["T"] }));
      const a = fakeModule("asks", `await ctx.confirm("x", "トークン " + ctx.state.get("T") + " が古い", ["手順 " + ctx.state.get("T")]);`);
      const r = await runNode(fakeParent([a]), ["--target", "dev"]);
      expect(r.code).toBe(3);
      expect(r.stdout + r.stderr).not.toContain("secret-token-0123456789");
      expect(r.stdout).toContain("トークン [伏せ字] が古い");
    });
  });
});

describe("設定ファイルの権限（ほかのユーザーも読める）", () => {
  describe("正常系", () => {
    it("600 の設定ファイルなら聞かずに進む", async () => {
      writeConf("dev", "ADMIN_EMAIL=a@example.com\n", 0o600);
      const a = fakeModule("m", `ctx.log("モジュールが動いた");`);
      const r = await runNode(fakeParent([a]), ["--target", "dev"]);
      expect(r.code).toBe(0);
      expect(r.stderr).not.toContain("ほかのユーザーも読める");
      expect(r.stdout).toContain("モジュールが動いた");
    });

    it("入力: --list では「!」を出すだけで、聞かずに 0 で終わる", async () => {
      writeConf("dev", "ADMIN_EMAIL=a@example.com\n", 0o644);
      const a = fakeModule("m", "");
      const r = await runNode(fakeParent([a]), ["--target", "dev", "--list"]);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("ほかのユーザーも読める");
      expect(r.stdout).not.toContain("確認が必要");
    });

    it("入力: --check --json では「!」を標準エラーに出すだけで、標準出力の JSON は崩れない", async () => {
      writeConf("dev", "ADMIN_EMAIL=a@example.com\n", 0o644);
      const a = fakeModule("m", "");
      const r = await runNode(fakeParent([a]), ["--target", "dev", "--check", "--json"]);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("ほかのユーザーも読める");
      expect(JSON.parse(r.stdout.trimEnd().split("\n").at(-1)).results).toHaveLength(1);
    });
  });

  describe("異常系", () => {
    it("入力: apply で設定ファイルがほかのユーザーも読めると、chmod の手順を出して 3 で止まり、モジュールを動かさない（値は出さない）", async () => {
      const file = writeConf("dev", "SOME_TOKEN=very-secret-value-123\n", 0o644);
      const a = fakeModule("m", `ctx.log("モジュールが動いた");`);
      const r = await runNode(fakeParent([a]), ["--target", "dev"]);
      expect(r.code).toBe(3);
      expect(r.stderr).toContain(`! ${file} はほかのユーザーも読める`);
      expect(r.stderr).toContain(`chmod 600 ${file}`);
      expect(r.stdout).toContain("確認が必要（yes が入力されなかったので止めた）");
      expect(r.stdout).not.toContain("モジュールが動いた");
      expect(r.stdout + r.stderr).not.toContain("very-secret-value-123");
    });
  });
});
