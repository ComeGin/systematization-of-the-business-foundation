# cloud（AWS 本番環境の IaC。AWS SAM）

本番（`ap-northeast-1`）を CloudFormation（AWS SAM）で定義する。設計は `docs/RequirementDefinition/TA/06-aws-runtime.md`（主）、`TA/04`・`TA/05`・`TA/02`・`TA/01`。
**このディレクトリは「書いただけ」の状態である。`sam deploy` は一度も実行しておらず、AWS の API も呼んでいない。** 検証は `sam validate --lint` と cfn-guard の静的検査だけで、
実機で初めて分かることは「5. TODO 一覧」と各テンプレートの `TODO(未検証)` に残した。

**ADR-21（2026-10-05）で、Strapi と n8n をクラウドから外した。** 再帰的自己改善の仕組み（Strapi・n8n・監視アプリ・MCP・ビルド）はオンプレ、
成果物（Astro・Mautic・Chatwoot と、例外の `consent-api`・`admin-auth`）はクラウド、データの置き場（RDS・ElastiCache・S3・EFS）は AWS に置く。
オンプレと VPC は、小さな EC2 の WireGuard（`stacks/wireguard.yaml`）でつなぐ。構成は 1.1。

**ADR-25（2026-10-06）で、Umami をクラウドから外した。** アクセス解析の正本は GA4（SaaS。Google LLC）にし、クラウドに置くものは無い（`stats.` のホストも無い）。外したものは 6 節。

収益化（`points-api`・`I-26`〜`I-30`・`E-19` の S3 Object Lock）は作っていない（本システムの完成後。ポート 3106 とフォルダ名を予約しているだけ）。

**設定スクリプト（`setup/`）・オンプレ（`onprem/`）と合わせた本番の全体の順番と、人が行う作業の一覧は [`docs/runbooks/00-setup-overview.md`](../docs/runbooks/00-setup-overview.md)。** この README の 4 節は、その各手順の詳細（コマンドと注意）。

## 1. 構成

```
cloud/
  template.yaml              親。子を AWS::Serverless::Application で呼び、!GetAtt <Child>.Outputs.<Name> でつなぐ（Export と ImportValue は使わない）
  samconfig.toml.example     samconfig.toml の雛形（実体は追跡しない）
  global/template.yaml       us-east-1 の別スタック。CloudFront 用の ACM 証明書と WAF、フラットレートプランの購読
  stacks/
    network.yaml             VPC、2AZ の public / private、NAT 1 台、S3 ゲートウェイエンドポイント、セキュリティグループ（すべて。WireGuard の EC2 の SG を含む）
    wireguard.yaml           オンプレとの WireGuard の終端（EC2 t4g.nano 1 台、Elastic IP、private サブネットの経路、SSM のパラメータ）
    ecr.yaml                 ECR（Mautic・Chatwoot の 2 本。自作のサービス〈admin-auth・consent-api・faq-bot〉は Lambda で ECR を使わない）
    observability.yaml       SNS（comegin-lead-alert / comegin-ops-alert）、ハートビートのアラーム 2 つ（オンプレの監視アプリ、オンプレの n8n のスケジュール実行）
    runlog-archive.yaml      E-15（実行記録）の写しのバケット。追記だけ
    iam.yaml                 監視アプリ用とデプロイ用の管理ポリシー、オンプレの Strapi・n8n 用の IAM ユーザー 2 つ（アクセスキーは作らない）
    secrets.yaml             Secrets Manager（20 個。faq-bot の 2 個を含む）
    data.yaml                Aurora Serverless v2（MySQL 8.4 互換〈Mautic〉と PostgreSQL 16 互換〈4 アプリで共有〉）、Valkey、EFS、S3
    cluster.yaml             ECS クラスター、ロググループ（Service Connect は使わない）
    edge.yaml                ACM、ALB、リスナールール、WAF、Route 53
    cdn.yaml                 Astro の配信（CloudFront、OAC、Route 53）
    ses.yaml                 SES のドメイン ID と DKIM
    ops-tasks.yaml           運用者が RunTask で起動する DB 作成のタスク
    alarms.yaml              CloudWatch アラームと RDS のイベント通知
    services/<svc>.yaml      ECS のサービス 4 本（mautic-web・mautic-cron・chatwoot-web・chatwoot-worker）
    services/faq-bot.yaml    faq-bot（Lambda。VPC の外。関数 URL。ADR-26。4.17）
    services/consent-api.yaml consent-api（Lambda。VPC の中。ALB のターゲットとターゲットグループを持つ。ADR-26。4.18）
    services/admin-auth.yaml  admin-auth（Lambda 2 つ: 本体〈ALB のターゲット〉と運用〈admin-auth-ops〉。VPC の中。ADR-26。4.19）
  images/<製品>/Dockerfile   RDS の CA を足した派生イメージ（mautic・chatwoot。4.7）
```

### 1.1 オンプレとの接続（ADR-21）

```
オンプレ                                              AWS（ap-northeast-1）
  Strapi（本番。127.0.0.1:1338）   ─┐                   ┌─ RDS PostgreSQL（strapi・n8n ほか）
  n8n（本番。127.0.0.1:5679）      ─┤ wg0 10.99.0.2     │     ▲ 5432（EC2 で SNAT）
  Webhook の受け口（リバースプロキシ。 ├──UDP 51820──►  EC2 t4g.nano（WireGuard。wg0 10.99.0.1。public サブネット・Elastic IP）
   10.99.0.2:5680 の /webhook/* だけ） ┘                    │     ▲ 10.99.0.0/24 の経路（private サブネットの経路表 → この EC2 の ENI）
                                                            │     └─ mautic-web・mautic-cron・chatwoot-web・chatwoot-worker（Webhook を送る）
  S3（Strapi のメディア）と SNS（通知）は、トンネルを通さず、IAM ユーザーのキーでインターネット越しに使う
```

- **オンプレ → AWS**: Strapi・n8n が RDS の `strapi`・`n8n` データベースに届く。EC2 の nftables は、`wg0` から VPC への転送を **tcp 5432 だけ**許す（既定は drop）。どのデータベースに入れるかは、DB ユーザーの権限（ops-tasks の `REVOKE ALL ON DATABASE ... FROM PUBLIC` と、データベースごとのオーナー）で絞る。
- **AWS → オンプレ**: Mautic・Chatwoot のタスクから `http://10.99.0.2:5680/webhook/...` に届く。WireGuard の EC2 の SG は、この 4 つの SG からだけ、その 1 ポートだけを受ける。nftables も `10.99.0.2:5680/tcp` 以外への転送を落とす。**エディター・API・MCP は、クラウドから届かない**（オンプレのリバースプロキシが `/webhook/*` だけを n8n に通す）。
- **NAT の向き**: どちらの向きも EC2 で masquerade する。オンプレから見える送信元は `10.99.0.1` だけになる（オンプレに VPC のタスクの IP への経路を持たせないため。送信元ごとのレート制限は、実質的に全体での制限になる）。
- **n8n（オンプレ）から Chatwoot・Mautic の API**: ALB の機械向けのルール（`edge.yaml` の 201・202。製品側のトークンと WAF のレート制限で守る）を、公開ホスト（`ChatHost`・`MktHost`）経由で呼ぶ。VPC の内部経路は無い（Service Connect は廃止した）。
- **Strapi（`cms.`）と n8n（`n8n.`）は ALB にホストもルールも持たない。** DNS のレコードも、ACM の証明書の名前も無い。

### デプロイの順序と依存

```
global（us-east-1）→ 本番（親）→ global（2 回目。DistributionArn を入れる）
親の中: network → ecr / observability / runlog-archive / secrets → data → cluster → edge → cdn / ses / ops-tasks / wireguard / services / alarms / iam
```

### 名前の約束

- スタックの Outputs とパラメータはパスカルケース。一覧はカンマ区切りの String（`PrivateSubnetIds`）。サービス固有の名前は `<Svc><Item>`。
- Secret の名前は `comegin/<env>/<サービス>/<変数名>`。1 つの Secret に値を 1 つだけ入れる（平文）。ECS の `secrets` には「名前」を書く。`<prefix>` は親が子に渡す（`SecretNamePrefix`）。
- ECS のサービス名は `comegin-<env>-<svc>`、タスク定義のファミリーも同じ。固定名なので、アラームは名前だけで対象を指せる。
- データを持つリソース（RDS・EFS・S3・Secrets・ElastiCache・ECR・SNS）は `DeletionPolicy: Retain` と `UpdateReplacePolicy: Retain`。

## 2. 前提

- AWS CLI、SAM CLI（1.154 以上）、Docker（イメージのビルドとミラー用）。AWS の認証は環境（SSO・プロファイル）に任せ、`samconfig.toml` にキーを書かない。
- **デプロイは運用者が実行する。** エージェントに ECS・RDS・CloudFormation の変更権限を渡さない（TA-06 の 8 節）。
- AWS アカウントは単一（`798560359429`）。**AWS Free Tier の期間内のアカウントは、CloudFront のフラットレートプランを購読できない**（公式の制約。アカウントは 2026-09-16 作成。初回で確かめる）。
- **Lambda の同時実行数の上限**: このアカウントの `ConcurrentExecutions` は新しいアカウントの初期値の **10** だったが、2026-10-26 に Service Quotas（「AWS Lambda → Concurrent executions」`L-B99A9384`）で 1,000 を申請し、**2026-10-27 に `aws lambda get-account-settings` で 1,000 を確認した**。Lambda は予約していない枠を常に 100 残すことを求めるので、上限が 121 未満のアカウントでは、予約同時実行数を付けた関数（consent-api 10・admin-auth 5・admin-auth-ops 1・faq-bot 5。計 21）の作成が失敗する。別のアカウントに出すときは先に確かめる。待てない場合だけ、親のパラメータ `ConsentApiReservedConcurrency`・`AdminAuthReservedConcurrency`・`AdminAuthOpsReservedConcurrency`・`FaqBotReservedConcurrency` を 0（予約を付けない）にできる（そのあいだは、関数 URL への大量の要求〈faq-bot〉がアカウント全体の枠を使い切り、同意の受け口とログインまで止まりうる。運用の Lambda を同時に 2 回呼ばない）。
- `RunLogAdminPrincipalArns` に、**デプロイに使う主体（IAM ユーザー `comegin-iam`、または CloudFormation のサービスロール）の ARN** を入れること。入れないと、E-15 の写しのバケットポリシーが自分自身の更新を拒否して詰む。
- **`capabilities` は `CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND`**（`samconfig.toml.example` のとおり）。IAM ロールとユーザーに固定の名前（`comegin-<env>-...`）を付けているため、`CAPABILITY_IAM` だけでは拒否される。
- `cp samconfig.toml.example samconfig.toml` して値を入れる。`samconfig.toml` は `cloud/.gitignore` で除外している。

### 重要: パラメータは `samconfig.toml` にすべて書く

SAM CLI の `--parameter-overrides` は「前回の値を使う」ことができない。**書かなかったパラメータは、デプロイのたびにテンプレートの既定値に戻る。**
たとえば `ChatwootWebDesiredCount=1` を samconfig.toml に書かずにデプロイすると、次のデプロイで 0 に戻って**サービスが止まる**。
**既定値と違う値（`DesiredCount`・イメージのタグ・`GoogleClientId` など）は、すべて `samconfig.toml` の `parameter_overrides` に書き、それを正本にする。**
`aws ecs update-service --desired-count` で台数を直接変えない（CloudFormation の値とずれ、次のデプロイで上書きされる）。

## 3. 費用

### 3.1 見積もり（2026-10-26）

**月 約 $365（税抜き。消費税 10% 込みで約 $401、年 約 $4,800）**（2026-10-27 に PostgreSQL も Aurora Serverless v2 にした後。MySQL の Serverless v2 と Fargate の夜間の停止は 2026-10-26）。単価は AWS の Pricing API の東京リージョン（`ap-northeast-1`）の値（2026-10-26 に取得）、数量はこのテンプレートの既定値、使用量は立ち上げ期の想定（下の表の「前提」）。月 730 時間で換算。

| 区分 | 項目 | 月額（USD） | 前提・単価 |
|---|---|---:|---|
| 計算 | ECS Fargate mautic-web（1 vCPU・2 GB、x86、常時） | 44.98 | vCPU $0.05056/時・GB $0.00553/時 |
| 計算 | ECS Fargate chatwoot-web・chatwoot-worker・mautic-cron（計 2 vCPU・4 GB、x86、毎日 22 時〜翌 8 時は 0 台） | 52.48 | 同上。1 日 14 時間（夜間の停止で月 $37 前後下がる） |
| 計算 | EC2 t4g.nano（WireGuard）＋EBS gp3 8 GB | 4.71 | $0.0054/時・$0.096/GB 月 |
| 計算 | Lambda（4 関数。arm64） | 0 | 常時無料枠（月 100 万リクエスト・40 万 GB 秒）に収まる想定 |
| DB | Aurora PostgreSQL Serverless v2（Chatwoot・admin-auth・Strapi・n8n が共有。最小 0.5 ACU・最大 2 ACU） | 54.75 | $0.15/ACU 時。最小のまま動く想定（上限は 2 ACU で月 $219） |
| DB | Aurora MySQL Serverless v2（Mautic。最小 0.5 ACU・最大 2 ACU） | 54.75 | $0.15/ACU 時。最小のまま動く想定（山で伸びると増える。上限は 2 ACU で月 $219） |
| DB | Aurora ストレージ（各 10 GB）と I/O（計 4,000 万回/月） | 12.00 | $0.12/GB 月・$0.24/100 万回 |
| DB | ElastiCache Valkey cache.t4g.micro × 1 | 14.60 | $0.02/時 |
| DB | EFS（2 GB・日次バックアップ）・S3（計 5 GB） | 2.02 | $0.36/GB 月・$0.025/GB 月 |
| ネットワーク | ALB（平均 0.5 LCU） | 20.66 | $0.0243/時・$0.008/LCU 時 |
| ネットワーク | NAT Gateway（処理 30 GB/月） | 47.12 | $0.062/時・$0.062/GB |
| ネットワーク | パブリック IPv4 × 4（NAT・WireGuard・ALB の 2 AZ） | 14.60 | $0.005/時 |
| ネットワーク | CloudFront・インターネットへの転送 | 0 | フラットレートの Free プラン。転送は月 100 GB の無料枠内の想定（超過は $0.114/GB） |
| ネットワーク | Route 53（ホストゾーン 1） | 0.50 | 作成済み |
| セキュリティ | WAF（ALB 用。Web ACL 1・ルール 8・100 万リクエスト） | 13.60 | $5/ACL・$1/ルール・$0.60/100 万（CloudFront 用はプランに含まれる） |
| セキュリティ | Secrets Manager（22 個） | 8.85 | $0.40/個（$8.80）＋API の呼び出し |
| 運用 | CloudWatch（アラーム 30〈課金はアラームの中のメトリクスの数で 37〉・Container Insights 標準 約 60 メトリクス・ログ 6 GB） | 18.66 | $0.10/アラームのメトリクス・$0.30/メトリクス・$0.76/GB（無料枠を引いた） |
| 運用 | ECR（計 4 GB）・SES（3,000 通/月）・SNS・ACM | 0.70 | |
| | **合計** | **364.98** | |

