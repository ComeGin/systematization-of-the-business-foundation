# consent-api の Lambda 化（ADR-26 のサブプロジェクト ②）の設計

- 日付: 2026-10-12
- 状態: 設計の承認待ち（会話での設計はユーザーが 3 節とも承認済み）
- 対象: サブプロジェクト ② 「consent-api を ECS on Fargate から VPC の中の Lambda に移す」。③ admin-auth の Lambda 化はこの仕様の対象外（別の仕様。11 節）
- 前提: ADR-26（`docs/RequirementDefinition/AA/05-application-decisions.md`）、faq-bot の仕様（`docs/superpowers/specs/2026-10-11-faq-bot-design.md`。入口の分け方の前例）

## 1. 目的と合意した理解

**目的**: ADR-26 に従い、常駐の要らない consent-api を ECS on Fargate（常時 1 タスク。月 11 USD 前後〈概算〉）から VPC の中の Lambda に移し、呼ばれないあいだの費用をなくす。**API の振る舞い（パス・本文・Cookie・CORS・エラー・Valkey のキー）は 1 つも変えない。**

**ユーザーが決めたこと（2026-10-12）**

| # | 決定 |
|---|---|
| D1 | ② consent-api と ③ admin-auth を、この順に**別々の仕様**で進める（ADR-26 の帰結のとおり） |
| D2 | 入口の分け方は **faq-bot と同じ形**（処理の本体 `handler.ts` と、開発の入口 `server.ts`・本番の入口 `lambda.ts`）。Lambda Web Adapter・`serverless-http` などのラッパーは使わない |
| D3 | 2 節の AWS の構成（ALB のターゲットを `lambda` に替える。アラームを 3 つに替える） |
| D4 | テストは**単体と結合の両方を作り、実行する**（`.claude/rules/devops-testing.md` の「明確な指示」にあたる） |
| D5 | ③ admin-auth も IdP の応答時間の実測（Wave 4）を待たずに Lambda にする（③ の仕様で扱う） |

**確かめた事実（2026-10-12）**

- **本番は一度もデプロイしていない**（`cloud/README.md`）。IaC を書き換えるだけで済み、ECS から Lambda への切り替えの手順（並行稼働・DNS の切り替え）は要らない。
- **NAT ゲートウェイがある**（`cloud/stacks/network.yaml`）。VPC の中の Lambda から Secrets Manager に届く。
- ALB → Lambda（AWS の公式文書「Use Lambda functions as targets of an Application Load Balancer」）:
  - **ALB は Lambda をネットワークを通さずに直接呼ぶ**。ALB のセキュリティグループに外向きの許可は要らない。
  - 要求の本文・応答の JSON はそれぞれ **1 MB まで**。WebSocket は使えない。
  - ターゲットグループに登録できる関数は 1 つ。**関数のエイリアスを登録するのが推奨**（デプロイのたびに ALB が現行の版を呼ぶ）。
  - **ヘルスチェックは既定で無効**（有効にすると呼び出しの料金がかかる）。
  - **マルチバリューヘッダーは既定で無効**。無効のときは、同じ名前のヘッダー・クエリが複数あると最後の値だけが渡り、応答の `Set-Cookie` は 1 つだけ返せる。
  - 本文は、`content-encoding` が無く、`Content-Type` が `text/*`・`application/json` などのときはそのまま、それ以外は base64 で渡る（`isBase64Encoded`）。
  - ALB は Lambda の応答か打ち切りを待つ。
- **DD-02 の 8.3（応答を待たずにバナーを閉じる）**: 訪問者は consent-api の応答を待たない。コールドスタートの遅れは訪問者に見えない。

## 2. AWS の構成（`cloud/`）

### 2.1 ALB（`stacks/edge.yaml`）

