import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, truncateSync, utimesSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lighthouse, lighthouseEnv } from "../../src/builtin/lighthouse.js";
import type { BuiltinInput } from "../../src/context.js";
import { makeConfig, makeCtx, tempDir, writeAt } from "../helpers/runner.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

const VV = "MarketingDepartment/WebsiteOperations/frontend/verdant-virgo";

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
const wtResults = () => join(root, "wt", VV, ".lighthouse");
const future = () => new Date(Date.now() + 10_000);
/** spawn に渡した子プロセスの環境変数 */
const spawnedEnv = (index = 0) => (spawnMock.mock.calls[index]![2] as { env: NodeJS.ProcessEnv }).env;

function writeResult(name: string, content = "{}", mtime: Date = future()) {
  const file = writeAt(mainVV(), `.lighthouse/${name}`, content);
  utimesSync(file, mtime, mtime);
  return file;
}

function input(overrides: Partial<BuiltinInput> = {}, config: Parameters<typeof makeConfig>[0] = {}): BuiltinInput {
  const ctx = makeCtx(makeConfig({ mainCheckout: join(root, "main"), worktree: join(root, "wt"), ...config }));
  return { ctx, runId: "01K6PZ3T8Q4M2N7R9S5V1W3X6Y", signal: new AbortController().signal, timeoutSec: 30, job: null, ...overrides };
}

