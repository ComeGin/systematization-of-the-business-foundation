import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, truncateSync, utimesSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { a11y, a11yEnv } from "../../src/builtin/a11y.js";
import type { BuiltinInput } from "../../src/context.js";
import { makeConfig, makeCtx, tempDir, writeAt } from "../helpers/runner.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

// 実ホームの代わり（Playwright のブラウザの置き場を、テストの一時ディレクトリの中に向ける）
const fakeHome = vi.hoisted(() => ({ path: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome.path || actual.homedir() };
});

const VV = "frontend/verdant-virgo";

class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  closed = false;
  kill = vi.fn((_signal?: string) => {
    this.close(null);
    return true;
  });
  close(code: number | null) {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", code);
  }
}

let root: string;
let cleanup: () => void;
let child: FakeChild;
/** 子プロセスが「実行中」にすること（結果の JSON を書くなど）。終わったら close する。 */
let onRun: (child: FakeChild, options: { env: NodeJS.ProcessEnv }) => void;

const mainVV = () => join(root, "main", VV);
const wtResults = () => join(root, "wt", VV, ".a11y");
const browsersPath = () => join(fakeHome.path, ".cache/ms-playwright");
const future = () => new Date(Date.now() + 10_000);
const past = () => new Date(Date.now() - 3_600_000);
/** spawn に渡した子プロセスの環境変数 */
const spawnedEnv = (index = 0) => (spawnMock.mock.calls[index]![2] as { env: NodeJS.ProcessEnv }).env;

function writeResult(name: string, content = "{}", mtime: Date = future()) {
  const file = writeAt(mainVV(), `.a11y/${name}`, content);
  utimesSync(file, mtime, mtime);
  return file;
}

/** Playwright の JSON reporter の形（判定に使うところだけ） */
function report(stats: { expected?: number; unexpected?: number } = {}, errors: unknown[] = []) {
  return JSON.stringify({ config: {}, suites: [], errors, stats: { expected: 30, unexpected: 0, flaky: 0, skipped: 0, ...stats } });
}

/** 子プロセスが report を書いてから、code で終わる */
function finishWith(code: number | null, content: string = report(), extra: () => void = () => undefined) {
  onRun = (c) => {
    writeResult("results.json", content);
    extra();
    setImmediate(() => c.close(code));
  };
}

function input(overrides: Partial<BuiltinInput> = {}, config: Parameters<typeof makeConfig>[0] = {}): BuiltinInput {
  const ctx = makeCtx(makeConfig({ mainCheckout: join(root, "main"), worktree: join(root, "wt"), ...config }));
  return { ctx, runId: "01K6PZ3T8Q4M2N7R9S5V1W3X6Y", signal: new AbortController().signal, timeoutSec: 30, job: null, ...overrides };
}

