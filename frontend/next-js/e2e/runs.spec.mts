// 実行記録（E-15）と手動の起動。サンドボックスの E-15（実行のたびに空から作り直す）に、テストの中で記録を作って確かめる。
// エージェントの起動は ANTHROPIC_API_KEY が無いので、Agent SDK を呼ぶ前に「設定が無いため見送った」になる（Anthropic には届かない）。
import { asAdmin, expect, openHydrated, test } from "./support/fixtures.mjs";
import { cookieHeader, createSession } from "./support/auth.mjs";
import { runToCompletion, startRun, waitForRun } from "./support/api.mjs";
import { ADMIN_EMAIL, AGENT, JOBS } from "./support/sandbox.mjs";

test.use(asAdmin);

const RUN_URL = /\/runs\/[0-9A-HJKMNP-TV-Z]{26}$/;

test.describe("実行記録と手動の起動", () => {
  test.describe("正常系", () => {
    test("エージェントとプロンプトを指定して起動すると、実行の詳細へ移り、起動の種類と見送りの理由を出す", async ({ page }) => {
      await openHydrated(page, "/runs/new");
      await page.getByRole("textbox", { name: "エージェント名" }).fill(AGENT);
      await page.getByRole("textbox", { name: "プロンプト" }).fill("E2E の確認です。何もしないでください。");
      await page.getByRole("button", { name: "起動する" }).click();

      await expect(page).toHaveURL(RUN_URL);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(page.url().split("/").at(-1)!);
      await expect(page.getByText(`agent/${AGENT}`).first()).toBeVisible();
      await expect(page.getByText("設定が無いため見送った（ANTHROPIC_API_KEY）").first()).toBeVisible();
      await expect(page.getByText("手動", { exact: true })).toBeVisible();
    });

    test("一覧は新しい順で、状態で絞り込むと URL に条件が付き、その状態の記録だけを出す", async ({ page, request }) => {
      const cookie = cookieHeader(await createSession(ADMIN_EMAIL));
      // 成功（開発の Chatwoot を読む突き合わせ）と見送りを 1 件ずつ作る
      const success = await runToCompletion(request, cookie, { kind: "job", jobId: JOBS.miswrite });
      const skipped = await runToCompletion(request, cookie, { kind: "job", jobId: JOBS.published });
      expect([success.outcome, skipped.outcome]).toEqual(["success", "skipped"]);

      await openHydrated(page, "/runs");
      const table = page.getByRole("table");
      await expect(table.getByRole("link", { name: skipped.runId })).toBeVisible();
      // 新しい順（skipped を後に作った）
      const ids = await table.getByRole("link", { name: /^[0-9A-HJKMNP-TV-Z]{26}$/ }).allTextContents();
      expect(ids.indexOf(skipped.runId)).toBeLessThan(ids.indexOf(success.runId));

      await page.getByRole("button", { name: /状態で絞り込む/ }).click();
      await page.getByRole("option", { name: "見送り" }).click();
      await expect(page).toHaveURL(/\/runs\?outcome=skipped$/);
      await expect(table.getByRole("link", { name: skipped.runId })).toBeVisible();
      await expect(table.getByRole("link", { name: success.runId })).toHaveCount(0);
      const statuses = await table.getByRole("row").filter({ has: page.getByRole("link") }).allTextContents();
      for (const row of statuses) expect(row).toContain("見送り");
    });

    test("51 件を超えると「さらに古い記録」で前のページへさかのぼり、「最新に戻る」で戻れる", async ({ page, request }) => {
      test.setTimeout(180_000);
      const cookie = cookieHeader(await createSession(ADMIN_EMAIL));
      // テスト用データ: 見送りで終わる起動を 51 件（1 ページは 50 件）
      for (let i = 0; i < 51; i += 1) {
        const { runId } = await startRun(request, cookie, { kind: "job", jobId: JOBS.heartbeat });
        await waitForRun(request, cookie, runId);
      }

      await page.goto("/runs");
      await expect(page.getByText("最新のページです")).toBeVisible();
      await page.getByRole("link", { name: "さらに古い記録" }).click();
      await expect(page).toHaveURL(/\/runs\?before=[0-9A-HJKMNP-TV-Z]{26}$/);
      await expect(page.getByText("古い記録をさかのぼって表示しています")).toBeVisible();
      await page.getByRole("link", { name: "最新に戻る" }).click();
      await expect(page).toHaveURL(/\/runs$/);
    });
  });

  test.describe("異常系", () => {
    test("空入力: エージェント名かプロンプトが空のあいだは「起動する」を押せない", async ({ page }) => {
      await openHydrated(page, "/runs/new");
      const submit = page.getByRole("button", { name: "起動する" });
      await expect(submit).toBeDisabled();
      await page.getByRole("textbox", { name: "エージェント名" }).fill(AGENT);
      await expect(submit).toBeDisabled();
      await page.getByRole("textbox", { name: "プロンプト" }).fill("   ");
      await expect(submit).toBeDisabled();
    });

    test("入力: 形は正しいが存在しない相関 ID と、形の違う相関 ID の詳細は 404 になる", async ({ page }) => {
      expect((await page.goto("/runs/01K00000000000000000000000"))?.status()).toBe(404);
      expect((await page.goto("/runs/e2e-not-a-ulid"))?.status()).toBe(404);
    });

    test("入力: URL の状態の条件が一覧に無い値なら、絞り込まずに出す", async ({ page }) => {
      await page.goto("/runs?outcome=e2e-unknown");
      await expect(page.getByRole("heading", { level: 1, name: /実行記録/ })).toBeVisible();
      await expect(page.getByRole("button", { name: /すべての状態/ })).toBeVisible();
    });

    test("入力: API に形の違う起動の指示を送ると 400 を返す", async ({ request }) => {
      const cookie = cookieHeader(await createSession(ADMIN_EMAIL));
      const res = await request.post("/api/runs", {
        headers: { cookie, origin: "http://127.0.0.1:3201" },
        data: { target: { kind: "e2e-unknown" } },
      });
      expect(res.status()).toBe(400);
    });
  });
});
