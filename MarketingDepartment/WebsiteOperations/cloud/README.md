# cloud（AWS 本番環境の IaC。AWS SAM）

本番（`ap-northeast-1`）を CloudFormation（AWS SAM）で定義する。設計は `docs/RequirementDefinition/TA/06-aws-runtime.md`（主）、`TA/04`・`TA/05`・`TA/02`・`TA/01`。
**このディレクトリは「書いただけ」の状態である。`sam deploy` は一度も実行しておらず、AWS の API も呼んでいない。** 検証は `sam validate --lint` と cfn-guard の静的検査だけで、
実機で初めて分かることは「5. TODO 一覧」と各テンプレートの `TODO(未検証)` に残した。

**ADR-21（2026-10-05）で、Strapi と n8n をクラウドから外した。** 再帰的自己改善の仕組み（Strapi・n8n・監視アプリ・MCP・ビルド）はオンプレ、
成果物（Astro・Mautic・Chatwoot・Umami と、例外の `consent-api`・Cal.com・`admin-auth`）はクラウド、データの置き場（RDS・ElastiCache・S3・EFS）は AWS に置く。
オンプレと VPC は、小さな EC2 の WireGuard（`stacks/wireguard.yaml`）でつなぐ。構成は 1.1。

収益化（`points-api`・`I-26`〜`I-30`・`E-19` の S3 Object Lock）は作っていない（本システムの完成後。ポート 3106 とフォルダ名を予約しているだけ）。

## 1. 構成

```
cloud/
  template.yaml              親。子を AWS::Serverless::Application で呼び、!GetAtt <Child>.Outputs.<Name> でつなぐ（Export と ImportValue は使わない）
  samconfig.toml.example     samconfig.toml の雛形（実体は追跡しない）
  global/template.yaml       us-east-1 の別スタック。CloudFront 用の ACM 証明書と WAF、フラットレートプランの購読
  stacks/
    network.yaml             VPC、2AZ の public / private、NAT 1 台、S3 ゲートウェイエンドポイント、セキュリティグループ（すべて。WireGuard の EC2 の SG を含む）
    wireguard.yaml           オンプレとの WireGuard の終端（EC2 t4g.nano 1 台、Elastic IP、private サブネットの経路、SSM のパラメータ）
    ecr.yaml                 ECR（自作 2 本〈admin-auth・consent-api〉と、Mautic・Chatwoot・Umami・Cal.com の 6 本）
    observability.yaml       SNS（comegin-lead-alert / comegin-ops-alert）、オンプレのハートビートのアラーム
    runlog-archive.yaml      E-15（実行記録）の写しのバケット。追記だけ
    iam.yaml                 監視アプリ用とデプロイ用の管理ポリシー、オンプレの Strapi・n8n 用の IAM ユーザー 2 つ（アクセスキーは作らない）
    secrets.yaml             Secrets Manager（24 個）
    data.yaml                RDS（MySQL 8.4・PostgreSQL 16）、Valkey、EFS、S3
    cluster.yaml             ECS クラスター、ロググループ（Service Connect は使わない）
    edge.yaml                ACM、ALB、リスナールール、WAF、Route 53
    cdn.yaml                 Astro の配信（CloudFront、OAC、Route 53）
    ses.yaml                 SES のドメイン ID と DKIM
    ops-tasks.yaml           運用者が RunTask で起動する DB 作成のタスク
    alarms.yaml              CloudWatch アラームと RDS のイベント通知
    services/<svc>.yaml      ECS のサービス 8 本（mautic-web・mautic-cron・chatwoot-web・chatwoot-worker・umami・admin-auth・calcom・consent-api）
  images/<製品>/Dockerfile   RDS の CA を足した派生イメージ（mautic・chatwoot・umami・calcom。4.7）
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
- `RunLogAdminPrincipalArns` に、**デプロイに使う主体（IAM ユーザー `comegin-iam`、または CloudFormation のサービスロール）の ARN** を入れること。入れないと、E-15 の写しのバケットポリシーが自分自身の更新を拒否して詰む。
- **`capabilities` は `CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND`**（`samconfig.toml.example` のとおり）。IAM ロールとユーザーに固定の名前（`comegin-<env>-...`）を付けているため、`CAPABILITY_IAM` だけでは拒否される。
- `cp samconfig.toml.example samconfig.toml` して値を入れる。`samconfig.toml` は `cloud/.gitignore` で除外している。

### 重要: パラメータは `samconfig.toml` にすべて書く

SAM CLI の `--parameter-overrides` は「前回の値を使う」ことができない。**書かなかったパラメータは、デプロイのたびにテンプレートの既定値に戻る。**
たとえば `ChatwootWebDesiredCount=1` を samconfig.toml に書かずにデプロイすると、次のデプロイで 0 に戻って**サービスが止まる**。
**既定値と違う値（`DesiredCount`・イメージのタグ・`GoogleClientId` など）は、すべて `samconfig.toml` の `parameter_overrides` に書き、それを正本にする。**
`aws ecs update-service --desired-count` で台数を直接変えない（CloudFormation の値とずれ、次のデプロイで上書きされる）。

## 3. 費用

見積もりは未実施（TA-06 の 9 節）。固定費がかかる要素: ALB、WAF（ALB 用。フラットレートプランの対象外）、Fargate（8 サービス。タスクは各 1）、RDS（2 台）、ElastiCache（1 ノード）、NAT Gateway（1 つ）、EFS、
**EC2 t4g.nano（WireGuard。1 台）と Elastic IP（public IPv4 の課金）と EBS 8 GB（gp3）**、
Secrets Manager（24 個 + ビルド時に作る 3 個 = 27 個。1 個あたり月 $0.40 前後）、CloudWatch（アラーム 29 個、ログ、メトリクス）。

**ADR-21 による増減（概算。単価は見積もりで確かめる）**: Fargate のサービスが 2 つ減る（Strapi と n8n が各 1 vCPU・2 GB。東京の公表単価からの概算で、1 つあたり月 $45 前後。n8n は runners のサイドカー分も減る）。
EC2 t4g.nano（月 $4 前後）、Elastic IP（public IPv4 は 1 つ月 $3.65）、EBS 8 GB（月 $1 未満）が増える。Secrets Manager が 9 個減る（月 $3.6 前後）。アラームは 4 つ減って 2 つ増える。
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
sam deploy        # 初回は RDS・ElastiCache・ACM の検証で 30 分前後かかる
```

