import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * index.ts は import 時に環境変数を読み、サーバを起動する（トップレベル await）。
 * SDK のサーバ・トランスポート・Express を偽物に差し替え、vi.resetModules() → import() で毎回読み直す。
 * 偽物の中では vi.fn を使わない（restoreMocks で実装が外れるのを避けるため）。
 */
const state = vi.hoisted(() => ({
  servers: [] as Array<{ info: unknown; tools: Map<string, { config: any; handler: unknown }>; connected: unknown[] }>,
  factory: undefined as undefined | (() => unknown),
  handlerClosed: 0,
  appOptions: undefined as unknown,
  routes: [] as unknown[][],
  listen: undefined as undefined | { port: number; host: string },
  httpClosed: 0,
  verifier: undefined as undefined | { verifyAccessToken(token: string): Promise<any> },
  authMiddleware: function bearerAuthMiddleware() {},
  nodeHandler: function nodeHandler() {},
  timingSafeEqualCalls: [] as Array<[Buffer, Buffer]>,
}));

vi.mock("@modelcontextprotocol/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/server")>();
  class McpServer {
    info: unknown;
    tools = new Map<string, { config: any; handler: unknown }>();
    connected: unknown[] = [];
    constructor(info: unknown) {
      this.info = info;
      state.servers.push(this);
    }
    registerTool(name: string, config: unknown, handler: unknown) {
      if (this.tools.has(name)) throw new Error(`ツール名が重複しています: ${name}`);
      this.tools.set(name, { config, handler });
    }
    async connect(transport: unknown) {
      this.connected.push(transport);
    }
  }
  return {
    ...actual,
    McpServer,
    createMcpHandler: (factory: () => unknown) => {
      state.factory = factory;
      return {
        close: async () => {
          state.handlerClosed++;
        },
      };
    },
  };
});

vi.mock("@modelcontextprotocol/server/stdio", () => ({
  StdioServerTransport: class StdioServerTransport {
    readonly kind = "stdio";
  },
}));

vi.mock("@modelcontextprotocol/express", () => ({
  createMcpExpressApp: (options: unknown) => {
    state.appOptions = options;
    return {
      all: (...args: unknown[]) => {
        state.routes.push(args);
      },
      listen: (port: number, host: string, callback?: () => void) => {
        state.listen = { port, host };
        callback?.();
        return {
          close: () => {
            state.httpClosed++;
          },
        };
      },
    };
  },
  requireBearerAuth: (options: { verifier: typeof state.verifier }) => {
    state.verifier = options.verifier;
    return state.authMiddleware;
  },
}));

