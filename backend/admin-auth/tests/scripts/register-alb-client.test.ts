import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureStderr, DB_PASSWORD, mockExit, stubValidEnv } from "../helpers/env.js";

// auth（Better Auth のアダプター）と db はすべて偽物に差し替える（実 DB には繋がない）
const mocks = vi.hoisted(() => ({
  adapter: { findOne: vi.fn(), update: vi.fn(), create: vi.fn() },
  pool: { end: vi.fn() },
  createAuth: vi.fn(),
}));
vi.mock("../../src/auth.js", () => ({ createAuth: mocks.createAuth }));
vi.mock("../../src/db.js", () => ({ createPool: () => mocks.pool }));

const CLIENT_ID = "alb-admin-gate";
const CLIENT_SECRET = "alb-secret-0123456789abcdefghijklmnopq";
const HASHED = createHash("sha256").update(CLIENT_SECRET).digest("base64url");

const originalArgv = process.argv;
let stderr: ReturnType<typeof captureStderr>;

async function run(...args: string[]) {
  process.argv = ["node", "register-alb-client.js", ...args];
  vi.resetModules();
  await import("../../src/scripts/register-alb-client.js");
}

/** 登録済みの行（デフォルトの引数で登録したときと同じ内容） */
function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    clientId: CLIENT_ID,
    clientSecret: HASHED,
    name: "ALB (admin gate)",
    redirectUris: ["https://mautic.comegin.com/oauth2/idpresponse", "https://n8n.comegin.com/oauth2/idpresponse"],
    scopes: ["openid", "profile", "email"],
    tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    applicationType: "web",
    skipConsent: true,
    enableEndSession: false,
    requirePKCE: false,
    disabled: false,
    clientCredentialsScopes: [],
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  stubValidEnv({
    ALB_CLIENT_ID: CLIENT_ID,
    ALB_CLIENT_SECRET: CLIENT_SECRET,
    ALB_PROTECTED_HOSTS: "Mautic.comegin.com, n8n.comegin.com",
  });
  stderr = captureStderr();
  mocks.adapter.findOne.mockReset().mockResolvedValue(null);
  mocks.adapter.update.mockReset().mockResolvedValue(undefined);
  mocks.adapter.create.mockReset().mockResolvedValue(undefined);
  mocks.pool.end.mockReset().mockResolvedValue(undefined);
  mocks.createAuth.mockReset().mockReturnValue({ $context: Promise.resolve({ adapter: mocks.adapter }) });
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = undefined;
});

describe("新規の登録", () => {
  describe("正常系", () => {
    it("無ければ、ALB_CLIENT_ID の oauthClient の行を作る", async () => {
      await run();
      expect(mocks.adapter.findOne).toHaveBeenCalledWith({
        model: "oauthClient",
        where: [{ field: "clientId", value: CLIENT_ID }],
      });
      expect(mocks.adapter.update).not.toHaveBeenCalled();
      const { model, data } = mocks.adapter.create.mock.calls[0]![0];
      expect(model).toBe("oauthClient");
      expect(data).toMatchObject({ clientId: CLIENT_ID, clientDiscoveryId: null });
      expect(data.createdAt).toBeInstanceOf(Date);
      expect(stderr.text()).toContain(`created client ${CLIENT_ID}`);
    });

    it("シークレットは平文ではなく SHA-256 の base64url（パディングなし）で保存する", async () => {
      await run();
      const { data } = mocks.adapter.create.mock.calls[0]![0];
      expect(data.clientSecret).toBe(HASHED);
      expect(data.clientSecret).not.toContain("=");
      expect(JSON.stringify(data)).not.toContain(CLIENT_SECRET);
    });

    it("リダイレクト URI は保護するホストごとの https://<host>/oauth2/idpresponse（ホストは小文字）", async () => {
      await run();
      expect(mocks.adapter.create.mock.calls[0]![0].data.redirectUris).toEqual([
        "https://mautic.comegin.com/oauth2/idpresponse",
        "https://n8n.comegin.com/oauth2/idpresponse",
      ]);
    });

    it("既定は機密クライアント・認可コードだけ・同意の省略・PKCE を必須にしない・client_secret_basic", async () => {
      await run();
      expect(mocks.adapter.create.mock.calls[0]![0].data).toMatchObject({
        scopes: ["openid", "profile", "email"],
        tokenEndpointAuthMethod: "client_secret_basic",
        grantTypes: ["authorization_code"],
        responseTypes: ["code"],
        applicationType: "web",
        skipConsent: true,
        enableEndSession: false,
        requirePKCE: false,
        disabled: false,
        clientCredentialsScopes: [],
      });
    });

    it("シークレットを画面に出さない", async () => {
      await run();
      expect(stderr.text()).not.toContain(CLIENT_SECRET);
      expect(stderr.text()).not.toContain(HASHED);
    });

    it("終わったら DB の接続を閉じる", async () => {
      await run();
      expect(mocks.pool.end).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();
    });

    it("空入力: 引数が無いときは client_secret_basic・PKCE なしで登録する", async () => {
      await run();
      expect(mocks.adapter.create.mock.calls[0]![0].data).toMatchObject({
        tokenEndpointAuthMethod: "client_secret_basic",
        requirePKCE: false,
      });
      expect(stderr.text()).toContain("token_endpoint_auth_method=client_secret_basic require_pkce=false skip_consent=true");
    });
  });

  describe("異常系", () => {
    it("サーバ: 行の作成に失敗したら、メッセージを出して exitCode=1 にし、接続は閉じる", async () => {
      mocks.adapter.create.mockRejectedValue(new Error('duplicate key value violates unique constraint "oauthClient_pkey"'));
      await run();
      expect(stderr.text()).toContain("[alb] failed: duplicate key value");
      expect(stderr.text()).not.toContain("created client");
      expect(process.exitCode).toBe(1);
      expect(mocks.pool.end).toHaveBeenCalledTimes(1);
    });
  });
});

