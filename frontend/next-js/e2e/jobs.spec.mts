// 定期実行のジョブ（定義はサンドボックスの承認済み main の ops/schedules/*.yaml。sandbox.mjs が作る）。
// 一覧 → 詳細 → 手動で起動 → 実行の詳細 → ジョブの詳細の実行記録、までを画面だけで通す。
import { asAdmin, expect, openHydrated, test } from "./support/fixtures.mjs";
import { AGENT, AGENT_JOB_IO, AGENT_JOB_OVERVIEW, JOBS } from "./support/sandbox.mjs";

test.use(asAdmin);

test.describe("定期実行のジョブ", () => {
  test.describe("正常系", () => {
    test("一覧に main の定義がすべて出て、有効・無効と種類がわかる", async ({ page }) => {
      await page.goto("/jobs");
      await expect(page.getByRole("heading", { level: 1, name: /定期実行のジョブ/ })).toBeVisible();
      const table = page.getByRole("table");
      for (const id of Object.values(JOBS)) await expect(table.getByRole("link", { name: id, exact: true })).toBeVisible();
      await expect(table.getByRole("row").filter({ hasText: JOBS.heartbeat })).toContainText("*/5 * * * *");
    });

    test("ジョブの詳細から手動で起動すると、その定義を選んだ状態で起動でき、見送りの理由が実行の詳細とジョブの記録に出る", async ({ page }) => {
      await openHydrated(page, "/jobs");
      await page.getByRole("link", { name: JOBS.published, exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: JOBS.published })).toBeVisible();

      await page.getByRole("link", { name: "手動で起動" }).click();
      await expect(page).toHaveURL(new RegExp(`/runs/new\\?jobId=${JOBS.published}$`));
      await openHydrated(page);
      await page.getByRole("button", { name: "起動する" }).click();

      // published-article-check は未実装の雛形で、実行すると見送り（skipped）で終わる
      await expect(page).toHaveURL(/\/runs\/[0-9A-HJKMNP-TV-Z]{26}$/);
      await expect(page.getByText("見送り").first()).toBeVisible();
      await expect(page.getByText("公開された記事の確認は未実装のため見送った").first()).toBeVisible();
      const runId = page.url().split("/").at(-1)!;

      await page.getByRole("link", { name: new RegExp(`^${JOBS.published}`) }).first().click();
      await expect(page).toHaveURL(new RegExp(`/jobs/${JOBS.published}$`));
      await expect(page.getByRole("link", { name: runId })).toBeVisible();
    });
  });

  test.describe("正常系（概要・入出力・Agent）", () => {
    test("Agent のジョブの詳細に概要・段階・入出力・Agent へのリンクと指示が出る", async ({ page }) => {
      await openHydrated(page, `/jobs/${JOBS.agent}`);
      await expect(page.getByRole("heading", { level: 1, name: JOBS.agent })).toBeVisible();
      await expect(page.getByText(AGENT_JOB_OVERVIEW)).toBeVisible();
      await expect(page.getByText("改善ループの中の段階:")).toContainText("観測");
      for (const text of Object.values(AGENT_JOB_IO)) await expect(page.getByText(text, { exact: true })).toBeVisible();
      await page.getByText("Agent への指示（yaml の prompt）を見る").click();
      await expect(page.getByText("E2E の確認です。何もしないでください。")).toBeVisible();
      await page.getByRole("link", { name: AGENT, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/agents/${AGENT}$`));
    });

    test("overview の無いジョブは（定義に書かれていない）と出て、一覧の段階も同じ", async ({ page }) => {
      await page.goto(`/jobs/${JOBS.published}`);
      await expect(page.getByRole("heading", { level: 1, name: JOBS.published })).toBeVisible();
      await expect(page.getByText("（定義に書かれていない）").first()).toBeVisible();
      await page.goto("/jobs");
      await expect(page.getByRole("row").filter({ hasText: JOBS.published })).toContainText("（定義に書かれていない）");
      await expect(page.getByRole("row").filter({ hasText: JOBS.agent })).toContainText("観測");
    });
  });

  test.describe("異常系", () => {
    test("入力: 起動の前に必要な設定（AWS）が無いジョブは、起動せずに見送りの記録を残し、足りない変数の名前を出す", async ({ page }) => {
      await openHydrated(page, `/runs/new?jobId=${JOBS.heartbeat}`);
      await page.getByRole("button", { name: "起動する" }).click();
      await expect(page).toHaveURL(/\/runs\/[0-9A-HJKMNP-TV-Z]{26}$/);
      await expect(page.getByText("設定が無いため見送った（AWS_REGION, RUNLOG_BUCKET）").first()).toBeVisible();
    });

    test("入力: 存在しないジョブの詳細は 404 になる", async ({ page }) => {
      const response = await page.goto("/jobs/e2e-no-such-job");
      expect(response?.status()).toBe(404);
    });
  });
});
