import { describe, expect, it, vi } from "vitest";
import { buildSnapshot, FaqStore, FaqUnavailableError } from "../../src/faq/store.js";
import { jsonResponse, makeFaqDocument, makeFaqItem, sequenceFetch } from "../helpers/faq.js";

const URL_ = "https://comegin.com/faq.json";

function makeStore(fetchImpl: typeof fetch, clock = { now: 0 }) {
  const warn = vi.fn();
  const store = new FaqStore({ url: URL_, refreshMs: 600_000, timeoutMs: 1_500, fetchImpl, now: () => clock.now, warn });
  return { store, warn, clock };
}

describe("buildSnapshot", () => {
  describe("正常系", () => {
    it("id で引けて、索引は context と質問から作る", () => {
      const item = makeFaqItem({ id: "services-consulting-2", question: "契約の期間と解約を教えてください", context: "コンサル" });
      const snapshot = buildSnapshot([item], 5);
      expect(snapshot.byId.get("services-consulting-2")).toBe(item);
      expect(snapshot.index[0]?.g2.has("コン")).toBe(true);
      expect(snapshot.loadedAt).toBe(5);
    });

    it("空入力: 0 件でも作れる（読み込みでは弾く）", () => {
      expect(buildSnapshot([], 0).items).toEqual([]);
    });
  });
});

describe("FaqStore.current", () => {
  describe("正常系", () => {
    it("初回に取得して索引を返す", async () => {
      const { store } = makeStore(sequenceFetch(jsonResponse(makeFaqDocument([makeFaqItem()]))));
      const snapshot = await store.current();
      expect(snapshot.items.map((i) => i.id)).toEqual(["top-3"]);
    });

    it("更新間隔の内側では取り直さない", async () => {
      const fetchImpl = sequenceFetch(jsonResponse(makeFaqDocument([makeFaqItem()])));
      const { store, clock } = makeStore(fetchImpl);
      await store.current();
      clock.now = 599_999;
      await store.current();
      expect(fetchImpl.calls).toBe(1);
    });

    it("更新間隔を過ぎたら取り直す", async () => {
      const fetchImpl = sequenceFetch(
        jsonResponse(makeFaqDocument([makeFaqItem()])),
        jsonResponse(makeFaqDocument([makeFaqItem({ id: "top-4" })])),
      );
      const { store, clock } = makeStore(fetchImpl);
      await store.current();
      clock.now = 600_000;
      expect((await store.current()).items[0]?.id).toBe("top-4");
    });

    it("同時の呼び出しでは 1 回だけ取得する", async () => {
      const fetchImpl = sequenceFetch(jsonResponse(makeFaqDocument([makeFaqItem()])));
      const { store } = makeStore(fetchImpl);
      await Promise.all([store.current(), store.current()]);
      expect(fetchImpl.calls).toBe(1);
    });

    it("context が無い項目は null として受け付ける", async () => {
      const { id, question, answer, url } = makeFaqItem();
      const { store } = makeStore(sequenceFetch(jsonResponse(makeFaqDocument([{ id, question, answer, url } as never]))));
      expect((await store.current()).items[0]?.context).toBeNull();
    });
  });

  describe("異常系", () => {
    it("サーバ: 初回の取得に失敗したら FaqUnavailableError", async () => {
      const { store } = makeStore(sequenceFetch(new TypeError("fetch failed")));
      await expect(store.current()).rejects.toBeInstanceOf(FaqUnavailableError);
    });

    it("サーバ: 更新に失敗したら直前の索引を使い、警告を出す", async () => {
      const fetchImpl = sequenceFetch(jsonResponse(makeFaqDocument([makeFaqItem()])), jsonResponse({ error: "x" }, 503));
      const { store, clock, warn } = makeStore(fetchImpl);
      await store.current();
      clock.now = 600_000;
      expect((await store.current()).items[0]?.id).toBe("top-3");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("HTTP 503"));
    });

    it("サーバ: 更新に失敗したら次の更新間隔まで取り直さない", async () => {
      const fetchImpl = sequenceFetch(jsonResponse(makeFaqDocument([makeFaqItem()])), new TypeError("fetch failed"));
      const { store, clock } = makeStore(fetchImpl);
      await store.current();
      clock.now = 600_000;
      await store.current();
      clock.now = 600_001;
      await store.current();
      expect(fetchImpl.calls).toBe(2);
    });

    it("サーバ: CloudFront が HTML を 200 で返したら直前の索引を使う", async () => {
      const html = new Response("<!doctype html><title>Error</title>", { status: 200, headers: { "Content-Type": "text/html" } });
      const fetchImpl = sequenceFetch(jsonResponse(makeFaqDocument([makeFaqItem()])), html);
      const { store, clock, warn } = makeStore(fetchImpl);
      await store.current();
      clock.now = 600_000;
      expect((await store.current()).items[0]?.id).toBe("top-3");
      expect(warn).toHaveBeenCalled();
    });

    it("入力: version が 1 でなければ受け付けない", async () => {
      const { store } = makeStore(sequenceFetch(jsonResponse({ ...(makeFaqDocument([makeFaqItem()]) as object), version: 2 })));
      await expect(store.current()).rejects.toBeInstanceOf(FaqUnavailableError);
    });

    it("空入力: items が 0 件なら受け付けない", async () => {
      const { store } = makeStore(sequenceFetch(jsonResponse(makeFaqDocument([]))));
      await expect(store.current()).rejects.toBeInstanceOf(FaqUnavailableError);
    });

    it("入力: id が重複していたら受け付けない", async () => {
      const { store } = makeStore(sequenceFetch(jsonResponse(makeFaqDocument([makeFaqItem(), makeFaqItem()]))));
      await expect(store.current()).rejects.toBeInstanceOf(FaqUnavailableError);
    });

    it("入力: url が http・https でなければ受け付けない", async () => {
      const { store } = makeStore(sequenceFetch(jsonResponse(makeFaqDocument([makeFaqItem({ url: "javascript:alert(1)" })]))));
      await expect(store.current()).rejects.toBeInstanceOf(FaqUnavailableError);
    });
  });
});
