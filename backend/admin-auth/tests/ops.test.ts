import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOpsHandler, loadOpsContext, type OpsContext } from "../src/ops.js";
import { captureStderr, validEnv } from "./helpers/env.js";

const mocks = vi.hoisted(() => ({
  runMigrate: vi.fn(),
  registerAlbClient: vi.fn(),
  createAuth: vi.fn(() => ({ auth: true })),
  createAuthOptions: vi.fn(() => ({ options: true })),
}));
vi.mock("../src/operations.js", () => ({ runMigrate: mocks.runMigrate, registerAlbClient: mocks.registerAlbClient }));
vi.mock("../src/auth.js", () => ({ createAuth: mocks.createAuth, createAuthOptions: mocks.createAuthOptions }));

const ALB_SECRET = "alb-secret-0123456789abcdefghijklmnopq";
const ALB_ENV = { ALB_CLIENT_ID: "alb-admin-gate", ALB_PROTECTED_HOSTS: "chat.comegin.com", ADMIN_BOOTSTRAP_EMAILS: "a@comegin.com" };
const readSecrets = async (name: string) => (name === "ALB_CLIENT_SECRET" ? ALB_SECRET : `${name}-value-0123456789abcdefghijklmnop`);

let end: ReturnType<typeof vi.fn>;
let makePool: ReturnType<typeof vi.fn>;
let context: OpsContext;

beforeEach(async () => {
  captureStderr();
  end = vi.fn(async () => {});
  makePool = vi.fn(() => ({ end }) as never);
  context = await loadOpsContext({ ...validEnv(), ...ALB_ENV }, readSecrets);
  mocks.runMigrate.mockReset().mockResolvedValue({ createdTables: [], addedColumnsTables: [], bootstrapped: 1 });
  mocks.registerAlbClient.mockReset().mockResolvedValue({ outcome: "created", redirectUris: ["https://chat.comegin.com/oauth2/idpresponse"] });
});

describe("loadOpsContext", () => {
  describe("正常系", () => {
    it("秘密値を 3 つ読み（Google は読まない）、Google の設定を求めずに検証する", async () => {
      const readSecret = vi.fn(readSecrets);
      const ctx = await loadOpsContext({ ...validEnv({ NODE_ENV: "production" }), ...ALB_ENV }, readSecret);
      expect(readSecret.mock.calls.map((c) => c[0]).sort()).toEqual(["ALB_CLIENT_SECRET", "BETTER_AUTH_SECRET", "DB_PASSWORD"]);
      expect(ctx.alb.ALB_CLIENT_SECRET).toBe(ALB_SECRET);
      expect(ctx.config.ADMIN_BOOTSTRAP_EMAILS).toEqual(["a@comegin.com"]);
    });
  });

  describe("異常系", () => {
    it("入力: ALB の設定が足りなければ例外にし、終了しない", async () => {
      const exit = vi.spyOn(process, "exit");
      await expect(loadOpsContext(validEnv(), async () => ALB_SECRET)).rejects.toThrow("ALB_CLIENT_ID");
      expect(exit).not.toHaveBeenCalled();
    });
  });
});

describe("createOpsHandler", () => {
  describe("正常系", () => {
    it("migrate: 移行を実行し、結果を返して、プールを閉じる", async () => {
      const handler = createOpsHandler(async () => context, makePool);
      const result = await handler({ action: "migrate" });
      expect(result).toEqual({ ok: true, action: "migrate", result: { createdTables: [], addedColumnsTables: [], bootstrapped: 1 } });
      expect(mocks.runMigrate).toHaveBeenCalledWith(expect.anything(), { options: true }, ["a@comegin.com"]);
      expect(end).toHaveBeenCalledTimes(1);
    });

    it("register-alb-client: 既定は client_secret_basic・PKCE なし", async () => {
      const handler = createOpsHandler(async () => context, makePool);
      const result = await handler({ action: "register-alb-client" });
      expect(result).toMatchObject({ ok: true, action: "register-alb-client" });
      expect(mocks.registerAlbClient).toHaveBeenCalledWith({ auth: true }, context.alb, { authMethod: "client_secret_basic", requirePkce: false });
      expect(end).toHaveBeenCalledTimes(1);
    });

    it("register-alb-client: 認証方式と PKCE を指定できる", async () => {
      const handler = createOpsHandler(async () => context, makePool);
      await handler({ action: "register-alb-client", authMethod: "client_secret_post", requirePkce: true });
      expect(mocks.registerAlbClient.mock.calls[0]?.[2]).toEqual({ authMethod: "client_secret_post", requirePkce: true });
    });
  });

  describe("異常系", () => {
    it.each([
      ["知らない action", { action: "drop" }],
      ["余計な項目", { action: "migrate", extra: 1 }],
      ["不正な認証方式", { action: "register-alb-client", authMethod: "none" }],
      ["真偽値でない PKCE", { action: "register-alb-client", requirePkce: "yes" }],
    ])("入力: %s は、秘密値を読まずに ok: false を返す", async (_label, input) => {
      const load = vi.fn(async () => context);
      const result = await createOpsHandler(load, makePool)(input);
      expect(result.ok).toBe(false);
      expect(load).not.toHaveBeenCalled();
      expect(makePool).not.toHaveBeenCalled();
    });

    it("空入力: イベントが空・null でも ok: false を返す", async () => {
      const handler = createOpsHandler(async () => context, makePool);
      expect((await handler({})).ok).toBe(false);
      expect((await handler(null)).ok).toBe(false);
    });

    it("サーバ: 実行に失敗したら投げ（呼び出し元に FunctionError として見える）、プールは閉じる", async () => {
      mocks.runMigrate.mockRejectedValue(new Error("permission denied"));
      const handler = createOpsHandler(async () => context, makePool);
      await expect(handler({ action: "migrate" })).rejects.toThrow("permission denied");
      expect(end).toHaveBeenCalledTimes(1);
    });

    it("サーバ: 読み込みに失敗したら投げ、次の呼び出しでやり直す", async () => {
      const load = vi.fn<() => Promise<OpsContext>>().mockRejectedValueOnce(new Error("AccessDeniedException")).mockResolvedValue(context);
      const handler = createOpsHandler(load, makePool);
      await expect(handler({ action: "migrate" })).rejects.toThrow("AccessDeniedException");
      await expect(handler({ action: "migrate" })).resolves.toMatchObject({ ok: true });
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("入力: ok: false のエラーに入力の値を入れない", async () => {
      const result = await createOpsHandler(async () => context, makePool)({ action: "secret-value-xyz" });
      expect(JSON.stringify(result)).not.toContain("secret-value-xyz");
    });
  });
});