beforeEach(() => {
  ({ dir: root, cleanup } = tempDir("cp-lh-"));
  mkdirSync(join(mainVV(), "node_modules"), { recursive: true });
  onRun = (c) => setImmediate(() => c.close(0));
  spawnMock.mockImplementation((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
    child = new FakeChild();
    onRun(child, options);
    return child;
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => cleanup());

describe("lighthouseEnv", () => {
  describe("正常系", () => {
    it("PATH・HOME・npm_config_ignore_scripts だけを渡し、control-plane の秘密値を混ぜない", () => {
      vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
      expect(lighthouseEnv("/tmp/h", null)).toEqual({ PATH: process.env.PATH, HOME: "/tmp/h", npm_config_ignore_scripts: "true" });
    });

    it("SITE_URL は設定されているときだけ渡す", () => {
      expect(lighthouseEnv("/tmp/h", "https://comegin.com").SITE_URL).toBe("https://comegin.com");
    });

    it.each([
      ["null", null],
      ["空文字", ""],
    ])("空入力: SITE_URL が %s なら SITE_URL のキー自体を渡さない", (_label, siteUrl) => {
      expect(lighthouseEnv("/tmp/h", siteUrl)).not.toHaveProperty("SITE_URL");
    });
  });
});

describe("lighthouse の起動", () => {
  describe("正常系", () => {
    it("作業ツリーではなく main のチェックアウトで pnpm lh を起動する", async () => {
      mkdirSync(join(root, "wt", VV, "node_modules"), { recursive: true });
      await lighthouse(input({}, { siteUrl: "https://comegin.com" }));
      const [command, args, options] = spawnMock.mock.calls[0]!;
      expect(command).toBe("pnpm");
      expect(args).toEqual(["lh"]);
      expect(options.cwd).toBe(mainVV());
      expect(options.stdio).toEqual(["ignore", "ignore", "pipe"]);
      expect(spawnedEnv().SITE_URL).toBe("https://comegin.com");
    });

    it("CONTROL_AGENT_HOME があれば HOME にそれを渡す", async () => {
      const agentHome = join(root, "agenthome");
      await lighthouse(input({}, { agentHome }));
      expect(spawnedEnv().HOME).toBe(agentHome);
    });

    it("CONTROL_AGENT_HOME が無ければ使い捨ての一時ディレクトリを HOME にし、終わったら消す", async () => {
      let homeDuringRun = "";
      onRun = (c, options) => {
        homeDuringRun = options.env.HOME!;
        setImmediate(() => c.close(0));
      };
      await lighthouse(input());
      expect(homeDuringRun).not.toBe(homedir());
      expect(homeDuringRun.startsWith(join(tmpdir(), "comegin-lighthouse-"))).toBe(true);
      expect(existsSync(homeDuringRun)).toBe(false);
    });

    it("子プロセスの環境変数に control-plane の秘密値（GITHUB_TOKEN など）を渡さない", async () => {
      vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
      vi.stubEnv("CONTROL_N8N_EXPORT_API_KEY", "n8n-secret");
      await lighthouse(input());
      expect(Object.keys(spawnedEnv()).sort()).toEqual(["HOME", "PATH", "npm_config_ignore_scripts"]);
      expect(JSON.stringify(spawnedEnv())).not.toContain("secret");
    });
  });

  describe("異常系", () => {
    it("空入力: main のチェックアウトに node_modules が無ければ実行せず skipped", async () => {
      const result = await lighthouse(input({}, { mainCheckout: join(root, "empty-main") }));
      expect(result).toMatchObject({ outcome: "skipped", skipReason: "dependencies not installed" });
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });
});

describe("lighthouse の結果の写し", () => {
  describe("正常系", () => {
    it("今回更新された lhr-*.json と manifest.json だけを作業ツリーの .lighthouse に写す", async () => {
      writeResult("lhr-old.json", "{}", new Date(Date.now() - 3_600_000));
      writeResult("manifest.json", '{"old":true}', new Date(Date.now() - 3_600_000));
      onRun = (c) => {
        writeResult("lhr-1759500000000.json", '{"categories":{}}');
        writeResult("lhr-1759500000000.html", "<html>");
        writeResult("evil.js", "process.exit()");
        setImmediate(() => c.close(0));
      };
      const result = await lighthouse(input());
      expect(readdirSync(wtResults()).sort()).toEqual(["lhr-1759500000000.json", "manifest.json"]);
      expect(readFileSync(join(wtResults(), "lhr-1759500000000.json"), "utf8")).toBe('{"categories":{}}');
      expect(result).toMatchObject({ outcome: "success", failureClass: null });
      expect(result.summary).toContain("2 件");
    });
  });

  describe("異常系", () => {
    it("入力: シンボリックリンクの結果はたどらない", async () => {
      const outside = writeAt(root, "outside/secret.json", '{"secret":1}');
      onRun = (c) => {
        mkdirSync(join(mainVV(), ".lighthouse"), { recursive: true });
        symlinkSync(outside, join(mainVV(), ".lighthouse/lhr-link.json"));
        writeResult("lhr-real.json");
        setImmediate(() => c.close(0));
      };
      await lighthouse(input());
      expect(readdirSync(wtResults())).toEqual(["lhr-real.json"]);
    });

    it("入力: 写し先に同名のシンボリックリンクがあれば上書きしない", async () => {
      const target = writeAt(root, "outside/target.json", "original");
      mkdirSync(wtResults(), { recursive: true });
      symlinkSync(target, join(wtResults(), "lhr-1.json"));
      onRun = (c) => {
        writeResult("lhr-1.json", '{"new":1}');
        setImmediate(() => c.close(0));
      };
      const result = await lighthouse(input());
      expect(readFileSync(target, "utf8")).toBe("original");
      expect(result.outcome).toBe("partial");
    });

    it("入力: 写し先のディレクトリがシンボリックリンクなら拒否する", async () => {
      mkdirSync(join(root, "outside"), { recursive: true });
      mkdirSync(join(root, "wt", VV), { recursive: true });
      symlinkSync(join(root, "outside"), wtResults());
      onRun = (c) => {
        writeResult("lhr-1.json");
        setImmediate(() => c.close(0));
      };
      await expect(lighthouse(input())).rejects.toThrow("書き込み先がシンボリックリンク");
      expect(readdirSync(join(root, "outside"))).toEqual([]);
    });

    it("入力: 25 MiB を超える結果は写さない", async () => {
      onRun = (c) => {
        const big = writeResult("lhr-big.json");
        truncateSync(big, 25 * 1024 * 1024 + 1);
        utimesSync(big, future(), future());
        writeResult("lhr-small.json");
        setImmediate(() => c.close(0));
      };
      await lighthouse(input());
      expect(readdirSync(wtResults())).toEqual(["lhr-small.json"]);
    });

    it("空入力: 写すべき結果が無ければ partial（empty_but_ok）", async () => {
      expect(await lighthouse(input())).toMatchObject({ outcome: "partial", failureClass: "empty_but_ok" });
    });

    it("空入力: .lighthouse はあっても中身が空なら partial（empty_but_ok）で、作業ツリーには何も写さない", async () => {
      onRun = (c) => {
        mkdirSync(join(mainVV(), ".lighthouse"), { recursive: true });
        setImmediate(() => c.close(0));
      };
      expect(await lighthouse(input())).toMatchObject({ outcome: "partial", failureClass: "empty_but_ok" });
      expect(readdirSync(wtResults())).toEqual([]);
    });
  });
});

describe("lighthouse の失敗", () => {
  describe("異常系", () => {
    it("サーバ: 終了コードが 0 でなければ invalid_response で、stderr の末尾だけをログに出す", async () => {
      onRun = (c) =>
        setImmediate(() => {
          c.stderr.emit("data", Buffer.from(`${"x".repeat(1000)}ASSERTION FAILED`));
          c.close(1);
        });
      const result = await lighthouse(input());
      expect(result).toMatchObject({ outcome: "failure", failureClass: "invalid_response", summary: "Lighthouse CI が終了コード 1 で失敗した" });
      const logged = vi.mocked(console.error).mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("ASSERTION FAILED");
      expect(logged).not.toContain("x".repeat(500));
    });

    it("サーバ: シグナルで終わった（終了コード null）なら invalid_response の failure で、結果を写さない", async () => {
      onRun = (c) => {
        writeResult("lhr-1.json");
        setImmediate(() => c.close(null));
      };
      const result = await lighthouse(input());
      expect(result).toMatchObject({ outcome: "failure", failureClass: "invalid_response" });
      expect(existsSync(wtResults())).toBe(false);
    });

    it("サーバ: 起動できなければ（error イベント）unreachable", async () => {
      onRun = (c) => setImmediate(() => c.emit("error", new Error("spawn pnpm ENOENT")));
      expect(await lighthouse(input())).toMatchObject({ outcome: "failure", failureClass: "unreachable" });
    });

    it("サーバ: timeout_sec を過ぎたら SIGTERM で止めて timeout", async () => {
      onRun = () => undefined; // 自分では終わらない
      const result = await lighthouse(input({ timeoutSec: 0.05 }));
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(result).toMatchObject({ outcome: "failure", failureClass: "timeout", summary: "Lighthouse CI がタイムアウトした" });
    });

    it("入力: 停止要求でも子プロセスを止めて timeout", async () => {
      const stop = new AbortController();
      onRun = () => setImmediate(() => stop.abort());
      const result = await lighthouse(input({ signal: stop.signal }));
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(result).toMatchObject({ outcome: "failure", failureClass: "timeout" });
    });
  });
});
