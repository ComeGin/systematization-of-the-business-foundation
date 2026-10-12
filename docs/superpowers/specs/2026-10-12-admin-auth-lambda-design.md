# admin-auth の Lambda 化（ADR-26 のサブプロジェクト ③）の設計

- 日付: 2026-10-12
- 状態: 設計の承認待ち（会話での設計はユーザーが 3 節とも承認済み）
- 対象: サブプロジェクト ③ 「admin-auth を ECS on Fargate から VPC の中の Lambda に移す」
- 前提: ADR-26（`docs/RequirementDefinition/AA/05-application-decisions.md`）、② の仕様（`docs/superpowers/specs/2026-10-12-consent-api-lambda-design.md`。入口の分け方・ターゲットグループの置き場所・bundle の注意の前例）、faq-bot の仕様（`docs/superpowers/specs/2026-10-11-faq-bot-design.md`）

## 1. 目的と合意した理解

**目的**: ADR-26 に従い、管理画面の関門 admin-auth（Better Auth を OIDC Provider にした、ALB の `authenticate-oidc` の IdP）を ECS on Fargate（常時 1 タスク）から VPC の中の Lambda に移し、呼ばれないあいだの費用をなくす。**OIDC のエンドポイント・ログインの 3 段の検査・許可リスト・画面の振る舞いは変えない。**

**ユーザーが決めたこと（2026-10-12）**

| # | 決定 |
|---|---|
| D1 | **IdP の応答時間の実測（Wave 4）を待たずに Lambda にする**（ADR-26 の帰結の「実測してから決める」を置き換える）。根拠: ALB がトークンと UserInfo を呼ぶ数秒前に、ブラウザが同じ関数を 3 回呼ぶ（認可 → ログイン画面 → Google のコールバック）ため、ALB の呼び出しの時点で関数は起動済みである見込みが高い。**備えとして、プロビジョニングされた同時実行数をパラメータで有効にできるようにする**（既定 0）。Wave 4 で実測する |
| D2 | テストは**単体と結合の両方を作り、実行する**（② と同じ。`.claude/rules/devops-testing.md` の「明確な指示」にあたる） |
| D3 | DB の移行（`migrate`）と ALB のクライアントの登録（`register-alb-client`）は、**運用専用の Lambda（`admin-auth-ops`）**で行う。ALB にはつながず、運用者が `aws lambda invoke` で呼ぶ |
| D4 | 2・3 節の構成（ターゲットグループを関数のスタックに置く、マルチバリューヘッダーを有効にする、DB の接続をアイドルのあとに作り直す、許可リストの初期値を `migrate` に移す） |
| D5 | 開発の PostgreSQL を `127.0.0.1:5434` に開く（結合テスト用） |
| D6 | cloud/README の 4 章の節番号の重複（faq-bot の 4.14、② の consent-api の 4.15 が既存の 4.14・4.15 と重なる）を直し、faq-bot を 4.17、consent-api を 4.18、admin-auth を 4.19 にする |

**確かめた事実（2026-10-12）**

- **本番は一度もデプロイしていない**（`cloud/README.md`）。IaC の書き換えだけで済む。
- **Better Auth は Web 標準の `Request` → `Response` で動く**（`auth.handler`）。`better-auth/node` の `toNodeHandler` は、`auth` だけでなく同じ形の関数も受け取る（`node_modules/better-auth/dist/integrations/node.d.mts`）。内部の `better-call` の `getRequest` は、`x-forwarded-proto` と `host` から URL を組み立てる。
- **Better Auth はログインの途中で `Set-Cookie` を複数返す**（状態・セッションなど）。ALB→Lambda の既定（マルチバリューヘッダーが無効）では `Set-Cookie` は 1 つしか返せない（AWS の公式文書「Use Lambda functions as targets of an Application Load Balancer」）。
- 同じ文書より: マルチバリューヘッダーを有効にすると、要求のヘッダーとクエリは `multiValueHeaders`・`multiValueQueryStringParameters` で配列になり、応答も `multiValueHeaders` で返す。**クエリが URL エンコードされていても ALB はデコードしない。** 本文は `content-encoding` が無く、`Content-Type` が `text/*`・`application/json`・`application/javascript`・`application/xml` のときだけそのまま、それ以外（フォーム形式のトークンの要求を含む）は base64 で渡る。
- **Node 20 以降の Lambda は Amazon の CA（RDS を含む）を既定では読み込まない。** `/var/runtime/ca-cert.pem` にあり、`NODE_EXTRA_CA_CERTS` で読ませる（AWS の公式文書「Building Lambda functions with Node.js」。コールドスタートが延びるので、必要な証明書だけを同梱する方法も推奨されている）。
- **`pg`・`ioredis` などは CommonJS で `require` を呼ぶ。** ESM の bundle では `require` を用意しないと読み込みの時点で失敗する（② の最終レビューで判明。② の仕様 3.5）。
- **ALB が IdP のトークンと UserInfo の応答を何秒待つかは、今回も公式文書で見つからなかった**（ALB の認証の文書・トラブルシューティング）。D1 により実測は Wave 4 に回す。
- Secrets（`cloud/stacks/secrets.yaml`）: `comegin/<env>/admin-auth/` の下に `BETTER_AUTH_SECRET`・`DB_PASSWORD`・`GOOGLE_CLIENT_SECRET`・`ALB_CLIENT_SECRET`。
- DB とアプリ用ユーザーの作成（`cloud/stacks/ops-tasks.yaml` の ECS の RunTask）は Mautic・Chatwoot・Strapi・n8n と共有している。

