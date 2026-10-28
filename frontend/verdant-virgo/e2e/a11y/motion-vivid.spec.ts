// A（vivid）のページの Aceternity 風の動きの検査（計画書 2026-10-19-aceternity-motion の Task 3〜6 が足していく）。
// 部品の約束（Task 3。ヒーロー）:
//   - ヒーローの根に data-motion="hero"（id="hero-backdrop"）。中の装飾は aria-hidden で、一時停止のボタンだけが aria-hidden の外にある
//   - 動くのは reduced-motion でない場合だけ（2026-10-20 から Mobile・タッチでも動く。05-motion-spec.md §8.4）。reduced-motion は静止のグラデーション（CSS の animation も回らない）
//   - 指（タッチ）は押している間だけ応える（Tilt3d・GlowGrid・Pin3d・マーキーの停止。motion/lib/touch-press.ts の data-touch-press）
//   - 一時停止（MotionPauseFor）は #hero-backdrop に data-motion-paused を付け外しし、sessionStorage の motion:hero に 'paused' を残す
//   - 見出しは CSS だけで焦点が合う。opacity は 0.35 以上から始め、0 から始めない
// 背景の動きは CSS の animation だけで、requestAnimationFrame を使わない。止まったかどうかは rAF の数に加え、
// document.getAnimations() の running を数えて確かめる（rAF だけでは、もともと 0 の動きが止まったことの証明にならない）。
import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import {
  animationCounts,
  cls,
  instrument,
  rafDuring,
} from "../support/motion";
import {
  MOTION_PAUSE,
  MOTION_PAUSE_TARGETS,
} from "../../src/modules/site-content/a11y";
import { TOP } from "../../src/modules/site-content/top";
import { open } from "./axe";
import { AXE_TAGS } from "./routes";

const PAUSE_KEY = "motion:hero";
// 2026-10-28: トップ（/）のヒーローは「基盤の模型」に替わった（背景の光の検査は diorama.spec.ts に移した）
const HERO_ROUTES = ["/services/", "/services/development/"];

/** ヒーローの中で動いている（running）無限の CSS animation の数 */
const runningAmbient = (page: Page) =>
  page.evaluate(() => {
    const root = document.querySelector('[data-motion="hero"]');
    if (!root) return -1;
    return document
      .getAnimations()
      .filter(
        (a) =>
          a.playState === "running" &&
          a.effect?.getComputedTiming().iterations === Infinity &&
          root.contains((a.effect as KeyframeEffect).target),
      ).length;
  });

/** ヒーローの中の無限の CSS animation の数（running・paused を問わない） */
const ambientCount = (page: Page) =>
  page.evaluate(() => {
    const root = document.querySelector('[data-motion="hero"]');
    if (!root) return -1;
    return document
      .getAnimations()
      .filter(
        (a) =>
          a.effect?.getComputedTiming().iterations === Infinity &&
          root.contains((a.effect as KeyframeEffect).target),
      ).length;
  });

/**
 * ヒーローの一時停止のボタン。トップには CTA バナーの blobs のボタンもあり、名前は「動きを止める（…）」と対象名で分かれるが、
 * どちらも見える文字は同じ「動きを止める」で始まる（部分一致で両方に当たる）ので、#hero-backdrop の中に絞る
 */
const heroButton = (page: Page, name: string | RegExp) =>
  page.locator("#hero-backdrop").getByRole("button", { name });

/**
 * 見える文字（MOTION_PAUSE）＋ sr-only の対象名の accessible name。sr-only の要素は absolute（ブロック扱い）なので、
 * ブラウザが間に空白を入れて「動きを止める （ヒーロー）」になる。空白の有無に左右されないよう、間を \s* にした正規表現で照合する
 */
const pauseName = (label: string, target: string) =>
  new RegExp(`${label}\\s*${target}`);

/** matrix3d(...) の 16 個の値。matrix(...)（2D）のときは 3D の形に直す。none は null */
function matrix3d(transform: string): number[] | null {
  if (transform === "none") return null;
  const values = /\(([^)]+)\)/.exec(transform)?.[1].split(",").map(Number);
  if (!values) return null;
  if (transform.startsWith("matrix3d")) return values;
  const [a, b, c, d, e, f] = values;
  return [a, b, 0, 0, c, d, 0, 0, 0, 0, 1, 0, e, f, 0, 1];
}

const SERVICE_ROUTES = ["/", "/services/"];

/** ページ上の n 番目の Tilt3d の面の transform（computed） */
const tiltTransform = (page: Page, n: number) =>
  page
    .locator("[data-tilt3d-body]")
    .nth(n)
    .evaluate((el) => getComputedStyle(el).transform);

/** 要素の中の相対位置（0〜1）にマウスを動かす */
async function moveInto(
  page: Page,
  locator: ReturnType<Page["locator"]>,
  rx: number,
  ry: number,
) {
  await locator.scrollIntoViewIfNeeded();
  const box = (await locator.boundingBox())!;
  await page.mouse.move(box.x + box.width * rx, box.y + box.height * ry, {
    steps: 4,
  });
}

/**
 * 指（タッチ）で要素の中の相対位置（0〜1）を押す。tap() はすぐ離れて押している間の状態を見られないので、
 * 合成の PointerEvent（pointerType: touch）を送る。戻り値の関数で離す
 */
async function touchPress(
  locator: ReturnType<Page["locator"]>,
  rx: number,
  ry: number,
): Promise<() => Promise<void>> {
  await locator.scrollIntoViewIfNeeded();
  const box = (await locator.boundingBox())!;
  const init = {
    pointerType: "touch",
    isPrimary: true,
    clientX: box.x + box.width * rx,
    clientY: box.y + box.height * ry,
    bubbles: true,
  };
  await locator.dispatchEvent("pointerdown", init);
  return () => locator.dispatchEvent("pointerup", init);
}

/** Tab を押して、フォーカスが selector の要素の中に入るまで進む */
async function tabInto(page: Page, selector: string, max = 200) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(
      (sel) => !!document.activeElement?.closest(sel),
      selector,
    );
    if (inside) return;
  }
  throw new Error(`Tab ${max} 回で ${selector} の中に届かなかった`);
}

/** フォーカスしている要素のリングの様子と、ring が切れないか（祖先に overflow・clip が無いか） */
const focusRing = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const style = getComputedStyle(el);
    const clippers: string[] = [];
    for (let n = el.parentElement; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (
        cs.overflowX !== "visible" ||
        cs.overflowY !== "visible" ||
        cs.clipPath !== "none" ||
        /paint|strict|content/.test(cs.contain)
      )
        clippers.push(n.tagName.toLowerCase() + "." + n.className.slice(0, 30));
    }
    const rect = el.getBoundingClientRect();
    const top = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return {
      focusVisible: el.matches(":focus-visible"),
      style: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
      offset: Number.parseFloat(style.outlineOffset),
      clippers,
      hitSelf: !!top && (top === el || el.contains(top)),
    };
  });

const desktopOnly = (name: string) =>
  test.skip(
    name !== "desktop",
    "Desktop の project で確かめる（hover・マウスの操作を含む。Mobile は「入力: Mobile」の検査が覆う）",
  );

