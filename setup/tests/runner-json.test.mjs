// lib/runner.mjs の機械が読める check（--check --json・--phase all・--skip）の単体テスト。
// 親スクリプトは import すると main() が動き、process.exit で終わる CLI のため、setup.test.mjs と同じく node の子プロセスで起動して
// 終了コードと標準出力・標準エラーを確かめる（テスト対象が起こす子プロセスではないので node:child_process はモックしない）。
// モジュールは一時ディレクトリに置いた偽物（実際のコンテナ・AWS・HTTP には触れない）。HOME も一時ディレクトリにする。
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, removeTempDir } from "./helpers/temp-home.mjs";

const SETUP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(SETUP_DIR, "..");
const REAL_SCRIPT = join(SETUP_DIR, "setup.mjs");
const RUNNER_URL = pathToFileURL(join(SETUP_DIR, "lib/runner.mjs")).href;
// 状態ファイルに置いておく秘密値（出力に出てはいけない）
const SECRET = "tok-very-secret-value-0123456789";

let home;
let work;

beforeEach(() => {
  home = makeTempDir();
  work = makeTempDir("comegin-setup-json-");
  mkdirSync(join(home, ".config/comegin/setup"), { recursive: true });
  writeFileSync(join(home, ".config/comegin/setup/prod.state.json"), JSON.stringify({ values: { TOKEN_X: SECRET }, secrets: ["TOKEN_X"] }));
});

afterEach(() => {
  removeTempDir(home);
  removeTempDir(work);
});

const STATE_FILE = () => join(home, ".config/comegin/setup/prod.state.json");

/** 偽のモジュールを書く。meta の phases と check の本体（文字列）を指定する */
function fakeModule(id, phases, checkBody) {
  const file = join(work, `${id}.mjs`);
  writeFileSync(
    file,
    `export const meta = { id: ${JSON.stringify(id)}, title: ${JSON.stringify(`偽 ${id}`)}, targets: ["prod"], phases: ${JSON.stringify(phases)} };
export async function check(ctx) { ${checkBody} }
export async function apply() {}
`,
  );
  return file;
}

/** 偽のモジュールを呼ぶ親スクリプト（lib/runner.mjs の runSetup を呼ぶだけ）を書く。モジュールのパスは W（リポジトリのルート）からの相対 */
function fakeParent(moduleFiles) {
  const entry = join(work, "entry.mjs");
  const rels = moduleFiles.map((f) => relative(REPO, f));
  writeFileSync(entry, `import { runSetup } from ${JSON.stringify(RUNNER_URL)};\nrunSetup({ title: "偽の親", script: "setup/setup.mjs", modules: ${JSON.stringify(rels)} });\n`);
  return entry;
}

