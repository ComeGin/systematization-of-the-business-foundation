import { createHash } from "node:crypto";

import { OAuthError, OAuthErrorCode, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// index.ts は import した時点で設定を読み、サーバを起動する。
// HTTP の待ち受け・stdio の接続は偽物に差し替え、渡された引数だけを記録する
const h = vi.hoisted(() => ({
  verifier: null as OAuthTokenVerifier | null,
  factory: null as (() => unknown) | null,
  appOptions: null as unknown,
  routes: [] as unknown[][],
  listenArgs: null as unknown[] | null,
  servers: [] as { info: unknown; tools: Map<string, { annotations?: Record<string, boolean> }>; connect: ReturnType<typeof vi.fn> }[],
  stdioTransports: 0,
  httpClose: null as ReturnType<typeof vi.fn> | null,
  handlerClose: null as ReturnType<typeof vi.fn> | null,
  // stdio の接続を失敗させたいテストで設定する
  connectError: null as Error | null,
  // 待ち受けの失敗（EADDRINUSE など）を再現したいテストで設定する。Express 5 と同じくコールバックに渡す
  listenError: undefined as Error | undefined,
}));

vi.mock("@modelcontextprotocol/express", () => ({
  createMcpExpressApp: vi.fn((options: unknown) => {
    h.appOptions = options;
    return {
      all: (...args: unknown[]) => h.routes.push(args),
      listen: (port: number, host: string, callback?: (error?: Error) => void) => {
        h.listenArgs = [port, host];
        callback?.(h.listenError);
        h.httpClose = vi.fn((done?: () => void) => done?.());
        return { close: h.httpClose };
      },
    };
  }),
  requireBearerAuth: vi.fn((options: { verifier: OAuthTokenVerifier }) => {
    h.verifier = options.verifier;
    return "bearer-auth-middleware";
  }),
}));

vi.mock("@modelcontextprotocol/node", () => ({ toNodeHandler: vi.fn(() => vi.fn()) }));

vi.mock("@modelcontextprotocol/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/server")>();
  class FakeMcpServer {
    tools = new Map<string, unknown>();
    // restoreMocks で vi.fn の実装が消えても動くよう、実装は h の状態だけで決める
    connect = vi.fn(async () => {
      if (h.connectError) throw h.connectError;
    });
    constructor(public info: unknown) {
      h.servers.push(this as never);
    }
    registerTool(name: string, config: unknown) {
      if (this.tools.has(name)) throw new Error(`Tool ${name} is already registered`);
      this.tools.set(name, config);
    }
  }
  return {
    ...actual,
    McpServer: FakeMcpServer,
    createMcpHandler: vi.fn((factory: () => unknown) => {
      h.factory = factory;
      h.handlerClose = vi.fn(async () => {});
      return { close: h.handlerClose };
    }),
  };
});