vi.mock("@modelcontextprotocol/node", () => ({
  toNodeHandler: () => state.nodeHandler,
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const timingSafeEqual = (a: Buffer, b: Buffer) => {
    state.timingSafeEqualCalls.push([a, b]);
    return actual.timingSafeEqual(a, b);
  };
  return { ...actual, default: { ...actual, timingSafeEqual }, timingSafeEqual };
});

const ACCESS_TOKEN = "chatwoot-user-token-should-not-leak";
const MCP_TOKEN = "m".repeat(40);

type Level = "read_only" | "read_write" | "full";

let stderr: ReturnType<typeof vi.spyOn>;
let stdout: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  state.servers.length = 0;
  state.routes.length = 0;
  state.timingSafeEqualCalls.length = 0;
  state.factory = undefined;
  state.verifier = undefined;
  state.listen = undefined;
  state.appOptions = undefined;
  state.handlerClosed = 0;
  state.httpClosed = 0;
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  stdout = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

async function start(env: Record<string, string | undefined>) {
  const defaults: Record<string, string | undefined> = {
    CHATWOOT_BASE_URL: "http://localhost:3100",
    CHATWOOT_API_ACCESS_TOKEN: ACCESS_TOKEN,
    CHATWOOT_ACCOUNT_ID: "1",
    CHATWOOT_ACCESS_LEVEL: "read_only",
    CHATWOOT_TIMEZONE_OFFSET: undefined,
    TRANSPORT: "stdio",
    HOST: undefined,
    PORT: undefined,
    MCP_AUTH_TOKEN: undefined,
    MCP_ALLOWED_HOSTS: undefined,
  };
  for (const [key, value] of Object.entries({ ...defaults, ...env })) vi.stubEnv(key, value);
  vi.resetModules();
  await import("../src/index.js");
}

async function toolsFor(level: Level) {
  state.servers.length = 0;
  await start({ CHATWOOT_ACCESS_LEVEL: level });
  expect(state.servers).toHaveLength(1);
  return state.servers[0]!.tools;
}

const DELETE_TOOLS = ["chatwoot_delete_record", "chatwoot_delete_contact", "chatwoot_delete_message", "chatwoot_merge_contacts"];

describe("CHATWOOT_ACCESS_LEVEL ごとに登録するツール", () => {
  it("read_only は参照系 17 ツールだけで、すべて readOnlyHint=true", async () => {
    const tools = await toolsFor("read_only");
    expect(tools.size).toBe(17);
    for (const [name, { config }] of tools) expect(config.annotations.readOnlyHint, name).toBe(true);
  });

  it("read_write は read_only の全ツール + 作成・更新 11 ツールで、削除・統合は登録しない", async () => {
    const readOnly = [...(await toolsFor("read_only")).keys()];
    const tools = await toolsFor("read_write");
    expect(tools.size).toBe(28);
    for (const name of readOnly) expect(tools.has(name), name).toBe(true);
    const added = [...tools.keys()].filter((name) => !readOnly.includes(name));
    expect(added).toHaveLength(11);
    expect(added).toEqual(expect.arrayContaining(["chatwoot_send_message", "chatwoot_add_private_note"]));
    for (const name of added) expect(tools.get(name)!.config.annotations.readOnlyHint, name).toBe(false);
    for (const name of DELETE_TOOLS) expect(tools.has(name), name).toBe(false);
  });

  it("full は read_write の全ツール + 削除・統合 4 ツールで、追加分はすべて destructiveHint=true", async () => {
    const readWrite = [...(await toolsFor("read_write")).keys()];
    const tools = await toolsFor("full");
    expect(tools.size).toBe(32);
    for (const name of readWrite) expect(tools.has(name), name).toBe(true);
    const added = [...tools.keys()].filter((name) => !readWrite.includes(name));
    expect(added.sort()).toEqual([...DELETE_TOOLS].sort());
    for (const name of added) expect(tools.get(name)!.config.annotations.destructiveHint, name).toBe(true);
  });

  it("どのツールにもタイトル・説明・入力スキーマ・注釈があり、名前は chatwoot_ で始まる", async () => {
    for (const [name, { config }] of await toolsFor("full")) {
      expect(name).toMatch(/^chatwoot_/);
      expect(config.title, name).toBeTruthy();
      expect((config.description as string).length, name).toBeGreaterThanOrEqual(40);
      expect(config.inputSchema, name).toBeDefined();
      expect(config.annotations, name).toBeDefined();
    }
  });

  it("destructiveHint はすべてのツールで明示され、readOnlyHint=true のツールでは false", async () => {
    for (const [name, { config }] of await toolsFor("full")) {
      expect(typeof config.annotations.destructiveHint, name).toBe("boolean");
      if (config.annotations.readOnlyHint) expect(config.annotations.destructiveHint, name).toBe(false);
    }
  });
});

describe("stdio トランスポート", () => {
  it("SERVER_NAME / SERVER_VERSION でサーバを作り、StdioServerTransport につなぐ", async () => {
    await start({});
    const server = state.servers[0]!;
    expect(server.info).toEqual({ name: "chatwoot-mcp-server", version: "0.1.0" });
    expect(server.connected).toHaveLength(1);
    expect((server.connected[0] as { kind: string }).kind).toBe("stdio");
  });

  it("起動ログは stderr にだけ出し（stdout は MCP の通信用）、アクセストークンを含めない", async () => {
    await start({ CHATWOOT_ACCESS_LEVEL: "full" });
    expect(stdout).not.toHaveBeenCalled();
    const output = stderr.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(output).toContain("running on stdio");
    expect(output).toContain("access: full");
    expect(output).not.toContain(ACCESS_TOKEN);
  });
});

describe("HTTP トランスポート", () => {
  function startHttp(env: Record<string, string | undefined> = {}) {
    vi.spyOn(process, "on").mockImplementation(() => process);
    return start({ TRANSPORT: "http", MCP_AUTH_TOKEN: MCP_TOKEN, ...env });
  }

  it("/mcp の前段に Bearer 認証を置き、HOST・PORT・MCP_ALLOWED_HOSTS で待ち受ける", async () => {
    await startHttp({ HOST: "0.0.0.0", PORT: "4100", MCP_ALLOWED_HOSTS: "mcp.example.com" });
    expect(state.appOptions).toEqual({ host: "0.0.0.0", allowedHosts: ["mcp.example.com"] });
    expect(state.routes).toHaveLength(1);
    expect(state.routes[0]![0]).toBe("/mcp");
    expect(state.routes[0]![1]).toBe(state.authMiddleware);
    expect(state.listen).toEqual({ port: 4100, host: "0.0.0.0" });
  });

  it("サーバはリクエストごとに作る（起動時には作らず、createMcpHandler に工場関数を渡す）", async () => {
    await startHttp({ CHATWOOT_ACCESS_LEVEL: "read_write" });
    expect(state.servers).toHaveLength(0);
    state.factory!();
    expect(state.servers).toHaveLength(1);
    expect(state.servers[0]!.tools.size).toBe(28);
  });

  it("正しいトークンなら、SDK が要求する有効期限付きの AuthInfo を返す", async () => {
    await startHttp();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
    const info = await state.verifier!.verifyAccessToken(MCP_TOKEN);
    expect(info).toEqual({ token: MCP_TOKEN, clientId: "mcp-client", scopes: [], expiresAt: Date.parse("2026-10-05T00:00:00Z") / 1000 + 3600 });
  });

  it("SDK の verifyBearerToken を通しても受け付けられる（期限切れ扱いにならない）", async () => {
    await startHttp();
    const { verifyBearerToken } = await import("@modelcontextprotocol/server");
    await expect(verifyBearerToken(`Bearer ${MCP_TOKEN}`, { verifier: state.verifier as never })).resolves.toMatchObject({ clientId: "mcp-client" });
  });

  it("誤ったトークンは OAuthError（invalid_token）で拒否する", async () => {
    await startHttp();
    const { OAuthError, OAuthErrorCode } = await import("@modelcontextprotocol/server");
    const error = await state.verifier!.verifyAccessToken("x".repeat(40)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OAuthError);
    expect((error as { code: unknown }).code).toBe(OAuthErrorCode.InvalidToken);
  });

  it("長さの違うトークンも RangeError ではなく OAuthError で拒否する（SHA-256 ダイジェスト同士を比較する）", async () => {
    await startHttp();
    const { OAuthError } = await import("@modelcontextprotocol/server");
    for (const token of ["short", MCP_TOKEN + "extra", ""]) {
      await expect(state.verifier!.verifyAccessToken(token)).rejects.toBeInstanceOf(OAuthError);
    }
  });

  it("比較は timingSafeEqual で、32 バイト（SHA-256）のダイジェスト同士を渡す", async () => {
    await startHttp();
    state.timingSafeEqualCalls.length = 0;
    await state.verifier!.verifyAccessToken("short").catch(() => {});
    await state.verifier!.verifyAccessToken(MCP_TOKEN);
    expect(state.timingSafeEqualCalls).toHaveLength(2);
    for (const [a, b] of state.timingSafeEqualCalls) {
      expect(a).toHaveLength(32);
      expect(b).toHaveLength(32);
    }
  });

  it("SIGINT / SIGTERM でハンドラと HTTP サーバを閉じる", async () => {
    const on = vi.spyOn(process, "on").mockImplementation(() => process);
    await start({ TRANSPORT: "http", MCP_AUTH_TOKEN: MCP_TOKEN });
    const signals = on.mock.calls.map(([event]) => event);
    expect(signals).toEqual(expect.arrayContaining(["SIGINT", "SIGTERM"]));
    const shutdown = on.mock.calls.find(([event]) => event === "SIGTERM")![1] as () => Promise<void>;
    await shutdown();
    expect(state.handlerClosed).toBe(1);
    expect(state.httpClosed).toBe(1);
  });

  it("起動ログにトークンを含めない", async () => {
    await startHttp();
    const output = stderr.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(output).toContain("listening on http://127.0.0.1:3102/mcp");
    expect(output).not.toContain(MCP_TOKEN);
    expect(output).not.toContain(ACCESS_TOKEN);
  });
});
