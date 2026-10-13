import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureStderr, DB_PASSWORD, mockExit, SECRET, stubValidEnv } from "./helpers/env.js";

// index.ts は import した時点で起動する。server・handler・auth・db を偽物にして、起動と停止の手順だけを見る
// （振り分けは handler.test.ts、待ち受けの細部は server.test.ts）
const mocks = vi.hoisted(() => ({
  server: {} as Record<string, ReturnType<typeof vi.fn>>,
  createServer: vi.fn(),
  createHandler: vi.fn(() => "HANDLE"),
  createAuth: vi.fn(() => ({ handler: vi.fn() })),
  pool: { end: vi.fn(), query: vi.fn() },
}));
vi.mock("../src/server.js", () => ({ createServer: mocks.createServer }));
vi.mock("../src/handler.js", () => ({ createHandler: mocks.createHandler }));
vi.mock("../src/auth.js", () => ({ createAuth: mocks.createAuth }));
vi.mock("../src/db.js", () => ({ createPool: () => mocks.pool }));

let signals: Map<string, () => void>;
let stderr: ReturnType<typeof captureStderr>;

async function load() {
  vi.resetModules();
  await import("../src/index.js");
}

beforeEach(() => {
  stubValidEnv({ ADMIN_BOOTSTRAP_EMAILS: "a@comegin.com" });
  stderr = captureStderr();
  signals = new Map();
  vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
    signals.set(event, listener);
    return process;
  }) as never);
  mocks.server = {
    listen: vi.fn((_port: number, _host: string, cb?: () => void) => cb?.()),
    close: vi.fn((cb?: () => void) => cb?.()),
    closeIdleConnections: vi.fn(),
  };
  mocks.createServer.mockReset().mockReturnValue(mocks.server);
  mocks.createHandler.mockClear();
  mocks.createAuth.mockClear();
  mocks.pool.end.mockReset().mockResolvedValue(undefined);
  mocks.pool.query.mockReset();
});

describe("起動", () => {
  describe("正常系", () => {
    it("auth から handler を作り、設定のホストとポートで待ち受け、issuer をログに出す", async () => {
      vi.stubEnv("PORT", "4555");
      vi.stubEnv("HOST", "127.0.0.1");
      await load();
      expect((mocks.createAuth.mock.calls[0] as unknown[] | undefined)?.[1]).toBe(mocks.pool);
      expect(mocks.createHandler).toHaveBeenCalledWith({ auth: mocks.createAuth.mock.results[0]?.value });
      expect(mocks.createServer).toHaveBeenCalledWith("HANDLE");
      expect(mocks.server.listen).toHaveBeenCalledWith(4555, "127.0.0.1", expect.any(Function));
      expect(stderr.text()).toContain("issuer http://localhost:3103/api/auth");
    });

    it("許可リストの初期値は追加しない（migrate に移した。仕様 3.5）。起動で DB に触れない", async () => {
      await load();
      expect(mocks.pool.query).not.toHaveBeenCalled();
      expect(stderr.text()).not.toContain("allowlist bootstrap");
    });

    it("起動のログにシークレットと DB のパスワードを出さない", async () => {
      await load();
      expect(stderr.text()).not.toContain(SECRET);
      expect(stderr.text()).not.toContain(DB_PASSWORD);
    });
  });

  describe("異常系", () => {
    it("入力: 設定が不正なら、DB にもサーバーにも触れる前に終了する", async () => {
      vi.stubEnv("BETTER_AUTH_SECRET", "short");
      mockExit();
      await expect(load()).rejects.toThrow("process.exit(1)");
      expect(mocks.createAuth).not.toHaveBeenCalled();
      expect(mocks.createServer).not.toHaveBeenCalled();
    });

    it("空入力: 必須の環境変数が空なら終了し、名前を出す", async () => {
      vi.stubEnv("DATABASE_HOST", "");
      mockExit();
      await expect(load()).rejects.toThrow("process.exit(1)");
      expect(stderr.text()).toContain("DATABASE_HOST");
    });
  });
});

describe("停止", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await load();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("正常系", () => {
    it("SIGTERM・SIGINT を購読する", () => {
      expect(signals.has("SIGTERM")).toBe(true);
      expect(signals.has("SIGINT")).toBe(true);
    });

    it("SIGTERM で新しい接続を止め、処理中のリクエストを終えてから DB を閉じて exit(0) する", async () => {
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      signals.get("SIGTERM")!();
      expect(mocks.server.close).toHaveBeenCalledTimes(1);
      expect(mocks.server.closeIdleConnections).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      expect(mocks.pool.end).toHaveBeenCalledTimes(1);
    });

    it("2 回目のシグナルでは何もしない", () => {
      vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      mocks.server.close = vi.fn();
      signals.get("SIGTERM")!();
      signals.get("SIGINT")!();
      expect(mocks.server.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("異常系", () => {
    it("サーバ: 10 秒で処理が終わらなければ exit(1) で打ち切る", () => {
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      mocks.server.close = vi.fn();
      signals.get("SIGTERM")!();
      vi.advanceTimersByTime(9_999);
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(exit).toHaveBeenCalledWith(1);
    });
  });
});
