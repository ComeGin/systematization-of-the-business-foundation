// B（calm）のページの「静か」な動きの検査（計画書 2026-10-19-aceternity-motion の Task 7）。A の CTA の光の縁（CtaGlow）もここで見る。
// 部品の約束:
//   - Reveal: 画面に入るとき 16px 下から上がる。transform だけで、opacity は触らない（判断 R10）。CSS だけ（JS を読まない）。h1 には使わない
//   - CountUp: 最終値が最初の HTML にある（読み上げはこれだけ）。画面に入ったとき 1 回だけ、aria-hidden の重ねた数字が 0 から上がる
//   - ReadingProgress: 記事の上端に 2px の読了バー。記事の範囲の読み進めに結びつく
//   - 目次の「いまここ」: ブログ記事だけ aria-current="location"。規約（C）は付けない
//   - B のページには光り物（hero・globe・cta-glow・marquee）を置かない。B の CTA は MotionBlobs の自前の一時停止のボタン
//   - A の CTA（CtaGlow）: 光の縁が 1 周 --motion-duration-glow、粒は 1 秒以上の周期。一時停止のボタンは 1 つで、MotionBlobs の粒も止める
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { animationCounts, cls, instrument, rafDuring } from "../support/motion";
import {
  MOTION_PAUSE,
  MOTION_PAUSE_TARGETS,
} from "../../src/modules/site-content/a11y";
import { open } from "./axe";
import { NOT_FOUND_ROUTE, distRoutes } from "./routes";

const A_ROUTES = [
  "/",
  "/services/",
  "/services/environment-setup/",
  "/services/development/",
  "/services/consulting/",
  "/services/partnership/",
];

/** B（calm）の全ルート。A の 6 ルートと /legal/（C）を除く。存在しない URL（404）も B */
const calmRoutes = () => [
  ...distRoutes().filter(
    (route) => !A_ROUTES.includes(route) && !route.startsWith("/legal/"),
  ),
  NOT_FOUND_ROUTE,
];

/** ブログ記事（目次のある 1 本） */
const ARTICLE = distRoutes().find((route) =>
  /^\/blog\/(?!category\/|page\/)[^/]+\/$/.test(route),
);

const pauseName = (label: string, target: string) =>
  new RegExp(`${label}\\s*${target}`);

const desktopOnly = (name: string) =>
  test.skip(name !== "desktop", "md 以上の端末だけ");

/** 光り物（B に置かない部品の印） */
const SHINY =
  '[data-motion="hero"], [data-motion="globe"], [data-motion="cta-glow"], [data-motion="marquee"]';

