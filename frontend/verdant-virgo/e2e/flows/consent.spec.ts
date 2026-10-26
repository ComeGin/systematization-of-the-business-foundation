// Cookie の同意（DD-02 の 3.3・3.4・8 節）。同意バナーの操作が、Cookie・本物の consent-api の記録（Valkey）・
// 同意の対象（PostHog・Chatwoot）の読み込みにどう効くかを通す。
// consent-api の記録はテストの終わりに消す（API に削除が無いので valkey-cli。support/devstack.ts）。
import type { Page } from "@playwright/test";
import {
  consentCookie,
  expect,
  parseConsent,
  serverIssuedConsent,
  test,
} from "./support/fixtures";
import { consentRecord } from "./support/devstack";
import { E2E_BASE_URL } from "./support/env";

const BANNER_HEADING = "Cookie の利用について";

const banner = (page: Page) =>
  page.getByRole("heading", { name: BANNER_HEADING });

/** チャットの SDK（同意の対象）を読みに行ったか */
function watchChatSdk(page: Page) {
  const seen = { sdk: 0 };
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/packs/js/sdk.js") seen.sdk += 1;
  });
  return seen;
}

const policyVersion = (page: Page) =>
  page.locator("#comegin-consent-config").getAttribute("data-policy-version");

test.describe("Cookie の同意", () => {
  test.describe("正常系", () => {
    test("「同意する」で、Cookie と consent-api の記録が granted になり、PostHog とチャットを読み込む。次のページではバナーを出さない", async ({
      page,
      traffic,
      cleanup,
    }) => {
      const chat = watchChatSdk(page);
      await page.goto("/");
      await expect(banner(page)).toBeVisible();
      expect(traffic.posthogRequests).toBe(0);

      await page.getByRole("button", { name: "同意する" }).click();
      await expect(banner(page)).toBeHidden();

      const consent = await serverIssuedConsent(page, cleanup);
      expect(consent).toMatchObject({
        state: "granted",
        version: await policyVersion(page),
      });
      expect(traffic.consents).toEqual([
        expect.objectContaining({
          method: "POST",
          status: 201,
          body: '{"state":"granted"}',
        }),
      ]);
      expect(
        await consentRecord(`s=granted&v=${consent.version}&id=${consent.id}`),
      ).toMatchObject({
        state: "granted",
        policy_version: consent.version,
      });
      await expect.poll(() => traffic.posthogRequests).toBeGreaterThan(0);
      await expect.poll(() => chat.sdk).toBeGreaterThan(0);

      await page.goto("/pricing/");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(banner(page)).toBeHidden();
    });

    test("「同意しない」で、Cookie と記録が denied になり、PostHog もチャットも読み込まない", async ({
      page,
      traffic,
      cleanup,
    }) => {
      const chat = watchChatSdk(page);
      await page.goto("/");
      await page.getByRole("button", { name: "同意しない" }).click();
      await expect(banner(page)).toBeHidden();

      const consent = await serverIssuedConsent(page, cleanup);
      expect(consent.state).toBe("denied");
      expect(
        (await consentRecord(`s=denied&v=${consent.version}&id=${consent.id}`))
          .state,
      ).toBe("denied");

      await page.goto("/services/");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(traffic.posthogRequests).toBe(0);
      expect(chat.sdk).toBe(0);
    });

    test("フッターの「Cookie 設定」から撤回すると、同じ識別子に denied を積み、以後のページでは PostHog を読み込まない", async ({
      page,
      traffic,
      cleanup,
    }) => {
      await page.goto("/");
      await page.getByRole("button", { name: "同意する" }).click();
      const granted = await serverIssuedConsent(page, cleanup);

      await page
        .getByRole("contentinfo")
        .getByRole("button", { name: "Cookie 設定" })
        .click();
      await expect(banner(page)).toBeVisible();
      await page.getByRole("button", { name: "同意しない" }).click();
      await expect(banner(page)).toBeHidden();

      // 撤回は記録を消さずに積む（同じ識別子の Stream に denied が足される。3.3）
      await expect
        .poll(
          async () => parseConsent(await consentCookie(page.context())).state,
        )
        .toBe("denied");
      const withdrawn = parseConsent(await consentCookie(page.context()));
      expect(withdrawn.id).toBe(granted.id);
      await expect
        .poll(
          async () =>
            (
              await consentRecord(
                `s=denied&v=${withdrawn.version}&id=${withdrawn.id}`,
              )
            ).state,
        )
        .toBe("denied");
      expect(traffic.consents.map((c) => c.body)).toEqual([
        '{"state":"granted"}',
        '{"state":"denied"}',
      ]);

      const before = traffic.posthogRequests;
      await page.goto("/about/");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForLoadState("networkidle");
      expect(traffic.posthogRequests).toBe(before);
    });
  });

  test.describe("異常系", () => {
    test("入力: 古い版のポリシーに同意した Cookie は未同意として扱い、バナーを出し直して PostHog を読み込まない", async ({
      page,
      context,
      traffic,
    }) => {
      await context.addCookies([
        {
          name: "comegin_consent",
          value: "s=granted&v=2000-01-01",
          url: E2E_BASE_URL,
        },
      ]);
      await page.goto("/");
      await expect(banner(page)).toBeVisible();
      await page.waitForLoadState("networkidle");
      expect(traffic.posthogRequests).toBe(0);
    });

    test("入力: 形の壊れた Cookie は未同意として扱い、バナーを出す", async ({
      page,
      context,
      traffic,
    }) => {
      await context.addCookies([
        { name: "comegin_consent", value: "e2e-broken", url: E2E_BASE_URL },
      ]);
      await page.goto("/");
      await expect(banner(page)).toBeVisible();
      expect(traffic.posthogRequests).toBe(0);
    });

    test("入力: Cookie に他人の（サーバーが発行していない）識別子を入れて同意しても、サーバーは新しい識別子を発行する", async ({
      page,
      context,
      cleanup,
    }) => {
      const forged = "e2eForgedIdentifier0000";
      await context.addCookies([
        {
          name: "comegin_consent",
          value: `s=denied&v=2000-01-01&id=${forged}`,
          url: E2E_BASE_URL,
        },
      ]);
      await page.goto("/");
      await page.getByRole("button", { name: "同意する" }).click();
      await expect
        .poll(async () => parseConsent(await consentCookie(context)).id)
        .not.toBe(forged);
      await serverIssuedConsent(page, cleanup);
      expect(
        (await consentRecord(`s=granted&v=2000-01-01&id=${forged}`)).state,
      ).toBe("unset");
    });
  });
});
