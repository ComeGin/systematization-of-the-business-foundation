# admin-auth

本番の管理画面（Mautic・Chatwoot）の手前にかける**関門**（ADR-21 で Strapi・n8n はオンプレに移り、ADR-24 で Cal.com は SaaS になり、ADR-25 で Umami は廃止したため、いずれも対象から外れた）。Better Auth を OAuth 2.1 / OIDC Provider として動かし、ALB の `authenticate-oidc` の IdP にする（開発ポート 3103。本番は ALB 配下の Lambda〈VPC の中。ADR-26。2026-10-12 に ECS on Fargate から移した〉、ホスト名 `auth.comegin.com`）。

- ログインは **Google Workspace**（認証）。誰を通すかは **管理者の許可リスト**（認可。`admin_auth` データベースの表）が決める。
- 製品の SSO ではない。関門を通ったあとも、各製品のアカウントでログインする。
- **管理画面への通信は admin-auth を通らない。** 関わるのはログインのときだけで、その後は ALB が自分のセッション Cookie（12 時間）で判定する。admin-auth が止まっても、新しいログインができなくなるだけで、既存のセッションと訪問者向けの機能は影響を受けない。

設計の出典: `docs/RequirementDefinition/AA/05-application-decisions.md` の ADR-13、`TA/06-aws-runtime.md` の 5.2・5.2.1、`TA/04-security-and-secrets.md` の 6 節、Lambda 化は `docs/superpowers/specs/2026-10-12-admin-auth-lambda-design.md`。

## 構成

```
src/handler.ts                    入口に依存しない本体（Request → Response）。Better Auth・内蔵の画面・ヘルスチェックへの振り分け。例外を投げない
src/server.ts                     開発の入口（3103）。toNodeHandler で handler を包む
src/lambda.ts                     本番の入口（ALB のマルチバリューのイベント ⇄ Request/Response）。秘密値の読み込み、60 秒のアイドルのあとの DB の接続の作り直し
src/ops.ts                        運用の入口（admin-auth-ops。{"action":"migrate"}・{"action":"register-alb-client",…}）
src/operations.ts                 migrate と ALB クライアントの登録の本体（開発の CLI と ops.ts で共有）
src/index.ts                      開発の起動と停止
src/config.ts                     zod で環境変数を検証（loadConfig は終了、parseConfig は例外）
src/auth.ts                       Better Auth の設定（Google ログイン、hd・許可リストの検査、jwt・oauthProvider プラグイン）
src/allowlist.ts                  許可リストの表（admin_allowlist）の操作
src/pages.ts                      ログイン画面・同意画面・エラー画面（外部のスクリプトや画像を読み込まない。nonce 付きの CSP）
src/secrets.ts                    Secrets Manager の読み込み（本番の 2 つの入口）
src/scripts/migrate.ts            開発の CLI（pnpm db:migrate・compose の migrate）
src/scripts/register-alb-client.ts  開発の CLI（pnpm alb:register）
```

依存は `better-auth`・`@better-auth/oauth-provider`（どちらも `1.7.6`。7 日の待機〈`minimumReleaseAge`〉を満たす最新）・`pg`・`zod` だけ。

### エンドポイント

| パス | 内容 |
|---|---|
| `GET /.well-known/openid-configuration` | OIDC の discovery。issuer 配下（`/api/auth/.well-known/openid-configuration`）の同じ内容への別名 |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 のメタデータ（同上の別名。issuer の後ろにパスを付ける形も返す） |
| `GET /api/auth/jwks` | 署名の公開鍵（RS256） |
| `GET /api/auth/oauth2/authorize` | 認可（ALB が使う） |
| `POST /api/auth/oauth2/token` | トークン（ALB が使う） |
| `GET /api/auth/oauth2/userinfo` | UserInfo（ALB が使う） |
| `POST /api/auth/sign-in/social`、`GET /api/auth/callback/google` | Google ログイン |
| `GET /sign-in` | ログイン画面（認可フローから遷移してくる） |
| `GET /consent` | 同意画面（`skip_consent` で通るため通常は出ない） |
| `GET /error` | ログイン失敗の画面 |
| `GET /healthz` | 開発のヘルスチェック（200）。**DB は見ない**。本番の ALB ではヘルスチェックを使わない（Lambda。ADR-26） |

