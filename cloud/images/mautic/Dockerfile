# syntax=docker/dockerfile:1
# check=skip=InvalidDefaultArgInFrom
# Mautic の公式イメージ（mautic/mautic）の派生イメージ。RDS の CA を足して MySQL（RDS）への接続でサーバー証明書を検証させ、
# インストーラーの TLS・cron の Webhook の送信・信頼するプロキシの設定を足す（下の 1〜5）。
# TA-06 の 3.2（イメージは ECR に置く）。上流のイメージのかわりに、これをビルドして ECR の mautic リポジトリに置く（cloud/README.md の 4.7）。
#
# ビルド:
#   docker build --platform linux/amd64 --build-arg UPSTREAM_TAG=7.2.0-apache \
#     --build-arg UPSTREAM_DIGEST=sha256:dea3bb71a5c5bf4c0c7d1764e58a32109898e7b2e6a710f14f50e2a913c03a0f -t <ECR の URI>:<固定のタグ> cloud/images/mautic
#
# UPSTREAM_TAG と UPSTREAM_DIGEST は必須（既定なし）。latest は使わない。取り込み済みのソース（backend/mautic-system）のバージョンに合わせる。
# 上流はタグとダイジェストの両方で固定する（タグは付け替えられうるため。ダイジェストがあれば Docker はそれを使う）。
# ダイジェストは `docker buildx imagetools inspect <イメージ>:<タグ>` の Digest（読み取りだけ）。タグを上げたら両方を変える（cloud/README.md の 4.7）。
ARG UPSTREAM_TAG
ARG UPSTREAM_DIGEST
# RDS の CA 束（global-bundle.pem）の SHA-256。内容が変わるとビルドが失敗する（改ざんの検知と、CA の更新を人が確かめるため）。
# AWS が束を更新したら、取得して中身を確かめたうえで、この値を更新する（cloud/README.md の 4.7）。
ARG RDS_CA_SHA256=90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b

FROM scratch AS rds-ca
ARG RDS_CA_SHA256
ADD --checksum=sha256:${RDS_CA_SHA256} https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /rds-global-bundle.pem

FROM docker.io/mautic/mautic:${UPSTREAM_TAG}@${UPSTREAM_DIGEST}
# --chmod は親ディレクトリにも効くため 0755 にする（0644 だと /etc/rds に入れず、www-data が読めない）。
COPY --from=rds-ca --chmod=0755 /rds-global-bundle.pem /etc/rds/global-bundle.pem

# 1) 起動時の接続確認（entrypoint の mysqladmin ping）を、CA の検証つきの TLS にする。
#    RDS の MySQL は require_secure_transport=1（data.yaml）で、TLS でない接続を拒否するため、これが無いと起動しない。
RUN printf '[client]\nssl-ca=/etc/rds/global-bundle.pem\nssl-verify-server-cert\n' > /etc/mysql/conf.d/rds-ssl.cnf

# 2) Mautic（Doctrine / PDO）の MySQL への接続で、CA を指定してサーバー証明書を検証する。
#    Mautic の設定（local.php や MAUTIC_* の環境変数）には、PDO の SSL のオプションを渡す項目が無いため、
#    app/config/config.php の 2 つの接続の options に足す（default と、unbuffered の両方）。
#    足した行がちょうど 2 か所であることと、PHP の構文が壊れていないことを確かめる。確かめられなければビルドを失敗させる。
#    上流のバージョンを上げたときにパターンが合わなくなれば、ここで失敗する（黙って検証なしになることはない）。
RUN set -eux; \
    f=/var/www/html/docroot/app/config/config.php; \
    perl -0pi -e 's/(\x27options\x27\s*=>\s*\[PDO::ATTR_STRINGIFY_FETCHES => true)(\],)/$1, PDO::MYSQL_ATTR_SSL_CA => \x27\/etc\/rds\/global-bundle.pem\x27, PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT => true$2/' "$f"; \
    perl -0pi -e 's/(\$unbufferedQueryConstant\s*=> false,)/$1\n                    PDO::MYSQL_ATTR_SSL_CA => \x27\/etc\/rds\/global-bundle.pem\x27,\n                    PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT => true,/' "$f"; \
    test "$(grep -c 'PDO::MYSQL_ATTR_SSL_CA' "$f")" = 2; \
    test "$(grep -c 'PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT' "$f")" = 2; \
    php -l "$f"

# 3) インストーラー（/installer と mautic:install）の DB 接続も、CA を指定して検証つきの TLS にする。
#    インストーラーは 2) の config.php を通らず、InstallBundle の SchemaHelper が DriverManager::getConnection で直接つなぐ
#    （InstallService の DB の作成とスキーマの作成の 2 か所）。SSL の指定が無いと平文で接続し、
#    require_secure_transport=1 の RDS に拒否されて、インストールが DB の段階で止まる。
#    接続のパラメータを組み立てる行（charset を utf8mb4 にする行）の直後に、Doctrine の driverOptions（PDO に渡す）を足す。
#    足した行がちょうど 1 か所であることと、PHP の構文を確かめる。
RUN set -eux; \
    f=/var/www/html/docroot/app/bundles/InstallBundle/Helper/SchemaHelper.php; \
    perl -0pi -e 's/(\$dbParams\[\x27charset\x27\]\s*=\s*\x27utf8mb4\x27;)/$1\n        \$dbParams[\x27driverOptions\x27] = (\$dbParams[\x27driverOptions\x27] ?? []) + [\\PDO::MYSQL_ATTR_SSL_CA => \x27\/etc\/rds\/global-bundle.pem\x27, \\PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT => true];/' "$f"; \
    test "$(grep -c 'PDO::MYSQL_ATTR_SSL_CA' "$f")" = 1; \
    test "$(grep -c 'PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT' "$f")" = 1; \
    php -l "$f"

# 4) mautic-cron で Webhook のキューを毎分送る（mautic:webhooks:process）。
#    本番の Mautic は queue_mode=command_process（Webhook をフォームの送信などの要求の中で送らず、キューに積む。setup/README.md）。
#    公式イメージの cron の定義（/templates/mautic_cron。entrypoint が起動のたびにコンテナの中へ写す）では、この行がコメントアウトされていて、
#    そのままだとキューに積まれるだけで、オンプレの n8n（I-11）に届かない。コメントを外し、有効な行がちょうど 1 つであることを確かめる。
RUN set -eux; \
    f=/templates/mautic_cron; \
    sed -i -E 's|^#[[:space:]]*(\* \* \* \* \* php /var/www/html/bin/console mautic:webhooks:process)|\1|' "$f"; \
    test "$(grep -cE '^\* \* \* \* \* php /var/www/html/bin/console mautic:webhooks:process' "$f")" = 1

# 5) 信頼するプロキシ（ALB）を Mautic に効かせる。環境変数 MAUTIC_TRUSTED_PROXIES だけでは効かない（Mautic は config/local.php と
#    config/parameters_local.php からしか読まない）。起動のたびに parameters_local.php を書く薄い entrypoint を前に置く
#    （comegin-entrypoint.sh。最後に公式の /entrypoint.sh を exec する）。上流には CMD が無いので、ENTRYPOINT を替えても CMD は失われない。
COPY --chmod=0755 comegin-entrypoint.sh /comegin-entrypoint.sh
ENTRYPOINT ["/comegin-entrypoint.sh"]
