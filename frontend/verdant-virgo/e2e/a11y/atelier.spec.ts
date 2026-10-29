// ヒーロー第 2 版「デザイナーのアトリエ」の検査（計画 docs/superpowers/plans/2026-10-28-hero-atelier.md の Task 3〜8）。
// 部品の約束（Task 3。歩かない状態）:
//   - 根は [data-motion="atelier"]。最初の HTML にポスター（<picture> の img）があり、h1 は 3D を待たずに読める
//   - 時間帯は head の inline script が最初の描画の前に <html data-atelier-phase> に付け、ポスターはその時間帯の 1 枚だけを読む（JS なしは昼）
//   - WebGL が使えて reduced-motion でなく、一時停止でなく、遅い端末でなければ、canvas（aria-hidden）に替わり、根に data-atelier-live="true"
//   - 一時停止（MotionPause。storageKey motion:atelier）で描画が止まり、次に開いても最初から止まっている
//   - 端末の速さの判定は sessionStorage の atelier:quality に残る。検証用の VM は GPU が無く遅いので、動く側の検査は判定済みの値を先に置く
import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import sharp from "sharp";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { cls, instrument, rafDuring } from "../support/motion";
import { open } from "./axe";
import { AXE_TAGS } from "./routes";
import { ATELIER } from "../../src/modules/site-content/atelier";
import { CASES } from "../../src/modules/site-content/cases";
import { PROPS } from "../../src/modules/atelier/lib/props";

const ROOT = '[data-motion="atelier"]';
const TOP_ROUTE = "/";
const QUALITY_KEY = "atelier:quality";
const PHASES = ["morning", "day", "dusk", "night"] as const;
/** 各時間帯の中の時刻（端末の現地時刻） */
const AT: Record<(typeof PHASES)[number], string> = {
  morning: "2026-10-29T07:30:00",
  day: "2026-10-29T13:00:00",
  dusk: "2026-10-29T17:30:00",
  night: "2026-10-29T21:00:00",
};

/**
 * 立体を動かす検査の下ごしらえ。検証用の VM は GPU が無く、1440×900 の描画は 1 フレームに数百 ms かかって操作が時間切れになるので、
 * Desktop は 1024×640（Desktop の配置のまま）に縮める（第 1 版の模型より描くものが多い）
 */
async function liveViewport(page: Page, project: string) {
  if (project === "desktop")
    await page.setViewportSize({ width: 1024, height: 640 });
}

/** 端末の判定を「動かしてよい」に先に決めておく（検証用の VM は GPU が無いため） */
export async function presetLive(page: Page) {
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

/** 相対輝度のコントラスト比（WCAG 2.x） */
function contrast(a: number[], b: number[]) {
  const lum = ([r, g, bl]: number[]) => {
    const f = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test.describe("アトリエ（ポスターと時間帯）", () => {
  test.describe("正常系", () => {
    test("時間帯の属性が最初の描画の前に <html data-atelier-phase> に付き、ポスターはその時間帯の画像", async ({
      page,
    }) => {
      await page.clock.setFixedTime(new Date(AT.night));
      // 最初の描画の前に付いていることを、DOMContentLoaded の時点で見る
      await page.addInitScript(() => {
        document.addEventListener("DOMContentLoaded", () => {
          (window as unknown as { __phaseAtDcl: string }).__phaseAtDcl =
            document.documentElement.dataset.atelierPhase ?? "";
        });
      });
      await open(page, TOP_ROUTE);
      expect(
        await page.evaluate(
          () => (window as unknown as { __phaseAtDcl: string }).__phaseAtDcl,
        ),
      ).toBe("night");
      const src = await page
        .locator(`${ROOT} picture img`)
        .evaluate((img: HTMLImageElement) => img.currentSrc);
      expect(src).toMatch(/top-night/);
    });

    test("ポスターは 1 枚だけ要求される（ほかの時間帯の画像を読まない）", async ({
      page,
    }) => {
      await page.clock.setFixedTime(new Date(AT.dusk));
      const requested = new Set<string>();
      page.on("request", (request) => {
        const m = /\/top-(morning|day|dusk|night)(-mobile)?\.[^/]*webp/.exec(
          request.url(),
        );
        if (m) requested.add(m[1]);
      });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await open(page, TOP_ROUTE);
      expect([...requested]).toEqual(["dusk"]);
    });

    test("WebGL があれば canvas に替わり、ポスターと入れ替わる間のレイアウトのずれが 0", async ({
      page,
    }, testInfo) => {
      test.setTimeout(240_000);
      await liveViewport(page, testInfo.project.name);
      await instrument(page);
      await presetLive(page);
      await open(page, TOP_ROUTE);
      const root = page.locator(ROOT);
      await expect(root).toHaveAttribute("data-atelier-live", "true", {
        timeout: 200_000,
      });
      await expect(root.locator("canvas")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      expect((await cls(page)).motion).toBeLessThan(0.001);
    });

    test("一時停止で data-frame が止まり、次に開いても最初から止まっていて canvas を作らない", async ({
      page,
    }, testInfo) => {
      test.setTimeout(240_000);
      await liveViewport(page, testInfo.project.name);
      await instrument(page);
      await presetLive(page);
      await open(page, TOP_ROUTE);
      const root = page.locator(ROOT);
      await expect(root).toHaveAttribute("data-atelier-live", "true", {
        timeout: 200_000,
      });
      await root.getByRole("button", { name: /動きを止める/ }).click();
      await expect(root).toHaveAttribute("data-motion-paused", "true");
      const frame = () =>
        root
          .locator("canvas")
          .evaluate((c: HTMLCanvasElement) => c.dataset.frame ?? "");
      const before = await frame();
      await rafDuring(page, 1_000);
      expect(await frame()).toBe(before);
      await open(page, TOP_ROUTE);
      await expect(page.locator(ROOT)).toHaveAttribute(
        "data-motion-paused",
        "true",
      );
      await page.waitForTimeout(3_000);
      await expect(page.locator(`${ROOT} canvas`)).toHaveCount(0);
    });

    test("canvas は aria-hidden、axe の違反 0", async ({ page }, testInfo) => {
      test.setTimeout(240_000);
      await liveViewport(page, testInfo.project.name);
      await presetLive(page);
      await open(page, TOP_ROUTE);
      await expect(page.locator(ROOT)).toHaveAttribute(
        "data-atelier-live",
        "true",
        { timeout: 200_000 },
      );
      const result = await new AxeBuilder({ page })
        .withTags(AXE_TAGS)
        .include("[data-atelier-hero]")
        .analyze();
      expect(result.violations.map((v) => v.id)).toEqual([]);
    });

    for (const phase of PHASES) {
      test(`時間帯の覆いの上の文字のコントラストが 4.5 以上（${phase}）`, async ({
        page,
      }) => {
        await page.clock.setFixedTime(new Date(AT[phase]));
        await page.emulateMedia({ reducedMotion: "reduce" });
        await open(page, TOP_ROUTE);
        await expect(page.locator("html")).toHaveAttribute(
          "data-atelier-phase",
          phase,
        );
        // 文字の後ろの覆いは --atelier-veil を 84% で重ねる。いちばん悪い場合（覆いの下の絵が白）の地の色を、覆いの色と白を 84:16 で混ぜた色とし、
        // ヒーローの文字（h1・本文・注記）の色と比べる
        const colors = await page.evaluate(() => {
          const rgb = (css: string) => {
            const probe = document.createElement("div");
            probe.style.color = css;
            document.body.appendChild(probe);
            const out = getComputedStyle(probe)
              .color.match(/[\d.]+/g)!
              .slice(0, 3)
              .map(Number);
            probe.remove();
            return out;
          };
          const hero = document.querySelector("[data-atelier-hero]")!;
          const veil = getComputedStyle(hero)
            .getPropertyValue("--atelier-veil")
            .trim();
          const texts = [...hero.querySelectorAll<HTMLElement>("h1, p")].filter(
            (el) => el.offsetParent !== null && el.textContent?.trim(),
          );
          return {
            veil: rgb(veil),
            texts: texts.map((el) =>
              getComputedStyle(el)
                .color.match(/[\d.]+/g)!
                .slice(0, 3)
                .map(Number),
            ),
          };
        });
        expect(colors.texts.length).toBeGreaterThan(2);
        const worst = colors.veil.map((c) => c * 0.84 + 255 * 0.16);
        for (const t of colors.texts)
          expect(contrast(t, worst)).toBeGreaterThanOrEqual(4.5);
      });
    }
  });

  test.describe("異常系", () => {
    test("入力: reduced-motion では three を読まず、ポスターのまま（一時停止のボタンも出ない）", async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await presetLive(page);
      const three = countThree(page);
      await open(page, TOP_ROUTE);
      await page.waitForTimeout(4_000);
      const root = page.locator(ROOT);
      await expect(root.locator("canvas")).toHaveCount(0);
      await expect(root.locator("picture img")).toBeVisible();
      await expect(
        root.getByRole("button", { name: /動きを止める|動きを再開する/ }),
      ).toHaveCount(0);
      expect(three.count, "three を読んでいない").toBe(0);
    });

    test("入力: WebGL が無いとポスターのまま", async ({ page }) => {
      await page.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (
          this: HTMLCanvasElement,
          type: string,
          ...rest: unknown[]
        ) {
          if (/webgl/.test(type)) return null;
          return (original as (...a: unknown[]) => unknown).call(
            this,
            type,
            ...rest,
          );
        } as typeof original;
      });
      await presetLive(page);
      const three = countThree(page);
      await open(page, TOP_ROUTE);
      await page.waitForTimeout(4_000);
      const root = page.locator(ROOT);
      await expect(root.locator("canvas")).toHaveCount(0);
      await expect(root.locator("picture img")).toBeVisible();
      expect(three.count).toBe(0);
    });

    test("入力: 遅い端末（フレームが 40ms を超える）はポスターに戻り、判定が sessionStorage に残る", async ({
      page,
    }, testInfo) => {
      test.setTimeout(360_000);
      await liveViewport(page, testInfo.project.name);
      // 遅い端末: 読み込みは普通の速さのまま、描画のフレームの間隔だけを 60ms に引き延ばす（第 1 版と同じ作り）
      await page.addInitScript(() => {
        const original = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (callback) =>
          original(
            () =>
              setTimeout(
                () => callback(performance.now()),
                60,
              ) as unknown as number,
          );
      });
      await open(page, TOP_ROUTE);
      const root = page.locator(ROOT);
      await expect
        .poll(
          () =>
            page.evaluate((key) => sessionStorage.getItem(key), QUALITY_KEY),
          { timeout: 300_000 },
        )
        .toContain('"live":false');
      await expect(root).not.toHaveAttribute("data-atelier-live", "true");
      await expect(root.locator("picture img")).toBeVisible();
      await expect(root.locator("canvas")).toHaveCount(0);
    });
  });
});

test.describe("アトリエ（JS なし）", () => {
  test.use({ javaScriptEnabled: false });

  test("空入力: JS（と WebGL）が無くても、展示の壁の額の文字（題と説明）が HTML の文字として読める（1.1.1。額の絵は canvas の画素だけ）", async ({
    page,
  }) => {
    await page.goto(TOP_ROUTE);
    const hero = page.locator("[data-atelier-hero]");
    for (const frame of Object.values(ATELIER.frames)) {
      await expect(hero).toContainText(frame.title);
      await expect(hero).toContainText(frame.body);
    }
  });

  test("空入力: JS が無くても、昼のポスターと h1 が最初の HTML で見える", async ({
    page,
  }) => {
    await page.goto(TOP_ROUTE);
    const img = page.locator(`${ROOT} img[src*="top-day"]`).first();
    await expect(img).toBeVisible();
    await expect(page.locator("h1")).toBeVisible();
  });
});

// Task 4。歩く（マウス・長押し・キーボード）。島の根に data-atelier-t（0〜1。小数 3 桁）と data-atelier-walking（進んでいる間）
const POS_KEY = "atelier:pos";
const STILLS_DIR = path.resolve("src/modules/atelier/assets/stills");

async function openLive(page: Page, project: string, pos?: number) {
  await liveViewport(page, project);
  await presetLive(page);
  if (pos !== undefined)
    await page.addInitScript(
      ([key, value]) => {
        try {
          if (!sessionStorage.getItem("__pos_set")) {
            sessionStorage.setItem(key, value);
            sessionStorage.setItem("__pos_set", "1");
          }
        } catch {}
      },
      [POS_KEY, String(pos)] as const,
    );
  await open(page, TOP_ROUTE);
  const root = page.locator(ROOT);
  await expect(root).toHaveAttribute("data-atelier-live", "true", {
    timeout: 200_000,
  });
  return root;
}

const tOf = async (page: Page) =>
  Number((await page.locator(ROOT).getAttribute("data-atelier-t")) ?? "NaN");

/** ヒーローの中の、文字・ボタン・置き物の無い所（天窓のあたり） */
async function emptySpot(page: Page) {
  const box = (await page.locator("[data-atelier-hero]").boundingBox())!;
  return { x: box.x + box.width * 0.62, y: box.y + box.height * 0.18 };
}

/** CDP で指を置いて、ms のあいだ押したまま、指を離す（Chrome は pointer 事件を作る） */
async function longPress(
  page: Page,
  x: number,
  y: number,
  ms: number,
  move?: { dy: number },
) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  if (move) {
    for (let i = 1; i <= 8; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y + (move.dy * i) / 8 }],
      });
      await page.waitForTimeout(16);
    }
  }
  await page.waitForTimeout(ms);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