test.describe("A（vivid）の動き", () => {
  test.beforeEach(async ({ page }) => instrument(page));
  // 2026-10-28: ヒーローの模型（diorama）の描画が、ページ全体の rAF の数に混ざらないよう、最初から止めて開く（模型は diorama.spec.ts で検査する）
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        sessionStorage.setItem("motion:diorama", "paused");
      } catch {}
    });
  });

  // 2026-10-28: トップ・サービス一覧・詳細のヒーローは「基盤の模型」（diorama）に替わり、背景の光（HeroBackdrop）はどのページでも使わなくなった。
  // 模型にも当てはまる約束（一時停止のボタンの名前・文字のコントラスト・JS なしで死んだボタンを出さない）は diorama.spec.ts に移した。
  // HeroBackdrop の部品を消すかは、計画の最終確認で決める（それまでこの検査は止めておく）
  test.describe.skip("ヒーロー", () => {
    test.describe("正常系", () => {
      for (const route of HERO_ROUTES) {
        test(`${route} の根に data-motion="hero" があり、中の装飾は aria-hidden（一時停止のボタンだけが外）`, async ({
          page,
        }) => {
          await open(page, route);
          const hero = page.locator('[data-motion="hero"]');
          await expect(hero).toHaveCount(1);
          const leaks = await hero.evaluate((root) =>
            [...root.querySelectorAll("svg, canvas, img")]
              .filter((el) => !el.closest('[aria-hidden="true"]'))
              .map((el) => el.tagName),
          );
          expect(leaks, "aria-hidden の外にある装飾").toEqual([]);
          // 装飾の層そのものは aria-hidden
          await expect(
            hero.locator(":scope > [aria-hidden='true']"),
          ).toHaveCount(1);
        });
      }

      test("トップの見出しは行ごとに、サービスの見出しは全体で、CSS だけで焦点が合う（opacity 0.35 から。JS が無くても同じ）", async ({
        browser,
        baseURL,
      }) => {
        const context = await browser.newContext({
          javaScriptEnabled: false,
          baseURL,
        });
        const page = await context.newPage();
        await page.goto("/", { waitUntil: "load" });
        await expect(page.locator("h1 .hero-line")).toHaveCount(3);
        await page.goto("/services/", { waitUntil: "load" });
        await expect(page.locator("h1.hero-heading")).toHaveCount(1);
        await context.close();
      });

      test("通常は 5 秒以内に一時停止のボタンが出て、押すと止まる（属性・sessionStorage・animation）。ページを移っても止まったまま、再開で動く", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, "/");
        const pause = heroButton(page, MOTION_PAUSE.pause);
        await expect(pause).toBeVisible({ timeout: 5_000 });
        const root = page.locator("#hero-backdrop");
        await expect(root).toHaveAttribute("data-motion-paused", "false");
        expect(await ambientCount(page), "動く部品の数").toBeGreaterThan(0);
        expect(
          await runningAmbient(page),
          "押す前に動いている",
        ).toBeGreaterThan(0);

        await pause.click();
        await expect(heroButton(page, MOTION_PAUSE.resume)).toBeVisible();
        await expect(root).toHaveAttribute("data-motion-paused", "true");
        expect(
          await page.evaluate((k) => sessionStorage.getItem(k), PAUSE_KEY),
        ).toBe("paused");
        expect(await runningAmbient(page), "押した後に動いている").toBe(0);
        expect(await rafDuring(page, 1_500), "押した後の rAF").toBe(0);

        // ページを移っても、戻っても止まったまま（sessionStorage の復元）
        await open(page, "/services/");
        await expect(heroButton(page, MOTION_PAUSE.resume)).toBeVisible({
          timeout: 5_000,
        });
        await expect(page.locator("#hero-backdrop")).toHaveAttribute(
          "data-motion-paused",
          "true",
        );
        expect(await runningAmbient(page), "移った先で動いている").toBe(0);

        await heroButton(page, MOTION_PAUSE.resume).click();
        await expect(page.locator("#hero-backdrop")).toHaveAttribute(
          "data-motion-paused",
          "false",
        );
        expect(
          await page.evaluate((k) => sessionStorage.getItem(k), PAUSE_KEY),
        ).toBeNull();
        expect(await runningAmbient(page), "再開した後").toBeGreaterThan(0);
      });

      test("トップの一時停止のボタンは名前が互いに異なる（見える文字で始まり、対象名が続く。2.5.3）。止めて再開の名前でも対象名が付く", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, "/");
        const blobs = page.locator('[data-motion="blobs"]').first();
        await blobs.scrollIntoViewIfNeeded();
        // client:visible なので画面に入ってから水和する。水和が済むのを待つ
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
        // CTA の一時停止のボタンは CtaGlow が持つ（Task 7。MotionBlobs は externalPause で自前のボタンを出さない）。バナー（aside）の中に絞る
        const cta = page
          .locator("aside:has([data-motion='blobs'])")
          .getByRole("button", {
            name: pauseName(MOTION_PAUSE.pause, MOTION_PAUSE_TARGETS.cta),
          });
        await expect(cta).toBeVisible({ timeout: 10_000 });
        const hero = heroButton(
          page,
          pauseName(MOTION_PAUSE.pause, MOTION_PAUSE_TARGETS.hero),
        );
        await expect(hero).toBeAttached({ timeout: 5_000 });
        const names = await page
          .locator("button")
          .evaluateAll((els) =>
            els
              .filter((el) =>
                el.closest("#hero-backdrop, aside:has([data-motion='blobs'])"),
              )
              .map((el) => (el.textContent ?? "").trim()),
          );
        expect(names).toHaveLength(2);
        expect(new Set(names).size, `名前: ${names.join(" / ")}`).toBe(2);
        for (const name of names)
          expect(name.startsWith(MOTION_PAUSE.pause)).toBe(true);
        // 止めて「再開」でも、対象名が付く
        await hero.scrollIntoViewIfNeeded();
        await hero.click();
        await expect(
          heroButton(
            page,
            pauseName(MOTION_PAUSE.resume, MOTION_PAUSE_TARGETS.hero),
          ),
        ).toBeVisible();
      });

      test("前のページで止めていたら、水和を待たず最初の描画から止まっている（動きが一瞬も出ない）", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await page.addInitScript((key) => {
          sessionStorage.setItem(key, "paused");
          // DOMContentLoaded の時点（island の水和より前）の属性を控える
          document.addEventListener("DOMContentLoaded", () => {
            (
              window as unknown as { __pausedAtDcl: string | null }
            ).__pausedAtDcl =
              document
                .getElementById("hero-backdrop")
                ?.getAttribute("data-motion-paused") ?? null;
          });
        }, PAUSE_KEY);
        await page.goto("/", { waitUntil: "load" });
        expect(
          await page.evaluate(
            () =>
              (window as unknown as { __pausedAtDcl: string | null })
                .__pausedAtDcl,
          ),
        ).toBe("true");
        expect(await runningAmbient(page)).toBe(0);
      });

      test("一時停止のボタンは Tab で届き、フォーカスリングが見え、Enter で止まる", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, "/");
        const pause = heroButton(page, MOTION_PAUSE.pause);
        await expect(pause).toBeVisible({ timeout: 5_000 });
        await pause.focus();
        const ring = await pause.evaluate((el) => {
          const s = getComputedStyle(el);
          return {
            style: s.outlineStyle,
            width: Number.parseFloat(s.outlineWidth),
            color: s.outlineColor,
          };
        });
        expect(ring.style).not.toBe("none");
        expect(ring.width).toBeGreaterThan(0);
        // 暗い地の上は白いリング（blue.500 は 2.91:1。global.css の data-surface="dark"）
        expect(ring.color).toBe("rgb(255, 255, 255)");
        await page.keyboard.press("Enter");
        await expect(heroButton(page, MOTION_PAUSE.resume)).toBeFocused();
        await expect(page.locator("#hero-backdrop")).toHaveAttribute(
          "data-motion-paused",
          "true",
        );
      });

      test("一時停止のボタンは、ヒーローの文字・ボタンに重ならず、クリックを受ける", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        for (const route of HERO_ROUTES) {
          await open(page, route);
          const pause = heroButton(page, MOTION_PAUSE.pause);
          await expect(pause, route).toBeVisible({ timeout: 5_000 });
          await pause.scrollIntoViewIfNeeded();
          const box = (await pause.boundingBox())!;
          // 的の大きさ（2.5.8）
          expect(Math.min(box.width, box.height), route).toBeGreaterThanOrEqual(
            24,
          );
          // 真ん中にいちばん上の要素がボタン自身（ほかの要素に覆われていない）
          const top = await page.evaluate(
            ({ x, y }) => {
              const el = document.elementFromPoint(x, y);
              return el?.closest("button")?.textContent?.trim() ?? el?.tagName;
            },
            { x: box.x + box.width / 2, y: box.y + box.height / 2 },
          );
          expect(top, route).toBe(
            `${MOTION_PAUSE.pause}${MOTION_PAUSE_TARGETS.hero}`,
          );
          // ヒーローの h1・本文・CTA と重ならない
          const overlaps = await page.evaluate((b) => {
            const hero = document.querySelector('[data-motion="hero"]')!;
            const section = hero.closest("section")!;
            return [...section.querySelectorAll("h1, p, a")]
              .filter((el) => !hero.contains(el))
              .filter((el) => {
                const r = el.getBoundingClientRect();
                return (
                  r.width > 0 &&
                  r.height > 0 &&
                  r.left < b.x + b.width &&
                  r.right > b.x &&
                  r.top < b.y + b.height &&
                  r.bottom > b.y
                );
              })
              .map((el) => el.tagName);
          }, box);
          expect(overlaps, route).toEqual([]);
        }
      });

      test("h1 の opacity は、読み込みの直後でも 0.35 以上（0 から始めない）", async ({
        page,
      }) => {
        for (const route of HERO_ROUTES) {
          await page.goto(route, { waitUntil: "domcontentloaded" });
          const effective = await page.evaluate(() => {
            const h1 = document.querySelector("h1")!;
            // 文字そのものの見かけの opacity ＝ h1 とその中の要素の opacity の積の最小
            const own = Number(getComputedStyle(h1).opacity);
            const inner = [...h1.querySelectorAll("*")].map((el) =>
              Number(getComputedStyle(el).opacity),
            );
            return own * Math.min(1, ...inner);
          });
          expect(effective, route).toBeGreaterThanOrEqual(0.35);
        }
      });

      test("見出しは焦点が合うと opacity 1・blur 0 になる（最後まで 0.35 のままにならない）", async ({
        page,
      }) => {
        await open(page, "/");
        await page.waitForTimeout(1_500);
        const state = await page.evaluate(() => {
          const els = [
            document.querySelector("h1")!,
            ...document.querySelectorAll("h1 .hero-line"),
          ];
          return els.map((el) => {
            const s = getComputedStyle(el);
            return { opacity: s.opacity, filter: s.filter };
          });
        });
        for (const s of state) {
          expect(s.opacity).toBe("1");
          expect(s.filter === "none" || s.filter === "blur(0px)").toBe(true);
        }
      });

      for (const route of HERO_ROUTES) {
        test(`${route} は axe の違反が 0、動きが要因のレイアウトのずれ（CLS）が 0.01 未満`, async ({
          page,
        }) => {
          await open(page, route);
          await page.waitForTimeout(3_000);
          const results = await new AxeBuilder({ page })
            .withTags(AXE_TAGS)
            .analyze();
          expect(
            results.violations.map(
              (v) =>
                `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(",")}`,
            ),
          ).toEqual([]);
          const value = await cls(page);
          expect(value.motion, route).toBeLessThan(0.01);
        });
      }

      test("ヒーローの文字（h1・本文）は、背景の動きを描いた状態でも地と 4.5:1 以上", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, "/");
        await expect(heroButton(page, MOTION_PAUSE.pause)).toBeVisible({
          timeout: 5_000,
        });
        // 見出しが焦点を結んだ後に測る。下端に固定の Cookie バナーが補足の文字に掛かるので、測る間は隠す
        await page.waitForTimeout(1_500);
        await page.evaluate(() =>
          document.getElementById("cookie-banner")?.setAttribute("hidden", ""),
        );
        const texts = page.locator(
          'section:has([data-motion="hero"]) h1, section:has([data-motion="hero"]) p',
        );
        const count = await texts.count();
        expect(count).toBeGreaterThan(0);
        for (let i = 0; i < count; i++) {
          const text = texts.nth(i);
          const color = await text.evaluate((el) => getComputedStyle(el).color);
          // 文字を透明にして、文字の後ろの地（背景の動きを含む）だけを写す
          await text.evaluate((el) =>
            el.style.setProperty("color", "transparent", "important"),
          );
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
          const label = (await text.innerText()).slice(0, 20);
          expect(min, `${i + 1} 番目の文字「${label}」`).toBeGreaterThanOrEqual(
            4.5,
          );
        }
      });
    });

    test.describe("異常系", () => {
      test("入力: JS が無いと（scripting: none）背景は静止のグラデーションで、動く層は描かれず、animation も回らない（止める手段が無いまま動かさない。2.2.2）", async ({
        browser,
        baseURL,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        const context = await browser.newContext({
          javaScriptEnabled: false,
          baseURL,
          viewport: { width: 1440, height: 900 },
        });
        const page = await context.newPage();
        for (const route of HERO_ROUTES) {
          await page.goto(route, { waitUntil: "load" });
          await page.waitForTimeout(500);
          const live = await page.evaluate(
            () =>
              getComputedStyle(document.querySelector(".hero-backdrop__live")!)
                .display,
          );
          expect(live, `${route} の動く層の display`).toBe("none");
          expect(await runningAmbient(page), route).toBe(0);
        }
        await context.close();
      });

      test("入力: 水和に失敗しても（一時停止のボタンの島が読み込めない）、動く層の animation は始まらない（止める手段が出るまで動かさない）", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await page.route("**/*PauseToggle*", (route) => route.abort());
        await page.goto("/", { waitUntil: "load" });
        await page.waitForTimeout(2_500);
        await expect(page.locator("#hero-backdrop")).not.toHaveAttribute(
          "data-motion-ready",
          "true",
        );
        expect(
          await page.evaluate(
            () =>
              getComputedStyle(document.querySelector(".hero-backdrop__live")!)
                .display,
          ),
          "動く層は描かれている（水和だけが失敗した状態）",
        ).not.toBe("none");
        expect(await runningAmbient(page)).toBe(0);
        await expect(
          page.getByRole("button", { name: MOTION_PAUSE.pause }),
        ).toHaveCount(0);
      });

      test("入力: reduced-motion では一時停止のボタンが無く、背景の CSS animation も回らず、2 秒の間の rAF の増分が 0", async ({
        page,
      }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        for (const route of HERO_ROUTES) {
          await open(page, route);
          await expect(
            page.getByRole("button", { name: MOTION_PAUSE.pause }),
          ).toHaveCount(0);
          expect(await runningAmbient(page), `${route} の動く部品`).toBe(0);
          expect(await rafDuring(page, 2_000), route).toBe(0);
          // 見出しは最初から焦点が合った状態（opacity 1）
          const opacity = await page.evaluate(
            () => getComputedStyle(document.querySelector("h1")!).opacity,
          );
          expect(opacity, route).toBe("1");
        }
      });

      test("入力: Mobile（hover のない端末）でも背景が動き、一時停止のボタンがヒーローの右下に出て、押すと止まる（2026-10-20 から。§8.4）", async ({
        page,
      }, testInfo) => {
        test.skip(testInfo.project.name !== "mobile", "Mobile の project だけ");
        for (const route of HERO_ROUTES) {
          await open(page, route);
          const pause = heroButton(page, MOTION_PAUSE.pause);
          await expect(pause, route).toBeVisible({ timeout: 5_000 });
          expect(await runningAmbient(page), `${route} の動く部品`).toBeGreaterThan(0);
          // ボタンはヒーローの中（右下）に収まり、横にあふれない
          const hero = (await page.locator("#hero-backdrop").boundingBox())!;
          const box = (await pause.boundingBox())!;
          expect(box.x + box.width, route).toBeLessThanOrEqual(hero.x + hero.width);
          expect(box.y + box.height, route).toBeLessThanOrEqual(hero.y + hero.height);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            route,
          ).toBe(true);
        }
        await heroButton(page, MOTION_PAUSE.pause).click();
        await expect(page.locator("#hero-backdrop")).toHaveAttribute("data-motion-paused", "true");
        expect(await runningAmbient(page), "押した後").toBe(0);
        // 次の検査に止めた状態を持ち越さない
        await heroButton(page, MOTION_PAUSE.resume).click();
      });

      test("入力: JS が無くても、見出し・本文・CTA が読め、背景はあっても一時停止のボタンは出ない（押せない死んだボタンを出さない）", async ({
        browser,
        baseURL,
      }) => {
        const context = await browser.newContext({
          javaScriptEnabled: false,
          baseURL,
        });
        const page = await context.newPage();
        for (const route of HERO_ROUTES) {
          await page.goto(route, { waitUntil: "load" });
          await expect(page.locator("h1")).toBeVisible();
          await expect(page.locator('[data-motion="hero"]')).toHaveCount(1);
          await expect(
            page.getByRole("button", { name: MOTION_PAUSE.pause }),
          ).toHaveCount(0);
        }
        await context.close();
      });
    });
  });

  // Task 4: Feature Sections（光の縁。GlowGrid）と 3D Card Effect（傾き。Tilt3d）。
  // 部品の約束:
  //   - GlowGrid の子の [data-glow-card] は、hover（細かいポインター・reduced-motion でない・script が来ている）のとき ::before の opacity が 1、
  //     --glow-x／--glow-y にポインターの位置（%）が入る。キーボード（focus-visible）では縁の全体が静かに光る
  //   - Tilt3d の面（[data-tilt3d-body]）は、hover で rotate ＋ translateZ、キーボードのフォーカスでは回転なしの translateZ だけ。
  //     coarse pointer・reduced-motion では transform が none のまま。静止しているときも none
  //   - 動かしていないときは rAF が回らない
  describe_feature_3d();
  describe_marquee_pin_stats();
  describe_globe();
});