## 2. AWS の構成（`cloud/`）

### 2.1 ALB（`stacks/edge.yaml`）

- ルール 300（`auth.` のホスト全体 → admin-auth。ログインの途中なので認証なし）は**変えない**。OIDC のルール（1001・1002）も変えない（IdP のエンドポイントを URL で呼ぶだけ。ALB は IdP の DNS をインターネット経由で引くため、`auth.` → ALB → Lambda の経路になる）。WAF も変えない。
- **admin-auth のターゲットグループを edge から `stacks/services/admin-auth.yaml` に移す**（② と同じ理由。CloudFormation で Lambda を登録する手段は `TargetGroup` の `Targets` だけで、edge に置くと循環する）。edge はルール 300 の転送先として、親から `AdminAuthTargetGroupArn` を受け取る。
- ターゲットグループ: `TargetType: lambda`、**名前を固定**（`comegin-<env>-admin-auth`）、`Targets` は本体の関数の**エイリアス `live`**、**ヘルスチェックは無効**、**マルチバリューヘッダーは有効**（`lambda.multi_value_headers.enabled: true`）。
- ALB からの呼び出しの許可（`AWS::Lambda::Permission`）: `FunctionName` はエイリアスの ARN、`Principal: elasticloadbalancing.amazonaws.com`、`SourceAccount`、`SourceArn` は `arn:<partition>:elasticloadbalancing:<region>:<account>:targetgroup/comegin-<env>-admin-auth/*`。ターゲットグループに `DependsOn` で許可を付ける（② と同じ）。
- edge から外すもの: `AdminAuthPort`・`AdminAuthHealthCheckPath` のパラメータ、`AdminAuthTargetGroup`、出力の `AdminAuthTargetGroupArn`・`AdminAuthTargetGroupFullName`。出力の `AlbProtectedHosts` は残す（README と親の出力が使う）。

### 2.2 本体の Lambda（`admin-auth`。`stacks/services/admin-auth.yaml` を書き換え）

| 項目 | 値 | 理由 |
|---|---|---|
| 型 | `AWS::Serverless::Function`。`Metadata.BuildMethod: makefile`（`build-AdminAuthFunction`） | ② と同じ |
| ランタイム | `nodejs22.x`・`arm64` | ② と同じ |
| Handler | `index.handler`（`dist-lambda/index.mjs`） | |
| メモリ | **512 MB** | Better Auth と `pg` が重い。メモリに比例して CPU が増え、コールドスタートが短くなる |
| タイムアウト | **10 秒** | DB の接続（5 秒）と問い合わせ（5 秒）の上限。ALB の IdP の呼び出しを長く待たせない |
| 予約同時実行数 | **5**（パラメータ `ReservedConcurrency`） | 管理者だけが使う。RDS の接続数の上限（5 × 2）にもなる |
| プロビジョニングされた同時実行数 | パラメータ `ProvisionedConcurrency`（既定 **0**）。0 より大きいときだけエイリアスに `ProvisionedConcurrencyConfig` を付ける（条件つき） | D1 の備え。Wave 4 の実測で IdP の呼び出しが遅いと分かったら 1 にする（常時 1 つ起動で、月 4〜5 USD 前後〈概算〉） |
| エイリアス | `AutoPublishAlias: live` | 2.1 |
| VPC | private サブネット、既存の `AdminAuthSecurityGroup` | RDS（5432）と、NAT 経由の Google・Secrets Manager に届く |
| 環境変数 | `NODE_ENV=production`、`BETTER_AUTH_URL=https://<AuthHost>`、`DATABASE_HOST`・`DATABASE_PORT`・`DATABASE_NAME`・`DATABASE_USERNAME`・`DATABASE_SSL=true`、`GOOGLE_CLIENT_ID`、`GOOGLE_HOSTED_DOMAIN`、`NODE_EXTRA_CA_CERTS=/var/runtime/ca-cert.pem`、`SECRETS_PREFIX=<SecretNamePrefix>/admin-auth` | 秘密値は環境変数に置かない（3.6） |
| 実行ロール | `secretsmanager:GetSecretValue` を **`admin-auth/BETTER_AUTH_SECRET-*`・`admin-auth/DB_PASSWORD-*`・`admin-auth/GOOGLE_CLIENT_SECRET-*` の 3 つだけ**（`ALB_CLIENT_SECRET` は読めない）、ログ、VPC の ENI（SAM が付ける） | 本体は ALB のクライアントシークレットを使わない |
| ロググループ | `/aws/lambda/comegin-<env>-admin-auth`（保持期間はパラメータ。既定 30 日） | `cluster.yaml` の `/comegin/<env>/admin-auth` は外す |

