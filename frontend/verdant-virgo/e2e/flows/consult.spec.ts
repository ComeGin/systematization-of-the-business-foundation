// 無料相談（I-08 ブラウザ → Mautic）。CTA から申し込み、本物の開発の Mautic にコンタクトと送信結果が作られるまでを通す。
// a11y の forms.spec.ts は送信を差し替えて画面の振る舞いを見る。ここは送信の中身が Mautic のどこに残るかを見る:
//   コンタクト（E-09）  … company・firstname・lastname・email（小文字）・privacy_consent_version・email_optin
//   フォームの送信結果  … page_url・cta_id・service_interest・distinct_id（コンタクトの項目には写らない。dev/setup の FORMS）
// 作ったコンタクトはテストの終わりに消す（送信結果は Mautic の API で消せないので残る。メールの接頭辞 e2e- で見分ける）。
import type { Page } from "@playwright/test";
import {
  expect,
  grantConsent,
  test,
  type Traffic,
} from "./support/fixtures";
import {
  deleteMauticContactsByEmail,
  mailhogSubjectsTo,
  eventually,
  mauticContactsByEmail,
  mauticSubmissionsOf,
  type MauticContact,
} from "./support/devstack";
import { devValue, e2eEmail, e2eName } from "./support/env";
import { CONSULT_TEXT, consultForm, emailField } from "../support/forms";
import { VALIDATION } from "../../src/modules/forms/lib/messages";
import { contactThanks } from "../../src/modules/site-content/contact";

const formId = () => Number(devValue("MAUTIC_FORM_ID_CONSULT"));

interface Applicant {
  company: string;
  lastname: string;
  firstname: string;
  email: string;
  optin?: boolean;
}

const applicant = (label: string, email = e2eEmail(label)): Applicant => ({
  company: e2eName(`${label}-company`),
  lastname: "試験",
  firstname: "花子",
  email,
});

/** 無料相談のフォームを埋める（同意のチェックは必須。お知らせメールは任意） */
async function fill(page: Page, who: Applicant) {
  const form = await consultForm(page);
  await form.getByLabel(CONSULT_TEXT.companyLabel).fill(who.company);
  await form
    .getByRole("textbox", {
      name: new RegExp(`^${CONSULT_TEXT.lastnameLabel}`),
    })
    .fill(who.lastname);
  await form
    .getByRole("textbox", {
      name: new RegExp(`^${CONSULT_TEXT.firstnameLabel}`),
    })
    .fill(who.firstname);
  await emailField(form).fill(who.email);
  await form
    .getByLabel(CONSULT_TEXT.messageLabel)
    .fill("E2E の申し込みです。返信は不要です。");
  await form.getByRole("checkbox", { name: /に同意する/ }).click();
  if (who.optin)
    await form.getByRole("checkbox", { name: CONSULT_TEXT.optinLabel }).click();
  return form;
}