- **固定費（時間課金）が 9 割**（Aurora 30%・Fargate 27%・NAT と IPv4 17%・ALB 6%）。トラフィックが 10 倍になっても、合計は大きくは変わらない（ALB の LCU・WAF のリクエスト・転送が増える）。**Aurora の 2 つが平均 1 ACU で動くと月 約 $475**（それぞれ ＋$55）。
- **立ち上げ直後（サービスの DesiredCount が 0 のあいだ）は月 約 $268**（Fargate が無い）。
- **CloudFront のフラットレートのプランが使えない場合**（Free Tier の期間のアカウントは購読できない。4.3）、CloudFront 用の WAF の分（$5＋ルール 4＋リクエスト）で月 約 $9 増える。
- 含めていないもの: 消費税、AWS サポートのプラン、新規アカウントの Free Tier のクレジット（あれば最初の月々から差し引かれる）、オンプレ（Strapi・n8n・監視アプリ・OpenSEO）と外部 SaaS（Anthropic・PostHog・GA4・Cal.com・DataForSEO・Google Workspace）。
- **下げる余地**（いずれも未適用。判断は R1）: Fargate の Compute Savings Plans（Aurora Serverless v2 にはリザーブドインスタンスが効かない）、Fargate の ARM（Graviton。2 つの公式イメージは arm64 に対応。月 $27 前後下がる。2026-10-26 は x86 のままと決めた）、mautic-cron を 0.25 vCPU・0.5 GB に下げる（実測の後）。インターフェースの VPC エンドポイントで NAT を置き換えるのは、エンドポイント 1 つ × 2 AZ で月 $20 前後かかり、この規模では NAT より高い。

固定費がかかる要素: ALB、WAF（ALB 用。フラットレートプランの対象外）、Fargate（4 サービス〈mautic-web・mautic-cron・chatwoot-web・chatwoot-worker〉。タスクは各 1。自作のサービスは Lambda〈ADR-26〉）、Aurora（MySQL・PostgreSQL とも Serverless v2 で最小 0.5 ACU〈各 月 $55 前後〉＋ストレージと I/O）、ElastiCache（1 ノード）、NAT Gateway（1 つ）、EFS、
**EC2 t4g.nano（WireGuard。1 台）と Elastic IP（public IPv4 の課金）と EBS 8 GB（gp3）**、
Secrets Manager（20 個 + RDS が管理するマスターの 2 個 = 22 個。1 個あたり月 $0.40 前後）、CloudWatch（アラーム 30 個〈`alarms.yaml` の 28 個と `observability.yaml` のハートビートの 2 個〉、ログ、メトリクス）。

**ADR-21 による増減（概算。単価は見積もりで確かめる）**: Fargate のサービスが 2 つ減る（Strapi と n8n が各 1 vCPU・2 GB。東京の公表単価からの概算で、1 つあたり月 $45 前後。n8n は runners のサイドカー分も減る）。
EC2 t4g.nano（月 $4 前後）、Elastic IP（public IPv4 は 1 つ月 $3.65）、EBS 8 GB（月 $1 未満）が増える。Secrets Manager が 9 個減る（月 $3.6 前後）。アラームは 4 つ減って 2 つ増える（さらに n8n のハートビートのアラームが 1 つ増える）。
**ADR-25 による増減**: Fargate のサービスが 1 つ減る（Umami。0.5 vCPU・1 GB）。Secret が 3 個減る（`umami/DB_PASSWORD`・`APP_SECRET`・`DATABASE_URL`）。アラームが 2 つ減る。ECR が 1 本、ALB のリスナールールが 3 つ、ターゲットグループが 1 つ、Route 53 のレコードが 1 つ減る。
オンプレから RDS への通信は WireGuard の EC2 を通り、NAT Gateway は通らない。RDS の応答と Webhook（AWS からインターネットへ出る分）は、インターネットへのデータ転送料の対象（Strapi の記事とワークフローの規模なら小さい見込みだが、見積もりに入れる）。

**このリポジトリの設計で増える費用（見積もりに入れること）**

- **Container Insights**（`cluster.yaml`）: ECS のタスク数のアラームに必要。メトリクスとログの分が増える。
- **WAF のログ**（`edge.yaml`。CloudWatch Logs）: Count のルールの誤検知を確かめるために出す。ブロックと Count だけを残す。
- **Secrets Manager**: 1 値 1 Secret にしたため、設計書の「約 18 個」より多い（Chatwoot 4 個など。CloudFormation の `GenerateSecretString` は 1 つの Secret に生成値を 1 つしか作れない）。
- **RDS のログ**（エラー・スロークエリ・PostgreSQL ログ）: ロググループを作って 30 日で消す。
- CloudFront は Free プラン（$0）の想定。WAF は CloudFront 用がプランに含まれ、ALB 用は別に課金される。

## 4. デプロイ手順

以降のコマンドの `<...>` は置き換える。値はスタックの出力から読む（`aws cloudformation describe-stacks --stack-name comegin-prod --query 'Stacks[0].Outputs'`）。

### 4.1 global（us-east-1）: ACM 証明書と CloudFront 用 WAF

```bash
cd cloud
sam deploy --config-env global
aws cloudformation describe-stacks --region us-east-1 --stack-name comegin-global-prod --query 'Stacks[0].Outputs'
```

出力の `CertificateArn` と `WebAclArn` を、`samconfig.toml` の本番のパラメータ `CloudFrontCertificateArn` と `CloudFrontWebAclArn` に書く（必須。既定なし）。
ACM の証明書は DNS 検証。Route 53 に検証用のレコードが自動で作られ、検証が通るまで数分待つ。

### 4.2 本番スタック（ap-northeast-1）

```bash
sam build         # 必須（2026-10-11 から）。faq-bot・consent-api・admin-auth の Lambda を各 Makefile（pnpm と esbuild）でまとめる。開発機に pnpm 11 が要る
sam deploy        # 初回は RDS・ElastiCache・ACM の検証で 30 分前後かかる
```

**`sam build` を飛ばすと、faq-bot（4.17）・consent-api（4.18）・admin-auth（4.19）の `CodeUri`（TypeScript のソースと開発用の依存）がそのまま zip になり、`index.handler` が無いまま作られる。** 親のテンプレートは 3 つのスタックを無条件で作るため、使わない場合でも build は省けない（faq-bot は受信箱にボットを接続しない限り、訪問者には影響しない。consent-api と admin-auth は ALB から呼ばれるので、build を飛ばすと同意の受け口とログインが 502 になる）。

作られるもの: ネットワーク、**WireGuard の EC2（Elastic IP つき）と、private サブネットの経路**、ECR、SNS、データストア、Secrets、ALB と WAF、CloudFront、SES のドメイン ID、アラーム、
**IAM ユーザー 2 つ（オンプレの Strapi・n8n 用。アクセスキーは無い）**、ECS のサービス（**すべて DesiredCount 0**）。
サービスは 0 台のまま作られ、イメージがまだ無くても問題ない（タスク定義はイメージの存在を検査しない）。
WireGuard の EC2 は、デプロイの直後から起動する（オンプレの公開鍵が空のあいだは、ピアを持たず、トンネルは張れない）。次の 4.2.1 で鍵を受け渡す。

#### 4.2.1 WireGuard（オンプレとの接続）: 鍵の受け渡しとオンプレ側の設定

鍵は、EC2 の秘密鍵が EC2 の外に出ない形で受け渡す。**秘密鍵を CloudFormation・SSM・Secrets Manager・チャットに載せない。** 渡すのは公開鍵だけ（秘密鍵ではないので、CloudFormation のパラメータと SSM のパラメータに載せてよい）。
下の手順は、2026-10-28 に本番でトンネルが通った順番。オンプレ側の詳細は `onprem/wireguard/README.md`。

```
オンプレ（10.99.0.2）                                 AWS（VPC 10.20.0.0/16）
 ├ 秘密鍵: ~/.config/comegin/wireguard/private.key     ├ WireGuard の EC2（wg0 = 10.99.0.1 / Elastic IP = 出力 WireguardPublicIp）
 │   （このマシンから出さない）                         │   秘密鍵: /etc/wireguard/server.key（EC2 から出さない）
 └ wg0 ──── UDP 51820（オンプレから外向きに接続）───▶   ├ オンプレ → RDS の 5432 だけを通す
          ◀─── Webhook（10.99.0.2:5680 だけ）────────   └ Mautic・Chatwoot → n8n の Webhook だけを通す
```

| 値 | 作る場所 | 渡し方 |
|---|---|---|
| EC2 の公開鍵 | EC2 の中（user-data が初回の起動で作る） | EC2 が SSM の `/comegin/<env>/wireguard/server-public-key` に書く → オンプレが読む |
| オンプレの公開鍵 | オンプレ（`onprem/wireguard/dev/gen-keys.sh`） | SSM の `/comegin/<env>/wireguard/onprem-public-key` と `samconfig.toml` の `OnpremWireguardPublicKey` → EC2 が 2 分ごとに読んでピアにする（`wg-peer-sync.timer`） |
| Elastic IP | CloudFormation | スタックの出力 `WireguardPublicIp` → オンプレの `Endpoint`（ポートは `WireguardPort`。既定 51820） |

| アドレス | 中身 |
|---|---|
| `10.99.0.0/24`（`OnpremWireguardCidr`） | トンネルの中だけで使うアドレス帯。VPC（`VpcCidr`。既定 `10.20.0.0/16`）の外で、重ならない値として決めた（AWS が割り当てたものではない） |
| `10.99.0.1`（`WireguardServerAddress`） | EC2 の `wg0`（仮想の NIC）。EC2 の本物の NIC（ENI）は VPC のアドレス（`10.20.0.x`）と Elastic IP を持ち、それとは別 |
| `10.99.0.2`（`OnpremPeerAddress`） | オンプレの `wg0`。Mautic・Chatwoot の Webhook の宛先（`10.99.0.2:5680`） |

以下のコマンドは、次の関数を定義してから使う（スタックの出力を読む）:

```bash
OUT() { aws cloudformation describe-stacks --region ap-northeast-1 --stack-name comegin-prod --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
```

**1. EC2 の公開鍵と Elastic IP を取り出す**（初回のデプロイのあと数分。`OnpremWireguardPublicKey` は空のままでよい）

```bash
aws ssm get-parameter --region ap-northeast-1 --name "$(OUT WireguardServerPublicKeyParameterName)" --query Parameter.Value --output text
OUT WireguardPublicIp
```

- 公開鍵が `ParameterNotFound` のままなら、EC2 の user-data が途中で止まっている（下の「つまずいたとき」）。

**2. オンプレで鍵を作る**（前提: `sudo apt install wireguard-tools`）

```bash
cd onprem/wireguard && ./dev/gen-keys.sh
```

- 秘密鍵は `~/.config/comegin/wireguard/private.key`（600）に置かれ、画面には公開鍵だけが出る。何度実行しても、既にある鍵は作り直さない。
- オンプレの LAN が `10.99.0.0/24` や `10.20.0.0/16` と重なっていないことを、`ip -br addr` と `ip route` で確かめる（重なると経路が食い違う。重なるなら上の 3 つのパラメータと `onprem/wireguard/wg0.conf.example` をそろえて変える）。

**3. オンプレの公開鍵を AWS に渡す**（**SSM と `samconfig.toml` の両方に入れる**）

```bash
# すぐ効く。EC2 は 2 分ごとにこの値を読み直して、ピアを足す
aws ssm put-parameter --region ap-northeast-1 --name "$(OUT OnpremPublicKeyParameterName)" \
  --type String --overwrite --value '<手順 2 で表示された公開鍵>'
```

同じ値を `cloud/samconfig.toml` の `parameter_overrides` に書く。あわせて AMI も固定する（次の `sam deploy` で反映。デプロイは急がなくてよい）:

```
"OnpremWireguardPublicKey=<手順 2 で表示された公開鍵>",
"WireguardFixedAmiId=<下のコマンドの値>",
```

```bash
aws ec2 describe-instances --region ap-northeast-1 --instance-ids "$(OUT WireguardInstanceId)" --query 'Reservations[0].Instances[0].ImageId' --output text
```

- **SSM だけに入れると、CloudFormation の管理値（`UNSET`）とずれ、次の `sam deploy` で `UNSET` に戻ってトンネルが切れる。** `samconfig.toml` だけだと、反映が次のデプロイまで待ちになる。
- **渡すのを忘れると、EC2 はオンプレを知らないので、要求を黙って捨てる**（オンプレの `wg show` に `latest handshake` が出ず、`0 B received` のまま。2026-10-28 の初回で起きた）。
- **AMI の固定は初回のデプロイのあとに必ず行う。** 既定は SSM の「最新」の AMI で、新しい AMI が出たあとのデプロイでインスタンスが置き換わると、**EC2 の秘密鍵が失われ、公開鍵が変わる**（オンプレの設定の作り直しが要る）。空でなければ SSM の「最新」より優先される。
- このデプロイに `UserData` の変更（2026-10-27 のスワップの追加など）も入っていると、EC2 は 1 回停止・起動する（置き換えはしない）。鍵とスワップはディスクに残るので、トンネルは数十秒で戻る。

**4. オンプレの設定を作って置く**

```bash
./dev/render-conf.sh --endpoint <手順 1 の Elastic IP> --server-public-key <手順 1 の EC2 の公開鍵>
sudo install -m 600 -o root -g root ~/.config/comegin/wireguard/wg0.conf /etc/wireguard/wg0.conf
```

- `render-conf.sh` は雛形 `onprem/wireguard/wg0.conf.example` に値を入れる。秘密鍵はファイルから直接読み、コマンドラインにも画面にも出さない。作られる設定の形:

```ini
[Interface]
Address = 10.99.0.2/32
PrivateKey = <オンプレの秘密鍵>
MTU = 1380
[Peer]
PublicKey = <EC2 の公開鍵>
Endpoint = <WireguardPublicIp>:51820
AllowedIPs = 10.20.0.0/16, 10.99.0.1/32
PersistentKeepalive = 25
```

- `AllowedIPs` は VPC の CIDR（`VpcCidr`。RDS への経路）と EC2 のアドレス（`10.99.0.1/32`）。**`PersistentKeepalive` が要る**（EC2 から先にオンプレへ送れない。オンプレの送信元ポートは NAT で変わる）。`ListenPort` は書かない（オンプレから外向きに接続する。`wg show` の `listening port` が毎回変わるのは正常）。
- **`MTU = 1380` は EC2 側と同じ値**（自動に任せると EC2 側が 8921 になり、PPPoE〈1454〉や DS-Lite・MAP-E〈1460〉の回線で外側の UDP が分割される）。
- EC2 側のピアの `AllowedIPs` は `10.99.0.2/32`（`OnpremPeerAddress`）だけ。EC2 は、オンプレからの通信も VPC からの通信も masquerade するので、オンプレに VPC のタスクの IP への経路は要らない（オンプレから見た Webhook の送信元は常に `10.99.0.1`）。

**5. 起動する**

```bash
sudo systemctl enable --now wg-quick@wg0
```

- 再起動後も自動で上がる。Strapi・n8n より先に上がる必要がある（`onprem/README.md` の「起動の順番」）。

**6. 疎通を確かめる**（手順 3 から数分以内）

| 場所 | コマンド | 合格の目安 |
|---|---|---|
| オンプレ | `sudo wg show wg0` | `latest handshake` が 2 分以内に出ていて、`transfer` の `received` が 0 B でない |
| オンプレ | `ping -c 3 10.99.0.1` | EC2 まで届く |
| オンプレ | `psql "host=<PostgresEndpoint> dbname=strapi user=strapi sslmode=verify-full sslrootcert=<RDS の CA 束>"` | RDS に繋がる（TLS の検証は 4.7 と同じ CA 束。接続先は RDS のエンドポイント名のまま。名前は VPC の private IP に解決される） |
| EC2（`aws ssm start-session --region ap-northeast-1 --target "$(OUT WireguardInstanceId)"`） | `sudo wg show` | ピアが 1 つ（オンプレの公開鍵）で、`latest handshake` がある |
| EC2 | `sudo nft list ruleset` | forward の既定が drop で、許可が、戻りの通信（`ct state established,related accept`）と新しい接続の 2 行の、計 3 行だけ |