test.describe("アトリエ（歩く）", () => {
  test.describe.configure({ timeout: 300_000 });

  test.describe("正常系", () => {
    test("canvas の空いた所にカーソルを置くと進み、外すとゆっくり止まる", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "マウスは Desktop");
      await openLive(page, testInfo.project.name);
      const spot = await emptySpot(page);
      await page.mouse.move(spot.x, spot.y);
      await expect
        .poll(() => tOf(page), { timeout: 60_000 })
        .toBeGreaterThan(0.01);
      await page.mouse.move(1, 1);
      const left = await tOf(page);
      // 外した後も少し進んでから止まる（急に止まらない。アンチゴール 2）
      await expect
        .poll(() => tOf(page), { timeout: 30_000 })
        .toBeGreaterThan(left);
      await expect(page.locator(ROOT)).not.toHaveAttribute(
        "data-atelier-walking",
        /.*/,
        { timeout: 60_000 },
      );
    });

    // 2026-10-29（ユーザーの指示）: 文字の板（「現場の言葉と、技術の言葉を。」の板）は、カメラが動いている間は隠す（1280px 以上。3D に重ねる配置だけ）。
    // 止まると戻る。板の中にキーボードのフォーカスがあるときは隠さない（フォーカスした物を消さない）
    test("1280px 以上: カメラが動いている間（data-atelier-walking・data-atelier-flying）は文字の板を隠し、中のリンクを押せなくし、止まると戻す", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "重ねる配置は Desktop");
      // 動いている間に根に印が付くことは、上の「進み、外すとゆっくり止まる」が確かめる。ここでは印と板の見え方の約束だけを見る。
      // GPU の無い VM で 3D を動かしながら読むと、読む間に状態が変わる（1 秒に 1 コマ）ので、ポスターのまま印を手で付け外しする
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.addInitScript(() => {
        try {
          sessionStorage.setItem("atelier:quality", JSON.stringify({ live: false, dpr: 1 }));
        } catch {}
      });
      await open(page, TOP_ROUTE);
      const state = (mark: "walking" | "flying" | null) =>
        page.evaluate((mark) => {
          const r = document.querySelector('[data-motion="atelier"]')!;
          const c = document.querySelector<HTMLElement>("[data-atelier-hero] .atelier-hero__copy")!;
          c.style.setProperty("transition", "none");
          r.removeAttribute("data-atelier-walking");
          r.removeAttribute("data-atelier-flying");
          if (mark === "walking") r.setAttribute("data-atelier-walking", "forward");
          if (mark === "flying") r.setAttribute("data-atelier-flying", "pricing");
          return { opacity: Number(getComputedStyle(c).opacity), link: getComputedStyle(c.querySelector("a")!).pointerEvents };
        }, mark);
      expect(await state(null)).toEqual({ opacity: 1, link: "auto" });
      expect(await state("walking")).toEqual({ opacity: 0, link: "none" });
      expect(await state("flying")).toEqual({ opacity: 0, link: "none" });
      expect(await state(null)).toEqual({ opacity: 1, link: "auto" });
      // 板の中にフォーカスがあるときは隠さない
      await page.locator("[data-atelier-hero] .atelier-hero__copy a").first().focus();
      expect((await state("walking")).opacity).toBe(1);
      // 1279px 以下（文字は 3D の下）は隠さない
      await page.locator("body").evaluate((b) => (document.activeElement as HTMLElement | null)?.blur());
      await page.setViewportSize({ width: 1024, height: 720 });
      expect((await state("walking")).opacity).toBe(1);
    });

    test("1280px 以上: 文字の板の中にフォーカスがあるまま矢印キーで歩いても、板は隠さない", async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "キーボードは Desktop");
      const root = await openLive(page, testInfo.project.name);
      await page.setViewportSize({ width: 1280, height: 720 });
      const copy = page.locator("[data-atelier-hero] .atelier-hero__copy");
      await copy.locator("a").first().focus();
      await page.keyboard.down("ArrowUp");
      await expect(root).toHaveAttribute("data-atelier-walking", "forward", { timeout: 60_000 });
      await page.waitForTimeout(800);
      expect(await copy.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
      await page.keyboard.up("ArrowUp");
    });

    // 2026-10-30（ユーザーの指示）: 右側だけでなく左側も通れる。道は 2 本（根の data-atelier-lane: 0＝右・1＝左）
    test("左側も通れる: カーソルが左半分にある間は左の道へ、右半分にある間は右の道へ移る（アバターのそばでは替えない）", async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "マウスは Desktop");
      const root = await openLive(page, testInfo.project.name);
      const lane = async () => Number((await root.getAttribute("data-atelier-lane")) ?? "NaN");
      // 3D の上の左半分の、ボタン・案内の無い所
      const spotAt = (side: "left" | "right") =>
        page.evaluate((side) => {
          const r = document.querySelector('[data-motion="atelier"]')!.getBoundingClientRect();
          const xs = side === "left" ? [0.2, 0.3, 0.12, 0.4] : [0.7, 0.8, 0.6, 0.88];
          for (const fx of xs)
            for (const fy of [0.2, 0.3, 0.15, 0.4]) {
              const x = r.left + r.width * fx;
              const y = r.top + r.height * fy;
              const hit = document.elementFromPoint(x, y);
              if (hit?.closest('[data-motion="atelier"]') && !hit.closest("button, a, [data-atelier-ui]")) return { x, y };
            }
          return null;
        }, side);
      const left = (await spotAt("left"))!;
      expect(left).not.toBeNull();
      await page.mouse.move(left.x, left.y);
      await page.mouse.move(left.x + 3, left.y + 2);
      await expect.poll(lane, { timeout: 120_000 }).toBeGreaterThan(0.5);
      const right = (await spotAt("right"))!;
      await page.mouse.move(right.x, right.y);
      await page.mouse.move(right.x + 3, right.y + 2);
      await expect.poll(lane, { timeout: 120_000 }).toBeLessThan(0.5);
      await page.mouse.move(1, 1);
    });

    test("入力: 3D の上のボタン（アバターの名札など）が画面の端に来ても、ページは横にスクロールしない", async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "アバターの名札は Desktop で確かめる");
      const root = await openLive(page, testInfo.project.name);
      const avatar = root.locator(".atelier__avatar");
      await expect(avatar).toBeVisible({ timeout: 120_000 });
      // 左の道ではアバターが右の端に来る。名札（文字は見えない間も幅を持つ）が画面の外へはみ出す位置に置く
      const widths = await page.evaluate(() => {
        const b = document.querySelector<HTMLElement>('[data-motion="atelier"] .atelier__avatar')!;
        b.style.left = `${document.documentElement.clientWidth - 10}px`;
        return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
      });
      expect(widths.sw).toBe(widths.cw);
    });

    test("左側も通れる（キーボード）: ← で左の道、→ で右の道へ移る（2.1.1）", async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "キーボードは Desktop");
      const root = await openLive(page, testInfo.project.name);
      const lane = async () => Number((await root.getAttribute("data-atelier-lane")) ?? "NaN");
      await root.getByRole("button", { name: ATELIER.forward }).focus();
      // 入口は 2 本の道が同じ所なので、立ち止まったままでも替えられる（ページは横に送られない）
      const scrolled = await page.evaluate(() => window.scrollX);
      await page.keyboard.press("ArrowLeft");
      await expect.poll(lane, { timeout: 120_000 }).toBe(1);
      await page.keyboard.press("ArrowRight");
      await expect.poll(lane, { timeout: 120_000 }).toBe(0);
      expect(await page.evaluate(() => window.scrollX)).toBe(scrolled);
    });

    test("相談の席の前（t=1）で止まり、それ以上進まない", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "マウスは Desktop");
      await openLive(page, testInfo.project.name, 0.985);
      const spot = await emptySpot(page);
      await page.mouse.move(spot.x, spot.y);
      await expect.poll(() => tOf(page), { timeout: 60_000 }).toBe(1);
      await page.waitForTimeout(1_500);
      expect(await tOf(page)).toBe(1);
    });

    test("少しでも進むと「入口に戻る」が出て、押すと入口へワープする（歩いて戻らない。2026-10-30 ユーザーの指示）", async ({
      page,
    }, testInfo) => {
      const root = await openLive(page, testInfo.project.name, 0.1);
      const back = root.getByRole("button", { name: ATELIER.back });
      await expect(back).toBeVisible();
      // 歩いて戻る（data-atelier-walking="back"）が一度でも出たかを残す
      await page.evaluate(() => {
        const r = document.querySelector('[data-motion="atelier"]')!;
        (window as unknown as { __walkedBack: boolean }).__walkedBack = false;
        new MutationObserver(() => {
          if (r.getAttribute("data-atelier-walking") === "back") (window as unknown as { __walkedBack: boolean }).__walkedBack = true;
        }).observe(r, { attributes: true, attributeFilter: ["data-atelier-walking"] });
      });
      await back.click();
      // ワープなので、押した直後に t が 0（GPU の無い VM でも 1 フレームを待たない）
      expect(await tOf(page)).toBe(0);
      await expect(back).toBeHidden();
      await page.waitForTimeout(1_500);
      expect(await page.evaluate(() => (window as unknown as { __walkedBack: boolean }).__walkedBack)).toBe(false);
      expect(await tOf(page)).toBe(0);
    });

    test("1280px 以上・入口（t=0）: 点はそれぞれの置き物の近くに出る（文字の板の右に寄せて縦に並べない）。板に隠れる置き物の点は、板がある間は出さない", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "点を重ねるのは Desktop");
      const root = await openLive(page, testInfo.project.name);
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.waitForTimeout(1_500);
      // 入口のポスターと同じ構図（歩くカメラの t=0。cover）の、置き物の位置（画像に対する %）
      const phase = await page.evaluate(() => document.documentElement.getAttribute("data-atelier-phase") ?? "day");
      const anchors = JSON.parse(
        fs.readFileSync(path.join(STILLS_DIR, `top-${phase}.anchors.json`), "utf-8"),
      ) as Record<string, { x: number; y: number }>;
      const placed = await root.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const copy = document.querySelector("[data-atelier-hero] .atelier-hero__copy")!.getBoundingClientRect();
        return {
          box: { w: box.width, h: box.height, left: box.left, top: box.top },
          copy: { left: copy.left - box.left, right: copy.right - box.left, top: copy.top - box.top, bottom: copy.bottom - box.top },
          points: [...el.querySelectorAll<HTMLElement>("[data-atelier-prop], [data-atelier-frame]")]
            .filter((b) => !b.hidden)
            .map((b) => {
              const r = b.getBoundingClientRect();
              const id = b.dataset.atelierProp ?? `frame:${b.dataset.atelierFrame}`;
              return { id, x: r.left + r.width / 2 - box.left, y: r.top + r.height / 2 - box.top };
            }),
        };
      });
      expect(placed.points.length).toBeGreaterThan(0);
      // cover: 16:9 の絵を枠いっぱいに敷き詰める
      const s = Math.max(placed.box.w / 16, placed.box.h / 9);
      const [iw, ih] = [16 * s, 9 * s];
      const [ox, oy] = [(placed.box.w - iw) / 2, (placed.box.h - ih) / 2];
      for (const p of placed.points) {
        const a = anchors[p.id]!;
        const [ax, ay] = [ox + (a.x / 100) * iw, oy + (a.y / 100) * ih];
        // 点どうしを離す分（34px）までのずれは許す
        expect(Math.hypot(p.x - ax, p.y - ay), `${p.id} が置き物から離れている`).toBeLessThanOrEqual(40);
        // 板の上には置かない
        const onCopy = p.x >= placed.copy.left && p.x <= placed.copy.right && p.y >= placed.copy.top && p.y <= placed.copy.bottom;
        expect(onCopy, `${p.id} が板の上にある`).toBe(false);
      }
    });

    test("一度カメラが動いたら、文字の板はそのセッションの間（読み込み直しても）隠れたまま。新しいセッションでは出る。動けない端末（reduced-motion）では隠さない", async ({
      page,
      browser,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "重ねる配置は Desktop");
      const root = await openLive(page, testInfo.project.name);
      await root.getByRole("button", { name: ATELIER.forward }).click();
      await expect(root).toHaveAttribute("data-atelier-walking", "forward", { timeout: 60_000 });
      expect(await page.evaluate(() => sessionStorage.getItem("atelier:moved"))).toBe("1");
      // 同じセッションで 1280px にして読み込み直す: 最初の描画から隠れている（読み込み直しで一瞬出ない）
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.reload();
      const copy = page.locator("[data-atelier-hero] .atelier-hero__copy");
      const shown = () => copy.evaluate((el) => ({ opacity: getComputedStyle(el).opacity, pe: getComputedStyle(el).pointerEvents }));
      expect(await shown()).toEqual({ opacity: "0", pe: "none" });
      // キーボードで板の中へ入ると出る（フォーカスした物を見えなくしない）
      await copy.locator("a").first().focus();
      await expect.poll(async () => (await shown()).opacity).toBe("1");
      // 新しいセッション（別の context）では出る
      const fresh = await browser.newContext({ viewport: { width: 1280, height: 720 }, baseURL: testInfo.project.use.baseURL });
      const p2 = await fresh.newPage();
      await p2.goto(TOP_ROUTE);
      expect(await p2.locator("[data-atelier-hero] .atelier-hero__copy").evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
      // reduced-motion（3D を出さない）では、動いた記録があっても隠さない
      const reduced = await browser.newContext({ viewport: { width: 1280, height: 720 }, baseURL: testInfo.project.use.baseURL, reducedMotion: "reduce" });
      const p3 = await reduced.newPage();
      await p3.addInitScript(() => sessionStorage.setItem("atelier:moved", "1"));
      await p3.goto(TOP_ROUTE);
      expect(await p3.locator("[data-atelier-hero] .atelier-hero__copy").evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
      await fresh.close();
      await reduced.close();
    });

    test("キーボード: 「前へ進む」で次の止まる所まで進む。↑ を押している間は進み、↓ で戻る", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "キーボードは Desktop");
      const root = await openLive(page, testInfo.project.name);
      const forward = root.getByRole("button", { name: ATELIER.forward });
      await forward.focus();
      const scrolled = await page.evaluate(() => window.scrollY);
      await page.keyboard.press("Enter");
      await expect
        .poll(() => tOf(page), { timeout: 60_000 })
        .toBeGreaterThan(0.02);
      await expect(root).not.toHaveAttribute("data-atelier-walking", /.*/, {
        timeout: 120_000,
      });
      const stopped = await tOf(page);
      await page.keyboard.down("ArrowUp");
      await expect
        .poll(() => tOf(page), { timeout: 60_000 })
        .toBeGreaterThan(stopped + 0.01);
      await page.keyboard.up("ArrowUp");
      await expect(root).not.toHaveAttribute("data-atelier-walking", /.*/, {
        timeout: 120_000,
      });
      const ahead = await tOf(page);
      await page.keyboard.down("ArrowDown");
      await expect
        .poll(() => tOf(page), { timeout: 60_000 })
        .toBeLessThan(ahead - 0.005);
      await page.keyboard.up("ArrowDown");
      // ページは送られない（フォーカスがヒーローの中にある間の矢印は歩く操作）
      expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
    });

    test("Mobile: 空いた所を 300ms 以上押している間だけ進む。長押しで文字の選択・メニューが出ない", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "mobile", "長押しは Mobile");
      const root = await openLive(page, testInfo.project.name);
      const spot = await emptySpot(page);
      // GPU の無い VM では 1 秒に数フレームしか描けず、1 フレームの進みは 0.1 秒ぶんまでなので、長めに押す
      await longPress(page, spot.x, spot.y, 6_000);
      await expect
        .poll(() => tOf(page), { timeout: 60_000 })
        .toBeGreaterThan(0.005);
      expect(
        await page.evaluate(() => window.getSelection()?.toString() ?? ""),
      ).toBe("");
      const prevented = await root.evaluate((el) => {
        const event = new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(event);
        return event.defaultPrevented;
      });
      expect(prevented).toBe(true);
    });

    test("Mobile: 縦のスワイプはページをスクロールする", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "mobile", "スワイプは Mobile");
      await openLive(page, testInfo.project.name);
      const spot = await emptySpot(page);
      await longPress(page, spot.x, spot.y + 300, 50, { dy: -260 });
      await expect
        .poll(() => page.evaluate(() => window.scrollY), { timeout: 10_000 })
        .toBeGreaterThan(50);
      expect(await tOf(page)).toBe(0);
    });

    test("進んだ位置は atelier:pos に残り、開き直すと同じ位置から描く", async ({
      page,
    }, testInfo) => {
      await openLive(page, testInfo.project.name, 0.3);
      expect(await tOf(page)).toBeCloseTo(0.3, 2);
      await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
      expect(
        Number(
          await page.evaluate((key) => sessionStorage.getItem(key), POS_KEY),
        ),
      ).toBeCloseTo(0.3, 2);
      await open(page, TOP_ROUTE);
      await expect(page.locator(ROOT)).toHaveAttribute(
        "data-atelier-live",
        "true",
        { timeout: 200_000 },
      );
      expect(await tOf(page)).toBeCloseTo(0.3, 2);
    });

    test("一時停止の間も進める", async ({ page }, testInfo) => {
      const root = await openLive(page, testInfo.project.name);
      await root.getByRole("button", { name: /動きを止める/ }).click();
      await expect(root).toHaveAttribute("data-motion-paused", "true");
      await root.getByRole("button", { name: ATELIER.forward }).click();
      await expect
        .poll(() => tOf(page), { timeout: 60_000 })
        .toBeGreaterThan(0.02);
    });

    test("axe の違反 0。「前へ進む」「入口に戻る」は 24px 以上", async ({
      page,
    }, testInfo) => {
      const root = await openLive(page, testInfo.project.name, 0.2);
      for (const name of [ATELIER.forward, ATELIER.back]) {
        const box = (await root.getByRole("button", { name }).boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(24);
        expect(box.height).toBeGreaterThanOrEqual(24);
      }
      const result = await new AxeBuilder({ page })
        .withTags(AXE_TAGS)
        .include("[data-atelier-hero]")
        .analyze();
      expect(result.violations.map((v) => v.id)).toEqual([]);
    });
  });

  test.describe("異常系", () => {
    test("入力: 文字・CTA の上にカーソルがある間は進まない", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "マウスは Desktop");
      await openLive(page, testInfo.project.name);
      await page.locator("[data-atelier-hero] h1").hover();
      await page.waitForTimeout(3_000);
      expect(await tOf(page)).toBe(0);
      await page.locator("[data-atelier-hero] a").first().hover();
      await page.waitForTimeout(3_000);
      expect(await tOf(page)).toBe(0);
    });

    test("入力: 1279px 以下（3D の下に文字を積む）で、3D の外（文字のまわりの余白）にカーソルを置いても進まず、Tips も開かない", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "マウスは Desktop");
      // openLive は Desktop を 1024×640 にする（積む配置）。ヒーローの区画の中で、3D の箱の外・文字の板の外の余白
      // （文字の層〈.atelier-hero__inner〉の下の padding。1024px では文字の板が横幅いっぱいなので、右の余白は無い）
      await openLive(page, testInfo.project.name);
      await page.evaluate(() => {
        const inner = document.querySelector(".atelier-hero__inner")!.getBoundingClientRect();
        window.scrollBy(0, inner.bottom - innerHeight + 120);
      });
      await page.waitForTimeout(500);
      const spot = await page.evaluate(() => {
        const inner = document.querySelector(".atelier-hero__inner")!.getBoundingClientRect();
        const copy = document.querySelector("[data-atelier-hero] .atelier-hero__copy")!.getBoundingClientRect();
        const x = inner.left + inner.width / 2;
        const y = (copy.bottom + inner.bottom) / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          x,
          y,
          hit: hit ? `${hit.tagName}.${String(hit.className)}`.slice(0, 60) : null,
          inHero: !!hit?.closest("[data-atelier-hero]"),
          in3d: !!hit?.closest('[data-motion="atelier"]'),
          onCopy: !!hit?.closest(".atelier-hero__copy"),
        };
      });
      expect(spot).toMatchObject({ inHero: true, in3d: false, onCopy: false });
      await page.mouse.move(spot.x, spot.y);
      await page.mouse.move(spot.x + 4, spot.y + 2);
      await page.waitForTimeout(3_000);
      expect(await tOf(page)).toBe(0);
      await expect(page.locator("[data-atelier-tips]")).toHaveCount(0);
    });

    test("入力: 明るい壁・空の上でも、3D の上の点・アバター・操作のボタンのフォーカスが見える（白い輪の外に暗い輪。2.4.7・1.4.11）", async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "キーボードは Desktop");
      const root = await openLive(page, testInfo.project.name);
      // 白い輪（outline）だけだと、昼・朝の明るい地（コンクリート #f3e9dc・空）で 3:1 に届かない。外側に暗い輪（box-shadow）を持つ
      const darkRing = (shadow: string) =>
        [...shadow.matchAll(/rgba?\(([^)]+)\)/g)].some((m) => {
          const [r, g, b, a = "1"] = m[1].split(",").map((v) => v.trim());
          const lum = (0.2126 * Number(r) + 0.7152 * Number(g) + 0.0722 * Number(b)) / 255;
          return lum < 0.25 && Number(a) >= 0.6;
        });
      for (const selector of [".atelier-point:not([hidden])", ".atelier__avatar", ".atelier__button"]) {
        const target = root.locator(selector).first();
        await target.focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await expect(target).toBeFocused();
        const style = await target.evaluate((el) => ({ outline: getComputedStyle(el).outlineStyle, shadow: getComputedStyle(el).boxShadow }));
        expect(style.outline, selector).toBe("solid");
        expect(darkRing(style.shadow), `${selector}: ${style.shadow}`).toBe(true);
      }
    });

    test("入力: ホイールはページをスクロールし、進まない", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "ホイールは Desktop");
      await openLive(page, testInfo.project.name);
      const box = (await page.locator("[data-atelier-hero] h1").boundingBox())!;
      await page.mouse.move(box.x + 4, box.y + 4);
      await page.mouse.wheel(0, 400);
      await expect
        .poll(() => page.evaluate(() => window.scrollY), { timeout: 60_000 })
        .toBeGreaterThan(100);
      expect(await tOf(page)).toBe(0);
    });

    test("入力: Mobile で短くタップしても進まない", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "mobile", "タップは Mobile");
      await openLive(page, testInfo.project.name);
      const spot = await emptySpot(page);
      await page.touchscreen.tap(spot.x, spot.y);
      await page.waitForTimeout(3_000);
      expect(await tOf(page)).toBe(0);
    });
  });
});

