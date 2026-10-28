// モーションの検査（計画書の検証 9。動きの規則 1〜8、WCAG 2.2.2・2.3.1・2.1.1・2.4.7・2.5.8・4.1.3・1.4.3）。
// 部品の約束（motion から 2026-10-18 に受けた内容）:
//   - 各ラッパーの根に data-motion="symbol|nav|gallery|blobs|send-status"。canvas は aria-hidden で、静止の代わりは常に DOM にある
//   - symbol・nav・blobs は md 以上かつ hover のある端末だけで読む（Mobile では読まない）
//   - reduced-motion では symbol と blobs は WebGL を作らず、blobs の一時停止ボタンも出さない。nav と gallery は操作しない限り rAF 0
//   - blobs は画面外・タブ非表示・一時停止で rAF を止める。一時停止は sessionStorage の motion:cta-blobs に 'paused'
//   - MorphGallery はネイティブのラジオ 3 つ（矢印キーで選ぶ）で、aria-live を持たない
// requestAnimationFrame は init script で包んで、実際に呼ばれたコールバックの数を数える。
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { CONSULT_TEXT, consultForm, fillConsult } from "../support/forms";
import { focusStep, liveRegionTexts, markTabbables } from "../support/dom";
import { open } from "./axe";
import { MOTION_PAUSE } from "../../src/modules/site-content/a11y";
import { cls, instrument, rafDuring } from "../support/motion";

const PAUSE_KEY = "motion:cta-blobs";

/**
 * CTA バナーの一時停止のボタン。トップには A のヒーロー（HeroBackdrop。2026-10-19）の一時停止のボタンもあり、
 * 名前（MOTION_PAUSE）が同じなので、blobs を持つバナー（aside）の中に絞る。ヒーローの側は motion-vivid.spec.ts が見る。
 * ボタンの持ち主は、A（トップ）では CtaGlow（Task 7。判断 R1。MotionBlobs は externalPause で自前のボタンを出さない）、B では MotionBlobs の island。
 * どちらでも 1 つのバナーに 1 つだけ
 */
const blobsButton = (page: Page, name: string) =>
  page
    .locator('aside:has([data-motion="blobs"])')
    .getByRole("button", { name });
const GALLERY_ROUTE = "/services/partnership/";

/**
 * CTA バナーの中の MotionBlobs（トップの 1-11）を画面に入れ、水和を待つ（client:visible なので画面に入ってから水和する）。
 * 水和の前後の commit で React が rAF を使うかもしれないので、終わってから少し置く（motion の注意。2026-10-18）
 */
