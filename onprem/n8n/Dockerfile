# syntax=docker/dockerfile:1
# check=skip=InvalidDefaultArgInFrom
# n8n の公式イメージ（n8nio/n8n）に RDS の CA を足す派生イメージ。本番（オンプレ）の n8n が RDS（PostgreSQL）へ
# つなぐときに、サーバー証明書を検証させるため（ADR-21）。
# n8n は DB_POSTGRESDB_SSL_CA_FILE（compose.yml）でこの CA の置き場を知る。runners は DB に接続しないので派生させない。
#
# ビルド（compose.yml の build: から呼ばれる。手でやるなら）:
#   docker build --build-arg N8N_VERSION=<N8N_VERSION> --build-arg N8N_DIGEST=<sha256:…> -t comegin/n8n-onprem:<N8N_VERSION> onprem/n8n
#
# N8N_VERSION と N8N_DIGEST は必須（既定なし。値は環境変数ファイル。.env.example）。latest は使わない。runners と必ず同じバージョンにする。
# 上流はタグとダイジェストの両方で固定する（タグは付け替えられうるため）。ダイジェストは `docker buildx imagetools inspect n8nio/n8n:<版>` の Digest。
ARG N8N_VERSION
ARG N8N_DIGEST
# RDS の CA 束（global-bundle.pem）の SHA-256。内容が変わるとビルドが失敗する（黙って別の CA を信頼しないため）。
# AWS が CA 束を更新したら、新しい値を人が確かめてから、この値と cloud/ 側（RdsCaSha256）を揃えて更新する。
ARG RDS_CA_SHA256=90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b

FROM scratch AS rds-ca
ARG RDS_CA_SHA256
ADD --checksum=sha256:${RDS_CA_SHA256} https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /rds-global-bundle.pem

FROM docker.io/n8nio/n8n:${N8N_VERSION}@${N8N_DIGEST}
# --chmod は親ディレクトリにも効くため 0755 にする（非 root のユーザーが読めるように）。
COPY --from=rds-ca --chmod=0755 /rds-global-bundle.pem /etc/rds/global-bundle.pem