- 出力: `FunctionName`・`AliasArn`・`TargetGroupArn`・`TargetGroupFullName`。

### 2.3 運用の Lambda（`admin-auth-ops`。同じテンプレート）

| 項目 | 値 | 理由 |
|---|---|---|
| Handler | `ops.handler`（`dist-lambda/ops.mjs`。`build-AdminAuthOpsFunction`） | |
| メモリ・タイムアウト | 512 MB・**60 秒** | 移行は時間がかかりうる |
| 予約同時実行数 | **1** | 移行と登録が重ねて走らないように |
| エイリアス | なし（ALB に登録しない） | |
| VPC | 本体と同じサブネットと SG | |
| 環境変数 | 本体と同じ DB・`BETTER_AUTH_URL`・`GOOGLE_HOSTED_DOMAIN`・`NODE_EXTRA_CA_CERTS`・`SECRETS_PREFIX`、加えて `ADMIN_BOOTSTRAP_EMAILS`・`ALB_CLIENT_ID`・`ALB_PROTECTED_HOSTS`。`GOOGLE_CLIENT_ID` は渡さない | |
| 実行ロール | `BETTER_AUTH_SECRET`・`DB_PASSWORD`・`ALB_CLIENT_SECRET` の 3 つだけ（Google の秘密値は読めない） | 移行と登録に Google は要らない |
| 呼び出し | 運用者の IAM の主体が `lambda:InvokeFunction` で呼ぶ（リソースベースの許可は付けない） | ALB・インターネットから呼べない |

- 出力: `OpsFunctionName`（親の出力にも出す。README の手順で使う）。
- 親の出力 `AdminAuthSecurityGroupId`（RunTask 用）は外し、`AdminAuthOpsFunctionName` に替える。

### 2.4 ネットワーク（`stacks/network.yaml`）

- **外す**: `AdminAuthPort` のパラメータ、ALB の SG の admin-auth への外向きの許可（`To admin-auth`）、`AdminAuthFromAlb`。
- **残す**: `AdminAuthSecurityGroup`（`GroupDescription` は変えない）とその外向き、`PostgresFromAdminAuth`。ALB の SG の 443 の外向き（IdP の呼び出し）も残す。

### 2.5 監視（`stacks/alarms.yaml`）

**外す**: `AdminAuthRunningTaskAlarm`・`AdminAuthUnhealthyHostAlarm`。

**足す**（② と同じ形。SNS の `ops`。`TreatMissingData: notBreaching`。OK のときも送る）:

| アラーム | メトリクス | 条件 | 拾うもの |
|---|---|---|---|
| `admin-auth-errors` | `AWS/Lambda` の `Errors`（本体） | 1 分の合計 > 0 | 例外・タイムアウト・初期化の失敗 |
| `admin-auth-throttles` | `AWS/Lambda` の `Throttles`（本体） | 1 分の合計 > 0 | 予約同時実行数（5）に達した |
| `admin-auth-target-5xx` | `AWS/ApplicationELB` の `HTTPCode_Target_5XX_Count`（ターゲットグループ） | 5 分の合計 ≥ 1 | DB の障害などで Better Auth・handler が 500 を返した（応答として返すため `Errors` に数えられない） |

- admin-auth は止まっても既存の ALB のセッション（12 時間）のあいだは誰も困らないため、**このアラームでしか気づけない**（TA-05 の項目 12 の性質は変わらない）。
- 運用の Lambda にはアラームを付けない（運用者が呼び出しの結果を見る）。

