// 開発スタックの接続先（リポジトリ直下の CLAUDE.md のポート表と同じ。変えるときは両方を直す）。
// どれも 127.0.0.1 に開いている。コンテナから見た名前（host.docker.internal）は middleware/host-relay が中継する。
export const DEV = {
  strapi: "http://127.0.0.1:1337",
  mautic: "http://127.0.0.1:8000",
  mailhog: "http://127.0.0.1:8025", // Mautic と n8n（I-21 の開発の配信）が送る MailHog
  chatwoot: "http://127.0.0.1:3100",
  n8n: "http://127.0.0.1:5678",
  openseo: "http://127.0.0.1:3001",
  adminAuth: "http://127.0.0.1:3103",
  consentApi: "http://127.0.0.1:3104",
  nextJs: "http://127.0.0.1:3200",
} as const;

export type ServiceName = keyof typeof DEV;

/** 生きているかを見るパス（認証の要らないもの） */
export const HEALTH_PATH: Record<ServiceName, string> = {
  strapi: "/_health",
  mautic: "/s/login",
  mailhog: "/api/v2/messages?limit=1",
  chatwoot: "/api",
  n8n: "/healthz",
  openseo: "/api/health",
  adminAuth: "/healthz",
  consentApi: "/healthz",
  nextJs: "/login",
};

/** docker compose のコンテナ名（障害を起こすテストが pause / unpause する） */
export const CONTAINERS = {
  consentValkey: "consent-api-valkey-1",
  adminAuthPostgres: "admin-auth-postgres-1",
  n8n: "n8n-n8n-1",
} as const;
