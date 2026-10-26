// 開発スタックの障害（DD-07・DD-02 の 5.2・8.4）。コンテナを docker pause で止め（接続は張られたまま応答だけが止まる）、
// 訪問者から見て行き止まりにならないかを確かめる。どのテストも、成否にかかわらずコンテナを再開する（withPaused）。
// ほかのテストを巻き込まないよう、プロジェクト faults（flows がすべて終わった後）で、このファイルの中も 1 本ずつ流す。
import {
  consentCookie,
  expect,
  parseConsent,
  serverIssuedConsent,
  test,
} from "../support/fixtures";
import {
  consentRecordKeysCreatedSince,
  deleteMauticContactsByEmail,
  eventually,
  mauticContactsByEmail,
  withPaused,
} from "../support/devstack";
import { CONTAINERS, e2eEmail, e2eName } from "../support/env";
import { CONSULT_TEXT, consultForm, emailField } from "../../support/forms";

test.describe.configure({ mode: "serial" });

test.describe("開発スタックの障害", () => {
  test.describe("異常系", () => {
    test("サーバ: consent-api の保存先（Valkey）が応答しなくても、「同意する」で同意は成立し、PostHog を読み込む（記録だけが欠け、戻った後にも残らない）", async ({
      page,
      context,
      traffic,
      cleanup,
    }) => {
      await page.goto("/");
      const pausedAt = Date.now();
      await withPaused(CONTAINERS.consentValkey, async () => {
        await page.getByRole("button", { name: "同意する" }).click();
        await expect(
          page.getByRole("heading", { name: "Cookie の利用について" }),
        ).toBeHidden();
        // consent-api は 2 秒で諦めて 503 を返し、Cookie を書かない。ブラウザの JS が書いた Cookie（識別子なし）で同意が成立する
        await expect
          .poll(() => traffic.consents.map((c) => c.status), {
            timeout: 15_000,
          })
          .toEqual([503]);
        const consent = parseConsent(await consentCookie(context));
        expect(consent).toMatchObject({ state: "granted", id: null });
        await expect.poll(() => traffic.posthogRequests).toBeGreaterThan(0);
      });

      // 戻った後に同意し直すと、記録が作られて識別子が付く（後片付けも積む）
      await page
        .getByRole("contentinfo")
        .getByRole("button", { name: "Cookie 設定" })
        .click();
      await page.getByRole("button", { name: "同意する" }).click();
      const regranted = await serverIssuedConsent(page, cleanup);
      expect(regranted.state).toBe("granted");

      // 止めている間に送った書き込みは、Valkey が戻ったときに実行されるが、期限切れで書かれない（consent-api の README）。
      // consent-api の Valkey の接続は 1 本で、コマンドは順に実行されるので、同意し直しの記録ができた時点で判定できる
      expect(await consentRecordKeysCreatedSince(pausedAt)).toEqual([
        `consent:c:${regranted.id}`,
      ]);
    });

    test("サーバ: Mautic の DB が応答しないと、10 秒で「応答がありませんでした」を出して入力を残し、戻った後に押し直すと申し込める", async ({
      page,
      cleanup,
    }) => {
      test.setTimeout(180_000);
      const email = e2eEmail("fault");
      cleanup.add("Mautic のコンタクト", () =>
        deleteMauticContactsByEmail(email),
      );

      await page.goto("/contact/");
      const form = await consultForm(page);
      await form
        .getByLabel(CONSULT_TEXT.companyLabel)
        .fill(e2eName("fault-company"));
      await form
        .getByRole("textbox", {
          name: new RegExp(`^${CONSULT_TEXT.lastnameLabel}`),
        })
        .fill("試験");
      await form
        .getByRole("textbox", {
          name: new RegExp(`^${CONSULT_TEXT.firstnameLabel}`),
        })
        .fill("障害");
      await emailField(form).fill(email);
      await form
        .getByLabel(CONSULT_TEXT.messageLabel)
        .fill("E2E の障害の確認です。返信は不要です。");
      await form.getByRole("checkbox", { name: /に同意する/ }).click();

      await withPaused(CONTAINERS.mauticMysql, async () => {
        await form.getByRole("button", { name: CONSULT_TEXT.submit }).click();
        await expect(form.getByText(CONSULT_TEXT.timeoutTitle)).toBeVisible({
          timeout: 20_000,
        });
        await expect(emailField(form)).toHaveValue(email);
        await expect(
          form.getByRole("button", { name: CONSULT_TEXT.submit }),
        ).toBeEnabled();
        await expect(page).toHaveURL(/\/contact\/?$/);
      });

      // 止まっていた要求は DB が戻ると処理されうる（ブラウザは応答を待たずに諦めている）。押し直すと完了画面へ移る
      await form.getByRole("button", { name: CONSULT_TEXT.submit }).click();
      await expect(page).toHaveURL(/\/contact\/thanks\/?$/, {
        timeout: 60_000,
      });
      await eventually(
        "Mautic のコンタクト",
        async () => (await mauticContactsByEmail(email))[0],
        { timeoutMs: 60_000 },
      );
    });
  });
});
