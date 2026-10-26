import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { ConsentStore } from "../src/store.js";
import { SHUTDOWN_TIMEOUT_MS } from "../src/constants.js";
import { makeConfig } from "./helpers/config.js";

// index.ts は import した時点で起動する。設定・Valkey・HTTP サーバーを偽物にして、起動と停止の手順だけを見る
const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  createValkey: vi.fn(),
  createServer: vi.fn(),
  createHandler: vi.fn(),
}));
vi.mock("../src/config.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../src/valkey.js", () => ({ createValkey: mocks.createValkey }));
vi.mock("../src/server.js", () => ({ createServer: mocks.createServer }));
vi.mock("../src/handler.js", () => ({ createHandler: mocks.createHandler }));

/** createHandler が返す handle の代わり */
const HANDLE = () => Promise.resolve({ status: 200, headers: {}, body: "" });

const config = makeConfig({ HOST: "0.0.0.0", PORT: 3104, VALKEY_KEY_PREFIX: "consent:" });

let valkey: { quit: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; eval: ReturnType<typeof vi.fn> };
let server: {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  closeIdleConnections: ReturnType<typeof vi.fn>;
};
let handlers: Map<string, () => void>;
let exit: MockInstance<typeof process.exit>;
let stderr: MockInstance<typeof console.error>;

async function boot(): Promise<void> {
  vi.resetModules();
  handlers = new Map();
  // 本物の process にシグナルのハンドラーを残さないよう、import の間だけ process.on を差し替える
  const on = vi.spyOn(process, "on").mockImplementation(((event: string, handler: () => void) => {
    handlers.set(event, handler);
    return process;
  }) as typeof process.on);
  try {
    await import("../src/index.js");
  } finally {
    on.mockRestore();
  }
}

/** server.close に渡されたコールバック（処理中のリクエストが終わったら呼ばれる） */
function closeCallback(): () => void {
  return server.close.mock.calls[0]![0] as () => void;
}

