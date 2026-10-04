# syntax=docker/dockerfile:1
# check=skip=InvalidDefaultArgInFrom
# Mautic の公式イメージ（mautic/mautic）に RDS の CA を足し、MySQL（RDS）への接続でサーバー証明書を検証させる派生イメージ。
# TA-06 の 3.2（イメージは ECR に置く）。上流のイメージのかわりに、これをビルドして ECR の mautic リポジトリに置く（cloud/README.md の 4.7）。
#
# ビルド:
#   docker build --platform linux/amd64 --build-arg UPSTREAM_TAG=7.2.0-apache -t <ECR の URI>:<固定のタグ> cloud/images/mautic
#
# UPSTREAM_TAG は必須（既定なし）。latest は使わない。取り込み済みのソース（backend/mautic-system）のバージョンに合わせる。
ARG UPSTREAM_TAG
# RDS の CA 束（global-bundle.pem）の SHA-256。内容が変わるとビルドが失敗する（改ざんの検知と、CA の更新を人が確かめるため）。
# AWS が束を更新したら、取得して中身を確かめたうえで、この値を更新する（cloud/README.md の 4.7）。
ARG RDS_CA_SHA256=fe45bbebf92ad3e27a583bbb2ddd1553c521ed4d49af5514dc0a40372ea5395c

FROM scratch AS rds-ca
ARG RDS_CA_SHA256
ADD --checksum=sha256:${RDS_CA_SHA256} https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /rds-global-bundle.pem

FROM docker.io/mautic/mautic:${UPSTREAM_TAG}
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
