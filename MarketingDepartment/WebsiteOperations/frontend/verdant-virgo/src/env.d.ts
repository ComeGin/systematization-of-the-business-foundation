// 環境変数の型。値と意味は .env.example が正本（名前は DD-02 の 1.1・DD-05 の 1 節に合わせる）。
// PUBLIC_ の付いたものはブラウザの JS に埋め込まれる。付いていないものは .astro の frontmatter・設定ファイルでだけ読む。

interface ImportMetaEnv {
  readonly SITE_URL?: string;
  readonly BUILD_TARGET?: 'development' | 'production';

  readonly STRAPI_URL?: string;
  readonly STRAPI_API_TOKEN?: string;
  readonly UPLOAD_S3_BUCKET?: string;
  readonly UPLOAD_S3_REGION?: string;

  readonly PUBLIC_GA4_MEASUREMENT_ID?: string;
  readonly PUBLIC_POSTHOG_PROJECT_TOKEN?: string;
  readonly PUBLIC_POSTHOG_HOST?: string;
  readonly PUBLIC_CHATWOOT_BASE?: string;
  readonly PUBLIC_CHATWOOT_WEBSITE_TOKEN?: string;

  readonly PUBLIC_MAUTIC_BASE?: string;
  readonly MAUTIC_FORM_ID_CONSULT?: string;
  readonly MAUTIC_FORM_ID_SOURCE_DL?: string;

  readonly PUBLIC_CALCOM_BASE?: string;
  readonly PUBLIC_CALCOM_LINK?: string;

  readonly PUBLIC_CONSENT_BASE?: string;
  readonly PUBLIC_CONSENT_COOKIE_DOMAIN?: string;
  readonly CONSENT_POLICY_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