beforeEach(() => {
  valkey = {
    quit: vi.fn().mockResolvedValue("OK"),
    disconnect: vi.fn(),
    // append の書き込みのスクリプト（store.ts）。1 は書けたこと
    eval: vi.fn().mockResolvedValue(1),
  };
  server = { listen: vi.fn(), close: vi.fn(), closeIdleConnections: vi.fn() };
  mocks.loadConfig.mockReturnValue(config);
  mocks.createValkey.mockReturnValue(valkey);
  mocks.createServer.mockReturnValue(server);
  mocks.createHandler.mockReturnValue(HANDLE);
  exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("起動", () => {
  describe("正常系", () => {
    it("設定を読み、その設定で Valkey・handler・サーバーを作る", async () => {
      await boot();
      expect(mocks.loadConfig).toHaveBeenCalledTimes(1);
      expect(mocks.createValkey).toHaveBeenCalledWith(config);
      // resetModules 後の index.ts と同じモジュールのクラスで照合する
      const { ConsentStore } = await import("../src/store.js");
      expect(mocks.createHandler).toHaveBeenCalledWith({ config, store: expect.any(ConsentStore) });
      expect(mocks.createServer).toHaveBeenCalledWith(HANDLE);
    });

    it("ストアは作った Valkey と VALKEY_KEY_PREFIX を使う", async () => {
      await boot();
      const { store } = mocks.createHandler.mock.calls[0]![0] as { store: ConsentStore };
      await store.append("eAd5tbgdBQH8cAOA_oELjQ", { state: "granted", at: "t", policy: "p" });
      expect(valkey.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        "consent:c:eAd5tbgdBQH8cAOA_oELjQ",
        expect.stringMatching(/^\d+$/),
        "granted",
        "t",
        "p",
      );
    });

    it("PORT と HOST で待ち受け、起動のログは stderr に出す", async () => {
      await boot();
      expect(server.listen).toHaveBeenCalledWith(3104, "0.0.0.0", expect.any(Function));
      (server.listen.mock.calls[0]![2] as () => void)();
      expect(stderr).toHaveBeenCalledWith("[consent-api] listening on 0.0.0.0:3104");
    });

    it("起動のログに VALKEY_URL と VALKEY_PASSWORD を出さない", async () => {
      mocks.loadConfig.mockReturnValue(
        makeConfig({ VALKEY_URL: "rediss://cache.example:6379", VALKEY_PASSWORD: "auth-token-should-not-leak" }),
      );
      await boot();
      (server.listen.mock.calls[0]![2] as () => void)();
      const output = stderr.mock.calls.flat().map(String).join("\n");
      expect(output).not.toContain("auth-token-should-not-leak");
      expect(output).not.toContain("rediss://cache.example:6379");
    });

    it("SIGTERM と SIGINT を受け取るハンドラーを登録する", async () => {
      await boot();
      expect([...handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    });
  });

  describe("異常系", () => {
    it("空入力: 必須の環境変数が無く loadConfig が止めたら、Valkey にもサーバーにも触れない", async () => {
      // 本物の loadConfig は process.exit(1) で止まる。ここでは exit の代わりに例外で止める
      mocks.loadConfig.mockImplementation(() => {
        throw new Error("process.exit(1)");
      });
      await expect(boot()).rejects.toThrow("process.exit(1)");
      expect(mocks.createValkey).not.toHaveBeenCalled();
      expect(mocks.createServer).not.toHaveBeenCalled();
      expect(mocks.createHandler).not.toHaveBeenCalled();
      expect(handlers.size).toBe(0);
    });

    it("サーバ: Valkey のクライアントが作れなければ、待ち受けを始めない", async () => {
      mocks.createValkey.mockImplementation(() => {
        throw new Error("ERR invalid URL");
      });
      await expect(boot()).rejects.toThrow("ERR invalid URL");
      expect(mocks.createServer).not.toHaveBeenCalled();
      expect(mocks.createHandler).not.toHaveBeenCalled();
      expect(server.listen).not.toHaveBeenCalled();
    });
  });
});

describe("停止（SIGTERM / SIGINT）", () => {
  describe("正常系", () => {
    it.each(["SIGTERM", "SIGINT"])("%s で新しい接続の受け付けを止め、待機中の keep-alive 接続を閉じる", async (signal) => {
      await boot();
      handlers.get(signal)!();
      expect(server.close).toHaveBeenCalledTimes(1);
      expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledWith(`[consent-api] ${signal} received, shutting down`);
    });

    it("処理中のリクエストが終わるまでは Valkey を閉じず、終わってから quit して exit(0)", async () => {
      await boot();
      handlers.get("SIGTERM")!();
      expect(valkey.quit).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();

      closeCallback()();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      expect(valkey.quit).toHaveBeenCalledTimes(1);
      expect(valkey.disconnect).not.toHaveBeenCalled();
    });

    it("2 回目のシグナルは無視する（停止の手順を重ねない）", async () => {
      await boot();
      handlers.get("SIGTERM")!();
      handlers.get("SIGINT")!();
      handlers.get("SIGTERM")!();
      expect(server.close).toHaveBeenCalledTimes(1);
      expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);
    });

    it("強制終了のタイマーは unref し、それ自体がプロセスを生かし続けないようにする", async () => {
      await boot();
      const unref = vi.fn();
      const setTimeoutSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((() => ({ unref })) as unknown as typeof setTimeout);
      handlers.get("SIGTERM")!();
      setTimeoutSpy.mockRestore();
      expect(unref).toHaveBeenCalledTimes(1);
    });
  });

  describe("異常系", () => {
    it("サーバ: quit が失敗したら disconnect で切ってから exit(0)", async () => {
      valkey.quit.mockRejectedValue(new Error("Connection is closed."));
      await boot();
      handlers.get("SIGTERM")!();
      closeCallback()();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      expect(valkey.disconnect).toHaveBeenCalledTimes(1);
    });

    it("サーバ: 10 秒で終わらなければ exit(1) で強制終了する", async () => {
      vi.useFakeTimers();
      await boot();
      handlers.get("SIGTERM")!();
      vi.advanceTimersByTime(9_999);
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(exit).toHaveBeenCalledWith(1);
    });

    it("サーバ: Valkey の quit が返らないまま（接続が固まった）でも、10 秒で exit(1) する", async () => {
      vi.useFakeTimers();
      valkey.quit.mockReturnValue(new Promise(() => {}));
      await boot();
      handlers.get("SIGTERM")!();
      closeCallback()();
      await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
      expect(valkey.quit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
    });
  });
});
