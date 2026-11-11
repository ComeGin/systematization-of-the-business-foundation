# syntax=docker/dockerfile:1
# check=skip=InvalidDefaultArgInFrom
# Chatwoot の公式イメージ（chatwoot/chatwoot）に RDS の CA を足す派生イメージ。PostgreSQL（RDS）への接続でサーバー証明書を検証させる。
# Rails（pg / libpq）は PGSSLMODE=verify-full と PGSSLROOTCERT（services/chatwoot-*.yaml）で、この CA の置き場を渡す。
#
# ビルドと push（リポジトリのルートから。生の docker build・push は使わない）:
#   node cloud/images/build-push.mjs chatwoot
# 上流のタグとダイジェストは cloud/images/chatwoot/upstream.json から読み、--build-arg UPSTREAM_TAG・UPSTREAM_DIGEST に渡す。
# 本来のタグ <タグ> と、ビルドしたコミットを残す <タグ>-rev-<コミット> の 2 つを push する（cloud/README.md の 4.7）。
#
# UPSTREAM_TAG（4.12 以上）と UPSTREAM_DIGEST は必須（既定なし）。latest は使わない。chatwoot-web と chatwoot-worker は同じイメージ。
# 上流はタグとダイジェストの両方で固定する（タグは付け替えられうるため。ダイジェストがあれば Docker はそれを使う）。
# ダイジェストは `docker buildx imagetools inspect <イメージ>:<タグ>` の Digest（読み取りだけ）。タグを上げたら upstream.json の tag と digest の両方を変える（cloud/README.md の 4.7）。
ARG UPSTREAM_TAG
ARG UPSTREAM_DIGEST
# RDS の CA 束（global-bundle.pem）の SHA-256。内容が変わるとビルドが失敗する（cloud/README.md の 4.7）。
ARG RDS_CA_SHA256=90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b

FROM scratch AS rds-ca
ARG RDS_CA_SHA256
ADD --checksum=sha256:${RDS_CA_SHA256} https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /rds-global-bundle.pem

FROM docker.io/chatwoot/chatwoot:${UPSTREAM_TAG}@${UPSTREAM_DIGEST}
# --chmod は親ディレクトリにも効くため 0755 にする（非 root のユーザーが読めるように）。
COPY --from=rds-ca --chmod=0755 /rds-global-bundle.pem /etc/rds/global-bundle.pem
