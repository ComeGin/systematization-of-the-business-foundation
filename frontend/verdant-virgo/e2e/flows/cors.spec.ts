// 開発スタックの CORS の許可（ブラウザを使わない）。
// E2E のページの送信は、support/fixtures.ts が Origin を公開サイトのオリジン（SITE_URL）に置き換えて本物に転送する。
// その前提（開発スタックが公開サイトのオリジンを許し、それ以外を拒む）が崩れていないことを、ここで直接確かめる。
// 設定は setup が入れる（Mautic は dev/setup の cors_valid_domains、consent-api は環境変数の SITE_URL）。
import { expect, test } from "./support/fixtures";
import { DEV, allowedOrigin } from "./support/env";

const OTHER_ORIGIN = "https://e2e-not-allowed.example.com";

const preflight = (origin: string, method: string, headers: string) => ({
  method: "OPTIONS",
  headers: {
    origin,
    "access-control-request-method": method,
    "access-control-request-headers": headers,
  },
});

test.describe("開発スタックの CORS", () => {
  test.describe("正常系", () => {
    test("Mautic は公開サイトのオリジンからのフォーム送信のプリフライトを許す", async ({
      request,
    }) => {
      const res = await request.fetch(
        `${DEV.mautic}/form/submit?formId=1&ajax=1`,
        preflight(allowedOrigin(), "POST", "x-requested-with"),
      );
      expect(res.headers()["access-control-allow-origin"]).toBe(
        allowedOrigin(),
      );
    });

    test("consent-api は公開サイトのオリジンからのプリフライトに、資格情報つきの許可を返す", async ({
      request,
    }) => {
      const res = await request.fetch(
        `${DEV.consentApi}/v1/consent`,
        preflight(allowedOrigin(), "POST", "content-type"),
      );
      expect(res.status()).toBe(204);
      expect(res.headers()).toMatchObject({
        "access-control-allow-origin": allowedOrigin(),
        "access-control-allow-credentials": "true",
      });
    });
  });

  test.describe("異常系", () => {
    test("入力: 許可していないオリジンには、Mautic は Access-Control-Allow-Origin を返さない", async ({
      request,
    }) => {
      const res = await request.fetch(
        `${DEV.mautic}/form/submit?formId=1&ajax=1`,
        preflight(OTHER_ORIGIN, "POST", "x-requested-with"),
      );
      expect(res.headers()["access-control-allow-origin"]).toBeUndefined();
    });

    test("入力: 許可していないオリジンからの同意の記録は、consent-api が 403 で拒む（記録も Cookie も作らない）", async ({
      request,
    }) => {
      const res = await request.post(`${DEV.consentApi}/v1/consent`, {
        headers: { origin: OTHER_ORIGIN, "content-type": "application/json" },
        data: { state: "granted" },
      });
      expect(res.status()).toBe(403);
      expect(await res.json()).toEqual({ error: "origin_not_allowed" });
      expect(res.headers()["set-cookie"]).toBeUndefined();
    });
  });
});
