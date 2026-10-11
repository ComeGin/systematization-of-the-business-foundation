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

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3104
# ALB のターゲットのヘルスチェックとは別に、コンテナ自身の生存確認（Valkey は見ない）
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3104) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "dist/index.js"]