function describe_feature_3d() {
  test.describe("Feature・3D Card", () => {
    test.describe("正常系", () => {
      test("トップに GlowGrid が 4 つ（5 方法 3＋2・選ばれる理由 6・体験 3）で、子はすべて [data-glow-card]。サービス詳細に 1 つ", async ({
        page,
      }) => {
        await open(page, "/");
        const counts = await page
          .locator("[data-glow-grid]")
          .evaluateAll((grids) =>
            grids.map((g) => ({
              children: g.children.length,
              cards: g.querySelectorAll(":scope > [data-glow-card]").length,
            })),
          );
        expect(counts).toEqual([
          { children: 3, cards: 3 },
          { children: 2, cards: 2 },
          { children: 6, cards: 6 },
          { children: 3, cards: 3 },
        ]);
        await open(page, "/services/development/");
        const detail = await page
          .locator("[data-glow-grid]")
          .evaluateAll((grids) =>
            grids.map((g) => [
              g.children.length,
              g.querySelectorAll(":scope > [data-glow-card]").length,
            ]),
          );
        expect(detail).toHaveLength(1);
        expect(detail[0][0]).toBe(detail[0][1]);
      });

      for (const route of SERVICE_ROUTES) {
        test(`${route} のサービスカードは 4 枚とも Tilt3d で包まれ、高さと「詳しく見る」の位置が同じ行でそろう。ロゴは入っていない`, async ({
          page,
        }) => {
          await open(page, route);
          await expect(page.locator("[data-tilt3d]")).toHaveCount(4);
          // ロゴ（img）を入れない
          await expect(page.locator("[data-tilt3d] img")).toHaveCount(0);
          const rows = await page.locator("[data-tilt3d]").evaluateAll((els) =>
            els.map((el) => {
              const rect = el.getBoundingClientRect();
              const link = el.querySelector("a[href]")!.getBoundingClientRect();
              const card = el.querySelector("article")!.getBoundingClientRect();
              return {
                top: Math.round(rect.top + scrollY),
                height: Math.round(rect.height),
                cardHeight: Math.round(card.height),
                linkTop: Math.round(link.top + scrollY),
              };
            }),
          );
          // カードは wrapper いっぱいに伸びる
          for (const row of rows) expect(row.cardHeight).toBe(row.height);
          // 2×2 のとき（Desktop）、同じ行の高さと下の位置がそろう
          if (rows[0].top === rows[1].top) {
            expect(rows[0].height).toBe(rows[1].height);
            expect(rows[0].linkTop).toBe(rows[1].linkTop);
          }
        });
      }

      test("hover すると光の縁がポインターの位置に出る（--glow-x／--glow-y は割合。縁の ::before の opacity が 1）", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, "/");
        const card = page.locator("[data-glow-card]").first();
        await card.scrollIntoViewIfNeeded();
        const ring = () =>
          card.evaluate((el) => getComputedStyle(el, "::before").opacity);
        expect(await ring(), "hover の前").toBe("0");
        await moveInto(page, card, 0.25, 0.75);
        await expect.poll(ring).toBe("1");
        const vars = await card.evaluate((el) => ({
          x: (el as HTMLElement).style.getPropertyValue("--glow-x"),
          y: (el as HTMLElement).style.getPropertyValue("--glow-y"),
        }));
        expect(Number.parseFloat(vars.x)).toBeGreaterThan(20);
        expect(Number.parseFloat(vars.x)).toBeLessThan(30);
        expect(Number.parseFloat(vars.y)).toBeGreaterThan(70);
        expect(Number.parseFloat(vars.y)).toBeLessThan(80);
        expect(vars.x.endsWith("%")).toBe(true);
        // 縁は mask で抜かれ、パレットの変数（brand.sky・blue.300）から作られる
        const gradient = await card.evaluate(
          (el) => getComputedStyle(el, "::before").backgroundImage,
        );
        expect(gradient).toContain("radial-gradient");
        // 離すと消える
        await page.mouse.move(2, 2);
        await expect.poll(ring).toBe("0");
      });

      test("hover しても、カードの中身の文字・リンクの当たり判定は変わらない（::before／::after は pointer-events なし）", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, "/");
        const card = page.locator("[data-glow-card]").first();
        await moveInto(page, card, 0.5, 0.5);
        const pe = await card.evaluate((el) => [
          getComputedStyle(el, "::before").pointerEvents,
          getComputedStyle(el, "::after").pointerEvents,
        ]);
        expect(pe).toEqual(["none", "none"]);
      });

      test("キーボード: 光の縁の全体が静かに（動かさず）光る（カードの中の操作できる要素に focus-visible が当たったとき）", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, "/");
        // 5 方法のカードには操作できる要素が無い（Tab でフォーカスが来ない）。規則を確かめるため、ボタンを差し込む
        await page.keyboard.press("Tab");
        await page.evaluate(() => {
          const card = document.querySelector("[data-glow-card]")!;
          const button = document.createElement("button");
          button.id = "e2e-glow-probe";
          button.textContent = "probe";
          card.append(button);
        });
        await page.locator("#e2e-glow-probe").focus();
        const card = page.locator("[data-glow-card]").first();
        await expect
          .poll(() =>
            card.evaluate((el) => getComputedStyle(el, "::before").opacity),
          )
          .toBe("0.85");
        const bg = await card.evaluate(
          (el) => getComputedStyle(el, "::before").backgroundImage,
        );
        expect(bg, "全体の縁は線形（動かない）").toContain("linear-gradient");
        expect(bg).not.toContain("radial-gradient");
      });

      test("hover するとサービスカードが傾く（transform が none 以外）。右上に寄せると rotateY が +・rotateX が +。離すと none に戻る。止まっている間は rAF が回らない", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, "/");
        const card = page.locator("[data-tilt3d]").first();
        expect(await tiltTransform(page, 0), "hover の前").toBe("none");
        await moveInto(page, card, 0.95, 0.05);
        await expect.poll(() => tiltTransform(page, 0)).not.toBe("none");
        const m = matrix3d(await tiltTransform(page, 0))!;
        // matrix3d は列順。m[2]＝x 軸の像の z、m[6]＝y 軸の像の z。
        // rotateY(+)：右の端が奥へ沈む（x 軸の像の z が負）。rotateX(+)：上の端が奥へ沈む（y 軸の像の z が正）。どちらも「ポインターのある側が押される」
        expect(m[2], "rotateY が +").toBeLessThan(0);
        expect(m[6], "rotateX が +").toBeGreaterThan(0);
        expect(m[14], "手前へ浮く").toBeGreaterThan(0);
        // 8 度を超えない
        expect(Math.abs(Math.asin(m[2])) * (180 / Math.PI)).toBeLessThanOrEqual(
          8.5,
        );
        // 価格の枠が手前へ浮く
        const inner = await card.evaluate((el) => {
          const lift = el.querySelector("[data-tilt-lift]")!;
          return getComputedStyle(lift).transform;
        });
        expect(matrix3d(inner)![14]).toBeGreaterThan(0);
        // ポインターを止めている間は、rAF が回らない
        expect(await rafDuring(page, 1_000), "止めている間の rAF").toBe(0);
        // 反対側へ動かすと、符号が変わる
        await moveInto(page, card, 0.05, 0.95);
        await expect
          .poll(async () => matrix3d(await tiltTransform(page, 0))![2])
          .toBeGreaterThan(0);
        // 離すと戻る
        await page.mouse.move(2, 2);
        await expect.poll(() => tiltTransform(page, 0)).toBe("none");
      });

      test("傾いている間も、カードの中のリンクはポインターで押せる位置にある（当たり判定が崩れない）", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, "/");
        const card = page.locator("[data-tilt3d]").first();
        await moveInto(page, card, 0.9, 0.1);
        await expect.poll(() => tiltTransform(page, 0)).not.toBe("none");
        await page.waitForTimeout(400); // transition が終わるまで
        const hits = await card.evaluate((el) =>
          [...el.querySelectorAll("a[href]")].map((a) => {
            const r = a.getBoundingClientRect();
            const top = document.elementFromPoint(
              r.left + r.width / 2,
              r.top + r.height / 2,
            );
            return !!top && (top === a || a.contains(top));
          }),
        );
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.every(Boolean), "リンクの中心にリンクがある").toBe(true);
      });

      test("キーボード: Tab でカードの中のリンクに届くと、傾かずに手前へ浮く（translateZ だけ）。フォーカスリングは 2px で、切れない", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, "/");
        await tabInto(page, "[data-tilt3d]");
        const ring = await focusRing(page);
        expect(ring.focusVisible).toBe(true);
        expect(ring.style).toBe("solid");
        expect(ring.width).toBe(2);
        expect(ring.offset).toBe(2);
        expect(ring.clippers, "リングを切る祖先").toEqual([]);
        expect(ring.hitSelf, "リンクの中心にリンクがある").toBe(true);

        const wrapper = page.locator("[data-tilt3d]:has(:focus)");
        await expect
          .poll(
            async () =>
              matrix3d(
                await wrapper
                  .locator("[data-tilt3d-body]")
                  .evaluate((el) => getComputedStyle(el).transform),
              )?.[14],
          )
          .toBeCloseTo(16, 0);
        const m = matrix3d(
          await wrapper
            .locator("[data-tilt3d-body]")
            .evaluate((el) => getComputedStyle(el).transform),
        )!;
        // 回転なし（x・y 軸が奥へ向かわない）
        expect(m[2]).toBeCloseTo(0, 5);
        expect(m[6]).toBeCloseTo(0, 5);
        expect(m[0]).toBeCloseTo(1, 5);
        expect(m[5]).toBeCloseTo(1, 5);
        // リングの外形（リンクの四角を 4px 広げたもの）がカードの中に収まる
        const inside = await page.evaluate(() => {
          const a = document.activeElement!.getBoundingClientRect();
          const w = document
            .activeElement!.closest("[data-tilt3d]")!
            .getBoundingClientRect();
          return (
            a.left - 4 >= w.left - 1 &&
            a.right + 4 <= w.right + 1 &&
            a.bottom + 4 <= w.bottom + 1
          );
        });
        expect(inside, "リングがカードの外へはみ出す").toBe(true);

        // hover が重なっても傾かない
        await moveInto(page, wrapper, 0.95, 0.05);
        await page.waitForTimeout(400);
        const both = matrix3d(
          await wrapper
            .locator("[data-tilt3d-body]")
            .evaluate((el) => getComputedStyle(el).transform),
        )!;
        expect(both[2]).toBeCloseTo(0, 5);
        expect(both[14]).toBeCloseTo(16, 0);
      });

      test("hover・フォーカスのどちらの状態でも axe の違反が 0", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        for (const route of SERVICE_ROUTES) {
          await open(page, route);
          const card = page.locator("[data-tilt3d]").first();
          await moveInto(page, card, 0.8, 0.2);
          await page.waitForTimeout(400);
          const hovered = await new AxeBuilder({ page })
            .withTags(AXE_TAGS)
            .analyze();
          expect(
            hovered.violations.map((v) => v.id),
            `${route} hover`,
          ).toEqual([]);
          await page.mouse.move(2, 2);
          await tabInto(page, "[data-tilt3d]");
          await page.waitForTimeout(400);
          const focused = await new AxeBuilder({ page })
            .withTags(AXE_TAGS)
            .analyze();
          expect(
            focused.violations.map((v) => v.id),
            `${route} focus`,
          ).toEqual([]);
        }
      });
    });

    test.describe("異常系", () => {
      test("入力: 動きを減らす設定では、傾きも光も出ず、rAF も回らない（perspective・transform・::before がそのまま）", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await open(page, "/");
        const card = page.locator("[data-tilt3d]").first();
        await moveInto(page, card, 0.9, 0.1);
        await page.mouse.move(100, 200, { steps: 6 });
        await moveInto(page, card, 0.2, 0.8);
        await page.waitForTimeout(400);
        expect(await tiltTransform(page, 0), "傾き").toBe("none");
        expect(
          await card.evaluate((el) => getComputedStyle(el).perspective),
        ).toBe("none");
        expect(await rafDuring(page, 1_000), "rAF").toBe(0);

        const glow = page.locator("[data-glow-card]").first();
        await moveInto(page, glow, 0.5, 0.5);
        await page.waitForTimeout(400);
        expect(
          await glow.evaluate((el) => getComputedStyle(el, "::before").opacity),
          "光の縁",
        ).toBe("0");
        expect(
          await glow.evaluate((el) =>
            (el as HTMLElement).style.getPropertyValue("--glow-x"),
          ),
          "script は位置を書かない",
        ).toBe("");

        // キーボードのフォーカスでも浮かない
        await page.mouse.move(2, 2);
        await tabInto(page, "[data-tilt3d]");
        await page.waitForTimeout(300);
        expect(await tiltTransform(page, 0)).toBe("none");
      });

      test("入力: Mobile（hover も細かいポインターも無い）では、指で押している間だけ傾いて浮き、縁が光る。離すと戻り、rAF は回り続けない（2026-10-20 から。§8.4）", async ({
        page,
      }, testInfo) => {
        test.skip(testInfo.project.name !== "mobile", "Mobile の project だけ");
        await open(page, "/");
        const card = page.locator("[data-tilt3d]").first();
        expect(await tiltTransform(page, 0), "押す前").toBe("none");
        // 右上を押す → 押した側が沈む（rotateY が +・rotateX が +）
        const releaseCard = await touchPress(card, 0.9, 0.1);
        await expect(card).toHaveAttribute("data-touch-press", "");
        await expect.poll(() => tiltTransform(page, 0)).not.toBe("none");
        expect(await card.evaluate((el) => getComputedStyle(el).perspective)).toBe("1000px");
        await releaseCard();
        await expect(card).not.toHaveAttribute("data-touch-press");
        await expect.poll(() => tiltTransform(page, 0)).toBe("none");

        const glow = page.locator("[data-glow-card]").first();
        const releaseGlow = await touchPress(glow, 0.25, 0.75);
        await expect.poll(() => glow.evaluate((el) => getComputedStyle(el, "::before").opacity)).toBe("1");
        expect(await glow.evaluate((el) => el.style.getPropertyValue("--glow-x"))).toBe("25%");
        await releaseGlow();
        await expect.poll(() => glow.evaluate((el) => getComputedStyle(el, "::before").opacity)).toBe("0");
        // 押していない間は何も回らない（ヒーローの背景は CSS の animation なので rAF に数えない）
        expect(await rafDuring(page, 1_000), "rAF").toBe(0);
        // カードの文字とリンクはそのまま読める
        await expect(card.locator("a[href]").first()).toBeVisible();
      });

      test("入力: Mobile で押したまま指を動かしてスクロールが始まる（pointercancel）と、待たずに元へ戻る", async ({
        page,
      }, testInfo) => {
        test.skip(testInfo.project.name !== "mobile", "Mobile の project だけ");
        await open(page, "/");
        const card = page.locator("[data-tilt3d]").first();
        await touchPress(card, 0.9, 0.1);
        await expect(card).toHaveAttribute("data-touch-press", "");
        await card.dispatchEvent("pointercancel", { pointerType: "touch", isPrimary: true, bubbles: true });
        await expect(card).not.toHaveAttribute("data-touch-press");
        expect(await card.evaluate((el) => el.style.getPropertyValue("--tilt-x"))).toBe("");
      });

      test("入力: JS が無くても、カードの文字・リンクがすべて見え、光も傾きも出ない（hover の光と傾きは script が来てから）", async ({
        browser,
        baseURL,
      }) => {
        const context = await browser.newContext({
          javaScriptEnabled: false,
          baseURL,
          viewport: { width: 1440, height: 900 },
        });
        const page = await context.newPage();
        for (const route of ["/", "/services/", "/services/development/"]) {
          await page.goto(route, { waitUntil: "load" });
          // 見出し・本文・リンクがすべて見える
          const hidden = await page
            .locator("[data-tilt3d] , [data-glow-grid]")
            .evaluateAll((roots) =>
              roots.flatMap((root) =>
                [...root.querySelectorAll("h2, h3, p, a[href], dt, dd, li")]
                  .filter(
                    (el) =>
                      !el.checkVisibility({
                        opacityProperty: true,
                        visibilityProperty: true,
                      }),
                  )
                  .map((el) => el.textContent?.trim().slice(0, 20)),
              ),
            );
          expect(hidden, `${route} の見えない要素`).toEqual([]);
          await expect(page.locator("[data-glow-ready]")).toHaveCount(0);
          await expect(page.locator("[data-tilt-ready]")).toHaveCount(0);
          // 部品があること（無いまま通らない）。サービス詳細にはカードの傾きが無く、光の縁だけ
          const tilts = route === "/services/development/" ? 0 : 4;
          await expect(page.locator("[data-tilt3d]")).toHaveCount(tilts);
          const glows = await page.locator("[data-glow-card]").count();
          expect(
            route === "/services/" ? glows === 0 : glows > 0,
            `${route} の光の縁のカード ${glows}`,
          ).toBe(true);
          if (tilts > 0) {
            const card = page.locator("[data-tilt3d]").first();
            await moveInto(page, card, 0.9, 0.1);
            await page.waitForTimeout(400);
            expect(await tiltTransform(page, 0), `${route} 傾き`).toBe("none");
          }
          const glow = page.locator("[data-glow-card]").first();
          if (await glow.count()) {
            await moveInto(page, glow, 0.5, 0.5);
            await page.waitForTimeout(400);
            expect(
              await glow.evaluate(
                (el) => getComputedStyle(el, "::before").opacity,
              ),
              `${route} 光`,
            ).toBe("0");
          }
        }
        await context.close();
      });
    });
  });
}