### 2.6 親テンプレートと、ほかのスタック

- `template.yaml`:
  - `AdminAuthService` のパラメータを Lambda の分に替える。`ClusterArn`・`LogGroupName`・`ImageRepositoryUri`・`ImageTag`・`DesiredCount`・`Cpu`・`Memory`・`ContainerPort`・`TargetGroupArn`・`EnableExecuteCommand`・`HealthCheckGracePeriodSeconds` を外し、`ReservedConcurrency`・`ProvisionedConcurrency` を渡す。
  - **`AlbProtectedHosts` は `EdgeStack` の出力ではなく、親で `!Join [',', [!Ref ChatHost, !Ref MktHost]]` として渡す**（edge が admin-auth のターゲットグループを参照するようになるため。edge の出力を使うと循環する。値は同じ）。
  - `EdgeStack` に `AdminAuthTargetGroupArn: !GetAtt AdminAuthService.Outputs.TargetGroupArn` を渡す。`NetworkStack`・`EdgeStack` の `AdminAuthPort` を外す。
  - 親のパラメータ `AdminAuthPort`・`AdminAuthImageTag`・`AdminAuthDesiredCount`・`AdminAuthCpu`・`AdminAuthMemory` を外し、`AdminAuthReservedConcurrency`（既定 5）・`AdminAuthProvisionedConcurrency`（既定 0）を足す。`AdminBootstrapEmails` は運用の Lambda に渡す。
  - `AlarmsStack` に本体の関数名とターゲットグループの名前を `AdminAuthService` の出力から渡す。
- `stacks/ecr.yaml`: `AdminAuthRepository` と出力を外す（ECR は Mautic・Chatwoot の 2 本になる）。
- `stacks/cluster.yaml`: `AdminAuthLogGroup` と出力を外す。
- `stacks/ops-tasks.yaml`: 変えない（DB の作成は共有のタスク）。

## 3. コード（`backend/admin-auth/src/`）

### 3.1 ファイルと責務

| ファイル | 責務 | 変更 |
|---|---|---|
| `handler.ts` | **入口に依存しない本体**。`createHandler({ auth })` が `(req: Request) => Promise<Response>` を返す。今の `index.ts` の振り分けをそのまま移す: `GET`・`HEAD` の `/healthz`（DB は見ない）、ルート直下の discovery 2 本を `/api/auth` 配下への別名として付け替える、`/api/auth/*` と `/.well-known/*` は `auth.handler`、`GET`・`HEAD` の `/sign-in`・`/consent`・`/error` は内蔵の画面（nonce 付きの CSP）、それ以外は 404。1 件 1 行のログ（時刻・メソッド・パス・ステータス・所要時間。**クエリとメールは出さない**）。**例外を投げない**（想定外の失敗は 500 の `internal error`） | 新規（中身は移動） |
| `server.ts` | 開発の入口（3103）。`toNodeHandler(handle)` を `http.createServer` で包む。要求ターゲットを URL として解釈できない要求（`//[` など）は 400 の `bad request`（今と同じ）。`toNodeHandler` が投げたら 500。keep-alive・タイムアウトの設定は今のまま | 新規 |
| `lambda.ts` | 本番の入口。ALB のマルチバリューの形のイベント ⇄ `Request`/`Response`（3.2）、初期化（3.3）、DB の接続の作り直し（3.4） | 新規 |
| `ops.ts` | 運用の入口。`{ action: "migrate" }` と `{ action: "register-alb-client", authMethod?: "client_secret_basic" \| "client_secret_post", requirePkce?: boolean }` を受け、結果の JSON（`{ ok: true, action, result }`）を返す。不正な入力は例外にせず `{ ok: false, error }` を返す。実行の失敗は例外（`Errors` に数え、呼び出し元に見える） | 新規 |
| `operations.ts` | 今の `scripts/migrate.ts`・`register-alb-client.ts` の中身を関数にしたもの。`runMigrate(pool, authOptions, bootstrapEmails)` は移行 → 許可リストの表の作成 → **許可リストの初期値の追加**（3.5）を行い、作った表・足した列・追加した件数を返す。`registerAlbClient(auth, alb, { authMethod, requirePkce })` は `"created" \| "updated" \| "unchanged"` と登録したリダイレクト URI を返す | 新規（中身は移動） |
| `config.ts` | ② と同じく、例外を投げる `parseConfig(env, { requireGoogle })` を足す（`requireGoogle` の既定は `NODE_ENV=production` のとき真。運用の入口は偽を渡す）。`loadConfig` は今の出力のまま終了する | 追加 |
| `db.ts` | `createPool(config, overrides?)` で、Lambda の入口がプールの大きさと問い合わせのタイムアウトを渡せるようにする | 追加 |
| `index.ts` | 開発の起動（`createServer(createHandler({ auth }))`）と停止（SIGTERM）。**許可リストの初期値の追加はしない**（3.5） | 縮小 |
| `scripts/migrate.ts`・`scripts/register-alb-client.ts` | 開発の CLI（`pnpm db:migrate`・`pnpm alb:register`）。引数の解釈と、`operations.ts` の呼び出しと、結果の表示だけ | 縮小 |
| `auth.ts`・`allowlist.ts`・`pages.ts`・`constants.ts` | 今の部品 | そのまま（定数の追加は可） |

