// Cookie 同意の状態（ブラウザ側）。01-content-spec.md §8.1・8.1.1、DD-02 の 3.3・3.4・8 節。
//
// - 判定は Cookie `comegin_consent` だけで行う（同期で読めるため。DD-02 の 3.3）。
// - 同意の操作では、この JS が Cookie を書き、consent-api に POST する（応答を待たない）。
//   受け口が落ちていても同意は成立し、サーバー側の記録だけが欠ける（DD-02 の 8.4 の二重化。リードの決定）。
// - 識別子（id）はサーバーだけが発行する。JS は既存の id を引き継ぐか、id なしで書く。
//   POST の応答の Set-Cookie が id 付きの値で上書きする（backend/consent-api/README.md）。
// - Cookie の版（v）が現行の CONSENT_POLICY_VERSION と違えば未同意として扱い、同意を取り直す（DD-02 の 4.4）。

export type ConsentState = 'granted' | 'denied' | 'unset';

const COOKIE_NAME = 'comegin_consent';
const MAX_AGE_SECONDS = 31536000; // 12 か月（§8.1.1）
const CHANGE_EVENT = 'comegin:consent-change';
const OPEN_EVENT = 'comegin:consent-open';
const BANNER_EVENT = 'comegin:consent-banner';
/** ConsentBanner.astro が置く設定の要素。CONSENT_POLICY_VERSION は PUBLIC_ ではないため DOM で渡す */
export const CONFIG_ELEMENT_ID = 'comegin-consent-config';

interface ConsentCookie {
  state: string;
  version: string;
  id: string | null;
}

function policyVersion(): string {
  return document.getElementById(CONFIG_ELEMENT_ID)?.dataset.policyVersion ?? '';
}

function readCookie(): ConsentCookie | null {
  const raw = document.cookie
    .split('; ')
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  return { state: params.get('s') ?? '', version: params.get('v') ?? '', id: params.get('id') };
}

export function getConsent(): ConsentState {
  if (typeof document === 'undefined') return 'unset';
  const cookie = readCookie();
  if (!cookie || cookie.version !== policyVersion()) return 'unset';
  return cookie.state === 'granted' || cookie.state === 'denied' ? cookie.state : 'unset';
}

function writeCookie(state: 'granted' | 'denied'): void {
  const id = readCookie()?.id;
  // 値の形は consent-api と同じ `s=…&v=…&id=…`（エンコードしない）
  let value = `s=${state}&v=${policyVersion()}`;
  if (id) value += `&id=${id}`;
  let cookie = `${COOKIE_NAME}=${value}; Max-Age=${MAX_AGE_SECONDS}; Path=/; SameSite=Lax; Secure`;
  const domain = import.meta.env.PUBLIC_CONSENT_COOKIE_DOMAIN;
  if (domain) cookie += `; Domain=${domain}`;
  document.cookie = cookie;
}

function recordOnServer(state: 'granted' | 'denied'): void {
  const base = import.meta.env.PUBLIC_CONSENT_BASE;
  if (!base) return;
  // 投げっぱなし（DD-02 の 8 節。タイムアウト・リトライなし）。失敗は訪問者に見せない（8.3）
  fetch(`${base.replace(/\/$/, '')}/v1/consent`, {
    method: 'POST',
    mode: 'cors',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
    keepalive: true,
  }).catch(() => {});
}

/** 同意する／同意しない（撤回も denied）。Cookie を書き、記録を送り、変化を知らせる */
export function setConsent(state: 'granted' | 'denied'): void {
  writeCookie(state);
  recordOnServer(state);
  window.dispatchEvent(new CustomEvent<ConsentState>(CHANGE_EVENT, { detail: state }));
}

/** 同意の状態が変わったときに呼ばれる。戻り値で購読をやめる */
export function onConsentChange(callback: (state: ConsentState) => void): () => void {
  const listener = (event: Event) => callback((event as CustomEvent<ConsentState>).detail);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

/** 同意バナーを再表示する（フッターの「Cookie 設定」、未同意でのチャットのボタン） */
export function openConsentBanner(opener?: HTMLElement | null): void {
  window.dispatchEvent(new CustomEvent<HTMLElement | null>(OPEN_EVENT, { detail: opener ?? null }));
}

export function onConsentBannerOpenRequest(callback: (opener: HTMLElement | null) => void): () => void {
  const listener = (event: Event) => callback((event as CustomEvent<HTMLElement | null>).detail);
  window.addEventListener(OPEN_EVENT, listener);
  return () => window.removeEventListener(OPEN_EVENT, listener);
}

let bannerVisible = false;

/** バナーの表示の状態。chat がランチャーを隠すのに使う（K4） */
export function isConsentBannerVisible(): boolean {
  return bannerVisible;
}

export function setConsentBannerVisible(visible: boolean): void {
  bannerVisible = visible;
  window.dispatchEvent(new CustomEvent<boolean>(BANNER_EVENT, { detail: visible }));
}

export function onConsentBannerVisibilityChange(callback: (visible: boolean) => void): () => void {
  const listener = (event: Event) => callback((event as CustomEvent<boolean>).detail);
  window.addEventListener(BANNER_EVENT, listener);
  return () => window.removeEventListener(BANNER_EVENT, listener);
}