/** 送って完了画面に移るまで待ち、Mautic に転送した 1 件を返す */
async function submitAndWaitForThanks(page: Page, traffic: Traffic) {
  const form = await consultForm(page);
  await form.getByRole("button", { name: CONSULT_TEXT.submit }).click();
  await expect(page).toHaveURL(/\/contact\/thanks\/?$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(traffic.forms).toHaveLength(1);
  expect(traffic.forms[0].status).toBe(200);
  return traffic.forms[0].fields;
}

/** Mautic のコンタクト（フォームの処理は同期なので、普通は送信の応答の時点でできている） */
const contactOf = (email: string) =>
  eventually(
    `Mautic のコンタクト（${email}）`,
    async () => (await mauticContactsByEmail(email))[0],
  );

const policyVersion = (page: Page) =>
  page.locator("#comegin-consent-config").getAttribute("data-policy-version");

test.describe("無料相談", () => {
  test.describe("正常系", () => {
    test("顕在の記事の CTA から申し込むと、Mautic にコンタクトと送信結果が作られ、完了画面へ移る（メールは小文字で届く）", async ({
      page,
      traffic,
      cleanup,
      seed,
    }) => {
      // 大文字を混ぜて入れる。ブラウザが小文字にして送る（冪等キーと I-19 の突合をそろえる。DD-02 の 5.3）
      const typed = e2eEmail("article")
        .replace(/^e2e/, "E2E")
        .replace("example.com", "Example.COM");
      const email = typed.toLowerCase();
      cleanup.add("Mautic のコンタクト", () =>
        deleteMauticContactsByEmail(email),
      );

      await page.goto(`/blog/${seed.adoption.slug}/`);
      await page.getByTestId("consult_article_inline").click();
      await expect(page).toHaveURL(/\/contact\/?\?/);

      const who = { ...applicant("article", typed), optin: true };
      await fill(page, who);
      const version = await policyVersion(page);
      const sent = await submitAndWaitForThanks(page, traffic);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        contactThanks.hero.h1,
      );

      // ブラウザが送ったもの
      expect(sent).toMatchObject({
        email,
        page_url: `/blog/${seed.adoption.slug}/`,
        cta_id: "consult_article_inline",
        email_optin: "1",
        privacy_consent_version: version,
      });
      expect(sent.privacy_consent_at).toMatch(/\+09:00$/);
      // 同意していない訪問者には PostHog の distinct_id が無い（送らない。観測のために CV を失わない）
      expect(sent.distinct_id).toBeUndefined();

      // Mautic に残ったもの
      const contact: MauticContact = await contactOf(email);
      expect(contact.fields.all).toMatchObject({
        email,
        company: who.company,
        lastname: who.lastname,
        firstname: who.firstname,
        privacy_consent_version: version,
      });
      expect([1, true, "1"]).toContain(contact.fields.all.email_optin);
      const submissions = await mauticSubmissionsOf(formId(), contact.id);
      expect(submissions).toHaveLength(1);
      expect(submissions[0].results).toMatchObject({
        page_url: `/blog/${seed.adoption.slug}/`,
        cta_id: "consult_article_inline",
      });

      // 自動返信（受付確認）が、入力したメールアドレスに 1 通だけ届く（開発は MailHog。完了画面の案内と同じ約束）
      const mails = await eventually(
        "受付確認のメール",
        async () => {
          const found = await mailhogSubjectsTo(email);
          return found.length > 0 ? found : undefined;
        },
        { timeoutMs: 60_000, intervalMs: 1_000 },
      );
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toContain(
        "無料相談のお申し込みを受け付けました",
      );
    });

    test("サービス詳細の CTA から申し込むと、相談の対象（service_interest）が送信結果に残る", async ({
      page,
      traffic,
      cleanup,
    }) => {
      const who = applicant("service");
      cleanup.add("Mautic のコンタクト", () =>
        deleteMauticContactsByEmail(who.email),
      );

      await page.goto("/services/consulting/");
      const cta = page.getByTestId("consult_consulting_hero");
      const service = new URL(
        (await cta.getAttribute("href"))!,
        page.url(),
      ).searchParams.get("service");
      expect(service).toBeTruthy();
      await cta.click();

      await fill(page, who);
      const sent = await submitAndWaitForThanks(page, traffic);
      expect(sent).toMatchObject({
        service_interest: service,
        cta_id: "consult_consulting_hero",
        page_url: "/services/consulting/",
      });

      const contact = await contactOf(who.email);
      const [submission] = await mauticSubmissionsOf(formId(), contact.id);
      expect(submission.results).toMatchObject({ service_interest: service });
      // 任意のチェックを付けなければ、受け取らない希望として 0 を明示して送る（DD-02 の 5.3）
      expect(sent.email_optin).toBe("0");
    });

    test("Cookie に同意した訪問者の送信には PostHog の distinct_id が入り、Mautic の送信結果に残る（匿名から実名への接続点）", async ({
      page,
      traffic,
      cleanup,
    }) => {
      const who = applicant("consented");
      cleanup.add("Mautic のコンタクト", () =>
        deleteMauticContactsByEmail(who.email),
      );

      await page.goto("/contact/");
      expect((await grantConsent(page, cleanup)).state).toBe("granted");
      // PostHog（差し替え）が読み込まれ、distinct_id が決まるまで待つ
      await expect.poll(() => traffic.posthogRequests).toBeGreaterThan(0);

      await fill(page, who);
      const sent = await submitAndWaitForThanks(page, traffic);
      expect(sent.distinct_id).toBeTruthy();

      const contact = await contactOf(who.email);
      const [submission] = await mauticSubmissionsOf(formId(), contact.id);
      expect(submission.results).toMatchObject({
        distinct_id: sent.distinct_id,
      });
    });
  });

  test.describe("異常系", () => {
    test("空入力: 何も入れずに送ると、入力の誤りを示し、Mautic には何も送らない", async ({
      page,
      traffic,
    }) => {
      await page.goto("/contact/");
      const form = await consultForm(page);
      await form.getByRole("button", { name: CONSULT_TEXT.submit }).click();
      await expect(page.getByText(CONSULT_TEXT.errorSummary)).toBeVisible();
      await expect(form.getByText(VALIDATION.companyRequired)).toBeVisible();
      await expect(form.getByLabel(CONSULT_TEXT.companyLabel)).toBeFocused();
      expect(traffic.forms).toHaveLength(0);
      await expect(page).toHaveURL(/\/contact\/?$/);
    });

    test("入力: メールの形式が誤っていると送らず、Mautic にコンタクトが作られない", async ({
      page,
      traffic,
    }) => {
      const who = applicant("invalid", `${e2eName("invalid")}-at-example.com`);
      await page.goto("/contact/");
      const form = await fill(page, who);
      await form.getByRole("button", { name: CONSULT_TEXT.submit }).click();
      await expect(form.getByText(VALIDATION.emailInvalid)).toBeVisible();
      expect(traffic.forms).toHaveLength(0);
      expect(await mauticContactsByEmail(who.email)).toEqual([]);
    });

    test("入力: 同じタブで同じメールを同じ日に二重に送ると、2 回目は送らず、Mautic の送信結果は 1 件のまま", async ({
      page,
      traffic,
      cleanup,
    }) => {
      const who = applicant("duplicate");
      cleanup.add("Mautic のコンタクト", () =>
        deleteMauticContactsByEmail(who.email),
      );

      await page.goto("/contact/");
      await fill(page, who);
      await submitAndWaitForThanks(page, traffic);

      await page.goto("/contact/");
      const form = await fill(page, who);
      await form.getByRole("button", { name: CONSULT_TEXT.submit }).click();
      await expect(form.getByText(CONSULT_TEXT.duplicateBody)).toBeVisible();
      expect(traffic.forms).toHaveLength(1);

      const contact = await contactOf(who.email);
      expect(await mauticSubmissionsOf(formId(), contact.id)).toHaveLength(1);
    });

    test("入力: URL の cta・service・from が一覧の外・別のオリジンでも送信は通り、その値は送らない（page_url は /contact）", async ({
      page,
      traffic,
      cleanup,
    }) => {
      const who = applicant("tampered");
      cleanup.add("Mautic のコンタクト", () =>
        deleteMauticContactsByEmail(who.email),
      );

      await page.goto(
        `/contact/?cta=e2e_unknown&service=e2e-unknown&from=${encodeURIComponent("//evil.example/x")}`,
      );
      await fill(page, who);
      const sent = await submitAndWaitForThanks(page, traffic);
      expect(sent.cta_id).toBeUndefined();
      expect(sent.service_interest).toBeUndefined();
      expect(sent.page_url).toBe("/contact");

      const contact = await contactOf(who.email);
      expect(await mauticSubmissionsOf(formId(), contact.id)).toHaveLength(1);
    });
  });
});
