// フォームの検査（計画書の検証 6。WCAG 1.3.5・3.3.1・3.3.2・4.1.3）。
// 送信は support/fixtures.ts が /form/submit をパスで差し替える（開発の Mautic に送らない）。
import { expect, test } from "../support/fixtures";
import {
  CONSULT_TEXT,
  SOURCE_DL_TEXT,
  announceChannels,
  consultForm,
  controlsWithoutVisibleLabel,
  emailField,
  fillConsult,
  fillSourceDl,
  invalidWithoutDescribedError,
  sourceDlForm,
} from "../support/forms";
import { liveRegionTexts } from "../support/dom";
import { open } from "./axe";
import { VALIDATION } from "../../src/modules/forms/lib/messages";

// 入力目的のある欄（1.3.5）。tel の欄を足したら tel も足す
const AUTOCOMPLETE: Record<string, string> = {
  company: "organization",
  lastname: "family-name",
  firstname: "given-name",
  email: "email",
};

test.describe("無料相談のフォーム", () => {
  test.describe("正常系", () => {
    test("送信先は /form/submit?formId=…&ajax=1 で、差し替えた応答だけが使われ、完了画面へ移る", async ({
      page,
      net,
    }) => {
      await open(page, "/contact/");
      const form = await consultForm(page);
      const email = await fillConsult(form);
      await form.getByRole("button", { name: CONSULT_TEXT.submit }).click();
      await page.waitForURL(/\/contact\/thanks\/?$/, { waitUntil: "commit" });
      const sent = net.to("/form/submit");
      expect(sent).toHaveLength(1);
      expect(sent[0].method).toBe("POST");
      expect(sent[0].search).toMatch(/^\?formId=\d+&ajax=1$/);
      expect(
        new URLSearchParams(sent[0].body ?? "").get("mauticform[email]"),
      ).toBe(email);
    });

    test("すべての欄に見えるラベルがある（姓・名を含む）", async ({ page }) => {
      await open(page, "/contact/");
      const form = await consultForm(page);
      expect(await controlsWithoutVisibleLabel(form)).toEqual([]);
    });

    test("入力目的のある欄に autocomplete がある（organization・family-name・given-name・email）", async ({
      page,
    }) => {
      await open(page, "/contact/");
      const form = await consultForm(page);
      for (const [name, token] of Object.entries(AUTOCOMPLETE)) {
        await expect
          .soft(form.locator(`[name="${name}"]`), name)
          .toHaveAttribute("autocomplete", token);
      }
    });

    test("文字数は、残り 20 字を超えて余っている間は読み上げず、残り 20 字以下になると読み上げる", async ({
      page,
    }) => {
      await open(page, "/contact/");
      const form = await consultForm(page);
      const message = form.getByLabel(CONSULT_TEXT.messageLabel);
      await message.fill("あ".repeat(10));
      expect(
        (await liveRegionTexts(page)).filter((t) => /2,000|残り|超/.test(t)),
        "10 字のとき",
      ).toEqual([]);
      await message.fill("あ".repeat(1985));
      await expect
        .poll(
          async () =>
            (await liveRegionTexts(page)).some((t) => /15|1,985/.test(t)),
          { message: "1,985 字のとき" },
        )
        .toBe(true);
    });
  });

  test.describe("異常系", () => {
    test("空入力: 何も入れずに送ると送信せず、最初のエラー（会社名）にフォーカスが移り、エラーが欄と結ばれる", async ({
      page,
      net,
    }) => {
      await open(page, "/contact/");
      const form = await consultForm(page);
      await form.getByRole("button", { name: CONSULT_TEXT.submit }).click();
      await expect(form.getByLabel(CONSULT_TEXT.companyLabel)).toBeFocused();
      expect(net.to("/form/submit")).toHaveLength(0);
      for (const text of [
        VALIDATION.companyRequired,
        VALIDATION.lastnameRequired,
        VALIDATION.emailRequired,
        VALIDATION.messageRequired,
        VALIDATION.privacyRequired,
      ]) {
        await expect
          .soft(form.getByText(text, { exact: true }).first())
          .toBeVisible();
      }
      expect(await invalidWithoutDescribedError(form)).toEqual([]);
    });

    test("入力: メールの形式が誤っていると、メールの欄にエラーが結ばれる", async ({
      page,
    }) => {
      await open(page, "/contact/");
      const form = await consultForm(page);
      await fillConsult(form, "not-an-email");
      await form.getByRole("button", { name: CONSULT_TEXT.submit }).click();
      const email = emailField(form);
      await expect(email).toBeFocused();
      await expect(email).toHaveAttribute("aria-invalid", "true");
      await expect(email).toHaveAccessibleDescription(
        new RegExp(
          VALIDATION.emailInvalid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        ),
      );
    });

    test("サーバ: 500 のとき送信失敗を 1 回だけ読み上げ、入力が残り、ボタンが押せる状態に戻る", async ({
      page,
      net,
    }) => {
      net.mautic = "server-error";
      await open(page, "/contact/");
      const form = await consultForm(page);
      await fillConsult(form);
      await form.getByRole("button", { name: CONSULT_TEXT.submit }).click();
      await expect(page.getByText(CONSULT_TEXT.failedTitle)).toBeVisible();
      expect(await announceChannels(page, CONSULT_TEXT.failedTitle)).toBe(1);
      await expect(form.getByLabel(CONSULT_TEXT.companyLabel)).toHaveValue(
        "株式会社テスト",
      );
      await expect(
        form.getByRole("button", { name: CONSULT_TEXT.submit }),
      ).toBeEnabled();
    });

    test("サーバ: Mautic が受け付けない（success: 0）とき送信失敗になる", async ({
      page,
      net,
    }) => {
      net.mautic = "rejected";
      await open(page, "/contact/");
      const form = await consultForm(page);
      await fillConsult(form);
      await form.getByRole("button", { name: CONSULT_TEXT.submit }).click();
      await expect(page.getByText(CONSULT_TEXT.failedTitle)).toBeVisible();
      expect(await announceChannels(page, CONSULT_TEXT.failedTitle)).toBe(1);
    });

    test("サーバ: 10 秒応答が無いとき「応答がありませんでした」を 1 回だけ読み上げる", async ({
      page,
      net,
    }) => {
      net.mautic = "hang";
      await open(page, "/contact/");
      const form = await consultForm(page);
      await fillConsult(form);
      await form.getByRole("button", { name: CONSULT_TEXT.submit }).click();
      await expect(
        form.getByRole("button", { name: CONSULT_TEXT.submitting }),
      ).toBeDisabled();
      await expect(page.getByText(CONSULT_TEXT.timeoutTitle)).toBeVisible({
        timeout: 15_000,
      });
      expect(await announceChannels(page, CONSULT_TEXT.timeoutTitle)).toBe(1);
    });

    test("入力: 同じメールで二重に送ると、送らずに二重送信の案内を 1 回だけ読み上げる", async ({
      page,
      net,
    }) => {
      // 送信 → 完了画面（Cal.com を読む）→ もう一度送信、と 2 往復するので 30 秒を超えることがある
      test.setTimeout(60_000);
      await open(page, "/contact/");
      const email = await fillConsult(await consultForm(page));
      await page.getByRole("button", { name: CONSULT_TEXT.submit }).click();
      await page.waitForURL(/\/contact\/thanks\/?$/, { waitUntil: "commit" });
      await open(page, "/contact/");
      const form = await consultForm(page);
      await fillConsult(form, email);
      await form.getByRole("button", { name: CONSULT_TEXT.submit }).click();
      await expect(page.getByText(CONSULT_TEXT.duplicateBody)).toBeVisible();
      expect(await announceChannels(page, CONSULT_TEXT.duplicateBody)).toBe(1);
      expect(net.to("/form/submit")).toHaveLength(1);
    });
  });
});