// Task 5: 3D Marquee（使うツール。ToolMarquee）・3D Animated Pin（導入事例・無料 DL。Pin3d）・Stats（導入事例の数値カード。StatRow）。
// 部品の約束:
//   - ToolMarquee: 根に id="tool-marquee"・data-motion="marquee"。読み上げ用の <ul> が 1 つだけ DOM にあり、流れる面（複製）は aria-hidden かつ inert。
//     動くのは md 以上かつ hover のある端末で、reduced-motion でなく、JS が使えるときだけ（それ以外は今の折り返しの並び）。
//     傾いた面に 3 本の流れ（向きは交互、1 周は --motion-duration-ambient の 3 倍）。一時停止（motion:marquee）と、ポインターを載せている間の停止。
//   - Pin3d: hover と focus-visible で、ピン（[data-pin3d-pin]）が opacity 1 になり、カードが奥へ倒れる。CSS だけ。
//     倒れるのは動きを減らす設定でなく細かいポインターのとき（フォーカスは常に）。ピンの出現（静止）は reduced-motion でも出す
//   - StatRow: カードが画面に入ると順に現れ（transform だけ。opacity は触らない）、値の下の罫が引かれる（scroll-driven animation）。値は「—」のまま
const MARQUEE = "#tool-marquee";
const MARQUEE_KEY = "motion:marquee";

