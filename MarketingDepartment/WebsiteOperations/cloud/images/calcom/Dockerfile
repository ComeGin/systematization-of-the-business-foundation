# syntax=docker/dockerfile:1
# check=skip=InvalidDefaultArgInFrom
# Cal.com のイメージに RDS の CA を足す派生イメージ。PostgreSQL（RDS）への接続でサーバー証明書を検証させる。
# TODO: Cal.com のライセンスと公式イメージの有無を先に確かめる（TA-06 の 11 節。確かめずに動かさない）。
#
# Cal.com は Prisma（2025 年時点で 6 系の Rust エンジン。ドライバーアダプターへの移行が進行中）。どちらのエンジンでも、
# DATABASE_URL の sslmode=verify-full&sslaccept=strict で検証し、次の 2 つの環境変数で CA を信頼させる（umami と同じ。cloud/images/umami/Dockerfile）:
#   NODE_EXTRA_CA_CERTS: Node の pg（アダプター）が RDS の CA を信頼する
#   SSL_CERT_FILE:       Rust のエンジン（OpenSSL）が RDS の CA を信頼する。システムの CA 束に RDS の CA を足した束を指す
#
# ビルド:
#   docker build --platform linux/amd64 --build-arg UPSTREAM_TAG=<固定のタグ> -t <ECR の URI>:<固定のタグ> cloud/images/calcom
#
# UPSTREAM_TAG は必須（既定なし）。latest は使わない。
ARG UPSTREAM_TAG
# RDS の CA 束（global-bundle.pem）の SHA-256。内容が変わるとビルドが失敗する（cloud/README.md の 4.7）。
ARG RDS_CA_SHA256=fe45bbebf92ad3e27a583bbb2ddd1553c521ed4d49af5514dc0a40372ea5395c

FROM scratch AS rds-ca
ARG RDS_CA_SHA256
ADD --checksum=sha256:${RDS_CA_SHA256} https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /rds-global-bundle.pem

FROM docker.io/calcom/cal.com:${UPSTREAM_TAG}
# --chmod は親ディレクトリにも効くため 0755 にする（非 root のユーザーが読めるように）。
COPY --from=rds-ca --chmod=0755 /rds-global-bundle.pem /etc/rds/global-bundle.pem
# システムの CA 束がこのパスに無い基盤イメージでは、ここで失敗する（黙って検証なしにはならない）。
RUN cat /etc/ssl/certs/ca-certificates.crt /etc/rds/global-bundle.pem > /tmp/ca-bundle-with-rds.pem
ENV NODE_EXTRA_CA_CERTS=/etc/rds/global-bundle.pem \
    SSL_CERT_FILE=/tmp/ca-bundle-with-rds.pem
