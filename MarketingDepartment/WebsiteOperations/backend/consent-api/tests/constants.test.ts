import { describe, expect, it } from "vitest";
import {
  HEADERS_TIMEOUT_MS,
  ID_PATTERN,
  KEEP_ALIVE_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  SHUTDOWN_TIMEOUT_MS,
  VALKEY_COMMAND_TIMEOUT_MS,
} from "../src/constants.js";

// 値の書き写しではなく、コメントに書かれた定数どうしの関係を確かめる
const ALB_IDLE_TIMEOUT_MS = 60_000;

describe("タイムアウトの関係", () => {
  describe("正常系", () => {
    it("keep-alive は ALB のアイドルタイムアウト（60 秒）より長い（短いと 502 になる）", () => {
      expect(KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(ALB_IDLE_TIMEOUT_MS);
    });

    it("headersTimeout は keep-alive より長い（Node の要件。逆だと keep-alive 中の接続がヘッダー待ちで切られる）", () => {
      expect(HEADERS_TIMEOUT_MS).toBeGreaterThan(KEEP_ALIVE_TIMEOUT_MS);
    });

    it("POST の Valkey への 2 往復（inspect と append）がともにタイムアウトしても、リクエストのタイムアウト前に 503 を返せる", () => {
      expect(VALKEY_COMMAND_TIMEOUT_MS * 2).toBeLessThan(REQUEST_TIMEOUT_MS);
    });

    it("停止の猶予は ECS の既定の stopTimeout（30 秒）に収まる", () => {
      expect(SHUTDOWN_TIMEOUT_MS).toBeLessThan(30_000);
    });
  });
});

describe("ID_PATTERN", () => {
  describe("正常系", () => {
    it("128 ビットの base64url（22 文字）を受け付ける", () => {
      expect(ID_PATTERN.test(Buffer.alloc(16, 0xff).toString("base64url"))).toBe(true);
      expect(ID_PATTERN.test("eAd5tbgdBQH8cAOA_oELjQ")).toBe(true);
    });
  });

  describe("異常系", () => {
    it.each([
      ["21 文字", "a".repeat(21)],
      ["23 文字", "a".repeat(23)],
      ["base64 のパディング", "eAd5tbgdBQH8cAOA_oEL=="],
      ["base64 の + と /", "eAd5tbgdBQH8cAOA+oEL/Q"],
      ["Cookie の区切り文字", "eAd5tbgdBQH8cAOA;oELjQ"],
      ["改行を含む", "eAd5tbgdBQH8cAOA_oELjQ\n"],
      ["全角の英数字", "ｅAd5tbgdBQH8cAOA_oELjQ"],
    ])("入力: %s は拒否する", (_label, value) => {
      expect(ID_PATTERN.test(value)).toBe(false);
    });

    it("空入力: 空文字は拒否する", () => {
      expect(ID_PATTERN.test("")).toBe(false);
    });
  });
});