beforeEach(() => {
  ({ dir: root, cleanup } = tempDir("cp-a11y-"));
  fakeHome.path = join(root, "realhome");
  mkdirSync(join(mainVV(), "node_modules"), { recursive: true });
  mkdirSync(join(browsersPath(), "chromium-1248"), { recursive: true });
  finishWith(0);
  spawnMock.mockImplementation((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
    child = new FakeChild();
    onRun(child, options);
    return child;
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  fakeHome.path = "";
  cleanup();
});

describe("a11yEnv", () => {
  describe("正常系", () => {
    it("PATH・HOME・npm_config_ignore_scripts・PLAYWRIGHT_BROWSERS_PATH だけを渡し、control-plane の秘密値を混ぜない", () => {
      vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
      expect(a11yEnv("/tmp/h", null, "/home/u/.cache/ms-playwright")).toEqual({
        PATH: process.env.PATH,
        HOME: "/tmp/h",
        npm_config_ignore_scripts: "true",
        PLAYWRIGHT_BROWSERS_PATH: "/home/u/.cache/ms-playwright",
      });
    });

    it("SITE_URL は設定されているときだけ渡す", () => {
      expect(a11yEnv("/tmp/h", "https://comegin.com", "/b").SITE_URL).toBe("https://comegin.com");
    });

    it.each([
      ["null", null],
      ["空文字", ""],
    ])("空入力: SITE_URL が %s なら SITE_URL のキー自体を渡さない", (_label, siteUrl) => {
      expect(a11yEnv("/tmp/h", siteUrl, "/b")).not.toHaveProperty("SITE_URL");
    });
  });
});

describe("a11y の起動", () => {
  describe("正常系", () => {
    it("作業ツリーではなく main のチェックアウトで pnpm a11y:ci（ビルドから検査まで）を起動する", async () => {
      mkdirSync(join(root, "wt", VV, "node_modules"), { recursive: true });
      await a11y(input({}, { siteUrl: "https://comegin.com" }));
      const [command, args, options] = spawnMock.mock.calls[0]!;
      expect(command).toBe("pnpm");
      expect(args).toEqual(["a11y:ci"]);
      expect(options.cwd).toBe(mainVV());
      expect(options.stdio).toEqual(["ignore", "ignore", "pipe"]);
      expect(spawnedEnv().SITE_URL).toBe("https://comegin.com");
    });

    it("PLAYWRIGHT_BROWSERS_PATH には実ホームの ~/.cache/ms-playwright を渡し、HOME には実ホームを渡さない", async () => {
      await a11y(input());
      expect(spawnedEnv().PLAYWRIGHT_BROWSERS_PATH).toBe(browsersPath());
      expect(spawnedEnv().HOME).not.toBe(fakeHome.path);
      expect(spawnedEnv().HOME).not.toBe(homedir());
    });

    it("CONTROL_AGENT_HOME があれば HOME にそれを渡す", async () => {
      const agentHome = join(root, "agenthome");
      await a11y(input({}, { agentHome }));
      expect(spawnedEnv().HOME).toBe(agentHome);
    });

    it("CONTROL_AGENT_HOME が無ければ使い捨ての一時ディレクトリを HOME にし、終わったら消す", async () => {
      let homeDuringRun = "";
      onRun = (c, options) => {
        homeDuringRun = options.env.HOME!;
        writeResult("results.json", report());
        setImmediate(() => c.close(0));
      };
      await a11y(input());
      expect(homeDuringRun.startsWith(join(tmpdir(), "comegin-a11y-"))).toBe(true);
      expect(existsSync(homeDuringRun)).toBe(false);
    });

    it("子プロセスの環境変数に control-plane の秘密値（GITHUB_TOKEN など）を渡さない", async () => {
      vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
      vi.stubEnv("CONTROL_N8N_EXPORT_API_KEY", "n8n-secret");
      await a11y(input());
      expect(Object.keys(spawnedEnv()).sort()).toEqual(["HOME", "PATH", "PLAYWRIGHT_BROWSERS_PATH", "npm_config_ignore_scripts"]);
      expect(JSON.stringify(spawnedEnv())).not.toContain("secret");
    });

    it("Chromium がヘッドレス版（chromium_headless_shell-*）だけでも起動する", async () => {
      cleanup();
      ({ dir: root, cleanup } = tempDir("cp-a11y-"));
      fakeHome.path = join(root, "realhome");
      mkdirSync(join(mainVV(), "node_modules"), { recursive: true });
      mkdirSync(join(browsersPath(), "chromium_headless_shell-1248"), { recursive: true });
      expect((await a11y(input())).outcome).toBe("success");
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("異常系", () => {
    it("空入力: main のチェックアウトに node_modules が無ければ実行せず skipped", async () => {
      const result = await a11y(input({}, { mainCheckout: join(root, "empty-main") }));
      expect(result).toMatchObject({ outcome: "skipped", skipReason: "dependencies not installed" });
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("空入力: ブラウザの置き場が無ければ実行せず skipped（chromium not installed）", async () => {
      fakeHome.path = join(root, "no-such-home");
      const result = await a11y(input());
      expect(result).toMatchObject({ outcome: "skipped", skipReason: "chromium not installed" });
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it.each([
      ["Chromium 以外のブラウザだけ", (dir: string) => mkdirSync(join(dir, "firefox-1490"), { recursive: true })],
      ["chromium-* がディレクトリでなくファイル", (dir: string) => writeAt(dir, "chromium-1248", "")],
      ["版の無い名前", (dir: string) => mkdirSync(join(dir, "chromium-latest"), { recursive: true })],
    ])("入力: %s なら実行せず skipped", async (_label, prepare) => {
      fakeHome.path = join(root, "other-home");
      mkdirSync(browsersPath(), { recursive: true });
      prepare(browsersPath());
      expect(await a11y(input())).toMatchObject({ outcome: "skipped", skipReason: "chromium not installed" });
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });
});

describe("a11y の結果の写し", () => {
  describe("正常系", () => {
    it("今回更新された .a11y 直下の *.json だけを作業ツリーの .a11y に写す", async () => {
      writeResult("old.json", "{}", past());
      finishWith(0, report({ expected: 30 }), () => {
        writeResult("summary.json", '{"totals":{}}');
        writeResult("index.html", "<html>");
        writeResult("evil.js", "process.exit()");
        writeResult("nested/inner.json", "{}");
      });
      const result = await a11y(input());
      expect(readdirSync(wtResults()).sort()).toEqual(["results.json", "summary.json"]);
      expect(readFileSync(join(wtResults(), "summary.json"), "utf8")).toBe('{"totals":{}}');
      expect(result).toMatchObject({ outcome: "success", failureClass: null });
      expect(result.summary).toContain("2 件");
      expect(result.summary).toContain("不合格 0 件・合格 30 件");
    });

    it("axe の違反で終了コード 1 でも、レポートが読めて errors が空なら success（違反の判断は quality-checker）", async () => {
      finishWith(1, report({ expected: 28, unexpected: 2 }));
      const result = await a11y(input());
      expect(result).toMatchObject({ outcome: "success", failureClass: null });
      expect(result.summary).toContain("不合格 2 件・合格 28 件");
      expect(readdirSync(wtResults())).toEqual(["results.json"]);
    });
  });

  describe("異常系", () => {
    it("入力: シンボリックリンクの結果はたどらない", async () => {
      const outside = writeAt(root, "outside/secret.json", '{"secret":1}');
      finishWith(0, report(), () => symlinkSync(outside, join(mainVV(), ".a11y/link.json")));
      await a11y(input());
      expect(readdirSync(wtResults())).toEqual(["results.json"]);
    });

    it("入力: 写し先に同名のシンボリックリンクがあれば上書きしない", async () => {
      const target = writeAt(root, "outside/target.json", "original");
      mkdirSync(wtResults(), { recursive: true });
      symlinkSync(target, join(wtResults(), "results.json"));
      const result = await a11y(input());
      expect(readFileSync(target, "utf8")).toBe("original");
      expect(result).toMatchObject({ outcome: "partial", failureClass: "empty_but_ok" });
    });

    it("入力: 写し先のディレクトリがシンボリックリンクなら拒否する", async () => {
      mkdirSync(join(root, "outside"), { recursive: true });
      mkdirSync(join(root, "wt", VV), { recursive: true });
      symlinkSync(join(root, "outside"), wtResults());
      await expect(a11y(input())).rejects.toThrow("書き込み先がシンボリックリンク");
      expect(readdirSync(join(root, "outside"))).toEqual([]);
    });

    it("入力: 25 MiB を超える結果は写さない", async () => {
      finishWith(0, report(), () => {
        const big = writeResult("big.json");
        truncateSync(big, 25 * 1024 * 1024 + 1);
        utimesSync(big, future(), future());
      });
      await a11y(input());
      expect(readdirSync(wtResults())).toEqual(["results.json"]);
    });

    it("空入力: 終了コード 0 で写すべき結果が無ければ partial（empty_but_ok）", async () => {
      onRun = (c) => setImmediate(() => c.close(0));
      expect(await a11y(input())).toMatchObject({ outcome: "partial", failureClass: "empty_but_ok" });
      expect(existsSync(wtResults())).toBe(false);
    });
  });
});

describe("a11y の失敗", () => {
  describe("異常系", () => {
    it("サーバ: 終了コード 1 でレポートが無ければ、ビルドの失敗として invalid_response で、stderr の末尾だけをログに出す", async () => {
      onRun = (c) =>
        setImmediate(() => {
          c.stderr.emit("data", Buffer.from(`${"x".repeat(1000)}[build] Missing SITE_URL`));
          c.close(1);
        });
      const result = await a11y(input());
      expect(result).toMatchObject({
        outcome: "failure",
        failureClass: "invalid_response",
        summary: "a11y の検査の前にビルドが失敗した（検査のレポートが作られなかった）",
      });
      const logged = vi.mocked(console.error).mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("Missing SITE_URL");
      expect(logged).not.toContain("x".repeat(500));
    });

    it("サーバ: 前回のレポート（今回より古い）しか無ければ、無いものとして扱い failure で写さない", async () => {
      writeResult("results.json", report(), past());
      onRun = (c) => setImmediate(() => c.close(1));
      expect(await a11y(input())).toMatchObject({ outcome: "failure", failureClass: "invalid_response" });
      expect(existsSync(wtResults())).toBe(false);
    });

    it("入力: レポートがシンボリックリンクなら読まず、failure で写さない", async () => {
      const outside = writeAt(root, "outside/report.json", report());
      utimesSync(outside, future(), future());
      onRun = (c) => {
        mkdirSync(join(mainVV(), ".a11y"), { recursive: true });
        symlinkSync(outside, join(mainVV(), ".a11y/results.json"));
        setImmediate(() => c.close(1));
      };
      expect(await a11y(input())).toMatchObject({ outcome: "failure", failureClass: "invalid_response" });
      expect(existsSync(wtResults())).toBe(false);
    });

    it("サーバ: レポートのトップに errors（webServer の起動失敗など）があれば failure で写さない", async () => {
      finishWith(1, report({ expected: 0 }, [{ message: "Error: Timed out waiting 60000ms from config.webServer." }]));
      const result = await a11y(input());
      expect(result).toMatchObject({
        outcome: "failure",
        failureClass: "invalid_response",
        summary: "a11y の検査を始められなかった（Playwright のエラー 1 件）",
      });
      expect(existsSync(wtResults())).toBe(false);
    });

    it.each([
      ["JSON として壊れている", "{not json"],
      ["stats が無い", JSON.stringify({ errors: [] })],
      ["stats の件数が数でない", JSON.stringify({ errors: [], stats: { expected: "30", unexpected: 0 } })],
    ])("サーバ: レポートが%sなら invalid_response で写さない", async (_label, content) => {
      finishWith(1, content);
      expect(await a11y(input())).toMatchObject({
        outcome: "failure",
        failureClass: "invalid_response",
        summary: "a11y の検査のレポートを解釈できなかった",
      });
      expect(existsSync(wtResults())).toBe(false);
    });

    it("サーバ: 終了コードが 0・1 以外なら、レポートがあっても invalid_response で写さない", async () => {
      finishWith(2);
      expect(await a11y(input())).toMatchObject({
        outcome: "failure",
        failureClass: "invalid_response",
        summary: "a11y の検査が終了コード 2 で失敗した",
      });
      expect(existsSync(wtResults())).toBe(false);
    });

    it("サーバ: シグナルで終わった（終了コード null）なら invalid_response の failure で、結果を写さない", async () => {
      finishWith(null);
      expect(await a11y(input())).toMatchObject({ outcome: "failure", failureClass: "invalid_response" });
      expect(existsSync(wtResults())).toBe(false);
    });

    it("サーバ: 起動できなければ（error イベント）unreachable", async () => {
      onRun = (c) => setImmediate(() => c.emit("error", new Error("spawn pnpm ENOENT")));
      expect(await a11y(input())).toMatchObject({ outcome: "failure", failureClass: "unreachable" });
    });

    it("サーバ: timeout_sec を過ぎたら SIGTERM で止めて timeout", async () => {
      onRun = () => undefined; // 自分では終わらない
      const result = await a11y(input({ timeoutSec: 0.05 }));
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(result).toMatchObject({ outcome: "failure", failureClass: "timeout", summary: "a11y の検査がタイムアウトした" });
    });

    it("入力: 停止要求でも子プロセスを止めて timeout", async () => {
      const stop = new AbortController();
      onRun = () => setImmediate(() => stop.abort());
      const result = await a11y(input({ signal: stop.signal }));
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(result).toMatchObject({ outcome: "failure", failureClass: "timeout" });
    });
  });
});
