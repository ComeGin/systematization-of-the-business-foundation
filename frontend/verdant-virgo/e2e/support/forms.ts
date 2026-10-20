// フォームの操作（無料相談）。文言は src の messages から読む（文言を変えてもテストが追従する）。
// 無料 DL のメールのフォームは 2026-10-20 に公開サイトから消した（どのページも「ソースコードを無料 DL」の CTA）。
import { expect, type Locator, type Page } from "@playwright/test";
import { CONSULT_TEXT } from "../../src/modules/forms/lib/messages";

export { CONSULT_TEXT };

/**
 * 見つけたフォームに印（data-e2e-form）を付け、印で探し直した locator を返す。
 * 送信ボタンの名前は押すと「送信中…」に変わるので、ボタンの名前で探したままだと送信中にフォームを見失う。
 */
async function pin(form: Locator, name: string): Promise<Locator> {
  await form.evaluate((el, value) => el.setAttribute("data-e2e-form", value), name);
  return form.page().locator(`form[data-e2e-form="${name}"]`);
}

/** 無料相談のフォーム（/contact/）。水和して送信ボタンが押せるまで待つ */
export async function consultForm(page: Page): Promise<Locator> {
  const form = page.locator("form").filter({
    has: page.getByRole("button", { name: CONSULT_TEXT.submit }),
  });
  await expect(
    form.getByRole("button", { name: CONSULT_TEXT.submit }),
  ).toBeEnabled();
  return pin(form, "consult");
}

/** 同じ日・同じメールの二重送信の判定に掛からないよう、テストごとに違うメールにする */
export const uniqueEmail = () =>
  `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

/** メールアドレスの欄。ラベルには「必須」のバッジも入るので、名前の先頭で探す */
export const emailField = (form: Locator) =>
  form.getByRole("textbox", { name: new RegExp(`^${CONSULT_TEXT.emailLabel}`) });

/** 無料相談の必須の欄をすべて正しく埋める */
export async function fillConsult(form: Locator, email = uniqueEmail()) {
  await form.getByLabel(CONSULT_TEXT.companyLabel).fill("株式会社テスト");
  await form
    .getByRole("textbox", { name: new RegExp(`^${CONSULT_TEXT.lastnameLabel}`) })
    .fill("山田");
  await form
    .getByRole("textbox", { name: new RegExp(`^${CONSULT_TEXT.firstnameLabel}`) })
    .fill("太郎");
  await emailField(form).fill(email);
  await form.getByLabel(CONSULT_TEXT.messageLabel).fill("e2e の確認です。");
  await form.getByRole("checkbox", { name: /に同意する/ }).click();
  return email;
}

/**
 * 見えるラベルの無い入力欄（WCAG 3.3.2）。label[for]・包む <label>・aria-labelledby の先が、
 * 見えていて文字を持つときだけ「見えるラベルがある」とする（aria-label・placeholder だけは不可）。
 */
export function controlsWithoutVisibleLabel(form: Locator): Promise<string[]> {
  return form.evaluate((root) => {
    const seen = (el: Element | null) => {
      if (!el) return false;
      const rect = (el as HTMLElement).getBoundingClientRect();
      return (
        (el as HTMLElement).checkVisibility({ visibilityProperty: true }) &&
        rect.width > 1 &&
        rect.height > 1 &&
        !!el.textContent?.trim()
      );
    };
    const controls = [
      ...root.querySelectorAll<HTMLElement>(
        'input:not([type="hidden"]):not([aria-hidden="true"]), select, textarea, [role="checkbox"], [role="radio"], [role="combobox"]',
      ),
    ].filter((el) => {
      const rect = el.getBoundingClientRect();
      return (
        el.checkVisibility({ visibilityProperty: true }) &&
        rect.width > 2 &&
        rect.height > 2
      );
    });
    return controls
      .filter((el) => {
        if (
          el.id &&
          seen(document.querySelector(`label[for="${CSS.escape(el.id)}"]`))
        )
          return false;
        if (seen(el.closest("label"))) return false;
        const ids = el.getAttribute("aria-labelledby");
        if (
          ids &&
          ids.split(/\s+/).some((id) => seen(document.getElementById(id)))
        )
          return false;
        return true;
      })
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}[name=${el.getAttribute("name") ?? ""}] aria-label=${el.getAttribute("aria-label") ?? ""}`,
      );
  });
}

/**
 * aria-invalid の欄のうち、aria-describedby が見えるエラーの文を指していないもの（WCAG 3.3.1・1.3.1）。
 */
export function invalidWithoutDescribedError(form: Locator): Promise<string[]> {
  return form.evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>('[aria-invalid="true"]')]
      .filter((el) => {
        const ids = (el.getAttribute("aria-describedby") ?? "")
          .split(/\s+/)
          .filter(Boolean);
        return !ids.some((id) => {
          const target = document.getElementById(id);
          return (
            !!target?.textContent?.trim() &&
            target.checkVisibility({ visibilityProperty: true })
          );
        });
      })
      .map(
        (el) =>
          el.getAttribute("name") ?? el.getAttribute("role") ?? el.tagName,
      ),
  );
}

/**
 * ある文が支援技術に届く経路の数。フォーカスの移動（フォーカスした要素がその文を含む）と、
 * その文を含む生きた領域（role=alert・status・aria-live）を数える。1 なら 1 回だけ読み上げられる。
 */
export function announceChannels(page: Page, text: string): Promise<number> {
  return page.evaluate((needle) => {
    const live = [
      ...document.querySelectorAll<HTMLElement>(
        '[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"]',
      ),
    ].filter(
      (el) =>
        el.getAttribute("aria-live") !== "off" &&
        el.textContent?.includes(needle),
    );
    // 入れ子の生きた領域は外側だけを数える
    const outer = live.filter(
      (el) => !live.some((other) => other !== el && other.contains(el)),
    );
    const active = document.activeElement as HTMLElement | null;
    const focused =
      !!active &&
      active !== document.body &&
      !!active.textContent?.includes(needle);
    // 生きた領域にフォーカスも移すと、領域の通知とフォーカスの読み上げで 2 回になる
    return outer.length + (focused ? 1 : 0);
  }, text);
}
