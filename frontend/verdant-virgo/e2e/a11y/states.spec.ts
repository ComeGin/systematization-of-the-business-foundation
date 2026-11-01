// 状態を作ってから axe を回す（計画書の検証 2 の後半）。結果は .a11y/pages/<project>/<slug>--<state>.json に書き、
// summary.json に入る（merge.ts）。送信は support/fixtures.ts が /form/submit をパスで差し替える。
// 無料 DL のメールのフォームの状態（送信中・成功・入力エラー・失敗）は、2026-10-20 にフォームを消したので検査しない。
// Cookie バナーの表示中は、初回訪問の全ルートの検査（pages.spec.ts）で見ている。
import { expect, test } from "../support/fixtures";
import { CONSULT_TEXT, consultForm, fillConsult } from "../support/forms";
import { audit, brief, open } from "./axe";
import { BOOKING_TEXT } from "../../src/modules/booking/lib/messages";

test.describe("状態ごとの axe 検査", () => {
  // 2026-10-28: ヒーローのアトリエは最初の 3 秒で端末の速さを測る。GPU の無い検証用の VM ではその間ページが重く、axe が時間切れになる。
  // 最初から「遅い端末」と判定済み（ポスター）で開く（keyboard.spec.ts と同じ。アトリエは atelier.spec.ts で検査する）
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        sessionStorage.setItem("atelier:quality", JSON.stringify({ live: false, dpr: 1 }));
      } catch {}
    });
  });
  test.describe("正常系", () => {
    test("Mobile メニューを開いたときに違反が無い", async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "mobile",
        "Mobile のメニューは mobile の project だけ",
      );
      const { result } = await audit(
        page,
        testInfo,
        "/",
        "menu-open",
        async () => {
          const response = await open(page, "/");
          await page.getByRole("button", { name: "メニューを開く" }).click();
          await expect(page.locator("dialog#mobile-menu")).toHaveAttribute(
            "open",
            "",
          );
          return response;
        },
      );
      expect(brief(result.violation_items)).toEqual([]);
    });

    test("Cookie バナーで「同意しない」を選んだ後に違反が無い", async ({
      page,
      net,
    }, testInfo) => {
      const { result } = await audit(
        page,
        testInfo,
        "/",
        "consent-denied",
        async () => {
          const response = await open(page, "/");
          await page.getByRole("button", { name: "同意しない" }).click();
          await expect(page.locator("#cookie-banner")).toBeHidden();
          return response;
        },
      );
      expect(brief(result.violation_items)).toEqual([]);
      expect(net.to("/v1/consent")).toHaveLength(1);
    });

    test("主ボタンに hover した状態で違反が無い（無料相談の送信ボタンとトップの CTA）", async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "hover はポインターのある desktop だけ",
      );
      const { result: form } = await audit(
        page,
        testInfo,
        "/contact/",
        "hover-submit",
        async () => {
          const response = await open(page, "/contact/");
          const consult = await consultForm(page);
          await consult
            .getByRole("button", { name: CONSULT_TEXT.submit })
            .hover();
          return response;
        },
      );
      expect(brief(form.violation_items), "/contact/").toEqual([]);
      const { result: top } = await audit(
        page,
        testInfo,
        "/",
        "hover-cta",
        async () => {
          const response = await open(page, "/");
          await page.locator("main a[data-cta-id]").first().hover();
          return response;
        },
      );
      expect(brief(top.violation_items), "/").toEqual([]);
    });

    test("予約枠（Cal.com）の時間枠が読み込まれた後も、ページ側に違反が無い（iframe の中は除く）", async ({
      page,
    }, testInfo) => {
      // 時間枠が出ると iframe が 1,700px 前後に伸び、外側の枠がスクロールする（2026-10-19 の Q2 で scrollable-region-focusable を検知）
      test.setTimeout(60_000);
      // 外部に届かないときは skip する。audit の中で skip すると errored として summary に残るので、先に開いて確かめる
      const response = await open(page, "/contact/thanks/");
      const slot = page.frameLocator("iframe").first().locator('button[data-testid="time"]').first();
      const ready = await slot.waitFor({ timeout: 25_000 }).then(() => true, () => false);
      test.skip(!ready, "Cal.com の時間枠が読み込めない（外部のサービスに届かない）");
      const { result } = await audit(
        page,
        testInfo,
        "/contact/thanks/",
        "booking-ready",
        async () => response,
        // iframe の中は第三者（部分適合）。外側の枠とページは検査する
        ["iframe"],
      );
      expect(brief(result.violation_items)).toEqual([]);
    });
  });

  test.describe("異常系", () => {
    test("入力: 無料相談を空のまま送った入力エラーの表示に違反が無い", async ({
      page,
    }, testInfo) => {
      const { result } = await audit(
        page,
        testInfo,
        "/contact/",
        "form-error",
        async () => {
          const response = await open(page, "/contact/");
          const form = await consultForm(page);
          await form.getByRole("button", { name: CONSULT_TEXT.submit }).click();
          await expect(page.getByText(CONSULT_TEXT.errorSummary)).toBeVisible();
          return response;
        },
      );
      expect(brief(result.violation_items)).toEqual([]);
    });

    test("サーバ: 無料相談の送信失敗（500）の表示に違反が無い", async ({
      page,
      net,
    }, testInfo) => {
      net.mautic = "server-error";
      const { result } = await audit(
        page,
        testInfo,
        "/contact/",
        "form-failed",
        async () => {
          const response = await open(page, "/contact/");
          const form = await consultForm(page);
          await fillConsult(form);
          await form.getByRole("button", { name: CONSULT_TEXT.submit }).click();
          await expect(page.getByText(CONSULT_TEXT.failedTitle)).toBeVisible();
          return response;
        },
      );
      expect(brief(result.violation_items)).toEqual([]);
    });

    test("サーバ: 無料相談の 10 秒の無応答の表示に違反が無い", async ({
      page,
      net,
    }, testInfo) => {
      net.mautic = "hang";
      const { result } = await audit(
        page,
        testInfo,
        "/contact/",
        "form-timeout",
        async () => {
          const response = await open(page, "/contact/");
          const form = await consultForm(page);
          await fillConsult(form);
          await form.getByRole("button", { name: CONSULT_TEXT.submit }).click();
          await expect(page.getByText(CONSULT_TEXT.timeoutTitle)).toBeVisible({
            timeout: 15_000,
          });
          return response;
        },
      );
      expect(brief(result.violation_items)).toEqual([]);
    });

    test("入力: 無料相談の二重送信の案内に違反が無い", async ({
      page,
    }, testInfo) => {
      // 送信 → 完了画面 → もう一度送信、と 2 往復するので 30 秒を超えることがある
      test.setTimeout(60_000);
      const { result } = await audit(
        page,
        testInfo,
        "/contact/",
        "form-duplicate",
        async () => {
          await open(page, "/contact/");
          const email = await fillConsult(await consultForm(page));
          await page.getByRole("button", { name: CONSULT_TEXT.submit }).click();
          await page.waitForURL(/\/contact\/thanks\/?$/, {
            waitUntil: "commit",
          });
          const response = await open(page, "/contact/");
          const form = await consultForm(page);
          await fillConsult(form, email);
          await form.getByRole("button", { name: CONSULT_TEXT.submit }).click();
          await expect(
            page.getByText(CONSULT_TEXT.duplicateBody),
          ).toBeVisible();
          return response;
        },
      );
      expect(brief(result.violation_items)).toEqual([]);
    });

    test("サーバ: 予約枠（Cal.com）の読み込みに失敗したときの案内に違反が無い", async ({
      page,
    }, testInfo) => {
      // embed.js の読み込みを失敗させる（booking/lib/calcom.ts の onerror → 代わりの案内）
      await page.route(
        (url) => url.pathname === "/embed/embed.js",
        (route) => route.abort(),
      );
      const { result } = await audit(
        page,
        testInfo,
        "/contact/thanks/",
        "booking-failed",
        async () => {
          const response = await open(page, "/contact/thanks/");
          await expect(page.getByText(BOOKING_TEXT.failedTitle)).toBeVisible();
          return response;
        },
      );
      expect(brief(result.violation_items)).toEqual([]);
    });
  });
});