/** 流れの面。ready（水和して止める手段が出た）になるのを待つ */
async function marqueeReady(page: Page) {
  await expect(page.locator(MARQUEE)).toHaveAttribute(
    "data-motion-ready",
    "true",
    { timeout: 5_000 },
  );
}

const marqueeButton = (page: Page, name: string | RegExp) =>
  page.locator(MARQUEE).getByRole("button", { name });

/** 要素の ::after の scaleX（transform が none のときは 1） */
const afterScaleX = (locator: ReturnType<Page["locator"]>) =>
  locator.evaluate((el) => {
    const t = getComputedStyle(el, "::after").transform;
    if (t === "none") return 1;
    return Number(/\(([^)]+)\)/.exec(t)![1].split(",")[0]);
  });

/** カードの transform の translateY（none は 0） */
const translateY = (locator: ReturnType<Page["locator"]>) =>
  locator.evaluate((el) => {
    const t = getComputedStyle(el).transform;
    if (t === "none") return 0;
    const v = /\(([^)]+)\)/.exec(t)![1].split(",").map(Number);
    return t.startsWith("matrix3d") ? v[13] : v[5];
  });

const pinOpacity = (locator: ReturnType<Page["locator"]>) =>
  locator.evaluate((el) => Number(getComputedStyle(el).opacity));