// Task 5。代表のアバター（押すとランダムに身ぶり）。根に data-atelier-avatar="ready"（立った）と data-atelier-avatar-motion（いまの身ぶり）
const MOTION_NAMES = [
  "greeting",
  "nod",
  "peace",
  "point",
  "show-full-body",
  "think",
];

async function openWithAvatar(page: Page, project: string) {
  const root = await openLive(page, project);
  await expect(root).toHaveAttribute("data-atelier-avatar", "ready", {
    timeout: 200_000,
  });
  return root;
}

test.describe("アトリエ（代表のアバター）", () => {
  test.describe.configure({ timeout: 360_000 });

  test.describe("正常系", () => {
    test("アバターのボタン（名札の名前）を押すと身ぶりが始まる", async ({
      page,
    }, testInfo) => {
      const root = await openWithAvatar(page, testInfo.project.name);
      await root.getByRole("button", { name: ATELIER.avatarName }).click();
      await expect(root).toHaveAttribute(
        "data-atelier-avatar-motion",
        new RegExp(`^(${MOTION_NAMES.join("|")})$`),
      );
    });

    test("続けて押しても同じ身ぶりが 2 回続かない", async ({
      page,
    }, testInfo) => {
      const root = await openWithAvatar(page, testInfo.project.name);
      const button = root.getByRole("button", { name: ATELIER.avatarName });
      const seen: string[] = [];
      // GPU の無い VM では、押すたびにボタンが落ち着くのを待つ（1 秒に 1 フレームを切る）ので、5 回にする（続けて同じ身ぶりが出ないことは 4 組で見られる）
      for (let i = 0; i < 5; i++) {
        await button.click();
        seen.push(
          (await root.getAttribute("data-atelier-avatar-motion")) ?? "",
        );
      }
      for (const m of seen) expect(MOTION_NAMES).toContain(m);
      for (let i = 1; i < seen.length; i++)
        expect(seen[i]).not.toBe(seen[i - 1]);
    });

    test("Enter でも同じ", async ({ page }, testInfo) => {
      const root = await openWithAvatar(page, testInfo.project.name);
      await root.getByRole("button", { name: ATELIER.avatarName }).focus();
      await page.keyboard.press("Enter");
      await expect(root).toHaveAttribute(
        "data-atelier-avatar-motion",
        new RegExp(`^(${MOTION_NAMES.join("|")})$`),
      );
    });

    test("カーソルを乗せると名札が出て、ページは移らない", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "カーソルは Desktop");
      const root = await openWithAvatar(page, testInfo.project.name);
      const button = root.getByRole("button", { name: ATELIER.avatarName });
      await button.hover();
      await expect(root.locator("[data-atelier-avatar-label]")).toBeVisible();
      await expect(root.locator("[data-atelier-avatar-label]")).toHaveText(
        ATELIER.avatarName,
      );
      await button.click();
      await page.waitForTimeout(1_000);
      expect(new URL(page.url()).pathname).toBe("/");
    });
  });
});