### 3.2 ALB のイベントの変換（`lambda.ts`。マルチバリューヘッダーが有効）

- 要求:
  - ヘッダーは `multiValueHeaders` の値をすべて `Headers` に `append` する（名前は小文字に）。
  - URL は `https://<host>` ＋ `path` ＋ クエリ。クエリは `multiValueQueryStringParameters` の各キーと値を、**ALB がデコードしていないのでそのまま** `k=v` で `&` につなぐ。`host` が無ければ `BETTER_AUTH_URL` のホストを使う。
  - 本文は `GET`・`HEAD` では付けない。それ以外は `isBase64Encoded` に従って復号する（`null`・空なら本文なし）。
- 応答:
  - すべてのヘッダーを `multiValueHeaders` に入れる。`Set-Cookie` は `response.headers.getSetCookie()` で 1 つずつ配列にする（`Headers` の反復は `set-cookie` をつなげてしまうため）。
  - 本文は、`Content-Type` が `text/*`・`application/json`・`application/javascript`・`application/xml`（`+json` などを含む）ならそのまま、それ以外と型なしは base64（`isBase64Encoded: true`）。
  - `statusCode` と `statusDescription`（② と同じ形）。

### 3.3 初期化

- 初期化は**最初の呼び出しで 1 回だけ**行い、**失敗したら次の呼び出しでやり直す**（② の `createLambdaHandler` と同じ形。初期化の関数を引数で受け、テストで差し替えられるようにする）。
- 初期化の中身: 秘密値を 3 つ並行で読む（3.6）→ `parseConfig`（不正なら例外）→ `createPool`（3.4）→ `createAuth` → `createHandler`。**DB には触れない**（許可リストの初期値は `migrate` に移した。3.5）。
- 秘密値と設定は保持し、3.4 の作り直しでは読み直さない。

### 3.4 DB の接続（凍結とアイドル）

- Lambda の入口のプール: `max: 2`（1 つの実行環境が同時に処理するのは 1 件だけ。Better Auth は 1 件の中で問い合わせを並べることがある）、`query_timeout: 5000`（問い合わせが 5 秒で返らなければ失敗にする保険）。接続のタイムアウトは今の 5 秒のまま。
- **前の呼び出しの終わりから 60 秒以上空いていたら、処理の前にプールと auth と handler を作り直す**（古いプールは待たずに `end()` を始め、失敗は無視する）。理由: 凍結のあいだに通り道が接続を黙って捨てると、プールの接続は生きているように見え、最初の問い合わせが固まる（② の Valkey と同じ問題）。60 秒は、ALB がトークンと UserInfo を呼ぶ一連の流れ（ログインの数秒）では作り直さず、アイドルのあとだけ作り直す長さ。
- 時刻は差し替えられるようにする（テストのため）。

### 3.5 許可リストの初期値

- 今は、起動のたびに `ADMIN_BOOTSTRAP_EMAILS` を表へ追加し、表が無ければプロセスを止めている。**これを `migrate` の最後に移す**（開発の CLI・compose の `migrate` サービス・運用の Lambda で同じ）。
- 本体（開発の起動・Lambda）は許可リストの表に触れずに起動する。**`migrate` の前は表が無いため、ログインの判定（許可リストの照会）が 500 になる。** 手順で `migrate` を先に流す（README・cloud/README に書く）。
- 許可リストの追加と削除を人が SQL で行う運用は変えない。

### 3.6 秘密値

