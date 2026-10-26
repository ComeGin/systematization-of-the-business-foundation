// 監視アプリのログイン（ADR-23。Google〈Workspace〉だけ。許可リスト CONTROL_ADMIN_EMAILS）。
// Google の画面と、コールバックでのトークンの交換（サーバーが Google と通信する）はオンプレの外なので通さない:
//   - ログインの開始 … 「Google でログイン」で認可の画面へ向かう URL を、Google に届く前に止めて中身（hd・戻り先）を確かめる
//   - ログインの後   … サンドボックスの SQLite に本物の Better Auth で作ったセッションを Cookie として渡す（support/auth.mts）
import { asAdmin, expect, openHydrated, test } from "./support/fixtures.mjs";
import { cookieHeader, createSession, storageStateOf } from "./support/auth.mjs";
import { ADMIN_EMAIL, BASE_URL, GOOGLE_CLIENT_ID, JOBS, OUTSIDER_EMAIL } from "./support/sandbox.mjs";

test.describe("ログイン", () => {
  test.describe("正常系", () => {
    test("ログインしていなければ、コンソールのページはログインの画面に移る", async ({ page }) => {
      await page.goto("/runs");
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole("button", { name: "Google でログイン" })).toBeEnabled();
    });

    test("「Google でログイン」で、Workspace のドメイン（hd）と戻り先を付けて Google の認可の画面へ向かう（Google には届けない）", async ({
      page,
      traffic,
    }) => {
      await openHydrated(page, "/login");
      await page.getByRole("button", { name: "Google でログイン" }).click();
      await expect
        .poll(() => traffic.blocked.find((url) => new URL(url).hostname === "accounts.google.com"), { timeout: 30_000 })
        .toBeTruthy();

      const authorize = new URL(traffic.blocked.find((url) => new URL(url).hostname === "accounts.google.com")!);
      expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
        client_id: GOOGLE_CLIENT_ID,
        response_type: "code",
        hd: "comegin.com",
        prompt: "select_account",
        redirect_uri: `${BASE_URL}/api/auth/callback/google`,
      });
      expect(authorize.searchParams.get("state")).toBeTruthy();
    });

    test.describe("許可リストのアカウントでログイン済み", () => {
      test.use(asAdmin);

      test("/ は実行記録へ移り、上のバーにログイン中のユーザーを出す", async ({ page }) => {
        await page.goto("/");
        await expect(page).toHaveURL(/\/runs$/);
        await expect(page.getByRole("heading", { level: 1, name: /実行記録/ })).toBeVisible();
        await expect(page.getByRole("banner").getByRole("button", { name: ADMIN_EMAIL.split("@")[0] })).toBeVisible();
      });

      test("ログインの画面を開いても、ログイン済みなら / へ戻す", async ({ page }) => {
        await page.goto("/login");
        await expect(page).toHaveURL(/\/runs$/);
      });
    });

    test("ログアウトすると、ログインの画面に戻り、同じ Cookie ではもう入れない", async ({ browser }) => {
      // ほかのテストが使うセッションを消さないよう、このテストだけのセッションを作る
      const cookie = await createSession(ADMIN_EMAIL);
      const context = await browser.newContext({ storageState: storageStateOf(cookie) });
      const page = await context.newPage();
      await page.goto("/runs");
      await expect(page.getByRole("heading", { level: 1, name: /実行記録/ })).toBeVisible();

      await page.getByRole("button", { name: ADMIN_EMAIL.split("@")[0] }).click();
      await page.getByRole("menuitem", { name: "ログアウト" }).click();
      await expect(page).toHaveURL(/\/login$/);

      const res = await page.request.get("/api/runs", { headers: { cookie: cookieHeader(cookie) } });
      expect(res.status()).toBe(401);
      await context.close();
    });
  });

  test.describe("異常系", () => {
    test("入力: 許可リストに無いメールのセッションは、ページではログインの画面に戻され、そのまま失効する", async ({ browser }) => {
      const cookie = await createSession(OUTSIDER_EMAIL);
      const context = await browser.newContext({ storageState: storageStateOf(cookie) });
      const page = await context.newPage();
      await page.goto("/runs");
      await expect(page).toHaveURL(/\/login$/);
      // 失効したので、同じ Cookie の API も通らない
      const res = await page.request.get("/api/runs", { headers: { cookie: cookieHeader(cookie) } });
      expect(res.status()).toBe(401);
      await context.close();
    });

    test("入力: ログインに失敗して ?error= 付きで戻ると、通るアカウントの条件を案内する", async ({ page }) => {
      await page.goto("/login?error=unable_to_get_user_info");
      await expect(page.getByText(/許可リスト（CONTROL_ADMIN_EMAILS）にあるメールだけがログインできます/)).toBeVisible();
    });

    test("入力: ログインしていない API の要求は 401 を返す", async ({ request }) => {
      for (const path of ["/api/runs", "/api/jobs", "/api/miswrite-candidates"]) {
        const res = await request.get(path);
        expect(res.status(), path).toBe(401);
      }
    });

    test("入力: ログイン済みでも、別のオリジンからの手動の起動（POST）は 403 で拒む", async ({ request }) => {
      const cookie = await createSession(ADMIN_EMAIL);
      const res = await request.post("/api/runs", {
        headers: { cookie: cookieHeader(cookie), origin: "https://e2e-evil.example.com" },
        data: { target: { kind: "job", jobId: JOBS.published } },
      });
      expect(res.status()).toBe(403);
    });
  });
});