- ルール 106（`consent.` の `/v1/consent`・GET/POST/OPTIONS → consent-api）は**変えない**。WAF も変えない。
- **consent-api のターゲットグループを edge から `stacks/services/consent-api.yaml` に移す。** CloudFormation で Lambda をターゲットグループに登録する手段は `TargetGroup` の `Targets` だけで、関数の ARN が要る。ターゲットグループを edge に置いたままだと、edge が services の関数を参照し、services が edge のターゲットグループを参照する循環になる。移したあとの依存は **services → edge の一方向**（edge はルール 106 の転送先として、親から `ConsentApiTargetGroupArn` を受け取る）。
- ターゲットグループ: `TargetType: lambda`、**名前を固定**（`comegin-<env>-consent-api`。下の許可の `SourceArn` で使う）、`Targets` は consent-api の**エイリアス `live`**（SAM の `AutoPublishAlias`）。**ヘルスチェックは無効**、**マルチバリューヘッダーは無効**（`Set-Cookie` は 1 つだけで、ブラウザが送る `Cookie` ヘッダーも 1 つのため）。
- ALB からの呼び出しの許可（`AWS::Lambda::Permission`）: `FunctionName` はエイリアスの ARN、`Principal: elasticloadbalancing.amazonaws.com`、`SourceAccount` はこのアカウント、`SourceArn` は `arn:<partition>:elasticloadbalancing:<region>:<account>:targetgroup/comegin-<env>-consent-api/*`。**ターゲットの登録は許可が先に要る**ため、ターゲットグループに `DependsOn` で許可を付ける。`SourceArn` にターゲットグループの `!Ref` を使うと、許可とターゲットグループが互いを待つ循環になるので、固定の名前とワイルドカードで絞る。
- 出力: `TargetGroupArn`（edge のルール 106 へ）と `TargetGroupFullName`（2.4 のアラームへ）。edge の出力の `ConsentApiTargetGroupArn`・`ConsentApiTargetGroupFullName` は外す。

### 2.2 Lambda（`stacks/services/consent-api.yaml` を書き換え）

faq-bot（`stacks/services/faq-bot.yaml`）の形に合わせる。

| 項目 | 値 | 理由 |
|---|---|---|
| 型 | `AWS::Serverless::Function`。`Metadata.BuildMethod: makefile`（`backend/consent-api/Makefile` の `build-ConsentApiFunction`） | faq-bot と同じ。pnpm と esbuild でまとめ、ECR を使わない |
| ランタイム | `nodejs22.x`・`arm64` | faq-bot と同じ |
| メモリ | 256 MB | 処理は Valkey の 1〜3 コマンドだけ |
| タイムアウト | **10 秒** | 最悪の待ち時間（接続の待ち 3 秒＋`inspect` 2 秒＋`append` 2 秒 ＝ 7 秒。コールドスタートは Secrets Manager の読み込みが足される）を収める（2026-10-12 の最終レビューで 6 秒から変更） |
| 予約同時実行数 | **10**（パラメータ `ReservedConcurrency`） | 費用と乱用の上限。WAF のレート制限（TA-06 の 5.5。consent は最も厳しい）とは別の保険。Valkey の接続数の上限にもなる |
| エイリアス | `AutoPublishAlias: live` | 2.1 |
| VPC | private サブネット、既存の `ConsentApiSecurityGroup` | Valkey に届くため |
| 環境変数 | `NODE_ENV=production`、`VALKEY_URL=rediss://<ValkeyEndpoint>:6379`、`VALKEY_KEY_PREFIX=consent:`、`SITE_URL`、`COOKIE_DOMAIN`、`CONSENT_POLICY_VERSION`、`VALKEY_PASSWORD_SECRET_ID=<SecretNamePrefix>/shared/VALKEY_AUTH_TOKEN` | AUTH トークンの値は環境変数に置かない（3.4） |
| 実行ロール | `secretsmanager:GetSecretValue`（`shared/VALKEY_AUTH_TOKEN-*` だけ）、ログの書き込み、VPC の ENI の操作（SAM が `VpcConfig` から付ける管理ポリシー） | ECS の実行ロールと同じ範囲。RDS の資格情報は読めない |
| ロググループ | `/aws/lambda/comegin-<env>-consent-api`（保持期間はパラメータ。既定 30 日） | faq-bot と同じ。`cluster.yaml` の `/comegin/<env>/consent-api` は外す |