- 本体: `SECRETS_PREFIX` の下の `BETTER_AUTH_SECRET`・`DB_PASSWORD`・`GOOGLE_CLIENT_SECRET` を初期化で並行して読み、`parseConfig` に `BETTER_AUTH_SECRET`・`DATABASE_PASSWORD`・`GOOGLE_CLIENT_SECRET` として渡す。
- 運用: `BETTER_AUTH_SECRET`・`DB_PASSWORD`・`ALB_CLIENT_SECRET` を読み、`parseConfig(…, { requireGoogle: false })` と `loadAlbConfig` 相当の検証（例外を投げる形）に渡す。
- 読めない・値が無いときは初期化の失敗にする。**値はログにも例外のメッセージにも出さない**（Secret の名前だけ）。`@aws-sdk/client-secrets-manager` は bundle に含めない（devDependencies）。

### 3.7 ビルドと依存

- `package.json`: `bundle`（esbuild で `src/lambda.ts` → `dist-lambda/index.mjs` と `src/ops.ts` → `dist-lambda/ops.mjs`。ESM、`--external:@aws-sdk/*`、**`--banner:js` で `createRequire(import.meta.url)` から `require` を用意する**）、`test:integration`、`clean` に `dist-lambda`。devDependencies に `esbuild` と `@aws-sdk/client-secrets-manager`（② と同じ版の指定）。
- `Makefile`: `build-AdminAuthFunction`（`index.mjs` と `.map` を写す）と `build-AdminAuthOpsFunction`（`ops.mjs` と `.map` を写す）。どちらも bundle のあとに、出力を読み込めることを確かめてから写す（モジュールの最上位では接続しない）。
- `Dockerfile`・`compose.yml` は開発の起動用に残す。**RDS の CA を取る段（`rds-ca` と `NODE_EXTRA_CA_CERTS`）は本番専用だったので消す**（開発の PostgreSQL は TLS を使わない）。`.gitignore`・`.dockerignore` に `dist-lambda` を足す。

## 4. 振る舞い（変えないもの）

README の「エンドポイント」「ログインの通し方（3 段の検査）」「ALB 側の設定値」「ALB クライアントの登録」に書いてあることは、次の 2 点を除いて**そのまま**。

1. 許可リストの初期値の追加が、起動時から `migrate` の最後に移る（3.5）。
2. 本番の `migrate` と `register-alb-client` が、ECS の RunTask から運用の Lambda の呼び出しに替わる（2.3）。登録の内容（機密クライアント・`skip_consent`・リダイレクト URI・SHA-256 で保存するシークレット・`--auth-method`・`--require-pkce` に当たる指定）は変えない。

## 5. 失敗時の扱い

| 失敗 | 扱い | 管理者から見える結果 |
|---|---|---|
| コールドスタートで秘密値を読めない・設定が不正 | 初期化の失敗（例外）→ `Errors`。ALB は 502。次の呼び出しで初期化をやり直す | ログインの画面・Google のコールバック・ALB の IdP の呼び出しが失敗する。ALB のセッションが残っている人は影響を受けない |
| DB に届かない・問い合わせが 5 秒で返らない | Better Auth か handler が 500 → `admin-auth-target-5xx` | ログインできない |
| 60 秒以上のアイドルのあと | 処理の前にプールを作り直す（3.4） | 最初の要求が DB の接続のぶん遅くなる |
| 10 秒以内に終わらない | Lambda の打ち切り → `Errors`。ALB は 502 | ログインできない |
| 同時実行数の上限（5）を超える | `Throttles`。ALB は 5xx | 同上（管理者が 5 人同時にログインし続けない限り起きない） |
| `migrate` の前（許可リストの表が無い） | 許可リストの照会が失敗して 500 | ログインできない（手順で防ぐ） |
| 運用の Lambda の失敗 | 例外（呼び出し元に `FunctionError` として見える） | 運用者が結果を見てやり直す |

- **Better Auth のレート制限はメモリ上にあり、Lambda では実行環境ごとに分かれる**（ECS の 1 タスクのときより緩くなる）。もともと `X-Forwarded-For` の先頭を送信元とみなすため詐称でき、**実効のあるレート制限は ALB の WAF に頼る**としていた（README）。この扱いは変えない。

## 6. 開発環境

- 開発の起動は今のまま（`docker compose up -d --build` で 127.0.0.1:3103。`pnpm dev`）。compose の `migrate` サービスが、許可リストの初期値も入れる。
- **結合テスト（7 節）のために、開発の PostgreSQL を `127.0.0.1:5434` にだけ開く**（`compose.yml` の `ports: ["127.0.0.1:5434:5432"]`。5432 は Chatwoot、5433 は n8n）。`.claude/CLAUDE.md` のポートの表に 5434 を足す。README の「PostgreSQL はホストに公開しない」を直す。
- `.env.example` に `SECRETS_PREFIX`（本番の入口だけ。開発は使わない）の説明を足す。