vi.mock("@modelcontextprotocol/server/stdio", () => ({
  StdioServerTransport: class {
    constructor() {
      h.stdioTransports++;
    }
  },
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const TOKEN = "mcp-auth-token-0123456789abcdefghij";
const CLIENT_SECRET = "mautic-client-secret-value";

const READ_TOOLS = [
  "mautic_get_contact",
  "mautic_get_contact_activity",
  "mautic_get_contact_relations",
  "mautic_get_dashboard_widget_data",
  "mautic_get_record",
  "mautic_list_campaign_contacts",
  "mautic_list_contacts",
  "mautic_list_files",
  "mautic_list_form_submissions",
  "mautic_list_lookup",
  "mautic_list_records",
  "mautic_list_themes",
  "mautic_query_stats",
  "mautic_run_report",
];

let stderr: ReturnType<typeof vi.spyOn>;
let stdout: ReturnType<typeof vi.spyOn>;
let consoleLog: ReturnType<typeof vi.spyOn>;
let signalHandlers: Map<string, unknown>;
// 直前のテストが時間切れで終わっても、読み込み中の index.ts が次のテストの h に書き込まないよう待つために持つ
let pendingImport: Promise<unknown> | undefined;

function stubBaseEnv(env: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    MAUTIC_BASE_URL: "https://mautic.example.com/",
    MAUTIC_CLIENT_ID: "client-id",
    MAUTIC_CLIENT_SECRET: CLIENT_SECRET,
    MAUTIC_ACCESS_LEVEL: undefined,
    TRANSPORT: undefined,
    HOST: undefined,
    PORT: undefined,
    MCP_AUTH_TOKEN: TOKEN,
    MCP_ALLOWED_HOSTS: undefined,
    ...env,
  };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
}

async function start(env: Record<string, string | undefined> = {}) {
  stubBaseEnv(env);
  pendingImport = import("../src/index.js");
  await pendingImport;
}

function stderrText(): string {
  return stderr.mock.calls.map((args: unknown[]) => args.join(" ")).join("\n");
}

function toolNames(): string[] {
  expect(h.factory).not.toBeNull();
  h.factory!();
  return [...h.servers.at(-1)!.tools.keys()].sort();
}

beforeEach(async () => {
  await pendingImport?.catch(() => {});
  pendingImport = undefined;
  vi.resetModules();
  Object.assign(h, {
    verifier: null,
    factory: null,
    appOptions: null,
    routes: [],
    listenArgs: null,
    servers: [],
    stdioTransports: 0,
    httpClose: null,
    handlerClose: null,
    connectError: null,
    listenError: undefined,
  });
  const crypto = await import("node:crypto");
  vi.mocked(crypto.timingSafeEqual).mockClear();

  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  signalHandlers = new Map();
  const originalOn = process.on.bind(process);
  vi.spyOn(process, "on").mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
    if (event === "SIGINT" || event === "SIGTERM") {
      signalHandlers.set(event, listener);
      return process;
    }
    return originalOn(event, listener);
  }) as typeof process.on);
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleLog = vi.spyOn(console, "log");
  stdout = vi.spyOn(process.stdout, "write");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("起動: HTTP（既定）", () => {
  describe("正常系", () => {
    it("/mcp に Bearer 認証のミドルウェアを挟んで登録し、HOST:PORT で待ち受ける", async () => {
      await start({ HOST: "127.0.0.1", PORT: "3999", MCP_ALLOWED_HOSTS: "a.ngrok.app" });
      expect(h.routes).toHaveLength(1);
      expect(h.routes[0]![0]).toBe("/mcp");
      expect(h.routes[0]![1]).toBe("bearer-auth-middleware");
      expect(h.listenArgs).toEqual([3999, "127.0.0.1"]);
      expect(h.appOptions).toEqual({ host: "127.0.0.1", allowedHosts: ["a.ngrok.app"] });
    });

    it("空入力: HOST・PORT・MCP_ALLOWED_HOSTS が未指定なら 127.0.0.1:3100 で待ち受け、allowedHosts は渡さない", async () => {
      await start();
      expect(h.listenArgs).toEqual([3100, "127.0.0.1"]);
      expect(h.appOptions).toEqual({ host: "127.0.0.1", allowedHosts: undefined });
    });

    it("SIGINT・SIGTERM で終了処理を登録する", async () => {
      await start();
      expect([...signalHandlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    });

    it("終了シグナルでハンドラーと HTTP サーバを閉じてから exit(0) する", async () => {
      await start();
      const shutdown = signalHandlers.get("SIGTERM") as () => Promise<void>;
      await expect(shutdown()).rejects.toThrow("process.exit(0)");
      expect(h.handlerClose).toHaveBeenCalledTimes(1);
      expect(h.httpClose).toHaveBeenCalledTimes(1);
    });

    it("起動ログは stderr に出し、トークンやクライアントシークレットを含めない", async () => {
      await start();
      expect(stderrText()).toContain("listening on http://127.0.0.1:3100/mcp (Mautic: https://mautic.example.com, access: read_only)");
      expect(stderrText()).not.toContain(TOKEN);
      expect(stderrText()).not.toContain(CLIENT_SECRET);
      expect(consoleLog).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
    });
  });

  describe("異常系", () => {
    it("空入力: MCP_AUTH_TOKEN がなければ起動せずに exit(1) する", async () => {
      await expect(start({ MCP_AUTH_TOKEN: undefined })).rejects.toThrow("process.exit(1)");
      expect(h.listenArgs).toBeNull();
      expect(h.routes).toHaveLength(0);
    });

    it("入力: MCP_AUTH_TOKEN が 32 文字未満なら起動せずに exit(1) し、値をログに出さない", async () => {
      const short = "short-secret-token";
      await expect(start({ MCP_AUTH_TOKEN: short })).rejects.toThrow("process.exit(1)");
      expect(h.listenArgs).toBeNull();
      expect(stderrText()).toContain("MCP_AUTH_TOKEN");
      expect(stderrText()).not.toContain(short);
      expect(stderrText()).not.toContain(CLIENT_SECRET);
    });

    it("入力: MAUTIC_BASE_URL が URL でなければ起動せずに exit(1) し、サーバも作らない", async () => {
      await expect(start({ MAUTIC_BASE_URL: "mautic.example.com" })).rejects.toThrow("process.exit(1)");
      expect(h.listenArgs).toBeNull();
      expect(h.factory).toBeNull();
      expect(h.stdioTransports).toBe(0);
    });

    // 3100 は Chatwoot 本体と衝突しうる（CLAUDE.md のポート表）。Express 5 は失敗もコールバックに error 付きで渡す
    it("サーバ: 待ち受けに失敗したら（EADDRINUSE など）listening と出さず、理由を stderr に出して exit(1) する", async () => {
      h.listenError = Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:3100"), { code: "EADDRINUSE" });
      await expect(start()).rejects.toThrow("process.exit(1)");
      expect(stderrText()).toContain("[mautic-mcp-server] failed to listen on 127.0.0.1:3100 (EADDRINUSE)");
      expect(stderrText()).not.toContain("listening on");
      expect(stderrText()).not.toContain(TOKEN);
      expect(stderrText()).not.toContain(CLIENT_SECRET);
    });
  });
});

describe("起動: stdio", () => {
  describe("正常系", () => {
    it("空入力: MCP_AUTH_TOKEN が未設定でも stdio トランスポートに接続し、HTTP では待ち受けない", async () => {
      await start({ TRANSPORT: "stdio", MCP_AUTH_TOKEN: undefined });
      expect(h.stdioTransports).toBe(1);
      expect(h.servers).toHaveLength(1);
      expect(h.servers[0]!.connect).toHaveBeenCalledTimes(1);
      expect(h.listenArgs).toBeNull();
    });

    it("ログは stderr だけに出し、stdout（MCP の通信路）には何も書かない", async () => {
      await start({ TRANSPORT: "stdio", MCP_AUTH_TOKEN: undefined });
      expect(stderrText()).toContain("running on stdio (Mautic: https://mautic.example.com, access: read_only)");
      expect(consoleLog).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
    });
  });

  describe("異常系", () => {
    it("サーバ: stdio の接続に失敗したら起動を中断し（import が reject する）、起動ログを出さない", async () => {
      h.connectError = new Error("stdin closed");
      await expect(start({ TRANSPORT: "stdio", MCP_AUTH_TOKEN: undefined })).rejects.toThrow("stdin closed");
      expect(stderrText()).not.toContain("running on stdio");
      expect(stdout).not.toHaveBeenCalled();
    });
  });
});

describe("MAUTIC_ACCESS_LEVEL ごとに登録されるツール", () => {
  describe("正常系", () => {
    it("空入力: 未指定（既定）は read_only で、参照系 14 ツールだけ", async () => {
      await start();
      expect(toolNames()).toEqual(READ_TOOLS);
    });

    it("read_only を明示しても参照系 14 ツールだけ", async () => {
      await start({ MAUTIC_ACCESS_LEVEL: "read_only" });
      expect(toolNames()).toEqual(READ_TOOLS);
    });

    it("read_write は参照系に作成・更新を加え、削除は登録しない", async () => {
      await start({ MAUTIC_ACCESS_LEVEL: "read_write" });
      expect(toolNames()).toEqual([...READ_TOOLS, "mautic_create_record", "mautic_update_record"].sort());
    });

    it("full はさらに削除を加える", async () => {
      await start({ MAUTIC_ACCESS_LEVEL: "full" });
      expect(toolNames()).toEqual([...READ_TOOLS, "mautic_create_record", "mautic_delete_record", "mautic_update_record"].sort());
    });

    it("read_only ⊂ read_write ⊂ full になる", async () => {
      const sets: Set<string>[] = [];
      for (const level of ["read_only", "read_write", "full"]) {
        vi.resetModules();
        await start({ MAUTIC_ACCESS_LEVEL: level });
        sets.push(new Set(toolNames()));
      }
      const [readOnly, readWrite, full] = sets as [Set<string>, Set<string>, Set<string>];
      expect([...readOnly].every((name) => readWrite.has(name))).toBe(true);
      expect([...readWrite].every((name) => full.has(name))).toBe(true);
      expect(readOnly.size).toBeLessThan(readWrite.size);
      expect(readWrite.size).toBeLessThan(full.size);
    });

    it("参照系のツールはすべて readOnlyHint=true・destructiveHint=false", async () => {
      await start({ MAUTIC_ACCESS_LEVEL: "full" });
      h.factory!();
      const tools = h.servers.at(-1)!.tools;
      for (const name of READ_TOOLS) {
        expect(tools.get(name)!.annotations, name).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      }
    });

    it("サーバ情報に名前とバージョンを設定する", async () => {
      await start();
      h.factory!();
      expect(h.servers.at(-1)!.info).toEqual({ name: "mautic-mcp-server", version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    });
  });

  describe("異常系", () => {
    it("入力: 未知のアクセスレベル（admin）では起動せずに exit(1) し、ツールを 1 つも登録しない", async () => {
      await expect(start({ MAUTIC_ACCESS_LEVEL: "admin" })).rejects.toThrow("process.exit(1)");
      expect(stderrText()).toMatch(/- MAUTIC_ACCESS_LEVEL: /);
      expect(h.factory).toBeNull();
      expect(h.servers).toHaveLength(0);
    });

    it("入力: 大文字の FULL は別の値として拒否する（書き込みツールを黙って開かない）", async () => {
      await expect(start({ MAUTIC_ACCESS_LEVEL: "FULL" })).rejects.toThrow("process.exit(1)");
      expect(h.factory).toBeNull();
    });
  });
});

describe("HTTP の Bearer 認証（固定トークン）", () => {
  async function verifier(): Promise<OAuthTokenVerifier> {
    await start();
    expect(h.verifier).not.toBeNull();
    return h.verifier!;
  }

  describe("正常系", () => {
    it("一致するトークンなら AuthInfo を返し、期限は 3600 秒後にする", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
      const auth = await (await verifier()).verifyAccessToken(TOKEN);
      expect(auth).toEqual({
        token: TOKEN,
        clientId: "mcp-client",
        scopes: [],
        expiresAt: Math.floor(new Date("2026-10-05T00:00:00Z").getTime() / 1000) + 3600,
      });
    });

    it("比較は SHA-256 ダイジェスト同士の timingSafeEqual で行う", async () => {
      const crypto = await import("node:crypto");
      const verify = await verifier();
      await verify.verifyAccessToken("short").catch(() => {});

      const timingSafeEqual = vi.mocked(crypto.timingSafeEqual);
      expect(timingSafeEqual).toHaveBeenCalledTimes(1);
      const [given, expected] = timingSafeEqual.mock.calls[0]! as [Buffer, Buffer];
      expect(given.equals(createHash("sha256").update("short").digest())).toBe(true);
      expect(expected.equals(createHash("sha256").update(TOKEN).digest())).toBe(true);
    });
  });

  describe("異常系", () => {
    it("入力: 同じ長さで内容が違うトークンは invalid_token の OAuthError にする", async () => {
      const wrong = TOKEN.slice(0, -1) + "X";
      const error = await (await verifier()).verifyAccessToken(wrong).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OAuthError);
      expect((error as OAuthError).code).toBe(OAuthErrorCode.InvalidToken);
    });

    it("入力: 長さの違うトークン・空文字でも RangeError にならず invalid_token にする", async () => {
      const verify = await verifier();
      for (const token of ["short", "", `${TOKEN}-longer`]) {
        const error = await verify.verifyAccessToken(token).catch((e: unknown) => e);
        expect(error, token).toBeInstanceOf(OAuthError);
        expect((error as OAuthError).code).toBe(OAuthErrorCode.InvalidToken);
      }
    });

    it("空入力: 空文字のトークンは invalid_token にし、AuthInfo を返さない", async () => {
      const error = await (await verifier()).verifyAccessToken("").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OAuthError);
      expect((error as OAuthError).code).toBe(OAuthErrorCode.InvalidToken);
    });

    it("入力: 拒否のエラー文に、送られたトークンも正しいトークンも含めない", async () => {
      const wrong = "wrong-token-value-0123456789abcdef";
      const error = (await (await verifier()).verifyAccessToken(wrong).catch((e: unknown) => e)) as OAuthError;
      expect(error.message).not.toContain(wrong);
      expect(error.message).not.toContain(TOKEN);
      expect(stderrText()).not.toContain(TOKEN);
    });
  });
});
