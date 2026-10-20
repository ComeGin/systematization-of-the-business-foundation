// アバター（avatar の AvatarDock・AvatarStage。設計書 §7）の e2e。
// 既定の fixture はアバターを止めて開く（fixtures.ts の avatarLive）ので、この spec だけ動かして開く。
// 見ること: C のページに出ない・読まない／Desktop で canvas が出てエモートする／一時停止で rAF が止まる／たたむと覚える／
//           reduced-motion は静止画だけ／Mobile は押してから読む／Mobile で出した後は 120px で、スクロール中は左の画面の外へ逃げる（R19）／
//           同意バナー・Chatwoot・送信ボタンと重ならない／axe と CLS。
import type { Page, Request } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "../support/fixtures";
import { cls, instrument, rafDuring } from "../support/motion";
import { open } from "./axe";
import { AXE_TAGS } from "./routes";
import {
  AVATAR_LABELS,
  MOTION_PAUSE_TARGETS,
} from "../../src/modules/site-content/a11y";

test.use({ avatarLive: true });

const DOCK = '[data-motion="avatar"]';
const READY = `${DOCK}[data-avatar-state="ready"]`;

const desktopOnly = (name: string) =>
  test.skip(
    name !== "desktop",
    "Desktop（hover があり、最初から 3D を出す端末）だけ",
  );
const mobileOnly = (name: string) =>
  test.skip(name !== "mobile", "Mobile（最初はアイコンだけ）だけ");

/** .vrm（モデル）の要求を数える */
function watchModel(page: Page): Request[] {
  const requests: Request[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith(".vrm"))
      requests.push(request);
  });
  return requests;
}

/** 最後に再生したエモート（AvatarStage が window.__avatar に書く） */
const lastEmote = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __avatar?: { lastEmote: string | null } })
        .__avatar?.lastEmote ?? null,
  );

/** このセッションでは挨拶を済ませたことにする（2 ページ目以降の振る舞い。R17） */
const markGreeted = (page: Page) =>
  page.addInitScript(() => {
    try {
      window.sessionStorage.setItem("avatar:greeted", "true");
    } catch {
      // 何もしない
    }
  });

/** 同意バナーを「同意しない」で閉じる（consent-api への送信は fixture が差し替える） */
async function declineConsent(page: Page) {
  const decline = page.getByRole("button", { name: "同意しない" });
  if (await decline.isVisible()) await decline.click();
  await expect(page.locator("#cookie-banner")).toBeHidden();
}

// 名前は見える文字 ＋ sr-only の対象名（間に空白が入ることがある）
const pauseButton = (page: Page, label: string) =>
  page.locator(DOCK).getByRole("button", {
    name: new RegExp(`^${label}\\s*${MOTION_PAUSE_TARGETS.avatar}$`),
  });