## 7. テスト

② と同じ決まり（`正常系`/`異常系`、`空入力:`・`入力:`・`サーバ:` の接頭辞、外部はモック、`testTimeout`/`hookTimeout` 30 秒、src のバグは `it.todo`）。

| 種別 | 置き場 | 内容 |
|---|---|---|
| 単体 | `tests/handler.test.ts`（新規） | 今の `tests/index.test.ts` の振り分けの検査を、`handle(new Request(...))` で直接呼ぶ形に移す。`/healthz`（GET・HEAD・DB を見ない）、discovery の 2 本の別名、`/api/auth/*` と `/.well-known/*` が `auth.handler` に渡ること、画面 3 つと CSP・`no-store`、404、`auth.handler` が投げたら 500、ログにクエリとメールが出ないこと。`auth` は偽物 |
| 単体 | `tests/server.test.ts`（新規） | 開発の入口だけ: 解釈できない要求ターゲットで 400、複数の `Set-Cookie` がそのまま出ること、`x-forwarded-proto` と `host` から URL を組み立てること、keep-alive の設定 |
| 単体 | `tests/lambda.test.ts`（新規） | マルチバリューのイベント → `Request`（ヘッダーの複数値、クエリを再エンコードしない、base64 の本文、`GET` に本文を付けない、`host` が無いとき）、`Response` → 応答（`Set-Cookie` を配列で、本文の型による base64 の判断、`statusDescription`）、初期化が 1 回だけで失敗したらやり直すこと、秘密値を 3 つ読み `ALB_CLIENT_SECRET` は読まないこと、**60 秒以上空いたらプールと auth を作り直し、Secrets Manager は読み直さないこと**、60 秒未満なら作り直さないこと、値がログに出ないこと |
| 単体 | `tests/ops.test.ts`・`tests/operations.test.ts`（新規） | `action` の振り分け、不正な `action`・`authMethod` で `{ ok: false }`、空の入力、`migrate` の最後に初期値が入ること、登録の created・updated・unchanged（今の `tests/scripts/*.test.ts` の検査を関数の形に移す）、運用の入口が Google の秘密値を読まないこと |
| 単体 | `tests/config.test.ts`・`tests/db.test.ts`・`tests/index.test.ts`・`tests/scripts/*.test.ts`・`tests/bundle-config.test.ts` | `parseConfig` と `requireGoogle`、`createPool` の上書き、縮めた `index.ts`（初期値を追加しない）と CLI、bundle の設定（banner・2 つの出力・Makefile の 2 つのターゲットと読み込みの確認） |
| 結合 | `backend/admin-auth/integration/`（新規。`vitest.integration.config.ts`、`pnpm test:integration`） | **ALB の形のイベントで本番の入口（`lambda.ts`）と運用の入口（`ops.ts`）を呼び、開発の PostgreSQL（`127.0.0.1:5434`）を本物として使う**（Secrets Manager と Google だけ差し替える）。運用: `migrate` を 2 回（2 回目は変化なし）、`register-alb-client`（created → unchanged）。本体: discovery と JWKS、DB に直接作ったセッションで ALB と同じ流れ（認可 → コード → `client_secret_basic` のトークン → UserInfo）が通ること、`Set-Cookie` が複数そのまま返ること。PostgreSQL を `docker pause` したときの 500 と `unpause` 後の回復。時計を差し替えた 60 秒のアイドルのあとの作り直し。データは `it-` 接頭辞で作り、`afterAll` で消す。`docker pause` は必ず戻す |
| 結合（既存） | リポジトリ直下の `integration/tests/admin-auth/` | 開発サーバー（3103）を叩く既存のテスト。**開発のイメージを作り直して**、そのまま通ることを確かめる（許可リストの初期値の時機が変わるため、前提が崩れれば直す） |

## 8. 更新する文書

