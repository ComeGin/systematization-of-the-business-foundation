// ヒーローの「基盤の模型」（diorama）の検査（計画 docs/superpowers/plans/2026-10-28-hero-diorama.md の Task 5〜10）。
// 部品の約束（Task 5。眺める模型）:
//   - 根は [data-motion="diorama"]。最初の HTML にポスター（<picture> の img）があり、h1 は 3D を待たずに読める
//   - WebGL が使えて reduced-motion でなく、一時停止でなく、遅い端末でなければ、canvas（aria-hidden）に替わり、根に data-diorama-live="true"
//   - 一時停止（MotionPause。storageKey motion:diorama）で rAF が止まり、次のページでも最初から止まっている（data-motion-paused="true"、canvas を作らない）
//   - 端末の速さの判定は sessionStorage の diorama:quality に残る（{"live":bool,"dpr":n}）。検証用の VM は GPU が無く遅いので、
//     「動く」側の検査は判定済みの値（live）を先に置いてから開く。「遅い端末」の検査は CPU を絞って判定させる
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { cls, instrument, rafDuring } from "../support/motion";
import { open } from "./axe";
import { AXE_TAGS } from "./routes";
import { DIORAMA } from "../../src/modules/site-content/diorama";
import { MOTION_PAUSE, MOTION_PAUSE_TARGETS } from "../../src/modules/site-content/a11y";
import { CASES } from "../../src/modules/site-content/cases";
import { TOP } from "../../src/modules/site-content/top";

const ROOT = '[data-motion="diorama"]';
const LIVE_ROUTE = "/services/";
const NEXT_ROUTE = "/services/development/";
const QUALITY_KEY = "diorama:quality";

/** 端末の判定を「動かしてよい」に先に決めておく（検証用の VM は GPU が無いため） */
async function presetLive(page: Page) {
  await page.addInitScript((key) => {
    try {
      sessionStorage.setItem(key, JSON.stringify({ live: true, dpr: 1 }));
    } catch {}
  }, QUALITY_KEY);
}

/** three の実装（isWebGLRenderer）を含む JS の応答を数える */
function countThree(page: Page) {
  const box = { count: 0 };
  page.on("response", async (response) => {
    if (!/\.js(\?|$)/.test(response.url()) || !response.ok()) return;
    const body = await response.text().catch(() => "");
    if (body.includes("isWebGLRenderer")) box.count++;
  });
  return box;
}