作られるもの: ネットワーク、**WireGuard の EC2（Elastic IP つき）と、private サブネットの経路**、ECR、SNS、データストア、Secrets、ALB と WAF、CloudFront、SES のドメイン ID、アラーム、
**IAM ユーザー 2 つ（オンプレの Strapi・n8n 用。アクセスキーは無い）**、ECS のサービス（**すべて DesiredCount 0**）。
サービスは 0 台のまま作られ、イメージがまだ無くても問題ない（タスク定義はイメージの存在を検査しない）。
WireGuard の EC2 は、デプロイの直後から起動する（オンプレの公開鍵が空のあいだは、ピアを持たず、トンネルは張れない）。次の 4.2.1 で鍵を受け渡す。

#### 4.2.1 WireGuard（オンプレとの接続）: 鍵の受け渡しとオンプレ側の設定

鍵は、EC2 の秘密鍵が EC2 の外に出ない形で受け渡す。**秘密鍵を CloudFormation・SSM・Secrets Manager・チャットに載せない。** 渡すのは公開鍵だけ（秘密鍵ではないので、CloudFormation のパラメータと SSM のパラメータに載せてよい）。

```bash
OUT() { aws cloudformation describe-stacks --region ap-northeast-1 --stack-name comegin-prod --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

# 1. 初回のデプロイのあと（OnpremWireguardPublicKey は空のまま）、EC2 が起動して公開鍵を SSM に書くまで数分待つ。
#    うまくいかないときは、SSM Session Manager で入って user-data のログを見る（SSH は使わない）:
aws ssm start-session --region ap-northeast-1 --target "$(OUT WireguardInstanceId)"
#   （EC2 の中）sudo tail -n 50 /var/log/wireguard-setup.log ; sudo wg show

# 2. EC2 の公開鍵と、Endpoint の IP を取り出す（オンプレの Peer に入れる値）
aws ssm get-parameter --region ap-northeast-1 --name "$(OUT WireguardServerPublicKeyParameterName)" --query Parameter.Value --output text
OUT WireguardPublicIp
```

オンプレ側（人が実行。`onprem/` の README が詳細）。鍵対は、オンプレで作り、**秘密鍵はオンプレの秘匿ファイルにだけ置く**（画面に出さない）:

```bash
( umask 077; wg genkey > wg-onprem.key )      # 秘密鍵。リポジトリに入れない
wg pubkey < wg-onprem.key > wg-onprem.pub     # 公開鍵（これを EC2 に渡す）
```

オンプレの `wg0.conf` の形（`<...>` は置き換える）:

```ini
[Interface]
Address = 10.99.0.2/24
PrivateKey = <wg-onprem.key の中身>
[Peer]
PublicKey = <手順 2 の EC2 の公開鍵>
Endpoint = <WireguardPublicIp>:51820
AllowedIPs = 10.99.0.1/32, 10.20.0.0/16
PersistentKeepalive = 25
```

- `AllowedIPs` は EC2 のアドレス（`10.99.0.1/32`）と VPC の CIDR（`VpcCidr`。RDS への経路）。**`PersistentKeepalive` が要る**（EC2 から先にオンプレへ送れない。オンプレの送信元ポートは NAT で変わる）。
- EC2 側のピアの `AllowedIPs` は `10.99.0.2/32`（`OnpremPeerAddress`）だけ。EC2 は、オンプレからの通信を masquerade するので、オンプレに VPC のタスクの IP への経路は要らない。

オンプレの公開鍵を EC2 に渡す（EC2 は 2 分ごとに SSM のパラメータを読んで、ピアを更新する。インスタンスは置き換わらない）:

| 方法 | 手順 | 注意 |
|---|---|---|
| (a) 推奨 | `samconfig.toml` の `parameter_overrides` に `"OnpremWireguardPublicKey=<wg-onprem.pub の中身>"` を書いて `sam deploy` | CloudFormation の値が正になる |
| (b) すぐに反映したい | `aws ssm put-parameter --region ap-northeast-1 --name /comegin/prod/wireguard/onprem-public-key --type String --overwrite --value '<wg-onprem.pub の中身>'`（人が実行） | **CloudFormation の管理値（初期は `UNSET`）とずれる（ドリフト）。** 同じ値を `samconfig.toml` の `OnpremWireguardPublicKey` にも書いておく（書かないと、ドリフトの検知で差が出る。あとで別の値をこのパラメータに入れるときに、元の値と食い違う） |

確認（オンプレの鍵を渡してから、数分以内）:

- オンプレ: `sudo wg show` に `latest handshake` が出る。`ping 10.99.0.1` が通る。`psql "host=<PostgresEndpoint> dbname=strapi user=strapi sslmode=verify-full sslrootcert=<RDS の CA 束>"` で RDS に繋がる（TLS の検証は、4.7 と同じ CA 束で行う。接続先は RDS のエンドポイント名のまま。名前は VPC の private IP に解決される）。
- AWS 側: `aws ssm start-session --target <WireguardInstanceId>` で入り、`sudo wg show`（`latest handshake` と転送量）と `sudo nft list ruleset`（forward の既定が drop で、許可が 2 行だけであること）を見る。
- **Webhook の送信先**（人が各製品の管理画面で設定する）: Mautic は `http://10.99.0.2:5680/webhook/mautic-event`、Chatwoot は `http://10.99.0.2:5680/webhook/chatwoot-event`。HTTP だが、WireGuard の内側を通る。署名の検証（`I-11` `I-12`）は引き続き n8n 側で必須。
  Mautic・Chatwoot のタスクは、宛先が VPC の外（`10.99.0.0/24`）なので、private サブネットの経路表（`PrivateRouteToOnprem`）で EC2 に届く。届かないときは、SG（`WireguardSecurityGroup` の ingress が 4 つの SG から tcp 5680 か）、EC2 の送信元／宛先チェックが無効か、nftables のカウンターを順に見る。

**AMI を固定する（初回のデプロイのあとに必ず行う）。** 既定では、AMI は SSM の「最新」を指す。新しい AMI が出たあとの更新でインスタンスが置き換わる設計になると、**秘密鍵が失われ、公開鍵が変わる（オンプレの `wg0.conf` の `PublicKey` の更新が要る）**。動いている EC2 の AMI の ID を取り出して、`samconfig.toml` の `parameter_overrides` に書く:

