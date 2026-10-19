import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// loadThree は three を読む唯一の入口（地球儀とアバターが同じチャンクを使う）。
// three は重いので実物は読まず、vi.mock で差し替える。モジュールの状態（読み込みの Promise）を各ケースで作り直すため、毎回 resetModules する。
// 公開関数 loadThree・canUseWebGL はどちらも引数が無いので、「空入力: 」のケースは置かない（空にできる入力が無い）。

async function importModule() {
  return import("@/modules/motion/lib/three");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("three");
  vi.unstubAllGlobals();
});

describe("loadThree", () => {
  describe("正常系", () => {
    it("2 回呼んでも同じオブジェクトが返る", async () => {
      vi.doMock("three", () => ({ marker: 1 }));
      const { loadThree } = await importModule();
      const first = await loadThree();
      const second = await loadThree();
      expect(first).toBe(second);
      expect(first).toMatchObject({ marker: 1 });
    });

    it("動的 import は 1 回だけ（同時に呼んでも Promise を使い回す）", async () => {
      const factory = vi.fn(() => ({ marker: 1 }));
      vi.doMock("three", factory);
      const { loadThree } = await importModule();
      const [a, b, c] = await Promise.all([loadThree(), loadThree(), loadThree()]);
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(factory).toHaveBeenCalledTimes(1);
    });
  });

  describe("異常系", () => {
    it("サーバ: 読み込みに失敗したら reject し、次の呼び出しで読み直す", async () => {
      vi.doMock("three", () => {
        throw new Error("チャンクの取得に失敗");
      });
      const { loadThree } = await importModule();
      // vitest は factory の例外を包んで投げ直すので、メッセージではなく「reject した」ことを見る
      await expect(loadThree()).rejects.toThrow();

      // 失敗した Promise を使い回さない（通信が戻った後に、ページを開き直さずに読めるようにする）
      vi.doMock("three", () => ({ marker: 2 }));
      await expect(loadThree()).resolves.toMatchObject({ marker: 2 });
    });
  });
});

describe("canUseWebGL", () => {
  const stubDocument = (getContext: () => unknown) =>
    vi.stubGlobal("document", {
      createElement: () => ({ getContext }),
    });

  describe("正常系", () => {
    it("webgl2 の文脈が取れれば true", async () => {
      stubDocument(() => ({}));
      const { canUseWebGL } = await importModule();
      expect(canUseWebGL()).toBe(true);
    });

    it("確かめた後に WEBGL_lose_context で文脈を解放する（確認用の文脈を残さない）", async () => {
      const loseContext = vi.fn();
      const getExtension = vi.fn((name: string) =>
        name === "WEBGL_lose_context" ? { loseContext } : null,
      );
      stubDocument(() => ({ getExtension }));
      const { canUseWebGL } = await importModule();
      expect(canUseWebGL()).toBe(true);
      expect(getExtension).toHaveBeenCalledWith("WEBGL_lose_context");
      expect(loseContext).toHaveBeenCalledTimes(1);
    });

    it("1 ページで 1 回だけ確かめる（2 回目からは覚えた結果を返し、canvas を作らない）", async () => {
      const createElement = vi.fn(() => ({ getContext: () => ({}) }));
      vi.stubGlobal("document", { createElement });
      const { canUseWebGL } = await importModule();
      expect(canUseWebGL()).toBe(true);
      expect(canUseWebGL()).toBe(true);
      expect(createElement).toHaveBeenCalledTimes(1);
    });
  });

  describe("異常系", () => {
    it("サーバ: document が無い（ビルド時・テスト）なら false", async () => {
      const { canUseWebGL } = await importModule();
      expect(canUseWebGL()).toBe(false);
    });

    it("入力: 文脈が取れない（WebGL 無効）なら false", async () => {
      stubDocument(() => null);
      const { canUseWebGL } = await importModule();
      expect(canUseWebGL()).toBe(false);
    });

    it("入力: getContext が例外を投げても false（落とさない）", async () => {
      stubDocument(() => {
        throw new Error("blocked");
      });
      const { canUseWebGL } = await importModule();
      expect(canUseWebGL()).toBe(false);
    });
  });
});