test.describe("模型（眺める模型・サービス一覧）", () => {
  // 検証用の VM は GPU が無く、glb の展開とシェーダーの準備に 10 秒以上かかる（アバターも同じ three を読む）
  test.describe.configure({ timeout: 120_000 });
  test.describe("正常系", () => {
    test("WebGL があれば canvas に替わり、ポスターと入れ替わる間に模型のレイアウトのずれが 0", async ({
      page,
    }) => {
      await instrument(page);
      await presetLive(page);
      await open(page, LIVE_ROUTE);
      const root = page.locator(ROOT);
      await expect(root).toHaveAttribute("data-diorama-live", "true", {
        timeout: 90_000,
      });
      await expect(root.locator("canvas")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      // ポスターから canvas への入れ替えでレイアウトは動かない（丸めの誤差の 0.000001 程度は許す）
      expect((await cls(page)).motion).toBeLessThan(0.001);
    });

    test("一時停止で rAF が止まり、次のページでも最初から止まっていて canvas を作らない", async ({
      page,
    }) => {
      await instrument(page);
      await presetLive(page);
      await open(page, LIVE_ROUTE);
      const root = page.locator(ROOT);
      await expect(root).toHaveAttribute("data-diorama-live", "true", {
        timeout: 90_000,
      });
      await root.getByRole("button", { name: /動きを止める/ }).click();
      await expect(root).toHaveAttribute("data-motion-paused", "true");
      // アバターなど、ほかの部品の rAF が混ざらないよう、模型の canvas が描き直されないことを見る
      const before = await root
        .locator("canvas")
        .evaluate((c: HTMLCanvasElement) => c.dataset.frame ?? "");
      await rafDuring(page, 1_000);
      expect(
        await root
          .locator("canvas")
          .evaluate((c: HTMLCanvasElement) => c.dataset.frame ?? ""),
      ).toBe(before);
      await open(page, NEXT_ROUTE);
      await expect(page.locator(ROOT)).toHaveAttribute(
        "data-motion-paused",
        "true",
      );
      await page.waitForTimeout(3_000);
      await expect(page.locator(`${ROOT} canvas`)).toHaveCount(0);
    });

    test("canvas は aria-hidden で、axe の違反が 0", async ({ page }) => {
      await presetLive(page);
      await open(page, LIVE_ROUTE);
      await expect(page.locator(ROOT)).toHaveAttribute(
        "data-diorama-live",
        "true",
        { timeout: 90_000 },
      );
      const result = await new AxeBuilder({ page })
        .withTags(AXE_TAGS)
        .include(ROOT)
        .analyze();
      expect(result.violations.map((v) => v.id)).toEqual([]);
    });
  });

  test.describe("異常系", () => {
    test("入力: reduced-motion では three を読まず、ポスターのまま（一時停止のボタンも出ない）", async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await presetLive(page);
      const three = countThree(page);
      await open(page, LIVE_ROUTE);
      await page.waitForTimeout(4_000);
      const root = page.locator(ROOT);
      await expect(root.locator("canvas")).toHaveCount(0);
      await expect(root.locator("picture img")).toBeVisible();
      await expect(
        root.getByRole("button", { name: /動きを止める|動きを再開する/ }),
      ).toHaveCount(0);
      expect(three.count, "three を読んでいない").toBe(0);
    });

    test("入力: 遅い端末（フレームが 40ms を超える）はポスターに戻り、判定が sessionStorage に残る", async ({
      page,
    }) => {
      test.setTimeout(240_000);
      // 遅い端末: 読み込みは普通の速さのまま、描画のフレームの間隔だけを 60ms に引き延ばす（CPU を絞ると読み込みが終わらない）
      await page.addInitScript(() => {
        const original = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (callback) => original(() => setTimeout(() => callback(performance.now()), 60) as unknown as number);
      });
      await open(page, LIVE_ROUTE);
      const root = page.locator(ROOT);
      await expect
        .poll(
          () =>
            page.evaluate((key) => sessionStorage.getItem(key), QUALITY_KEY),
          { timeout: 180_000 },
        )
        .toContain('"live":false');
      await expect(root).not.toHaveAttribute("data-diorama-live", "true");
      await expect(root.locator("picture img")).toBeVisible();
      await expect(root.locator("canvas")).toHaveCount(0);
    });
  });
});

test.describe("模型（JS なし）", () => {
  test.use({ javaScriptEnabled: false });

  test("空入力: JS が無くても、ポスターと h1 が最初の HTML で見える", async ({
    page,
  }) => {
    await page.goto(LIVE_ROUTE);
    await expect(page.locator(`${ROOT} picture img`)).toBeVisible();
    await expect(page.locator("h1")).toBeVisible();
  });
});

// Task 6。トップの触れる模型（部品のボタンとパネル）
const TOP_ROUTE = "/";

