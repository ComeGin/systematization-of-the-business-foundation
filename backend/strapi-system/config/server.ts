import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Server => ({
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1337),
  // 本番は ALB が TLS を終端する。PROXY=true と PUBLIC_URL（https://cms.comegin.com）を渡さないと、
  // 管理画面が Secure Cookie を発行できずログインできない。開発環境は両方とも既定のままでよい。
  url: env('PUBLIC_URL', ''),
  proxy: env.bool('PROXY', false),
  app: {
    keys: env.array('APP_KEYS')!,
  },
  mcp: {
    enabled: true,
    connectTimeoutMs: 10000, // 10 seconds
    requestTimeoutMs: 120000, // 2 minutes
  },
  webhooks: {
    populateRelations: env.bool('WEBHOOKS_POPULATE_RELATIONS', false),
  },
});

export default config;