function runNode(script, args, env = {}) {
  return new Promise((done, fail) => {
    const base = { ...process.env, HOME: home };
    delete base.SETUP_WORKTREE;
    const child = spawn(process.execPath, [script, ...args], { cwd: SETUP_DIR, env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

const lastLine = (text) => text.trimEnd().split("\n").at(-1);

describe("--check --json", () => {
  describe("正常系", () => {
    it("サーバ: stdout の最後の行だけが JSON で、人向けの表示とモジュールのログは stderr に出る", async () => {
      const mod = fakeModule("ok-mod", ["env"], `ctx.log("ctx のログ"); console.log("素の console.log"); return { ok: true, notes: ["メモ"] };`);
      const r = await runNode(fakeParent([mod]), ["--target", "prod", "--check", "--json"]);
      expect(r.code).toBe(0);
      // stdout は JSON の 1 行だけ
      expect(r.stdout.trimEnd().split("\n")).toHaveLength(1);
      const report = JSON.parse(lastLine(r.stdout));
      expect(report.version).toBe(1);
      expect(report.target).toBe("prod");
      expect(report.script).toBe("setup/setup.mjs");
      // 人向けの表示は stderr に回る
      expect(r.stderr).toContain("■ 偽 ok-mod");
      expect(r.stderr).toContain("✓ 用意できている");
      expect(r.stderr).toContain("ctx のログ");
      expect(r.stderr).toContain("素の console.log");
    });

    it("サーバ: 時刻は +09:00 の ISO 8601 で、finishedAt は startedAt 以降", async () => {
      const mod = fakeModule("ok-mod", ["env"], `return { ok: true, notes: [] };`);
      const r = await runNode(fakeParent([mod]), ["--target", "prod", "--check", "--json"]);
      const report = JSON.parse(lastLine(r.stdout));
      expect(report.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+09:00$/);
      expect(report.finishedAt).toMatch(/\+09:00$/);
      expect(Date.parse(report.finishedAt)).toBeGreaterThanOrEqual(Date.parse(report.startedAt));
    });

    it("入力: モジュールが items を返すと results に載り、返さなければ [] になる", async () => {
      const withItems = fakeModule("with-items", ["env"], `return { ok: true, notes: ["n"], items: [{ key: "x.y", step: "P1", level: "ok", title: "見出し", evidence: "根拠", stopId: "x:y" }] };`);
      const noItems = fakeModule("no-items", ["env"], `return { ok: false, notes: ["! 警告"] };`);
      const r = await runNode(fakeParent([withItems, noItems]), ["--target", "prod", "--check", "--json"]);
      const { results } = JSON.parse(lastLine(r.stdout));
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        moduleId: "with-items",
        phase: "env",
        ok: true,
        notes: ["n"],
        items: [{ key: "x.y", step: "P1", level: "ok", title: "見出し", evidence: "根拠", stopId: "x:y" }],
        error: null,
        skipped: false,
      });
      expect(results[1]).toMatchObject({ moduleId: "no-items", ok: false, notes: ["! 警告"], items: [], error: null, skipped: false });
    });

    it("入力: check の中の state.set は error に入り、状態ファイルは変わらず、ほかのモジュールは続く", async () => {
      const writer = fakeModule("writer", ["env"], `ctx.state.set("DB_INIT_X", "1"); return { ok: true, notes: [] };`);
      const after = fakeModule("after", ["env"], `return { ok: true, notes: ["続いた"] };`);
      const before = readFileSync(STATE_FILE(), "utf8");
      const r = await runNode(fakeParent([writer, after]), ["--target", "prod", "--check", "--json"]);
      expect(r.code).toBe(0);
      const { results } = JSON.parse(lastLine(r.stdout));
      expect(results[0]).toMatchObject({ moduleId: "writer", ok: false, error: "check の中で状態を書こうとした: DB_INIT_X" });
      expect(results[1]).toMatchObject({ moduleId: "after", ok: true, notes: ["続いた"], error: null });
      expect(readFileSync(STATE_FILE(), "utf8")).toBe(before);
    });

    it("入力: check が投げても終了コードは 0 で、error に message が入り、次へ進む", async () => {
      const bad = fakeModule("bad", ["env"], `throw new Error("AWS に届かない");`);
      const good = fakeModule("good", ["env"], `return { ok: true, notes: [] };`);
      const r = await runNode(fakeParent([bad, good]), ["--target", "prod", "--check", "--json"]);
      expect(r.code).toBe(0);
      const { results } = JSON.parse(lastLine(r.stdout));
      expect(results[0]).toMatchObject({ moduleId: "bad", ok: false, notes: [], items: [], error: "AWS に届かない" });
      expect(results[1]).toMatchObject({ moduleId: "good", ok: true });
    });

    it("入力: --skip したモジュールは check を呼ばず skipped: true で残り、ほかは確かめる", async () => {
      const skipped = fakeModule("skipped", ["env"], `throw new Error("呼ばれてはいけない");`);
      const kept = fakeModule("kept", ["env"], `return { ok: true, notes: [] };`);
      const r = await runNode(fakeParent([skipped, kept]), ["--target", "prod", "--check", "--json", "--skip", "skipped"]);
      expect(r.code).toBe(0);
      const { results } = JSON.parse(lastLine(r.stdout));
      expect(results[0]).toEqual({ moduleId: "skipped", phase: "env", ok: false, notes: [], items: [], error: null, skipped: true });
      expect(results[1]).toMatchObject({ moduleId: "kept", ok: true, skipped: false });
    });

    it("入力: --phase all は google・operate を含む全段階を確かめ、省略すると env〜apps だけ", async () => {
      const early = fakeModule("early", ["env"], `return { ok: true, notes: [] };`);
      const late = fakeModule("late", ["operate"], `return { ok: true, notes: [] };`);
      const parent = fakeParent([early, late]);
      const all = JSON.parse(lastLine((await runNode(parent, ["--target", "prod", "--check", "--json", "--phase", "all"])).stdout));
      expect(all.results.map((x) => `${x.moduleId}:${x.phase}`)).toEqual(["early:env", "late:operate"]);
      const dflt = JSON.parse(lastLine((await runNode(parent, ["--target", "prod", "--check", "--json"])).stdout));
      expect(dflt.results.map((x) => x.moduleId)).toEqual(["early"]);
    });

    it("入力: モジュールが返した notes・items・error に秘密値が混ざっても伏せ字になる", async () => {
      const leaky = fakeModule(
        "leaky",
        ["env"],
        `return { ok: false, notes: ["token=${SECRET}"], items: [{ key: "k", step: "P1", level: "warn", title: "t ${SECRET}", evidence: "e ${SECRET}" }] };`,
      );
      const thrower = fakeModule("thrower", ["env"], `throw new Error("失敗 ${SECRET}");`);
      const r = await runNode(fakeParent([leaky, thrower]), ["--target", "prod", "--check", "--json"]);
      expect(r.stdout).not.toContain(SECRET);
      expect(r.stderr).not.toContain(SECRET);
      const { results } = JSON.parse(lastLine(r.stdout));
      expect(results[0].notes[0]).toBe("token=[伏せ字]");
      expect(results[0].items[0]).toMatchObject({ title: "t [伏せ字]", evidence: "e [伏せ字]" });
      expect(results[1].error).toBe("失敗 [伏せ字]");
    });

    it("入力: ctx.checkOnly は true、ctx.WORKTREE は SETUP_WORKTREE があればそれ、無ければリポジトリのルート", async () => {
      const mod = fakeModule("ctx-mod", ["env"], `return { ok: true, notes: [String(ctx.checkOnly), ctx.WORKTREE, ctx.REPO] };`);
      const parent = fakeParent([mod]);
      const none = JSON.parse(lastLine((await runNode(parent, ["--target", "prod", "--check", "--json"])).stdout));
      expect(none.results[0].notes).toEqual(["true", REPO, REPO]);
      const other = makeTempDir("comegin-worktree-");
      try {
        const set = JSON.parse(lastLine((await runNode(parent, ["--target", "prod", "--check", "--json"], { SETUP_WORKTREE: other })).stdout));
        expect(set.results[0].notes).toEqual(["true", other, REPO]);
      } finally {
        removeTempDir(other);
      }
    });

    it("入力: --json なしの --check は今までと同じ人向けの表示で、標準出力に JSON を出さない", async () => {
      const mod = fakeModule("ok-mod", ["env"], `return { ok: true, notes: ["メモ"] };`);
      const writer = fakeModule("writer", ["env"], `ctx.state.set("K", "v"); return { ok: true, notes: [] };`);
      const r = await runNode(fakeParent([mod, writer]), ["--target", "prod", "--check"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("■ 偽 ok-mod（ok-mod）\n  ✓ 用意できている\n    - メモ");
      expect(r.stdout).toContain("? 確かめられない（check の中で状態を書こうとした: K）");
      expect(r.stdout).not.toContain('"version"');
    });
  });

  describe("異常系", () => {
    it("入力: --json を --check なしで渡すと 1 で終わり、何も実行しない", async () => {
      const r = await runNode(REAL_SCRIPT, ["--target", "prod", "--json"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--json は --check と一緒にだけ使う");
      expect(r.stdout).toBe("");
    });

    it("入力: --phase all を --check なしで渡すと 1 で終わる", async () => {
      const r = await runNode(REAL_SCRIPT, ["--target", "prod", "--phase", "all"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--phase all は --check と一緒にだけ使う");
    });

    it("入力: --phase all を dev に付けると 1 で終わる", async () => {
      const r = await runNode(REAL_SCRIPT, ["--target", "dev", "--check", "--phase", "all"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--phase は --target prod だけで使う");
    });

    it("入力: --json を --list と一緒に渡すと 1 で終わる", async () => {
      const r = await runNode(REAL_SCRIPT, ["--target", "prod", "--check", "--json", "--list"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--json は --list・--show と一緒に使えない");
    });

    it("入力: --skip に --list に無い id を渡すと、何も確かめずに 1 で終わる", async () => {
      const mod = fakeModule("only-mod", ["env"], `throw new Error("呼ばれてはいけない");`);
      const r = await runNode(fakeParent([mod]), ["--target", "prod", "--check", "--json", "--skip", "no-such"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--skip の no-such が見つからない");
      expect(r.stdout).toBe("");
    });

    it("入力: --skip の値が無い・空の id があると 1 で終わる", async () => {
      const noValue = await runNode(REAL_SCRIPT, ["--target", "prod", "--check", "--skip"]);
      expect(noValue.code).toBe(1);
      expect(noValue.stderr).toContain("--skip の後に値が要る");
      const empty = await runNode(REAL_SCRIPT, ["--target", "prod", "--check", "--skip", "a,"]);
      expect(empty.code).toBe(1);
      expect(empty.stderr).toContain("--skip の id に空のものがある");
    });

    it("入力: SETUP_WORKTREE が相対パスだと 1 で終わる", async () => {
      const mod = fakeModule("ok-mod", ["env"], `return { ok: true, notes: [] };`);
      const r = await runNode(fakeParent([mod]), ["--target", "prod", "--check", "--json"], { SETUP_WORKTREE: "relative/path" });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("SETUP_WORKTREE は絶対パスで指定する");
      expect(r.stdout).toBe("");
    });

    it("入力: --only で絞ったモジュールとは別の id を --skip しても、--list にある id なら止まらない", async () => {
      const a = fakeModule("a-mod", ["env"], `return { ok: true, notes: [] };`);
      const b = fakeModule("b-mod", ["env"], `return { ok: true, notes: [] };`);
      const r = await runNode(fakeParent([a, b]), ["--target", "prod", "--check", "--json", "--only", "a-mod", "--skip", "b-mod"]);
      expect(r.code).toBe(0);
      const { results } = JSON.parse(lastLine(r.stdout));
      expect(results.map((x) => x.moduleId)).toEqual(["a-mod"]);
    });
  });
});