test.describe("模型（トップ・触れる模型）", () => {
  test.describe.configure({ timeout: 120_000 });

  test.describe("正常系", () => {
    test("部品のボタンを Tab で巡れ、フォーカスで部品が持ち上がる（data-diorama-hover）", async ({ page }) => {
      await presetLive(page);
      await open(page, TOP_ROUTE);
      const root = page.locator(ROOT);
      await expect(root).toHaveAttribute("data-diorama-live", "true", { timeout: 90_000 });
      const shelf = root.getByRole("button", { name: DIORAMA.parts.shelf.name, exact: true });
      await shelf.focus();
      await expect(root).toHaveAttribute("data-diorama-hover", "shelf");
      await page.keyboard.press("Tab");
      await expect(root).not.toHaveAttribute("data-diorama-hover", "shelf");
    });

    test("ボタンを押すとパネルが 1 つだけ開き、パネルにフォーカスが移る。Esc で閉じてボタンへ戻る", async ({ page }) => {
      await presetLive(page);
      await open(page, TOP_ROUTE);
      const root = page.locator(ROOT);
      await expect(root).toHaveAttribute("data-diorama-live", "true", { timeout: 90_000 });
      const approval = root.getByRole("button", { name: DIORAMA.parts.approval.name, exact: true });
      await approval.click();
      const dialog = page.getByRole("dialog", { name: DIORAMA.parts.approval.name });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(DIORAMA.parts.approval.body);
      expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      // 開いたまま別の部品を押すと、前のパネルは閉じる
      await root.getByRole("button", { name: DIORAMA.parts.shelf.name, exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await expect(page.getByRole("dialog", { name: DIORAMA.parts.shelf.name })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(root.getByRole("button", { name: DIORAMA.parts.shelf.name, exact: true })).toBeFocused();
    });

    test("窓口のパネルは、掲載許可の実績が 0 件なら準備中と自社の事実を出し、架空の社名を出さない", async ({ page }) => {
      await presetLive(page);
      await open(page, TOP_ROUTE);
      const root = page.locator(ROOT);
      await root.getByRole("button", { name: DIORAMA.parts.desk.name, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: DIORAMA.parts.desk.name });
      await expect(dialog).toContainText(DIORAMA.cases.heading);
      await expect(dialog).toContainText(DIORAMA.cases.empty);
      await expect(dialog).toContainText(DIORAMA.cases.selfNote);
      for (const study of CASES) await expect(dialog).not.toContainText(study.company);
    });

    test("幅を 1280 → 390 → 1280 と変えても、Desktop では各ボタンの中心が部品の位置から 24px 以内（点どうしが近いときは離す）、Mobile ではボタンが重ならず模型の枠の中にある", async ({ page }) => {
      await presetLive(page);
      await page.setViewportSize({ width: 1280, height: 800 });
      await open(page, TOP_ROUTE);
      const root = page.locator(ROOT);
      await expect(root).toHaveAttribute("data-diorama-live", "true", { timeout: 90_000 });
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await page.waitForTimeout(1_500);
        if (width < 768) {
          // Mobile: 部品の名前のボタンの列（点を重ねない）。ボタンどうしが重ならず、模型の枠の上下の中に収まる
          const rects = await root.evaluate((el) => {
            const box = el.getBoundingClientRect();
            return {
              box: { top: box.top, bottom: box.bottom },
              items: [...el.querySelectorAll<HTMLElement>("[data-diorama-part]")].map((b) => {
                const r = b.getBoundingClientRect();
                return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
              }),
            };
          });
          expect(rects.items.length).toBeGreaterThan(5);
          rects.items.forEach((a, i) =>
            rects.items
              .slice(i + 1)
              .forEach((b) => expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true)),
          );
          for (const a of rects.items) expect(a.top >= rects.box.top && a.bottom <= rects.box.bottom).toBe(true);
          continue;
        }
        const gaps = await root.evaluate((el) => {
          const anchors = JSON.parse(el.getAttribute("data-diorama-anchors") ?? "{}") as Record<string, { x: number; y: number }>;
          const box = el.querySelector(".diorama__box")!.getBoundingClientRect();
          return [...el.querySelectorAll<HTMLElement>("[data-diorama-part]")].map((b) => {
            const a = anchors[b.dataset.dioramaPart!];
            const r = b.getBoundingClientRect();
            if (!a) return 0;
            return Math.hypot(r.left + r.width / 2 - (box.left + (a.x / 100) * box.width), r.top + r.height / 2 - (box.top + (a.y / 100) * box.height));
          });
        });
        expect(gaps.length).toBeGreaterThan(0);
        // 点どうしが近い部品は 34px 以上に離す（2.5.8）ので、部品の位置からの差は 24px まで許す
        expect(Math.max(...gaps), `幅 ${width}`).toBeLessThanOrEqual(24);
      }
    });

    test("トップの一時停止のボタンは名前が互いに異なる（見える文字で始まり、対象名が続く。2.5.3）", async ({ page }, testInfo) => {
      // motion-vivid.spec.ts の「ヒーロー」から移した（2026-10-28。背景の光から模型に替わった）
      test.skip(testInfo.project.name !== "desktop", "CTA の動き（MotionBlobs）は md 以上だけ");
      await presetLive(page);
      await open(page, TOP_ROUTE);
      await expect(page.locator(ROOT)).toHaveAttribute("data-diorama-live", "true", { timeout: 90_000 });
      // 下の部品（client:visible）も水和させてから、ページ全体の一時停止のボタンを集める
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(3_000);
      await page.evaluate(() => window.scrollTo(0, 0));
      // 見える文字と sr-only の対象名のあいだの改行は除く
      const names = (await page.getByRole("button", { name: new RegExp(`^${MOTION_PAUSE.pause}`) }).allInnerTexts()).map((n) => n.replace(/\s+/g, ""));
      expect(names, `名前: ${names.join(" / ")}`).toContain(`${MOTION_PAUSE.pause}${MOTION_PAUSE_TARGETS.diorama}`);
      expect(names.length).toBeGreaterThanOrEqual(2);
      expect(new Set(names).size, `名前: ${names.join(" / ")}`).toBe(names.length);
    });

    test("ヒーローの文字（h1・本文）は、模型を描いた状態でも地と 4.5:1 以上", async ({ page }, testInfo) => {
      // motion-vivid.spec.ts の「ヒーロー」から移した（2026-10-28）。Desktop は文字が模型に重なる
      test.skip(testInfo.project.name !== "desktop", "Mobile は文字と模型が重ならない");
      await presetLive(page);
      await open(page, TOP_ROUTE);
      await expect(page.locator(ROOT)).toHaveAttribute("data-diorama-live", "true", { timeout: 90_000 });
      // 模型を描いた状態で止めてから測る（動き続ける WebGL の上で文字ごとに画面写真を撮ると、GPU の無い VM では時間切れになる）
      await page.locator(ROOT).getByRole("button", { name: new RegExp(`^${MOTION_PAUSE.pause}`) }).click();
      await page.waitForTimeout(500);
      await page.evaluate(() => document.getElementById("cookie-banner")?.setAttribute("hidden", ""));
      const texts = page.locator("[data-diorama-hero] h1, [data-diorama-hero] .diorama-hero__copy p");
      const count = await texts.count();
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        const text = texts.nth(i);
        const color = await text.evaluate((el) => getComputedStyle(el).color);
        await text.evaluate((el) => el.style.setProperty("color", "transparent", "important"));
        const png = await text.screenshot({ animations: "allow" });
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
              const f = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
              return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
            };
            const lf = lum(fr, fgc, fb);
            let worst = 21;
            for (let p = 0; p < data.length; p += 16) {
              const lb = lum(data[p], data[p + 1], data[p + 2]);
              worst = Math.min(worst, (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05));
            }
            return worst;
          },
          { b64: png.toString("base64"), fg: color },
        );
        expect(min, `${i + 1} 番目の文字「${(await text.innerText()).slice(0, 20)}」`).toBeGreaterThanOrEqual(4.5);
      }
    });

    test("パネルを開いたまま下へ読み進めてページの別の所を押しても、画面はヒーローへ跳ね戻らない（最終レビュー I-1）", async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "Desktop のパネル");
      await presetLive(page);
      await open(page, TOP_ROUTE);
      const root = page.locator(ROOT);
      await root.getByRole("button", { name: DIORAMA.parts.shelf.name, exact: true }).click();
      await expect(page.getByRole("dialog", { name: DIORAMA.parts.shelf.name })).toBeVisible();
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(800);
      const before = await page.evaluate(() => window.scrollY);
      expect(before).toBeGreaterThan(1000);
      // いま見えている所の、操作できない文字の上を座標で押す（locator.click は要素を画面に入れるためにスクロールするので使わない）
      const point = await page.evaluate(() => {
        for (let y = 200; y < window.innerHeight - 100; y += 40) {
          for (let x = 200; x < window.innerWidth - 200; x += 80) {
            const el = document.elementFromPoint(x, y);
            if (el && el.closest("main") && !el.closest("a, button, input, select, textarea, label, summary")) return { x, y };
          }
        }
        return null;
      });
      expect(point, "押せる文字の上の点").not.toBeNull();
      await page.mouse.click(point!.x, point!.y);
      await page.waitForTimeout(800);
      expect(await page.evaluate(() => window.scrollY), "押した後の位置").toBeGreaterThanOrEqual(before - 5);
      // 外側を押したので、パネルは閉じている
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    test("一時停止のまま幅を変えても、押せる点は部品の上に置き直される（再開しても動かない。最終レビュー I-5）", async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "Desktop の中での幅の変化（1440 → 1100）");
      await presetLive(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, TOP_ROUTE);
      const root = page.locator(ROOT);
      await expect(root).toHaveAttribute("data-diorama-live", "true", { timeout: 90_000 });
      await root.getByRole("button", { name: new RegExp(`^${MOTION_PAUSE.pause}`) }).click();
      await page.setViewportSize({ width: 1100, height: 900 });
      await page.waitForTimeout(800);
      const positions = () =>
        root.evaluate((el) =>
          [...el.querySelectorAll<HTMLElement>("[data-diorama-part]")].map((b) => {
            const r = b.getBoundingClientRect();
            return [b.dataset.dioramaPart, Math.round(r.left), Math.round(r.top)] as const;
          }),
        );
      const paused = await positions();
      await root.getByRole("button", { name: new RegExp(`^${MOTION_PAUSE.resume}`) }).click();
      await page.waitForTimeout(1_500);
      const resumed = await positions();
      // 再開してすぐは視差（ポインター）も寄りも無いので、正しく置き直されていれば位置は変わらない
      paused.forEach(([id, x, y], i) => {
        expect(Math.hypot(x - resumed[i][1], y - resumed[i][2]), `${id}`).toBeLessThanOrEqual(3);
      });
    });

    test("パネルを開いた状態でも axe の違反が 0", async ({ page }) => {
      await presetLive(page);
      await open(page, TOP_ROUTE);
      const root = page.locator(ROOT);
      await root.getByRole("button", { name: DIORAMA.parts.agents.name, exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).include(ROOT).analyze();
      expect(result.violations.map((v) => v.id)).toEqual([]);
    });
  });

  test.describe("異常系", () => {
    test("入力: reduced-motion でも、ポスターの上に同じボタンがあり、パネルが開く", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await open(page, TOP_ROUTE);
      const root = page.locator(ROOT);
      await expect(root.locator("canvas")).toHaveCount(0);
      const parts = root.locator("[data-diorama-part]");
      expect(await parts.count()).toBeGreaterThan(5);
      await root.getByRole("button", { name: DIORAMA.parts.site.name, exact: true }).click();
      await expect(page.getByRole("dialog", { name: DIORAMA.parts.site.name })).toBeVisible();
    });
  });
});