// Task 6。置き物と Tips・展示の壁・動かないときの一覧。
// 置き物のボタンは [data-atelier-prop="<id>"]、額のボタンは [data-atelier-frame="<n>"]、Tips は [data-atelier-tips]（role="dialog"）、一覧は [data-atelier-list]
const TIP_PROPS = Object.entries(PROPS)
  .filter(([, p]) => p.href)
  .map(([id, p]) => ({
    id: id as keyof typeof ATELIER.props,
    href: p.href!,
    still: p.still!,
  }));

test.describe("アトリエ（置き物と Tips）", () => {
  test.describe.configure({ timeout: 420_000 });

  test.describe("正常系", () => {
    test("置き物にカーソルを乗せると縁が光り、Tips（画像・見出し・説明・見る）が出る。画像は移り先の静止画（その時間帯）", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "カーソルは Desktop");
      await page.clock.setFixedTime(new Date(AT.dusk));
      const root = await openLive(page, testInfo.project.name);
      await root.locator('[data-atelier-prop="pricing"]').hover();
      await expect(root).toHaveAttribute("data-atelier-hover", "pricing");
      const tips = page.locator("[data-atelier-tips]");
      await expect(tips).toBeVisible();
      await expect(tips.getByRole("heading")).toHaveText(
        ATELIER.props.pricing.heading,
      );
      await expect(tips).toContainText(ATELIER.props.pricing.body);
      await expect(
        tips.getByRole("link", { name: new RegExp(ATELIER.props.pricing.cta) }),
      ).toHaveAttribute("href", "/pricing/");
      expect(await tips.locator("img").getAttribute("src")).toMatch(
        /pricing-dusk/,
      );
    });

    test("Tips を開いている間はカーソルを動かしても進まない", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "カーソルは Desktop");
      const root = await openLive(page, testInfo.project.name);
      await root.locator('[data-atelier-prop="pricing"]').click();
      await expect(page.locator("[data-atelier-tips]")).toBeVisible();
      const spot = await emptySpot(page);
      await page.mouse.move(spot.x, spot.y);
      await page.mouse.move(spot.x + 30, spot.y + 10, { steps: 5 });
      await page.waitForTimeout(3_000);
      expect(await tOf(page)).toBe(0);
    });

    test("8 つの置き物の Tips の「見る」は、それぞれの移り先へのリンク。押すと移る", async ({
      page,
    }, testInfo) => {
      const root = await openLive(page, testInfo.project.name);
      // ボタンは 8 つとも DOM にある。Desktop は画面に入っている置き物だけを押せる（画面の外のボタンは隠す。歩くと現れる）
      await expect(root.locator("[data-atelier-prop]")).toHaveCount(8);
      let checked = 0;
      for (const prop of TIP_PROPS) {
        const button = root.locator(`[data-atelier-prop="${prop.id}"]`);
        if (await button.isHidden()) continue;
        checked++;
        await button.click();
        const link = page.locator("[data-atelier-tips]").getByRole("link");
        await expect(link).toHaveAttribute("href", prop.href);
        await page.keyboard.press("Escape");
        await expect(page.locator("[data-atelier-tips]")).toHaveCount(0);
      }
      expect(checked).toBeGreaterThanOrEqual(
        testInfo.project.name === "mobile" ? 8 : 6,
      );
      await root.locator('[data-atelier-prop="blog"]').click();
      await page.locator("[data-atelier-tips]").getByRole("link").click();
      await expect(page).toHaveURL(/\/blog\/$/, { timeout: 60_000 });
    });

    test("Tab で置き物のボタンを順にたどれ、Enter で Tips、もう一度 Enter（「見る」）で移る", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "キーボードは Desktop");
      const root = await openLive(page, testInfo.project.name);
      const shown = await root
        .locator("[data-atelier-prop]:not([hidden])")
        .count();
      const first = root.locator("[data-atelier-prop]:not([hidden])").first();
      await first.focus();
      const visited = new Set<string>();
      for (let i = 0; i < 12; i++) {
        const id = await page.evaluate(
          () => document.activeElement?.getAttribute("data-atelier-prop") ?? "",
        );
        if (id) visited.add(id);
        await page.keyboard.press("Tab");
      }
      expect(shown).toBeGreaterThanOrEqual(6);
      expect(visited.size).toBe(shown);
      await root.locator('[data-atelier-prop="contact"]').focus();
      await page.keyboard.press("Enter");
      const link = page.locator("[data-atelier-tips]").getByRole("link");
      await expect(link).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/contact\/$/, { timeout: 60_000 });
    });

    test("Escape・外側を押すと閉じる。Escape はボタンへフォーカスを戻し、外側を押したときは戻さない", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "Desktop");
      const root = await openLive(page, testInfo.project.name);
      const button = root.locator('[data-atelier-prop="development"]');
      await button.click();
      await expect(page.locator("[data-atelier-tips]")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-atelier-tips]")).toHaveCount(0);
      await expect(button).toBeFocused();
      await button.click();
      await expect(page.locator("[data-atelier-tips]")).toBeVisible();
      await page.locator("[data-atelier-hero] h1").click();
      await expect(page.locator("[data-atelier-tips]")).toHaveCount(0);
      await expect(button).not.toBeFocused();
    });

    test("Mobile: 1 回目のタップで Tips、Tips のタップで移る", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "mobile", "Mobile");
      const root = await openLive(page, testInfo.project.name);
      await root.locator('[data-atelier-prop="envSetup"]').tap();
      const tips = page.locator("[data-atelier-tips]");
      await expect(tips).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/");
      await tips.getByRole("link").tap();
      await expect(page).toHaveURL(/\/services\/environment-setup\/$/, {
        timeout: 60_000,
      });
    });

    test("押せるボタンどうしは 24px 以上離れ、すべて枠の中にある", async ({
      page,
    }, testInfo) => {
      const root = await openLive(page, testInfo.project.name);
      const rects = await root.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return {
          box: { left: 0, right: box.width, top: 0, bottom: box.height },
          items: [
            ...el.querySelectorAll<HTMLElement>(
              "[data-atelier-prop], [data-atelier-frame]",
            ),
          ]
            .filter((b) => !b.hidden)
            .map((b) => {
              // Mobile の名前の帯は横にスクロールする（設計どおり）。帯の中で見える位置に出してから、枠の中にあるかを見る
              b.scrollIntoView({ block: "nearest", inline: "nearest" });
              const r = b.getBoundingClientRect();
              const f = el.getBoundingClientRect();
              // 枠に対する位置（スクロールでページが動いても比べられるように）
              return {
                x: r.left - f.left + r.width / 2,
                y: r.top - f.top + r.height / 2,
                w: r.width,
                h: r.height,
                left: r.left - f.left,
                right: r.right - f.left,
                top: r.top - f.top,
                bottom: r.bottom - f.top,
              };
            }),
        };
      });
      expect(rects.items.length).toBeGreaterThanOrEqual(
        testInfo.project.name === "mobile" ? 9 : 6,
      );
      for (const a of rects.items) {
        expect(a.w).toBeGreaterThanOrEqual(24);
        expect(a.h).toBeGreaterThanOrEqual(24);
        expect(
          a.left >= rects.box.left - 1 &&
            a.right <= rects.box.right + 1 &&
            a.top >= rects.box.top - 1 &&
            a.bottom <= rects.box.bottom + 1,
        ).toBe(true);
      }
      if (testInfo.project.name === "desktop")
        rects.items.forEach((a, i) =>
          rects.items
            .slice(i + 1)
            .forEach((b) =>
              expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(
                24,
              ),
            ),
        );
    });

    test("展示の壁: 額は 7 枚、許可の無い会社の名前はページのどこにも無い。jis の額だけが Tips に「見る」を持ち /accessibility/ へ移る", async ({
      page,
    }, testInfo) => {
      const root = await openLive(page, testInfo.project.name);
      expect(await root.getAttribute("data-atelier-frames")).toBe("7");
      const html = await page.content();
      for (const c of CASES.filter((x) => x.permission !== "granted"))
        expect(html).not.toContain(c.company);
      const frames = root.locator("[data-atelier-frame]");
      await expect(frames).toHaveCount(1);
      await frames.first().click();
      const tips = page.locator("[data-atelier-tips]");
      await expect(tips.getByRole("heading")).toHaveText(
        ATELIER.frames.jis.title,
      );
      await expect(tips.getByRole("link")).toHaveAttribute(
        "href",
        "/accessibility/",
      );
    });

    test("axe の違反 0（Tips を開いた状態。4 つの時間帯）", async ({
      page,
    }, testInfo) => {
      const root = await openLive(page, testInfo.project.name);
      await root.locator('[data-atelier-prop="consulting"]').click();
      await expect(page.locator("[data-atelier-tips]")).toBeVisible();
      // 札の色は <html data-atelier-phase> の値（theme.css の --atelier-tip-*）だけで決まる。検査を流した時刻の時間帯だけでなく、
      // 4 つとも確かめる（夜だけ札が暗い。2026-10-29 に夜の見出しが紺のまま 1.47:1 だった）
      for (const phase of ["morning", "day", "dusk", "night"] as const) {
        await page.evaluate(
          (p) => document.documentElement.setAttribute("data-atelier-phase", p),
          phase,
        );
        const result = await new AxeBuilder({ page })
          .withTags(AXE_TAGS)
          .include("[data-atelier-hero]")
          .analyze();
        expect(
          result.violations.map((v) => v.id),
          phase,
        ).toEqual([]);
      }
    });
  });

  test.describe("異常系", () => {
    test("入力: Mobile で置き物を長押ししても歩かず、Tips が出る", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "mobile", "Mobile");
      const root = await openLive(page, testInfo.project.name);
      const nameplate = root.locator('[data-atelier-prop="nameplate"]');
      // 名前の帯は横にスクロールする。押す前に見える位置へ出す
      await nameplate.scrollIntoViewIfNeeded();
      const box = (await nameplate.boundingBox())!;
      await longPress(
        page,
        box.x + box.width / 2,
        box.y + box.height / 2,
        1_500,
      );
      await expect(page.locator("[data-atelier-tips]")).toBeVisible();
      expect(await tOf(page)).toBe(0);
    });

    for (const [label, prepare] of [
      [
        "reduced-motion",
        async (page: Page) => page.emulateMedia({ reducedMotion: "reduce" }),
      ],
      [
        "WebGL なし",
        async (page: Page) =>
          page.addInitScript(() => {
            const original = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (
              this: HTMLCanvasElement,
              type: string,
              ...rest: unknown[]
            ) {
              if (/webgl/.test(type)) return null;
              return (original as (...a: unknown[]) => unknown).call(
                this,
                type,
                ...rest,
              );
            } as typeof original;
          }),
      ],
    ] as const) {
      test(`入力: ${label}では、ポスターと一覧（置き物 8 つの画像・見出し・説明・リンク）が出て、リンクは 8 つの移り先へ行く`, async ({
        page,
      }) => {
        await prepare(page);
        await open(page, TOP_ROUTE);
        const list = page.locator("[data-atelier-list]");
        await expect(list).toBeVisible();
        await expect(
          list.getByRole("heading", { name: ATELIER.listHeading }),
        ).toBeVisible();
        const items = list.locator("li");
        await expect(items).toHaveCount(8);
        const hrefs = await list
          .locator("a")
          .evaluateAll((as) => as.map((a) => a.getAttribute("href")));
        expect(hrefs.sort()).toEqual(TIP_PROPS.map((p) => p.href).sort());
        for (const prop of TIP_PROPS) {
          const item = list.locator("li", {
            hasText: ATELIER.props[prop.id].heading,
          });
          await expect(item).toContainText(ATELIER.props[prop.id].body);
          await expect(item.locator("img")).toHaveAttribute("src", /\.webp/);
        }
        const result = await new AxeBuilder({ page })
          .withTags(AXE_TAGS)
          .include("[data-atelier-list]")
          .analyze();
        expect(result.violations.map((v) => v.id)).toEqual([]);
      });
    }

    test("入力: 動いている間は一覧を出さない", async ({ page }, testInfo) => {
      await openLive(page, testInfo.project.name);
      await expect(page.locator("[data-atelier-list]")).toBeHidden();
    });
  });
});

