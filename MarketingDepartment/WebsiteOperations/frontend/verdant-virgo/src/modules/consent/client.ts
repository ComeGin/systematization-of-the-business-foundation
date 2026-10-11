// consent モジュールのブラウザ用の公開口。ブラウザで動くコード（<script>・island）はここから import する
// （index.ts は .astro の部品も export するため、クライアントのバンドルに引き込まない）。
export {
  getConsent,
  onConsentChange,
  setConsent,
  openConsentBanner,
  onConsentBannerOpenRequest,
  isConsentBannerVisible,
  onConsentBannerVisibilityChange,
  type ConsentState,
} from './lib/consent';
