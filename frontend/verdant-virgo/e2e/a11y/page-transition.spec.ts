// ページ移動の形のつながり（文書間の View Transitions。page-transition モジュール）の検査。計画書の Task 8。
//   - 遷移元: pageswap で、押したカードの [data-morph] にだけ view-transition-name を付ける（1 ページに同じ名前を 2 つ作らない）
//   - 遷移先: サービス詳細の h1・記事の h1 とアイキャッチ・お問い合わせの h1 が、名前を静的に持つ
//   - C のページ（規約・ポリシー）は opt-in しない。入るとき・出るときに遷移が起きない（pagereveal の viewTransition が null）
//   - reduced-motion では ::view-transition-* の animation が none（global.css の既存の規則）
// 文書間の View Transitions は Chromium だけが対応しているので、Desktop の Chromium だけで回す。
// pageswap の後はページが替わるので、計数は sessionStorage（同じオリジン）に書いて、次のページで読む。
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { open } from "./axe";
import { distRoutes } from "./routes";

const SWAP_KEY = "__e2eVtSwap";
// 記事の関連記事のカード（8-9）
const RELATED_CARD =
  'section[aria-labelledby="article-related"] [data-morph-source]';
const REVEAL_KEY = "__e2eVtReveal";

type SwapRecord = {
  named: string[];
  duplicates: string[];
  /** 名前が付いた要素の data-cta-id（CTA でなければ空文字） */
  namedCtaIds: string[];
  /** 同じ名前を避けるために名前を none にした要素（[data-vt-cleared]）の数 */
  cleared: number;
};
type RevealRecord = {
  path: string;
  transition: boolean;
  vtAnimations: number;
  /** pagereveal で page-transition が名前を付けた要素（[data-vt-set]）の名前。遷移の準備ができた時点 */
  named: string[];
};

/** 1 ページの中の view-transition-name（none・auto 以外）の一覧（computed）。DOM の順 */
const computedNamesScript = () =>
  [...document.querySelectorAll<HTMLElement>("*")]
    .map((el) => getComputedStyle(el).viewTransitionName)
    .filter((name) => name && name !== "none" && name !== "auto");

/**
 * 遷移先の pagereveal を見張る（ページの読み込みの前に入れる）。
 * viewTransition の有無と、遷移の準備ができた時点の ::view-transition-* の animation の数を sessionStorage に書く。
 */
async function watchReveal(page: Page) {
  await page.addInitScript((key) => {
    window.addEventListener("pagereveal", (event) => {
      const transition = (
        event as Event & { viewTransition: ViewTransition | null }
      ).viewTransition;
      const write = (vtAnimations: number) =>
        sessionStorage.setItem(
          key,
          JSON.stringify({
            path: location.pathname,
            transition: !!transition,
            vtAnimations,
            named: [...document.querySelectorAll<HTMLElement>("[data-vt-set]")].map(
              (el) => el.style.viewTransitionName,
            ),
          }),
        );
      write(-1);
      if (!transition) return;
      transition.ready
        .then(() => {
          const count = document
            .getAnimations()
            .filter((a) =>
              (
                (a.effect as KeyframeEffect | null)?.pseudoElement ?? ""
              ).startsWith("::view-transition"),
            ).length;
          write(count);
        })
        .catch(() => {});
    });
  }, REVEAL_KEY);
}

/**
 * 遷移元の pageswap を見張る。page-transition の pageswap（module の script）より後に登録するため、読み込みの後に入れる。
 * 名前を付けた要素（inline の style に view-transition-name を持つもの）の名前と、computed の名前の重複を sessionStorage に書く。
 */
async function watchSwap(page: Page) {
  await page.evaluate((key) => {
    window.addEventListener("pageswap", () => {
      const namedEls = [
        ...document.querySelectorAll<HTMLElement>(
          '[style*="view-transition-name"]',
        ),
      ].filter((el) => el.style.viewTransitionName && el.style.viewTransitionName !== "none");
      const named = namedEls.map((el) => el.style.viewTransitionName);
      const namedCtaIds = namedEls.map((el) => el.getAttribute("data-cta-id") ?? "");
      const cleared = document.querySelectorAll("[data-vt-cleared]").length;
      const all = [...document.querySelectorAll<HTMLElement>("*")]
        .map((el) => getComputedStyle(el).viewTransitionName)
        .filter((name) => name && name !== "none" && name !== "auto");
      const duplicates = [
        ...new Set(all.filter((name, i) => all.indexOf(name) !== i)),
      ];
      sessionStorage.setItem(
        key,
        JSON.stringify({ named, duplicates, namedCtaIds, cleared }),
      );
    });
  }, SWAP_KEY);
}

