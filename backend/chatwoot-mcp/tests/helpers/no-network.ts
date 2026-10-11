import { afterEach, beforeEach, expect, vi } from "vitest";

/**
 * 全テスト共通の安全柵（vitest.config.ts の setupFiles で読み込む）。
 * 各テストの前に global fetch を「呼ばれたら失敗する偽物」に差し替え、installFetch() を忘れたテストが
 * 実ネットワークや 127.0.0.1 で動いている開発環境の Chatwoot に届かないようにする。
 * restoreMocks で実装が外れないよう、vi.fn ではなく普通の関数で作る
 */
let unexpected: string[] = [];

beforeEach(() => {
  unexpected = [];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    unexpected.push(String(input));
    throw new Error("テストで fetch を差し替えずに呼び出しました（installFetch を使ってください）");
  });
});

afterEach(() => {
  expect(unexpected, "fetch を差し替えずに呼び出したテストがあります").toEqual([]);
});
