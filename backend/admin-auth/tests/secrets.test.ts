import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { describe, expect, it, vi } from "vitest";
import { secretReader } from "../src/secrets.js";

describe("secretReader", () => {
  describe("正常系", () => {
    it("<接頭辞>/<名前> の Secret を GetSecretValue で読み、文字列を返す", async () => {
      const send = vi.fn().mockResolvedValue({ SecretString: "value-1" });
      const read = secretReader({ send } as never, "comegin/prod/admin-auth");
      await expect(read("DB_PASSWORD")).resolves.toBe("value-1");
      const command = send.mock.calls[0]![0] as GetSecretValueCommand;
      expect(command).toBeInstanceOf(GetSecretValueCommand);
      expect(command.input).toEqual({ SecretId: "comegin/prod/admin-auth/DB_PASSWORD" });
    });
  });

  describe("異常系", () => {
    it("空入力: 接頭辞が空なら、SDK を呼ばずに失敗する", async () => {
      const send = vi.fn();
      await expect(secretReader({ send } as never, "")("DB_PASSWORD")).rejects.toThrow("SECRETS_PREFIX");
      expect(send).not.toHaveBeenCalled();
    });

    it("サーバ: 文字列の値が無ければ失敗し、メッセージは Secret の名前だけ", async () => {
      const send = vi.fn().mockResolvedValue({ SecretBinary: new Uint8Array([1]) });
      await expect(secretReader({ send } as never, "p")("X")).rejects.toThrow("p/X に値が無い");
    });

    it("サーバ: SDK の例外（権限・NAT の断）はそのまま投げる", async () => {
      const send = vi.fn().mockRejectedValue(new Error("AccessDeniedException"));
      await expect(secretReader({ send } as never, "p")("X")).rejects.toThrow("AccessDeniedException");
    });
  });
});
