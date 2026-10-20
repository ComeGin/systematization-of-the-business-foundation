// Chatwoot のウィジェット（DD-02 の 4 節、01-content-spec.md §1.5・§8）。
// - 同意の後にだけ SDK を読み込む（K3）。PUBLIC_CHATWOOT_BASE・PUBLIC_CHATWOOT_WEBSITE_TOKEN が未設定なら読み込まない。
// - 同意バナーを表示している間はランチャーを隠す（K4）。隠すのは SDK の toggleBubbleVisibility で行い、DOM を直接消さない（§8.1）。
// - 撤回したらウィジェットを隠す（DD-02 の 3.4 の 3）。以後のページでは読み込まない。
// - 読み込みの失敗はサイト本体に影響させない（4 節「表示されないだけ」）。
// - 読み込んだ後、ランチャー・閉じるボタン・iframe に読み上げ用の名前を補い、開閉のときにフォーカスを移す（widget-a11y.ts。
//   §8.1 の「内部構造に依存しない」の例外で、G-2 でユーザーが決めた）。
import {
  getConsent,
  isConsentBannerVisible,
  openConsentBanner,
} from "@/modules/consent/client";
import { installWidgetA11y } from "./widget-a11y";

interface ChatwootApi {
  toggle(state?: "open" | "close"): void;
  toggleBubbleVisibility(visibility: "show" | "hide"): void;
}

declare global {
  interface Window {
    chatwootSettings?: Record<string, unknown>;
    chatwootSDK?: {
      run(options: { websiteToken: string; baseUrl: string }): void;
    };
    $chatwoot?: ChatwootApi;
  }
}

type LoadState = "idle" | "loading" | "ready" | "failed";
let state: LoadState = "idle";
/** 開いてほしいと押されたボタン（読み込みが済んだら開く。失敗したらこの近くに案内を出す） */
let openRequester: HTMLElement | null = null;
let openTimer: number | undefined;
/** 未同意で押されてバナーを出したボタン。そのバナーで「同意する」を選んだら開く */
let pendingAfterConsent: HTMLElement | null = null;

/** 押してから chatwoot:ready が来るまで待つ時間（これを過ぎたら案内を出す） */
const OPEN_TIMEOUT_MS = 10_000;
const NOTICE_ID = "chat-open-failure";
const SUPPORT_EMAIL = "kamegin4@comegin.com";

function config(): { baseUrl: string; websiteToken: string } | null {
  const baseUrl = import.meta.env.PUBLIC_CHATWOOT_BASE?.replace(/\/$/, "");
  const websiteToken = import.meta.env.PUBLIC_CHATWOOT_WEBSITE_TOKEN;
  return baseUrl && websiteToken ? { baseUrl, websiteToken } : null;
}

/** ランチャーの表示を、同意とバナーの状態に合わせる */
export function syncChatBubble(): void {
  if (state !== "ready" || !window.$chatwoot) return;
  const show = getConsent() === "granted" && !isConsentBannerVisible();
  window.$chatwoot.toggleBubbleVisibility(show ? "show" : "hide");
  if (!show) window.$chatwoot.toggle("close");
}

function clearNotice(): void {
  document.getElementById(NOTICE_ID)?.remove();
}

/**
 * チャットを開けなかったときの案内（押したボタンの直後に出す）。文言は §5.1 の送信失敗の文に合わせた（仕様書に無い。03-handoff へ申し送り）。
 * role="status" の要素を先に置いてから文を入れ、支援技術に読み上げさせる。
 */
function showFailureNotice(near: HTMLElement | null): void {
  clearNotice();
  const notice = document.createElement("p");
  notice.id = NOTICE_ID;
  notice.setAttribute("role", "status");
  notice.className = "phrase mt-2 text-sm text-destructive";
  (near ?? document.body).insertAdjacentElement(
    near ? "afterend" : "beforeend",
    notice,
  );
  requestAnimationFrame(() => {
    const link = document.createElement("a");
    link.href = `mailto:${SUPPORT_EMAIL}`;
    link.className = "text-text-link underline hover:text-text-link-hover";
    link.textContent = SUPPORT_EMAIL;
    notice.append(
      "チャットを表示できませんでした。",
      link,
      " までメールでご連絡ください。",
    );
  });
}