/** island（client:visible）の水和を待つ。済んだ後の最初の commit が rAF を使うことがあるので少し置く */
async function settle(page: Page, selector: string) {
  await page
    .waitForFunction(
      (sel) => {
        const island = document.querySelector(sel)?.closest("astro-island");
        return !island || !island.hasAttribute("ssr");
      },
      selector,
      { timeout: 10_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(500);
}

/** 要素の transform の matrix の ty（下へのずれ px）。none は 0 */
const translateY = (page: Page, selector: string, index = 0) =>
  page
    .locator(selector)
    .nth(index)
    .evaluate((el) => {
      return new DOMMatrix(getComputedStyle(el).transform).m42;
    });

test.describe("B（calm）の動き", () => {
  test.beforeEach(async ({ page }) => instrument(page));
  // 2026-10-28: ヒーローの模型（diorama）の描画が、ページ全体の rAF の数に混ざらないよう、最初から止めて開く（模型は diorama.spec.ts で検査する）
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        sessionStorage.setItem("motion:diorama", "paused");
      } catch {}
    });
  });

  test.describe("全ルート", () => {
    test.describe("正常系", () => {
      for (const route of calmRoutes()) {
        test(`${route}: 光り物（hero・globe・cta-glow・marquee）が 0 個で、h1 は Reveal の中にない`, async ({
          page,
        }) => {
          await page.goto(route, { waitUntil: "domcontentloaded" });
          await expect(page.locator("html")).toHaveAttribute(
            "data-motion-zone",
            "calm",
          );
          expect(
            await page
              .locator(`[data-motion-zone="calm"] :is(${SHINY})`)
              .count(),
          ).toBe(0);
          // 最初の描画から動かさない（LCP の見出しは Reveal の外）
          expect(
            await page
              .locator("h1")
              .evaluateAll(
                (els) => els.filter((el) => el.closest("[data-reveal]")).length,
              ),
          ).toBe(0);
        });
      }
    });
  });

  test.describe("Reveal", () => {
    test.describe("正常系", () => {
      test("/pricing/: 画面の下の料金カードは 16px 下から始まり、画面に入ると元の位置に着く。opacity は 1 のまま", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, "/pricing/");
        const cards = page.locator("article[class*='justify-between']");
        expect(
          await page.locator("[data-reveal]").count(),
        ).toBeGreaterThanOrEqual(6);
        // 5 枚の料金カードは、どれも Reveal の中
        expect(
          await cards.evaluateAll(
            (els) => els.filter((el) => el.closest("[data-reveal]")).length,
          ),
        ).toBe(5);
        // 下にある（最初の画面に入っていない）Reveal は、まだ 16px 下にある
        const below = await page.locator("[data-reveal]").evaluateAll((els) =>
          els
            .map((el, index) => ({
              index,
              top: el.getBoundingClientRect().top,
            }))
            .filter((item) => item.top > window.innerHeight + 100)
            .map((item) => item.index),
        );
        expect(below.length).toBeGreaterThan(0);
        expect(await translateY(page, "[data-reveal]", below[0])).toBeCloseTo(
          16,
          0,
        );
        // 画面の中央に持ってくると、元の位置に着く
        await page
          .locator("[data-reveal]")
          .nth(below[0])
          .evaluate((el) => el.scrollIntoView({ block: "center" }));
        await expect
          .poll(() => translateY(page, "[data-reveal]", below[0]))
          .toBeCloseTo(0, 0);
        // どの Reveal も opacity は 1（画面の外にある間も文字が 100% の濃さ。axe のコントラスト検査に落ちない）
        const opacities = await page
          .locator("[data-reveal]")
          .evaluateAll((els) => els.map((el) => getComputedStyle(el).opacity));
        expect(opacities.length).toBeGreaterThan(0);
        expect(opacities.every((opacity) => opacity === "1")).toBe(true);
      });

      test("同じ段のカードは step の分だけ遅れて着く（現れ始めが遅い）", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, "/pricing/");
        const steps = await page
          .locator("[data-reveal]")
          .evaluateAll((els) =>
            els.map((el) =>
              getComputedStyle(el).getPropertyValue("--reveal-step").trim(),
            ),
          );
        // 料金カードの 3 列（0・1・2）と 2 列（0・1）
        expect(steps.slice(0, 5)).toEqual(["0", "1", "2", "0", "1"]);
      });

      test("JS を読まない（Reveal だけのページには island の JS が無い）", async ({
        page,
      }) => {
        const scripts: string[] = [];
        page.on("request", (request) => {
          if (request.resourceType() === "script") scripts.push(request.url());
        });
        await open(page, "/sitemap/");
        expect(
          scripts.filter((url) => /CountUp|TocTracker|Reveal/.test(url)),
        ).toEqual([]);
        expect(await page.locator("[data-reveal]").count()).toBeGreaterThan(0);
      });
    });

    test.describe("異常系", () => {
      test("入力: reduced-motion では動かない（画面の下にある Reveal も元の位置）", async ({
        page,
      }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await open(page, "/pricing/");
        const ys = await page
          .locator("[data-reveal]")
          .evaluateAll((els) =>
            els.map((el) => new DOMMatrix(getComputedStyle(el).transform).m42),
          );
        expect(ys.length).toBeGreaterThan(0);
        expect(ys.every((y) => y === 0)).toBe(true);
      });

      test("入力: JS が無くても Reveal の中の文字がすべて読める", async ({
        browser,
      }) => {
        const context = await browser.newContext({ javaScriptEnabled: false });
        const page = await context.newPage();
        await page.goto("/pricing/");
        // 料金カードの見出し（Reveal の中）が読める
        const cardHeading = page.locator("[data-reveal] article h2").first();
        await expect(cardHeading).toBeVisible();
        expect(((await cardHeading.textContent()) ?? "").trim().length).toBeGreaterThan(0);
        expect(
          await page
            .locator("[data-reveal]")
            .evaluateAll((els) =>
              els.every((el) => getComputedStyle(el).opacity === "1"),
            ),
        ).toBe(true);
        await context.close();
      });
    });
  });

  test.describe("CountUp（ブログ一覧 7-3）", () => {
    test.describe("正常系", () => {
      test("72.2%・53.8%・50.8% は、アクセシビリティツリーに 1 回ずつだけ現れる（数え上げの前・途中・後）", async ({
        page,
      }) => {
        await open(page, "/blog/");
        const read = async () => {
          const tree = await page.locator("main").ariaSnapshot();
          return ["72.2%", "53.8%", "50.8%"].map(
            (value) => tree.split(value).length - 1,
          );
        };
        expect(await read(), "水和した直後").toEqual([1, 1, 1]);
        await page.waitForTimeout(400);
        expect(await read(), "数え上げの途中").toEqual([1, 1, 1]);
        await expect(page.locator('[data-count-state="done"]')).toHaveCount(3, {
          timeout: 10_000,
        });
        expect(await read(), "数え上げの後").toEqual([1, 1, 1]);
      });

      test("画面の外にある間は 0 から待ち（armed）、画面に入ると 1 回だけ上がって最終値に着く。行の高さは動かない", async ({
        page,
      }, testInfo) => {
        // 数字が最初の画面の外に出るよう、画面を低くする（Desktop は導入の数字が 261〜423px にある。2026-10-28 に導入の右へ模型の静止画が入り、
        // 本文の列が狭くなって下がった。以前は 229〜342px）。水和は画面の 200px 手前で済むので、高さ 230px なら 430px まで水和する
        test.skip(testInfo.project.name !== "desktop", "Desktop だけ");
        await page.setViewportSize({ width: 1440, height: 230 });
        await page.addInitScript(() => {
          const w = window as unknown as { __ticks: string[] };
          w.__ticks = [];
          new MutationObserver(() => {
            for (const el of document.querySelectorAll("[data-count-ticker]")) {
              const text = el.textContent ?? "";
              if (w.__ticks.at(-1) !== text) w.__ticks.push(text);
            }
          }).observe(document, {
            subtree: true,
            childList: true,
            characterData: true,
          });
        });
        await open(page, "/blog/");
        const target = page
          .locator("[data-count-final]", { hasText: "53.8%" })
          .locator("xpath=..");
        const paragraph = target.locator("xpath=ancestor::p[1]");
        // 画面の外: 水和済みで、まだ数え始めない（0 から待つ）
        await expect(target).toHaveAttribute("data-count-state", "armed", {
          timeout: 10_000,
        });
        expect(await target.locator("[data-count-ticker]").textContent()).toBe(
          "0.0%",
        );
        const before = (await paragraph.boundingBox())?.height;
        await target.evaluate((el) => el.scrollIntoView({ block: "center" }));
        await expect(target).toHaveAttribute("data-count-state", "counting");
        const startedAt = Date.now();
        await expect(target).toHaveAttribute("data-count-state", "done", {
          timeout: 10_000,
        });
        const took = Date.now() - startedAt;
        // 時間は --motion-duration-large の 2 倍（1200ms）。観測の揺れを見て広めに
        expect(took).toBeGreaterThan(500);
        expect(took).toBeLessThan(2_500);
        const after = (await paragraph.boundingBox())?.height;
        expect(after).toBe(before);
        // 最終値の文字がそのまま見える
        await expect(target.locator("[data-count-final]")).toBeVisible();
        expect(await target.locator("[data-count-ticker]").count()).toBe(0);
        // 途中の値は 0.0% から単調に増え、最終値を超えない
        const ticks = await page.evaluate(
          () => (window as unknown as { __ticks: string[] }).__ticks,
        );
        const values = ticks.map((text) => Number.parseFloat(text));
        expect(values.length).toBeGreaterThan(5);
        expect(values.every((v) => v >= 0 && v <= 72.2)).toBe(true);
        const mine = values.filter((_, i) => ticks[i].endsWith("%"));
        expect(mine[0]).toBe(0);
      });

      test("数え上げの間も、レイアウトのずれ（motion）は 0.01 未満", async ({
        page,
      }) => {
        await open(page, "/blog/");
        await expect(page.locator('[data-count-state="done"]')).toHaveCount(3, {
          timeout: 10_000,
        });
        expect((await cls(page)).motion).toBeLessThan(0.01);
      });
    });

    test.describe("異常系", () => {
      test("入力: 水和の前（JS は有効）は最終値の領域が隠れ（clip-path）、アクセシビリティツリーには値が 1 回あり、水和が来なくても 4 秒後に見える（安全策）", async ({
        page,
      }, testInfo) => {
        test.skip(testInfo.project.name !== "desktop", "Desktop だけ");
        // 数え上げの island の JS を止めて、水和が来ない状態を作る
        await page.route(/CountUpIsland.*\.js/, (route) => route.abort());
        await page.goto("/blog/", { waitUntil: "load" });
        const final = page.locator("[data-count-final]", { hasText: "72.2%" });
        expect(await page.locator("[data-count-state]").count()).toBe(0);
        const clip = () =>
          final.evaluate((el) => getComputedStyle(el).clipPath);
        expect(await clip()).toBe("inset(50%)");
        const tree = await page.locator("main").ariaSnapshot();
        expect(tree.split("72.2%").length - 1).toBe(1);
        // 4 秒後（animation-delay）に安全策が clip-path を外す
        await expect.poll(clip, { timeout: 8_000 }).toBe("none");
        await expect(final).toBeVisible();
      });

      test("入力: 最終値が見えてから 0 に戻る揺れが無い（水和の前・armed・counting の間、最終値の文字は隠れたまま）", async ({
        page,
      }, testInfo) => {
        test.skip(testInfo.project.name !== "desktop", "Desktop だけ");
        await page.addInitScript(() => {
          const w = window as unknown as { __clipLog: string[] };
          w.__clipLog = [];
          const tick = () => {
            for (const el of document.querySelectorAll("[data-count-up]")) {
              const final = el.querySelector("[data-count-final]");
              if (!final) continue;
              w.__clipLog.push(
                `${el.getAttribute("data-count-state") ?? "idle"}|${getComputedStyle(final).clipPath}`,
              );
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        await open(page, "/blog/");
        await expect(page.locator('[data-count-state="done"]')).toHaveCount(3, {
          timeout: 10_000,
        });
        const log = await page.evaluate(
          () => (window as unknown as { __clipLog: string[] }).__clipLog,
        );
        const kinds = new Set(log.map((entry) => entry.split("|")[0]));
        expect(kinds.has("counting"), "数え上げを観測した").toBe(true);
        // 動かす間（idle・armed・counting）は、最終値の文字がいつも隠れている
        const visibleWhileMoving = log.filter(
          (entry) =>
            /^(idle|armed|counting)\|/.test(entry) && !entry.endsWith("|inset(50%)"),
        );
        expect(visibleWhileMoving).toEqual([]);
        // 数え終わると見える
        expect(log.some((entry) => entry === "done|none")).toBe(true);
      });

      test("入力: JS が無くても 72.2% が見える（最終値は最初の HTML にある）", async ({
        browser,
      }) => {
        const context = await browser.newContext({ javaScriptEnabled: false });
        const page = await context.newPage();
        await page.goto("/blog/");
        const final = page.locator("[data-count-final]", { hasText: "72.2%" });
        await expect(final).toBeVisible();
        await expect(final).toHaveText("72.2%");
        expect(await final.evaluate((el) => getComputedStyle(el).clipPath)).toBe("none");
        expect(await page.locator("[data-count-ticker]").count()).toBe(0);
        await context.close();
      });

      test("入力: reduced-motion では数え上げず（rAF 0・ticker なし）、最終値のまま", async ({
        page,
      }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await open(page, "/blog/");
        await settle(page, "[data-count-up]");
        expect(await rafDuring(page, 1_500)).toBe(0);
        expect(await page.locator("[data-count-ticker]").count()).toBe(0);
        const states = await page
          .locator("[data-count-up]")
          .evaluateAll((els) =>
            els.map((el) => el.getAttribute("data-count-state")),
          );
        expect(states).toEqual(["static", "static", "static"]);
        // 最終値の文字は隠れていない（水和の前から reduced-motion では隠さない）
        expect(
          await page
            .locator("[data-count-final]")
            .evaluateAll((els) => els.map((el) => getComputedStyle(el).clipPath)),
        ).toEqual(["none", "none", "none"]);
        await expect(
          page.locator("[data-count-final]", { hasText: "72.2%" }),
        ).toBeVisible();
      });

      test("入力: 料金のページには数え上げがない（金額は切り替えない）", async ({
        page,
      }) => {
        await open(page, "/pricing/");
        expect(await page.locator("[data-count-up]").count()).toBe(0);
      });
    });
  });

  test.describe("ブログ記事", () => {
    test.beforeEach(() => {
      expect(ARTICLE, "dist にブログ記事がありません").toBeTruthy();
    });

    test.describe("正常系", () => {
      test("スクロールすると、目次の項目のどれか 1 つが aria-current=location になり、画面の上 30% の線より上の最後の見出しに対応する", async ({
        page,
      }) => {
        await open(page, ARTICLE!);
        // Desktop の目次（sidebar）と Mobile の目次（accordion）の両方に付く（片方は CSS で隠れているだけ）。順は本文の順
        const links = page.locator("nav[data-toc-track]").first().locator("a");
        const ids = await links.evaluateAll((els) =>
          els.map((el) => (el.getAttribute("href") ?? "").slice(1)),
        );
        expect(ids.length).toBeGreaterThan(1);
        const current = page.locator("[data-toc-track] a[aria-current='location']");
        // 期待する項目: 画面の上から 30% の線より上にある、いちばん下の見出し
        const expected = () =>
          page.evaluate((list) => {
            const line = window.innerHeight * 0.3;
            let found: string | null = null;
            for (const id of list) {
              const el = document.getElementById(id);
              if (el && el.getBoundingClientRect().top <= line) found = id;
              else break;
            }
            return found;
          }, ids);
        for (const id of [ids[0], ids.at(-1)!]) {
          await page.evaluate(
            (target) => document.getElementById(target)?.scrollIntoView(),
            id,
          );
          const want = await expected();
          expect(want, "見出しを先頭に持ってきたので、線より上の見出しがある").not.toBeNull();
          // 2 つの目次（sidebar・accordion）の同じ項目に付く
          await expect(current).toHaveCount(2, { timeout: 10_000 });
          await expect
            .poll(() =>
              current.evaluateAll((els) => els.map((el) => el.getAttribute("href"))),
            )
            .toEqual([`#${want}`, `#${want}`]);
        }
        // 最後の見出しまで来たら、最後の項目
        expect(await current.first().getAttribute("href")).toBe(`#${ids.at(-1)}`);
        // 記事の一番上へ戻ると、最初の見出しより上なので印はなくなる
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect(current).toHaveCount(0, { timeout: 10_000 });
      });

      test("目次の「いまここ」の見た目の印（項目の左の線）が付く", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, ARTICLE!);
        const nav = page.locator("nav[data-toc-track]:visible");
        const first = (await nav
          .locator("a")
          .first()
          .getAttribute("href"))!.slice(1);
        await page.evaluate(
          (id) => document.getElementById(id)?.scrollIntoView(),
          first,
        );
        const item = nav.locator("li:has(a[aria-current='location'])");
        await expect(item).toHaveCount(1, { timeout: 10_000 });
        await expect
          .poll(() =>
            item.evaluate((el) => getComputedStyle(el).borderLeftColor),
          )
          .not.toBe("rgba(0, 0, 0, 0)");
        expect(
          await item.evaluate((el) => getComputedStyle(el).borderLeftWidth),
        ).toBe("2px");
      });

      test("読了バー: 2px・aria-hidden・brand.blue.500 で、記事を読み進めた分だけ伸びる", async ({
        page,
      }) => {
        await open(page, ARTICLE!);
        const bar = page.locator("[data-reading-progress]");
        await expect(bar).toHaveAttribute("aria-hidden", "true");
        const box = await bar.boundingBox();
        expect(box?.height).toBe(2);
        expect(box?.y).toBe(0);
        // 色はトークン（brand.blue.500）から
        const colors = await bar.evaluate((el) => {
          const probe = document.createElement("span");
          probe.style.color = "var(--color-brand-blue-500)";
          document.body.appendChild(probe);
          const token = getComputedStyle(probe).color;
          probe.remove();
          return { bar: getComputedStyle(el).backgroundColor, token };
        });
        expect(colors.bar).toBe(colors.token);

        const scale = () =>
          bar.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
        // 記事の上端が画面の上端に着いたところを 0、記事の下端が画面の下端に着いたところを 1 とした、いまの読み進め（画像の読み込みで記事の高さが
        // 変わっても、測った時点の高さで比べる）
        const progress = () =>
          page.evaluate(() => {
            const el = document.querySelector("article:has([data-reading-progress])")!;
            const rect = el.getBoundingClientRect();
            const span = rect.height - window.innerHeight;
            return Math.min(1, Math.max(0, -rect.top / span));
          });
        const scrollTo = (fraction: number) =>
          page.evaluate((f) => {
            const el = document.querySelector("article:has([data-reading-progress])")!;
            const rect = el.getBoundingClientRect();
            const span = rect.height - window.innerHeight;
            window.scrollTo(0, rect.top + window.scrollY + span * f);
            return span;
          }, fraction);
        expect(await scrollTo(0), "記事は画面より長い").toBeGreaterThan(0);
        await expect.poll(scale).toBeCloseTo(0, 2);
        // 途中: バーの伸びは、記事の範囲での読み進めと一致する
        await scrollTo(0.5);
        await expect
          .poll(async () => Math.abs((await scale()) - (await progress())), {
            timeout: 10_000,
          })
          .toBeLessThan(0.03);
        expect(await scale(), "途中では 0 でも 1 でもない").toBeGreaterThan(0.2);
        expect(await scale()).toBeLessThan(0.8);
        // 記事の下端: ほぼ 1
        await scrollTo(1);
        await expect
          .poll(async () => Math.abs((await scale()) - (await progress())), {
            timeout: 10_000,
          })
          .toBeLessThan(0.03);
        expect(await scale()).toBeGreaterThan(0.9);
      });

      test("読了バーでレイアウトはずれない（motion の CLS 0.01 未満）", async ({
        page,
      }) => {
        await open(page, ARTICLE!);
        await page.evaluate(() =>
          window.scrollTo(0, document.body.scrollHeight / 3),
        );
        await page.waitForTimeout(300);
        expect((await cls(page)).motion).toBeLessThan(0.01);
      });
    });

    test.describe("異常系", () => {
      test("入力: reduced-motion では読了バーを出さない", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await open(page, ARTICLE!);
        await expect(page.locator("[data-reading-progress]")).toBeHidden();
      });

      test("入力: JS が無くても目次は今までどおりのリンクの並び（印は付かない）", async ({
        browser,
      }) => {
        const context = await browser.newContext({ javaScriptEnabled: false });
        const page = await context.newPage();
        await page.goto(ARTICLE!);
        // Mobile では目次が閉じた details の中なので、見えるかどうかでなく DOM のリンクの数で見る
        const nav = page.locator("nav[data-toc-track]").first();
        expect(await nav.locator("a").count()).toBeGreaterThan(1);
        expect(await page.locator("[aria-current='location']").count()).toBe(0);
        await context.close();
      });

      test("入力: 規約（C）の目次には aria-current が付かず、追跡の JS も読まない", async ({
        page,
      }) => {
        const scripts: string[] = [];
        page.on("request", (request) => {
          if (request.resourceType() === "script") scripts.push(request.url());
        });
        await open(page, "/legal/privacy/");
        expect(await page.locator("[data-toc-track]").count()).toBe(0);
        const ids = await page
          .locator("nav a[href^='#']")
          .evaluateAll((els) =>
            els.map((el) => (el.getAttribute("href") ?? "").slice(1)),
          );
        expect(ids.length).toBeGreaterThan(1);
        for (const id of [ids[0], ids.at(-1)!]) {
          await page.evaluate(
            (target) => document.getElementById(target)?.scrollIntoView(),
            id,
          );
          await page.waitForTimeout(300);
          expect(await page.locator("[aria-current='location']").count()).toBe(
            0,
          );
        }
        expect(scripts.filter((url) => /TocTracker|CountUp/.test(url))).toEqual(
          [],
        );
        // C には動きの部品がない
        expect(
          await page
            .locator("[data-reveal], [data-count-up], [data-reading-progress]")
            .count(),
        ).toBe(0);
      });
    });
  });

  test.describe("reduced-motion（rAF）", () => {
    test.describe("異常系", () => {
      for (const route of [
        "/pricing/",
        "/about/",
        "/blog/",
        "/contact/",
        "/contact/thanks/",
        "/accessibility/",
      ]) {
        test(`入力: ${route} は reduced-motion で rAF の増分が 0（MotionBlobs を含む）`, async ({
          page,
        }) => {
          await page.emulateMedia({ reducedMotion: "reduce" });
          await open(page, route);
          // CTA の MotionBlobs（client:visible）を画面に入れて水和させる
          // MotionBlobs は md 以上だけ（Mobile では hidden）。見えるときだけ画面に入れて水和させる
          const blobs = page.locator('[data-motion="blobs"]').first();
          if (await blobs.isVisible()) {
            await blobs.scrollIntoViewIfNeeded();
            await settle(page, '[data-motion="blobs"]');
          }
          // 一時停止のボタンは出ない（動かないため）
          expect(
            await page
              .locator("aside")
              .getByRole("button", { name: new RegExp(MOTION_PAUSE.pause) })
              .count(),
          ).toBe(0);
          expect(await rafDuring(page, 1_500), route).toBe(0);
        });
      }

      test("入力: ブログ記事は reduced-motion で rAF の増分が 0", async ({
        page,
      }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await open(page, ARTICLE!);
        const blobs = page.locator('[data-motion="blobs"]').first();
        if (await blobs.isVisible()) {
          await blobs.scrollIntoViewIfNeeded();
          await settle(page, '[data-motion="blobs"]');
        }
        expect(await rafDuring(page, 1_500)).toBe(0);
      });
    });
  });

  test.describe("B の CTA（MotionBlobs）", () => {
    test.describe("正常系", () => {
      test("/pricing/: 一時停止のボタンは 1 つ（MotionBlobs の自前）で、CtaGlow は無い。止めると粒の rAF が止まる", async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, "/pricing/");
        const blobs = page.locator('[data-motion="blobs"]').first();
        await blobs.scrollIntoViewIfNeeded();
        await settle(page, '[data-motion="blobs"]');
        const banner = page.locator("aside:has([data-motion='blobs'])");
        const pause = banner.getByRole("button", {
          name: pauseName(MOTION_PAUSE.pause, MOTION_PAUSE_TARGETS.cta),
        });
        await expect(pause).toBeVisible({ timeout: 10_000 });
        expect(await banner.getByRole("button").count()).toBe(1);
        expect(await page.locator('[data-motion="cta-glow"]').count()).toBe(0);
        expect(await rafDuring(page, 1_000), "動いている間").toBeGreaterThan(0);
        await pause.focus();
        await page.keyboard.press("Enter");
        await expect(
          banner.getByRole("button", {
            name: pauseName(MOTION_PAUSE.resume, MOTION_PAUSE_TARGETS.cta),
          }),
        ).toBeVisible();
        expect(await rafDuring(page, 1_500), "止めた後").toBe(0);
      });
    });
  });
});