- Valkey の証明書は Amazon の CA の署名で、Node の標準の信頼ストアで検証できる（今の `consent-api.yaml` の説明のとおり）。`NODE_EXTRA_CA_CERTS` は要らない。
- 出力: `FunctionName`、`AliasArn`、`TargetGroupArn`、`TargetGroupFullName`（2.1）。

### 2.3 ネットワーク（`stacks/network.yaml`）

- **外す**: ALB の SG の consent-api への外向きの許可（`To consent-api`）と、`ConsentApiFromAlb`（ALB は Lambda を直接呼ぶため）。
- **残す**: `ConsentApiSecurityGroup` と、その外向き（Secrets Manager は NAT 経由の 443）、`ValkeyFromConsentApi`（6379）。
- SG の `GroupDescription`（`consent-api tasks (reach Valkey only)`）は変えない（変えると SG が置き換わる。未デプロイなので害は無いが、差分を小さくする）。
- `ConsentApiPort` のパラメータは、使う箇所が無くなれば親テンプレート・network・edge から外す。

### 2.4 監視（`stacks/alarms.yaml`）

**外す**: `ConsentApiRunningTaskAlarm`（ECS のタスク数）、`ConsentApiUnhealthyHostAlarm`（ヘルスチェックが無効になる）。

**足す**（どれも SNS の `ops` へ。`TreatMissingData: notBreaching`。OK のときも送る。faq-bot の `FaqBotErrorsAlarm` と同じ形）:

| アラーム | メトリクス | 条件 | 拾うもの |
|---|---|---|---|
| `consent-api-errors` | `AWS/Lambda` の `Errors` | 1 分の合計 > 0 | 例外・タイムアウト・初期化の失敗（3.3） |
| `consent-api-throttles` | `AWS/Lambda` の `Throttles` | 1 分の合計 > 0 | 予約同時実行数（10）に達した |
| `consent-api-target-5xx` | `AWS/ApplicationELB` の `HTTPCode_Target_5XX_Count`（ターゲットグループ） | 5 分の合計 ≥ 1 | **Valkey の障害の 503 と、想定外の 500**。どちらも応答として返すため `Errors` に数えられない。同意が成立しないと新しい訪問者の PostHog・Chatwoot・GA4 が止まる（DD-02 の 8.4）ため、1 件で鳴らす |

### 2.5 親テンプレートと、ほかのスタック

- `template.yaml`: `ConsentApiService` のパラメータを Lambda の分に替える（`ClusterArn`・`ImageRepositoryUri`・`ImageTag`・`DesiredCount`・`Cpu`・`Memory`・`ContainerPort`・`EnableExecuteCommand`・`HealthCheckGracePeriodSeconds`・`LogGroupName`・`TargetGroupArn` を外し、`SecretNamePrefix`・`PrivateSubnetIds`・`SecurityGroupId`・`ValkeyEndpoint`・`SiteUrl`・`CookieDomain`・`ConsentPolicyVersion`・`ReservedConcurrency` を渡す）。親のパラメータ `ConsentApiImageTag`・`ConsentApiDesiredCount`・`ConsentApiCpu`・`ConsentApiMemory` を外す。**`EdgeStack` に `ConsentApiService` の `TargetGroupArn` を渡す**（2.1。依存の向きが edge → services から services → edge に変わる）。`alarms.yaml` に関数名と、`ConsentApiService` のターゲットグループの名前を渡す。
- `stacks/ecr.yaml`: `ConsentApiRepository` と出力を外す（未デプロイなので、Retain のリポジトリは AWS に残っていない）。
- `stacks/cluster.yaml`: `ConsentApiLogGroup` と出力を外す。
- `samconfig.toml.example`: 外したパラメータの上書きがあれば消す（未知のパラメータは更新を失敗させる）。

## 3. コード（`backend/consent-api/src/`）

### 3.1 ファイルと責務