```bash
aws ec2 describe-instances --region ap-northeast-1 --instance-ids "$(OUT WireguardInstanceId)" --query 'Reservations[0].Instances[0].ImageId' --output text
# → "WireguardFixedAmiId=<ami-...>" を samconfig.toml に書いて sam deploy（空でなければ SSM の「最新」より優先される）
```

- ENI は別のリソースで、EC2 に差している。**インスタンスの置き換え（AMI やインスタンスタイプの変更）は、新しい EC2 が同じ ENI を使おうとして「使用中」で失敗し、ロールバックする見込み**（未検証）。意図せず鍵が入れ替わることを防ぐ副作用でもある。意図して置き換えるときは、古い EC2 を手で終了（`aws ec2 terminate-instances`）してから `sam deploy` する。ENI・Elastic IP・経路は引き継がれるので、オンプレの `Endpoint` は変わらない。**新しい EC2 の公開鍵（手順 2）を、オンプレの `wg0.conf` の `PublicKey` に入れて `wg-quick` を再起動する。**
- OS の更新: SSM Session Manager で入り、`sudo dnf upgrade --security -y`。カーネルが更新されたときは再起動（ENI・Elastic IP・秘密鍵・nftables・systemd のユニットは変わらない。短く止まる）。止まっている間は、オンプレの Strapi・n8n が RDS に届かず、Webhook が欠落する（TA-05 の縮退運転）。
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
トピックポリシーの `sns:Unsubscribe` の Deny は補助にすぎない。`comegin-lead-alert` も同じ手順で購読する。
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
| `comegin-<env>-onprem-n8n-sns` | `comegin-ops-alert`・`comegin-lead-alert` への `sns:Publish` だけ（購読の変更とトピックの設定変更は不可） | オンプレの n8n の AWS の資格情報（エディターで、アクセスキーを入れる。前回の Assume Role と Use System Credentials は使わない） |

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

### 4.6 Secrets の値を入れる（プレースホルダ 6 個）

`secrets.yaml` の Secret のうち 18 個は自動生成（英数字のみ）。次の 6 個は値なしで作られるので、人間が入れる。**値を入れる前にそのサービスの DesiredCount を上げない**（ECS がタスクの起動に失敗する）。
生成された値を変えない（暗号化の鍵・ソルトを変えると既存のデータを復号できなくなる）。**Secrets Manager の値を消したり作り直したりしない。**
Strapi と n8n の鍵類（`APP_KEYS`・`ENCRYPTION_KEY`・`N8N_ENCRYPTION_KEY`・PostHog のトークンなど）は、オンプレで動かす（ADR-21）ので、Secrets Manager に置かない。オンプレの秘匿ファイルにだけ置く。

| Secret | 入れる値 | 出どころ |
|---|---|---|
| `comegin/<env>/admin-auth/GOOGLE_CLIENT_SECRET` | Google の OAuth クライアントのシークレット | Google Cloud（Workspace の「内部」）。承認済みのリダイレクト URI は `https://<AuthHost>/api/auth/callback/google`。クライアント ID は親のパラメータ `GoogleClientId` |
| `comegin/<env>/mautic/SMTP_USERNAME` `SMTP_PASSWORD` | Mautic 用の SES の SMTP 認証情報 | 4.9 |
| `comegin/<env>/chatwoot/SMTP_USERNAME` `SMTP_PASSWORD` | Chatwoot 用の SES の SMTP 認証情報（Mautic とは別に発行） | 4.9 |
| `comegin/<env>/calcom/GOOGLE_API_CREDENTIALS` | Google の OAuth クライアントの JSON（Calendar 用） | Google Cloud。**admin-auth のクライアントと共用しない** |

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
- CA の取得はビルド時（`ADD --checksum=sha256:...`）で、**SHA-256 は `fe45bbebf92ad3e27a583bbb2ddd1553c521ed4d49af5514dc0a40372ea5395c`**（2026-10-04 に取得した 111 証明書の束）。
  AWS が束を更新すると、**ビルドも ops-tasks のタスクも失敗する（意図した動作。改ざんの検知と、CA の更新を人が確かめるため）。** 更新の手順:
  1. `curl -fsS https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /tmp/b.pem` で取得し、中身（証明書の数、発行者）を確かめる。
  2. `sha256sum /tmp/b.pem` の値を、`cloud/images/*/Dockerfile` の `RDS_CA_SHA256` と、親のパラメータ `RdsCaSha256`（ops-tasks）に反映する。
  3. 4 つの派生イメージを、ビルドの連番を上げたタグでビルドし直して push する。
- ElastiCache（`rediss://`）は、Amazon の公開 CA で署名されており、Node（consent-api）と Ruby（Chatwoot）の既定の信頼ストアで検証される。検証を無効にする設定は入れていない。
- 自作の admin-auth は、Dockerfile が同じ CA を `NODE_EXTRA_CA_CERTS` で持つ。

| 接続元 | 検証のしかた（テンプレートの設定） | 検証の状況 |
|---|---|---|
| Chatwoot（Rails・libpq） | `PGSSLMODE=verify-full`、`PGSSLROOTCERT=/etc/rds/global-bundle.pem` | libpq は、自作の CA のローカルの PostgreSQL で確認済み（正しいとき接続、CA が無いときとホスト名が違うときは失敗）。Chatwoot の Rails 本体では未 |
| Umami（Node の pg と Prisma の Rust エンジン） | `DATABASE_URL` を `sslmode=verify-full&sslaccept=strict`、`NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE`（システムの CA 束に RDS の CA を足した束） | **Umami 3.4.0 のイメージで確認済み**（ローカルの TLS つき PostgreSQL）。pg 8.22 と Prisma のエンジンの両方が、CA が無いとき・ホスト名が違うときに失敗し、正しいとき接続する。実機の RDS では未 |
| Cal.com（Prisma） | Umami と同じ | 未（イメージを取得していない。Prisma 6 の Rust エンジンを想定） |
| Mautic（Doctrine・PDO と起動時の `mysqladmin ping`） | `config.php` に `PDO::MYSQL_ATTR_SSL_CA` と `PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT` を足し（ビルド時のパッチ。2 か所に入ったことと `php -l` を確かめ、確かめられなければビルドが失敗する）、mariadb-admin の設定（`/etc/mysql/conf.d/rds-ssl.cnf`）に `ssl-ca` と `ssl-verify-server-cert`。RDS の MySQL は `require_secure_transport=1`（`data.yaml`） | **派生イメージのビルドを確認済み。PHP 8.3 の PDO と `mysqladmin` は、自作の CA のローカルの TLS つき MySQL で確認済み**（正しいとき接続、CA が違うときとホスト名が違うときは失敗）。Mautic 本体の起動は未 |
| admin-auth | `DATABASE_SSL=true`（CA は Dockerfile の `NODE_EXTRA_CA_CERTS`） | edge が実装済み。実機では未 |
| オンプレの Strapi・n8n（WireGuard 経由） | `onprem/` の設定（Strapi は `DATABASE_SSL=true`、n8n は `DB_POSTGRESDB_SSL_CA_FILE` と `REJECT_UNAUTHORIZED=true`）。接続先は RDS のエンドポイント名（ホスト名の検証が通る） | 未（実機で、トンネルを張ってから確かめる） |
| ops-tasks の DB 作成タスク | 起動時に CA を取得して SHA-256 を照合し、`PGSSLMODE=verify-full`（MySQL は `--ssl-mode=VERIFY_IDENTITY`） | CA の取得と照合は、各イメージで確認済み |

