import { describe, expect, it } from "vitest";
import { createRuntime } from "../src/runtime.js";
import { makeConfig } from "./helpers/config.js";
import { jsonResponse, makeFaqDocument, makeFaqItem } from "./helpers/faq.js";
import { recordingFetch } from "./helpers/http.js";

describe("createRuntime", () => {
  describe("正常系", () => {
    it("FAQ を設定の FAQ_URL から読む", async () => {
      const { fetchImpl, calls } = recordingFetch(jsonResponse(makeFaqDocument([makeFaqItem()])));
      const runtime = createRuntime(makeConfig({ FAQ_URL: "https://comegin.com/faq.json" }), { fetchImpl });
      expect((await runtime.faq.current()).items).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://comegin.com/faq.json");
    });

    it("空入力: deps を省略しても組み立てられ、/healthz に答える", async () => {
      const runtime = createRuntime(makeConfig());
      expect((await runtime.handle({ method: "GET", path: "/healthz", headers: {}, body: Buffer.alloc(0) })).status).toBe(200);
    });
  });

  describe("異常系", () => {
    it("サーバ: FAQ の取得に失敗したら、faq.current が例外を投げる", async () => {
      const { fetchImpl } = recordingFetch(new TypeError("fetch failed"));
      const runtime = createRuntime(makeConfig(), { fetchImpl });
      await expect(runtime.faq.current()).rejects.toThrow("faq.json");
    });
  });
});