| 文書 | 内容 |
|---|---|
| `docs/RequirementDefinition/AA/05-application-decisions.md` | ADR-26 の帰結に「③ は 2026-10-12 の仕様（このファイル）で実施。実測は Wave 4 で、備えはプロビジョニングされた同時実行数」 |
| `docs/RequirementDefinition/AA/01-application-landscape.md` | admin-auth の行の配置 |
| `docs/RequirementDefinition/TA/06-aws-runtime.md` | 冒頭の注記（ECS に残るもの）、3.1 の表、3.2 のイメージの表、3.3（admin-auth の移行は運用の Lambda）、5.2.1（IdP は Lambda。ALB の IdP の呼び出しとコールドスタートの関係）、費用の表 |
| `docs/RequirementDefinition/TA/05-observability-and-ops.md` | 項目 12 から admin-auth を外し、項目 24（admin-auth の Lambda のアラーム）を足す |
| `docs/RequirementDefinition/TA/04-security-and-secrets.md` | admin-auth の秘密値を読む主体（本体は 3 つ、運用は 3 つ。`ALB_CLIENT_SECRET` は運用だけ） |
| `docs/DetailedDesign/07-failure-and-degradation.md` | 縮退の表に admin-auth の行 |
| `docs/README.md`・`docs/RequirementDefinition/TA/03-triggers-and-cicd.md` | admin-auth を ECS とする記述に注記 |
| `cloud/README.md` | 1 章の構成、4.7（自作のイメージが無くなる）、4.10（移行と登録を運用の Lambda で行う）、4.11（DesiredCount の 1 行目）、4.12（イメージの更新）、新しい節 4.19（admin-auth）、**4 章の節番号の重複の解消**（D6: faq-bot を 4.17、consent-api を 4.18。参照も合わせる）、6 章の ECR の本数 |
| `backend/admin-auth/README.md` | 本番の構成（Lambda 2 つ・ALB）、`src/` の構成、許可リストの初期値の時機、ALB クライアントの登録の本番の手順（運用の Lambda）、開発の PostgreSQL の 5434、結合テストの実行方法、運用上の注意（keep-alive・SIGTERM は開発だけ、DB の接続の作り直し） |
| `.claude/CLAUDE.md` | 自作コードの表（admin-auth も Lambda）、ポートの表（3103 の説明、5434 の追加） |

## 9. 本番への反映（手順を `cloud/README.md` に書く。実行はしない）

`.claude/rules/build-deploy.md` により、ビルドとデプロイはこの作業では実行しない。

1. `sam build` → `sam deploy`。
2. DB とアプリ用ユーザーを作る（4.8 の共有のタスク。今と同じ）。
3. 運用の Lambda で `{"action":"migrate"}` を呼ぶ（許可リストの初期値もここで入る）。
4. 運用の Lambda で `{"action":"register-alb-client"}` を呼ぶ。
5. 確かめる: 管理画面（`chat.`・`mkt.`）を開き、`auth.` に飛んで Google でログインし、戻ってこられること。**ALB の IdP の呼び出しが通ること（ALB のアクセスログの `AuthTokenEpRequestFailed`・`AuthUserinfoEpRequestFailed` が無いこと）と、その所要時間**を見る。遅ければ `AdminAuthProvisionedConcurrency=1` にしてデプロイする。アラーム 3 つが鳴っていないこと。

## 10. 実行しないこと・後で確かめること

- **bundle とデプロイはしない**（ルール）。Wave 4（実機確認）で確かめる: bundle の読み込み（`Makefile` の確認）、VPC から RDS（`/var/runtime/ca-cert.pem` での TLS の検証）・Google・Secrets Manager（NAT）に届くこと、コールドスタートの所要時間、**ALB の IdP の呼び出しが待つ時間と、関数が起動済みであること（D1 の根拠）**、60 秒以上のアイドルのあとの作り直し、README の「実地で未確認」の項目（クライアント認証の方式・PKCE・ID トークンの鍵・UserInfo のクレーム）。
- **git の操作はしない**（`.claude/rules/git.md`）。この仕様もコミットしない。

## 11. 対象外

- OIDC のエンドポイント・3 段の検査・許可リストの運用・画面の変更。
- `better-auth` と `@better-auth/oauth-provider` の版の更新（README の TODO のまま）。
- RDS Proxy（管理者だけが使い、接続数が小さいため要らない）。
- Better Auth のレート制限の共有の保存先（5 節。WAF に頼る扱いのまま）。

## 12. 未決定事項

- **予約同時実行数（5）・タイムアウト（10 秒）・メモリ（512 MB）・アイドルの判定（60 秒）**は暫定値。Wave 4 の実測で見直す。判断者 `R1`。
- **プロビジョニングされた同時実行数を使うか**（D1）。Wave 4 で、ALB の IdP の呼び出しの所要時間と、起動済みの実行環境に当たる割合を見て決める。判断者 `R1`。
- **RDS の CA を `/var/runtime/ca-cert.pem` から読むか、RDS の CA だけを同梱するか**（AWS は後者を推奨。コールドスタートが短くなる）。Wave 4 でコールドスタートを測り、遅ければ同梱に替える。