const readSession = <T>(page: Page, key: string) =>
  page.evaluate((k) => {
    const raw = sessionStorage.getItem(k);
    return raw ? JSON.parse(raw) : null;
  }, key) as Promise<T | null>;

/** 同意バナーを閉じる（下端に固定で、カードのリンクに重なることがある） */
const hideConsent = (page: Page) =>
  page.evaluate(() =>
    document.getElementById("cookie-banner")?.setAttribute("hidden", ""),
  );

/** リンクを押して、遷移先の読み込みを待つ */
async function follow(
  page: Page,
  link: ReturnType<Page["locator"]>,
  to: RegExp,
) {
  await link.scrollIntoViewIfNeeded();
  await Promise.all([page.waitForURL(to, { waitUntil: "load" }), link.click()]);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

test.describe("ページ移動の形のつながり", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "文書間の View Transitions は Desktop の Chromium だけで確かめる",
    );
    // A のページ（WebGL の地球儀・背景）を開いてから移るので、全ルートの検査と並ぶと 30 秒を超えることがある
    testInfo.setTimeout(60_000);
  });

  test.describe("正常系", () => {
    test("/services/ で「詳しく見る」を押すと、押したカードの見出しにだけ名前が付き（1 つ）、詳細の h1 が vt-service-title を持つ", async ({
      page,
    }) => {
      await watchReveal(page);
      await open(page, "/services/");
      await hideConsent(page);
      await watchSwap(page);
      const link = page
        .locator('[data-morph-source] a[href="/services/development"]')
        .first();
      await follow(page, link, /\/services\/development\/?$/);

      const swap = await readSession<SwapRecord>(page, SWAP_KEY);
      expect(swap?.named).toEqual(["vt-service-title"]);
      expect(swap?.duplicates).toEqual([]);

      const h1Name = await page
        .locator("h1")
        .evaluate((el) => getComputedStyle(el).viewTransitionName);
      expect(h1Name).toBe("vt-service-title");
      // B〜A どうしの移動では遷移が起きていて、::view-transition-* が動く（C と reduced-motion の検査の対照）
      await expect
        .poll(
          async () =>
            (await readSession<RevealRecord>(page, REVEAL_KEY))?.vtAnimations,
        )
        .toBeGreaterThan(0);
      expect(
        (await readSession<RevealRecord>(page, REVEAL_KEY))?.transition,
      ).toBe(true);
    });

    test("詳細から一覧へ戻ると、pagereveal（head の inline script）が一覧のそのカードの見出しに名前を付ける", async ({
      page,
    }) => {
      await watchReveal(page);
      await open(page, "/services/");
      await hideConsent(page);
      await follow(
        page,
        page.locator('[data-morph-source] a[href="/services/development"]').first(),
        /\/services\/development\/?$/,
      );
      await Promise.all([page.waitForURL(/\/services\/?$/), page.goBack()]);
      await expect
        .poll(async () => (await readSession<RevealRecord>(page, REVEAL_KEY))?.vtAnimations)
        .toBeGreaterThan(0);
      const reveal = await readSession<RevealRecord>(page, REVEAL_KEY);
      expect(reveal?.path).toMatch(/^\/services\/?$/);
      expect(reveal?.named[0]).toBe("vt-service-title");
      // 遷移が終わると名前を外す（次の移動で取り合わない）
      await expect.poll(() => page.locator("[data-vt-set]").count()).toBe(0);
    });

    test("1 ページの中で、同じ view-transition-name を持つ要素が 2 つ以上ない（全ルート）", async ({
      page,
    }) => {
      test.setTimeout(120_000);
      for (const route of distRoutes()) {
        await page.goto(route, { waitUntil: "load" });
        const names = await page.evaluate(computedNamesScript);
        const duplicates = [
          ...new Set(names.filter((name, i) => names.indexOf(name) !== i)),
        ];
        expect(duplicates, `${route} の重複`).toEqual([]);
      }
    });

    test("記事から関連記事の記事へ移るとき（無ければサービス詳細から別のサービスへ）、名前が重複しない", async ({
      page,
    }) => {
      await watchReveal(page);
      const article = distRoutes().find((route) =>
        /^\/blog\/(?!category\/|page\/)[^/]+\/$/.test(route),
      );
      let related = 0;
      if (article) {
        await open(page, article);
        related = await page.locator(RELATED_CARD).count();
      }
      if (article && related > 0) {
        await hideConsent(page);
        await watchSwap(page);
        const link = page.locator(`${RELATED_CARD} a[href]`).first();
        const href = (await link.getAttribute("href")) ?? "";
        await follow(page, link, new RegExp(`${href.replace(/\/$/, "")}/?$`));
        const swap = await readSession<SwapRecord>(page, SWAP_KEY);
        // 移動元の記事の h1・アイキャッチは名前を外し、押したカードの見出しと画像にだけ付ける
        expect(swap?.named).toEqual(["vt-article-media", "vt-article-title"]);
        expect(swap?.duplicates).toEqual([]);
      } else {
        await open(page, "/services/development/");
        await hideConsent(page);
        await watchSwap(page);
        // 詳細のページには別のサービスへのカードが無いので、名前は付かず、静的な h1 の 1 つだけ
        await page.evaluate(() => {
          location.href = "/services/consulting/";
        });
        await page.waitForURL(/\/services\/consulting\/?$/, {
          waitUntil: "load",
        });
        const swap = await readSession<SwapRecord>(page, SWAP_KEY);
        expect(swap?.duplicates).toEqual([]);
      }
      const names = await page.evaluate(computedNamesScript);
      expect([
        ...new Set(names.filter((name, i) => names.indexOf(name) !== i)),
      ]).toEqual([]);
    });
  });

  test.describe("正常系（お問い合わせの CTA）", () => {
    const HEADER_CTA = 'header a[data-cta-id="consult_global_header"]';

    test("/services/ でヘッダーの CTA を押すと、押したボタン 1 つにだけ vt-contact-title が付き、お問い合わせの h1 が同じ名前を持つ", async ({
      page,
    }) => {
      await open(page, "/services/");
      await hideConsent(page);
      await watchSwap(page);
      await follow(page, page.locator(HEADER_CTA), /\/contact\/?\?/);

      const swap = await readSession<SwapRecord>(page, SWAP_KEY);
      expect(swap?.named).toEqual(["vt-contact-title"]);
      expect(swap?.namedCtaIds).toEqual(["consult_global_header"]);
      expect(swap?.duplicates).toEqual([]);
      const h1Name = await page
        .locator("h1")
        .evaluate((el) => getComputedStyle(el).viewTransitionName);
      expect(h1Name).toBe("vt-contact-title");
    });

    test("/contact/ で同じ CTA を押すと（自分自身へ移る）、静的な h1 の名前が外れ、ボタンにだけ付く", async ({
      page,
    }) => {
      await open(page, "/contact/");
      await hideConsent(page);
      await watchSwap(page);
      await follow(page, page.locator(HEADER_CTA), /\/contact\/?\?/);

      const swap = await readSession<SwapRecord>(page, SWAP_KEY);
      expect(swap?.named).toEqual(["vt-contact-title"]);
      expect(swap?.namedCtaIds).toEqual(["consult_global_header"]);
      // 静的に vt-contact-title を持つ h1 は none にした（1 つ）
      expect(swap?.cleared).toBe(1);
      expect(swap?.duplicates).toEqual([]);
    });
  });

  test.describe("異常系", () => {
    test("入力: C のページ（/legal/privacy/）へ入るときも、C から出るときも遷移が起きない", async ({
      page,
    }) => {
      await watchReveal(page);
      await open(page, "/");
      await hideConsent(page);
      // C へ入る
      await follow(
        page,
        page.locator('footer a[href^="/legal/privacy"]').first(),
        /\/legal\/privacy\/?$/,
      );
      const into = await readSession<RevealRecord>(page, REVEAL_KEY);
      expect(into?.path).toMatch(/^\/legal\/privacy\/?$/);
      expect(into?.transition).toBe(false);
      // C のページは opt-in していない（@view-transition も pagereveal の登録も無い）
      expect(
        await page
          .locator("script:not([src])")
          .evaluateAll((els) =>
            els.some((el) => el.textContent?.includes("installReveal")),
          ),
      ).toBe(false);
      // C から出る（B の料金へ）
      await follow(
        page,
        page.locator('footer a[href^="/pricing"]').first(),
        /\/pricing\/?$/,
      );
      const out = await readSession<RevealRecord>(page, REVEAL_KEY);
      expect(out?.path).toMatch(/^\/pricing\/?$/);
      expect(out?.transition).toBe(false);
    });

    test("入力: reduced-motion では ::view-transition-* の animation が none", async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await watchReveal(page);
      await open(page, "/services/");
      await hideConsent(page);
      await follow(
        page,
        page
          .locator('[data-morph-source] a[href="/services/development"]')
          .first(),
        /\/services\/development\/?$/,
      );
      await expect
        .poll(
          async () =>
            (await readSession<RevealRecord>(page, REVEAL_KEY))?.vtAnimations,
        )
        .toBe(0);
      const reveal = await readSession<RevealRecord>(page, REVEAL_KEY);
      expect(reveal?.transition).toBe(true);
    });
  });
});