**重要（Prisma）**: Prisma の Rust のエンジン（起動時の `prisma migrate deploy`）は、`sslmode` が `require` でも `verify-full` でも証明書を検証しない（上のローカルの実験で、CA が無くても繋がった）。
検証するのは `sslaccept=strict` を付けたときだけ。Umami と Cal.com の URL に `sslaccept=strict` を付けているのはこのため。外すと、暗号化だけで検証しない設定に戻る。
なお、Node の pg は sslmode の `require` を `verify-full` の別名として扱うが、pg v9 では libpq 互換（検証しない）に変わる予定なので、`verify-full` と明示している。

#### 派生イメージ（4 本。上流のタグを固定してビルドする）

タグは `<上流のタグ>-<ビルドの連番>`（再ビルドするときは連番を上げる。ECR のタグは上書きできない）。

| 製品 | Dockerfile | `UPSTREAM_TAG` | ECR のリポジトリ | パラメータの例 |
|---|---|---|---|---|
| Chatwoot | `cloud/images/chatwoot` | `v4.18.0`（**4.12 以上**。署名つき Webhook の `X-Chatwoot-Signature` は 4.12 以降。API チャネルとエージェントボットの署名は 4.13 以降） | `comegin/<env>/chatwoot` | `ChatwootImageTag=v4.18.0-1` |
| Umami | `cloud/images/umami` | `3.4.0`（**3.4.0 以上**。ghcr.io のタグは `v` なし） | `comegin/<env>/umami` | `UmamiImageTag=3.4.0-1` |
| Mautic | `cloud/images/mautic` | `7.2.0-apache`（公式に 7.x のタグがある。取り込み済みのソースは 7.2.0） | `comegin/<env>/mautic` | `MauticImageTag=7.2.0-1` |
| Cal.com | `cloud/images/calcom` | **ライセンスの確認が先（5 節）** | `comegin/<env>/calcom` | `CalcomImageTag` |

```bash
docker build --platform linux/amd64 --build-arg UPSTREAM_TAG=v4.18.0 -t $ECR/comegin/prod/chatwoot:v4.18.0-1 cloud/images/chatwoot
docker push $ECR/comegin/prod/chatwoot:v4.18.0-1
```

#### 自作のイメージ（タグはコミットの短縮 SHA など、毎回変わるもの）

| リポジトリ | ビルド元 | パラメータ |
|---|---|---|
| `comegin/<env>/admin-auth` | `backend/admin-auth`（同上） | `AdminAuthImageTag` |
| `comegin/<env>/consent-api` | `backend/consent-api` | `ConsentApiImageTag` |

```bash
TAG=$(git rev-parse --short HEAD)
docker build --platform linux/amd64 -t $ECR/comegin/prod/consent-api:$TAG backend/consent-api
docker push $ECR/comegin/prod/consent-api:$TAG
```

タグを設定ファイル（`samconfig.toml`）に書いてデプロイする（`REPLACE-WITH-FIXED-TAG` のままでは起動しない）。

### 4.8 データベースとアプリ用ユーザーを作る（1 回だけ）

PostgreSQL に `chatwoot` / `umami` / `admin_auth` / `strapi` / `n8n` / `calcom` のデータベースとユーザー（同じ名前）を、MySQL に `mautic` を作る。パスワードは Secrets Manager のアプリ用の値に揃える。
`strapi` と `n8n` は、オンプレの Strapi・n8n が WireGuard 経由で使う（ADR-21）。作り方は同じで、使うのはオンプレ側だけ。
冪等なので、何度実行してもよい（パスワードを Secret の値に揃え直す）。chatwoot のデータベースには拡張（`vector`・`pg_trgm`・`pg_stat_statements`）も入れる。

