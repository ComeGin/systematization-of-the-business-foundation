import type { Core } from '@strapi/strapi';

// aws-s3 のときだけ、管理画面が署名付き URL の画像・動画を表示できるよう CSP に S3 のホストを足す。
const mediaHosts =
  process.env.UPLOAD_PROVIDER === 'aws-s3' && process.env.UPLOAD_S3_BUCKET && process.env.UPLOAD_S3_REGION
    ? [`${process.env.UPLOAD_S3_BUCKET}.s3.${process.env.UPLOAD_S3_REGION}.amazonaws.com`]
    : [];

const security: Core.Config.Middlewares[number] = mediaHosts.length
  ? {
      name: 'strapi::security',
      config: {
        contentSecurityPolicy: {
          useDefaults: true,
          directives: {
            'connect-src': ["'self'", 'https:'],
            'img-src': ["'self'", 'data:', 'blob:', 'market-assets.strapi.io', ...mediaHosts],
            'media-src': ["'self'", 'data:', 'blob:', ...mediaHosts],
            upgradeInsecureRequests: null,
          },
        },
      },
    }
  : 'strapi::security';

const config: Core.Config.Middlewares = [
  'strapi::logger',
  'strapi::errors',
  'global::posthog-error',
  security,
  'strapi::cors',
  'strapi::poweredBy',
  'strapi::query',
  'strapi::body',
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
];

export default config;
