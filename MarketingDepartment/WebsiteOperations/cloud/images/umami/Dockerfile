# syntax=docker/dockerfile:1
# check=skip=InvalidDefaultArgInFrom
# Umami の公式イメージに RDS の CA を足す派生イメージ。PostgreSQL（RDS）への接続でサーバー証明書を検証させる。
#
# Umami v3 は Prisma 7 で、実行時は @prisma/adapter-pg（Node の pg）、起動時の prisma migrate deploy（scripts/check-db.js）は
# Prisma の Rust のスキーマエンジンが DB に接続する。どちらも DATABASE_URL の sslmode=verify-full&sslaccept=strict で検証し
# （Rust のエンジンは sslmode だけでは検証しない。検証するのは sslaccept=strict。services/umami.yaml）、
# 次の 2 つの環境変数で CA を信頼させる（URL に証明書のパスを書かない。pg は sslcert をクライアント証明書と読むため）:
#   NODE_EXTRA_CA_CERTS: Node の pg が RDS の CA を信頼する
#   SSL_CERT_FILE:       Rust のエンジン（OpenSSL）が RDS の CA を信頼する。システムの CA 束に RDS の CA を足した束を指す
#                        （SSL_CERT_FILE は既定の CA 束を置き換えるため、システムの束を含める）
#
# ビルド:
#   docker build --platform linux/amd64 --build-arg UPSTREAM_TAG=<3.4.0 以上の固定のタグ。ghcr.io のタグは v なし> -t <ECR の URI>:<固定のタグ> cloud/images/umami
#
# UPSTREAM_TAG は必須（既定なし）。latest は使わない。
ARG UPSTREAM_TAG
# RDS の CA 束（global-bundle.pem）の SHA-256。内容が変わるとビルドが失敗する（cloud/README.md の 4.7）。
ARG RDS_CA_SHA256=fe45bbebf92ad3e27a583bbb2ddd1553c521ed4d49af5514dc0a40372ea5395c

FROM scratch AS rds-ca
ARG RDS_CA_SHA256
ADD --checksum=sha256:${RDS_CA_SHA256} https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /rds-global-bundle.pem

FROM ghcr.io/umami-software/umami:${UPSTREAM_TAG}
# --chmod は親ディレクトリにも効くため 0755 にする（非 root のユーザーが読めるように）。
COPY --from=rds-ca --chmod=0755 /rds-global-bundle.pem /etc/rds/global-bundle.pem
# システムの CA 束がこのパスに無い基盤イメージでは、ここで失敗する（黙って検証なしにはならない）。
RUN cat /etc/ssl/certs/ca-certificates.crt /etc/rds/global-bundle.pem > /tmp/ca-bundle-with-rds.pem
ENV NODE_EXTRA_CA_CERTS=/etc/rds/global-bundle.pem \
    SSL_CERT_FILE=/tmp/ca-bundle-with-rds.pem