```bash
OUT() { aws cloudformation describe-stacks --region ap-northeast-1 --stack-name comegin-prod --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
CLUSTER=$(OUT ClusterName); SUBNETS=$(OUT PrivateSubnetIds); OPS_SG=$(OUT OpsTasksSecurityGroupId)

TASK=$(aws ecs run-task --cluster "$CLUSTER" --launch-type FARGATE --task-definition comegin-prod-db-init-postgres \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$OPS_SG],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK"
aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].containers[0].[exitCode,reason]'   # exitCode が 0 であること
aws logs tail /comegin/prod/tasks --since 15m                                                                      # 結果のログ
# MySQL は --task-definition comegin-prod-db-init-mysql
```

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
5. バウンスと苦情を Mautic に返す経路は未決定（TA-06 の 11 節）。SES のイベントを社内の通知（ops）に流すと、宛先のメールアドレスが載ってしまうため、ここでは設定していない。

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
| **Chatwoot** | 上の `db:chatwoot_prepare`（entrypoint は `docker/entrypoints/rails.sh` のまま、`command` だけ上書き）。**初回とイメージを更新するたびに、サービスを起動する前に実行する。** |
| **admin-auth** | ① 移行 `["node","dist/scripts/migrate.js"]` ② ALB を信頼済みクライアントとして登録 `["node","dist/scripts/register-alb-client.js"]`（**`pnpm alb:register` ではない。イメージの中に pnpm は無い**）。どちらも冪等で、終了コードは成功 0・失敗 1。タスク定義は `comegin-prod-admin-auth`、コンテナ名 `admin-auth`、セキュリティグループは `AdminAuthSecurityGroupId`。環境変数はサービスと同じもの（`DATABASE_*`・`BETTER_AUTH_*`・`GOOGLE_*`・`ALB_*`）で、`ALB_CLIENT_SECRET` は ALB のリスナールールと同じ Secret から渡る。**`ALB_PROTECTED_HOSTS` には `authenticate-oidc` をかける 4 つのホスト（`ChatHost`・`MktHost`・`StatsHost`・`CalHost`）がすべて入る**（ADR-21 で `cms.`・`n8n.` を外した）（親が edge の出力から渡す）。足りないホストでは、ALB のリダイレクトが拒否されてログインできない。**移行と登録のあとで `AdminAuthDesiredCount` を上げる**（許可リストの表が無い、または DB に届かないとき、プロセスは終了して ECS が再起動を繰り返す）。 |
| **Mautic** | **RunTask は要らない。** 公式の entrypoint が、インストール済み（`config/local.php` に `db_driver` と `site_url` がある）なら、web ロールの起動のたびに `doctrine:migrations:migrate` を実行する。未インストールのあいだは何もせず、cron は**インストールが終わるまで待つ**。初回は、`mautic-web` を起動し、ログインした管理者がブラウザで `https://<MktHost>/installer` を開いてインストールする（`/installer` は OIDC の内側）。`local.php` は EFS の `config` に保存され、再起動で消えない。CLI でするなら ECS Exec（`su -s /bin/sh www-data -c 'cd /var/www/html && php ./bin/console mautic:install https://<MktHost> --admin_email=<…> --admin_password=<…>'`。未検証）。管理者のパスワードは Secrets Manager に置かず、インストール時に人間が決める。**TODO(未検証)**: Mautic の設定名（`MAUTIC_SITE_URL`、`MAUTIC_TRUSTED_PROXIES`）。 |
| **Umami** | RunTask は要らない。イメージの起動処理（`scripts/check-db.js`）が、起動のたびに `prisma migrate deploy` を実行する（タスクは 1 つなので並行しない）。 |
| **Cal.com** | 起動時に自分で DB を移行する（タスクは 1 つなので並行しない）。Cal.com の起動時の移行は実機で確かめる（TA-06 の 3.3）。 |
| **Strapi・n8n（オンプレ）** | オンプレで動かす（ADR-21）。起動時に自分で RDS の `strapi`・`n8n` データベースを移行する。WireGuard が張れていて、4.8 のパスワードを渡してから起動する。 |

**移行が失敗したら、サービスのイメージを更新しない**（古いイメージのまま動かし続ける）。

#### n8n の AWS の資格情報（SNS への発行）

オンプレの n8n の AWS ノードには、IAM ユーザー `comegin-<env>-onprem-n8n-sns` のアクセスキーを入れる（4.5 で発行）。n8n のエディターで、AWS の資格情報を作る: 認証は**アクセスキー**、リージョンは `ap-northeast-1`。ワークフローの SNS ノードにこの資格情報を使う。
前回の Assume Role・Use System Credentials・`N8N_AWS_SYSTEM_CREDENTIALS_ACCESS_ENABLED` は使わない（ロール `sns-publisher` は無い）。引き受けや購読の変更の権限は、このユーザーに無い（2 トピックへの `sns:Publish` だけ。TA-04 の 1 節）。

### 4.11 DesiredCount を上げる順

1 つ上げるたびに、4.13 の確認と、CloudWatch のアラームが鳴っていないことを見る。`samconfig.toml` の `parameter_overrides` に書いてデプロイする。

| 順 | サービス | 条件・注意 |
|---|---|---|
| 1 | `AdminAuthDesiredCount=1` | イメージ、`GoogleClientId`、`GOOGLE_CLIENT_SECRET`、DB 作成、migrate、`register-alb-client` を済ませてから。**これが無いと、管理画面に誰も入れない** |
| 2 | `UmamiDesiredCount=1` | |
| 3 | `ChatwootWebDesiredCount=1` → `ChatwootWorkerDesiredCount=1` | `db:chatwoot_prepare` のあと。SMTP の Secret を入れてから。**Webhook の送信先（4.2.1）は、オンプレの n8n の受け口が起動してから設定する** |
| 4 | `MauticWebDesiredCount=1` → `MauticCronDesiredCount=1` | イメージと初期設定のあと。**cron は 1 に固定**（2 つ動くとキャンペーンとメールが二重になる） |
| 5 | `ConsentApiDesiredCount=1` | 公開サイトの同意の受け口。WAF のレート制限が最も厳しい |
| 6 | `CalcomDesiredCount` | **0 のまま**（ライセンスとメールが未解決。5 節） |

`mautic-web` と `mautic-cron` の DesiredCount は 0 か 1 しか受け付けない（テンプレートが拒否する）。
WireGuard の EC2 は DesiredCount の対象ではない（常時 1 台。4.2.1）。オンプレの Strapi・n8n の起動は、ここの対象外（`onprem/` の README）。

### 4.12 イメージの更新

1. 新しいイメージを ECR に置く（4.7）。
2. **DB のスキーマが変わる製品（Chatwoot・Mautic・admin-auth・Umami）**: 先にそのサービスを `DesiredCount=0` にして、新しいタグでデプロイする（タスク定義の新しいリビジョンができる）。マイグレーションの RunTask（4.10）が成功したら、`DesiredCount=1` に戻してデプロイする。止まっている間は、その製品の機能が止まる。
3. **自分で移行する製品（Cal.com）と、スキーマが変わらない更新**: タグを変えてデプロイするだけ（ローリング更新。サーキットブレーカーが、新しいタスクの起動が失敗し続けたときに直前に戻す）。
4. Strapi と n8n の更新は、オンプレで行う（ADR-21。`onprem/` の README）。このスタックの対象外。
5. **4.13 の確認をデプロイごとに行う。** 製品を更新すると訪問者向けのパスが変わりうる。許可リスト方式なので、変わると機能が止まる側に倒れる（管理画面が開く側には倒れない）。

### 4.13 デプロイ後の確認

