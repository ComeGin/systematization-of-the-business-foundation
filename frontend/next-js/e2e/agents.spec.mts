// Agent の画面（定義はサンドボックスの承認済み main の .claude/agents/*.md と ops/mcp-registry.yaml。sandbox.mjs が作る）。
// メニュー → 一覧 → 詳細（接続先ごとのツールと参照／書き込み、使うジョブ、手順）までを画面だけで通す。
import { asAdmin, expect, openHydrated, test } from "./support/fixtures.mjs";
import { AGENT, JOBS } from "./support/sandbox.mjs";

test.use(asAdmin);

test.describe("Agent", () => {
  test.describe("正常系", () => {
    test("メニューから Agent の一覧へ行き、詳細で接続先ごとのツールと書き込みの印、使うジョブ、手順が出る", async ({ page }) => {
      await openHydrated(page, "/jobs");
      await page.getByRole("navigation").getByRole("link", { name: "Agent", exact: true }).click();
      await expect(page).toHaveURL(/\/agents$/);
      await expect(page.getByRole("heading", { level: 1, name: /Agent/ })).toBeVisible();
      const row = page.getByRole("row").filter({ hasText: AGENT });
      await expect(row).toContainText("E2E 用のエージェント（起動はしない）。");
      await expect(row).not.toContainText("2 文目");
      await expect(row).toContainText("1 本");

      await row.getByRole("link", { name: AGENT, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/agents/${AGENT}$`));
      await expect(page.getByRole("heading", { level: 1, name: AGENT })).toBeVisible();
      await expect(page.getByText("E2E 用のエージェント（起動はしない）。2 文目。")).toBeVisible();

      await expect(page.getByRole("heading", { name: "接続先とツール" })).toBeVisible();
      const tools = page.getByRole("main");
      await expect(tools.getByRole("heading", { name: /^e2e-prod/ })).toContainText("read_write");
      await expect(tools.getByRole("heading", { name: /^e2e-ro/ })).toContainText("read_only");
      await expect(tools.getByRole("listitem").filter({ hasText: "e2e_add_note" })).toContainText("書き込み");
      await expect(tools.getByRole("listitem").filter({ hasText: "e2e_list_items" })).toContainText("参照");
      // 登録表で read_only の接続先は、名前が run でも参照
      await expect(tools.getByRole("listitem").filter({ hasText: "e2e_run_report" })).toContainText("参照");
      await expect(tools.getByRole("listitem").filter({ hasText: /Write$/ })).toContainText("書き込み");

      await expect(page.getByRole("link", { name: JOBS.agent, exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "E2E の手順" })).toBeVisible();
    });
  });

  test.describe("異常系", () => {
    test("入力: 無い Agent と、名前の形でない URL は 404 になる", async ({ page }) => {
      expect((await page.goto("/agents/e2e-no-such-agent"))?.status()).toBe(404);
      expect((await page.goto("/agents/E2E_Bad"))?.status()).toBe(404);
    });
  });
});