// Task 7。下層ページの冒頭の静止画（同じアトリエの別の場所。spec §7）。根は [data-atelier-still="<PageKey>"]
const STILL_PAGES = [
  { path: "/services/", key: "services", variant: "backdrop" },
  {
    path: "/services/environment-setup/",
    key: "service:environment-setup",
    variant: "backdrop",
  },
  {
    path: "/services/development/",
    key: "service:development",
    variant: "backdrop",
  },
  {
    path: "/services/consulting/",
    key: "service:consulting",
    variant: "backdrop",
  },
  {
    path: "/services/partnership/",
    key: "service:partnership",
    variant: "backdrop",
  },
  { path: "/about/", key: "about", variant: "media" },
  { path: "/pricing/", key: "pricing", variant: "media" },
  { path: "/blog/", key: "blog", variant: "media" },
  { path: "/contact/", key: "contact", variant: "media" },
  { path: "/contact/thanks/", key: "contactThanks", variant: "media" },
  { path: "/accessibility/", key: "accessibility", variant: "banner" },
] as const;

test.describe("アトリエ（下層ページの冒頭の静止画）", () => {
  // 最終レビュー I-5: サービス一覧・詳細の文字は、静止画（backdrop）の上に覆いを重ねて読ませる。axe は背景が画像の文字を判定しない。
  // 最悪の場合（静止画が真っ白）に差し替えて画面を撮り、文字の矩形の下でいちばん明るい画素と文字色の比を、2 つの幅 × 4 つの時間帯で測る
  test("入力: 静止画が真っ白でも、サービス一覧・詳細の文字が 4.5:1（大きな文字は 3:1）を保つ（1024・1440px × 4 つの時間帯）", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "覆いを重ねるのは 768px 以上");
    test.setTimeout(240_000);
    const white = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ffffff" } }).png().toBuffer();
    await page.route(/\.webp(\?|$)/, (route) => route.fulfill({ body: white, contentType: "image/png" }));
    await page.emulateMedia({ reducedMotion: "reduce" });
    const failures: string[] = [];
    for (const width of [1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ["/services/", "/services/development/"]) {
        await open(page, path);
        for (const phase of ["morning", "day", "dusk", "night"] as const) {
          await page.evaluate((p) => document.documentElement.setAttribute("data-atelier-phase", p), phase);
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
          // 文字（自分の文字を持つ要素）の矩形・色（canvas で sRGB に直す）・大きさを取り、文字を隠して下の地だけを撮る
          const texts = await page.evaluate(() => {
            const still = document.querySelector('[data-atelier-variant="backdrop"]')!;
            const section = still.closest("section")!;
            const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
            const rgb = (color: string) => {
              ctx.clearRect(0, 0, 1, 1);
              ctx.fillStyle = color;
              ctx.fillRect(0, 0, 1, 1);
              return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
            };
            const els = [...section.querySelectorAll<HTMLElement>("*")].filter(
              // 導入の h1 と本文（CTA は自分の地を持ち、axe が判定できる）
              (el) => !still.contains(el) && !!el.closest("h1, p") && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()) && el.getClientRects().length > 0,
            );
            const out = els.map((el) => {
              const r = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              const size = parseFloat(cs.fontSize);
              const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
              return { text: el.textContent!.trim().slice(0, 16), x: r.left, y: r.top, w: r.width, h: r.height, color: rgb(cs.color), large, sr: cs.position === "absolute" && r.width <= 1 };
            });
            // 字形ごと描かない（color だけでは、見出しの動きの部品が描く字形が残る）。島の描き直しで要素が替わっても効くよう、
            // 印ではなく選択子で隠す。撮った後に外す
            const style = document.createElement("style");
            style.id = "e2e-hide-style";
            style.textContent = "section:has([data-atelier-variant='backdrop']) :is(h1, p), section:has([data-atelier-variant='backdrop']) :is(h1, p) *{visibility:hidden!important}";
            document.head.append(style);
            return out.filter((t) => !t.sr && t.w > 1 && t.h > 1 && t.y < innerHeight);
          });
          const shot = await page.screenshot();
          const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
          const scale = info.width / width;
          for (const t of texts) {
            let brightest = [0, 0, 0];
            let best = -1;
            for (let y = Math.max(0, Math.floor(t.y * scale)); y < Math.min(info.height, Math.ceil((t.y + t.h) * scale)); y++)
              for (let x = Math.max(0, Math.floor(t.x * scale)); x < Math.min(info.width, Math.ceil((t.x + t.w) * scale)); x++) {
                const i = (y * info.width + x) * info.channels;
                const l = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
                if (l > best) {
                  best = l;
                  brightest = [data[i], data[i + 1], data[i + 2]];
                }
              }
            const ratio = contrast(t.color, brightest);
            if (ratio < (t.large ? 3 : 4.5)) failures.push(`${path} ${width}px ${phase}「${t.text}」${ratio.toFixed(2)} 地 rgb(${brightest.join(",")})`);
          }
          await page.evaluate(() => document.getElementById("e2e-hide-style")?.remove());
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test.describe.configure({ timeout: 180_000 });

  test.describe("正常系", () => {
    for (const phase of PHASES) {
      test(`11 のページの冒頭に、その時間帯（${phase}）の静止画が 1 枚だけある`, async ({
        page,
      }, testInfo) => {
        await page.clock.setFixedTime(new Date(AT[phase]));
        const mobile = testInfo.project.name === "mobile";
        for (const p of STILL_PAGES) {
          const requested = new Set<string>();
          const onRequest = (r: { url(): string }) => {
            const m = new RegExp(
              `/${p.key.replace(":", "_")}-(morning|day|dusk|night)(-mobile)?\\.[^/]*webp`,
            ).exec(r.url());
            if (m) requested.add(m[1]);
          };
          page.on("request", onRequest);
          await open(page, p.path);
          page.off("request", onRequest);
          const still = page.locator(`[data-atelier-still="${p.key}"]`);
          await expect(still, p.path).toHaveCount(1);
          const img = still.locator("img");
          await expect(img, p.path).toBeVisible();
          await expect(img, p.path).toHaveAttribute("alt", "");
          const src = await img.evaluate(
            (el: HTMLImageElement) => el.currentSrc,
          );
          const suffix = mobile && p.variant === "backdrop" ? "-mobile" : "";
          expect(src, p.path).toMatch(
            new RegExp(`/${p.key.replace(":", "_")}-${phase}${suffix}\\.`),
          );
          expect([...requested], p.path).toEqual([phase]);
        }
      });
    }

    test("/accessibility/ は パンくず → 静止画（16:9・本文と同じ幅）→ h1 の順", async ({
      page,
    }) => {
      await open(page, "/accessibility/");
      const order = await page.evaluate(() => {
        const crumb = document.querySelector(
          "nav[aria-label] ol, nav[aria-label] ul",
        );
        const still = document.querySelector(
          '[data-atelier-still="accessibility"]',
        );
        const h1 = document.querySelector("h1");
        if (!crumb || !still || !h1) return null;
        const before = (a: Node, b: Node) =>
          !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        const r = still.getBoundingClientRect();
        return {
          crumbFirst: before(crumb, still),
          stillBeforeH1: before(still, h1),
          ratio: r.width / r.height,
          width: r.width,
        };
      });
      expect(order).not.toBeNull();
      expect(order!.crumbFirst).toBe(true);
      expect(order!.stillBeforeH1).toBe(true);
      expect(order!.ratio).toBeCloseTo(16 / 9, 1);
      expect(order!.width).toBeLessThanOrEqual(720);
    });

    test("会社概要の静止画にはアバターが写る（書き出しの位置の記録にアバターがある）", async () => {
      const fs = await import("node:fs");
      for (const phase of PHASES) {
        const json = JSON.parse(
          fs.readFileSync(
            `src/modules/atelier/assets/stills/about-${phase}.anchors.json`,
            "utf8",
          ),
        );
        expect(Object.keys(json)).toContain("avatar");
      }
    });

    test("axe の違反 0・静止画で表示がずれない（CLS 0）", async ({ page }) => {
      for (const p of STILL_PAGES.filter((x) =>
        ["about", "service:development", "accessibility"].includes(x.key),
      )) {
        await instrument(page);
        await open(page, p.path);
        expect((await cls(page)).motion, p.path).toBeLessThan(0.001);
        const result = await new AxeBuilder({ page })
          .withTags(AXE_TAGS)
          .include(`[data-atelier-still="${p.key}"]`)
          .analyze();
        expect(
          result.violations.map((v) => v.id),
          p.path,
        ).toEqual([]);
      }
    });
  });
});

test.describe("アトリエ（下層ページの静止画・JS なし）", () => {
  test.use({ javaScriptEnabled: false });

  test("空入力: JS が無いときは昼の静止画", async ({ page }) => {
    for (const p of STILL_PAGES.filter((x) =>
      ["about", "services", "accessibility"].includes(x.key),
    )) {
      await page.goto(p.path);
      await expect(
        page
          .locator(`[data-atelier-still="${p.key}"] img[src*="-day"]`)
          .first(),
        p.path,
      ).toBeVisible();
    }
  });
});

// Task 8。Tips から下層ページへ（カメラの移動としてつなぐ。spec §9 の 3）
/** ページ全体で、view-transition-name が vt-atelier の要素を数える */
const vtCount = (page: Page) =>
  page.evaluate(
    () =>
      [...document.querySelectorAll<HTMLElement>("*")].filter(
        (el) => getComputedStyle(el).viewTransitionName === "vt-atelier",
      ).length,
  );

test.describe("アトリエ（Tips から下層ページへ）", () => {
  test.describe.configure({ timeout: 420_000 });

  test.describe("正常系", () => {
    test("Tips の「見る」を押すと、カメラが移り先のカメラへ動き（data-atelier-flying）、終わってから移る", async ({
      page,
    }, testInfo) => {
      const root = await openLive(page, testInfo.project.name);
      await root.locator('[data-atelier-prop="pricing"]').click();
      // GPU の無い VM では 1 フレームが 1 秒近く、カメラの移動（600ms）が 1 フレームで終わって、すぐに移る。
      // 移り始めた時点のページの URL と data-atelier-flying を sessionStorage に残し、移った先で読む
      await page.evaluate(() => {
        const root = document.querySelector('[data-motion="atelier"]')!;
        new MutationObserver(() => {
          const to = root.getAttribute("data-atelier-flying");
          if (to)
            sessionStorage.setItem(
              "__e2e_flew",
              JSON.stringify({ to, path: location.pathname }),
            );
        }).observe(root, {
          attributes: true,
          attributeFilter: ["data-atelier-flying"],
        });
      });
      await page.locator("[data-atelier-tips]").getByRole("link").click();
      await expect(page).toHaveURL(/\/pricing\/$/, { timeout: 120_000 });
      expect(
        JSON.parse(
          (await page.evaluate(() => sessionStorage.getItem("__e2e_flew"))) ??
            "null",
        ),
      ).toEqual({ to: "pricing", path: "/" });
    });

    test("移った後は、移り先の静止画に vt-atelier が残らない", async ({
      page,
    }, testInfo) => {
      const root = await openLive(page, testInfo.project.name);
      await root.locator('[data-atelier-prop="blog"]').click();
      await page.locator("[data-atelier-tips]").getByRole("link").click();
      await expect(page).toHaveURL(/\/blog\/$/, { timeout: 120_000 });
      await expect.poll(() => vtCount(page), { timeout: 10_000 }).toBe(0);
    });

    test("下層ページからブラウザーの「戻る」で帰ると、同じ t から描かれ、Tips は閉じ、vt-atelier が残っていない。置き物のボタンが押せる", async ({
      page,
    }, testInfo) => {
      const root = await openLive(page, testInfo.project.name, 0.06);
      const before = await tOf(page);
      await root.locator('[data-atelier-prop="development"]').click();
      await page.locator("[data-atelier-tips]").getByRole("link").click();
      await expect(page).toHaveURL(/\/services\/development\/$/, {
        timeout: 120_000,
      });
      await page.goBack();
      const back = page.locator(ROOT);
      await expect(back).toHaveAttribute("data-atelier-live", "true", {
        timeout: 200_000,
      });
      expect(await tOf(page)).toBeCloseTo(before, 2);
      await expect(page.locator("[data-atelier-tips]")).toHaveCount(0);
      expect(await vtCount(page)).toBe(0);
      await back.locator('[data-atelier-prop="pricing"]').click();
      await expect(page.locator("[data-atelier-tips]")).toBeVisible();
    });

    test("18:59 に開いて 19:01 に Tips から移ると、移り先は夕方（dusk）の静止画", async ({
      page,
    }, testInfo) => {
      await page.clock.setFixedTime(new Date("2026-10-29T18:59:00"));
      const root = await openLive(page, testInfo.project.name);
      await page.clock.setFixedTime(new Date("2026-10-29T19:01:00"));
      await root.locator('[data-atelier-prop="contact"]').click();
      await page.locator("[data-atelier-tips]").getByRole("link").click();
      await expect(page).toHaveURL(/\/contact\/$/, { timeout: 120_000 });
      const src = await page
        .locator('[data-atelier-still="contact"] img')
        .evaluate((img: HTMLImageElement) => img.currentSrc);
      expect(src).toMatch(/contact-dusk/);
    });
  });

  test.describe("異常系", () => {
    test("入力: 一時停止のままなら、カメラを動かさずにすぐ移る", async ({
      page,
    }, testInfo) => {
      const root = await openLive(page, testInfo.project.name);
      await root.getByRole("button", { name: /動きを止める/ }).click();
      await root.locator('[data-atelier-prop="consulting"]').click();
      // 飛んだか（data-atelier-flying が付いたか）を sessionStorage に残し、移った先で読む（移る前のページの変数は移った後に読めない。最終レビュー I-6）
      await page.evaluate(() => {
        sessionStorage.removeItem("__e2e_flew");
        const root = document.querySelector('[data-motion="atelier"]')!;
        new MutationObserver(() => {
          if (root.hasAttribute("data-atelier-flying")) sessionStorage.setItem("__e2e_flew", "1");
        }).observe(root, { attributes: true, attributeFilter: ["data-atelier-flying"] });
      });
      await page.locator("[data-atelier-tips]").getByRole("link").click();
      await expect(page).toHaveURL(/\/services\/consulting\/$/, {
        timeout: 60_000,
      });
      expect(await page.evaluate(() => sessionStorage.getItem("__e2e_flew"))).toBeNull();
    });

    test("入力: bfcache から戻った（pageshow の persisted）ら、飛んでいる印と vt-atelier を外し、Tips を閉じ、歩く位置から描く", async ({
      page,
    }, testInfo) => {
      // Playwright の Chromium は bfcache を使わないので、移る直前の状態（飛んでいる印・遷移の名前・開いた Tips）を作ってから、
      // 戻ったときと同じ pageshow（persisted: true）を送る（第 1 版の不具合〈名前の付けっぱなし〉が起きた経路。最終レビュー I-6）
      const root = await openLive(page, testInfo.project.name, 0.06);
      const before = await tOf(page);
      await root.locator('[data-atelier-prop="development"]').click();
      await expect(page.locator("[data-atelier-tips]")).toBeVisible();
      await page.evaluate(() => {
        const r = document.querySelector<HTMLElement>('[data-motion="atelier"]')!;
        r.setAttribute("data-atelier-flying", "development");
        r.style.viewTransitionName = "vt-atelier";
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });
      await expect(root).not.toHaveAttribute("data-atelier-flying", /.*/);
      await expect(page.locator("[data-atelier-tips]")).toHaveCount(0);
      expect(await vtCount(page)).toBe(0);
      expect(await tOf(page)).toBeCloseTo(before, 2);
      await root.locator('[data-atelier-prop="pricing"]').click();
      await expect(page.locator("[data-atelier-tips]")).toBeVisible();
    });

    // 遅い端末と reduced-motion は別の経路なので分けて確かめる（最終レビュー I-6）
    for (const condition of ["遅い端末", "reduced-motion"] as const)
    test(`入力: ${condition}（ポスターと一覧）の一覧のリンクから移っても、移り先はその時間帯の静止画`, async ({
      page,
    }) => {
      await page.clock.setFixedTime(new Date(AT.night));
      if (condition === "reduced-motion") await page.emulateMedia({ reducedMotion: "reduce" });
      else
        await page.addInitScript(() => {
          try {
            sessionStorage.setItem(
              "atelier:quality",
              JSON.stringify({ live: false, dpr: 1 }),
            );
          } catch {}
        });
      await open(page, TOP_ROUTE);
      await page
        .locator("[data-atelier-list]")
        .getByRole("link", { name: new RegExp(ATELIER.props.pricing.heading) })
        .click();
      await expect(page).toHaveURL(/\/pricing\/$/);
      const src = await page
        .locator('[data-atelier-still="pricing"] img')
        .evaluate((img: HTMLImageElement) => img.currentSrc);
      expect(src).toMatch(/pricing-night/);
    });
  });
});
