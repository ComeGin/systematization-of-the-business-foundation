// 動きの区分（motionZone）の検査。BaseLayout が <html data-motion-zone> に区分を出すこと。
//   A（vivid）＝ トップ・サービスの一覧と詳細 4 本 / B（calm）＝ ほか（既定）/ C（none）＝ 規約・ポリシー
// 後のタスクの部品（アバター・形のつながり・光の縁）はこの値を見て出す・出さないを決める。
import { expect, test } from "../support/fixtures";
import { open } from "./axe";
import { NOT_FOUND_ROUTE } from "./routes";

const ZONES: [string, "vivid" | "calm" | "none"][] = [
  ["/", "vivid"],
  ["/services/", "vivid"],
  ["/services/environment-setup/", "vivid"],
  ["/services/development/", "vivid"],
  ["/services/consulting/", "vivid"],
  ["/services/partnership/", "vivid"],
  ["/pricing/", "calm"],
  ["/blog/", "calm"],
  [NOT_FOUND_ROUTE, "calm"],
  ["/legal/privacy/", "none"],
  ["/legal/tokushoho/", "none"],
];

test.describe("motionZone", () => {
  test.describe("正常系", () => {
    for (const [route, zone] of ZONES) {
      test(`${route} は ${zone}`, async ({ page }) => {
        await open(page, route);
        await expect(page.locator("html")).toHaveAttribute("data-motion-zone", zone);
      });
    }

    // R20: C のページのヘッダーは静的な <nav> だけ（MotionNav〈GooeyNav〉を水和しない）。
    // Desktop（md 以上かつ hover あり）は、ほかのページなら GooeyNav が水和する条件なので、ここで確かめる
    for (const route of ["/legal/privacy/", "/legal/tokushoho/"]) {
      test(`${route} のヘッダーは静的な nav だけで、React の island も chunk も読まない`, async ({
        page,
      }, testInfo) => {
        test.skip(testInfo.project.name !== "desktop", "Desktop だけ（Mobile は元から水和しない）");
        const bodies: Promise<{ url: string; body: string }>[] = [];
        page.on("response", (response) => {
          const url = response.url();
          if (!/\.js(\?|$)/.test(url)) return;
          bodies.push(
            response
              .text()
              .catch(() => "")
              .then((body) => ({ url, body })),
          );
        });
        await open(page, route);
        await page.waitForTimeout(1_000);
        await expect(page.locator("astro-island")).toHaveCount(0);
        // ナビはほかのページと同じ名前・リンクで残る
        const nav = page.getByRole("navigation", { name: "メイン" });
        await expect(nav).toBeVisible();
        expect(await nav.getByRole("link").count()).toBeGreaterThan(0);
        const scripts = await Promise.all(bodies);
        // React の本体（react-dom・Astro の React の renderer）は、本番のビルドでもエラーの URL（react.dev/errors）を含む
        expect(
          scripts
            .filter(({ url, body }) => /GooeyNavIsland/.test(url) || body.includes("react.dev/errors"))
            .map(({ url }) => url),
          "React の chunk",
        ).toEqual([]);
      });
    }
  });
});
