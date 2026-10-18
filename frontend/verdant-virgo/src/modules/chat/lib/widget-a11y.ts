// Chatwoot のウィジェットに読み上げ用の名前を補い、開閉のときのフォーカスを移す（4.1.2・2.4.3）。
//
// **01-content-spec.md §8.1 の「ウィジェットの内部構造に依存しない」の例外**（2026-10-18。G-2〈P-7〉でユーザーが決定）。
// SDK が出すランチャーは英語の title「Open chat window」だけ、閉じるボタンは名前なし、iframe は title なしで、
// SDK の設定では直せない。そこで SDK が置いた要素（クラス名・id）を探し、属性（aria-label・title）を足すことと
// フォーカスを移すことだけを行う。要素を消す・並べ替える・中身を書き換えることはしない。
// Chatwoot の更新で要素の名前が変わると、ここは黙って何もしなくなる（console.warn だけ出す）。e2e が 3 つの名前を見て気づく。
// iframe の中（ウィジェット本体）には触れない（部分適合として /accessibility/ に明記する）。
import { CHAT_WIDGET_NAMES } from "./messages";

/** SDK（Chatwoot の sdk.js）が置く要素。更新で変わったら、ここだけ直す */
const SELECTORS = {
  bubbleHolder: "#cw-bubble-holder",
  launcher: ".woot-widget-bubble:not(.woot--close)",
  close: ".woot-widget-bubble.woot--close",
  widgetHolder: ".woot-widget-holder",
  frame: "#chatwoot_live_chat_widget",
} as const;
/** ウィジェットを閉じているときに widgetHolder に付くクラス */
const HIDDEN_CLASS = "woot--hide";

function setAttribute(
  element: Element | null,
  name: string,
  value: string,
): boolean {
  if (!element) return false;
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  return true;
}

/** 3 つの名前を付ける。見つからなかった要素の名前を返す */
function applyNames(): string[] {
  const missing: string[] = [];
  if (
    !setAttribute(
      document.querySelector(SELECTORS.launcher),
      "aria-label",
      CHAT_WIDGET_NAMES.launcher,
    )
  )
    missing.push("launcher");
  if (
    !setAttribute(
      document.querySelector(SELECTORS.close),
      "aria-label",
      CHAT_WIDGET_NAMES.close,
    )
  )
    missing.push("close");
  if (
    !setAttribute(
      document.querySelector(SELECTORS.frame),
      "title",
      CHAT_WIDGET_NAMES.frame,
    )
  )
    missing.push("frame");
  return missing;
}

let installed = false;

/** chatwoot:ready の後に 1 回だけ呼ぶ */
export function installWidgetA11y(): void {
  if (installed) return;
  installed = true;

  const missing = applyNames();
  if (missing.length > 0)
    console.warn(
      `[chat] Chatwoot のウィジェットの要素が見つかりません（${missing.join("・")}）。読み上げ用の名前を付けられません。`,
    );

  // SDK が要素を作り直したり属性を書き戻したりしたら付け直す
  const bubbleHolder = document.querySelector(SELECTORS.bubbleHolder);
  const widgetHolder = document.querySelector(SELECTORS.widgetHolder);
  const observer = new MutationObserver(() => applyNames());
  for (const target of [bubbleHolder, widgetHolder]) {
    if (target)
      observer.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-label", "title"],
      });
  }

  // 開閉のときのフォーカス。開いたらウィジェットの iframe へ、閉じたらランチャーへ戻す。
  // フォーカスがランチャー・閉じるボタン・body・チャットを開くボタン（data-chat-open）・iframe にあるときだけ動かす（入力中の欄などからは奪わない）
  if (!widgetHolder) {
    console.warn(
      "[chat] Chatwoot のウィジェットの枠が見つかりません。開閉のときにフォーカスを移せません。",
    );
    return;
  }
  let open = !widgetHolder.classList.contains(HIDDEN_CLASS);
  const movable = () => {
    const active = document.activeElement;
    return (
      !active ||
      active === document.body ||
      active.matches(
        `${SELECTORS.launcher}, ${SELECTORS.close}, ${SELECTORS.frame}, [data-chat-open]`,
      )
    );
  };
  new MutationObserver(() => {
    const nowOpen = !widgetHolder.classList.contains(HIDDEN_CLASS);
    if (nowOpen === open) return;
    open = nowOpen;
    if (!movable()) return;
    const target = document.querySelector<HTMLElement>(
      nowOpen ? SELECTORS.frame : SELECTORS.launcher,
    );
    target?.focus();
  }).observe(widgetHolder, { attributes: true, attributeFilter: ["class"] });
}
