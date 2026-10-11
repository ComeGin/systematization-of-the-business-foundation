import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureStderr, DB_PASSWORD, mockExit, SECRET, stubValidEnv } from "./helpers/env.js";

// node:http・better-auth/node・auth・db・allowlist はすべて偽物に差し替える（待ち受けず、DB にも繋がない）。
// 偽物の状態（handler・server）は vi.hoisted に持ち、テストごとに beforeEach で作り直す
type Handler = (req: FakeRequest, res: FakeResponse) => void;

const mocks = vi.hoisted(() => ({
  handler: undefined as unknown as Handler,
  server: undefined as unknown as Record<string, ReturnType<typeof vi.fn> | number>,
  authHandler: vi.fn(),
  createAuth: vi.fn(() => ({ auth: true })),
  bootstrapAllowlist: vi.fn(),
  pool: { end: vi.fn() },
}));

vi.mock("node:http", () => ({
  default: {
    createServer: (handler: Handler) => {
      mocks.handler = handler;
      return mocks.server;
    },
  },
}));
vi.mock("better-auth/node", () => ({ toNodeHandler: () => mocks.authHandler }));
vi.mock("../src/auth.js", () => ({ createAuth: mocks.createAuth }));
vi.mock("../src/db.js", () => ({ createPool: () => mocks.pool }));
vi.mock("../src/allowlist.js", () => ({ bootstrapAllowlist: mocks.bootstrapAllowlist }));

interface FakeRequest {
  method: string;
  url: string | undefined;
}

class FakeResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  headersSent = false;
  body = "";
  writeHead(status: number, headers: Record<string, string>) {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }
  end(body = "") {
    this.body += body;
    this.emit("finish");
    return this;
  }
}

let signals: Map<string, () => void>;
let stderr: ReturnType<typeof captureStderr>;

async function load() {
  vi.resetModules();
  await import("../src/index.js");
}

function request(method: string, url: string | undefined) {
  const req: FakeRequest = { method, url };
  const res = new FakeResponse();
  mocks.handler(req, res);
  return { req, res };
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
  mocks.authHandler.mockReset().mockResolvedValue(undefined);
  mocks.createAuth.mockClear();
  mocks.bootstrapAllowlist.mockReset().mockResolvedValue(1);
  mocks.pool.end.mockReset().mockResolvedValue(undefined);
});

describe("起動", () => {
  describe("正常系", () => {
    it("許可リストの初期値を追加してから、設定のホストとポートで待ち受ける", async () => {
      vi.stubEnv("PORT", "4555");
      vi.stubEnv("HOST", "127.0.0.1");
      await load();
      expect(mocks.bootstrapAllowlist).toHaveBeenCalledWith(mocks.pool, ["a@comegin.com"]);
      expect(mocks.server.listen).toHaveBeenCalledWith(4555, "127.0.0.1", expect.any(Function));
      expect(stderr.text()).toContain("allowlist bootstrap: 1 added");
      expect(stderr.text()).toContain("issuer http://localhost:3103/api/auth");
    });

    it("ALB のアイドルタイムアウト（60 秒）より長い keep-alive にする", async () => {
      await load();
      expect(mocks.server.keepAliveTimeout).toBeGreaterThan(60_000);
      expect(mocks.server.headersTimeout).toBeGreaterThan(mocks.server.keepAliveTimeout as number);
      expect(mocks.server.requestTimeout).toBe(30_000);
    });

    it("空入力: ADMIN_BOOTSTRAP_EMAILS が空なら、空の一覧を渡して（0 件追加で）そのまま起動する", async () => {
      vi.stubEnv("ADMIN_BOOTSTRAP_EMAILS", "");
      mocks.bootstrapAllowlist.mockResolvedValue(0);
      await load();
      expect(mocks.bootstrapAllowlist).toHaveBeenCalledWith(mocks.pool, []);
      expect(stderr.text()).toContain("allowlist bootstrap: 0 added");
      expect(mocks.server.listen).toHaveBeenCalledTimes(1);
    });

    it("起動のログにシークレットと DB のパスワードを出さない", async () => {
      await load();
      expect(stderr.text()).not.toContain(SECRET);
      expect(stderr.text()).not.toContain(DB_PASSWORD);
    });
  });

  describe("異常系", () => {
    it("サーバ: 許可リストの表に届かないときは、原因を出して exit(1) し、待ち受けない", async () => {
      mocks.bootstrapAllowlist.mockRejectedValue(new Error('relation "admin_allowlist" does not exist'));
      mockExit();
      await expect(load()).rejects.toThrow("process.exit(1)");
      expect(stderr.text()).toContain("run db:migrate first");
      expect(mocks.createAuth).not.toHaveBeenCalled();
      expect(mocks.server.listen).not.toHaveBeenCalled();
    });

    it("サーバ: DB に繋がらないときも exit(1) し、ログにシークレットと DB のパスワードを出さない", async () => {
      mocks.bootstrapAllowlist.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:5432"));
      mockExit();
      await expect(load()).rejects.toThrow("process.exit(1)");
      expect(stderr.text()).toContain("connect ECONNREFUSED");
      expect(stderr.text()).not.toContain(SECRET);
      expect(stderr.text()).not.toContain(DB_PASSWORD);
    });

    it("入力: 設定が不正なら、DB に触れる前に終了する", async () => {
      vi.stubEnv("BETTER_AUTH_SECRET", "short");
      mockExit();
      await expect(load()).rejects.toThrow("process.exit(1)");
      expect(mocks.bootstrapAllowlist).not.toHaveBeenCalled();
      expect(mocks.server.listen).not.toHaveBeenCalled();
    });

    it("空入力: 必須の環境変数が空なら、DB に触れる前に終了する", async () => {
      vi.stubEnv("DATABASE_HOST", "");
      mockExit();
      await expect(load()).rejects.toThrow("process.exit(1)");
      expect(stderr.text()).toContain("DATABASE_HOST");
      expect(mocks.bootstrapAllowlist).not.toHaveBeenCalled();
    });
  });
});