**7. その後**

- Strapi・n8n を立ち上げる（WireGuard → Strapi → n8n の順。`onprem/README.md`）。設定スクリプトでは、段階 apps の `onprem` モジュールが手順 2〜6 と立ち上げを案内する。
- n8n の受け口が起動したら、各製品の管理画面で Webhook の送信先を設定する: Mautic は `http://10.99.0.2:5680/webhook/mautic-event`、Chatwoot は `http://10.99.0.2:5680/webhook/chatwoot-event`。HTTP だが、WireGuard の内側を通る。署名の検証（`I-11` `I-12`）は引き続き n8n 側で必須。
  Mautic・Chatwoot のタスクは、宛先が VPC の外（`10.99.0.0/24`）なので、private サブネットの経路表（`PrivateRouteToOnprem`）で EC2 に届く。届かないときは、SG（`WireguardSecurityGroup` の ingress が 4 つの SG から tcp 5680 か）、EC2 の送信元／宛先チェックが無効か、nftables のカウンターを順に見る。

**つまずいたとき**（上の 2 つは 2026-10-27〜28 の初回で起きた）:

| 症状 | 原因 | 対処 |
|---|---|---|
| 手順 1 の EC2 の公開鍵が `ParameterNotFound` のまま | user-data が途中で止まっている。初回は t4g.nano（512 MiB）で `dnf install` がメモリ不足で強制終了され（`Out of memory: Killed process ... (dnf)`）、鍵の生成から先が一つも実行されなかった | 下の「user-data が止まったとき」 |
| オンプレの `wg show` に `latest handshake` が無く、`0 B received`（`ping 10.99.0.1` は 100% loss） | **オンプレの公開鍵が EC2 に渡っていない**（SSM の `onprem-public-key` が `UNSET`）。WireGuard は知らない相手の要求を黙って捨てるので、オンプレからは「送っているのに返事が無い」としか見えない | 手順 3 を行う。`aws ssm get-parameter --region ap-northeast-1 --name "$(OUT OnpremPublicKeyParameterName)" --query Parameter.Value --output text` が、オンプレの `wg show` の `interface:` の `public key` と同じか確かめる |
| 上と同じ症状で、鍵は合っている | EC2 の公開鍵か Endpoint の取り違え／UDP 51820 の外向きを、オンプレの回線・ルーター・仮想マシンの NAT が止めている | オンプレの `[Peer] PublicKey` が手順 1 の値と同じか、`Endpoint` が手順 1 の Elastic IP か。EC2 の SG（`WireguardSecurityGroup`）は UDP 51820 を `WireguardIngressCidr`（既定 `0.0.0.0/0`）から受ける |
| handshake はあるが RDS に届かない | RDS の SG が WireGuard の EC2 からの 5432 を許していない／DB 名の違い（DB ユーザーの権限は `strapi` `n8n` だけ） | `network.yaml` の SG。EC2 で `sudo nft list ruleset` のカウンター |
| `/var/log/wireguard-setup.log` の最後が `FAILED to publish` | EC2 が公開鍵を SSM に書けなかった | インスタンスのロールと、public サブネットのインターネットへの経路を確かめ、下の手順で user-data を実行し直す |

**user-data が止まったとき**: SSM で入らなくても、`aws ec2 get-console-output --region ap-northeast-1 --instance-id "$(OUT WireguardInstanceId)" --latest --output text | grep -E 'part-001|Killed|FAILED'` で起動時の出力が読める（読み取りだけ）。テンプレートは、dnf の前に 1 GiB のスワップファイル（`/swapfile`）を作るように直してある。**user-data は初回の起動でしか流れない**（テンプレートの `UserData` の変更をデプロイすると EC2 は停止・起動するが、流れ直さない）ので、既に動いている EC2 は SSM で入って直す:

```bash
aws ssm start-session --region ap-northeast-1 --target "$(OUT WireguardInstanceId)"
# （EC2 の中。テンプレートの user-data の冒頭と同じことを手で行ってから、user-data をもう一度実行する。どれも何度実行しても同じ結果になる）
sudo bash -c 'if [ ! -f /swapfile ]; then dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none; chmod 600 /swapfile; mkswap /swapfile; fi; swapon --show=NAME --noheadings | grep -qx /swapfile || swapon /swapfile; grep -q "^/swapfile " /etc/fstab || echo "/swapfile none swap defaults 0 0" >> /etc/fstab'
free -m                                                  # Swap の total が 1023 前後になる
sudo bash /var/lib/cloud/instance/scripts/part-001       # 最後に「wireguard setup: done」（数分かかる）
sudo wg show                                             # interface: wg0 と listening port: 51820（ピアは手順 3 まで無い）
```

**運用**:

- ENI は別のリソースで、EC2 に差している。**インスタンスの置き換え（AMI やインスタンスタイプの変更）は、新しい EC2 が同じ ENI を使おうとして「使用中」で失敗し、ロールバックする見込み**（未検証）。意図せず鍵が入れ替わることを防ぐ副作用でもある。意図して置き換えるときは、古い EC2 を手で終了（`aws ec2 terminate-instances`）してから `sam deploy` する。ENI・Elastic IP・経路は引き継がれるので、オンプレの `Endpoint` は変わらない。**新しい EC2 の公開鍵（手順 1）でオンプレの設定を作り直し（`./dev/render-conf.sh ... --force`）、`sudo systemctl restart wg-quick@wg0` する。**
- OS の更新: SSM Session Manager で入り、`sudo dnf upgrade --security -y`（スワップがあるので t4g.nano でも足りる）。カーネルが更新されたときは再起動（ENI・Elastic IP・秘密鍵・nftables・systemd のユニットは変わらない。短く止まる）。止まっている間は、オンプレの Strapi・n8n が RDS に届かず、Webhook が欠落する（TA-05 の縮退運転）。
- 停止（ステータスチェックの失敗）は ops トピックに通知される。システム側の障害は自動復旧する（`WireguardSystemRecoverAlarm`）。トンネルそのもの（`latest handshake` の途絶）の監視は作っていない（5 節）。

### 4.3 global の 2 回目: フラットレートプランの購読

本番スタックの出力 `DistributionArn` を、global の `DistributionArn` に入れて更新する。`samconfig.toml` の `[global.deploy.parameters]` の `parameter_overrides` に `"DistributionArn=<ARN>"` を足す。

```bash
sam deploy --config-env global
```

- `PlanTier` の既定は FREE（即時に有効。$0）。有料のティアは `PENDING_APPROVAL` になり、`ApprovePaidSubscription` を呼ぶまで課金されない（CloudFormation は承認しない）。
- Free プランの WAF のルールは 5 つまで（このテンプレートは 4 つ）。
- **TODO(未検証)**: `AWS::PricingPlanManager::Subscription` を実機で作ったことがない。作れない（Free Tier のアカウントなど）場合は、購読を外して従量課金で運用する（CloudFront と WAF の費用が出る）。

### 4.4 通知先の購読（SNS）

トピックの作成と購読の設定は人間（R1）が行う。購読は自動では作らない。

```bash
OPS_TOPIC=<出力の OpsAlertTopicArn>
aws sns subscribe --region ap-northeast-1 --topic-arn "$OPS_TOPIC" --protocol email --notification-endpoint <通知先のメールアドレス>
# 確認メールの「Confirm subscription」の URL から Token を取り出し、次を実行する（メールのリンクは踏まない）
aws sns confirm-subscription --region ap-northeast-1 --topic-arn "$OPS_TOPIC" --token <Token> --authenticate-on-unsubscribe true
```

**`--authenticate-on-unsubscribe true` が要点。** SNS の通知メールには購読解除のリンクが付いており、転送を受けた人でも解除できてしまう。
これを防ぐのは、トピックポリシーではなく、購読の確認時にこのフラグを付けること（公式: Amazon SNS security best practices）。
**トピックポリシーで `sns:Unsubscribe` は制限できない**（SNS がトピックポリシーで受け付ける action に無く、書くと作成に失敗する。2026-10-27 の初回のデプロイで判明し、Deny を外した。公式: Valid Amazon SNS policy actions）。`comegin-lead-alert` も同じ手順で購読する。
TA-05 の「AWS コンソールで確認 URL を貼り付けて確認する」方法では、このフラグを付けられない。

購読の状態（`Confirmed` の数）の監視（TA-05 の項目 8）は作っていない。通知経路そのものが壊れた場合に SNS では知らせられないため、SNS 以外の手段が要る（未決定。5 節）。

### 4.5 IAM の管理ポリシーを付ける・オンプレの IAM ユーザーのキーを発行する

`iam.yaml` は、管理ポリシー 2 本と、オンプレの Strapi・n8n 用の IAM ユーザー 2 つを作る。**アクセスキーは作らない**（キーを CloudFormation の出力や状態に残さないため）。管理ポリシーの付与先の IAM ユーザー（またはロール）も、人間が作る。

| ポリシー（出力） | 付ける先 | 許すこと |
|---|---|---|
| `ControlPlanePolicyArn` | 監視アプリ（ローカル）の写し用の主体。**Claude Code の実行環境には渡さない** | E-15 の写しへの追記（`runs/` の `s3:PutObject` だけ）、名前空間 `ComeGin/Onprem` への `cloudwatch:PutMetricData` だけ。削除・読み取り・設定変更・アラームの操作は不可 |
| `DeployPolicyArn` | Astro の配信を承認して実行する人間の主体。**Claude Code の実行環境に置かない** | Astro バケットへの Put / Delete / List と、そのディストリビューションの `cloudfront:CreateInvalidation` だけ |

**オンプレの IAM ユーザー（ADR-21）**: 次の 2 つは、スタックが作る（ポリシーも付いている）。アクセスキーは人が発行する。

| IAM ユーザー | 許すこと | 使う場所 |
|---|---|---|
| `comegin-<env>-onprem-strapi-media` | Strapi のメディアのバケット（`comegin-<env>-strapi-media-<アカウント ID>`）への `s3:GetObject`・`PutObject`・`DeleteObject` と、`s3:ListBucket` だけ | オンプレの Strapi（`onprem/strapi` の秘匿ファイルの `AWS_ACCESS_KEY_ID`・`AWS_SECRET_ACCESS_KEY`。Strapi の S3 プロバイダーは SDK の既定の探索でこれを読む） |
| `comegin-<env>-onprem-n8n-sns` | `comegin-ops-alert`・`comegin-lead-alert` への `sns:Publish` と、名前空間 `ComeGin/OnpremN8n` だけへの `cloudwatch:PutMetricData`（n8n のスケジュール実行のハートビート）。購読の変更・トピックの設定変更・アラームの操作・監視アプリの名前空間（`ComeGin/Onprem`）への送信は不可 | オンプレの n8n の AWS の資格情報（エディターで、アクセスキーを入れる。SNS のノードとハートビートの HTTP Request ノードで同じ資格情報を使う。前回の Assume Role と Use System Credentials は使わない） |

アクセスキーの発行（**人が自分の端末で実行する。Claude Code の実行環境では実行しない。キーを画面に出さず、ファイルに直接書く**）:

```bash
( umask 077
  aws iam create-access-key --user-name comegin-prod-onprem-strapi-media \
    --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text > ./strapi-media.key )
# 中身は「アクセスキー ID<タブ>シークレット」。オンプレの秘匿ファイルの値に写したら、このファイルを消す（shred -u ./strapi-media.key）。
# n8n 用も同じ（--user-name comegin-prod-onprem-n8n-sns）。n8n のエディターの資格情報に入れたら、ファイルを消す。
```

- キーは 1 ユーザーあたり 2 つまで。ローテーションは、新しいキーを作って切り替え、古いキーを `aws iam update-access-key --status Inactive` で止めて動作を確かめてから、`aws iam delete-access-key` で消す。
- **キーを Claude Code の環境変数に引き継がない**（監視アプリの許可リスト方式の `env` のとおり）。キーが漏れた疑いがあれば、すぐに `delete-access-key` する（権限は上の 1 バケットか 2 トピックだけ）。
- スタックは、ユーザーとポリシーを作るだけで、キーの有無を知らない。キーを作っても、CloudFormation の状態にも出力にも残らない。

### 4.6 Secrets の値を入れる（プレースホルダ 7 個）

`secrets.yaml` の Secret のうち 13 個は自動生成（英数字のみ）。次の 7 個は値なしで作られるので、人間が入れる。**値を入れる前にそのサービスの DesiredCount を上げない**（ECS がタスクの起動に失敗する）。
生成された値を変えない（暗号化の鍵・ソルトを変えると既存のデータを復号できなくなる）。**Secrets Manager の値を消したり作り直したりしない。**
Strapi と n8n の鍵類（`APP_KEYS`・`ENCRYPTION_KEY`・`N8N_ENCRYPTION_KEY`・PostHog のトークンなど）は、オンプレで動かす（ADR-21）ので、Secrets Manager に置かない。オンプレの秘匿ファイルにだけ置く。

| Secret | 入れる値 | 出どころ |
|---|---|---|
| `comegin/<env>/admin-auth/GOOGLE_CLIENT_SECRET` | Google の OAuth クライアントのシークレット | Google Cloud（Workspace の「内部」）。承認済みのリダイレクト URI は `https://<AuthHost>/api/auth/callback/google`。クライアント ID は親のパラメータ `GoogleClientId` |
| `comegin/<env>/mautic/SMTP_USERNAME` `SMTP_PASSWORD` | Mautic 用の SES の SMTP 認証情報 | 4.9 |
| `comegin/<env>/chatwoot/SMTP_USERNAME` `SMTP_PASSWORD` | Chatwoot 用の SES の SMTP 認証情報（Mautic とは別に発行） | 4.9 |
| `comegin/<env>/faq-bot/CHATWOOT_BOT_TOKEN` `CHATWOOT_BOT_SECRET` | Chatwoot のエージェントボット「FAQ ボット」の access_token と secret | 4.17 |

値は、シェルの履歴に残らない方法で入れる:

```bash
read -rs SECRET_VALUE   # 入力が画面に出ない
aws secretsmanager put-secret-value --region ap-northeast-1 --secret-id comegin/prod/admin-auth/GOOGLE_CLIENT_SECRET --secret-string "$SECRET_VALUE"
unset SECRET_VALUE
```

### 4.7 イメージを ECR に置く

イメージは ECR に置く（Docker Hub の取得回数の制限と、上流のタグの付け替えの影響を避けるため）。**タグは不変**（同じタグを上書きできない）。**`latest` は使わない**（パラメータが拒否する）。
**Fargate は X86_64 で動かす。** 開発機が ARM（Apple Silicon など）の場合は `--platform linux/amd64` を必ず付ける。

```bash
ACCOUNT=<AWS のアカウント ID>
REGION=ap-northeast-1
ECR=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ECR
```

#### すべてのサービスが DB の証明書を検証して接続する

暗号化だけで証明書を検証しない設定（証明書の検証を切る指定、`no-verify` の指定など）は入れていない。

- **RDS の CA**（`https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`）は、DB に接続する各イメージが持つ。上流のイメージは、薄い**派生イメージ**（`cloud/images/<製品>/Dockerfile`）にして ECR に置く。
  `FROM <上流>:<固定のタグ>` に CA を足すだけで、Mautic だけは設定ファイルへの小さなパッチも入る（下の表）。**Strapi と n8n はオンプレで動かす（ADR-21）ので、ECR に置かない。** オンプレの Strapi・n8n も、同じ CA 束（下の SHA-256 で確かめたもの）で RDS の証明書とホスト名を検証して接続する（`onprem/` 側の設定）。