`/api/auth/token`（JWT プラグインの素のトークン発行）は `disabledPaths` で無効にしている（OAuth Provider を使うときの必須設定）。メールとパスワードのログイン・サインアップも無効。

## ログインの通し方（3 段の検査）

どれか 1 つが漏れても通らないようにしてある。

| 段 | どこで | 何を見るか |
|---|---|---|
| 1 | Google プロバイダーの `hd` オプション（Better Auth） | Google が署名して返した ID トークンの `hd` クレームが `GOOGLE_HOSTED_DOMAIN` と一致すること。`hd` が無いトークンは拒否。**認可リクエストの `hd` パラメータは画面の候補を絞るだけで制限にならない**ため、サーバー側の検査を入れている |
| 2 | `mapProfileToUser`（このサービス） | Google の profile の `hd` が `GOOGLE_HOSTED_DOMAIN` と一致し、`email_verified` が true であること（1 段目と独立にもう一度見る） |
| 3 | `databaseHooks`（このサービス） | メールが `@<GOOGLE_HOSTED_DOMAIN>` で終わり、かつ `admin_allowlist` の表にあるときだけ、**ユーザーの作成と、セッションの作成**を許す。許可リストから外された人は、すでにユーザーがあっても新しいセッションを作れない |

「Workspace のアカウントを持つこと」と「管理画面に入ってよいこと」は別。Workspace に外部のメールアドレスで作られた Google アカウントは `hd` を持たないため、1・2 段目で止まる。

拒否したときは、メールアドレスを記録せず、理由の種類だけを stderr に出す（`email is not on the allowlist` など）。

### 許可リストの運用

- 初期値は `ADMIN_BOOTSTRAP_EMAILS`（カンマ区切り）。**`migrate` の最後に表へ追加するだけ**で、削除はしない（2026-10-12 に起動時から移した。本番は運用の Lambda の migrate）。
- 追加と削除は人が SQL で行う（本番では Session Manager のポートフォワードで RDS に入る。admin-auth は Lambda で、ECS Exec の入り口にならない。踏み台サーバーは置かない。TA-06 の 5.6）。BA-05 の参加時・離任時のチェックリストに含める。

```sql
-- 追加（小文字で書く。表の CHECK 制約が小文字以外を拒否する）
INSERT INTO admin_allowlist (email, added_by) VALUES ('person@comegin.com', 'manual');

-- 削除（離任時。Google Workspace のアカウントの停止と、両方を行う）
DELETE FROM admin_allowlist WHERE email = 'person@comegin.com';
-- admin-auth 自身のセッションも失効させる
DELETE FROM session WHERE "userId" IN (SELECT id FROM "user" WHERE email = 'person@comegin.com');
```

**削除しても、ALB が発行済みのセッション Cookie は最大 12 時間は有効なまま**（ALB は自分の Cookie だけで判定するため、admin-auth には問い合わせない）。即時に締め出す必要があるときは、Google Workspace のアカウントの停止に加えて、各製品側のアカウントとトークンも止める。

## ALB 側の設定値（`authenticate-oidc`）

ALB は discovery を読まず、URL を人（SAM）が明示する。**issuer は `https://auth.comegin.com/api/auth`**（`/api/auth` の分を含む）。ID トークンの `iss` と一致させる。

| ALB の項目 | 値 |
|---|---|
| `Issuer` | `https://auth.comegin.com/api/auth` |
| `AuthorizationEndpoint` | `https://auth.comegin.com/api/auth/oauth2/authorize` |
| `TokenEndpoint` | `https://auth.comegin.com/api/auth/oauth2/token` |
| `UserInfoEndpoint` | `https://auth.comegin.com/api/auth/oauth2/userinfo` |
| `ClientId` / `ClientSecret` | `ALB_CLIENT_ID` / `ALB_CLIENT_SECRET` と同じ値（本番は同じ Secrets Manager の Secret から ALB と admin-auth の両方に渡す） |
| `Scope` | `openid email profile`（ALB は access token を UserInfo に送るため、`email` と `profile` も要る） |
| `SessionTimeout` | `43200`（12 時間） |
| `OnUnauthenticatedRequest` | `authenticate` |
| 対象 | `ALB_PROTECTED_HOSTS` の各ホスト（TA-06 の 5.2 の優先度 4。管理画面の側） |