test.describe("無料 DL のフォーム", () => {
  test.describe("正常系", () => {
    test("メールの欄に見えるラベルと autocomplete=email があり、送ると成功を 1 回だけ読み上げる", async ({
      page,
      net,
    }) => {
      await open(page, "/blog/");
      const form = await sourceDlForm(page);
      expect(await controlsWithoutVisibleLabel(form)).toEqual([]);
      await expect(form.locator('[name="email"]')).toHaveAttribute(
        "autocomplete",
        "email",
      );
      await fillSourceDl(form);
      await form.getByRole("button", { name: SOURCE_DL_TEXT.submit }).click();
      await expect(page.getByText(SOURCE_DL_TEXT.successTitle)).toBeVisible();
      expect(await announceChannels(page, SOURCE_DL_TEXT.successTitle)).toBe(1);
      expect(net.to("/form/submit")).toHaveLength(1);
    });
  });

  test.describe("異常系", () => {
    test("空入力: 何も入れずに送ると送信せず、メールの欄にフォーカスが移り、エラーが欄と結ばれる", async ({
      page,
      net,
    }) => {
      await open(page, "/blog/");
      const form = await sourceDlForm(page);
      await form.getByRole("button", { name: SOURCE_DL_TEXT.submit }).click();
      await expect(
        emailField(form),
      ).toBeFocused();
      expect(await invalidWithoutDescribedError(form)).toEqual([]);
      expect(net.to("/form/submit")).toHaveLength(0);
    });

    test("サーバ: 500 のとき登録の失敗を 1 回だけ読み上げ、ボタンが押せる状態に戻る", async ({
      page,
      net,
    }) => {
      net.mautic = "server-error";
      await open(page, "/blog/");
      const form = await sourceDlForm(page);
      await fillSourceDl(form);
      await form.getByRole("button", { name: SOURCE_DL_TEXT.submit }).click();
      await expect(page.getByText(SOURCE_DL_TEXT.failedTitle)).toBeVisible();
      expect(await announceChannels(page, SOURCE_DL_TEXT.failedTitle)).toBe(1);
      await expect(
        form.getByRole("button", { name: SOURCE_DL_TEXT.submit }),
      ).toBeEnabled();
    });
  });
});