- CA の取得はビルド時（`ADD --checksum=sha256:...`）で、**SHA-256 は `90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b`**（2026-10-28 に取得した 114 証明書の束。配信元の更新日は 2026-10-14）。履歴: 2026-10-04 の 111 証明書の束（`fe45bbebf92a…`）→ 2026-10-28 に、オンプレの Strapi のビルドが `digest mismatch` で止まって更新に気づいた。増えた 3 枚は sa-west-1 の Amazon RDS のルート CA（RSA2048・RSA4096・ECC384。発行日 2026-09-02）で、114 枚すべてが O=Amazon Web Services・OU=Amazon RDS の自己署名のルート CA、東京（ap-northeast-1）の 3 枚も入っていることを確かめた。
  AWS が束を更新すると、**ビルドも ops-tasks のタスクも失敗する（意図した動作。改ざんの検知と、CA の更新を人が確かめるため）。** 更新の手順:
  気づき方: `docker compose build`（オンプレの Strapi・n8n）や派生イメージのビルドが `failed to solve: digest mismatch sha256:<今の束>: sha256:<固定した値>` で止まる。DB 作成のタスク（4.8）はログに `sha256sum: WARNING: 1 computed checksum did NOT match` が出て `exitCode` が 1 になる。
  1. 束を取得し、**中身が正規の更新か**を確かめる（2026-10-28 に行った手順）:

     ```bash
     mkdir -p /tmp/rds-ca && cd /tmp/rds-ca
     curl -fsS -o a.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
     curl -fsS -o b.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem   # 2 回取って同じか
     sha256sum a.pem b.pem                                     # ビルドのエラーの「今の束」の値と一致するか
     curl -fsSI https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem | grep -i last-modified
     grep -c 'BEGIN CERTIFICATE' a.pem                         # 枚数（前回から何枚増えたか）
     awk '/BEGIN CERT/{n++} {print > ("c" n ".pem")}' a.pem
     for f in c*.pem; do openssl x509 -in "$f" -noout -subject -issuer -startdate -nameopt RFC2253 | paste -sd'|'; done > certs.txt
     grep -vc 'O=Amazon Web Services' certs.txt                # 0 であること（ほかの発行者が混ざっていない）
     grep -c 'ap-northeast-1 Root CA' certs.txt                # 3 であること（本番の RDS の CA が残っている）
     sort -t'|' -k3 -r certs.txt | head -5                     # 新しい証明書（増えた分）が何か
     ```

     合格の目安: すべてが `O=Amazon Web Services`・`OU=Amazon RDS` の自己署名のルート CA（subject と issuer が同じ）で、増えた分が新しいリージョンのものなど説明のつくもの。説明のつかない発行者や中間 CA が混ざっていたら、値を更新せずに止まって調べる。
  2. `sha256sum` の値を、次の **8 か所** に反映する（7 か所はリポジトリ。どれも `ADD --checksum` か `sha256sum -c` で照合する）:
     - `cloud/images/chatwoot/Dockerfile`・`cloud/images/mautic/Dockerfile` の `RDS_CA_SHA256`
     - `onprem/n8n/Dockerfile`・`backend/strapi-system/Dockerfile` の `RDS_CA_SHA256`（オンプレ。2026-10-27 に Strapi も照合する形にそろえた）
     - `cloud/template.yaml` の親のパラメータ `RdsCaSha256` の既定値と、`cloud/stacks/ops-tasks.yaml` の `RdsCaSha256` の既定値
     - この節の上の SHA-256 の値（と履歴）
     - **`samconfig.toml` の `parameter_overrides` の `RdsCaSha256`**（書いてある場合。**テンプレートの既定値より優先されるので、ここが古いままだとデプロイしても反映されない**。2026-10-28 に、既定値だけを直してデプロイし、タスク定義が古い値のまま残った）。`grep -n RdsCaSha256 cloud/samconfig.toml` で確かめる
  3. `cd cloud && sam build && sam deploy` で、DB 作成のタスク定義を新しい版にする。反映されたかは、次の値が新しい SHA-256 になっていることで確かめる:

     ```bash
     aws ecs describe-task-definition --region ap-northeast-1 --task-definition comegin-prod-db-init-postgres \
       --query "taskDefinition.containerDefinitions[0].environment[?name=='RDS_CA_SHA256'].value | [0]" --output text
     ```

     待てないときは `aws ecs run-task` に `--overrides '{"containerOverrides":[{"name":"psql","environment":[{"name":"RDS_CA_SHA256","value":"<新しい値>"}]}]}'` を付けて 1 回だけ新しい値で照合できる（CloudFormation の値とずれるので、あとで必ずデプロイする）。
  4. オンプレの Strapi・n8n をビルドし直す（`docker compose build --no-cache`。`onprem/README.md` の「起動の順番」）。2 つの派生イメージは、次に版を上げるときに、ビルドの連番を上げたタグでビルドし直して push する（古い束でも東京〈ap-northeast-1〉の CA が入っていれば、動いているイメージはそのままでよい）。
- ElastiCache（`rediss://`）は、Amazon の公開 CA で署名されており、Node（consent-api）と Ruby（Chatwoot）の既定の信頼ストアで検証される。検証を無効にする設定は入れていない。
- 自作の admin-auth（Lambda。ADR-26）は、Lambda の実行環境の `/var/runtime/ca-cert.pem`（RDS の CA を含む）を `NODE_EXTRA_CA_CERTS` で読む（2026-10-12 まではイメージに同梱していた）。

| 接続元 | 検証のしかた（テンプレートの設定） | 検証の状況 |
|---|---|---|
| Chatwoot（Rails・libpq） | `PGSSLMODE=verify-full`、`PGSSLROOTCERT=/etc/rds/global-bundle.pem` | libpq は、自作の CA のローカルの PostgreSQL で確認済み（正しいとき接続、CA が無いときとホスト名が違うときは失敗）。Chatwoot の Rails 本体では未 |
| Mautic（Doctrine・PDO と起動時の `mysqladmin ping`、インストーラー） | `config.php` に `PDO::MYSQL_ATTR_SSL_CA` と `PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT` を足し（Dockerfile の 2。2 か所に入ったことと `php -l` を確かめ、確かめられなければビルドが失敗する）、インストーラーの `SchemaHelper` にも同じ指定を足す（3）。mariadb-admin の設定（`/etc/mysql/conf.d/rds-ssl.cnf`）に `ssl-ca` と `ssl-verify-server-cert`（1）。Aurora MySQL は `require_secure_transport=ON`（`data.yaml`） | **1・2 を入れた時点の派生イメージのビルドは確認済み。PHP 8.3 の PDO と `mysqladmin` は、自作の CA のローカルの TLS つき MySQL で確認済み**（正しいとき接続、CA が違うときとホスト名が違うときは失敗）。**3〜5（2026-10-26 に追加）は、取り込み済みの 7.2.0 のソースと上流の cron の定義の写しでパッチが当たることだけを確かめ、通しのビルドは未**。Mautic 本体の起動は未 |
| admin-auth | `DATABASE_SSL=true`（CA は `NODE_EXTRA_CA_CERTS=/var/runtime/ca-cert.pem`。Lambda の実行環境のもの） | edge が実装済み。実機では未 |
| オンプレの Strapi・n8n（WireGuard 経由） | `onprem/` の設定（Strapi は `DATABASE_SSL=true`、n8n は `DB_POSTGRESDB_SSL_CA_FILE` と `REJECT_UNAUTHORIZED=true`）。接続先は RDS のエンドポイント名（ホスト名の検証が通る） | 未（実機で、トンネルを張ってから確かめる） |
| ops-tasks の DB 作成タスク | 起動時に CA を取得して SHA-256 を照合し、`PGSSLMODE=verify-full`（MySQL は `--ssl-mode=VERIFY_IDENTITY`） | CA の取得と照合は、各イメージで確認済み |

**重要（Prisma）**: Prisma の Rust のエンジン（起動時の `prisma migrate deploy`）は、`sslmode` が `require` でも `verify-full` でも証明書を検証しない（上のローカルの実験で、CA が無くても繋がった）。
検証するのは `sslaccept=strict` を付けたときだけ。外すと、暗号化だけで検証しない設定に戻る。いま Prisma を使うサービスは無い（以前の Umami で確かめた。ADR-25 で外した）。Prisma の製品を足すときは URL に `sslaccept=strict` を付ける。
なお、Node の pg は sslmode の `require` を `verify-full` の別名として扱うが、pg v9 では libpq 互換（検証しない）に変わる予定なので、`verify-full` と明示している。

#### 派生イメージ（2 本。上流をタグとダイジェストで固定してビルドする）

タグは `<上流のタグ>-<ビルドの連番>`（再ビルドするときは連番を上げる。ECR のタグは上書きできない）。
上流は **タグとダイジェストの両方**で固定する（`UPSTREAM_TAG` と `UPSTREAM_DIGEST`。どちらも必須。上流のタグは付け替えられうるので、CA の更新などで作り直したときに別の中身を取り込まないため。ダイジェストがあれば Docker はそれを使う）。ダイジェストは `docker buildx imagetools inspect <イメージ>:<タグ>` の `Digest`（読み取りだけ）。上流の版を上げたら両方を変える。

| 製品 | Dockerfile | `UPSTREAM_TAG` | `UPSTREAM_DIGEST`（2026-10-27 に取得） | ECR のリポジトリ | パラメータの例 |
|---|---|---|---|---|---|
| Chatwoot | `cloud/images/chatwoot` | `v4.18.0`（**4.12 以上**。署名つき Webhook の `X-Chatwoot-Signature` は 4.12 以降。API チャネルとエージェントボットの署名は 4.13 以降） | `sha256:b419dded7e9d2f54a24fd427b74ba7e6069d601b500618045c1eb6c01a1cc9a1` | `comegin/<env>/chatwoot` | `ChatwootImageTag=v4.18.0-1` |
| Mautic | `cloud/images/mautic` | `7.2.0-apache`（公式に 7.x のタグがある。取り込み済みのソースは 7.2.0） | `sha256:dea3bb71a5c5bf4c0c7d1764e58a32109898e7b2e6a710f14f50e2a913c03a0f` | `comegin/<env>/mautic` | `MauticImageTag=7.2.0-1` |

```bash
docker build --platform linux/amd64 --build-arg UPSTREAM_TAG=v4.18.0 \
  --build-arg UPSTREAM_DIGEST=sha256:b419dded7e9d2f54a24fd427b74ba7e6069d601b500618045c1eb6c01a1cc9a1 \
  -t $ECR/comegin/prod/chatwoot:v4.18.0-1 cloud/images/chatwoot
docker push $ECR/comegin/prod/chatwoot:v4.18.0-1
```

Mautic の派生イメージが足すもの（`cloud/images/mautic/Dockerfile` の 1〜5）: 1 `mysqladmin` の TLS、2 Doctrine の PDO の TLS、3 インストーラーの PDO の TLS、4 cron に `mautic:webhooks:process`（毎分）、5 `MAUTIC_TRUSTED_PROXIES` を `config/parameters_local.php` に写す entrypoint のラッパー（`comegin-entrypoint.sh`）。
**Mautic のタスク定義に `DEBUG=true` を入れない**（上流の起動の検査が、DB のパスワードなどの環境変数をログに出すため）。上流の cron の entrypoint は `MAUTIC_*` の環境変数をコンテナの中の `/tmp/cron.env` に書く（上流の挙動。コンテナの外には出ない）。

タグを設定ファイル（`samconfig.toml`）に書いてデプロイする（`REPLACE-WITH-FIXED-TAG` のままでは起動しない）。

#### 自作のサービス

自作のサービス（admin-auth・consent-api・faq-bot）は Lambda（ADR-26）で、イメージを作らない（`sam build` が zip にする。4.17〜4.19）。

### 4.8 データベースとアプリ用ユーザーを作る（1 回だけ）

PostgreSQL に `chatwoot` / `admin_auth` / `strapi` / `n8n` のデータベースとユーザー（同じ名前）を、MySQL に `mautic` を作る。パスワードは Secrets Manager のアプリ用の値に揃える。
`strapi` と `n8n` は、オンプレの Strapi・n8n が WireGuard 経由で使う（ADR-21）。作り方は同じで、使うのはオンプレ側だけ。
冪等なので、何度実行してもよい（パスワードを Secret の値に揃え直す）。chatwoot のデータベースには拡張（`vector`・`pg_trgm`・`pg_stat_statements`）も入れる。

手順（2026-10-28 に本番で通した形。端末の幅で長い行が折り返されても壊れないよう、1 行を短くして `\` でつないである。`\` の後ろに空白を入れない）:

```bash
# 1. 変数を用意する（関数の定義と変数の設定は行を分ける。端末を開き直したら、ここからやり直す）
REGION=ap-northeast-1
OUT() {
  aws cloudformation describe-stacks \
    --region "$REGION" \
    --stack-name comegin-prod \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text
}
CLUSTER=$(OUT ClusterName)
SUBNETS=$(OUT PrivateSubnetIds)
OPS_SG=$(OUT OpsTasksSecurityGroupId)
echo "CLUSTER=$CLUSTER"     # comegin-prod
echo "SUBNETS=$SUBNETS"     # subnet-...,subnet-...（private サブネット 2 つ）
echo "OPS_SG=$OPS_SG"       # sg-...

# 2. タスク定義の CA 束のハッシュが、今の束と同じかを確かめる（4.7。違うと手順 3 のタスクが照合で失敗する）
aws ecs describe-task-definition \
  --region "$REGION" \
  --task-definition comegin-prod-db-init-postgres \
  --query "taskDefinition.containerDefinitions[0].environment[?name=='RDS_CA_SHA256'].value | [0]" \
  --output text

# 3. PostgreSQL（chatwoot・admin_auth・strapi・n8n）
TASK=$(aws ecs run-task \
  --region "$REGION" \
  --cluster "${CLUSTER:?CLUSTER が空}" \
  --launch-type FARGATE \
  --task-definition comegin-prod-db-init-postgres \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$OPS_SG],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' \
  --output text)
echo "TASK=$TASK"           # arn:aws:ecs:...（None なら --query を外して実行し、failures を見る）

aws ecs wait tasks-stopped \
  --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK"      # 止まるまで待つだけ（成否は次で見る。最長 10 分）

aws ecs describe-tasks \
  --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK" \
  --query 'tasks[0].[containers[0].exitCode, stoppedReason]'
#  → [0, "Essential container in task exited"] なら成功

aws logs tail /comegin/prod/tasks --region "$REGION" --since 15m
#  → CREATE ROLE・CREATE DATABASE・CREATE EXTENSION（chatwoot の 3 つ）の後に「db-init-postgres: done」