```bash
# 訪問者向け: 認証なしで 200（パスは edge.yaml の許可リスト）
curl -s -o /dev/null -w '%{http_code}\n' https://<StatsHost>/script.js                  # 200（Umami のトラッカー）
curl -s -o /dev/null -w '%{http_code}\n' https://<ChatHost>/widget                      # 200 か製品の応答（Chatwoot のウィジェット）
curl -s -o /dev/null -w '%{http_code}\n' https://<ConsentHost>/v1/consent               # 200（同意の状態の取得）

# 機械向けの API: トークン無しでは製品側が拒否する（401）
curl -s -o /dev/null -w '%{http_code}\n' https://<ChatHost>/api/v1/accounts/1/conversations
curl -s -o /dev/null -w '%{http_code}\n' https://<MktHost>/api/contacts
curl -s -o /dev/null -w '%{http_code}\n' https://<StatsHost>/mcp

# 管理画面: 302 で auth. に飛ぶ（200 が返ったら認証が外れている。最優先で直す）
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<ChatHost>/app/
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<MktHost>/s/login
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<StatsHost>/

# 許可リストの外は閉じている
curl -s -o /dev/null -w '%{http_code}\n' https://<ConsentHost>/healthz                  # 404（/healthz は外に出さない）
curl -s -o /dev/null -w '%{http_code}\n' https://<ConsentHost>/                         # 404

# cms.・n8n. はもう無い（ADR-21）。DNS にレコードが無いこと（名前が引けない）を確かめる
dig +short cms.comegin.com
dig +short n8n.comegin.com
```

**Strapi のメディア（オンプレの Strapi から）**: 管理画面で画像を 1 枚アップロードし、署名付き URL（有効 1 時間）で取得できること。S3 のバケットが非公開のままであること（バケットのパブリックアクセスのブロックが全部オンであること）。アップロードは IAM ユーザー `onprem-strapi-media` のキーで行われる（CloudTrail で確かめられる）。

**WireGuard**: 4.2.1 の確認（`latest handshake`、RDS への接続、Webhook の疎通）。Mautic・Chatwoot の管理画面から Webhook を試し送信して、オンプレの n8n に届くこと。EC2 の `sudo nft list ruleset` で forward の許可が 2 行だけであること。

ブラウザで: 管理画面（`chat.`・`mkt.`・`stats.`・`cal.`）の URL を開くと Google のログインに転送され、許可リストに載っているアカウントだけが入れること、ALB のセッションが 12 時間であること。
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
- CloudFront のキャッシュポリシーはマネージド（Free プランで使える既定のルール）で、オリジンの `Cache-Control` を尊重する。上の同期の `--cache-control` が、長さを決める。
- ディレクトリ形式（`/about/` → `about/index.html`）は CloudFront Function が補う。404 ページ（`/404.html`）は `frontend/verdant-virgo` にまだ無い（5 節）。

### 4.15 開発機を意図的に止めるとき（休日など）

止める前にオンプレのハートビートのアラームのアクションを無効にし、再開予定の時刻に有効に戻す 1 回限りのスケジュールを**先に**作る（有効に戻し忘れると、オンプレの全滅が知らされない状態が続く）。無効にするのはオンプレのハートビートのアラームだけで、本番のアラームは止めない。手順は TA-05 の 4 節の表。