| ファイル | 責務 | 変更 |
|---|---|---|
| `handler.ts` | **入口に依存しない本体**。`createHandler({ config, store })`（ログは `console.error` に出す） → `(req: HttpRequest) => Promise<HttpResponse>`。ルーティング・CORS・`Origin` の照合・本文の検証（415・400・413）・識別子の発行と引き継ぎ・200 件の上限（429）・`Set-Cookie`・Valkey の障害（503）・想定外の失敗（500）・1 件 1 行のログを、今の `server.ts` からそのまま移す。**例外を投げない** | 新規（中身は移動） |
| `server.ts` | 開発の入口（Node の http。3104）。本文を上限つきで読み（宣言した `Content-Length` が上限を超える、または読んだ量が超えたら、その時点で 413 と `Connection: close`）、ヘッダーを `HttpRequest` に詰めて `handle` を呼び、結果を書き出すだけ。keep-alive・タイムアウトの設定はそのまま（開発だけの意味になる） | 縮小 |
| `lambda.ts` | 本番の入口。ALB のイベント ↔ `HttpRequest`・`HttpResponse` の変換と、初期化（3.3・3.4） | 新規 |
| `valkey.ts` | 今の `createValkey` に `waitReady(client, timeoutMs)` を足す | 追加 |
| `index.ts` | 開発の起動（`createServer(createHandler(...))`）と SIGTERM の処理 | 呼び出しの形だけ変える |
| `config.ts`・`store.ts`・`cookie.ts`・`constants.ts` | 今の部品 | そのまま（定数の追加は可） |

型:

```ts
// ヘッダー名は小文字。開発は server.ts、本番は lambda.ts が作る
export interface HttpRequest {
  readonly method: string;
  readonly path: string; // 要求ターゲット。クエリを含んでよい（handler が URL として解釈してパスだけを使う。ログもクエリを外す）
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Buffer;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>; // Set-Cookie は 1 つだけ
  readonly body: string; // 204 は空文字
}
```

- 413 の判定は `handler.ts` でも行う（`body.length` と、宣言された `content-length` の両方。ALB からは本文が全部届いてから渡るため）。
- ログは `handler.ts` が 1 件 1 行で出す（時刻・メソッド・パス・ステータス・所要時間。**識別子と IP は出さない**）。今の `server.ts` の `res.on("finish")` のログと同じ項目。

### 3.2 ALB のイベントの変換（`lambda.ts`）

- 要求: `httpMethod` → `method`、`path` → `path`、`headers` のキーを小文字にして `headers`、`body`（無ければ空）を `isBase64Encoded` に従って `Buffer` にする。`queryStringParameters` は使わない（consent-api はクエリを読まない）。
- 応答: `statusCode`、`statusDescription`（`"<コード> <理由句>"`。`node:http` の `STATUS_CODES`）、`headers`、`body`、`isBase64Encoded: false`。

### 3.3 初期化と Valkey の接続

- 初期化は**最初の呼び出しで 1 回だけ**行い、**失敗したら次の呼び出しでやり直す**（faq-bot の `createLambdaHandler` と同じ形。初期化の関数を引数で受け、テストで差し替えられるようにする）。
- 初期化の中身: AUTH トークンを読む（3.4）→ `parseConfig`（不正なら例外。`loadConfig` の `process.exit` は使わない。2026-10-12 の最終レビューで変更）→ `createValkey` → **`waitReady`（最大 3 秒）** → `ConsentStore` → `createHandler`。
- **接続はモジュールのスコープに 1 本持ち、呼び出しをまたいで使い回す。**
- **初期化で `ready` を待つ理由**: 今の設定（`enableOfflineQueue: false`）では、接続の完了前に届いたコマンドはすぐ失敗する。ECS ではサーバーの起動から最初の要求までに時間があったが、Lambda ではコールドスタートの直後に最初の要求を処理するため、待たないと最初の要求が必ず 503 になる。
- `ready` が 3 秒以内に来なければ初期化の失敗（例外）にする → `Errors` のアラームが鳴り、ALB は 502 を返す。作りかけの接続は閉じる（次の呼び出しの初期化で新しく作る）。
- **各呼び出しの前**に、接続が `ready` でなければ（凍結からの復帰後の再接続中など）`waitReady` で最大 3 秒待つ。それでも `ready` にならなければ、そのまま `handle` を呼ぶ（今と同じく 503 を返す）。
- `waitReady(client, timeoutMs)`: `client.status === "ready"` ならすぐ返る。そうでなければ `ready` のイベントか時間切れを待ち、`true` / `false` を返す（待つあいだに付けたリスナーは必ず外す）。
- ioredis の `error` のログを間引く今の処理（30 秒に 1 回）はそのまま。
- SIGTERM の処理は Lambda では要らない（`index.ts` にだけ残す）。