# 4. MySQL（mautic）。手順 3 の --task-definition を comegin-prod-db-init-mysql にして同じことを行う
#    → ログの最後が「db-init-mysql: done」
```

| 症状 | 原因 | 対処 |
|---|---|---|
| `ClusterNotFoundException: Cluster not found` | 変数 `CLUSTER` が空（端末を開き直した・手順 1 を飛ばした）。空の `--cluster` は `default` のクラスターを探しに行く | 手順 1 からやり直す。`${CLUSTER:?...}` の書き方なら、空のときは AWS を呼ぶ前に止まる |
| `bash: 予期しないトークン ... 周辺に構文エラー` | 関数の定義の `}` の後ろに `;` が無いまま、同じ行で次のコマンドを続けた | 手順 1 のとおり行を分ける |
| `aws: error: argument --query: expected one argument` と「コマンドが見つかりません」 | 貼り付けたときに長い行が `--query` の直後で折り返され、改行が入った | 手順 1 の、行を短くして `\` でつないだ形を使う |
| `exitCode` が 1 で、ログに `sha256sum: WARNING: 1 computed checksum did NOT match` | タスク定義の `RDS_CA_SHA256` が今の束と違う | 4.7 の更新の手順（特に `samconfig.toml` の `RdsCaSha256`） |
| `exitCode` が `null` で `stoppedReason` に `CannotPullContainerError` | Docker Hub のイメージを取得できない | private サブネットの NAT の経路 |
| ログに `password authentication failed` か `could not connect` | RDS のマスターの資格情報か、ops-tasks の SG から RDS への 5432 | `ops-tasks.yaml`・`network.yaml` |

- このタスクは、Docker Hub の公開イメージ（`postgres:16.15-alpine`、`mysql:8.4.11`。マイナーまで固定）を NAT 経由で取得し、**起動時に RDS の CA 束を取得して SHA-256 を照合したうえで、サーバー証明書とホスト名を検証して接続する**（PostgreSQL は `verify-full`、MySQL は `VERIFY_IDENTITY`）。AWS が束を更新すると照合に失敗する（4.7 の更新の手順）。
- **RDS のマスターの資格情報を読めるのは、このタスクの実行ロール（`comegin-<env>-ops-tasks-execution`）だけ。どのサービスのタスク定義からも参照しない。** 運用者が RunTask で起動したときだけ読まれる。
- TODO(未検証): `MYSQL_PWD` は非推奨だが 8.4 でも使える想定。使えなければ `--defaults-extra-file` に替える。

**`strapi` と `n8n` のパスワードをオンプレに渡す**（人が実行する。画面に出さず、ファイルに直接書く）。DB 作成のあと（パスワードが Secret の値に揃ったあと）に、オンプレの秘匿ファイルの `DATABASE_PASSWORD`（Strapi）と `DB_POSTGRESDB_PASSWORD`（n8n）に写す:

```bash
( umask 077
  aws secretsmanager get-secret-value --region ap-northeast-1 --secret-id comegin/prod/strapi/DB_PASSWORD --query SecretString --output text > ./strapi-db.pw
  aws secretsmanager get-secret-value --region ap-northeast-1 --secret-id comegin/prod/n8n/DB_PASSWORD --query SecretString --output text > ./n8n-db.pw )
# 値をオンプレの秘匿ファイルに写したら、./strapi-db.pw と ./n8n-db.pw を消す（shred -u）。
```

あわせて、オンプレの秘匿ファイルの `DATABASE_HOST`（Strapi）と `DB_POSTGRESDB_HOST`（n8n）には、PostgreSQL のクラスターのエンドポイントを入れる（親スタックの出力には無い。IP アドレスで書かない。TLS の検証はこのホスト名で行う）:

```bash
aws rds describe-db-clusters --region ap-northeast-1 --db-cluster-identifier comegin-prod-postgres --query 'DBClusters[0].Endpoint' --output text
```

Secret は、スタックを作り直すと新しい値になる（2026-10-27 の作り直しで変わった）。**前に写した値は使わず、DB 作成のあとに取り出し直す。** オンプレの起動の手順は `onprem/README.md` の「起動の順番」。

この 2 つの Secret は、ECS のどのタスク定義も参照しない（`ops-tasks` の DB 作成タスクだけが読む）。**値を変えたら、`db-init-postgres` を再実行して RDS 側のユーザーのパスワードを揃え、オンプレの秘匿ファイルも更新する。**

運用者が DB に入る必要があるときは、**踏み台を置かない**。ECS Exec か Session Manager のポートフォワードを使う（TA-06 の 5.6）:

```bash
aws ecs execute-command --cluster "$CLUSTER" --task <タスク ARN> --container <コンテナ名> --interactive --command "/bin/sh"
```

### 4.9 SES: 本番アクセスの申請と SMTP 認証情報

1. **本番アクセスの申請**（AWS コンソールの SES）。**現在はサンドボックス**（24 時間で 200 通、毎秒 1 通。検証済みの宛先にしか送れない）。顧客向けメールを送る前（BA-04 のトスアップを始める前）に済ませる。申請には配信停止と苦情の扱いの説明が要る。
2. ドメイン ID（`ses.yaml`）の DKIM と MAIL FROM が `Verified` になるのを待つ（Route 53 のレコードは自動）。
3. **SMTP 認証情報を Mautic 用と Chatwoot 用で別々に発行する**（コンソール: SES → SMTP settings → Create SMTP credentials）。ユーザー名と SMTP パスワードを 4.6 の Secret に入れる。SMTP のエンドポイントは `email-smtp.ap-northeast-1.amazonaws.com`、ポート 587（STARTTLS）。
4. **apex（`comegin.com`）の SPF と DMARC は作っていない。** `comegin.com` は Google Workspace のメールも使っており、apex には既に MX と SPF の TXT があると思われる（未確認）。SPF の TXT は 1 つしか持てないため、`include:amazonses.com` を既存の SPF に足す作業と、DMARC の設定は人間が行う。MAIL FROM のサブドメイン（`bounce.`）の MX と SPF は `ses.yaml` が作るので、衝突しない。
5. **受信サーバーへの TLS は必須（`SesTlsPolicy=REQUIRE`）**。TLS で繋がらない受信先には送らない（問い合わせの内容や氏名を平文で流さない）。届かない宛先が業務に要ると分かったら、`R1` の判断でデプロイの設定ファイルに `SesTlsPolicy=OPTIONAL` を書いてデプロイする。
6. バウンスと苦情を Mautic に返す経路は未決定（TA-06 の 11 節）。SES のイベントを社内の通知（ops）に流すと、宛先のメールアドレスが載ってしまうため、ここでは設定していない。

### 4.10 マイグレーションとアプリの初期設定

**移行を Web のタスクの起動処理に入れない**（タスクが複数起動すると並行して走るため。TA-06 の 3.3）。製品ごとに、次のとおりにする。
RunTask でサービスのタスク定義のコマンドを上書きする場合の書式（Chatwoot の例）:

```bash
CHATWOOT_SG=$(OUT ChatwootWebSecurityGroupId)
TASK=$(aws ecs run-task --cluster "$CLUSTER" --launch-type FARGATE --task-definition comegin-prod-chatwoot-web \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$CHATWOOT_SG],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"chatwoot","command":["bundle","exec","rails","db:chatwoot_prepare"]}]}' \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK"
aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].containers[0].exitCode'   # 0 であること
```

| サービス | 手順 |
|---|---|
| **Chatwoot** | 上の `db:chatwoot_prepare`（entrypoint は `docker/entrypoints/rails.sh` のまま、`command` だけ上書き）。**初回とイメージを更新するたびに、サービスを起動する前に実行する。** Webhook（オンプレの n8n。`10.99.0.2:5680`）を送れるよう、タスク定義に `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true` を入れてある（宛先ごとの許可が無いので、Chatwoot の SG の出口を 443・587・RDS・Valkey・`10.99.0.2:5680` だけに絞っている。`network.yaml`）。 |
| **admin-auth** | **運用の Lambda で行う**（4.19。RunTask は使わない）。① `{"action":"migrate"}`（許可リストの初期値も入る）② `{"action":"register-alb-client"}`。**① のあとでないと、ログインの判定が 500 になる** |
| **Mautic** | **RunTask は要らない。** 公式の entrypoint が、インストール済み（`config/local.php` に `db_driver` と `site_url` がある）なら、web ロールの起動のたびに `doctrine:migrations:migrate` を実行する。未インストールのあいだは何もせず、cron は**インストールが終わるまで待つ**。初回は、`mautic-web` を起動し、ログインした管理者がブラウザで `https://<MktHost>/installer` を開いてインストールする（`/installer` は OIDC の内側）。`local.php` は EFS の `config` に保存され、再起動で消えない。CLI でするなら ECS Exec（`su -s /bin/sh www-data -c 'cd /var/www/html && php ./bin/console mautic:install https://<MktHost> --admin_email=<…> --admin_password=<…>'`。未検証）。管理者のパスワードは Secrets Manager に置かず、インストール時に人間が決める。**信頼するプロキシ（ALB）は、派生イメージの entrypoint が起動のたびに `config/parameters_local.php` に書く**（`MAUTIC_TRUSTED_PROXIES` から。環境変数だけでは Mautic が読まない。`cloud/images/mautic/comegin-entrypoint.sh`）。インストールの前に効いているので、`site_url` は `https://` で保存される（インストール後に「設定 > システム設定」の Site URL が `https://<MktHost>` であることを確かめる）。インストーラーの DB 接続も派生イメージで TLS にしてある（Dockerfile の 3）。**インストール後に管理画面で行う設定**（開発は `backend/mautic-system/dev/setup` が同じことをする。`setup/README.md` の「Webhook の送り先と SSRF 対策」）: ①設定 > Webhook 設定 の「キューモード」を `command_process`（送るのは mautic-cron の毎分の `mautic:webhooks:process`。派生イメージの cron に入れてある）②同じ画面の「私設アドレスの許可」に **`10.99.0.2` だけ**（範囲では許可しない）③「失敗での自動停止」は無効にしない ④設定 > システム設定 > CORS 設定 に本番の公開サイトのオリジンだけ（「ドメインを制限する」は Yes のまま）。 |
| **Strapi・n8n（オンプレ）** | オンプレで動かす（ADR-21）。起動時に自分で RDS の `strapi`・`n8n` データベースを移行する。WireGuard が張れていて、4.8 のパスワードを渡してから起動する。 |

**移行が失敗したら、サービスのイメージを更新しない**（古いイメージのまま動かし続ける）。

#### n8n の AWS の資格情報（SNS への発行）

オンプレの n8n の AWS ノードには、IAM ユーザー `comegin-<env>-onprem-n8n-sns` のアクセスキーを入れる（4.5 で発行）。n8n のエディターで、AWS の資格情報を作る: 認証は**アクセスキー**、リージョンは `ap-northeast-1`。ワークフローの SNS ノードにこの資格情報を使う。ハートビートの HTTP Request ノード（`PutMetricData`）も同じ資格情報で署名する（次の節）。
前回の Assume Role・Use System Credentials・`N8N_AWS_SYSTEM_CREDENTIALS_ACCESS_ENABLED` は使わない（ロール `sns-publisher` は無い）。引き受けや購読の変更の権限は、このユーザーに無い（2 トピックへの `sns:Publish` と、名前空間 `ComeGin/OnpremN8n` への `PutMetricData` だけ。TA-04 の 1 節）。

#### n8n のスケジュール実行のハートビート（TA-05 の 4 節の項目 3）

n8n 自身は止まったことを知らせられないので、n8n は 5 分ごとに生存信号を **送るだけ** にして、止まったかの判定は CloudWatch のアラーム `comegin-<env>-onprem-n8n-schedule-heartbeat`（`observability.yaml`）が行う（欠損を違反として扱う）。

| n8n の `ops_settings` | 値 | 注意 |
|---|---|---|
| `heartbeatEnabled` | 既定 `false`。`true` にして初めて送る | `false` のあいだは信号が無いので、アラームは ALARM のまま（開発環境の n8n では `false` のまま） |
| `heartbeatNamespace` | `ComeGin/OnpremN8n` | 親スタックの出力 `N8nHeartbeatNamespace` と一致させる。ずれると IAM の条件で `AccessDenied` になり、アラームが欠損で発火する |
| メトリクス名・値 | `ScheduleHeartbeat`・1 | `observability.yaml` のパラメータ `N8nHeartbeatMetricName` と一致させる |
| ディメンション | **付けない** | 付けるとアラームのメトリクスに合わず、欠損のままになる |
| リージョン・送信先 | `ap-northeast-1` の CloudWatch（`PutMetricData`） | |

有効にする順序: ①スタックをデプロイする（アラームは信号が無いので ALARM から始まる）→ ②アクセスキーを発行して n8n の資格情報に入れる（4.5）→ ③`heartbeatEnabled` を `true` にして、ハートビートのワークフローを公開する → ④アラームの状態が `OK` に戻り、復旧の通知が `comegin-ops-alert` に届くことを確かめる。

### 4.11 DesiredCount を上げる順

1 つ上げるたびに、4.13 の確認と、CloudWatch のアラームが鳴っていないことを見る。`samconfig.toml` の `parameter_overrides` に書いてデプロイする。

| 順 | サービス | 条件・注意 |
|---|---|---|
| 1 | `ChatwootWebDesiredCount=1` → `ChatwootWorkerDesiredCount=1` | `db:chatwoot_prepare` のあと。SMTP の Secret を入れてから。**Webhook の送信先（4.2.1）は、オンプレの n8n の受け口が起動してから設定する** |
| 2 | `MauticWebDesiredCount=1` → `MauticCronDesiredCount=1` | イメージと初期設定のあと。**cron は 1 に固定**（2 つ動くとキャンペーンとメールが二重になる） |

**夜間の停止（2026-10-26。ユーザーの決定）**: `chatwoot-web`・`chatwoot-worker`・`mautic-cron` は、毎日 22 時に 0 台にして翌 8 時に DesiredCount に戻す（日本時間。各サービスの `NightlyStopScalableTarget`。Application Auto Scaling のスケジュール）。`mautic-web` は止めない。
- **夜間の影響**: 公開サイトのチャットのウィジェットが出ない（Chatwoot が 503。FAQ ボットも答えない）。Mautic のフォームの申し込みは受け付けるが、n8n（I-11）への Webhook・リードの通知（R3）・キャンペーン・セグメントの更新は 8 時以降にまとめて処理される。Chatwoot の Webhook（I-12）とメールも 8 時以降。
- 止める・戻す時刻は親のパラメータ `NightlyStopSchedule`・`NightlyStartSchedule`（cron 式）・`NightlyStopTimezone`、止めないなら `NightlyStopEnabled=false`。**DesiredCount が 0 のサービスには作らない**（朝に勝手に起動しないため）。
- 台数を変えるのは Application Auto Scaling で、CloudFormation の DesiredCount は昼の台数のまま。**切り替え（`NightlyStopEnabled`・DesiredCount・時刻の変更）は昼に行う**。夜間に行うと、①`NightlyStopEnabled=false` にしたり DesiredCount を 0 にしたりすると、スケジュールが消えてもタスクの数は 0 のまま残り、朝になっても起動しない（CloudFormation は変わっていない DesiredCount を送り直さない見込み）②DesiredCount を変えると、最小と最大がすぐ昼の台数になり、その夜は止まらない。①になったら `aws ecs update-service --cluster <ClusterName> --service comegin-prod-<svc> --desired-count 1` で戻す。夜間にほかの変更だけを `sam deploy` しても、止めたタスクが起きるかは未確認（起きても次の 22 時に止まり直す）。
- 実行中のタスク数のアラームは「希望の数 − 実行中の数」なので、夜間（希望 0）は鳴らない。ALB の 5xx の比率は、夜間にチャットに来た訪問者の 503 を数えるが、5 分で 20 リクエスト以下は見ない。
- Application Auto Scaling は、サービスにリンクされた IAM ロール（`AWSServiceRoleForApplicationAutoScaling_ECSService`）を使う。初回のデプロイで自動で作られる（デプロイの主体に `iam:CreateServiceLinkedRole` が要る）。

**Aurora Serverless v2 の最大 ACU を変えるとき**: `max_connections` は最大 ACU から決まり（2 ACU で 100 前後〈MySQL〉）、**インスタンスを再起動するまで反映されない**（静的なパラメータ）。`MysqlMaxCapacity`・`PostgresMaxCapacity` を変えて `sam deploy` した後、`aws rds reboot-db-instance --db-instance-identifier comegin-prod-mysql-1`（PostgreSQL は `comegin-prod-postgres-1`）を人が実行する（数十秒止まる）。張り付きは `ACUUtilization` のアラーム（`alarms.yaml`）で知る。Mautic（Apache）の同時処理数の既定は 150 で、2 ACU の接続数の上限を超えうる。`/mtc/event` が多いときに接続が足りなくなったら、最大 ACU を上げる。

