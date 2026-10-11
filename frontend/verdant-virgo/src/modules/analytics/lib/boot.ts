// 計測の起動（全ページ）。同意済みなら GA4・PostHog・CTA の表示の観測を始め、同意の変化に追従する。
import { getConsent, onConsentChange, type ConsentState } from '@/modules/consent/client';
import { grantGa4, revokeGa4 } from './ga4';
import { grantPosthog, revokePosthog } from './posthog';
import { installCtaClickTracking, startCtaViewTracking, stopCtaViewTracking } from './cta-tracking';

function apply(state: ConsentState): void {
  if (state === 'granted') {
    grantGa4();
    void grantPosthog();
    startCtaViewTracking();
  } else {
    revokeGa4();
    revokePosthog();
    stopCtaViewTracking();
  }
}

export function bootAnalytics(): void {
  installCtaClickTracking();
  if (getConsent() === 'granted') apply('granted');
  onConsentChange(apply);
}