test.describe("トップのヒーロー（JS なし）", () => {
  test.use({ javaScriptEnabled: false });

  test("空入力: タグライン・h1・本文・CTA が最初の HTML にあり、ヒーローに写真が無い", async ({ page }) => {
    await page.goto(TOP_ROUTE);
    const hero = page.locator("[data-diorama-hero]");
    await expect(hero.getByText(TOP.hero.tagline)).toBeVisible();
    await expect(hero.locator("h1")).toBeVisible();
    await expect(hero.getByRole("link", { name: TOP.hero.primaryCta.label })).toBeVisible();
    await expect(hero.locator(`${ROOT} picture img`)).toBeVisible();
    await expect(hero.locator("img:not(picture img)")).toHaveCount(0);
    // 押せない死んだボタンを出さない（一時停止・部品のボタンは JS で描く）
    await expect(hero.getByRole("button")).toHaveCount(0);
  });
});

// Task 7。サービス一覧・詳細 4 本の導入ヒーロー（眺める模型）
const SERVICE_ROUTES = ["/services/", "/services/environment-setup/", "/services/development/", "/services/consulting/", "/services/partnership/"];

test.describe("模型（サービスの導入ヒーロー）", () => {
  test.describe("正常系", () => {
    for (const route of SERVICE_ROUTES) {
      test(`${route}: ヒーローに模型があり、背景の光（#hero-backdrop）・地球儀・写真が無く、部品のボタンも無い（眺めるだけ）`, async ({ page }) => {
        await presetLive(page);
        await open(page, route);
        const hero = page.locator("main section").first();
        await expect(hero.locator(ROOT)).toHaveCount(1);
        await expect(hero.locator(`${ROOT} picture img`)).toBeVisible();
        await expect(hero.locator("#hero-backdrop")).toHaveCount(0);
        await expect(hero.locator("#globe-osaka")).toHaveCount(0);
        await expect(hero.locator("img:not(picture img)")).toHaveCount(0);
        await expect(hero.locator("[data-diorama-part]")).toHaveCount(0);
        await expect(hero.locator(ROOT).getByRole("button", { name: /動きを止める|動きを再開する/ })).toHaveCount(1);
      });
    }

    test("サービス詳細の h1 の view-transition-name はそのまま（vt-service-title）", async ({ page }) => {
      await open(page, "/services/development/");
      expect(await page.locator("h1").evaluate((el) => getComputedStyle(el).viewTransitionName)).toBe("vt-service-title");
    });
  });
});