function describe_marquee_pin_stats() {
  test.describe("Marquee・Pin・Stats", () => {
    test.describe("正常系", () => {
      test("ツールの名前が読み上げでちょうど 1 回ずつ現れる（流れる面は aria-hidden かつ inert。根は 1 つ）", async ({
        page,
      }) => {
        await open(page, "/");
        await expect(page.locator('[data-motion="marquee"]')).toHaveCount(1);
        const snapshot = await page.locator(MARQUEE).ariaSnapshot();
        for (const name of TOP.tools.badges) {
          const times = snapshot.split(name).length - 1;
          expect(times, `${name} が読み上げに ${times} 回`).toBe(1);
        }
        // 読み上げ用の一覧は <ul> が 1 つ。項目数はツールの数と同じ
        await expect(page.locator(`${MARQUEE} ul`)).toHaveCount(1);
        await expect(page.locator(`${MARQUEE} ul > li`)).toHaveCount(
          TOP.tools.badges.length,
        );
        // 流れる面は aria-hidden かつ inert。複製の文字はその中にしか無い
        const stage = page.locator("[data-marquee-stage]");
        await expect(stage).toHaveAttribute("aria-hidden", "true");
        await expect(stage).toHaveAttribute("inert", "");
        const leaks = await page.locator(MARQUEE).evaluate((root) =>
          [...root.querySelectorAll("[data-marquee-chip]")]
            .filter((el) => !el.closest('[aria-hidden="true"][inert]'))
            .map((el) => el.textContent),
        );
        expect(leaks, "aria-hidden・inert の外にある複製").toEqual([]);
        // ロゴを足さない（他社のロゴ・ComeGin のロゴとも、画像を入れない）
        await expect(page.locator(`${MARQUEE} img, ${MARQUEE} svg[role='img']`)).toHaveCount(0);
      });

      test("傾いた面に 3 本の流れ。向きは交互で、1 周は --motion-duration-ambient の 3 倍。水和したら動く", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, "/");
        await marqueeReady(page);
        const stage = page.locator("[data-marquee-stage]");
        await expect(stage).toBeVisible();
        const lanes = await page.locator("[data-marquee-track]").evaluateAll(
          (els) =>
            els.map((el) => {
              const s = getComputedStyle(el);
              return { direction: s.animationDirection, duration: s.animationDuration };
            }),
        );
        expect(lanes.map((l) => l.direction)).toEqual(["normal", "reverse", "normal"]);
        for (const lane of lanes) expect(lane.duration).toBe("24s");
        // 面が奥へ傾いている（3D の行列で、y 軸の像が奥へ向かう）
        const m = matrix3d(
          await page
            .locator("[data-marquee-plane]")
            .evaluate((el) => getComputedStyle(el).transform),
        );
        expect(m, "傾き").not.toBeNull();
        expect(Math.abs(m![6]), "y 軸の像の z").toBeGreaterThan(0.1);
        const counts = await animationCounts(page, MARQUEE);
        expect(counts.total, "流れの本数").toBe(3);
        expect(counts.running, "動いている").toBe(3);
        // 流れは rAF を使わない
        expect(await rafDuring(page, 1_000), "rAF").toBe(0);
      });

      test("一時停止のボタン: 名前に対象名が付き、押すと流れがすべて paused になり、ページを移っても止まったまま。再開で動く", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, "/");
        await marqueeReady(page);
        const pause = marqueeButton(
          page,
          pauseName(MOTION_PAUSE.pause, MOTION_PAUSE_TARGETS.marquee),
        );
        await expect(pause).toBeVisible({ timeout: 5_000 });
        await expect(page.locator(MARQUEE)).toHaveAttribute("data-motion-paused", "false");
        expect((await animationCounts(page, MARQUEE)).running).toBe(3);

        await pause.click();
        await expect(page.locator(MARQUEE)).toHaveAttribute("data-motion-paused", "true");
        expect(
          await page.evaluate((k) => sessionStorage.getItem(k), MARQUEE_KEY),
        ).toBe("paused");
        const stopped = await animationCounts(page, MARQUEE);
        expect(stopped.running, "押した後に動いている").toBe(0);
        expect(stopped.paused, "paused の本数").toBe(stopped.total);
        // getAnimations の playState がすべて paused
        expect(
          await page.evaluate(() =>
            document
              .querySelector("[data-marquee-stage]")!
              .getAnimations({ subtree: true })
              .map((a) => a.playState),
          ),
        ).toEqual(["paused", "paused", "paused"]);
        expect(await rafDuring(page, 1_000), "rAF").toBe(0);
        // 同じページに並ぶ別の一時停止（ヒーロー・CTA）と名前が違う
        await expect(
          marqueeButton(page, pauseName(MOTION_PAUSE.resume, MOTION_PAUSE_TARGETS.marquee)),
        ).toBeVisible();

        await open(page, "/");
        await expect(page.locator(MARQUEE)).toHaveAttribute("data-motion-paused", "true");
        expect((await animationCounts(page, MARQUEE)).running, "移った先").toBe(0);

        await marqueeButton(page, MOTION_PAUSE.resume).click();
        await expect(page.locator(MARQUEE)).toHaveAttribute("data-motion-paused", "false");
        expect((await animationCounts(page, MARQUEE)).running, "再開後").toBe(3);
      });

      test("ポインターを流れの上に載せている間は止まり（読める）、離すと流れる", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, "/");
        await marqueeReady(page);
        await moveInto(page, page.locator("[data-marquee-stage]"), 0.5, 0.5);
        await expect
          .poll(async () => (await animationCounts(page, MARQUEE)).running)
          .toBe(0);
        await page.mouse.move(2, 2);
        await expect
          .poll(async () => (await animationCounts(page, MARQUEE)).running)
          .toBe(3);
      });

      test("前のページで止めていたら、水和を待たず最初の描画から止まっている（流れが一瞬も出ない）", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await page.addInitScript((key) => {
          sessionStorage.setItem(key, "paused");
          document.addEventListener("DOMContentLoaded", () => {
            (window as unknown as { __marqueePaused: string | null }).__marqueePaused =
              document.getElementById("tool-marquee")?.getAttribute("data-motion-paused") ?? null;
          });
        }, MARQUEE_KEY);
        await page.goto("/", { waitUntil: "load" });
        expect(
          await page.evaluate(
            () => (window as unknown as { __marqueePaused: string | null }).__marqueePaused,
          ),
        ).toBe("true");
        expect((await animationCounts(page, MARQUEE)).running).toBe(0);
      });

      test("Pin3d: 導入事例の 3 枚と無料 DL に付き、静止時は見えない。hover でピン（brand.sky）が立ち、カードが奥へ倒れる。離すと戻る", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, "/");
        await expect(page.locator("[data-pin3d]")).toHaveCount(4);
        await expect(page.locator("[data-pin3d] [data-pin3d-pin]")).toHaveCount(4);
        const pin = page.locator("[data-pin3d-pin]");
        // ピンは装飾（aria-hidden）で、操作を受けない
        for (let i = 0; i < 4; i++) {
          await expect(pin.nth(i)).toHaveAttribute("aria-hidden", "true");
          expect(
            await pin.nth(i).evaluate((el) => getComputedStyle(el).pointerEvents),
          ).toBe("none");
          expect(await pinOpacity(pin.nth(i)), `${i} 静止時`).toBe(0);
        }
        // 点と線は brand.sky（#1298E8）だけ。ロゴ・画像は入っていない
        const sky = await pin.first().evaluate((el) => {
          const dot = getComputedStyle(el, "::after").backgroundColor;
          const line = getComputedStyle(el, "::before").backgroundImage;
          return { dot, line };
        });
        expect(sky.dot).toBe("rgb(18, 152, 232)");
        expect(sky.line).toContain("rgb(18, 152, 232)");
        await expect(page.locator("[data-pin3d] img")).toHaveCount(0);

        for (const n of [0, 3]) {
          const card = page.locator("[data-pin3d]").nth(n);
          expect(
            await card.locator("[data-pin3d-body]").evaluate((el) => getComputedStyle(el).transform),
          ).toBe("none");
          await moveInto(page, card, 0.5, 0.6);
          await expect.poll(() => pinOpacity(pin.nth(n)), `${n} hover`).toBe(1);
          // 奥へ倒れる: y 軸の像の z が正（rotateX(+) で下の辺が手前へ、上の辺が奥へ）
          await expect
            .poll(async () => {
              const m = matrix3d(
                await card.locator("[data-pin3d-body]").evaluate((el) => getComputedStyle(el).transform),
              );
              return m ? m[6] : 0;
            }, `${n} 傾き`)
            .toBeGreaterThan(0.05);
          await page.mouse.move(2, 2);
          await expect.poll(() => pinOpacity(pin.nth(n)), `${n} 離す`).toBe(0);
        }
      });

      test("Pin3d: キーボード。無料 DL のボタンに Tab で届くとピンが立つ。カードに操作できる要素が入った導入事例でも同じ（5 秒以内に戻らない）", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, "/");
        // 導入事例のカード（ダミー）には操作できる要素が無いので、規則を確かめるためにボタンを差し込む（Task 4 と同じ方法）
        await page.locator("[data-pin3d]").first().evaluate((el) => {
          const b = document.createElement("button");
          b.textContent = "差し込み";
          el.querySelector("article")!.append(b);
        });
        await tabInto(page, "[data-pin3d]");
        expect(
          await page.evaluate(() => !!document.activeElement?.matches(":focus-visible")),
        ).toBe(true);
        const first = page.locator("[data-pin3d]").first();
        await expect.poll(() => pinOpacity(first.locator("[data-pin3d-pin]"))).toBe(1);
        // 倒れる
        await expect
          .poll(async () => {
            const m = matrix3d(
              await first.locator("[data-pin3d-body]").evaluate((el) => getComputedStyle(el).transform),
            );
            return m ? m[6] : 0;
          })
          .toBeGreaterThan(0.05);
        // 実際の 1-9（無料 DL）の CTA にも Tab で届き、ピンが立つ
        await tabInto(page, "#source-dl");
        const dl = page.locator("[data-pin3d]:has(#source-dl)");
        await expect.poll(() => pinOpacity(dl.locator("[data-pin3d-pin]"))).toBe(1);
        // リングが欠けない: フォーカスしている要素の中心にその要素がある
        const ring = await focusRing(page);
        expect(ring.focusVisible).toBe(true);
        expect(ring.style).toBe("solid");
        expect(ring.clippers, "リングを切る祖先").toEqual([]);
        expect(ring.hitSelf, "フォーカスの中心にその要素がある").toBe(true);
        // フォーカスが外れると戻る
        await page.evaluate(() => (document.activeElement as HTMLElement).blur());
        await expect.poll(() => pinOpacity(dl.locator("[data-pin3d-pin]"))).toBe(0);
      });

      test("StatRow: 導入事例の数値カード 3 枚。値は「—」のまま（数え上げない）で、値の下に罫がある", async ({
        page,
      }) => {
        await open(page, "/");
        await expect(page.locator("[data-stat-row]")).toHaveCount(1);
        const cards = page.locator("[data-stat-row] > *");
        await expect(cards).toHaveCount(3);
        const values = page.locator("[data-stat-row] [data-stat-value]");
        await expect(values).toHaveCount(3);
        for (let i = 0; i < 3; i++) {
          await expect(values.nth(i)).toHaveText("—");
          // 罫（::after）の高さ。静止の状態でも場所を取っている（引かれるときに高さが動かない）
          expect(
            await values.nth(i).evaluate((el) => getComputedStyle(el, "::after").height),
          ).toBe("2px");
        }
      });

      test("StatRow: 画面に入ると順に現れる（scroll-driven animation。transform だけで opacity は触らない）。罫が引かれて 1 になる", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, "/");
        const supported = await page.evaluate(() =>
          CSS.supports("animation-timeline: view()"),
        );
        test.skip(!supported, "scroll-driven animation に対応していないブラウザは静止");
        const cards = page.locator("[data-stat-row] > *");
        const timeline = await cards.evaluateAll((els) =>
          els.map((el) => {
            const s = getComputedStyle(el);
            return {
              timeline: s.animationTimeline,
              start: s.animationRangeStart,
              opacity: s.opacity,
            };
          }),
        );
        for (const t of timeline) {
          expect(t.timeline).toContain("view");
          expect(t.opacity, "opacity は触らない").toBe("1");
        }
        // 順に現れる: 範囲の始まりが後ろのカードほど遅い
        // "entry"（＝ entry 0%）のように数が無いときは 0
        const starts = timeline.map(
          (t) => Number.parseFloat(t.start.replace(/[^\d.]/g, "")) || 0,
        );
        expect(starts[0]).toBeLessThan(starts[1]);
        expect(starts[1]).toBeLessThan(starts[2]);
        // まだ入っていない（画面の下）: 下げられ、罫は引かれていない
        await page.evaluate(() => window.scrollTo(0, 0));
        expect(await translateY(cards.first()), "入る前").toBeGreaterThan(5);
        expect(await afterScaleX(page.locator("[data-stat-value]").first()), "入る前の罫").toBeLessThan(0.5);
        // 画面の中ほどまで運ぶと、位置が戻り、罫が引かれる
        await cards.nth(1).evaluate((el) => el.scrollIntoView({ block: "center" }));
        await expect.poll(() => translateY(cards.first())).toBeCloseTo(0, 0);
        await expect
          .poll(() => afterScaleX(page.locator("[data-stat-value]").first()))
          .toBeCloseTo(1, 1);
        await expect(page.locator("[data-stat-value]").first()).toHaveText("—");
      });

      test("axe の違反が 0（静止・流れている間・ポインターを載せた Pin・フォーカスした Pin・StatRow が入った後）", async ({
        page,
      }, testInfo) => {
        await open(page, "/");
        const run = async (label: string) => {
          const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
          expect(result.violations.map((v) => v.id), label).toEqual([]);
        };
        await run("静止");
        if (testInfo.project.name === "desktop") {
          await marqueeReady(page);
          await run("流れている間");
          await moveInto(page, page.locator("[data-pin3d]").nth(3), 0.5, 0.6);
          await page.waitForTimeout(500);
          await run("Pin hover");
          await page.mouse.move(2, 2);
          await tabInto(page, "#source-dl");
          await page.waitForTimeout(500);
          await run("Pin focus");
        }
        await page.locator("[data-stat-row]").evaluate((el) => el.scrollIntoView({ block: "center" }));
        await page.waitForTimeout(500);
        await run("StatRow");
      });
    });

    test.describe("異常系", () => {
      test("入力: 動きを減らす設定では、流れる面が描かれず（display: none）、animation も rAF も無い。今の折り返しの並びで全部読め、一時停止のボタンも出ない", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await open(page, "/");
        expect(
          await page.locator("[data-marquee-stage]").evaluate((el) => getComputedStyle(el).display),
        ).toBe("none");
        expect((await animationCounts(page, MARQUEE)).total, "流れの animation").toBe(0);
        await expect(marqueeButton(page, /動きを止める/)).toHaveCount(0);
        const items = page.locator(`${MARQUEE} ul > li`);
        await expect(items).toHaveCount(TOP.tools.badges.length);
        for (let i = 0; i < TOP.tools.badges.length; i++) {
          await expect(items.nth(i)).toBeVisible();
          expect((await items.nth(i).boundingBox())!.width).toBeGreaterThan(20);
        }
        expect(await rafDuring(page, 1_000), "rAF").toBe(0);
        // 傾けない: 折り返しの並び（複数の行。flex-wrap）
        expect(
          await page.locator(`${MARQUEE} ul`).evaluate((el) => getComputedStyle(el).flexWrap),
        ).toBe("wrap");

        // Pin3d: 倒れない。ピンは静止のまま出る（hover・フォーカス）
        const card = page.locator("[data-pin3d]").nth(3);
        await moveInto(page, card, 0.5, 0.6);
        await page.waitForTimeout(400);
        await expect.poll(() => pinOpacity(card.locator("[data-pin3d-pin]"))).toBe(1);
        expect(
          await card.locator("[data-pin3d-body]").evaluate((el) => getComputedStyle(el).transform),
        ).toBe("none");
        // StatRow: animation が無く、位置はそのまま、罫は引かれている
        const stat = page.locator("[data-stat-row] > *").first();
        expect(await stat.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
        expect(await translateY(stat)).toBe(0);
        expect(await afterScaleX(page.locator("[data-stat-value]").first())).toBe(1);
      });

      test("入力: Mobile（hover も細かいポインターも無い）でも流れる面が動き、一時停止のボタンが出る。押している間は流れが止まり、Pin は押している間だけ立って倒れる（2026-10-20 から。§8.4）", async ({
        page,
      }, testInfo) => {
        test.skip(testInfo.project.name !== "mobile", "Mobile の project だけ");
        await open(page, "/");
        const stage = page.locator("[data-marquee-stage]");
        await stage.scrollIntoViewIfNeeded();
        expect(await stage.evaluate((el) => getComputedStyle(el).display)).toBe("block");
        await expect(marqueeButton(page, /動きを止める/)).toBeVisible({ timeout: 5_000 });
        await expect.poll(async () => (await animationCounts(page, MARQUEE)).running).toBeGreaterThan(0);
        // 読み上げ用の一覧は 1 つだけ残る（視覚的にだけ隠す）
        await expect(page.locator(`${MARQUEE} ul > li`)).toHaveCount(TOP.tools.badges.length);

        const releaseMarquee = await touchPress(page.locator(MARQUEE), 0.5, 0.6);
        await expect.poll(async () => (await animationCounts(page, MARQUEE)).running, "押している間").toBe(0);
        await releaseMarquee();
        await expect.poll(async () => (await animationCounts(page, MARQUEE)).running, "離した後").toBeGreaterThan(0);

        const card = page.locator("[data-pin3d]").first();
        const body = card.locator("[data-pin3d-body]");
        const releasePin = await touchPress(card, 0.5, 0.5);
        await expect.poll(() => pinOpacity(card.locator("[data-pin3d-pin]"))).toBe(1);
        await expect.poll(() => body.evaluate((el) => getComputedStyle(el).transform)).not.toBe("none");
        await releasePin();
        await expect.poll(() => pinOpacity(card.locator("[data-pin3d-pin]"))).toBe(0);
        await expect.poll(() => body.evaluate((el) => getComputedStyle(el).transform)).toBe("none");
        // 数値カードは読める
        await expect(page.locator("[data-stat-value]").first()).toHaveText("—");
      });

      test("入力: JS が無くても、ツールは折り返しの並びで 1 回ずつ全部見え、流れる面は描かれない。Pin は hover で立つ（CSS だけ）。数値カードも読める", async ({
        browser,
        baseURL,
      }, testInfo) => {
        // hover の確認があるので desktop の project だけ（Mobile は上の Mobile のテストが覆う）
        desktopOnly(testInfo.project.name);
        const context = await browser.newContext({
          javaScriptEnabled: false,
          baseURL,
          viewport: { width: 1440, height: 900 },
        });
        const page = await context.newPage();
        await page.goto("/", { waitUntil: "load" });
        expect(
          await page.locator("[data-marquee-stage]").evaluate((el) => getComputedStyle(el).display),
        ).toBe("none");
        await expect(page.locator(`${MARQUEE} button`)).toHaveCount(0);
        const items = page.locator(`${MARQUEE} ul > li`);
        await expect(items).toHaveCount(TOP.tools.badges.length);
        for (let i = 0; i < TOP.tools.badges.length; i++) {
          await expect(items.nth(i)).toBeVisible();
          await expect(items.nth(i)).toHaveText(TOP.tools.badges[i]);
        }
        // 数値カードの値と罫
        await expect(page.locator("[data-stat-value]")).toHaveCount(3);
        await expect(page.locator("[data-stat-value]").first()).toBeVisible();
        // hover で Pin が立つ（JS に頼らない）
        const card = page.locator("[data-pin3d]").nth(3);
        await moveInto(page, card, 0.5, 0.6);
        await expect.poll(() => pinOpacity(card.locator("[data-pin3d-pin]"))).toBe(1);
        await context.close();
      });
    });
  });
}