/** アバターの見えている部品（canvas・静止画・ボタン）の矩形 */
const visibleRects = (page: Page) =>
  page.evaluate((dock) => {
    const root = document.querySelector(dock);
    if (!root) return [];
    return [...root.querySelectorAll<HTMLElement>("canvas, img, button")]
      .filter((el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        // 透明な祖先（フォーカスと重なる間のアイコンのボタン。opacity 0）の中の img も見えていない
        let transparent = false;
        for (
          let node: Element | null = el;
          node && node !== root.parentElement;
          node = node.parentElement
        ) {
          if (getComputedStyle(node).opacity === "0") transparent = true;
        }
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          !transparent &&
          el.closest("[hidden]") === null
        );
      })
      .map((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  }, DOCK);

/**
 * 画面を少しずつスクロールし続ける（待たずに戻る）。ms を渡せばその後に止まり、渡さなければ stopScrolling まで続ける。
 * jiggle なら 1px 下げて戻すのを繰り返す（scroll は起きるが、位置はほとんど動かない。画面に入ってくる部品の rAF を混ぜない）
 */
const startScrolling = (
  page: Page,
  ms?: number,
  { jiggle = false }: { jiggle?: boolean } = {},
) =>
  page.evaluate(
    ([duration, small]) => {
      let flip = 1;
      const id = window.setInterval(() => {
        if (small) {
          window.scrollBy(0, flip);
          flip = -flip;
        } else window.scrollBy(0, 40);
      }, 50);
      (window as unknown as { __scrolling?: number }).__scrolling = id;
      if (duration !== undefined)
        window.setTimeout(() => window.clearInterval(id), duration);
    },
    [ms, jiggle] as const,
  );

/** startScrolling を止める */
const stopScrolling = (page: Page) =>
  page.evaluate(() =>
    window.clearInterval(
      (window as unknown as { __scrolling?: number }).__scrolling,
    ),
  );

/** Mobile で「アバターを表示する」を押して、描けるまで待つ */
async function summonAvatar(page: Page) {
  await page
    .locator(DOCK)
    .getByRole("button", { name: AVATAR_LABELS.summon })
    .click();
  await expect(page.locator(READY)).toBeAttached({ timeout: 30_000 });
}

const intersects = (
  a: DOMRect,
  b: { x: number; y: number; width: number; height: number },
) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

test.describe("アバター", () => {
  test.beforeEach(async ({ page }) => instrument(page));

  test.describe("正常系", () => {
    test("Desktop の /: 読み込みの後に aria-hidden の canvas が出て、着いたら手を振る（greeting）", async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      const models = watchModel(page);
      await open(page, "/");
      await expect(page.locator(READY)).toBeAttached({ timeout: 20_000 });
      await expect(
        page.locator(`${DOCK} canvas[aria-hidden="true"]`),
      ).toBeVisible();
      await expect.poll(() => lastEmote(page)).toBe("greeting");
      expect(models.length, ".vrm の要求").toBe(1);
      // 一時停止とたたむのボタンに名前がある
      await expect(pauseButton(page, AVATAR_LABELS.pause)).toBeVisible();
      await expect(
        page
          .locator(DOCK)
          .getByRole("button", { name: AVATAR_LABELS.collapse }),
      ).toBeVisible();
    });

    test("挨拶はセッションで 1 回: / で手を振った後に avatar:greeted が付き、同じセッションの /about/ では手を振らない（R17）", async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      await open(page, "/");
      await expect(page.locator(READY)).toBeAttached({ timeout: 20_000 });
      await expect.poll(() => lastEmote(page)).toBe("greeting");
      expect(
        await page.evaluate(() =>
          window.sessionStorage.getItem("avatar:greeted"),
        ),
      ).toBe("true");
      await open(page, "/about/");
      await expect(page.locator(READY)).toBeAttached({ timeout: 20_000 });
      // 描けた後に arrive が出る。受理されても手を振らないことを、少し待ってから確かめる
      await page.waitForTimeout(1_500);
      expect(await lastEmote(page)).toBeNull();
    });

    test("Desktop の /services/development/: プランの節までスクロールすると うなずく（nod）", async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      await markGreeted(page);
      await open(page, "/services/development/");
      await declineConsent(page);
      await expect(page.locator(READY)).toBeAttached({ timeout: 20_000 });
      expect(
        await lastEmote(page),
        "挨拶を済ませたセッションでは着いても手を振らない",
      ).toBeNull();
      await page
        .locator('[data-avatar-cue="pricing"]')
        .scrollIntoViewIfNeeded();
      await expect.poll(() => lastEmote(page)).toBe("nod");
    });

    test("Desktop の /services/development/: 主 CTA にフォーカスすると指さす（point）", async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      await markGreeted(page);
      await open(page, "/services/development/");
      await declineConsent(page);
      await expect(page.locator(READY)).toBeAttached({ timeout: 20_000 });
      await page.locator("main [data-cta-id]").first().focus();
      await expect.poll(() => lastEmote(page)).toBe("point");
    });

    test("一時停止のボタンで rAF の増分が 0 になり、sessionStorage の motion:avatar が paused になる", async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      // 会社紹介の最初の画面には、ほかに rAF で動く部品が無い（CTA の粒は画面に入るまで水和しない）
      await open(page, "/about/");
      await expect(page.locator(READY)).toBeAttached({ timeout: 20_000 });
      expect(await rafDuring(page, 1_000), "動いている間").toBeGreaterThan(0);
      const pause = pauseButton(page, AVATAR_LABELS.pause);
      await pause.focus();
      await page.keyboard.press("Enter");
      await expect(pauseButton(page, AVATAR_LABELS.resume)).toBeVisible();
      expect(await rafDuring(page, 1_500), "止めた後").toBe(0);
      expect(
        await page.evaluate(() =>
          window.sessionStorage.getItem("motion:avatar"),
        ),
      ).toBe("paused");
      // canvas は最後の姿勢のまま残る
      await expect(page.locator(`${DOCK} canvas`)).toBeVisible();
    });

    test("「アバターをしまう」で canvas が消え、出すボタンにフォーカスが移る。ページを移っても avatar:collapsed が残り、モデルを読まない", async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      await open(page, "/");
      await expect(page.locator(READY)).toBeAttached({ timeout: 20_000 });
      await page
        .locator(DOCK)
        .getByRole("button", { name: AVATAR_LABELS.collapse })
        .click();
      await expect(page.locator(`${DOCK} canvas`)).toBeHidden();
      const expand = page
        .locator(DOCK)
        .getByRole("button", { name: AVATAR_LABELS.expand });
      await expect(expand).toBeFocused();

      const models = watchModel(page);
      await open(page, "/pricing/");
      expect(
        await page.evaluate(() =>
          window.sessionStorage.getItem("avatar:collapsed"),
        ),
      ).toBe("true");
      await expect(
        page.locator(DOCK).getByRole("button", { name: AVATAR_LABELS.expand }),
      ).toBeVisible();
      await expect(page.locator(`${DOCK} canvas`)).toHaveCount(0);
      expect(
        models.length,
        "たたんだまま開いたページでは .vrm を読まない",
      ).toBe(0);

      // 出すと読み込み、canvas が出る
      await page
        .locator(DOCK)
        .getByRole("button", { name: AVATAR_LABELS.expand })
        .click();
      await expect(page.locator(READY)).toBeAttached({ timeout: 20_000 });
      await expect(
        page
          .locator(DOCK)
          .getByRole("button", { name: AVATAR_LABELS.collapse }),
      ).toBeFocused();
      expect(
        await page.evaluate(() =>
          window.sessionStorage.getItem("avatar:collapsed"),
        ),
      ).toBeNull();
    });

    test("Mobile: 最初は「アバターを表示する」のボタン（56px 以上）だけで、押すと .vrm を読む", async ({
      page,
    }, testInfo) => {
      mobileOnly(testInfo.project.name);
      const models = watchModel(page);
      await open(page, "/");
      const summon = page
        .locator(DOCK)
        .getByRole("button", { name: AVATAR_LABELS.summon });
      await expect(summon).toBeVisible();
      expect(
        await page.locator(DOCK).getByRole("button").count(),
        "ボタンは 1 つだけ",
      ).toBe(1);
      const box = await summon.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(56);
      expect(box?.height).toBeGreaterThanOrEqual(56);
      await page.waitForTimeout(1_000);
      expect(models.length, "押す前").toBe(0);
      await Promise.all([
        page.waitForRequest((request) =>
          new URL(request.url()).pathname.endsWith(".vrm"),
        ),
        summon.click(),
      ]);
      await expect(page.locator(READY)).toBeAttached({ timeout: 30_000 });
      await expect(
        page.locator(`${DOCK} canvas[aria-hidden="true"]`),
      ).toBeVisible();
    });

    test("Mobile: 出した後のステージの高さは 120px で、会社紹介のメンバーの節に入っても出ても 120px のまま（R19）", async ({
      page,
    }, testInfo) => {
      mobileOnly(testInfo.project.name);
      await open(page, "/about/");
      await declineConsent(page);
      await summonAvatar(page);
      const stage = page.locator(`${DOCK} .avatar-dock__stage`);
      const height = async () =>
        Math.round((await stage.boundingBox())!.height);
      await expect.poll(height).toBe(120);
      await page.locator('[data-avatar-cue="team"]').scrollIntoViewIfNeeded();
      await page.waitForTimeout(1_000);
      expect(await height(), "節に入った").toBe(120);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(1_000);
      expect(await height(), "節から出た").toBe(120);
    });

    test("Mobile: スクロールしている間は左の画面の外へ逃げ（同意バナーの上への逃がしと両立）、止まって 1 秒後には戻る（R19）", async ({
      page,
    }, testInfo) => {
      mobileOnly(testInfo.project.name);
      await open(page, "/");
      const banner = page.locator("#cookie-banner");
      await expect(banner).toBeVisible();
      await summonAvatar(page);
      const dock = page.locator(DOCK);

      // 測り終えるまでスクロールし続ける（負荷で遅れても、途中で止まって戻らないように）
      await startScrolling(page);
      await expect(dock).toHaveAttribute("data-avatar-away", "true");
      // 逃がす動き（transform のトランジション）が終わるのを待つ
      await page.waitForTimeout(600);
      const away = await visibleRects(page);
      expect(away.length).toBeGreaterThan(0);
      for (const rect of away) {
        expect(rect.x + rect.width, "右端が画面の左の外").toBeLessThanOrEqual(
          0,
        );
      }
      // 横（transform）と縦（同意バナーの translate）のどちらも効いている
      const style = await dock.evaluate((el) => {
        const computed = getComputedStyle(el);
        return { translate: computed.translate, transform: computed.transform };
      });
      expect(style.translate, "同意バナーの上への逃がし").not.toBe("none");
      expect(style.transform, "横への逃がし").not.toBe("none");
      expect(
        await dock.getAttribute("data-avatar-away"),
        "スクロールしている間は戻らない",
      ).toBe("true");

      // 止まってから 1 秒後には戻る（戻る合図は 600ms。戻る動き〈320ms〉は負荷で遅れることがあるので、位置は待って見る。バナーの上のまま）
      await stopScrolling(page);
      await page.waitForTimeout(1_000);
      expect(await dock.getAttribute("data-avatar-away"), "1 秒後").toBeNull();
      await expect
        .poll(async () =>
          Math.min(...(await visibleRects(page)).map((rect) => rect.x)),
        )
        .toBeGreaterThanOrEqual(0);
      const bannerBox = (await banner.boundingBox())!;
      const back = await visibleRects(page);
      expect(back.length).toBeGreaterThan(0);
      for (const rect of back) {
        expect(rect.x, "左端が画面の中").toBeGreaterThanOrEqual(0);
        expect(
          rect.y + rect.height,
          "下端がバナーの上端より上",
        ).toBeLessThanOrEqual(bannerBox.y);
      }
    });

    test("Mobile: 逃がしている間は描画の rAF が止まり、戻したら再開する（R19。/about/ の最初の画面）", async ({
      page,
    }, testInfo) => {
      mobileOnly(testInfo.project.name);
      await markGreeted(page);
      await open(page, "/about/");
      await declineConsent(page);
      await summonAvatar(page);
      expect(await rafDuring(page, 1_000), "出ている間").toBeGreaterThan(0);
      // 位置をほとんど動かさずに scroll を起こし続ける（ほかの部品を画面に入れない）
      await startScrolling(page, undefined, { jiggle: true });
      await expect(page.locator(DOCK)).toHaveAttribute(
        "data-avatar-away",
        "true",
      );
      expect(await rafDuring(page, 1_000), "逃がしている間").toBe(0);
      await stopScrolling(page);
      await expect(page.locator(DOCK)).not.toHaveAttribute(
        "data-avatar-away",
        "true",
      );
      expect(await rafDuring(page, 1_000), "戻した後").toBeGreaterThan(0);
    });

    test("Desktop ではスクロールしても逃げない", async ({ page }, testInfo) => {
      desktopOnly(testInfo.project.name);
      await markGreeted(page);
      await open(page, "/about/");
      await declineConsent(page);
      await expect(page.locator(READY)).toBeAttached({ timeout: 20_000 });
      await startScrolling(page, 1_000);
      await page.waitForTimeout(600);
      await expect(page.locator(DOCK)).not.toHaveAttribute(
        "data-avatar-away",
        "true",
      );
      for (const rect of await visibleRects(page)) {
        expect(rect.x, "左端が画面の中").toBeGreaterThanOrEqual(0);
      }
    });

    test("会社紹介のメンバーの節が見えている間は小さくなる（高さ 120px）", async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      await open(page, "/about/");
      await declineConsent(page);
      await expect(page.locator(READY)).toBeAttached({ timeout: 20_000 });
      const stage = page.locator(`${DOCK} .avatar-dock__stage`);
      expect(Math.round((await stage.boundingBox())!.height)).toBe(180);
      await page.locator('[data-avatar-cue="team"]').scrollIntoViewIfNeeded();
      await expect(page.locator(DOCK)).toHaveAttribute(
        "data-avatar-small",
        "true",
      );
      await expect
        .poll(async () => Math.round((await stage.boundingBox())!.height))
        .toBe(120);
    });

    test("同意バナーが出ている間はバナーの上に逃げ、右下（Chatwoot のランチャー）と重ならない", async ({
      page,
    }) => {
      await open(page, "/");
      const banner = page.locator("#cookie-banner");
      await expect(banner).toBeVisible();
      const bannerBox = (await banner.boundingBox())!;
      // 逃がす動き（translate のトランジション）が終わるのを待つ
      await page.waitForTimeout(800);
      const rects = await visibleRects(page);
      expect(rects.length).toBeGreaterThan(0);
      const viewport = page.viewportSize()!;
      // Chatwoot のランチャーは右下（right 20px・bottom 20px・64px 四方）。余白を見て右下の 120px 四方と比べる
      const chat = {
        x: viewport.width - 120,
        y: viewport.height - 120,
        width: 120,
        height: 120,
      };
      for (const rect of rects) {
        expect(
          rect.y + rect.height,
          "アバターの下端がバナーの上端より上",
        ).toBeLessThanOrEqual(bannerBox.y);
        expect(
          intersects(rect, chat),
          "Chatwoot のランチャーの場所と重ならない",
        ).toBe(false);
      }
    });

    test("C のページ（/legal/privacy/）には、アバターの DOM も JS も無く、.vrm を要求しない", async ({
      page,
    }) => {
      const models = watchModel(page);
      const scripts: string[] = [];
      page.on("response", (response) => {
        if (/\.js(\?|$)/.test(response.url())) scripts.push(response.url());
      });
      await open(page, "/legal/privacy/");
      await page.waitForTimeout(1_000);
      await expect(page.locator(DOCK)).toHaveCount(0);
      expect(models.length).toBe(0);
      expect(scripts.filter((url) => /AvatarStage|stage\./.test(url))).toEqual(
        [],
      );
    });

    test("動いている間も axe の違反が 0、動きが要因のレイアウトのずれ（CLS）が 0.01 未満", async ({
      page,
    }, testInfo) => {
      await open(page, "/");
      if (testInfo.project.name === "desktop")
        await expect(page.locator(READY)).toBeAttached({ timeout: 20_000 });
      const results = await new AxeBuilder({ page })
        .withTags(AXE_TAGS)
        .analyze();
      expect(
        results.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(",")}`,
        ),
      ).toEqual([]);
      expect((await cls(page)).motion).toBeLessThan(0.01);
    });

    test("three の実装は 1 つのチャンクだけ（アバターの GLTFLoader・three-vrm が別の three を連れて来ない）", async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      const withRenderer: string[] = [];
      page.on("response", async (response) => {
        const url = response.url();
        if (!/\.js(\?|$)/.test(url) || !response.ok()) return;
        const body = await response.text().catch(() => "");
        if (body.includes("isWebGLRenderer")) withRenderer.push(url);
      });
      await open(page, "/");
      await expect(page.locator(READY)).toBeAttached({ timeout: 20_000 });
      expect(withRenderer, "three の実装を含む JS").toHaveLength(1);
    });
  });

  test.describe("異常系", () => {
    test("入力: reduced-motion では .vrm を要求せず、静止画（img）だけで、一時停止のボタンが無い", async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      const models = watchModel(page);
      await open(page, "/");
      const summon = page
        .locator(DOCK)
        .getByRole("button", { name: AVATAR_LABELS.summon });
      if (await summon.isVisible()) await summon.click();
      await expect(
        page.locator(`${DOCK} img.avatar-dock__still`),
      ).toBeVisible();
      await expect(page.locator(`${DOCK} canvas`)).toHaveCount(0);
      await expect(pauseButton(page, AVATAR_LABELS.pause)).toHaveCount(0);
      await page.waitForTimeout(1_000);
      expect(models.length).toBe(0);
      expect(await rafDuring(page, 1_500)).toBe(0);
    });

    test("サーバ: .vrm を読めないと、静止画のまま（一時停止のボタンなし）で、コンソールに [avatar] の失敗を出す", async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      const errors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.route(
        (url) => url.pathname.endsWith(".vrm"),
        (route) => route.abort(),
      );
      await open(page, "/");
      await expect(page.locator(DOCK)).toHaveAttribute(
        "data-avatar-state",
        "failed",
        { timeout: 20_000 },
      );
      await expect(
        page.locator(`${DOCK} img.avatar-dock__still`),
      ).toBeVisible();
      await expect(pauseButton(page, AVATAR_LABELS.pause)).toHaveCount(0);
      expect(
        errors.filter((e) =>
          e.startsWith("[avatar] 3D の読み込みに失敗しました"),
        ),
      ).toHaveLength(1);
    });

    test("入力: Mobile でアバターのボタンにキーボードのフォーカスがある間は、スクロールしても逃げない（2.4.7。R19）", async ({
      page,
    }, testInfo) => {
      mobileOnly(testInfo.project.name);
      await open(page, "/");
      await declineConsent(page);
      await summonAvatar(page);
      // 押した後のフォーカスはたたむボタンにある（タップの後なのでリングは出ない）。Tab で一時停止のボタンへ、Shift+Tab で戻す（キーボードのフォーカス）
      const collapse = page
        .locator(DOCK)
        .getByRole("button", { name: AVATAR_LABELS.collapse });
      await expect(collapse).toBeFocused();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(collapse).toBeFocused();
      expect(
        await collapse.evaluate((el) => el.matches(":focus-visible")),
        "見えるフォーカス",
      ).toBe(true);
      await startScrolling(page, 1_000);
      await page.waitForTimeout(600);
      await expect(page.locator(DOCK)).not.toHaveAttribute(
        "data-avatar-away",
        "true",
      );
      const box = (await collapse.boundingBox())!;
      expect(box.x, "フォーカスのあるボタンが画面の中").toBeGreaterThanOrEqual(
        0,
      );
    });

    test("入力: Mobile で逃がしている間に Tab でアバターのボタンへ入ると、止まるのを待たずに戻る（2.4.7。R19）", async ({
      page,
    }, testInfo) => {
      mobileOnly(testInfo.project.name);
      await open(page, "/");
      await declineConsent(page);
      await summonAvatar(page);
      const dock = page.locator(DOCK);
      // 押した後のフォーカスはたたむボタン（タップの後なのでリングは出ず、逃がす）
      await startScrolling(page);
      await expect(dock).toHaveAttribute("data-avatar-away", "true");
      // スクロールを続けたまま Tab で一時停止のボタンへ（キーボードのフォーカス）
      await page.keyboard.press("Tab");
      const pause = pauseButton(page, AVATAR_LABELS.pause);
      await expect(pause).toBeFocused();
      await expect(dock).not.toHaveAttribute("data-avatar-away", "true", {
        timeout: 400,
      });
      await expect
        .poll(async () => (await pause.boundingBox())!.x)
        .toBeGreaterThanOrEqual(0);
      await stopScrolling(page);
    });

    test("入力: Mobile で逃がしている間に入力欄へフォーカスしても、戻った後のアバターは入力欄と重ならない（2.4.11。R19）", async ({
      page,
    }, testInfo) => {
      mobileOnly(testInfo.project.name);
      await open(page, "/contact/");
      await declineConsent(page);
      await summonAvatar(page);
      const dock = page.locator(DOCK);
      await startScrolling(page);
      await expect(dock).toHaveAttribute("data-avatar-away", "true");
      // 逃がす動き（320ms）が終わって画面の外に出きるまで、スクロールを続ける
      await page.waitForTimeout(500);
      await stopScrolling(page);
      // 最初の入力欄を、アバターの定位置（左下）に来る高さまでスクロールして（これも scroll なので逃がしたまま）、スクロールさせずにフォーカスする
      const input = page.locator("main form input:visible").first();
      await input.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        window.scrollBy(0, rect.bottom - (window.innerHeight - 60));
        (el as HTMLElement).focus({ preventScroll: true });
      });
      await expect(input).toBeFocused();
      expect(
        await dock.getAttribute("data-avatar-away"),
        "まだ逃がしている",
      ).toBe("true");
      await page.waitForTimeout(1_000);
      expect(await dock.getAttribute("data-avatar-away"), "1 秒後").toBeNull();
      const inputBox = (await input.boundingBox())!;
      expect(
        inputBox.y + inputBox.height,
        "入力欄がアバターの定位置にある",
      ).toBeGreaterThan(page.viewportSize()!.height - 16 - 220);
      // 戻る動き（320ms）を待って、見えている部品が入力欄と重ならない
      await page.waitForTimeout(500);
      for (const rect of await visibleRects(page)) {
        expect(intersects(rect, inputBox), JSON.stringify(rect)).toBe(false);
      }
    });

    test("入力: Mobile の reduced-motion でも、スクロールしている間は（トランジションなしで）逃げる（R19）", async ({
      page,
    }, testInfo) => {
      mobileOnly(testInfo.project.name);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await open(page, "/");
      await declineConsent(page);
      await page
        .locator(DOCK)
        .getByRole("button", { name: AVATAR_LABELS.summon })
        .click();
      await expect(
        page.locator(`${DOCK} img.avatar-dock__still`),
      ).toBeVisible();
      await startScrolling(page);
      await expect(page.locator(DOCK)).toHaveAttribute(
        "data-avatar-away",
        "true",
      );
      // トランジション（medium は 320ms）を待たずに、すぐ画面の外にある
      await page.waitForTimeout(100);
      for (const rect of await visibleRects(page)) {
        expect(rect.x + rect.width, "右端が画面の左の外").toBeLessThanOrEqual(
          0,
        );
      }
      await stopScrolling(page);
    });

    test("入力: お問い合わせの送信ボタンにフォーカスしたとき、アバターがその矩形と重ならない", async ({
      page,
    }, testInfo) => {
      await open(page, "/contact/");
      if (testInfo.project.name === "desktop")
        await expect(page.locator(READY)).toBeAttached({ timeout: 20_000 });
      const submit = page.locator('main form button[type="submit"]').first();
      await submit.focus();
      await expect(submit).toBeFocused();
      const submitBox = (await submit.boundingBox())!;
      await page.waitForTimeout(500);
      for (const rect of await visibleRects(page)) {
        expect(intersects(rect, submitBox), JSON.stringify(rect)).toBe(false);
      }
    });

    test("入力: 送信ボタンがアバターの位置に来ても、フォーカスするとアバターが重ならないようにたたむ（保存はしない）", async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      await open(page, "/contact/");
      await declineConsent(page);
      await expect(page.locator(READY)).toBeAttached({ timeout: 20_000 });
      // 送信ボタンを左下（アバターの枠の中）へ動かしてからフォーカスする
      const submit = page.locator('main form button[type="submit"]').first();
      await submit.evaluate((el) => {
        Object.assign((el as HTMLElement).style, {
          position: "fixed",
          left: "40px",
          bottom: "120px",
          zIndex: "60",
        });
      });
      await submit.focus();
      await expect(page.locator(`${DOCK} canvas`)).toBeHidden();
      const submitBox = (await submit.boundingBox())!;
      for (const rect of await visibleRects(page)) {
        expect(intersects(rect, submitBox), JSON.stringify(rect)).toBe(false);
      }
      expect(
        await page.evaluate(() =>
          window.sessionStorage.getItem("avatar:collapsed"),
        ),
      ).toBeNull();
      // フォーカスが外れたら戻る
      await page.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.blur(),
      );
      await expect(page.locator(`${DOCK} canvas`)).toBeVisible();
    });
  });
});