/** 開く待ちをやめて案内を出す（読み込みの失敗・設定が無い・時間切れ） */
function failOpen(reason: string): void {
  console.warn(`[chat] チャットを開けません（${reason}）。`);
  window.clearTimeout(openTimer);
  const near = openRequester;
  openRequester = null;
  if (near) showFailureNotice(near);
}

function waitAndOpen(requester: HTMLElement | null): void {
  openRequester = requester;
  clearNotice();
  window.clearTimeout(openTimer);
  openTimer = window.setTimeout(
    () => failOpen("応答がありません"),
    OPEN_TIMEOUT_MS,
  );
}

export function loadChatwoot(): void {
  const settings = config();
  if (!settings || state !== "idle") {
    syncChatBubble();
    return;
  }
  state = "loading";
  window.chatwootSettings = {
    position: "right",
    type: "standard",
    locale: "ja",
    hideMessageBubble: isConsentBannerVisible(),
  };
  window.addEventListener(
    "chatwoot:ready",
    () => {
      state = "ready";
      // 読み上げ用の名前と開閉のフォーカス（§8.1 の例外。G-2。widget-a11y.ts）
      installWidgetA11y();
      syncChatBubble();
      if (openRequester) {
        window.clearTimeout(openTimer);
        openRequester = null;
        clearNotice();
        window.$chatwoot?.toggle("open");
      }
    },
    { once: true },
  );
  const script = document.createElement("script");
  script.defer = true;
  script.async = true;
  script.src = `${settings.baseUrl}/packs/js/sdk.js`;
  script.onload = () =>
    window.chatwootSDK?.run({
      websiteToken: settings.websiteToken,
      baseUrl: settings.baseUrl,
    });
  script.onerror = () => {
    state = "failed";
    // 開いてほしいと押されていれば案内を出す（押されていなければ、ランチャーが出ないだけ。DD-02 の 4 節）
    if (openRequester) failOpen("SDK を読み込めません");
    else console.warn("[chat] Chatwoot の SDK を読み込めません。");
  };
  document.body.appendChild(script);
}

/**
 * 無料相談の「チャットで質問する」（chat_contact_aside。§4.6 の 6-5）。
 * 同意していなければ同意バナーを再表示する（ボタンを Disabled にしない）。そのバナーで「同意する」を選んだら、そのまま開く。
 */
export function openChat(opener?: HTMLElement | null): void {
  const requester = opener ?? null;
  if (getConsent() !== "granted") {
    pendingAfterConsent = requester;
    openConsentBanner(requester);
    return;
  }
  if (state === "ready") {
    clearNotice();
    window.$chatwoot?.toggle("open");
  } else if (state === "loading") waitAndOpen(requester);
  else if (state === "idle" && config()) {
    waitAndOpen(requester);
    loadChatwoot();
  } else {
    openRequester = requester;
    failOpen(
      state === "failed"
        ? "SDK を読み込めません"
        : "PUBLIC_CHATWOOT_BASE か PUBLIC_CHATWOOT_WEBSITE_TOKEN が未設定",
    );
  }
}

/** 同意の変化（ChatLoader から呼ぶ）。チャットのボタンから出したバナーで同意したら、そのまま開く */
export function handleConsentChange(
  consent: "granted" | "denied" | "unset",
): void {
  const requester = pendingAfterConsent;
  pendingAfterConsent = null;
  if (consent === "granted") {
    if (requester) openChat(requester);
    else loadChatwoot();
  } else {
    syncChatBubble();
  }
}

/** バナーが別の経路（フッターの「Cookie 設定」など）で出されたら、チャットを開く予約を取り消す */
export function handleBannerOpenRequest(opener: HTMLElement | null): void {
  if (opener !== pendingAfterConsent) pendingAfterConsent = null;
}

/** 同意せずにバナーが閉じたら、開く予約を取り消す */
export function handleBannerVisibilityChange(visible: boolean): void {
  if (!visible && getConsent() !== "granted") pendingAfterConsent = null;
  syncChatBubble();
}