- **リダイレクト URI** は、保護するホストごとに `https://<host>/oauth2/idpresponse`。登録は `register-alb-client.ts` が行う（下記）。
- クライアント認証の方式は既定で `client_secret_basic`（トークンエンドポイントの Authorization ヘッダー）。
- `auth.comegin.com` 自身は ALB の認証なしで通す（TA-06 の 5.2 の優先度 3）。IdP の DNS が公開で名前解決でき、証明書が公的な認証局の発行であること（ACM）が条件。

### Google Cloud 側

- OAuth クライアントを「ウェブアプリケーション」で作り、**ユーザータイプは「内部」**（Workspace の組織内のアカウントだけ）にする。
- 承認済みのリダイレクト URI: `https://auth.comegin.com/api/auth/callback/google`（開発は `http://localhost:3103/api/auth/callback/google`）。
- `GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET`（secret）を admin-auth に渡す。
- Google Workspace の 2 段階認証を組織で必須にする（admin-auth は MFA を持たない。ログインの強さは Google 側で担保する）。

## 環境変数

`.env.example` が正本。

| 変数 | 内容 | secret |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `3103`（開発の入口だけ） | |
| `NODE_ENV` | `production` では `GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET` が必須（運用の Lambda は除く。Google を使わない）。本番の Lambda は `production`（テンプレートで渡す）、compose は `development` | |
| `BETTER_AUTH_URL` | `https://auth.comegin.com`（開発 `http://localhost:3103`）。issuer は `${BETTER_AUTH_URL}/api/auth` | |
| `BETTER_AUTH_SECRET` | 32 文字以上。**変えると既存のセッションと、暗号化して DB に置いた値（JWKS の秘密鍵・Google のトークン）が使えなくなる** | ✔ |
| `DATABASE_HOST` `DATABASE_PORT` `DATABASE_NAME` `DATABASE_USERNAME` `DATABASE_SSL` | PostgreSQL（DB 名 `admin_auth`）。RDS では `DATABASE_SSL=true`（証明書を検証する） | |
| `DATABASE_PASSWORD` | | ✔ |
| `GOOGLE_CLIENT_ID` | | |
| `GOOGLE_CLIENT_SECRET` | | ✔ |
| `GOOGLE_HOSTED_DOMAIN` | 既定 `comegin.com`（ID トークンの `hd` と照合） | |
| `ADMIN_BOOTSTRAP_EMAILS` | 許可リストの初期値（カンマ区切り。migrate のときに表へ追加するだけ） | |
| `ALB_CLIENT_ID` | ALB の OIDC クライアント ID（登録（開発の CLI と運用の Lambda）だけが使う） | |
| `ALB_CLIENT_SECRET` | 同上（32 文字以上） | ✔ |
| `ALB_PROTECTED_HOSTS` | `/oauth2/idpresponse` を登録するホスト（カンマ区切り。登録（開発の CLI と運用の Lambda）だけが使う） | |
| `SECRETS_PREFIX` | 本番の 2 つの入口だけ。秘密値の Secret の接頭辞（`comegin/<env>/admin-auth`）。開発は使わない | |

設定が不正なときは、変数名と理由だけを stderr に出して終了する（値は出さない）。Lambda の入口は終了せず例外を投げる（本体は ALB が 502、運用は `FunctionError`）。

本番の Lambda は、実行環境にある Amazon の CA（RDS を含む）を `NODE_EXTRA_CA_CERTS=/var/runtime/ca-cert.pem` で読む（Node 20 以降の Lambda は既定では読み込まないため）。`DATABASE_SSL=true` で RDS に証明書を検証してつなぐのに要る。開発の Docker イメージには入れない（開発の PostgreSQL は TLS を使わない）。

## 起動（ローカル）

```bash
pnpm install
dev/init-env.sh                   # .env.example を写して、秘密値（BETTER_AUTH_SECRET・DATABASE_PASSWORD・ALB_CLIENT_ID・ALB_CLIENT_SECRET）を生成する。冪等で、値は表示しない
# 生成された環境変数ファイルに GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / ADMIN_BOOTSTRAP_EMAILS を人が入れる
docker compose up -d --build      # postgres → migrate（一度だけ）→ admin-auth の順に起動。admin-auth は 127.0.0.1:3103 だけに開く。migrate が許可リストの初期値も入れる
curl -s localhost:3103/.well-known/openid-configuration
curl -s localhost:3103/api/auth/jwks
```