```bash
aws cloudwatch disable-alarm-actions --alarm-names comegin-prod-onprem-heartbeat
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

ALB 用の WAF のレート制限のしきい値は暫定値（5 分あたり・送信元 IP あたり。consent 30、フォーム 100、予約 100、API 1000、`auth.` 300、その他 2000）。同じログで実測して決める。

## 5. TODO 一覧

設計書の「未決定事項」のうち、インフラで決まるもの、実機で確かめるもの、他のメンバーの作業待ちのもの。`(未検証)` は一度も実機で動かしていないという意味。

| 領域 | TODO | どこに書いたか |
|---|---|---|
| **Cal.com** | ライセンス（使う機能が自前で動かせる範囲か）、公式イメージの有無とタグ、起動時の DB の移行、予約の確認メール（SES の SMTP と `EMAIL_*`・Secret がまだ無い）、訪問者向けのパスの切り分け（`edge.yaml` にルールが無い。`cal.` は全体が OIDC の内側）。**確かめずに動かさない。DesiredCount は 0 のまま** | `services/calcom.yaml` |
| **訪問者向けパス** | TA-06 の 5.3 の想定値で入れてある。各製品のバージョンで DevTools により実測して確定する（Chatwoot は `/packs/*` 以外のアセットのパスがあるか、Mautic は `/form/generate.js` などの埋め込み用のパス、Umami の `TRACKER_SCRIPT_NAME`）。ヘルスチェックのパスも実測（Cal.com の `/api/version` は仮） | `edge.yaml` |
| **SES** | 本番アクセスの申請、apex の SPF と DMARC を Google Workspace と統合、バウンスと苦情を Mautic に返す経路 | 4.9、`ses.yaml` |
| **E-15 の写し** | 頻度と形式、保持期間とライフサイクル（決まるまで設定しない）、Object Lock（保持期間が決まってから）。`If-None-Match` を必須にするバケットポリシーの Deny は実機未検証（書き込みは単発の `PutObject` で、マルチパートを使わないこと） | `runlog-archive.yaml` |
| **SNS の購読** | `AuthenticateOnUnsubscribe` を付けた確認（4.4）。購読状態（`Confirmed` の数）の監視は未作成（SNS 以外の手段が要る。TA-05 の項目 8） | 4.4 |
| **外形監視** | 訪問者向けパスが認証なしで 200 を返すこと、管理画面が 302 を返すこと（200 は認証が外れた異常）、`cms.`・`n8n.` の名前が引けないことの定期確認は未作成（TA-05 の項目 6・7。CloudWatch Synthetics か Route 53 のヘルスチェックの案）。4.13 を手で行う | — |
| **WireGuard（ADR-21）** | ①**実機で一度も動かしていない**。AL2023 のカーネルに `wireguard` のモジュールがあるか、`wireguard-tools` が core のリポジトリにあるか（無ければ user-data が失敗し、`/var/log/wireguard-setup.log` に残る）。②nftables のルール（forward の既定 drop、両方向の masquerade）と、WireGuard の応答が SG の egress の許可なしで通るか（SG はステートフルなので通る想定。オンプレの `PersistentKeepalive` が通信を保つ）。③`ec2:recover`（`WireguardSystemRecoverAlarm`）が t4g で使えるか。④**トンネルそのもの（`latest handshake` の途絶）の監視は未作成**（EC2 の中から `PutMetricData` する案。IAM と名前空間を足す必要がある）。EC2 の死活（ステータスチェック）だけを見ている。⑤Webhook の再送の有無（Mautic・Chatwoot がオンプレの停止中に取りこぼした分を後から送るか）は、DD-07 の縮退運転で確かめる。⑥OS の更新は手動（4.2.1）。自動更新は入れていない。⑦AMI の変更で EC2 を置き換えると、ENI が「使用中」で失敗する見込み（未検証。4.2.1）。⑧`WireguardIngressCidr` は `0.0.0.0/0`（オンプレの IP が固定でないため）。固定の IP が使えるなら絞る | `wireguard.yaml`、`network.yaml`、4.2.1 |
| **オンプレの IAM ユーザー** | アクセスキーの発行（4.5）。S3 の署名付き URL（Strapi の S3 プロバイダー）が、IAM ユーザーのキーで動くこと。ローテーションの運用（キーは 1 ユーザー 2 つまで）。Strapi のアップロードの ACL（`BucketOwnerEnforced` のバケットなので、ACL を付けない設定が要る。`strapi-system` 側） | `iam.yaml`、4.5 |
| **Mautic** | ①`MAUTIC_SITE_URL` と `MAUTIC_TRUSTED_PROXIES` の設定名と形式（公式の「local.php の設定は `MAUTIC_<大文字の名前>`」に基づく想定）。**`trusted_proxies` が無いと ALB 越しのアクセスを HTTP と判定して壊れる恐れ**。②メールの設定名（SMTP は管理画面で設定する）。③非同期のキューを使うなら `mautic_worker` のサービスを足す。④`mautic-web` を 2 タスク以上にするには、セッションの保存先（Valkey か RDS）を決める。⑤派生イメージの `config.php` のパッチは、上流の版を上げるとパターンが合わなくなりうる（そのときはビルドが失敗する。黙って検証なしにはならない）。⑥Mautic 本体の起動と、`/installer` でのインストール | `services/mautic-*.yaml`、`images/mautic/Dockerfile` |
| **Chatwoot** | S3 をタスクロールで使えるか（`AWS_ACCESS_KEY_ID` を空のまま SDK の既定の探索に倒れるか。倒れなければ専用の IAM ユーザーのキーを Secret に）。有効にする拡張を採用バージョンの `db/schema.rb` で確かめる。Rails 本体で `PGSSLMODE=verify-full` が効くか | `services/chatwoot-*.yaml`、`ops-tasks.yaml` |
| **Umami・Cal.com の TLS** | 実機の RDS で検証つきで繋がること（実行時と、起動時の `prisma migrate deploy` の両方）。Cal.com のイメージでの確認（4.7 の表） | `services/umami.yaml`、`services/calcom.yaml` |
| **RDS への TLS** | すべてのサービスが検証つきで接続する形にした（4.7 の表）。**実機の RDS で、各製品が検証つきで繋がること**（とくに Cal.com・オンプレの Strapi と n8n・Chatwoot の Rails・Mautic 本体）。繋がらない製品があっても、`PostgresForceSsl` を 0 にしたり検証を外したりする前に、製品側の設定を探す | `data.yaml`、4.7 |
| **エンジンのバージョン** | RDS は `8.4` と `16` のプレフィックス指定（最新のマイナーを確かめて固定）。Valkey は `8.0`（CloudFormation と ElastiCache が受け付けるかを実機で確かめる。無ければ 7.2。開発は `valkey/valkey:8-alpine`）。Chatwoot の Sidekiq に問題が出たら、同じノードタイプのまま Redis OSS 7.1 に切り替える | `data.yaml` |
| **admin-auth** | PKCE は今は必須にしていない（ALB が送るか確認できないため。Wave 4 で確かめる）。**許可リストから外しても、ALB のセッション Cookie は最大 12 時間有効**（`OidcSessionTimeoutSeconds` を短くするかの検討を含む）。ALB のクライアント認証は既定の `client_secret_basic`（ALB が post を使う場合は、登録スクリプトの引数で登録し直す）。ALB と Better Auth の組み合わせの実地確認 | `edge.yaml`、`services/admin-auth.yaml` |
| **フラットレートプラン** | 購読の実機での確認（Free Tier のアカウントは不可）。apex か `www` か（プランは 1 apex まで）。allowance を超えた後の挙動。標準アクセスログは Pro 以上（Free は無し）。`/404.html` を `frontend/verdant-virgo` に作る | `global/template.yaml`、`cdn.yaml` |
| **WAF** | Common ルールの Count から Block への切り替え（判断は R1。4.16）、しきい値の実測、WAF のログの配信権限（デプロイ主体に `logs:CreateLogDelivery` と `logs:PutResourcePolicy` などが要る見込み）。ALB のアクセスログは未設定 | `edge.yaml`、4.16 |
| **ネットワーク** | タスクのセキュリティグループの外向きは tcp の全ポートを `0.0.0.0/0` に開けている（ECR・Secrets Manager・SES が呼ぶ外部 API）。宛先で絞るのは未着手 | `network.yaml` |
| **データの保全** | EFS の復元手順の確認（日次の自動バックアップ）。RDS の Enhanced Monitoring・Performance Insights は付けていない。Multi-AZ は止まった時間の実績を見て順に冗長化する（TA-06 の 4.6） | `data.yaml` |
| **見積もり** | 費用の見積もり（TA-06 の 9 節）。アラームの数、Container Insights、WAF のログ、WireGuard の EC2 と Elastic IP、インターネットへのデータ転送（RDS の応答・Webhook）を含める。3 節の増減の概算は未確認の単価に基づく | 3 節 |
| **未着手の設計** | 収益化（`points-api`・3106・`E-19` の S3 Object Lock）。オンプレの n8n・Strapi のハートビートのアラーム（オンプレの監視アプリのハートビートはある）。`consent-api` の TTL とバックアップ（TA-06 の 11 節） | — |

## 6. 設計書との差分と判断メモ

- **Secret が 24 個**: 設計書の「約 18 個」より多い。理由は 3 節。ADR-21 で Strapi と n8n の鍵類を外した（`DB_PASSWORD` の 2 個だけ残す）。
- **ECR は 6 本**: 自作 2 本（admin-auth・consent-api）と、Mautic、Chatwoot、Umami、Cal.com。**DB に接続する上流のイメージは、薄い派生イメージ**（RDS の CA を足したもの。4.7）にして置く。TA-06 の 3.2「イメージは ECR に置く」に従う。Strapi・n8n・n8n-runners は、オンプレで動かすので置かない（ADR-21）。
- **`cdn.yaml`・`ses.yaml`・`ops-tasks.yaml`・`alarms.yaml`**: 固定シートの一覧にないが必要なので足した（OAC 専用の Astro バケットとデプロイ用 IAM の対象、SES のドメイン ID、DB 作成のタスク、アラーム）。
- **イメージのタグは製品ごと**（6 個）: mautic-web と mautic-cron、chatwoot-web と chatwoot-worker のずれを防ぐ。タグは `<上流のタグ>-<ビルドの連番>`。
- **RDS のマスターの資格情報**: TA-06 の 7 節は「タスクには渡さない」とするが、アプリ用ユーザーを作る 1 回だけのタスクには要る。`ops-tasks.yaml` の専用の実行ロールだけが読める。
- **DB の TLS は、検証をしない形を作らない**: 暗号化だけにして逃がすことはしない。Prisma の Rust のエンジンが `sslmode` だけでは検証しない点は、実験で確かめて `sslaccept=strict` を付けた（4.7）。Mautic は上流が CA を渡す設定項目を持たないため、ビルド時にパッチを当て、当たったことを確かめられなければビルドを失敗させる。
- **Mautic の config は EFS で覆う（既定で有効）**: 公式イメージの `config/` には `.gitkeep` しか無く、覆っても既定のファイルは隠れない。`local.php` は entrypoint が無ければ作る。init コンテナは不要（イメージの中身を確かめた上での判断。4.10）。
- **n8n の SNS**: オンプレの n8n は、IAM ユーザー `onprem-n8n-sns` のアクセスキーで 2 トピックに発行する（前回のロール `sns-publisher` と、Assume Role・Use System Credentials は廃止。ADR-21）。キーは CloudFormation で作らず、人が発行する（4.5）。
- **Strapi・n8n を外した**（ADR-21）: `services/strapi.yaml`・`services/n8n.yaml`・`images/n8n/`、ALB の `cms.`・`n8n.` のルールとターゲットグループ、ACM の名前、Route 53 のレコード、WAF の `cms.` の API の分、ECR の 3 本、Strapi と n8n の鍵類の Secret（9 個）、アラーム 4 つ、ログのグループを外した。**ECR のリポジトリと Secret は `DeletionPolicy: Retain` なので、テンプレートから外しても AWS に残る**（ロググループは消える）。 まだ一度もデプロイしていないので実害は無いが、前の版をデプロイ済みの環境では、不要な ECR のリポジトリと Secret を手で消す。RDS の `strapi`・`n8n` データベースと、S3 の Strapi のメディアのバケットは、データの置き場として残した（ops-tasks の DB 作成もそのまま）。
- **Service Connect を廃止した**: n8n への Webhook と n8n からの API の呼び出しにしか使っていなかった。cluster の名前空間、4 つのサービスの設定とパラメータ、n8n 関連の SG のルールを外した。n8n（オンプレ）から Chatwoot・Mautic の API は ALB の機械向けのルール経由になる（1.1）。
- **WireGuard の SG は `network.yaml` に置いた**: SG は子スタック間の循環参照を避けるため network.yaml にまとめる流儀に合わせた。`wireguard.yaml` には `WireguardSecurityGroupId` を渡す。経路（`AWS::EC2::Route`）は `wireguard.yaml` が持ち、`network.yaml` の `PrivateRouteTableId` を親が渡す。
- **WireGuard の ENI を別のリソースにした**: 経路表の宛先を ENI にして、送信元／宛先チェックの無効化と Elastic IP の関連付けも ENI に付ける（固定シートの「EC2 の ENI」）。
- **両方向の masquerade**（固定シートの「オンプレから VPC への通信は SNAT」に、VPC からオンプレの向きを足した）: オンプレに VPC のタスクの IP への経路を持たせないため。代わりに、オンプレの nginx から見える送信元が `10.99.0.1` だけになる。
- **forward は既定で drop、許可は 2 行**: オンプレから VPC は tcp 5432 だけ、VPC からオンプレは `10.99.0.2:5680/tcp` だけ（固定シートのとおり。オンプレから VPC は、ポートも 5432 に絞った）。
- **オンプレの公開鍵を SSM のパラメータにした**: user-data に鍵を埋めないため、鍵の入れ替えでインスタンスが置き換わらない。EC2 が 2 分ごとに読む（`wg-peer-sync`）。パラメータ `OnpremWireguardPublicKey`（固定シート）は、このパラメータの値になる。
- **`ec2:recover`**: `StatusCheckFailed_System` のアラームに自動復旧のアクションを付けた（固定シートの「StatusCheckFailed（ops トピック）」に足した）。
- **パラメータ名**: `OnpremWireguardCidr` は WireGuard のアドレス帯（`10.99.0.0/24`）。UDP の受信元は別名の `WireguardIngressCidr`（既定 `0.0.0.0/0`）。`OnpremWebhookPort`（5680）、`WireguardServerAddress`（10.99.0.1）、`WireguardInstanceType`、`WireguardAmiSsmId`・`WireguardFixedAmiId`（AMI の固定）を足した。
- **`CAPABILITY_NAMED_IAM`**: 既存のテンプレートが IAM ロールに固定の名前を付けていたのに、`samconfig.toml.example` は `CAPABILITY_IAM` だけだった（デプロイで拒否される）。IAM ユーザーも固定の名前なので、例を直した。
- **SNS の購読解除**: トピックポリシーだけでは止まらず、`AuthenticateOnUnsubscribe` が要る（4.4）。TA-04・TA-05 には、リードが訂正を追記済み。
- **PostgreSQL のデータベースは 6 つ**（`points` を除く。TA-05 は 5 つ、TA-06 は 7 つと食い違っていた）。
- **mautic-web はローリング更新**、mautic-cron は止めてから起動する（二重実行の防止。更新中は短く止まる）。
- **WAF**: `auth.` ホストにもレート制限をかけた（Better Auth のレート制限は `X-Forwarded-For` を信頼するため、効き目は WAF に頼る）。
- **cfn-guard の指摘のうち意図した例外**: ALB の 443 を `0.0.0.0/0` に開ける、タスクの外向き、`Resource: '*'` しか書けないアクション（`ecr:GetAuthorizationToken`・`ssmmessages`・`PutMetricData`）、E-15 の写しの Object Lock・アクセスログ・レプリケーション、RDS の Multi-AZ とマスターユーザー名、S3 のアクセスログとレプリケーション。理由は各テンプレートのコメントにある。