describe("オプション", () => {
  describe("正常系", () => {
    it("--auth-method=client_secret_post で認証方式を切り替える", async () => {
      await run("--", "--auth-method=client_secret_post");
      expect(mocks.adapter.create.mock.calls[0]![0].data.tokenEndpointAuthMethod).toBe("client_secret_post");
      expect(stderr.text()).toContain("token_endpoint_auth_method=client_secret_post");
    });

    it("--require-pkce で PKCE を必須にする", async () => {
      await run("--require-pkce");
      expect(mocks.adapter.create.mock.calls[0]![0].data.requirePKCE).toBe(true);
    });
  });

  describe("異常系", () => {
    it("入力: 不明なオプションでは、DB に触れずに exit(1) する", async () => {
      mockExit();
      await expect(run("--auth-method=none")).rejects.toThrow("process.exit(1)");
      expect(stderr.text()).toContain("不明なオプション: --auth-method=none");
      expect(mocks.createAuth).not.toHaveBeenCalled();
    });

    it("空入力: 空文字の引数も不明なオプションとして、DB に触れずに exit(1) する", async () => {
      mockExit();
      await expect(run("")).rejects.toThrow("process.exit(1)");
      expect(stderr.text()).toContain("不明なオプション: ");
      expect(mocks.createAuth).not.toHaveBeenCalled();
    });

    it("入力: ALB の設定が不正なら、DB に触れずに終了する", async () => {
      vi.stubEnv("ALB_PROTECTED_HOSTS", "https://mautic.comegin.com");
      mockExit();
      await expect(run()).rejects.toThrow("process.exit(1)");
      expect(mocks.createAuth).not.toHaveBeenCalled();
    });

    it("空入力: ALB_PROTECTED_HOSTS が空なら、DB に触れずに終了する", async () => {
      vi.stubEnv("ALB_PROTECTED_HOSTS", "");
      mockExit();
      await expect(run()).rejects.toThrow("process.exit(1)");
      expect(stderr.text()).toContain("ALB_PROTECTED_HOSTS");
      expect(mocks.createAuth).not.toHaveBeenCalled();
    });

    it("入力: ALB_CLIENT_SECRET が短いときは、値を出さずに、DB に触れずに終了する", async () => {
      vi.stubEnv("ALB_CLIENT_SECRET", "alb-short-secret");
      mockExit();
      await expect(run()).rejects.toThrow("process.exit(1)");
      expect(stderr.text()).toContain("ALB_CLIENT_SECRET");
      expect(stderr.text()).not.toContain("alb-short-secret");
      expect(mocks.createAuth).not.toHaveBeenCalled();
    });
  });
});