- PostgreSQL は `127.0.0.1:5434` にだけ開いている（結合テストが Lambda の入口から直接つなぐため）。
- Google の ID とシークレットが空でも、discovery と JWKS は返る（ログインはできない）。
- ALB を信頼済みクライアントとして登録する:

```bash
docker compose run --rm --no-deps admin-auth node dist/scripts/register-alb-client.js
# 本番は運用の Lambda（admin-auth-ops）で {"action":"migrate"} のあとに {"action":"register-alb-client"} を呼ぶ（cloud/README の 4.19）
```

### テスト

```bash
pnpm test               # 単体（外部はモック）
pnpm test:integration   # 結合: ALB の形のイベントで lambda.ts（本体）と ops.ts（運用）を呼び、開発の PostgreSQL（127.0.0.1:5434）を本物として使う。PostgreSQL を数秒 docker pause する
```

## ALB クライアントの登録（`register-alb-client.ts`）

- 本番は運用の Lambda で行う（`{"action":"register-alb-client"}` を送る。呼び出し方は `cloud/README.md` の 4.19。`authMethod`・`requirePkce` で下のオプションと同じ指定ができる）。
- `ALB_CLIENT_ID` が無ければ作成し（`created`）、あれば内容を比べて、違うときだけ更新する（`updated`）。**同じ内容なら何も書かない**（`unchanged`。`updatedAt` も変わらない）。`ALB_PROTECTED_HOSTS` にホストを足して再実行すれば、リダイレクト URI だけが増える。**`ALB_CLIENT_SECRET` を変えて再実行すれば、シークレットが入れ替わる**（前のシークレットは即座に使えなくなる。ALB のリスナールールの `ClientSecret` も同時に更新すること）。
- 登録する内容: 機密クライアント、`grant_types=authorization_code`、`scope=openid profile email`、`skip_consent=true`（同意画面を省略）、`enable_end_session=false`、リダイレクト URI は `ALB_PROTECTED_HOSTS` の各ホストの `https://<host>/oauth2/idpresponse`。シークレットは Better Auth の既定と同じ SHA-256（base64url）で保存し、表示しない。
- Better Auth の公開 API（`adminCreateOAuthClient`）はログイン済みのユーザーのセッションを要求し、`client_id` も指定できない。ALB と同じ ID・シークレットを Secrets Manager から両方に渡す構成にするため、**Better Auth のアダプターで `oauthClient` の行を直接書く**。plugin のバージョンを上げたときは、このスクリプトが書く列とシークレットの保存方式が変わっていないかを確かめる。
- オプション（どちらも ALB での実地確認の結果で切り替える。下記）:
  - `--auth-method=client_secret_post`: ALB がトークンエンドポイントの認証をリクエスト本文で行うとき。
  - `--require-pkce`: ALB が PKCE に対応していると確認できたとき。

## 実地で確認した点・未確認の点

### ローカルで確認した（ALB と Google は使わず、`curl` と DB への直接のセッション作成で再現）

- discovery（ルートと `/api/auth` 配下で同一）と JWKS（RS256）が返る。
- 許可リスト外のメールと、ドメイン外のメールは、ユーザーを作れない。許可リストから外すと、既存のユーザーでもセッションを作れない。
- Google の ID トークン（署名なしの作り物）で `hd` の検査を確かめた。`hd=comegin.com` は通り、`hd` が違うもの・`hd` が無いものは Better Auth が拒否して（ユーザー情報を返さない）、ユーザーもセッションも作られない。`email_verified=false` は `mapProfileToUser` が拒否する。
- 登録スクリプトを 2 回続けて実行しても何も変わらない（`unchanged`）。ホストを足すと `updated` になり、リダイレクト URI が増える。
- ALB と同じ手順（認可 → コード → トークン → UserInfo）が通る。
  - 未ログインの認可リクエストは `/sign-in?...&sig=...` へ。ログイン済みなら、同意画面なしで `https://<host>/oauth2/idpresponse?code=...&state=...&iss=...` へ戻る。
  - `client_secret_basic` でトークンを取得でき、ID トークンは RS256、`aud` はクライアント ID、`nonce` が戻る。`client_secret_post` に登録し直せば、post でも取得できる。
  - UserInfo は `sub`・`name`・`email`・`email_verified` を返す。
  - コードの再利用、シークレット違い、登録外のリダイレクト URI は拒否される。**認証に失敗した試行でも、そのコードは使えなくなる。**