describe("ルーティング", () => {
  beforeEach(load);

  describe("正常系", () => {
    it("GET /healthz は DB を見ずに 200 ok を返す", () => {
      const { res } = request("GET", "/healthz");
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("ok");
      expect(res.headers["Cache-Control"]).toBe("no-store");
      expect(mocks.authHandler).not.toHaveBeenCalled();
    });

    it("HEAD /healthz も 200 を返す", () => {
      expect(request("HEAD", "/healthz").res.statusCode).toBe(200);
    });

    it("/api/auth/ 配下は Better Auth に渡す（メソッドを問わない）", () => {
      const { req } = request("POST", "/api/auth/oauth2/token");
      expect(mocks.authHandler).toHaveBeenCalledTimes(1);
      expect(mocks.authHandler.mock.calls[0]?.[0]).toBe(req);
      expect(req.url).toBe("/api/auth/oauth2/token");
    });

    it("ルート直下の openid-configuration は、クエリを保ったまま issuer 配下の別名に書き換えて渡す", () => {
      const { req } = request("GET", "/.well-known/openid-configuration?x=1");
      expect(req.url).toBe("/api/auth/.well-known/openid-configuration?x=1");
      expect(mocks.authHandler).toHaveBeenCalledTimes(1);
    });

    it("ルート直下の oauth-authorization-server も issuer 配下に書き換える", () => {
      const { req } = request("GET", "/.well-known/oauth-authorization-server");
      expect(req.url).toBe("/api/auth/.well-known/oauth-authorization-server");
    });

    it("RFC 8414 の issuer を後ろに付ける形は、書き換えずにそのまま渡す", () => {
      const { req } = request("GET", "/.well-known/oauth-authorization-server/api/auth");
      expect(req.url).toBe("/.well-known/oauth-authorization-server/api/auth");
      expect(mocks.authHandler).toHaveBeenCalledTimes(1);
    });

    it("GET /sign-in はログイン画面を、CSP とキャッシュ禁止のヘッダー付きで返す", () => {
      const { res } = request("GET", "/sign-in?client_id=a&sig=s");
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("管理画面へのログイン");
      expect(res.headers).toMatchObject({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      expect(res.headers["Content-Security-Policy"]).toContain("default-src 'none'");
    });

    it("GET /consent は同意画面を返す", () => {
      expect(request("GET", "/consent").res.body).toContain("skip_consent");
    });

    it("GET /error は error クエリに応じた文言を返す", () => {
      expect(request("GET", "/error?error=FORBIDDEN").res.body).toContain("許可リスト");
    });

    it("空入力: GET /error に error クエリが無ければ既定の文言を返す", () => {
      const { res } = request("GET", "/error");
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("ログインに失敗しました");
    });

    it("空入力: リクエストターゲットが無い（undefined）ときは / として扱い、404 を返す", () => {
      const { res } = request("GET", undefined);
      expect(res.statusCode).toBe(404);
      expect(mocks.authHandler).not.toHaveBeenCalled();
    });
  });

  describe("異常系", () => {
    it("入力: POST /healthz は 404", () => {
      expect(request("POST", "/healthz").res.statusCode).toBe(404);
    });

    it("入力: /api/auth の末尾のスラッシュが無いもの・似た名前のパスは Better Auth に渡さない", () => {
      expect(request("GET", "/api/auth").res.statusCode).toBe(404);
      expect(request("GET", "/api/authx/jwks").res.statusCode).toBe(404);
      expect(mocks.authHandler).not.toHaveBeenCalled();
    });

    it("入力: GET 以外の discovery は書き換えない", () => {
      const { req } = request("POST", "/.well-known/openid-configuration");
      expect(req.url).toBe("/.well-known/openid-configuration");
    });

    it("入力: GET /error はクエリの値を埋め込まない", () => {
      const { res } = request("GET", `/error?error=${encodeURIComponent("<script>x</script>")}`);
      expect(res.body).not.toContain("<script>x</script>");
    });

    it("入力: POST /sign-in は 404", () => {
      expect(request("POST", "/sign-in").res.statusCode).toBe(404);
    });

    it("入力: 未知のパスは 404 not found", () => {
      const { res } = request("GET", "/admin");
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe("not found");
    });

    it("入力: 解釈できないリクエストターゲット（例 //[）は例外を投げずに 400 を返し、Better Auth に渡さない", () => {
      const { res } = request("GET", "//[");
      expect(res.statusCode).toBe(400);
      expect(res.body).toBe("bad request");
      expect(mocks.authHandler).not.toHaveBeenCalled();
    });

    it("サーバ: Better Auth がヘッダーを送る前に失敗したら 500 を返す", async () => {
      mocks.authHandler.mockRejectedValue(new Error("boom"));
      const { res } = request("GET", "/api/auth/jwks");
      await vi.waitFor(() => expect(res.statusCode).toBe(500));
      expect(res.body).toBe("internal error");
    });

    it("サーバ: Better Auth がヘッダーを送ったあとに失敗したら、応答を閉じるだけにする", async () => {
      const res = new FakeResponse();
      mocks.authHandler.mockImplementation(async (_req: unknown, r: FakeResponse) => {
        r.writeHead(200, {});
        throw new Error("boom");
      });
      const end = vi.spyOn(res, "end");
      mocks.handler({ method: "GET", url: "/api/auth/jwks" }, res);
      await vi.waitFor(() => expect(end).toHaveBeenCalled());
      expect(res.statusCode).toBe(200);
    });

    it("サーバ: Better Auth の DB の失敗（RDS の例外）でも、応答の本文に例外の中身を出さない", async () => {
      mocks.authHandler.mockRejectedValue(new Error(`password authentication failed: ${DB_PASSWORD}`));
      const { res } = request("POST", "/api/auth/oauth2/token");
      await vi.waitFor(() => expect(res.statusCode).toBe(500));
      expect(res.body).toBe("internal error");
      expect(res.body).not.toContain(DB_PASSWORD);
    });
  });
});

describe("アクセスログ", () => {
  beforeEach(load);

  describe("正常系", () => {
    it("JSON の 1 行で、メソッド・パス・ステータスを出し、クエリ（認可コードや署名）は出さない", () => {
      stderr.spy.mockClear();
      request("GET", "/sign-in?code=SECRETCODE&sig=SIGVALUE");
      const line = String(stderr.spy.mock.calls.at(-1)?.[0]);
      const entry = JSON.parse(line);
      expect(entry).toMatchObject({ method: "GET", path: "/sign-in", status: 200 });
      expect(typeof entry.ms).toBe("number");
      expect(line).not.toContain("SECRETCODE");
      expect(line).not.toContain("SIGVALUE");
    });

    it("Better Auth に渡した応答も、書き換え後のパスだけを記録し、クエリは記録しない", () => {
      mocks.authHandler.mockImplementation(async (_req: unknown, res: FakeResponse) => {
        res.writeHead(200, {});
        res.end("{}");
      });
      stderr.spy.mockClear();
      request("GET", "/.well-known/openid-configuration?state=STATEVALUE");
      const line = String(stderr.spy.mock.calls.at(-1)?.[0]);
      expect(JSON.parse(line).path).toBe("/api/auth/.well-known/openid-configuration");
      expect(line).not.toContain("STATEVALUE");
    });

    it("空入力: リクエストターゲットが無いときは、空のパスで記録する", () => {
      stderr.spy.mockClear();
      request("GET", undefined);
      const entry = JSON.parse(String(stderr.spy.mock.calls.at(-1)?.[0]));
      expect(entry).toMatchObject({ method: "GET", path: "", status: 404 });
    });
  });

  describe("異常系", () => {
    it("入力: 解釈できないリクエストターゲット（400）も記録し、クエリは記録しない", () => {
      stderr.spy.mockClear();
      request("GET", "//[?code=SECRETCODE");
      const line = String(stderr.spy.mock.calls.at(-1)?.[0]);
      expect(JSON.parse(line)).toMatchObject({ status: 400 });
      expect(line).not.toContain("SECRETCODE");
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

    it("SIGINT でも同じく止める", async () => {
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      signals.get("SIGINT")!();
      expect(mocks.server.close).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
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