// Task 6: 3D Globe（サービス一覧の導入ヒーロー。GlobeOsaka）。
// 部品の約束:
//   - 根に id="globe-osaka"・data-motion="globe"。最初の HTML には静止画（日本が正面の図。.globe-osaka__still）が出ている
//   - md 以上・WebGL あり・reduced-motion でない・JS ありのとき、手が空いてから three で描いた canvas に替わる（根に data-globe-live="true"）。canvas は aria-hidden
//   - 一時停止（motion:globe）で rAF が止まる。画面外・タブ非表示でも止まる。止めたまま開いたページでは three を読まない（canvas が作られない）
//   - reduced-motion・JS なし・WebGL なしは静止画のまま（canvas なし・一時停止のボタンなし・rAF 0）。弧は出さない（点は大阪だけ）
//   - 2026-10-20 から Mobile でも canvas に替わる（05-motion-spec.md §8.4）。Mobile の一時停止は地球儀の左下
const GLOBE = "#globe-osaka";
const GLOBE_KEY = "motion:globe";
const GLOBE_ROUTE = "/services/";

const globeButton = (page: Page, name: string | RegExp) =>
  page.locator(GLOBE).getByRole("button", { name });

/** three を描き始めて、静止画から canvas に替わるのを待つ（手が空いてから読むので、少し待つ） */
async function globeLive(page: Page) {
  await expect(page.locator(GLOBE)).toHaveAttribute("data-globe-live", "true", {
    timeout: 20_000,
  });
}

/** 静止画（陸地の mask・点）が出ているか */
const stillState = (page: Page) =>
  page.locator(GLOBE).evaluate((root) => {
    const still = root.querySelector<HTMLElement>(".globe-osaka__still")!;
    const land = root.querySelector<HTMLElement>(".globe-osaka__land")!;
    const pin = root.querySelector<HTMLElement>(".globe-osaka__pin")!;
    const landStyle = getComputedStyle(land);
    const rect = root.getBoundingClientRect();
    return {
      opacity: Number(getComputedStyle(still).opacity),
      display: getComputedStyle(still).display,
      ariaHidden: still.getAttribute("aria-hidden"),
      mask: landStyle.maskImage || landStyle.webkitMaskImage,
      pinVisible: pin.getBoundingClientRect().width > 3,
      width: rect.width,
      height: rect.height,
    };
  });