### 実地で未確認（ALB と Google の実機が要る）

- **ALB のトークンエンドポイントのクライアント認証方式。** AWS のドキュメントで確認できなかった。Better Auth は登録した方式だけを受け付けるため、ALB が post を使うなら `invalid_client`（400）になる。その場合は `--auth-method=client_secret_post` で登録し直す。
- **ALB が PKCE を送るか。** Better Auth は既定で PKCE を必須にする。ALB が PKCE に対応しているか確認できなかったため、**登録スクリプトは PKCE を必須にしない**（機密クライアントで、シークレットと `state`・`nonce` で守られる。Better Auth が互換性のために用意している設定）。ALB の対応が確認できたら `--require-pkce` を付けて登録し直す。
- **ALB が ID トークンの署名を検証するか、その鍵の種類。** Better Auth の既定は EdDSA だが、ALB が対応するか確認できないため、最も互換性の高い RS256 にしてある。
- **ALB の UserInfo の呼び出し。** ALB は access token を UserInfo に送り、返ったクレームを `X-Amzn-Oidc-*` ヘッダーに載せる。ローカルでは `curl` で同じ呼び出し（`Authorization: Bearer <access token>`）が通ることまでを確かめた。ALB が実際に送る形（スコープの組み合わせ、`email` クレームの有無、クレームの大きさの上限 11 KB）は、ALB 越しにログインして `X-Amzn-Oidc-Data` を確かめるまで分からない。
- **ログイン画面から認可フローが続くか。** `/sign-in` は、認可リクエストの署名つきクエリ（`oauth_query`）を `POST /api/auth/sign-in/social` に付けて渡す（`@better-auth/oauth-provider` のクライアントと同じ規則）。Google ログインのあとに、保留していた認可リクエストが続いて ALB へ戻るかは、本物の Google ログインが無いと確かめられていない。
- **`mapProfileToUser` が拒否したときの画面。** Google のコールバックの途中で拒否した場合に、`/error` へ遷移するか、Better Auth の既定のエラーページになるかを確認していない（どちらでも、ログインは通らない）。
- **ALB が認可のレスポンスに付く `iss` パラメーター（RFC 9207）を無視するか。** Better Auth は常に付ける。
- **ALB 配下でのレート制限。** Better Auth のレート制限は `X-Forwarded-For` の先頭の値を送信元とみなす。ALB は送信元を末尾に足すだけなので、先頭は詐称できる。**実効のあるレート制限は ALB の WAF に頼る**（TA-06 の 5.5。`auth.` にもかける）。

## 運用上の注意

- ログは stderr に JSON の 1 行（時刻・メソッド・パス・ステータス・所要時間）。クエリ（認可コードや署名を含む）とメールアドレスは記録しない。
- JWKS の鍵のローテーションは有効にしていない（`rotationInterval` なし）。鍵の秘密鍵は `BETTER_AUTH_SECRET` で暗号化して DB に置く。
- SIGTERM での停止（猶予 10 秒）は開発の入口だけ。本番の Lambda は、前の呼び出しから 60 秒以上空いたら処理の前に DB の接続（プール）と auth を作り直す（凍結のあいだに切れた接続で固まらないように）。
- **`migrate` の前は許可リストの表が無く、ログインの判定が 500 になる**（起動時の検査はやめた。`migrate` を先に実行する）。
- 本番のバックアップは RDS の自動バックアップとポイントインタイムリカバリ（TA-06 の 4.5）。許可リストの表も同じ DB にある。
- Better Auth のレート制限はメモリ上にあり、Lambda では実行環境ごとに分かれる。実効のあるレート制限は ALB の WAF に頼る（上の「ALB 配下でのレート制限」と同じ）。

## TODO

- `better-auth` と `@better-auth/oauth-provider` を 1.7.7（2026-09-30 公開）へ上げる。公開から 7 日（`minimumReleaseAge`）を過ぎた 2026-10-07 以降に、2 つを同じ版で上げて、`register-alb-client.ts` が書く列とシークレットの保存方式が変わっていないかを確かめる。
- 実機の Google ログインと ALB を通した動作確認（上の「実地で未確認」の項目。バックエンド構築の Wave 4）。