consent-api と admin-auth は Lambda（ADR-26）で DesiredCount を持たない。`sam deploy` の時点で ALB から呼ばれる（4.18・4.19）。**admin-auth は 4.19 の migrate と登録が済むまで、管理画面に誰も入れない**（Chatwoot・Mautic を起動する前に済ませる）。
`mautic-web` と `mautic-cron` の DesiredCount は 0 か 1 しか受け付けない（テンプレートが拒否する）。
WireGuard の EC2 は DesiredCount の対象ではない（常時 1 台。4.2.1）。オンプレの Strapi・n8n の起動は、ここの対象外（`onprem/` の README）。

### 4.12 イメージの更新

1. 新しいイメージを ECR に置く（4.7）。
2. **DB のスキーマが変わる製品（Chatwoot・Mautic）**（Mautic は RunTask ではなく、mautic-web の起動時に entrypoint が移行する〈4.10〉。移行が長いとヘルスチェックの猶予〈180 秒〉を超えて途中で入れ替えられるので、版を上げるときは、その間だけ親のパラメータ `MauticWebHealthCheckGracePeriodSeconds`〈例 1800〉をデプロイの設定ファイルに書いて延ばし、移行が終わったら戻す。ECS Exec で `php bin/console doctrine:migrations:migrate` を先に済ませてもよい）: 先にそのサービスを `DesiredCount=0` にして、新しいタグでデプロイする（タスク定義の新しいリビジョンができる）。マイグレーションの RunTask（4.10）が成功したら、`DesiredCount=1` に戻してデプロイする。止まっている間は、その製品の機能が止まる。
3. **スキーマが変わらない更新**: タグを変えてデプロイするだけ（ローリング更新。サーキットブレーカーが、新しいタスクの起動が失敗し続けたときに直前に戻す）。
4. Strapi と n8n の更新は、オンプレで行う（ADR-21。`onprem/` の README）。このスタックの対象外。
5. **4.13 の確認をデプロイごとに行う。** 製品を更新すると訪問者向けのパスが変わりうる。許可リスト方式なので、変わると機能が止まる側に倒れる（管理画面が開く側には倒れない）。
6. **admin-auth（Lambda）**: `sam build` → `sam deploy` のあと、スキーマが変わる版なら運用の Lambda で `{"action":"migrate"}` を呼ぶ（4.19）。

### 4.13 デプロイ後の確認

```bash
# 訪問者向け: 認証なしで 200（パスは edge.yaml の許可リスト）
curl -s -o /dev/null -w '%{http_code}\n' https://<ChatHost>/widget                      # 200 か製品の応答（Chatwoot のウィジェット）
# ウィジェットの JS（/vite/assets/*。edge.yaml のルール 103）。302 なら認証の内側に落ちていて、ウィジェットが空になる
curl -s "https://<ChatHost>/widget?website_token=<website_token>" | grep -o '/vite/assets/widget-[^"]*\.js' | head -1 \
  | xargs -I{} curl -s -o /dev/null -w '%{http_code}\n' "https://<ChatHost>{}"           # 200

# Chatwoot の API はヘッダー api-access-token（ハイフン）で通る。api_access_token（アンダースコア）は ALB が捨てて 401 になる
curl -s -o /dev/null -w '%{http_code}\n' -H 'api-access-token: <トークン>' https://<ChatHost>/api/v1/profile   # 200
curl -s -o /dev/null -w '%{http_code}\n' https://<ConsentHost>/v1/consent               # 200（同意の状態の取得）

# 機械向けの API: トークン無しでは製品側が拒否する（401）
curl -s -o /dev/null -w '%{http_code}\n' https://<ChatHost>/api/v1/accounts/1/conversations
curl -s -o /dev/null -w '%{http_code}\n' https://<MktHost>/api/contacts

# 管理画面: 302 で auth. に飛ぶ（200 が返ったら認証が外れている。最優先で直す）
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<ChatHost>/app/
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<MktHost>/s/login

# 許可リストの外は閉じている
curl -s -o /dev/null -w '%{http_code}\n' https://<ConsentHost>/healthz                  # 404（/healthz は外に出さない）
curl -s -o /dev/null -w '%{http_code}\n' https://<ConsentHost>/                         # 404

# cms.・n8n.（ADR-21）と stats.（ADR-25）はもう無い。DNS にレコードが無いこと（名前が引けない）を確かめる
dig +short cms.comegin.com
dig +short n8n.comegin.com
dig +short stats.comegin.com
```

**Strapi のメディア（オンプレの Strapi から）**: 管理画面で画像を 1 枚アップロードし、署名付き URL（有効 1 時間）で取得できること。S3 のバケットが非公開のままであること（バケットのパブリックアクセスのブロックが全部オンであること）。アップロードは IAM ユーザー `onprem-strapi-media` のキーで行われる（CloudTrail で確かめられる）。

**WireGuard**: 4.2.1 の確認（`latest handshake`、RDS への接続、Webhook の疎通）。Mautic・Chatwoot の管理画面から Webhook を試し送信して、オンプレの n8n に届くこと。EC2 の `sudo nft list ruleset` で forward の許可が、戻りの通信（`ct state established,related accept`）と新しい接続の 2 行の、計 3 行だけであること。

**ハートビートのアラーム**（ともに ops トピックへ。ALARM と OK の両方で通知。5 分 × 3 期間・欠損は違反。`HeartbeatAlarmActionsEnabled` を共有）:

| アラーム | 名前空間・メトリクス | 送り手 | 見るもの |
|---|---|---|---|
| `comegin-<env>-onprem-heartbeat` | `ComeGin/Onprem`・`Heartbeat` | 監視アプリ（`ControlPlanePolicy` のキー） | 監視アプリ（改善ループ）の停止、オンプレの全滅 |
| `comegin-<env>-onprem-n8n-schedule-heartbeat` | `ComeGin/OnpremN8n`・`ScheduleHeartbeat` | オンプレの n8n（`onprem-n8n-sns` のキー。4.10） | n8n のスケジュール実行の停止（問い合わせの棚卸しなど） |

ブラウザで: 管理画面（`chat.`・`mkt.`）の URL を開くと Google のログインに転送され、許可リストに載っているアカウントだけが入れること、ALB のセッションが 12 時間であること。
`/oauth2/idpresponse` の登録が足りないと、ログインのあとで ALB がエラーを返す（`ALB_PROTECTED_HOSTS` とリスナールールのホストを一致させる）。

### 4.14 Astro の配信

ビルドはオンプレで行い、配信（同期と無効化）は人間が承認して実行する（ADR-15。`DeployPolicyArn` を付けた主体で）。**同期 → 無効化の順を入れ替えない**（逆にすると更新が一巡遅れる）。

```bash
BUCKET=$(OUT AstroBucketName); DIST=$(OUT DistributionId)
# ハッシュ付きの資産は長期キャッシュ（immutable）
aws s3 sync frontend/verdant-virgo/dist/ s3://$BUCKET --exclude '*' --include '_astro/*' --cache-control 'public,max-age=31536000,immutable'
# それ以外（HTML など）は都度検証。--delete で古いページを消す（孤児ページが公開され続けないように）
aws s3 sync frontend/verdant-virgo/dist/ s3://$BUCKET --exclude '_astro/*' --delete --cache-control 'public,max-age=0,must-revalidate'
aws cloudfront create-invalidation --distribution-id "$DIST" --paths '/*'
```

- **`SITE_URL` 未設定のビルドは意図的に停止する**（canonical と sitemap に localhost が焼き込まれるのを防ぐため）。
- **GA4（ADR-25）の測定 ID は、本番のビルドの環境変数 `PUBLIC_GA4_MEASUREMENT_ID`（`G-` で始まる。秘密値ではない）で渡す。** 未設定ならタグを出さない。開発のビルドには設定しない。ビルドはオンプレなので、このスタックには測定 ID のパラメータを持たない（以前の Umami の環境変数もこのスタックには無かった）。
- **CSP はこのスタックで付けていない**（`Managed-SecurityHeadersPolicy` は CSP を含まない。`cdn.yaml` の注記）。付けるなら GA4 のホストを Google の CSP ガイド（https://developers.google.com/tag-platform/security/guides/csp）に合わせる。5 節。
- CloudFront のキャッシュポリシーはマネージド（Free プランで使える既定のルール）で、オリジンの `Cache-Control` を尊重する。上の同期の `--cache-control` が、長さを決める。
- ディレクトリ形式（`/about/` → `about/index.html`）は CloudFront Function が補う。404 ページ（`/404.html`）は `frontend/verdant-virgo` にまだ無い（5 節）。

### 4.15 開発機を意図的に止めるとき（休日など）

止める前にオンプレのハートビートのアラーム 2 つ（監視アプリと n8n のスケジュール実行。n8n もオンプレなので一緒に止まる）のアクションを無効にし、再開予定の時刻に有効に戻す 1 回限りのスケジュールを**先に**作る（有効に戻し忘れると、オンプレの全滅が知らされない状態が続く）。無効にするのはこの 2 つのハートビートのアラームだけで、本番のアラームは止めない。手順は TA-05 の 4 節の表。

```bash
aws cloudwatch disable-alarm-actions --alarm-names comegin-prod-onprem-heartbeat comegin-prod-onprem-n8n-schedule-heartbeat
# 再開予定の時刻に enable-alarm-actions を呼ぶ 1 回限りのスケジュールを EventBridge Scheduler で作る（TA-05 の手順 2）
```

### 4.16 WAF の Common ルールを Block にする

`WafCommonRuleSetAction` の既定は **Count**（Mautic・Chatwoot の管理画面は HTML を本文に含めて保存するため、XSS 系のルールで誤検知しやすい）。
**Count から Block への切り替えを判断するのは `R1`。** 次の確認をしてから行う（CloudWatch Logs Insights。対象のロググループは `aws-waf-logs-comegin-<env>`。ログに残るのは Block と Count だけで、Cookie と Authorization は伏せてある）:

```
# どのルールで Block と Count が起きているか（件数）
fields action, terminatingRuleId
| stats count(*) as n by action, terminatingRuleId
| sort n desc

# Common ルールが Count した本物のリクエスト（管理画面の保存・アップロードが入っていないか）
fields @timestamp, httpRequest.clientIp, httpRequest.uri, httpRequest.args, ruleGroupList.0.ruleGroupId
| filter @message like /AWSManagedRulesCommonRuleSet/ and @message like /COUNT/
| sort @timestamp desc
| limit 100

# Block されたリクエスト（レート制限の誤爆がないか）
fields @timestamp, httpRequest.clientIp, httpRequest.uri, terminatingRuleId
| filter action = "BLOCK"
| stats count(*) as n by terminatingRuleId, httpRequest.uri
| sort n desc
```

フィールド名は WAF のログの形式（公式: AWS WAF log examples）に基づく。**未検証**（実機のログで確かめる）。
管理画面の保存・アップロード（Mautic のメールの本文、Chatwoot の添付）が Count に入っていなければ、Block にしてよい。入っていれば、そのルールだけを Count の上書き（`RuleActionOverrides`）に足してから Block にする。

ALB 用の WAF のレート制限のしきい値は暫定値（5 分あたり・送信元 IP あたり。consent 100〈2026-10-26 に 30 から上げた。CGNAT で正規の同意の記録が欠けないよう。1 回の同意は 2 リクエスト〉、フォーム 100、API 1000、`auth.` 300、その他 2000）。同じログで実測して決める。

### 4.17 faq-bot（Chatwoot の FAQ ボット。ADR-26）

Lambda（VPC の外。関数 URL）。仕様は `docs/superpowers/specs/2026-10-11-faq-bot-design.md`。**`sam build` は `backend/faq-bot/Makefile` を使い、pnpm と esbuild でまとめる**（開発機に pnpm 11 が要る。npm は使わない）。

1. 本番の Chatwoot（管理画面の「設定 → ラベル」）でラベル `faq-answered`・`faq-unmatched`・`faq-handoff` を作る。
2. 「設定 → ボット」でエージェントボット「FAQ ボット」を作る（Webhook の URL は後で入れるので、仮に `https://example.invalid/webhook`）。作成後の画面か `GET /api/v1/accounts/<id>/agent_bots/<bot_id>`（管理者のトークン）で access_token と secret を控える。
3. Secrets Manager に入れる（4.6 と同じく、シェルの履歴に残らない方法で）:

   ```bash
   read -rs SECRET_VALUE   # access_token を貼る（画面に出ない）
   aws secretsmanager put-secret-value --region ap-northeast-1 --secret-id comegin/prod/faq-bot/CHATWOOT_BOT_TOKEN --secret-string "$SECRET_VALUE"
   read -rs SECRET_VALUE   # secret を貼る
   aws secretsmanager put-secret-value --region ap-northeast-1 --secret-id comegin/prod/faq-bot/CHATWOOT_BOT_SECRET --secret-string "$SECRET_VALUE"
   unset SECRET_VALUE
   ```

4. 公開サイトを `faq.json` 入りでビルドして配信する（`https://<SiteHost>/faq.json` が JSON を返すこと）。
5. `sam build` → `sam deploy`。出力の `FaqBotFunctionUrl` の末尾に `webhook` を付けた URL を、2 のボットの Webhook の URL に入れる。
6. 「設定 → 受信箱 → Web サイト → ボットの設定」で「FAQ ボット」を選ぶ（**これで新しい会話は pending で始まり、ボットが先に答える**。外すと元に戻る）。
7. 受信箱「Web サイト」の設定を合わせる（2026-10-12 に追加。開発は `backend/chatwoot-system/setup/index.mjs` が同じことをする）:
   - **解決した会話への書き込みを許さない**（受信箱の設定の「解決後のメッセージを許可」を切る。API では `allow_messages_after_resolved: false`）。解決後はウィジェットに「新しいチャットを開始する」が出て、新しい会話になる（既定のままだと、解決した会話が開き直される）。
   - **担当者（人）を受信箱のメンバーにする**（「設定 → 受信箱 → Web サイト → 共同作業者」）。ボットから担当者への引き継ぎ（`faq-handoff`・`faq-unmatched`。`pending` → `open`）の通知は、受信箱のメンバーにだけ作られる（管理者でもメンバーでなければ届かない）。
   - **各担当者が、プロフィールの通知設定で「新しい会話が作成されたとき」のメールを有効にする**（引き継ぎで作られる通知の種類が「新しい会話」〈`conversation_creation`〉のため。本人のトークンでしか変えられない）。受信箱の自動割り当てが有効なら、続けて「割り当てられたとき」の通知も来る（両方有効だと引き継ぎごとにメールが 2 通）。メールは Chatwoot の SMTP（本番は SES。4.9）から送られる。
   - **ラベル `faq-ask-resolved` と、マクロ「解決の確認を送る」を作る**（「設定 → ラベル」と「設定 → マクロ」。マクロは全員で共有し、動作は「ラベルを追加: `faq-ask-resolved`」だけ）。担当者が返信の後にこのマクロを押すと、ボットが訪問者に［解決しました］ボタンを送る。ボタンが出ずにラベルが残っていたら、ラベルを外してから押し直す（`docs/superpowers/specs/2026-10-12-faq-bot-ask-resolved-design.md`）。
8. 確かめる: ウィジェットで「料金は税込ですか？」と送り、回答・ラベル `faq-answered` を見る。「営業時間は？」で担当者に回る（`open`・`faq-unmatched`）と、担当者にメールが届く。CloudWatch の `comegin-prod-faq-bot-errors` が OK のまま。

