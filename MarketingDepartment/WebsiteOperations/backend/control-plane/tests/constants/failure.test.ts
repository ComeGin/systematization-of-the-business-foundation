import { describe, expect, it } from "vitest";
import { type ClassifyInput, FAILURE_CLASSES, classifyResponse, isSuccessClass } from "../../src/constants/failure.js";

describe("isSuccessClass", () => {
  it("ok と empty_but_ok だけが取得の成功（E-13 の evidence に使える）", () => {
    expect(FAILURE_CLASSES.filter(isSuccessClass)).toEqual(["ok", "empty_but_ok"]);
  });
});

describe("classifyResponse（DD-01 の 4.4 の判定順）", () => {
  const base: ClassifyInput = { upstream: "other" };

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
    ["情報が無ければ ok", base, "ok"],
  ])("%s → %s", (_label, input, expected) => {
    expect(classifyResponse(input)).toBe(expected);
  });
});