// A（vivid）の CTA の光の縁と粒（CtaGlow）。判断 R1: 一時停止のボタンは CtaGlow の 1 つだけ。
test.describe("A の CTA（CtaGlow）", () => {
  test.beforeEach(async ({ page }) => instrument(page));
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        sessionStorage.setItem("motion:diorama", "paused");
      } catch {}
    });
  });

  const A_CTA_ROUTES = ["/", "/services/", "/services/development/"];

  test.describe("正常系", () => {
    for (const route of A_CTA_ROUTES) {
      test(`${route}: 光の縁は 1 周 --motion-duration-glow、粒は 1 秒以上の周期。装飾は aria-hidden。ボタンは 1 つ`, async ({
        page,
      }, testInfo) => {
        desktopOnly(testInfo.project.name);
        await open(page, route);
        const glow = page.locator('[data-motion="cta-glow"]');
        expect(await glow.count()).toBe(1);
        const banner = page.locator("aside:has([data-motion='cta-glow'])");
        await banner.scrollIntoViewIfNeeded();
        // 止める手段のボタンが水和して出るまで動かない（ready の印）
        await expect(banner).toHaveAttribute("data-motion-ready", "true", {
          timeout: 10_000,
        });
        expect(
          await glow.locator("> [aria-hidden='true']").count(),
          "装飾の層は aria-hidden",
        ).toBe(1);
        const pause = banner.getByRole("button", {
          name: pauseName(MOTION_PAUSE.pause, MOTION_PAUSE_TARGETS.cta),
        });
        await expect(pause).toBeVisible();
        expect(await banner.getByRole("button").count(), "ボタンは 1 つ").toBe(
          1,
        );

        const timing = await glow.evaluate((root) => {
          const list = document
            .getAnimations()
            .filter(
              (a) =>
                a.effect?.getComputedTiming().iterations === Infinity &&
                root.contains((a.effect as KeyframeEffect).target),
            );
          const edge = list.find((a) =>
            (a.effect as KeyframeEffect).target?.classList.contains(
              "cta-glow__edge",
            ),
          );
          const sparkles = list.filter((a) =>
            (a.effect as KeyframeEffect).target?.classList.contains(
              "cta-glow__sparkle",
            ),
          );
          return {
            edge: Number(edge?.effect?.getComputedTiming().duration),
            sparkles: sparkles.map((a) =>
              Number(a.effect?.getComputedTiming().duration),
            ),
            running: list.filter((a) => a.playState === "running").length,
          };
        });
        expect(timing.edge).toBe(2400);
        expect(timing.sparkles.length).toBeGreaterThanOrEqual(6);
        expect(Math.min(...timing.sparkles)).toBeGreaterThanOrEqual(2400);
        expect(timing.running).toBe(timing.sparkles.length + 1);
      });
    }

    test("/: 1 つのボタンで光の縁・粒・MotionBlobs の粒がまとめて止まり、再開で動く。ページを移っても止まったまま", async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      await open(page, "/");
      const banner = page.locator("aside:has([data-motion='cta-glow'])");
      await banner.scrollIntoViewIfNeeded();
      await settle(page, '[data-motion="blobs"]');
      await expect(banner).toHaveAttribute("data-motion-ready", "true");
      expect(await banner.getByRole("button").count()).toBe(1);
      expect(
        (await animationCounts(page, '[data-motion="cta-glow"]')).running,
        "光の縁・粒が動いている",
      ).toBeGreaterThan(0);
      expect(
        await rafDuring(page, 1_000),
        "MotionBlobs が動いている",
      ).toBeGreaterThan(0);

      const pause = banner.getByRole("button", {
        name: pauseName(MOTION_PAUSE.pause, MOTION_PAUSE_TARGETS.cta),
      });
      await pause.focus();
      await page.keyboard.press("Enter");
      await expect(banner).toHaveAttribute("data-motion-paused", "true");
      expect(
        await page.evaluate(() => sessionStorage.getItem("motion:cta-blobs")),
      ).toBe("paused");
      expect(
        (await animationCounts(page, '[data-motion="cta-glow"]')).running,
        "光の縁・粒が止まった",
      ).toBe(0);
      expect(await rafDuring(page, 1_500), "粒（MotionBlobs）も止まった").toBe(
        0,
      );

      // ページを移って戻っても止まったまま
      await open(page, "/about/");
      await open(page, "/");
      await banner.scrollIntoViewIfNeeded();
      await settle(page, '[data-motion="blobs"]');
      await expect(
        banner.getByRole("button", {
          name: pauseName(MOTION_PAUSE.resume, MOTION_PAUSE_TARGETS.cta),
        }),
      ).toBeVisible();
      expect(
        (await animationCounts(page, '[data-motion="cta-glow"]')).running,
      ).toBe(0);
      expect(await rafDuring(page, 1_500), "ページを移った後").toBe(0);

      // 再開すると両方が動く
      await banner
        .getByRole("button", {
          name: pauseName(MOTION_PAUSE.resume, MOTION_PAUSE_TARGETS.cta),
        })
        .click();
      await expect(banner).toHaveAttribute("data-motion-paused", "false");
      await expect
        .poll(
          async () =>
            (await animationCounts(page, '[data-motion="cta-glow"]')).running,
        )
        .toBeGreaterThan(0);
      expect(await rafDuring(page, 1_000), "再開した後").toBeGreaterThan(0);
    });

    test("/services/: 光の縁と粒は、止める手段のボタンが出てから動き、押すと止まる", async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      await open(page, "/services/");
      const banner = page.locator("aside:has([data-motion='cta-glow'])");
      await banner.scrollIntoViewIfNeeded();
      await expect(banner).toHaveAttribute("data-motion-ready", "true", {
        timeout: 10_000,
      });
      await banner
        .getByRole("button", {
          name: pauseName(MOTION_PAUSE.pause, MOTION_PAUSE_TARGETS.cta),
        })
        .click();
      expect(
        (await animationCounts(page, '[data-motion="cta-glow"]')).running,
      ).toBe(0);
    });

    test("Tab でボタンに届き、フォーカスリングが見える", async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      await open(page, "/");
      const banner = page.locator("aside:has([data-motion='cta-glow'])");
      await banner.scrollIntoViewIfNeeded();
      await expect(banner).toHaveAttribute("data-motion-ready", "true");
      const pause = banner.getByRole("button", { name: /動きを止める/ });
      // CTA のリンクから Tab を 1 回押すと、一時停止のボタンに着く（DOM の順で CTA の後）
      await banner.getByRole("link").first().focus();
      await page.keyboard.press("Tab");
      await expect(pause).toBeFocused();
      const outline = await pause.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          style: style.outlineStyle,
          width: Number.parseFloat(style.outlineWidth),
          shadow: style.boxShadow,
        };
      });
      expect(
        (outline.style !== "none" && outline.width > 0) ||
          outline.shadow !== "none",
      ).toBe(true);
    });
  });

  test.describe("異常系", () => {
    test("入力: 止める手段（一時停止のボタン）が水和しないうちは、光の縁・粒だけでなく MotionBlobs の粒（rAF）も動かさない", async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      // 一時停止のボタンの island の JS を止めて、aside に data-motion-ready が付かない状態を作る
      await page.route(/PauseToggle.*\.js/, (route) => route.abort());
      await page.goto("/", { waitUntil: "load" });
      const banner = page.locator("aside:has([data-motion='cta-glow'])");
      await banner.scrollIntoViewIfNeeded();
      await settle(page, '[data-motion="blobs"]');
      await expect(banner).not.toHaveAttribute("data-motion-ready", "true");
      expect(
        await page
          .locator(".cta-glow__live")
          .evaluate((el) => getComputedStyle(el).visibility),
      ).toBe("hidden");
      expect(await rafDuring(page, 1_500), "MotionBlobs は動かない").toBe(0);
    });

    test("入力: Mobile でも光の縁と粒が動き、一時停止のボタンが CTA のボタンと重ならない（2026-10-20 から。05-motion-spec.md §8.4）", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "mobile", "Mobile だけ");
      await open(page, "/");
      const banner = page.locator("aside:has([data-motion='cta-glow'])");
      await banner.scrollIntoViewIfNeeded();
      const pause = banner.getByRole("button", { name: /動きを止める/ });
      await expect(pause).toBeVisible({ timeout: 5_000 });
      expect(
        await page.locator(".cta-glow__live").evaluate((el) => getComputedStyle(el).display),
      ).toBe("block");
      await expect
        .poll(async () => (await animationCounts(page, '[data-motion="cta-glow"]')).running)
        .toBeGreaterThan(0);
      const cta = (await banner.locator("[data-cta-id]").first().boundingBox())!;
      const button = (await pause.boundingBox())!;
      expect(button.y, "一時停止のボタンは CTA の下").toBeGreaterThanOrEqual(cta.y + cta.height);
      const box = (await banner.boundingBox())!;
      expect(button.y + button.height, "バナーの中").toBeLessThanOrEqual(box.y + box.height);
      // MotionBlobs（粒の寄り合い）は Mobile では出さない（MO-6 のまま）
      expect(await rafDuring(page, 1_000), "MotionBlobs は動かない").toBe(0);
    });

    test("入力: reduced-motion では動かず、ボタンも出ない", async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await open(page, "/");
      const banner = page.locator("aside:has([data-motion='cta-glow'])");
      await banner.scrollIntoViewIfNeeded();
      await settle(page, '[data-motion="blobs"]');
      expect(
        await page
          .locator(".cta-glow__live")
          .evaluate((el) => getComputedStyle(el).display),
      ).toBe("none");
      expect(
        (await animationCounts(page, '[data-motion="cta-glow"]')).running,
      ).toBe(0);
      expect(
        await banner.getByRole("button", { name: /動きを止める/ }).count(),
      ).toBe(0);
      expect(await rafDuring(page, 1_500)).toBe(0);
    });

    test("入力: JS が無ければ出さない（止める手段が無いまま動かさない。2.2.2）", async ({
      browser,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      const context = await browser.newContext({
        javaScriptEnabled: false,
        viewport: { width: 1440, height: 900 },
      });
      const page = await context.newPage();
      await page.goto("/");
      expect(
        await page
          .locator(".cta-glow__live")
          .evaluate((el) => getComputedStyle(el).display),
      ).toBe("none");
      expect(
        await page.locator('[data-motion="cta-glow"] button').count(),
      ).toBe(0);
      await context.close();
    });

    test("入力: 動く層の中の animation はすべて装飾（aria-hidden）で、フォーカスを受ける要素が無い", async ({
      page,
    }, testInfo) => {
      desktopOnly(testInfo.project.name);
      await open(page, "/");
      const focusable = await page
        .locator(".cta-glow__live")
        .evaluate(
          (el) =>
            el.querySelectorAll(
              "a, button, input, select, textarea, [tabindex]",
            ).length,
        );
      expect(focusable).toBe(0);
    });
  });
});
