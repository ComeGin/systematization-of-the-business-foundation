// 誤った書き込みの候補（TA-07 の 6.2。builtin miswrite-check）。開発の Chatwoot（オンプレ。本物）に、
// エージェント専用ユーザー（ADR-17）の送信を作り、画面から突き合わせを起動して、候補の一覧に出るまでを通す。
// 会話とコンタクトは結合テストの補助で作り、テストの終わりに消す（名前とメールは e2e- で始める）。
import { asAdmin, expect, openHydrated, test } from "./support/fixtures.mjs";
import { createConversation, deleteConversationAndContact, sendOutgoing } from "../integration/helpers/chatwoot";
import { JOBS } from "./support/sandbox.mjs";

test.use(asAdmin);
// 2 本とも同じジョブ（e2e-miswrite）を起動するので、ファイルの中は順に流す（同時に起動すると後の方が見送りになる）
test.describe.configure({ mode: "serial" });

const OVERLAP = "前回の実行が継続中のため起動を見送った";

const runId = () => `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** 画面から突き合わせを起動し、終わった実行の詳細を開いたまま返す */
async function runMiswriteCheckFromUi(page: import("@playwright/test").Page) {
  // 同じジョブが別のテスト（runs.spec の絞り込み）で実行中なら、設計どおり「継続中のため見送り」になる。そのときは待って押し直す
  for (let attempt = 1; ; attempt += 1) {
    await openHydrated(page, `/runs/new?jobId=${JOBS.miswrite}`);
    await page.getByRole("button", { name: "起動する" }).click();
    await expect(page).toHaveURL(/\/runs\/[0-9A-HJKMNP-TV-Z]{26}$/);
    // 実行中は自動で読み直す（AutoRefresh）。終われば「成功」か「見送り」になる
    const status = page.getByRole("main").getByText(/^(成功|見送り)$/).first();
    await expect(status).toBeVisible({ timeout: 60_000 });
    if ((await status.textContent()) === "成功") return page.url().split("/").at(-1)!;
    await expect(page.getByText(OVERLAP).first()).toBeVisible();
    if (attempt >= 5) throw new Error("突き合わせが 5 回とも「継続中のため見送り」になった");
    await page.waitForTimeout(3_000);
  }
}

test.describe("誤った書き込みの候補", () => {
  test.describe("正常系", () => {
    test("エージェント専用ユーザーの送信で、提案にも実行にも対応しないものが、突き合わせの後に候補の一覧に出る（本文は出さない）", async ({
      page,
      cleanup,
    }) => {
      const id = runId();
      const conversation = await createConversation(`${id}-miswrite`, `${id}-miswrite@example.com`);
      cleanup.add("Chatwoot の会話とコンタクト", () => deleteConversationAndContact(conversation.displayId, conversation.contactId));
      const body = `${id}: エージェント専用ユーザーの送信（E2E）`;
      const messageId = await sendOutgoing(conversation.displayId, body, "agent");

      await runMiswriteCheckFromUi(page);
      await expect(page.getByText(/^突き合わせ: 走査した会話 \d+ 件、エージェントの送信 \d+ 件、候補 \d+ 件（新規 \d+ 件）$/)).toBeVisible();
      await expect(page.getByRole("cell", { name: `chatwoot-conversation:${conversation.displayId}` })).toBeVisible();

      await page.getByRole("link", { name: "誤った書き込みの候補" }).first().click();
      await expect(page).toHaveURL(/\/miswrite-candidates$/);
      const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name: String(messageId), exact: true }) });
      await expect(row).toContainText(String(conversation.displayId));
      await expect(row).toContainText("no matching proposal or run");
      await expect(page.getByText(body)).toHaveCount(0);
    });
  });

  test.describe("異常系", () => {
    test("入力: 人（管理者）の送信だけの会話は、突き合わせても候補にならない", async ({ page, cleanup }) => {
      const id = runId();
      const conversation = await createConversation(`${id}-human`, `${id}-human@example.com`);
      cleanup.add("Chatwoot の会話とコンタクト", () => deleteConversationAndContact(conversation.displayId, conversation.contactId));
      const messageId = await sendOutgoing(conversation.displayId, `${id}: 管理者（人）の送信（E2E）`, "admin");

      await runMiswriteCheckFromUi(page);
      await page.goto("/miswrite-candidates");
      await expect(page.getByRole("heading", { level: 1, name: /誤った書き込みの候補/ })).toBeVisible();
      await expect(page.getByRole("cell", { name: String(messageId), exact: true })).toHaveCount(0);
    });
  });
});
