# syntax=docker/dockerfile:1

# 開発の compose（backend/consent-api/compose.yml）だけが使う。本番は ALB 配下の Lambda（ADR-26）で、このイメージを使わない。
# 依存の取得・ビルド・実行の 3 段。実行イメージにはビルド用の道具とソースを入れず、非 root で動かす
# ベースの Node は版とダイジェストで固定する（タグは付け替えられうるため。24.22.1 は Brotli の脆弱性 CVE-2026-111497 の修正版）。
# 上げるときは `docker buildx imagetools inspect node:<版>-alpine` の Digest に変える（2026-10-27 に取得）
ARG NODE_IMAGE=node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
FROM ${NODE_IMAGE} AS base
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

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3104
# コンテナ自身の生存確認（Valkey は見ない）。このイメージは開発の compose だけが使う（本番は Lambda。ADR-26。ALB には載らない）
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3104) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "dist/index.js"]
