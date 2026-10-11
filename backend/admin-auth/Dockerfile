# syntax=docker/dockerfile:1

# 依存の取得・ビルド・実行の 3 段。実行イメージにはビルド用の道具とソースを入れず、非 root で動かす
FROM node:24-alpine AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

# RDS に TLS（証明書の検証つき）でつなぐための CA。Node は Amazon の CA を持たないため、NODE_EXTRA_CA_CERTS で追加する
FROM alpine:3 AS rds-ca
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /certs/rds-global-bundle.pem

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem
WORKDIR /app
COPY --from=rds-ca --chown=node:node /certs ./certs
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3103
# ALB のターゲットのヘルスチェックとは別に、コンテナ自身の生存確認（DB は見ない）
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3103) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "dist/index.js"]