### 3.4 AUTH トークン

- `VALKEY_PASSWORD_SECRET_ID` の Secret を、初期化で Secrets Manager から 1 回だけ読み、`loadConfig({ ...process.env, VALKEY_PASSWORD: <値> })` に渡す（faq-bot の `loadSecrets` と同じ扱い）。
- `VALKEY_PASSWORD_SECRET_ID` が無い、または Secret に値が無いときは初期化の失敗にする。**値はログに出さない**（Secret の ID だけ）。
- `@aws-sdk/client-secrets-manager` は Lambda の実行環境にあるので bundle に含めない（devDependencies に入れる。faq-bot と同じ）。

### 3.5 ビルドと依存

- `package.json`: `bundle`（`esbuild src/lambda.ts --bundle --platform=node --target=node22 --format=esm --sourcemap --outfile=dist-lambda/index.mjs --external:@aws-sdk/*`）、`test:integration`、`clean` に `dist-lambda` を足す。devDependencies に `esbuild` と `@aws-sdk/client-secrets-manager`（**faq-bot と同じ版の指定**。`minimumReleaseAge` を満たすもの）。
- `Makefile`: `build-ConsentApiFunction`（`pnpm install --frozen-lockfile` → `pnpm run bundle` → `dist-lambda/index.mjs` と `.map` を `$(ARTIFACTS_DIR)` に写す）。SAM の `Handler` は `index.handler`。
- `Dockerfile`・`compose.yml` は**開発の起動用として残す**（本番では使わないことをコメントに書く）。`.gitignore` に `dist-lambda` を足す。
- **ioredis（とその依存）は CommonJS で `require("events")` などを呼ぶ。ESM の出力には `require` が無いため、bundle の `--banner:js` で `createRequire(import.meta.url)` から `require` を用意する**（2026-10-12 の最終レビューで追加。無いと読み込みの時点で `Dynamic require of "events" is not supported` になり、すべての呼び出しが 502 になる）。`Makefile` は bundle のあとに出力を読み込めることを確かめてから写す（`sam build` のときに走る。今回はビルドしない。10 節）。
- Lambda の入口だけ、Valkey に `socketTimeout`（2 秒）を付ける（2026-10-12 の最終レビューで追加）。凍結のあいだに通り道が接続を黙って捨てると、`status` は `ready` のままソケットだけが死に、ioredis はコマンドのタイムアウトでは再接続しないため。応答が来なければソケットを壊して再接続させ、次の呼び出しで回復する。

## 4. 振る舞い（変えないもの）

README の「API」「Cookie」「CORS」「Valkey のキー設計」の節に書いてあることは**すべてそのまま**。とくに次は変えない。

- パスは `/v1/consent`（GET・POST・OPTIONS）と、開発用の `/healthz` だけ。`/healthz` は ALB に出さない（ヘルスチェックも無効になる）。
- Valkey に届かない・2 秒以内に返らないときは 503 で、**Cookie を書かない**。
- エラーの本文は `{"error":"<コード>"}`、すべての応答に `Cache-Control: no-store`・`X-Content-Type-Options: nosniff`。

## 5. 失敗時の扱い

| 失敗 | 扱い | 訪問者から見える結果 |
|---|---|---|
| コールドスタートで Secret を読めない・Valkey に 3 秒以内に届かない | 初期化の失敗（例外）→ `Errors`。ALB は 502 を返す。次の呼び出しで初期化をやり直す | バナーは閉じる（DD-02 の 8.3）。Cookie が書けないので未同意のまま（DD-02 の 8.4。今と同じ制約） |
| ウォームの状態で Valkey が落ちている | 各呼び出しで最大 3 秒待ってから 503 → `consent-api-target-5xx` | 同上 |
| 10 秒以内に終わらない | Lambda の打ち切り → `Errors`。ALB は 502 | 同上 |
| 同時実行数の上限（10）を超える | Lambda が呼び出しを拒否 → `Throttles`。ALB は 5xx を返す | 同上 |
| 想定外の例外（handler の中） | 今と同じく 500（`internal`）→ `consent-api-target-5xx` | 同上 |