async function showBlobs(page: Page) {
  const blobs = page.locator('[data-motion="blobs"]').first();
  await blobs.scrollIntoViewIfNeeded();
  await expect(blobs).toBeAttached();
  await page
    .waitForFunction(
      () => {
        const island = document
          .querySelector('[data-motion="blobs"]')
          ?.closest("astro-island");
        return !island || !island.hasAttribute("ssr");
      },
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(500);
  return blobs;
}

const desktopOnly = (name: string) =>
  test.skip(
    name !== "desktop",
    "symbol・nav・blobs は md 以上かつ hover のある端末だけ",
  );

test.describe("モーション", () => {
  test.beforeEach(async ({ page }) => instrument(page));
  // 2026-10-28: ヒーローの模型（diorama）の描画が、ページ全体の rAF の数に混ざらないよう、最初から止めて開く（模型は diorama.spec.ts で検査する）
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        sessionStorage.setItem("motion:diorama", "paused");
      } catch {}
    });
  });

  test.describe("正常系", () => {
    test("reduced-motion では 4 種とも静止し、rAF が呼ばれない（WebGL を作らず、一時停止のボタンも出さない）", async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await open(page, "/");
      // ShapeBlur は window の pointermove で起きるので、数える間はマウスを動かさない
      await showBlobs(page);
      expect(await rafDuring(page, 1_500), "トップ").toBe(0);
      await expect(
        page.locator(
          '[data-motion="symbol"] canvas, [data-motion="blobs"] canvas',
        ),
      ).toHaveCount(0);
      // ヒーローの一時停止のボタンも含め、ページに 1 つも無い
      await expect(
        page.getByRole("button", { name: MOTION_PAUSE.pause }),
      ).toHaveCount(0);
      // 2026-10-28: ヒーローのロゴの動き（MotionSymbol）は模型に替わった。静止の代わりは模型のポスター
      await expect(page.locator('[data-motion="diorama"] picture img')).toBeVisible();
      await open(page, GALLERY_ROUTE);
      expect(await rafDuring(page, 1_500), "MorphGallery").toBe(0);
    });

    test("MotionBlobs は Tab で届く一時停止のボタンで止まり、名前が「再開」に変わり、ページを移っても止まったまま", async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      await open(page, "/");
      await showBlobs(page);
      const pause = blobsButton(page, MOTION_PAUSE.pause);
      await expect(pause).toBeVisible();
      // Tab の順に入っている
      await markTabbables(page);
      await expect(pause).toHaveAttribute("data-e2e-tab", /\d+/);
      expect(await rafDuring(page, 1_000), "動いている間").toBeGreaterThan(0);

      await pause.focus();
      await page.keyboard.press("Enter");
      const resume = blobsButton(page, MOTION_PAUSE.resume);
      await expect(resume).toBeFocused();
      expect(
        await page.evaluate((key) => sessionStorage.getItem(key), PAUSE_KEY),
      ).toBe("paused");
      expect(await rafDuring(page, 1_500), "止めた後").toBe(0);

      await open(page, "/about/");
      await open(page, "/");
      await showBlobs(page);
      await expect(
        blobsButton(page, MOTION_PAUSE.resume),
      ).toBeVisible();
      expect(await rafDuring(page, 1_500), "ページを移った後").toBe(0);

      await blobsButton(page, MOTION_PAUSE.resume).focus();
      await page.keyboard.press("Space");
      await expect(
        blobsButton(page, MOTION_PAUSE.pause),
      ).toBeFocused();
    });

    test("MotionBlobs は画面の外とタブの非表示で描画を止める", async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      await open(page, "/");
      await showBlobs(page);
      expect(await rafDuring(page, 1_000), "画面の中").toBeGreaterThan(0);
      await page.evaluate(() => window.scrollTo(0, 0));
      // タブの非表示と同じく、止める前に予約済みだったフレームは数えない（待ちは 200ms が上限）
      await page.waitForTimeout(200);
      expect(await rafDuring(page, 1_500), "画面の外").toBe(0);
      await showBlobs(page);
      expect(await rafDuring(page, 1_000), "画面に戻した後").toBeGreaterThan(0);
      // タブの非表示を作る（ヘッドレスでは別のタブを前に出しても visibilityState が変わらないため、値とイベントを差し替える）
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "hidden",
        });
        Object.defineProperty(document, "hidden", {
          configurable: true,
          get: () => true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      // 止める前に予約済みだった 1 フレームは数えない
      await page.waitForTimeout(200);
      expect(await rafDuring(page, 1_500), "タブの非表示").toBe(0);
    });

    test("GooeyNav は Tab でフォーカスしたときも形が流れ、フォーカスリングが見える", async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      // 現在地の無いトップでは形自体が無いので、現在地のあるページで隣の項目へ Tab する。流れるのは aria-hidden の ul の clip-path
      await open(page, "/services/");
      const nav = page.locator('[data-motion="nav"]');
      const links = nav.locator("nav ul:not([aria-hidden]) a");
      await expect(links.first()).toBeVisible();
      const shapes = () =>
        nav.evaluate((root) =>
          [
            ...root.querySelectorAll(
              '[aria-hidden="true"], [aria-hidden="true"] *',
            ),
          ]
            .map(
              (el) =>
                `${el.getAttribute("style") ?? ""}|${el.getAttribute("class") ?? ""}`,
            )
            .join("\n"),
        );
      await links.nth(0).focus();
      await page.waitForTimeout(400);
      const before = await shapes();
      await page.keyboard.press("Tab");
      await page.waitForTimeout(400);
      expect(await shapes(), "形の位置・状態").not.toBe(before);
      const step = await focusStep(page);
      expect(step?.tag).toBe("a");
      expect(step?.visible, `フォーカスリング: ${step?.outline}`).toBe(true);
    });

    test("MorphGallery は日本語の名前のラジオで、矢印キーで写真が替わり、的が 24px 以上でフォーカスが見え、自動で読み上げない", async ({
      page,
    }) => {
      await open(page, GALLERY_ROUTE);
      const gallery = page.locator('[data-motion="gallery"]');
      const radios = gallery.getByRole("radio");
      await expect(radios).toHaveCount(3);
      await expect(gallery.getByRole("radiogroup")).toHaveAccessibleName(/\S/);
      for (let i = 0; i < 3; i++) {
        await expect(radios.nth(i)).toHaveAccessibleName(/[ぁ-んァ-ヶ一-龠]/);
      }
      await radios.nth(0).focus();
      await page.keyboard.press("ArrowRight");
      await expect(radios.nth(1)).toBeChecked();
      await expect(
        gallery.locator('[data-slide="1"][data-active]'),
      ).toBeAttached();
      await expect(gallery.locator('[data-slide="1"] img')).toBeVisible();
      const ring = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        return [el, el.closest("label"), el.parentElement].some((c) => {
          if (!c) return false;
          const s = getComputedStyle(c);
          return (
            (s.outlineStyle !== "none" &&
              Number.parseFloat(s.outlineWidth) > 0) ||
            s.boxShadow !== "none"
          );
        });
      });
      expect(ring, "フォーカスリング").toBe(true);
      const sizes = await gallery.locator("label").evaluateAll((labels) =>
        labels.map((l) => {
          const r = l.getBoundingClientRect();
          return Math.min(r.width, r.height);
        }),
      );
      expect(Math.min(...sizes), "的の大きさ（px）").toBeGreaterThanOrEqual(24);
      await expect(
        gallery.locator('[aria-live], [role="status"], [role="alert"]'),
      ).toHaveCount(0);
    });

    test("送信中の SendStatus は role=status で「送信中…」を 1 回だけ読み上げる", async ({
      page,
      net,
    }) => {
      net.mautic = "hang";
      await open(page, "/contact/");
      const form = await consultForm(page);
      await fillConsult(form);
      await form.getByRole("button", { name: CONSULT_TEXT.submit }).click();
      const status = page.locator('[data-motion="send-status"]');
      await expect(status).toHaveAttribute("role", "status");
      await expect(status).toHaveText(CONSULT_TEXT.submitting);
      expect(
        (await liveRegionTexts(page)).filter(
          (t) => t === CONSULT_TEXT.submitting,
        ),
      ).toHaveLength(1);
    });

    test("トップと MorphGallery のページで、動きのある部品が要因のレイアウトのずれ（CLS）が 0", async ({
      page,
    }, testInfo) => {
      for (const route of ["/", GALLERY_ROUTE]) {
        await open(page, route);
        // GooeyNav の canvas の寸法の変化は load の後 4 秒台に出たこともある（2026-10-19 の実測）
        await page.waitForTimeout(5_000);
        const value = await cls(page);
        // 合計は参考として記録する（Lighthouse の CLS のしきい値は lighthouserc.cjs のまま）
        testInfo.annotations.push({
          type: "CLS（合計）",
          description: `${route} ${value.total.toFixed(5)}`,
        });
        expect(value.motion, route).toBe(0);
      }
    });

    test("CTA バナーの文字は、MetaBalls を描いた状態でも地と 4.5:1 以上", async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      await open(page, "/");
      const blobs = await showBlobs(page);
      await page.waitForTimeout(1_500);
      const banner = blobs.locator("xpath=ancestor::aside[1]");
      const texts = banner.locator("h2, p");
      const count = await texts.count();
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        const text = texts.nth(i);
        const color = await text.evaluate((el) => getComputedStyle(el).color);
        // 文字を透明にして、文字の後ろの地（キャンバスを含む）だけを写す
        await text.evaluate((el) =>
          el.style.setProperty("color", "transparent", "important"),
        );
        const png = await text.screenshot({ animations: "disabled" });
        await text.evaluate((el) => el.style.removeProperty("color"));
        const min = await page.evaluate(
          async ({ b64, fg }) => {
            const img = new Image();
            img.src = `data:image/png;base64,${b64}`;
            await img.decode();
            const canvas = document.createElement("canvas");
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext("2d")!;
            ctx.drawImage(img, 0, 0);
            const data = ctx.getImageData(0, 0, img.width, img.height).data;
            const probe = document.createElement("canvas").getContext("2d")!;
            probe.fillStyle = fg;
            probe.fillRect(0, 0, 1, 1);
            const [fr, fgc, fb] = probe.getImageData(0, 0, 1, 1).data;
            const lum = (r: number, g: number, b: number) => {
              const f = (v: number) =>
                (v /= 255) <= 0.04045
                  ? v / 12.92
                  : ((v + 0.055) / 1.055) ** 2.4;
              return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
            };
            const lf = lum(fr, fgc, fb);
            let worst = 21;
            for (let p = 0; p < data.length; p += 16) {
              const lb = lum(data[p], data[p + 1], data[p + 2]);
              const ratio =
                (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);
              worst = Math.min(worst, ratio);
            }
            return worst;
          },
          { b64: png.toString("base64"), fg: color },
        );
        expect(min, `${i + 1} 番目の文字`).toBeGreaterThanOrEqual(4.5);
      }
    });
  });

  test.describe("正常系", () => {
    test("MetaBalls の粒の箱は CTA バナーの文字の右端から 24px 以上離れ、文字の後ろに置かない", async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      await open(page, "/");
      const blobs = await showBlobs(page);
      const box = await blobs
        .locator(":scope > div[aria-hidden]")
        .boundingBox();
      expect(box).not.toBeNull();
      const textRight = await blobs
        .locator("xpath=ancestor::aside[1]")
        .locator("h2, p")
        .evaluateAll((els) =>
          Math.max(
            ...els.map((el) => {
              // 文字の行の右端（ブロックの幅ではなく、文字そのものの範囲）
              const range = document.createRange();
              range.selectNodeContents(el);
              return Math.max(
                ...[...range.getClientRects()].map((r) => r.right),
              );
            }),
          ),
        );
      expect(box!.x - textRight).toBeGreaterThanOrEqual(24);
    });
  });

  test.describe("異常系", () => {
    test("入力: Mobile では ShapeBlur と GooeyNav の島を読み込まない", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "mobile", "Mobile の project だけ");
      const loaded: string[] = [];
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (/SymbolBlur|GooeyNav|ShapeBlur/.test(path)) loaded.push(path);
      });
      await open(page, "/");
      await page.waitForTimeout(1_000);
      expect(loaded).toEqual([]);
    });
  });
});