function describe_globe() {
  test.describe("Globe", () => {
    test.describe("正常系", () => {
      test("根は 1 つ。最初は静止画で、手が空いたら canvas に替わる（canvas は aria-hidden。静止画は消える）", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, GLOBE_ROUTE);
        await page.locator(GLOBE).scrollIntoViewIfNeeded(); // 2026-10-28: 地球儀はページ末尾（相談の案内の左）。画面に入れてから水和する
        await expect(page.locator('[data-motion="globe"]')).toHaveCount(1);
        // 最初の描画の時点では静止画だけ（three を読むのは手が空いてから）
        const before = await stillState(page);
        expect(before.mask, "陸地の mask（静止画の SVG）").toContain("url(");
        expect(before.pinVisible, "大阪の点").toBe(true);
        expect(before.ariaHidden).toBe("true");
        await globeLive(page);
        const canvas = page.locator(`${GLOBE} canvas`);
        await expect(canvas).toHaveCount(1);
        await expect(canvas).toHaveAttribute("aria-hidden", "true");
        // canvas の祖先にも aria-hidden の装飾の箱がある。フォーカスを受ける要素は canvas の中に無い
        expect(
          await canvas.evaluate((el) => !!el.closest('[aria-hidden="true"]')),
        ).toBe(true);
        expect(
          await page
            .locator(GLOBE)
            .evaluate(
              (root) =>
                root.querySelectorAll(
                  '[aria-hidden="true"] a, [aria-hidden="true"] button, [aria-hidden="true"] [tabindex]',
                ).length,
            ),
        ).toBe(0);
        await expect
          .poll(async () => (await stillState(page)).opacity)
          .toBeLessThan(0.05);
        // 地球の円は根の中に収まり、根の大きさは静止画と同じ（レイアウトを動かさない）
        const after = await stillState(page);
        expect(after.width).toBe(before.width);
        expect(after.height).toBe(before.height);
      });

      test("動いている間は rAF が回り（描画している）、地球儀の canvas は 1 枚だけ", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, GLOBE_ROUTE);
        await page.locator(GLOBE).scrollIntoViewIfNeeded(); // 2026-10-28: 地球儀はページ末尾（相談の案内の左）。画面に入れてから水和する
        await globeLive(page);
        expect(await rafDuring(page, 1_000), "描画している間の rAF").toBeGreaterThan(5);
        await expect(page.locator(`${GLOBE} canvas`)).toHaveCount(1);
      });

      test("一時停止のボタン: 名前に対象名が付き（隣の相談の案内のボタンと違う）、押すと rAF が止まり、属性・sessionStorage に残る。再開で動く", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, GLOBE_ROUTE);
        await page.locator(GLOBE).scrollIntoViewIfNeeded(); // 2026-10-28: 地球儀はページ末尾（相談の案内の左）。画面に入れてから水和する
        // 2026-10-28: 地球儀はヒーローから、ページ末尾の相談の案内（CTA）の左へ移った（ユーザーの決定）。画面に入れてから水和する
        await page.locator(GLOBE).scrollIntoViewIfNeeded();
        const pause = globeButton(
          page,
          pauseName(MOTION_PAUSE.pause, MOTION_PAUSE_TARGETS.globe),
        );
        await expect(pause).toBeVisible({ timeout: 10_000 });
        await expect(page.locator(GLOBE)).toHaveAttribute("data-motion-paused", "false");
        await globeLive(page);
        expect(await rafDuring(page, 1_000)).toBeGreaterThan(5);

        await pause.click();
        await expect(page.locator(GLOBE)).toHaveAttribute("data-motion-paused", "true");
        expect(
          await page.evaluate((k) => sessionStorage.getItem(k), GLOBE_KEY),
        ).toBe("paused");
        // 止まった後は three-globe の自前の rAF（輪・tween）も含めて 0
        await page.waitForTimeout(300);
        expect(await rafDuring(page, 1_500), "押した後の rAF").toBe(0);
        // 止めても、最後の 1 枚の canvas は残る（静止画に戻らない）
        await expect(page.locator(GLOBE)).toHaveAttribute("data-globe-live", "true");

        const resume = globeButton(
          page,
          pauseName(MOTION_PAUSE.resume, MOTION_PAUSE_TARGETS.globe),
        );
        await expect(resume).toBeVisible();
        // 同じページの別の一時停止（隣の相談の案内）とは名前が違う
        await expect(
          page.getByRole("button", { name: pauseName(MOTION_PAUSE.pause, MOTION_PAUSE_TARGETS.cta) }),
        ).toBeVisible();
        await resume.click();
        await expect(page.locator(GLOBE)).toHaveAttribute("data-motion-paused", "false");
        expect(
          await page.evaluate((k) => sessionStorage.getItem(k), GLOBE_KEY),
        ).toBeNull();
        expect(await rafDuring(page, 1_000), "再開した後の rAF").toBeGreaterThan(5);
      });

      test("止めたままページを移って戻ると、止まったまま開き、three を読まない（canvas を作らない）。再開で読み込んで動く", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, GLOBE_ROUTE);
        await page.locator(GLOBE).scrollIntoViewIfNeeded(); // 2026-10-28: 地球儀はページ末尾（相談の案内の左）。画面に入れてから水和する
        await expect(globeButton(page, MOTION_PAUSE.pause)).toBeVisible({ timeout: 10_000 });
        await globeButton(page, MOTION_PAUSE.pause).click();
        await open(page, "/services/development/");
        await open(page, GLOBE_ROUTE);
        await page.locator(GLOBE).scrollIntoViewIfNeeded(); // 2026-10-28: 地球儀はページ末尾（相談の案内の左）。画面に入れてから水和する
        await expect(page.locator(GLOBE)).toHaveAttribute("data-motion-paused", "true");
        await expect(globeButton(page, MOTION_PAUSE.resume)).toBeVisible({ timeout: 10_000 });
        // 手が空くのを十分に待っても、canvas は作られず静止画のまま
        await page.waitForTimeout(4_000);
        await expect(page.locator(`${GLOBE} canvas`)).toHaveCount(0);
        expect((await stillState(page)).opacity).toBe(1);
        expect(await rafDuring(page, 1_000), "止めたまま開いた rAF").toBe(0);

        await globeButton(page, MOTION_PAUSE.resume).click();
        await globeLive(page);
        expect(await rafDuring(page, 1_000), "再開した後の rAF").toBeGreaterThan(5);
      });

      test("動いている途中で reduced-motion が有効になると、rAF が止まり、一時停止のボタンも消える（canvas は残る）", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, GLOBE_ROUTE);
        await page.locator(GLOBE).scrollIntoViewIfNeeded(); // 2026-10-28: 地球儀はページ末尾（相談の案内の左）。画面に入れてから水和する
        await globeLive(page);
        expect(await rafDuring(page, 1_000)).toBeGreaterThan(5);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await expect(globeButton(page, /動きを止める|動きを再開する/)).toHaveCount(0);
        await page.waitForTimeout(500);
        expect(await rafDuring(page, 1_500), "reduced-motion に切り替えた後の rAF").toBe(0);
      });

      test("画面の外へスクロールすると rAF が止まり、戻ると動く", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, GLOBE_ROUTE);
        // 2026-10-28: 地球儀はヒーローから、ページ末尾の相談の案内（CTA）の左へ移った（ユーザーの決定）。画面に入れてから水和する
        await page.locator(GLOBE).scrollIntoViewIfNeeded();
        await globeLive(page);
        expect(await rafDuring(page, 1_000)).toBeGreaterThan(5);
        // 画面の外: ページの中ほど（「どれを選べばよいか」の節）。上端はヘッダーなどほかの部品の rAF があるので使わない
        await page.locator("#services-chooser").scrollIntoViewIfNeeded();
        await expect(page.locator(GLOBE)).not.toBeInViewport();
        await page.waitForTimeout(600);
        expect(await rafDuring(page, 1_500), "画面の外にある間の rAF").toBe(0);
        await page.locator(GLOBE).scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        expect(await rafDuring(page, 1_000), "戻した後の rAF").toBeGreaterThan(5);
      });

      test("three-globe の WebGPU の一式を外す差し替えが効いている（dist の Globe のチャンクにスタブの印があり、1MB 未満）", async () => {
        // vite-plugin.ts が効かなくなる（three-globe の版・import の形の変更）と、Globe のチャンクが約 1.5MB に戻る。ビルド済みの dist を直接見る
        const dir = path.resolve("dist/_astro");
        const chunk = fs.readdirSync(dir).filter((f) => /^Globe\..+\.js$/.test(f));
        expect(chunk, "Globe のチャンク").toHaveLength(1);
        const file = path.join(dir, chunk[0]);
        expect(fs.readFileSync(file, "utf8")).toContain(
          "three-globe の heatmaps（WebGPU）は、このサイトのビルドでは使えない",
        );
        expect(fs.statSync(file).size, "Globe のチャンクの大きさ").toBeLessThan(1_000_000);
      });

      test("three の実装は 1 つのチャンクだけ（isWebGLRenderer を含む JS の応答が 1 つ。R3F のチャンクは WebGLRenderer の名前を import するだけで、実装を持たない）", async ({
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
        await open(page, GLOBE_ROUTE);
        await page.locator(GLOBE).scrollIntoViewIfNeeded(); // 2026-10-28: 地球儀はページ末尾（相談の案内の左）。画面に入れてから水和する
        await globeLive(page);
        expect(withRenderer, "three の実装を含む JS").toHaveLength(1);
      });

      test("動いている間も、axe の違反が 0。動きが要因のレイアウトのずれ（CLS）が 0.01 未満", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, GLOBE_ROUTE);
        await page.locator(GLOBE).scrollIntoViewIfNeeded(); // 2026-10-28: 地球儀はページ末尾（相談の案内の左）。画面に入れてから水和する
        await globeLive(page);
        const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
        expect(
          results.violations.map(
            (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(",")}`,
          ),
        ).toEqual([]);
        expect((await cls(page)).motion).toBeLessThan(0.01);
      });

      test("一時停止のボタンに Tab で届き、Enter で止められる（フォーカスリングが見える）", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, GLOBE_ROUTE);
        await page.locator(GLOBE).scrollIntoViewIfNeeded(); // 2026-10-28: 地球儀はページ末尾（相談の案内の左）。画面に入れてから水和する
        const pause = globeButton(page, MOTION_PAUSE.pause);
        await expect(pause).toBeVisible({ timeout: 10_000 });
        await tabInto(page, `${GLOBE} button`);
        await expect(pause).toBeFocused();
        const ring = await focusRing(page);
        expect(ring.focusVisible).toBe(true);
        expect(ring.hitSelf, "ボタンが他の要素に覆われていない").toBe(true);
        await page.keyboard.press("Enter");
        await expect(page.locator(GLOBE)).toHaveAttribute("data-motion-paused", "true");
      });
    });

    test.describe("異常系", () => {
      test("入力: reduced-motion では canvas が無く、静止画が出ていて、一時停止のボタンも出ない。rAF は 0 で three も読まない", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await page.emulateMedia({ reducedMotion: "reduce" });
        let rendererScripts = 0;
        page.on("response", async (response) => {
          if (!/\.js(\?|$)/.test(response.url()) || !response.ok()) return;
          const body = await response.text().catch(() => "");
          if (body.includes("WebGLRenderer")) rendererScripts++;
        });
        await open(page, GLOBE_ROUTE);
        await page.locator(GLOBE).scrollIntoViewIfNeeded(); // 2026-10-28: 地球儀はページ末尾（相談の案内の左）。画面に入れてから水和する
        await page.waitForTimeout(4_000);
        await expect(page.locator(`${GLOBE} canvas`)).toHaveCount(0);
        await expect(page.locator(GLOBE)).not.toHaveAttribute("data-globe-live", "true");
        const still = await stillState(page);
        expect(still.opacity).toBe(1);
        expect(still.mask).toContain("url(");
        expect(still.pinVisible).toBe(true);
        await expect(globeButton(page, /動きを止める|動きを再開する/)).toHaveCount(0);
        expect(await rafDuring(page, 2_000), "rAF").toBe(0);
        expect(rendererScripts, "three を読んでいない").toBe(0);
      });

      test("サーバ: 地球儀の部品（Globe のチャンク）を読めないと、静止画のまま（canvas・一時停止のボタンなし）で、コンソールに [globe] の失敗を出す", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        const errors: string[] = [];
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        // GlobeIsland のチャンクは通し、動的 import の Globe（原本）のチャンクだけ落とす
        await page.route(/\/_astro\/Globe\.[\w-]+\.js$/, (route) =>
          route.abort(),
        );
        await open(page, GLOBE_ROUTE);
        await page.locator(GLOBE).scrollIntoViewIfNeeded(); // 2026-10-28: 地球儀はページ末尾（相談の案内の左）。画面に入れてから水和する
        await expect
          .poll(
            () =>
              errors.filter((e) =>
                e.startsWith("[globe] 3D の読み込みに失敗しました"),
              ).length,
            {
              timeout: 15_000,
            },
          )
          .toBe(1);
        await expect(page.locator(`${GLOBE} canvas`)).toHaveCount(0);
        await expect(
          globeButton(page, /動きを止める|動きを再開する/),
        ).toHaveCount(0);
        const still = await stillState(page);
        expect(still.opacity).toBe(1);
        expect(still.pinVisible).toBe(true);
      });

      test("入力: Mobile（md 未満）でも canvas に替わって動き、一時停止のボタンがヒーローのボタンと重ならない（2026-10-20 から。§8.4）", async ({
        page,
      }, testInfo) => {
        test.skip(testInfo.project.name !== "mobile", "Mobile の project だけ");
        test.setTimeout(60_000);
        await open(page, GLOBE_ROUTE);
        await page.locator(GLOBE).scrollIntoViewIfNeeded();
        await expect(page.locator(GLOBE)).toHaveAttribute("data-globe-live", "true", { timeout: 30_000 });
        await expect(page.locator(`${GLOBE} canvas`)).toHaveCount(1);
        const globePause = globeButton(page, /動きを止める/);
        await expect(globePause).toBeVisible();
        expect(await rafDuring(page, 1_000), "rAF").toBeGreaterThan(0);
        // 地球儀と、隣の相談の案内（CTA）の一時停止のボタンが重ならない（2026-10-28 に地球儀がヒーローから CTA の左へ移った）
        const a = (await globePause.boundingBox())!;
        const b = (await page.getByRole("button", { name: pauseName(MOTION_PAUSE.pause, MOTION_PAUSE_TARGETS.cta) }).boundingBox())!;
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap, "ボタンの重なり").toBe(false);
        // 根は画面の幅に収まる（横にあふれない）
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      });

      test("入力: JavaScript が使えなくても、静止画が出て、一時停止のボタンは無い", async ({
        browser,
        baseURL,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        const context = await browser.newContext({
          javaScriptEnabled: false,
          baseURL,
          viewport: { width: 1440, height: 900 },
        });
        const page = await context.newPage();
        await page.goto(GLOBE_ROUTE, { waitUntil: "load" });
        const still = await stillState(page);
        expect(still.opacity).toBe(1);
        expect(still.mask).toContain("url(");
        expect(still.pinVisible).toBe(true);
        await expect(page.locator(`${GLOBE} canvas`)).toHaveCount(0);
        await expect(page.locator(`${GLOBE} button`)).toHaveCount(0);
        await context.close();
      });
    });
  });
}

// 2026-10-28（計画 2026-10-28-hero-diorama の Task 11）: 告知バナー（1-1）の磨き込み。文言・配置・閉じるボタンなしは変えない
test.describe("告知バナー", () => {
  const ARROW = '[data-announcement] a[data-cta-id="dl_top_banner"] [data-icon="inline-end"]';
  const translateX = (page: Page) =>
    page.locator(ARROW).first().evaluate((el) => {
      const m = getComputedStyle(el).transform;
      return m === "none" ? 0 : new DOMMatrixReadOnly(m).m41;
    });

  test.describe("正常系", () => {
    test("「受け取る」に hover・キーボードのフォーカスで矢印が右へ 4px 動き、文言はいまのまま", async ({ page }, testInfo) => {
      desktopOnly(testInfo.project.name);
      await open(page, "/");
      await expect(page.locator("[data-announcement]")).toContainText(TOP.announcement.desktopBody);
      expect(await translateX(page)).toBe(0);
      await page.locator('[data-announcement] a[data-cta-id="dl_top_banner"]').hover();
      await page.waitForTimeout(400);
      expect(await translateX(page)).toBe(4);
      await page.mouse.move(0, 400);
      await page.waitForTimeout(400);
      expect(await translateX(page)).toBe(0);
      await page.locator('[data-announcement] a[data-cta-id="dl_top_banner"]').focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await page.waitForTimeout(400);
      expect(await translateX(page)).toBe(4);
    });
  });

  test.describe("異常系", () => {
    test("入力: reduced-motion では矢印が動かず、バッジの光も流れない", async ({ page }, testInfo) => {
      desktopOnly(testInfo.project.name);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await open(page, "/");
      await page.locator('[data-announcement] a[data-cta-id="dl_top_banner"]').hover();
      await page.waitForTimeout(400);
      expect(await translateX(page)).toBe(0);
      const running = await page.evaluate(
        () => document.getAnimations().filter((a) => (a.effect as KeyframeEffect | null)?.target instanceof Element && ((a.effect as KeyframeEffect).target as Element).closest("[data-announcement]")).length,
      );
      expect(running).toBe(0);
    });
  });
});
