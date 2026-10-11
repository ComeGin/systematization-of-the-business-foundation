// Google アナリティクス（GA4）。DD-02 の 2 節（ADR-25）。Consent Mode v2 の basic。
// 同意（comegin_consent の s=granted）があるときだけ呼ばれ、ここで初めて gtag.js を読み込む。
// PUBLIC_GA4_MEASUREMENT_ID が未設定なら何もしない（開発ではタグを出さない。2.4）。
// DD-02 の 2.1 はインラインのスクリプトで書いているが、手順は同じまま Astro がバンドルする外部の JS にした
// （CSP にインラインのハッシュを足さずに済む。2.5）。

declare global {
  interface Window {
    dataLayer: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

let loaded = false;

function gtag(..._args: unknown[]): void {
  // gtag.js は arguments オブジェクトそのものを dataLayer に積む前提
  // eslint-disable-next-line prefer-rest-params
  window.dataLayer.push(arguments);
}

export function grantGa4(): void {
  const measurementId = import.meta.env.PUBLIC_GA4_MEASUREMENT_ID;
  if (!measurementId) return;
  if (loaded) {
    // 同じページで撤回のあとに同意し直した場合
    gtag('consent', 'update', { analytics_storage: 'granted' });
    return;
  }
  loaded = true;
  window.dataLayer = window.dataLayer || [];
  window.gtag = gtag;
  // 1. 既定はすべて denied（タグより先に置く）
  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
  });
  // 2. 同意を反映する。広告の 3 つは常に denied のまま
  gtag('consent', 'update', { analytics_storage: 'granted' });
  // 3. ここで初めて gtag.js を読み込む
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
  document.head.appendChild(script);
  gtag('js', new Date());
  // プロパティの設定が誤って変わっても、タグ側で Google シグナルと広告のパーソナライズを止める
  gtag('config', measurementId, {
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
}

/** 撤回（DD-02 の 3.4 の 3'）。以後のページでは grantGa4 が呼ばれないので読み込まれない */
export function revokeGa4(): void {
  if (!loaded) return;
  gtag('consent', 'update', { analytics_storage: 'denied' });
}
