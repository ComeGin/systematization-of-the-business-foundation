import { describe, expect, it } from "vitest";
import type { FailureClass } from "../../src/contract.js";
import { type ClassifyInput, FAILURE_CLASSES, classifyResponse, isSuccessClass } from "../../src/constants/failure.js";

describe("isSuccessClass", () => {
  describe("正常系", () => {
    it("ok と empty_but_ok だけが取得の成功（E-13 の evidence に使える）", () => {
      expect(FAILURE_CLASSES.filter(isSuccessClass)).toEqual(["ok", "empty_but_ok"]);
    });
  });

  describe("異常系", () => {
    it("空入力: 空文字・未定義の分類は成功にしない（型の外から来ても evidence に使わせない）", () => {
      expect(isSuccessClass("" as FailureClass)).toBe(false);
      expect(isSuccessClass(undefined as unknown as FailureClass)).toBe(false);
    });

    it("入力: 9 値に無い分類は成功にしない", () => {
      expect(isSuccessClass("OK" as FailureClass)).toBe(false);
    });
  });
});

describe("classifyResponse（DD-01 の 4.4 の判定順）", () => {
  const base: ClassifyInput = { upstream: "other" };

  // 純粋な分類関数で、どの入力も 9 値のどれかに当てはめる（異常で投げることは無い）ため正常系だけ
  describe("正常系", () => {
    it.each<[string, ClassifyInput, string]>([
      ["接続失敗はタイムアウトより先", { ...base, connectFailed: true, timedOut: true, status: 500 }, "unreachable"],
      ["タイムアウトはステータスより先", { ...base, timedOut: true, status: 429 }, "timeout"],
      ["429", { ...base, status: 429, truncated: true }, "rate_limited"],
      ["403", { ...base, status: 403 }, "permission_denied"],
      ["401（Chatwoot 以外）", { ...base, upstream: "mautic", status: 401 }, "auth_failed"],
      ["401（Chatwoot はトークン不正と権限不足を区別できない）", { ...base, upstream: "chatwoot", status: 401 }, "permission_denied"],
      ["truncated は非 2xx より先", { ...base, status: 500, truncated: true }, "truncated"],
      ["5xx", { ...base, status: 503 }, "invalid_response"],
      ["3xx も成功にしない", { ...base, status: 302 }, "invalid_response"],
      ["2xx でも解釈できなければ", { ...base, status: 200, parseable: false, count: 3 }, "invalid_response"],
      ["0 件", { ...base, status: 200, parseable: true, count: 0 }, "empty_but_ok"],
      ["件数あり", { ...base, status: 200, parseable: true, count: 3 }, "ok"],
    ])("%s → %s", (_label, input, expected) => {
      expect(classifyResponse(input)).toBe(expected);
    });

    it("空入力: upstream だけ（他の情報が無い）なら ok", () => {
      expect(classifyResponse(base)).toBe("ok");
    });

    it("空入力: 0 件の応答（count=0）は ok ではなく empty_but_ok", () => {
      expect(classifyResponse({ ...base, status: 204, count: 0 })).toBe("empty_but_ok");
    });

    it("status 0（fetch が応答を作れなかった）は 2xx でないので invalid_response", () => {
      expect(classifyResponse({ ...base, status: 0 })).toBe("invalid_response");
    });
  });
});