describe("登録済みのとき（冪等）", () => {
  describe("正常系", () => {
    it("同じ内容なら何も書かない（updatedAt も変えない）", async () => {
      mocks.adapter.findOne.mockResolvedValue(storedRow());
      await run();
      expect(mocks.adapter.update).not.toHaveBeenCalled();
      expect(mocks.adapter.create).not.toHaveBeenCalled();
      expect(stderr.text()).toContain(`unchanged client ${CLIENT_ID}`);
    });

    it("ホストが増えたら、同じ行を更新する", async () => {
      mocks.adapter.findOne.mockResolvedValue(storedRow({ redirectUris: ["https://mautic.comegin.com/oauth2/idpresponse"] }));
      await run();
      expect(mocks.adapter.create).not.toHaveBeenCalled();
      const { model, where, update } = mocks.adapter.update.mock.calls[0]![0];
      expect(model).toBe("oauthClient");
      expect(where).toEqual([{ field: "clientId", value: CLIENT_ID }]);
      expect(update.redirectUris).toHaveLength(2);
      expect(update.updatedAt).toBeInstanceOf(Date);
      expect(stderr.text()).toContain(`updated client ${CLIENT_ID}`);
    });

    it("シークレットが変わったら、新しいダイジェストに入れ替える", async () => {
      mocks.adapter.findOne.mockResolvedValue(storedRow({ clientSecret: "old-digest" }));
      await run();
      expect(mocks.adapter.update.mock.calls[0]![0].update.clientSecret).toBe(HASHED);
    });

    it("オプションで認証方式を変えたら更新する", async () => {
      mocks.adapter.findOne.mockResolvedValue(storedRow());
      await run("--auth-method=client_secret_post");
      expect(mocks.adapter.update).toHaveBeenCalledTimes(1);
    });

    it("無効にされていたクライアントは、再実行で有効に戻す", async () => {
      mocks.adapter.findOne.mockResolvedValue(storedRow({ disabled: true }));
      await run();
      expect(mocks.adapter.update.mock.calls[0]![0].update.disabled).toBe(false);
    });
  });

  describe("異常系", () => {
    it("サーバ: 想定外の形の行（項目が欠けている）は、同じ内容とみなさずに更新する", async () => {
      mocks.adapter.findOne.mockResolvedValue({ clientId: CLIENT_ID });
      await run();
      expect(mocks.adapter.update).toHaveBeenCalledTimes(1);
      expect(mocks.adapter.create).not.toHaveBeenCalled();
    });

    it("サーバ: 行の更新に失敗したら、exitCode=1 にし、接続は閉じる", async () => {
      mocks.adapter.findOne.mockResolvedValue(storedRow({ disabled: true }));
      mocks.adapter.update.mockRejectedValue(new Error("canceling statement due to statement timeout"));
      await run();
      expect(stderr.text()).toContain("[alb] failed: canceling statement due to statement timeout");
      expect(process.exitCode).toBe(1);
      expect(mocks.pool.end).toHaveBeenCalledTimes(1);
    });
  });
});

describe("失敗", () => {
  describe("異常系", () => {
    it("サーバ: DB の操作に失敗したら、メッセージを出して exitCode=1 にし、接続は閉じる", async () => {
      mocks.adapter.findOne.mockRejectedValue(new Error("connection refused"));
      await run();
      expect(stderr.text()).toContain("[alb] failed: connection refused");
      expect(process.exitCode).toBe(1);
      expect(mocks.pool.end).toHaveBeenCalledTimes(1);
    });

    it("サーバ: Better Auth の初期化（$context）に失敗しても、exitCode=1 にし、接続は閉じる", async () => {
      // 未処理の reject にならないよう、src が $context を読んだときに初めて reject する
      mocks.createAuth.mockReturnValue({
        get $context() {
          return Promise.reject(new Error('relation "jwks" does not exist'));
        },
      });
      await run();
      expect(stderr.text()).toContain('[alb] failed: relation "jwks" does not exist');
      expect(mocks.adapter.findOne).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(mocks.pool.end).toHaveBeenCalledTimes(1);
    });

    it("サーバ: 失敗のログにも、クライアントシークレットと DB のパスワードを出さない", async () => {
      mocks.adapter.findOne.mockRejectedValue(new Error("connection refused"));
      await run();
      expect(stderr.text()).not.toContain(CLIENT_SECRET);
      expect(stderr.text()).not.toContain(HASHED);
      expect(stderr.text()).not.toContain(DB_PASSWORD);
    });
  });
});