- **ウォームの状態での Valkey の障害の待ち時間が、ECS のとき（即 503）より最大 3 秒長くなる。** 訪問者は応答を待たない（DD-02 の 8.3）ので見えない。

## 6. 開発環境

- 開発の起動は今のまま（`docker compose up -d --build` で 127.0.0.1:3104。`pnpm dev`）。
- **結合テスト（7 節）のために、開発の Valkey を `127.0.0.1:6380` にだけ開く**（`compose.yml` の `ports: ["127.0.0.1:6380:6379"]`）。`.claude/CLAUDE.md` のポートの表に 6380 を足す。README の「Valkey はホストに公開しない」の記述を直す。
- `.env.example` に `VALKEY_PASSWORD_SECRET_ID`（本番の入口だけが使う。開発は空）の説明を足す。

## 7. テスト

既存の決まりに従う: 対象ごとに `describe("正常系")` / `describe("異常系")`、各公開関数・エンドポイントに `空入力: ` のケース、異常系の名前は `入力: `（検証・形式）か `サーバ: `（Valkey・AWS SDK の例外・タイムアウト）で始める。外部はモック。`testTimeout` / `hookTimeout` は 30 秒。src のバグを見つけたら、src を直さず `it.todo` と直上のコメントで残す。

| 種別 | 置き場 | 内容 |
|---|---|---|
| 単体 | `tests/handler.test.ts`（新規） | 今の `tests/server.test.ts` の検査のうち、入口に関係しないもの（CORS・プリフライト・`Origin`・405・404・415・400・413〈本文の長さ・宣言した長さ〉・識別子の引き継ぎと新規の発行・200 件の上限・503・500・`/healthz`・ログに識別子と IP が出ないこと）を、`handle` を直接呼ぶ形に移す。Valkey は今の `FakeRedis` |
| 単体 | `tests/server.test.ts`（縮小） | 開発の入口だけ: 本文を途中で打ち切る 413（宣言した長さ・チャンク）、ヘッダー・本文・パス（クエリを除く）の受け渡し、`handle` の結果の書き出し、`handle` が投げたときの 500 |
| 単体 | `tests/lambda.test.ts`（新規） | イベントの変換（base64 の本文・本文なし・ヘッダー名の小文字化・メソッドなし）、応答の変換（`Set-Cookie`・`statusDescription`・`isBase64Encoded`）、初期化が 1 回だけで、失敗したら次でやり直すこと、各呼び出しの前の `waitReady`、AUTH トークンの読み込み（ID なし・値なし・SDK の例外。SDK はモック） |
| 単体 | `tests/valkey.test.ts`（追加） | `waitReady`: すでに ready・あとから ready・時間切れ・リスナーが残らないこと |
| 単体 | `tests/index.test.ts` ほか | 呼び出しの形の変更に合わせて直す |
| 結合 | `backend/consent-api/integration/`（新規。`vitest.integration.config.ts`、`pnpm test:integration`） | **ALB の形のイベントで `lambda.ts` の handler を呼び、開発の Valkey（`127.0.0.1:6380`）を本物として使う**（Secrets Manager だけモック）。同意の記録 → Cookie → 取得、撤回で同じ Stream に積まれること、`Origin` の拒否、Valkey を `docker pause` したときの 503 と `unpause` 後の回復、Valkey が止まった状態でのコールドスタート（初期化の失敗）と次の呼び出しでの回復。テストデータの識別子は `it-` ではなくサーバーが発行するため、作った Stream のキーを記録して `afterAll` で消す。`docker pause` は必ず `unpause` する |
| 結合（既存） | リポジトリ直下の `integration/tests/consent-api/` | 開発サーバー（3104）を HTTP で叩く既存の結合テスト。振る舞いを変えないので、**そのまま通ることを確かめる** |