// Task 8。B（calm）のページの導入ヒーロー（同じ模型の静止画。動かさない・光らせない）
const STILL_ROUTES = [
  { route: "/about/", key: "about" },
  { route: "/pricing/", key: "pricing" },
  { route: "/blog/", key: "blog" },
  { route: "/contact/", key: "contact" },
  { route: "/contact/thanks/", key: "contactThanks" },
];

test.describe("模型（B のページの静止画）", () => {
  test.describe("正常系", () => {
    for (const { route, key } of STILL_ROUTES) {
      test(`${route}: 導入ヒーローに、そのページの静止画があり、装飾として扱う（alt なし・aria-hidden）。canvas は無く three を読まない`, async ({
        page,
      }, testInfo) => {
        const three = countThree(page);
        // reduced-motion にしてアバター（3D）を静止画にし、three を読むのが模型だけかを確かめる
        await page.emulateMedia({ reducedMotion: "reduce" });
        await open(page, route);
        const still = page.locator(`[data-diorama-still="${key}"]`);
        await expect(still).toHaveCount(1);
        await expect(still).toHaveAttribute("aria-hidden", "true");
        await expect(still.locator("img")).toHaveAttribute("alt", "");
        expect(await still.locator("img").getAttribute("src")).toMatch(new RegExp(`${key.replace(":", "_")}\\.[^/]*webp$`));
        // Desktop だけに出す（Mobile は文字だけ。B は静か）
        if (testInfo.project.name === "desktop") await expect(still.locator("img")).toBeVisible();
        else await expect(still).toBeHidden();
        await expect(page.locator("main canvas")).toHaveCount(0);
        await page.waitForTimeout(2_000);
        expect(three.count, "three を読んでいない").toBe(0);
      });
    }
  });
});

