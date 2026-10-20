// 表示の検査（計画書の検証 4。WCAG 1.4.4・1.4.10・1.4.12、P-5 の reduced-motion）。
// - 幅 320px（1.4.10 のリフロー）: 全ルート。表示の幅は project に関係しないので desktop の project でだけ回す
// - 200% の拡大: ブラウザの 200% の拡大は、幅 1280px の窓で表示の幅が 640px になるのと同じなので、幅 640px で見る
// - 文字の間隔（1.4.12）: 200% と同時に当てる。重なりは機械で見つけにくいので Q2 の手動で見る
// - reduced-motion: transition・animation の時間が 10ms 以下（global.css が 0.01ms にする）
import { expect, test } from "../support/fixtures";
import {
  TEXT_SPACING_CSS,
  clippedText,
  horizontalOverflow,
  longMotions,
  settleAnimations,
} from "../support/dom";
import { open } from "./axe";
import { NOT_FOUND_ROUTE, distRoutes, templateRoutes } from "./routes";

const routes = [...distRoutes(), NOT_FOUND_ROUTE];

test.describe("表示", () => {
  test.describe("正常系", () => {
    for (const route of routes) {
      test(`幅 320px で ${route} に横スクロールが出ない`, async ({
        page,
      }, testInfo) => {
        test.skip(
          testInfo.project.name !== "desktop",
          "表示の幅の検査は 1 回でよい",
        );
        await page.setViewportSize({ width: 320, height: 640 });
        await open(page, route);
        expect(await horizontalOverflow(page)).toBe(0);
      });

      test(`200% の拡大と文字の間隔で ${route} の文字が切れず、横スクロールが出ない`, async ({
        page,
      }, testInfo) => {
        test.skip(
          testInfo.project.name !== "desktop",
          "表示の幅の検査は 1 回でよい",
        );
        await page.setViewportSize({ width: 640, height: 450 });
        await open(page, route);
        await page.addStyleTag({ content: TEXT_SPACING_CSS });
        expect
          .soft(await horizontalOverflow(page), "横スクロール（px）")
          .toBe(0);
        expect.soft(await clippedText(page), "切れている文字").toEqual([]);
      });
    }

    for (const route of [...templateRoutes(), NOT_FOUND_ROUTE]) {
      test(`reduced-motion で ${route} の transition と animation が実質 0 になる`, async ({
        page,
      }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await open(page, route);
        expect(await longMotions(page)).toEqual([]);
      });
    }
  });

  test.describe("異常系", () => {
    test("入力: 幅 320px で Mobile メニューを開いても、パネルが画面からはみ出さない", async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "mobile",
        "Mobile のメニューは mobile の project だけ",
      );
      await page.setViewportSize({ width: 320, height: 640 });
      await open(page, "/");
      await page.getByRole("button", { name: "メニューを開く" }).click();
      // 開く動き（右から 2.5rem）の途中を測らない
      await settleAnimations(page);
      const box = await page.locator("dialog#mobile-menu").boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      expect(await horizontalOverflow(page)).toBe(0);
    });

    test("入力: reduced-motion のまま Mobile メニューを開いても、開く動きが実質 0 になる", async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "mobile",
        "Mobile のメニューは mobile の project だけ",
      );
      await page.emulateMedia({ reducedMotion: "reduce" });
      await open(page, "/");
      await page.getByRole("button", { name: "メニューを開く" }).click();
      expect(await longMotions(page)).toEqual([]);
    });
  });
});
