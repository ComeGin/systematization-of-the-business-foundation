// ブログ（I-09 Strapi → Astro）。global-setup.ts が開発の Strapi に作った記事（本物）が、一覧・カテゴリ・記事のページに出るか。
// dev サーバーは表示のたびに Strapi から取り直すので、作った記事は再起動なしで出る（blog/lib/articles.ts）。
import { expect, test } from "./support/fixtures";
import { BLOG_CATEGORIES } from "../../src/modules/blog/lib/categories";
import { blogArticle } from "../../src/modules/site-content/blog";

const category = (slug: string) =>
  BLOG_CATEGORIES.find((c) => c.slug === slug)!;

test.describe("ブログ", () => {
  test.describe("正常系", () => {
    test("一覧の先頭のページに、公開した 2 本が新しい順に出て、カードから記事へ移れる", async ({
      page,
      seed,
    }) => {
      await page.goto("/blog/");
      const main = page.getByRole("main");
      const adoption = main.getByRole("link", { name: seed.adoption.title });
      const issues = main.getByRole("link", { name: seed.issues.title });
      await expect(adoption).toBeVisible();
      await expect(issues).toBeVisible();
      // 後から公開した issues が先（publishedAt の新しい順）
      const titles = await main
        .getByRole("heading", { level: 2 })
        .allTextContents();
      expect(
        titles.findIndex((t) => t.includes(seed.issues.title)),
      ).toBeLessThan(titles.findIndex((t) => t.includes(seed.adoption.title)));

      await adoption.click();
      await expect(page).toHaveURL(
        new RegExp(`/blog/${seed.adoption.slug}/?$`),
      );
      await expect(
        page.getByRole("heading", { level: 1, name: seed.adoption.title }),
      ).toBeVisible();
      await expect(page.getByText(seed.adoption.paragraph)).toBeVisible();
      await expect(page.locator('meta[name="description"]')).toHaveAttribute(
        "content",
        seed.adoption.description,
      );
    });

    test("カテゴリのタブは、そのカテゴリの記事だけに絞る", async ({
      page,
      seed,
    }) => {
      await page.goto("/blog/");
      const tabs = page.getByRole("navigation", { name: "カテゴリ" });
      await tabs
        .getByRole("link", { name: category(seed.adoption.categorySlug).label })
        .click();
      await expect(page).toHaveURL(
        new RegExp(`/blog/category/${seed.adoption.categorySlug}/?$`),
      );
      await expect(
        tabs.getByRole("link", {
          name: category(seed.adoption.categorySlug).label,
        }),
      ).toHaveAttribute("aria-current", "page");

      const main = page.getByRole("main");
      await expect(
        main.getByRole("link", { name: seed.adoption.title }),
      ).toBeVisible();
      await expect(
        main.getByRole("link", { name: seed.issues.title }),
      ).toHaveCount(0);
    });

    test("顕在（導入を検討する）の記事は、記事中と記事末に無料相談の CTA を出す", async ({
      page,
      seed,
    }) => {
      await page.goto(`/blog/${seed.adoption.slug}/`);
      await expect(page.getByTestId("consult_article_inline")).toHaveText(
        blogArticle.inlineCta.consult.button,
      );
      await expect(page.getByTestId("consult_article_end")).toHaveText(
        blogArticle.endCta.consultBanner.button,
      );
      await expect(page.getByTestId("dl_article_inline")).toHaveCount(0);
    });

    test("潜在（課題を知る）の記事は、無料相談の CTA を出さず、無料 DL の CTA を出す", async ({
      page,
      seed,
    }) => {
      await page.goto(`/blog/${seed.issues.slug}/`);
      await expect(page.getByTestId("dl_article_inline")).toHaveText(
        blogArticle.inlineCta.sourceDownload.button,
      );
      await expect(page.getByTestId("consult_article_inline")).toHaveCount(0);
      await expect(page.getByTestId("consult_article_end")).toHaveCount(0);
    });
  });

  test.describe("異常系", () => {
    test("入力: 公開していない下書きは、一覧にもカテゴリにも出ず、URL を直接開いても 404 になる", async ({
      page,
      seed,
    }) => {
      await page.goto("/blog/");
      await expect(
        page.getByRole("main").getByRole("link", { name: seed.adoption.title }),
      ).toBeVisible();
      await expect(
        page.getByRole("main").getByRole("link", { name: seed.draft.title }),
      ).toHaveCount(0);

      await page.goto(`/blog/category/${seed.draft.categorySlug}/`);
      await expect(
        page.getByRole("main").getByRole("link", { name: seed.draft.title }),
      ).toHaveCount(0);

      const response = await page.goto(`/blog/${seed.draft.slug}/`);
      expect(response?.status()).toBe(404);
    });

    test("入力: 存在しない記事の slug は 404 になる", async ({
      page,
      seed,
    }) => {
      const response = await page.goto(`/blog/${seed.runId}-no-such-article/`);
      expect(response?.status()).toBe(404);
    });
  });
});