## 8. 更新する文書

| 文書 | 内容 |
|---|---|
| `docs/RequirementDefinition/AA/05-application-decisions.md` | ADR-26 の帰結に「② は 2026-10-12 の仕様（このファイル）で実施」と注記 |
| `docs/RequirementDefinition/AA/01-application-landscape.md` | consent-api の行の実行基盤（ECS → VPC の中の Lambda。ALB の配下） |
| `docs/RequirementDefinition/TA/06-aws-runtime.md` | 冒頭の注記（ECS に残るもの）、3.1 の表と 86 行目の理由（ADR-26 で置き換え）、3.2 のイメージの表（consent-api はイメージを作らない）、4.8 の書き手、5.3（ターゲットの種類）、費用の表（Fargate のサービス数） |
| `docs/RequirementDefinition/TA/05-observability-and-ops.md` | 項目 12 の対象から consent-api を外し、Lambda の 3 つのアラーム（2.4）を書く |
| `docs/DetailedDesign/02-public-path-flows.md` | 8.1 の見出しと表（ADR-26 で Lambda。当時の「実行基盤を増やさない」は置き換え） |
| `docs/DetailedDesign/07-failure-and-degradation.md` | consent-api の縮退（5 節の表） |
| `cloud/README.md` | ディレクトリの説明（ECR の本数・ECS のサービスの本数）、consent-api のイメージのビルドと push、`DesiredCount` の段階を外し、Lambda のデプロイ（`sam build` / `sam deploy`）と確認の手順にする |
| `backend/consent-api/README.md` | 本番の構成（Lambda・ALB）、`src/` の構成、運用上の注意（`/healthz`・keep-alive・SIGTERM は開発だけ、Valkey の接続の使い回しと `waitReady`）、開発の Valkey の 6380、結合テストの実行方法 |
| `.claude/CLAUDE.md` | 自作コードの表（consent-api の本番は ALB 配下の Lambda）、ポートの表（3104 の説明、6380 の追加） |

## 9. 本番への反映（手順を `cloud/README.md` に書く。実行はしない）

`.claude/rules/build-deploy.md` により、ビルドとデプロイはこの作業では実行しない。

1. `sam build`（consent-api の Makefile が bundle を作る）と `sam deploy`。
2. 確認: 公開サイトのバナーで同意し、`comegin_consent` の Cookie が書かれ、`GET /v1/consent` が状態を返すこと。CloudWatch のアラーム 3 つが鳴っていないこと。Lambda のログに 1 件 1 行のログが出て、識別子と IP が無いこと。

## 10. 実行しないこと・後で確かめること

- **bundle とデプロイはしない**（ルール）。ESM の bundle で ioredis が動くこと（`Makefile` の読み込みの確認）、VPC の中の Lambda から ElastiCache（TLS・AUTH）と Secrets Manager（NAT）に届くこと、コールドスタートの所要時間、**15 分以上アイドルにしたあとの最初の POST が 201 になるか（`socketTimeout` による回復）**は、Wave 4（実機確認）で確かめる。
- **git の操作はしない**（`.claude/rules/git.md`）。この仕様もコミットしない。

## 11. 対象外と後続

- **サブプロジェクト ③: admin-auth の Lambda 化**（別の仕様。D5 により実測を待たずに進める。ALB の IdP の呼び出しの直前にブラウザが同じ関数を 3 回呼ぶため、ALB の呼び出しの時点で関数は起動済みである見込み。万一に備え、プロビジョニングされた同時実行数をパラメータで有効にできるようにする）。
- **対象外**: API の振る舞いの変更、記録の保持期間（TTL）、サイト側でも Cookie を書く二重化（DD-02 の 8.4）、同意率の指標。いずれも README の「未決定事項」のまま。

## 12. 未決定事項

- **予約同時実行数（10）とタイムアウト（10 秒）**は暫定値。Wave 4 の実測と、本番の同時実行数のメトリクスを見て見直す。判断者 `R1`。
- **`consent-api-target-5xx` のしきい値（5 分で 1 件）**は、本番で誤報が多ければ見直す（TA-05 の項目 12 のしきい値と一体で決める）。