- **faq-bot が失敗すると（Lambda の例外は関数 URL で 502）、Chatwoot は送り直さずに会話を `open` にする。** 訪問者は担当者に回り、アラームが `ops` に届く。
- しきい値（`FaqMatchHigh`・`FaqMatchLow`・`FaqMatchMargin`）は仕様 11 節の評価で決めた値が既定。変えるときは `backend/faq-bot/tests/matcher-eval.test.ts` で評価し直してから、パラメータで渡す。

### 4.18 consent-api（Cookie 同意の受け口。ADR-26）

VPC の中の Lambda（ALB のターゲット）。仕様は `docs/superpowers/specs/2026-10-12-consent-api-lambda-design.md`。**`sam build` は `backend/consent-api/Makefile` を使い、pnpm と esbuild でまとめる。** ターゲットグループ（`comegin-<env>-consent-api`）は `services/consent-api.yaml` が持ち、edge のルール 106 に渡す。

1. `sam build` → `sam deploy`（Secrets の `shared/VALKEY_AUTH_TOKEN` は secrets.yaml が作る。人が入れる値は無い）。
2. 確かめる: 公開サイトのバナーで同意し、`comegin_consent` の Cookie が書かれること。`curl -s https://<ConsentHost>/v1/consent` が `{"state":"unset"}` を返すこと（4.13）。
3. CloudWatch のアラーム `consent-api-errors`・`consent-api-throttles`・`consent-api-target-5xx` が鳴っていないこと。ロググループ `/aws/lambda/comegin-<env>-consent-api` に 1 件 1 行のログが出て、識別子と IP が無いこと。

- **初回の呼び出し（コールドスタート）は、Secrets Manager と Valkey への接続のぶん遅い。** 訪問者はバナーの応答を待たない（DD-02 の 8.3）。
- 予約同時実行数（`ConsentApiReservedConcurrency`。既定 10）とタイムアウト（10 秒）は暫定値。`Throttles` のアラームが鳴ったら上げる。
- **ターゲットグループの名前は固定**（`comegin-<env>-consent-api`。ALB からの呼び出しの許可を名前で絞るため）。置き換えの要る変更（`TargetType` など）は、名前の衝突で CloudFormation の更新が失敗する。そのときは `services/consent-api.yaml` の名前を変えてデプロイする（許可の `SourceArn` も同じ名前から作られる）。

### 4.19 admin-auth（管理画面の関門。ADR-26）

VPC の中の Lambda 2 つ。本体（`comegin-<env>-admin-auth`。ALB のターゲット）と運用（`comegin-<env>-admin-auth-ops`。ALB にはつながない）。仕様は `docs/superpowers/specs/2026-10-12-admin-auth-lambda-design.md`。**`sam build` は `backend/admin-auth/Makefile` の 2 つのターゲットを使う。** ターゲットグループ（`comegin-<env>-admin-auth`。マルチバリューヘッダー有効）は `services/admin-auth.yaml` が持ち、edge のルール 300 に渡す。

1. `sam build` → `sam deploy`。Secrets の `admin-auth/GOOGLE_CLIENT_SECRET`（4.6）と、親のパラメータ `GoogleClientId`・`AdminBootstrapEmails`（管理者の許可リストの初期値。カンマ区切り。空のまま migrate すると誰もログインできない）を `samconfig.toml` に入れておく。
2. DB とアプリ用ユーザーを作る（4.8 の共有のタスク）。
3. 移行（許可リストの初期値もここで入る）と、ALB の登録:

   ```bash
   OPS=$(OUT AdminAuthOpsFunctionName)
   aws lambda invoke --region ap-northeast-1 --function-name "$OPS" --cli-binary-format raw-in-base64-out --payload '{"action":"migrate"}' /dev/stdout
   aws lambda invoke --region ap-northeast-1 --function-name "$OPS" --cli-binary-format raw-in-base64-out --payload '{"action":"register-alb-client"}' /dev/stdout
   # ALB がトークンの要求で invalid_client になるときは '{"action":"register-alb-client","authMethod":"client_secret_post"}'
   ```

   結果の JSON が `{"ok":true,…}` であること。`{"ok":false,…}` は入力の誤り、`FunctionError` は実行の失敗（ロググループ `/aws/lambda/comegin-<env>-admin-auth-ops`）。
4. 確かめる: 管理画面（`chat.`・`mkt.`）を開き、`auth.` に飛んで Google でログインし、戻ってこられること。**ALB の認証のメトリクス（`AWS/ApplicationELB` の `ELBAuthError`・`ELBAuthFailure` が 0 であること）と、IdP の呼び出しの所要時間（`ELBAuthLatency`）**を見る（ALB のアクセスログは未設定〈5 章〉。原因を詳しく見るときは一時的に有効にして `error_reason` を見る）。アラーム `admin-auth-errors`・`admin-auth-throttles`・`admin-auth-target-5xx` が鳴っていないこと。

- **ALB の IdP の呼び出し（トークン・UserInfo）が待つ時間は公式文書で確かめられていない。** 呼び出しの数秒前にブラウザが同じ関数を呼ぶため、起動済みである見込み（仕様の D1）。遅い・失敗するときは `AdminAuthProvisionedConcurrency=1` にしてデプロイする（常時 1 つ起動。月 4〜5 USD 前後）。
- 予約同時実行数（`AdminAuthReservedConcurrency`。既定 5）・タイムアウト（10 秒）・アイドルの判定（60 秒）は暫定値。
- ターゲットグループの名前は固定（4.18 と同じ注意。置き換えの要る変更は名前を変えてデプロイする）。

## 5. TODO 一覧

設計書の「未決定事項」のうち、インフラで決まるもの、実機で確かめるもの、他のメンバーの作業待ちのもの。`(未検証)` は一度も実機で動かしていないという意味。

| 領域 | TODO | どこに書いたか |
|---|---|---|
| **訪問者向けパス** | TA-06 の 5.3 の想定値で入れてある。各製品のバージョンで DevTools により実測して確定する（Chatwoot は `/packs/*` 以外のアセットのパスがあるか、Mautic は `/form/generate.js` などの埋め込み用のパス）。ヘルスチェックのパスも実測 | `edge.yaml` |
| **SES** | 本番アクセスの申請、apex の SPF と DMARC を Google Workspace と統合、バウンスと苦情を Mautic に返す経路 | 4.9、`ses.yaml` |
| **E-15 の写し** | 頻度と形式、保持期間とライフサイクル（決まるまで設定しない）、Object Lock（保持期間が決まってから）。`If-None-Match` を必須にするバケットポリシーの Deny は実機未検証（書き込みは単発の `PutObject` で、マルチパートを使わないこと） | `runlog-archive.yaml` |
| **SNS の購読** | `AuthenticateOnUnsubscribe` を付けた確認（4.4）。購読状態（`Confirmed` の数）の監視は未作成（SNS 以外の手段が要る。TA-05 の項目 8） | 4.4 |
| **外形監視** | 訪問者向けパスが認証なしで 200 を返すこと、管理画面が 302 を返すこと（200 は認証が外れた異常）、`cms.`・`n8n.`・`stats.` の名前が引けないことの定期確認は未作成（TA-05 の項目 6・7。CloudWatch Synthetics か Route 53 のヘルスチェックの案）。4.13 を手で行う | — |
| **WireGuard（ADR-21）** | ①**実機で一度も動かしていない**。AL2023 のカーネルに `wireguard` のモジュールがあるか、`wireguard-tools` が core のリポジトリにあるか（無ければ user-data が失敗し、`/var/log/wireguard-setup.log` に残る）。②nftables のルール（forward の既定 drop、両方向の masquerade）と、WireGuard の応答が SG の egress の許可なしで通るか（SG はステートフルなので通る想定。オンプレの `PersistentKeepalive` が通信を保つ）。③`ec2:recover`（`WireguardSystemRecoverAlarm`）が t4g で使えるか。④**トンネルそのもの（`latest handshake` の途絶）の監視は未作成**（EC2 の中から `PutMetricData` する案。IAM と名前空間を足す必要がある）。EC2 の死活（ステータスチェック）だけを見ている。⑤Webhook の再送の有無（Mautic・Chatwoot がオンプレの停止中に取りこぼした分を後から送るか）は、DD-07 の縮退運転で確かめる。⑥OS の更新は手動（4.2.1）。自動更新は入れていない。⑦AMI の変更で EC2 を置き換えると、ENI が「使用中」で失敗する見込み（未検証。4.2.1）。⑧`WireguardIngressCidr` は `0.0.0.0/0`（オンプレの IP が固定でないため）。固定の IP が使えるなら絞る | `wireguard.yaml`、`network.yaml`、4.2.1 |
| **n8n のハートビート** | 実機で確かめる: ①n8n の HTTP Request ノードが、AWS の資格情報（アクセスキー）で `PutMetricData`（CloudWatch の Query API）に署名でき、`ComeGin/OnpremN8n` で通ること（名前空間の綴りの違いは `AccessDenied`）。②n8n を 15 分止めるとアラームが ALARM になり、再開で OK に戻り、どちらも ops に通知が届くこと。③5 分の送信間隔と 5 分の期間の境目で、1 期間のデータが 0 になる揺れがあっても、3 期間連続でなければ発火しないこと。④`heartbeatEnabled` が `false` の環境（開発）では、ALARM のままになること（意図どおり） | `observability.yaml`、`iam.yaml`、4.10 |
| **オンプレの IAM ユーザー** | アクセスキーの発行（4.5）。S3 の署名付き URL（Strapi の S3 プロバイダー）が、IAM ユーザーのキーで動くこと。ローテーションの運用（キーは 1 ユーザー 2 つまで）。Strapi のアップロードの ACL（`BucketOwnerEnforced` のバケットなので、ACL を付けない設定が要る。`strapi-system` 側） | `iam.yaml`、4.5 |
| **Mautic** | ①`MAUTIC_SITE_URL` の設定名と形式（公式の「local.php の設定は `MAUTIC_<大文字の名前>`」に基づく想定）。`trusted_proxies` は 2026-10-26 に、環境変数では効かない（`TrustMiddleware` は local.php と parameters_local.php だけを読む）と分かり、派生イメージの entrypoint で parameters_local.php に書く形にした（実機では未確認。インストール後の Site URL が `https://` であることで確かめる）。②メールの設定名（SMTP は管理画面で設定する）。③非同期のキューを使うなら `mautic_worker` のサービスを足す。④`mautic-web` を 2 タスク以上にするには、セッションの保存先（Valkey か RDS）を決める。⑤派生イメージの `config.php` のパッチは、上流の版を上げるとパターンが合わなくなりうる（そのときはビルドが失敗する。黙って検証なしにはならない）。⑥Mautic 本体の起動と、`/installer` でのインストール | `services/mautic-*.yaml`、`images/mautic/Dockerfile` |
| **Chatwoot** | `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true` で、管理画面から Webhook を試し送信して `10.99.0.2:5680` に届くこと（SG の出口を絞ったので、届かないときは SG の出口と WireGuard の SG を見る）。S3 をタスクロールで使えるか（`AWS_ACCESS_KEY_ID` を空のまま SDK の既定の探索に倒れるか。倒れなければ専用の IAM ユーザーのキーを Secret に）。有効にする拡張を採用バージョンの `db/schema.rb` で確かめる。Rails 本体で `PGSSLMODE=verify-full` が効くか | `services/chatwoot-*.yaml`、`ops-tasks.yaml` |
| **RDS への TLS** | すべてのサービスが検証つきで接続する形にした（4.7 の表）。**実機の RDS で、各製品が検証つきで繋がること**（とくにオンプレの Strapi と n8n・Chatwoot の Rails・Mautic 本体）。繋がらない製品があっても、`PostgresForceSsl` を 0 にしたり検証を外したりする前に、製品側の設定を探す | `data.yaml`、4.7 |
| **エンジンのバージョン** | Aurora は `8.4.mysql_aurora.8.4.8` と `16.15`（2026-10-26 時点の東京の最新。マイナーは自動で上がる）。Valkey は `8.0`（CloudFormation と ElastiCache が受け付けるかを実機で確かめる。無ければ 7.2。開発は `valkey/valkey:8-alpine`）。Chatwoot の Sidekiq に問題が出たら、同じノードタイプのまま Redis OSS 7.1 に切り替える | `data.yaml` |
| **admin-auth** | PKCE は今は必須にしていない（ALB が送るか確認できないため。Wave 4 で確かめる）。**許可リストから外しても、ALB のセッション Cookie は最大 12 時間有効**（`OidcSessionTimeoutSeconds` を短くするかの検討を含む）。ALB のクライアント認証は既定の `client_secret_basic`（ALB が post を使う場合は、運用の Lambda に `{"action":"register-alb-client","authMethod":"client_secret_post"}` を送って登録し直す。4.19）。ALB と Better Auth の組み合わせの実地確認 | `edge.yaml`、`services/admin-auth.yaml` |
| **フラットレートプラン** | 購読の実機での確認（Free Tier のアカウントは不可）。apex か `www` か（プランは 1 apex まで）。allowance を超えた後の挙動。標準アクセスログは Pro 以上（Free は無し）。`/404.html` を `frontend/verdant-virgo` に作る | `global/template.yaml`、`cdn.yaml` |
| **WAF** | Common ルールの Count から Block への切り替え（判断は R1。4.16）、しきい値の実測、WAF のログの配信権限（デプロイ主体に `logs:CreateLogDelivery` と `logs:PutResourcePolicy` などが要る見込み）。ALB のアクセスログは未設定 | `edge.yaml`、4.16 |
| **ネットワーク** | タスクのセキュリティグループの外向きは tcp の全ポートを `0.0.0.0/0` に開けている（ECR・Secrets Manager・SES が呼ぶ外部 API）。**Chatwoot の 2 つだけは 2026-10-26 に宛先で絞った**（443・587・RDS・Valkey・`10.99.0.2:5680`。`SAFE_FETCH_ALLOW_PRIVATE_NETWORK` で製品側の SSRF 対策が外れるため）。ほかのタスクは未着手 | `network.yaml` |
| **データの保全** | EFS の復元手順の確認（日次の自動バックアップ）。Aurora の Enhanced Monitoring・Performance Insights は付けていない。Aurora はクラスターなので、止まった時間の実績を見て、読み取りの複製（フェイルオーバーの先）をクラスターに足すだけで冗長化できる（TA-06 の 4.6） | `data.yaml` |
| **見積もり** | 費用の見積もり（TA-06 の 9 節）。アラームの数、Container Insights、WAF のログ、WireGuard の EC2 と Elastic IP、インターネットへのデータ転送（RDS の応答・Webhook）を含める。3 節の増減の概算は未確認の単価に基づく | 3 節 |
| **CSP（ADR-25）** | 公開サイトの `Content-Security-Policy` をどこで付けるか（CloudFront のカスタムの応答ヘッダーポリシーか、Astro 側か）。CloudFront で付けるなら、フラットレートプランの Free で独自の応答ヘッダーポリシーが使えるかを確かめる。GA4 の許可は Google の CSP ガイドの表に合わせる | `cdn.yaml` |
| **未着手の設計** | 収益化（`points-api`・3106・`E-19` の S3 Object Lock）。オンプレの **Strapi** のハートビートのアラーム（監視アプリと n8n のスケジュール実行のハートビートはある）。`consent-api` の TTL とバックアップ（TA-06 の 11 節） | — |

## 6. 設計書との差分と判断メモ

