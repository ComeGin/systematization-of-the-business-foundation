# Strapi の本番イメージ（ADR-21 でオンプレで動かす。構成は onprem/strapi/compose.yml。データは AWS の RDS・S3）。
#
#   docker build -t strapi-system .
#
# 環境変数は実行時に onprem/strapi の環境変数ファイルから渡す（イメージには焼き込まない）。
# 必須の変数と意味は .env.example を見る。ヘルスチェックのパスは /_health（204 を返す）。

ARG NODE_VERSION=22
ARG PNPM_VERSION=11.17.0

# ---------- 依存の解決とビルド ----------
FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG PNPM_VERSION

# better-sqlite3 と sharp のネイティブビルドが prebuilt で足りないときの保険
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# NODE_ENV=production にしておく（src/posthog.ts は本番以外で PostHog の設定が無いと例外にするため）
ENV NODE_ENV=production
ENV STRAPI_TELEMETRY_DISABLED=true
RUN pnpm build

# 実行に要らない開発用の依存を落とす
RUN pnpm prune --prod

# ---------- RDS の CA ----------
# RDS に TLS（証明書の検証つき）でつなぐための CA。Node は Amazon の CA を持たないため、NODE_EXTRA_CA_CERTS で追加する
FROM alpine:3 AS rds-ca
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /certs/rds-global-bundle.pem

# ---------- 実行 ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem
ENV STRAPI_TELEMETRY_DISABLED=true
ENV HOST=0.0.0.0
ENV PORT=1337

WORKDIR /app

COPY --from=rds-ca --chown=node:node /certs ./certs
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
# 利用者のマイグレーション置き場。Strapi が起動時に作ろうとして、無いと非 root では失敗する
COPY --from=build --chown=node:node /app/database ./database
# tsconfig.json が無いと Strapi が outDir（dist）を見つけられず、dist/config を読まない
COPY --from=build --chown=node:node /app/package.json /app/tsconfig.json /app/favicon.png ./

# 非 root で動かす（node イメージの node ユーザー。uid 1000）
USER node

EXPOSE 1337

# pnpm を実行時に使わない（corepack が実行時にネットワークから取得しないように）
CMD ["node", "node_modules/@strapi/strapi/bin/strapi.js", "start"]