// Task 10。ページの移動を「模型に寄るカメラ」に見せる（文書間の View Transitions。Chromium の Desktop だけ）
test.describe("模型（ページの移動）", () => {
  test.describe.configure({ timeout: 120_000 });

  test("トップから受託開発へ移ると、行き先で模型が zoom-in の印と拡大の中心（%）を受け取り、vt-diorama の名前は 1 ページに 1 つ", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "文書間の View Transitions は Desktop の Chromium だけで見る");
    await presetLive(page);
    await open(page, TOP_ROUTE);
    await expect(page.locator(ROOT)).toHaveAttribute("data-diorama-live", "true", { timeout: 90_000 });
    const names = () =>
      page.evaluate(() => [...document.querySelectorAll<HTMLElement>("*")].filter((el) => getComputedStyle(el).viewTransitionName === "vt-diorama").length);
    // 名前は移動の間だけ付ける（常に付けると模型が独立した重なりの層になり、押せる部品が文字の下に回る）
    expect(await names()).toBe(0);
    await page.locator('a[href^="/services/development"]').first().click();
    await page.waitForURL(/\/services\/development\/?$/);
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-vt-diorama"))).toBe("zoom-in");
    const origin = await page.evaluate(() => [
      document.documentElement.style.getPropertyValue("--vt-diorama-x"),
      document.documentElement.style.getPropertyValue("--vt-diorama-y"),
    ]);
    for (const v of origin) expect(v).toMatch(/^\d+(\.\d+)?%$/);
    // 遷移が終わったら名前を外す（1 ページに残さない）
    await expect.poll(names, { timeout: 5_000 }).toBe(0);
  });

  test("Desktop の移動の間、模型の絵は文字の列の側（左）を透かし、文字を覆わない（最終レビュー I-4）", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "文書間の View Transitions は Desktop の Chromium だけで見る");
    await open(page, "/services/development/");
    // 遷移の絵（::view-transition-old/new(vt-diorama)）に、文字の後ろの紺の覆いと同じ向きの mask が掛かる規則が、Desktop の幅で効いている
    const masked = await page.evaluate(() => {
      const found: string[] = [];
      const walk = (rules: CSSRuleList, inDesktop: boolean) => {
        for (const rule of [...rules]) {
          if (rule instanceof CSSMediaRule) walk(rule.cssRules, inDesktop || (/min-width:\s*768px|width\s*>=\s*768px/.test(rule.conditionText) && matchMedia(rule.conditionText).matches));
          else if (rule instanceof CSSStyleRule && inDesktop && /view-transition-(old|new)\(vt-diorama\)/.test(rule.selectorText)) {
            const mask = rule.style.getPropertyValue("mask-image") || rule.style.getPropertyValue("-webkit-mask-image");
            if (/gradient/.test(mask)) found.push(rule.selectorText);
          }
        }
      };
      for (const sheet of [...document.styleSheets]) {
        try {
          walk(sheet.cssRules, false);
        } catch {}
      }
      return found;
    });
    expect(masked.join(" ")).toMatch(/view-transition-old\(vt-diorama\)/);
    expect(masked.join(" ")).toMatch(/view-transition-new\(vt-diorama\)/);
  });

  test("入力: 行き先が B（静止画）のページなら寄らない（印を付けない）", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "文書間の View Transitions は Desktop の Chromium だけで見る");
    await presetLive(page);
    await open(page, TOP_ROUTE);
    await page.locator("header").getByRole("link", { name: "会社概要" }).first().click();
    await page.waitForURL(/\/about\/?$/);
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-vt-diorama"))).toBeNull();
  });
});