- **Secret が 20 個**（`secrets.yaml`。自動生成 13・人が入れる 7。ほかに RDS が管理するマスターの 2 個）。ADR-21 で Strapi と n8n の鍵類を外した（`DB_PASSWORD` の 2 個だけ残す）。ADR-24 で Cal.com の 4 個を、ADR-25 で Umami の 2 個（と `services/umami.yaml` が作っていた `DATABASE_URL` の 1 個）を外した。
- **ECR は 2 本**: Mautic と Chatwoot。**DB に接続する上流のイメージは、薄い派生イメージ**（RDS の CA を足したもの。4.7）にして置く。TA-06 の 3.2「イメージは ECR に置く」に従う。Strapi・n8n・n8n-runners は、オンプレで動かすので置かない（ADR-21）。自作のサービス（consent-api・admin-auth）は ADR-26 で Lambda になり、ECR を外した（2026-10-12）。
- **`cdn.yaml`・`ses.yaml`・`ops-tasks.yaml`・`alarms.yaml`**: 固定シートの一覧にないが必要なので足した（OAC 専用の Astro バケットとデプロイ用 IAM の対象、SES のドメイン ID、DB 作成のタスク、アラーム）。
- **イメージのタグは製品ごと**（2 個）: mautic-web と mautic-cron、chatwoot-web と chatwoot-worker のずれを防ぐ。タグは `<上流のタグ>-<ビルドの連番>`。
- **RDS のマスターの資格情報**: TA-06 の 7 節は「タスクには渡さない」とするが、アプリ用ユーザーを作る 1 回だけのタスクには要る。`ops-tasks.yaml` の専用の実行ロールだけが読める。
- **DB の TLS は、検証をしない形を作らない**: 暗号化だけにして逃がすことはしない。Prisma の Rust のエンジンが `sslmode` だけでは検証しない点は、実験で確かめて `sslaccept=strict` を付けた（4.7）。Mautic は上流が CA を渡す設定項目を持たないため、ビルド時にパッチを当て、当たったことを確かめられなければビルドを失敗させる。
- **Mautic の config は EFS で覆う（既定で有効）**: 公式イメージの `config/` には `.gitkeep` しか無く、覆っても既定のファイルは隠れない。`local.php` は entrypoint が無ければ作る。init コンテナは不要（イメージの中身を確かめた上での判断。4.10）。
- **n8n のハートビート**（TA-05 の 4 節の項目 3）: 監視アプリの名前空間（`ComeGin/Onprem`）とは別の `ComeGin/OnpremN8n` にした（n8n がオンプレの生存を偽れないように。TA-04 の 1 節）。期間（5 分）・期間数（3）・通知のスイッチ（`HeartbeatAlarmActionsEnabled`）は既存のハートビートと共有した（n8n も 5 分ごとに送るため）。そのため、開発機を止めるときは 2 つのアラームを一緒に無効にする（4.15）。送信の権限は、新しい IAM ユーザーを作らず、既存の `onprem-n8n-sns` の管理ポリシーに `PutMetricData`（`Resource: '*'`、条件 `cloudwatch:namespace`）の文を足した（ユーザーとポリシーの名前を変えないので、作り直しにならない）。`Resource: '*'` は、このアクションがリソースレベルの権限に対応しないための意図した例外。**ポリシーの `Description` を直した**が、`Description` は更新で置き換えになり、名前が固定のため**デプロイ後に変えると更新が失敗する**（未デプロイのうちに直した）。
- **n8n の SNS**: オンプレの n8n は、IAM ユーザー `onprem-n8n-sns` のアクセスキーで 2 トピックに発行する（前回のロール `sns-publisher` と、Assume Role・Use System Credentials は廃止。ADR-21）。キーは CloudFormation で作らず、人が発行する（4.5）。
- **Cal.com のセルフホストを外した**（ADR-24。ユーザーの決定による例外。TA-01 の 8 節の SaaS の基準は変えない）: Cal.com は SaaS（cal.com の無料プラン）にして、公開サイトに埋め込む。**デプロイ前に外した**（まだ一度もデプロイしていないので、Retain のリソースや Secret は AWS に残っていない）。**ADR-24 で SaaS に。cal.com への外向きの通信は訪問者のブラウザからだけで、AWS からは無い**（クラウド側から cal.com を呼ばない）。外したもの: `services/calcom.yaml`・`images/calcom/`、ECR の `calcom` リポジトリ、Secret 4 個（`calcom/DB_PASSWORD`・`NEXTAUTH_SECRET`・`CALENDSO_ENCRYPTION_KEY`・`GOOGLE_API_CREDENTIALS`）、RDS の `calcom` データベース（ops-tasks の作成も）、ALB の `cal.` のルール（OIDC）とターゲットグループ、ACM の SAN、Route 53 の `cal.`、WAF の `rate-limit-booking`（パラメータ `WafRateLimitBooking`）、SG（`CalcomSecurityGroup` と ALB・RDS からの許可）、ロググループ、アラーム 2 つ（実行中のタスク数・unhealthy）、`ALB_PROTECTED_HOSTS` の `cal.`、親の `CalcomService` とパラメータ（`CalHost`・`CalcomPort`・`CalcomImageTag`・`CalcomDesiredCount`・`CalcomCpu`・`CalcomMemory`）。ホスト名 `cal.comegin.com` は使わない（DNS にレコードを作らない）。デプロイ用の設定ファイルのパラメータの上書きに `Calcom*`・`CalHost`・`WafRateLimitBooking` を書いていたら、デプロイ前に消す（未知のパラメータは更新を失敗させる）。
- **Umami を外した**（ADR-25。ユーザーの決定による例外。TA-01 の 8 節の SaaS の基準は変えない）: アクセス解析の正本を GA4（SaaS）にした。**デプロイ前に外した**（まだ一度もデプロイしていないので、Retain の ECR と Secret は AWS に残っていない。前の版をデプロイ済みの環境では、`comegin/<env>/umami` の ECR と `comegin/<env>/umami/*` の Secret を手で消す。RDS の `umami` データベースも手で消す）。外したもの: `services/umami.yaml`（タスク定義・サービス・実行ロールとタスクロール・`umami/DATABASE_URL` の Secret）・`images/umami/`、ECR の `umami` リポジトリ、Secret 2 個（`umami/DB_PASSWORD`・`APP_SECRET`）、RDS の `umami` データベース（ops-tasks の作成も）、ALB の `stats.` のルール 3 つ（訪問者向け `/script.js`・`/api/send`、機械向け `/mcp`、OIDC）とターゲットグループ、ACM の SAN、Route 53 の `stats.`、WAF の `rate-limit-api` の `/mcp` の条件（`/mcp` を受けるサービスが無くなった）、SG（`UmamiSecurityGroup` と ALB・RDS からの許可。ALB の egress も）、ロググループ、アラーム 2 つ（実行中のタスク数・unhealthy）、`ALB_PROTECTED_HOSTS` の `stats.`、親の `UmamiService` とパラメータ（`StatsHost`・`UmamiPort`・`UmamiImageTag`・`UmamiDesiredCount`・`UmamiCpu`・`UmamiMemory`）。デプロイ用の設定ファイルのパラメータの上書きにこれらを書いていたら、デプロイ前に消す（未知のパラメータは更新を失敗させる）。**ACM の証明書は SAN が減るので置き換わる**（新しい証明書を DNS 検証してから差し替える）。**PostgreSQL の SG の `GroupDescription` を直したので、この SG も置き換わる**（未デプロイのうちに直した。デプロイ後に変えると RDS の SG の付け替えになる）。
- **Strapi・n8n を外した**（ADR-21）: `services/strapi.yaml`・`services/n8n.yaml`・`images/n8n/`、ALB の `cms.`・`n8n.` のルールとターゲットグループ、ACM の名前、Route 53 のレコード、WAF の `cms.` の API の分、ECR の 3 本、Strapi と n8n の鍵類の Secret（9 個）、アラーム 4 つ、ログのグループを外した。**ECR のリポジトリと Secret は `DeletionPolicy: Retain` なので、テンプレートから外しても AWS に残る**（ロググループは消える）。 まだ一度もデプロイしていないので実害は無いが、前の版をデプロイ済みの環境では、不要な ECR のリポジトリと Secret を手で消す。RDS の `strapi`・`n8n` データベースと、S3 の Strapi のメディアのバケットは、データの置き場として残した（ops-tasks の DB 作成もそのまま）。
- **Service Connect を廃止した**: n8n への Webhook と n8n からの API の呼び出しにしか使っていなかった。cluster の名前空間、4 つのサービスの設定とパラメータ、n8n 関連の SG のルールを外した。n8n（オンプレ）から Chatwoot・Mautic の API は ALB の機械向けのルール経由になる（1.1）。
- **データベースは Aurora Serverless v2**（2026-10-27。ユーザーの条件「アプリケーション側に互換がある場合はサーバーレス、それ以外はクラスター。サーバーレスとクラスターでコストを比較すること」）。単価は Pricing API の東京の値（月 730 時間）:
  - **互換**: MySQL（Mautic）も PostgreSQL（Chatwoot・admin-auth・Strapi・n8n）も、Aurora Serverless v2 に互換がある（同じ Aurora のエンジン。Chatwoot が使う pgvector も含む）。東京で Aurora MySQL 8.4 互換と Aurora PostgreSQL 16.15 の `db.serverless` が使えることを、2026-10-27 に `DescribeOrderableDBInstanceOptions` で確かめた → **どちらもサーバーレス**
  - **コストの比較**: サーバーレスは $0.15/ACU 時（最小 0.5 ACU で月 $55、平均 1 ACU で月 $110、上限の 2 ACU で月 $219）。クラスターのいちばん安い構成は db.t4g.medium（$0.113/時＝月 $82。db.t3.medium は $0.125/時）で、T 系は CPU クレジットの超過料金（$0.09/vCPU 時）がかかりうる。**損益分岐は平均 0.75 ACU**。どちらも一時停止はできない（自動の一時停止は接続がゼロの状態が続かないと効かず、Mautic の毎分の cron と、Chatwoot・n8n・Strapi の常時の接続で止まらない）。平均が 0.75 ACU を超え続けるならクラスターのほうが安いので、`ACUUtilization` のアラームと Cost Explorer（使用タイプ `Aurora:ServerlessV2Usage`）で見直す
  - **経緯**: 2026-10-26 は「高コストでなく互換があればサーバーレス」の方針で、MySQL はサーバーレス、PostgreSQL は「1 ACU 程度が要る」という想定でクラスターにした。その前は RDS の単一インスタンスと比べてサーバーレスを高コストとしたが、方針の選択肢に単一インスタンスは無いので撤回した。2026-10-27 に条件の文言（互換があればサーバーレス）に合わせ、PostgreSQL もサーバーレスにした
  - **1 つにまとめられない**: Aurora はクラスターごとにエンジンが 1 つで、Mautic は MySQL 専用（インストーラーのドライバーは `pdo_mysql` だけ）、Chatwoot は PostgreSQL 専用。PostgreSQL の側は、1 つのクラスターを 4 アプリで共有している
  - **Valkey はノードを持つクラスター**（cache.t4g.micro × 1）。ElastiCache Serverless は常にクラスターモードで、対応するクライアントしか使えず（公式の troubleshooting）、Chatwoot の Sidekiq は Redis Cluster に対応しないため、互換が無い
  - Aurora はストレージが自動で伸びるので、空き容量のアラーム 2 つを外した。RDS のイベントは、インスタンスとクラスターの 2 つの購読にした（ops トピックのポリシーも、発行元の `db:` と `cluster:` の両方を許す。`cluster:` が無いとクラスターのイベントが黙って拒否される）。最大 ACU への張り付きは `ACUUtilization` のアラームで知る
- **WireGuard の終端だけは EC2**（計算資源は、特に理由が無ければ ECS on Fargate か Lambda にする方針の例外）: Fargate では WireGuard を動かせない（カーネルのモジュールと `NET_ADMIN` の権限が要るが、Fargate のタスクには付けられない。経路表の宛先にする固定の ENI も持てない）。Lambda は常駐できない。AWS Site-to-Site VPN は、オンプレ側に固定のグローバル IP が要り（オンプレの IP は固定でない）、IP なしで使う証明書の認証には AWS Private CA の費用がかかる。そのため、いちばん小さい EC2（t4g.nano。月 $4 前後）を 1 台置く。
- **WireGuard の SG は `network.yaml` に置いた**: SG は子スタック間の循環参照を避けるため network.yaml にまとめる流儀に合わせた。`wireguard.yaml` には `WireguardSecurityGroupId` を渡す。経路（`AWS::EC2::Route`）は `wireguard.yaml` が持ち、`network.yaml` の `PrivateRouteTableId` を親が渡す。
- **WireGuard の ENI を別のリソースにした**: 経路表の宛先を ENI にして、送信元／宛先チェックの無効化と Elastic IP の関連付けも ENI に付ける（固定シートの「EC2 の ENI」）。
- **両方向の masquerade**（固定シートの「オンプレから VPC への通信は SNAT」に、VPC からオンプレの向きを足した）: オンプレに VPC のタスクの IP への経路を持たせないため。代わりに、オンプレの nginx から見える送信元が `10.99.0.1` だけになる。
- **forward は既定で drop、新しい接続の許可は 2 行**（ほかに戻りの通信の `ct state established,related accept` が 1 行）: オンプレから VPC は tcp 5432 だけ、VPC からオンプレは `10.99.0.2:5680/tcp` だけ（固定シートのとおり。オンプレから VPC は、ポートも 5432 に絞った）。
- **オンプレの公開鍵を SSM のパラメータにした**: user-data に鍵を埋めないため、鍵の入れ替えでインスタンスが置き換わらない。EC2 が 2 分ごとに読む（`wg-peer-sync`）。パラメータ `OnpremWireguardPublicKey`（固定シート）は、このパラメータの値になる。
- **`ec2:recover`**: `StatusCheckFailed_System` のアラームに自動復旧のアクションを付けた（固定シートの「StatusCheckFailed（ops トピック）」に足した）。
- **パラメータ名**: `OnpremWireguardCidr` は WireGuard のアドレス帯（`10.99.0.0/24`）。UDP の受信元は別名の `WireguardIngressCidr`（既定 `0.0.0.0/0`）。`OnpremWebhookPort`（5680）、`WireguardServerAddress`（10.99.0.1）、`WireguardInstanceType`、`WireguardAmiSsmId`・`WireguardFixedAmiId`（AMI の固定）を足した。
- **`CAPABILITY_NAMED_IAM`**: 既存のテンプレートが IAM ロールに固定の名前を付けていたのに、`samconfig.toml.example` は `CAPABILITY_IAM` だけだった（デプロイで拒否される）。IAM ユーザーも固定の名前なので、例を直した。
- **SNS の購読解除**: トピックポリシーだけでは止まらず、`AuthenticateOnUnsubscribe` が要る（4.4）。TA-04・TA-05 には、リードが訂正を追記済み。**2026-10-27**: 補助として残していたトピックポリシーの `sns:Unsubscribe` の Deny は、SNS が受け付けない action で初回のデプロイが失敗した（`Policy statement action out of service scope!`）ので外した。
- **PostgreSQL のデータベースは 4 つ**（`chatwoot`・`admin_auth`・`strapi`・`n8n`。`points` と、ADR-24 で外した `calcom`、ADR-25 で外した `umami` を除く。もとは 6 つで、TA-05 は 5 つ、TA-06 は 7 つと食い違っていた）。
- **mautic-web はローリング更新**、mautic-cron は止めてから起動する（二重実行の防止。更新中は短く止まる）。
- **WAF**: `auth.` ホストにもレート制限をかけた（Better Auth のレート制限は `X-Forwarded-For` を信頼するため、効き目は WAF に頼る）。
- **cfn-guard の指摘のうち意図した例外**: ALB の 443 を `0.0.0.0/0` に開ける、タスクの外向き、`Resource: '*'` しか書けないアクション（`ecr:GetAuthorizationToken`・`ssmmessages`・`PutMetricData`）、E-15 の写しの Object Lock・アクセスログ・レプリケーション、RDS の Multi-AZ とマスターユーザー名、S3 のアクセスログとレプリケーション。理由は各テンプレートのコメントにある。
