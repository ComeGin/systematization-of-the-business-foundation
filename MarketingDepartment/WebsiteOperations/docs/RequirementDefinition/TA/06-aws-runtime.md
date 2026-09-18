# 06. 訪問者が触れるシステムの AWS 実行環境（Mautic / Chatwoot / Umami）

TA（Technology Architecture）層。ID は EA 共通用語集の定義をそのまま使う。
ファイルパスは `MarketingDepartment/WebsiteOperations/` を起点とした相対で書く。

AA-05 の ADR-12 で、**訪問者のブラウザが直接触れるシステムを AWS に置く**と決めた。Astro の配信は TA-02 が扱い、本ファイルは残りの 3 つ（Mautic・Chatwoot・Umami）の本番の実行環境を扱う。

**状態: 未着手（`cloud/` ディレクトリは空）。** 本ファイルの内容はすべて To-Be の設計である。**開発環境は今のままローカルの Docker で動かし、本ファイルの構成は本番にだけ適用する。**

## 1. 検証の状態

**2026-09-18 に AWS API で実地検証を行った**（読み取りのみ）。

| 検証項目 | 結果 |
|---|---|
| RDS for MySQL | `ap-northeast-1` で **8.4 系（8.4.7〜8.4.9）** が使える。開発環境の MySQL 8.4（`backend/mautic-system/docker/compose.yaml`）と同じ系列 |
| RDS for PostgreSQL | `ap-northeast-1` で **16 系（〜16.15）と 17 系（〜17.9）** が使える。開発環境の Chatwoot は `pgvector/pgvector:pg16`、Umami は `postgres:15-alpine` |
| ElastiCache | **Valkey 7.2〜9.1** と **Redis OSS 4.0〜7.1** が使える |
| VPC | **デフォルト VPC（`172.31.0.0/16`）のみ。** 本設計の VPC は新規に作る |
| ECS | **クラスター 0 件** |
| **SES** | **サンドボックスのまま**（`ProductionAccessEnabled: false`。24 時間で 200 通、毎秒 1 通）。**顧客向けメールを送るには本番アクセスの申請が必須**（6 節） |

## 2. 図 1 全体構成（To-Be）

```mermaid
flowchart LR
    VIS["訪問者のブラウザ"] -->|"HTTPS と WebSocket"| ALB["ALB と WAF<br/>ホスト名で振り分け"]
    OPR["運用者"] -->|"Better Auth 経由で<br/>Google Workspace"| ALB
    ONP["オンプレ<br/>MCP と n8n"] -->|"API<br/>製品のトークン"| ALB
    ALB --> ECS["ECS on Fargate<br/>Mautic Chatwoot Umami"]
    ECS --> DB["RDS<br/>MySQL と PostgreSQL"]
    ECS --> KV["ElastiCache<br/>Valkey"]
    ECS --> FS["S3 と EFS"]
    ECS -->|"Webhook<br/>ngrok 経由"| ONP
```

図は To-Be を描いている。**As-Is ではこの図のリソースが 1 つも存在しない**（ECS クラスター 0 件。1 節）。

**入口は ALB 1 つで、3 種類の主体が入ってくる。** 訪問者（無認証。レート制限のみ）・運用者（Better Auth を IdP にした ALB の OIDC 認証）・オンプレのサーバー（製品側のトークン）である。TA-04 の 7 節が ngrok で解こうとしていた「要件が正反対の経路の同居」は、**ALB のリスナールールで経路ごとに分ける**形に置き換わる（5 節）。

## 3. 実行基盤（ECS on Fargate）

### 3.1 サービスとタスク

| システム | ECS サービス | 役割 | タスク数（4.6 で決定） | 開発環境での対応 |
|---|---|---|---|---|
| **Mautic** | `mautic-web` | 管理画面・API・フォーム受付・トラッキング | 1 | PHP ビルトインサーバー（`backend/mautic-system/dev/serve.sh`） |
| | `mautic-cron` | セグメント更新・キャンペーン実行・メールのキュー処理などの定期実行 | **1 に固定** | 手動実行 |
| **Chatwoot** | `chatwoot-web` | Rails（管理画面・API・ウィジェット・ActionCable） | 1 | `rails` サービス（`backend/chatwoot-system/docker-compose.yaml`） |
| | `chatwoot-worker` | Sidekiq | 1 | `sidekiq` サービス |
| **Umami** | `umami` | トラッカー配信・イベント受信・管理画面・API | 1 | `umami` サービス（`middleware/umami-master/docker-compose.yml`） |
| **管理画面の関門**（自作） | `admin-auth` | Better Auth。ALB に対する OIDC の IdP と、Google Workspace でのログイン（5.2） | 1 | 未作成（置き場所は `backend/admin-auth` を想定） |

- **`mautic-cron` は 1 タスクに固定する。** 2 つ動くとキャンペーンの実行やメールの送信が二重になる。オートスケールの対象にしない。
- **`mautic-web` を 2 タスク以上にするには、PHP のセッションを共有する必要がある。** Mautic の既定はファイルに保存するセッション（`app/config/config.php` の `session.handler_id` が `null`）であり、タスクをまたげない。当面は 1 タスクで運用し、増やすときにセッションの保存先（ElastiCache か RDS）を決める。
- **各サービスのタスク数は 1 で決定した**（単一構成。`R1` の 2026-09-18 の決定。4.6）。そのタスクがある AZ が障害を起こすと、そのサービスは別の AZ で起動し直すまで止まる。

### 3.2 コンテナイメージ

| システム | イメージ | 規則 |
|---|---|---|
| Chatwoot | 公式の `chatwoot/chatwoot` | **`latest` を使わず、バージョンのタグで固定する。** 開発環境の compose は `latest` のままであり、本番と開発でバージョンがずれうる |
| Umami | 公式の `ghcr.io/umami-software/umami` | 同上。**v3.4.0 以上に固定する**（API キーと `/mcp` が要る。5.4）。開発環境の compose は `latest`、取り込んだソースは **3.4.0**（2026-09-18 に取り込み直した） |
| Mautic | 公式イメージが 7.x を提供していればそれを使う。**無ければ `backend/mautic-system`（7.2.0）からビルドする** | 取り込んだソースと本番のバージョンを一致させる。**公式イメージの有無は本セッションで確認していない**（11 節） |

**イメージは ECR に置く。** Docker Hub から直接取得すると、取得回数の制限と、上流のタグの付け替えの影響を受ける。

### 3.3 DB の移行は、デプロイの前に 1 回だけのタスクで行う

**Chatwoot のエントリーポイントは DB の移行を行わない**（`.claude/CLAUDE.md` の記述と同じ）。本番でも同じで、新しいイメージを出す前に `bundle exec rails db:chatwoot_prepare` を**1 回だけの ECS タスク**（`RunTask`）として実行する。

- **移行を Web のタスクの起動処理に入れない。** タスクが複数起動すると移行が並行して走る。
- 移行が失敗したら、サービスのイメージを更新しない（古いイメージのまま動かし続ける）。
- Mautic（`doctrine:migrations:migrate`）と Umami も同じ扱いにする。Umami のイメージが起動時に自動で移行するかは、実装時に確認する（11 節）。

## 4. データストア

### 4.1 一覧

| ストア | 使うシステム | 構成（4.6 で単一構成に決定） | 開発環境での対応 |
|---|---|---|---|
| **RDS for MySQL 8.4** | Mautic | Single-AZ、自動バックアップ 7 日（ポイントインタイムリカバリ） | `mysql:8.4`（Docker） |
| **RDS for PostgreSQL 16** | Chatwoot・Umami・`admin-auth` | **1 インスタンスに 3 つのデータベース**（`chatwoot` / `umami` / `admin_auth`）。ユーザーもデータベースごとに分ける。Single-AZ、自動バックアップ 7 日 | Chatwoot は `pgvector/pgvector:pg16`、Umami は `postgres:15-alpine` |
| **ElastiCache（Valkey）** | Chatwoot（必須）・Mautic（キャッシュ。任意） | **ノードベース・クラスターモード無効**・1 ノード。転送中の暗号化（TLS）と AUTH を有効にする | `redis:alpine` |
| **S3** | Chatwoot（添付ファイル。Active Storage） | パブリックアクセスを全ブロック。バージョニング有効 | ローカルのディスク（`ACTIVE_STORAGE_SERVICE=local`） |
| **EFS** | Mautic（`media/` と設定ファイル） | `mautic-web` と `mautic-cron` の両方にマウントする | ホストのディレクトリ |

### 4.2 ElastiCache Serverless は使えない（重要）

**ElastiCache Serverless は常にクラスターモードで動き、クラスタープロトコルに対応したクライアントからしか使えない**（AWS の公式トラブルシューティングで確認）。**Chatwoot のジョブ実行基盤である Sidekiq は Redis のクラスターモードに対応していない**ため、Serverless を選ぶと Chatwoot のワーカーが動かない。

- **ノードベースのクラスターを、クラスターモード無効で作る。** 「Serverless のほうが運用が楽」という理由で選ばない。
- **Valkey を選ぶのは暫定である。** Redis OSS 7.1 より安いが、Chatwoot の公式ドキュメントは Redis を前提に書かれている。動作に問題が出たら、同じノードタイプのまま Redis OSS 7.1 に切り替える。
- **TLS を有効にすると URL が `rediss://` になる。** Chatwoot の `.env.example` には証明書の検証を緩める `REDIS_OPENSSL_VERIFY_MODE` があるが、**本番では使わない**（ElastiCache の証明書は検証できる）。

### 4.3 RDS for PostgreSQL を Chatwoot・Umami・`admin-auth` で共有する

**1 インスタンスにまとめるのは費用のためである**（RDS はインスタンス単位の固定費が大きい）。代わりに次を受け入れる。

- **片方の負荷がもう片方に響く。** Umami のイベント受信が急増すると Chatwoot の応答が遅くなりうる。
- **メンテナンスと障害が同時に来る。**
- **データベースとユーザーを分けて、権限は混ぜない。** Chatwoot のユーザーは `umami` データベースに接続できない。後から別インスタンスに分けるときは、データベース単位で移せる。
- **pgvector は `chatwoot` データベースでだけ有効にする**（`CREATE EXTENSION vector`）。Chatwoot は開発環境でも pgvector 入りのイメージを使っている。

### 4.4 Mautic のファイルは EFS に置く

Mautic は次のファイルをローカルのディスクに書く。Fargate のタスクのディスクはタスクが止まると消えるため、**`mautic-web` と `mautic-cron` で共有する EFS に置く。**

| パス | 中身 | EFS に置かない場合 |
|---|---|---|
| `media/images` | メールやランディングページに使う画像（`image_path`） | **配信済みのメールの画像が消える** |
| `media/files` | アセット（`upload_dir`） | ダウンロード資料が消える |
| `config/local.php` | 管理画面の設定画面から保存される設定 | **設定画面で変えた内容がタスクの再起動で消える** |

- **`var/cache` は EFS に置かない。** キャッシュは読み書きが多く、EFS に置くと遅くなる。タスクのローカルに置く。
- Mautic には S3 と連携するプラグイン（`plugins/MauticCloudStorageBundle` の Amazon S3 連携）があるが、**これはアセットの参照先を S3 にする機能で、`media/images` を S3 に移すものではない。** EFS を使う理由は変わらない。

### 4.5 バックアップ

| ストア | 手段 | 復旧できる範囲 |
|---|---|---|
| RDS（2 台） | 自動バックアップ 7 日 ＋ ポイントインタイムリカバリ | 7 日以内の任意の時点 |
| EFS | AWS Backup（日次） | 日次 |
| S3 | バージョニング | 削除・上書きの取り消し |
| ElastiCache | **取らない** | Chatwoot のキューに入っていたジョブは失われる。正本は RDS にあるため、会話そのものは失われない |

**訪問者が生んだデータ（`E-07` `E-09` `E-10`）の復旧が、運用担当者 1 人の手作業に依存しなくなる。** これが ADR-12 の理由の 1 つである（TA-01 の 9 節が挙げていた可用性の課題）。

### 4.6 可用性は単一構成にする（決定）

**`R1` が 2026-09-18 に単一構成で決定した。** 冗長化の費用を、事業の現在の規模では払わない。

| 要素 | 構成 | 障害時に起きること | 復旧 |
|---|---|---|---|
| RDS（2 台） | Single-AZ | その AZ の障害で DB が止まり、依存するサービスがすべて止まる | AZ の復旧を待つか、ポイントインタイムリカバリで別の AZ に新しいインスタンスを作る |
| ECS のタスク | 各サービス 1 | タスクの停止から ECS が起動し直すまで止まる | ECS が自動で起動し直す |
| ElastiCache | 1 ノード | Chatwoot のワーカーと ActionCable が止まる。キューのジョブは失われる | ノードの置き換えを待つ |
| NAT Gateway | 1 つ | タスクから外への送信（Webhook・メール・ECR）が止まる | AZ の復旧を待つ |

- **止まったことは CloudWatch のアラームから SNS で知らせる**（TA-05）。単一構成を選んだ以上、止まらないことではなく、**止まったことにすぐ気づけること**で補う。
- **見直す契機は、止まった時間の実績である。** 障害の記録（`E-12`）から、問い合わせを受け付けられなかった時間が許容できないと分かった時点で、Multi-AZ から順に冗長化する。

## 5. 経路の分離（ALB と WAF）

### 5.1 ホスト名

**ALB を 1 つにして、ホスト名で 3 つのシステムに振り分ける。** ALB は 1 台ごとに固定費がかかるため、システムごとに分けない。

| ホスト名（**2026-09-18 に確定**） | 振り分け先 | DD-02 の変数 |
|---|---|---|
| `chat.comegin.com` | `chatwoot-web` | `PUBLIC_CHATWOOT_BASE` |
| `mkt.comegin.com` | `mautic-web` | `PUBLIC_MAUTIC_BASE` |
| `stats.comegin.com` | `umami` | `PUBLIC_UMAMI_BASE` |
| `auth.comegin.com` | `admin-auth`（管理画面の関門。5.2.1） | —（公開ページには出さない） |

- **証明書は `ap-northeast-1` の ACM で発行する。** CloudFront（`us-east-1` 必須。TA-02）とは逆で、ALB に付ける証明書は ALB と同じリージョンのものでなければならない。
- **ホスト名は `R1` が 2026-09-18 に確定した。** Umami のホスト名とスクリプト名（`TRACKER_SCRIPT_NAME`）が広告ブロッカーに遮断されるかは、設置後に実測する（遮断されていればスクリプト名を変える）。
- **`comegin.com` のサブドメインにすることで、Cookie が同一サイトの扱いになる。** ngrok のドメインは公開サイトとは別のサイトであり、ブラウザのサードパーティ Cookie の制限を受ける（Chatwoot のウィジェットの会話の継続や Mautic のトラッキング Cookie が影響を受ける）。サブドメインに移すと、公開サイト（`comegin.com`）と同じサイトになる。
- **ホスト名は ngrok の固定ドメインと違い、再起動で変わらない。** `SITE_URL`・`PUBLIC_*_BASE`・`MCP_ALLOWED_HOSTS` を揃える作業（DD-02 の 1.1）は 1 回で済む。

### 5.2 3 種類の主体をリスナールールで分ける

TA-04 の 7 節のエンドポイント分離表を、**ALB のリスナールールと WAF でそのまま実現する。** 方針は許可リストで変わらない。**列挙したパスだけを ALB の認証なしで通し、それ以外はすべて管理者の認証を求める。**

| 優先度 | 条件 | 動作 | 対象 |
|---|---|---|---|
| 1 | 訪問者向けのパス（5.3 の表） | **認証・認可をしない。WAF のレート制限だけをかける** | 訪問者（ブラウザからの API 実行を含む） |
| 2 | 機械向けの API のパス（5.4 の表） | **ALB の認証なしで転送**。製品側のトークンで認証される。WAF のレート制限をかける | MCP サーバ・n8n |
| 3 | `auth.comegin.com`（`admin-auth` 自身） | **ALB の認証なしで転送**。WAF のレート制限をかける | 運用者（ログインの途中） |
| 4 | 上記以外のすべて | **ALB の `authenticate-oidc` で認証してから転送。IdP は `admin-auth`（Better Auth）** | 運用者（管理画面） |

- **優先度 4 を既定にする。** 列挙し損ねたパスは認証が必要な側に倒れ、「管理画面が開いてしまう」ではなく「訪問者向けの機能が動かない」という気づきやすい壊れ方になる（TA-04 の 7 節の許可リスト方式と同じ理由）。
- **訪問者側は認証も認可も行わない**（`R1` の 2026-09-18 の決定）。ウィジェット・フォーム・トラッカーは訪問者にログインを求められないため、守りは WAF のレート制限だけになる。**1 つの送信元から短時間に大量のリクエストが来ることだけを防ぐ**（5.5）。
- **送信元 IP による許可は採らない**（2026-09-18。オンプレの送信元 IP が固定ではないため）。機械向けの API は、製品側の認証と WAF のレート制限の 2 つで守る（5.4）。
- **管理画面の SPA が呼ぶ API は、優先度 2 か 4 で通る。** Chatwoot の管理画面が呼ぶ `/api/v1/accounts/*` は優先度 2 に当たるが、製品側のトークンを持って呼ぶため問題ない。

#### 5.2.1 管理者の認証は Better Auth で Google Workspace を使う（決定）

**`R1` が 2026-09-18 に決定した**（AA-05 の ADR-13。当初の案だった Amazon Cognito は採らない）。**Better Auth を OIDC の IdP として動かし、ALB の `authenticate-oidc` から参照する。** Better Auth 自身は Google Workspace の OIDC でログインさせる。

```mermaid
sequenceDiagram
    participant U as 運用者
    participant ALB as ALB
    participant BA as admin-auth<br/>Better Auth
    participant G as Google Workspace
    participant P as 管理画面
    U->>ALB: 管理画面を開く
    ALB->>BA: IdP の認可画面へ転送
    BA->>G: Google でログイン
    G-->>BA: ID トークン（hd と email）
    BA->>BA: ドメインと許可リストを検査
    BA-->>ALB: 認可コード
    ALB->>BA: トークンと UserInfo を取得
    ALB->>P: セッション Cookie を付けて転送
```

図は To-Be を描いている。**As-Is では `admin-auth` 自体が存在しない。**

| 項目 | 設定 | 理由 |
|---|---|---|
| Better Auth の構成 | **OAuth 2.1 Provider プラグイン**（`@better-auth/oauth-provider`）と JWT プラグイン。OIDC の探索メタデータ・認可・トークン・UserInfo のエンドポイントを持つ | ALB の `authenticate-oidc` が求める 3 つのエンドポイント（認可・トークン・UserInfo）をそろえる |
| ALB の登録 | **機密クライアント**（クライアントシークレットあり）。**信頼済みクライアントとして同意画面を省略する**（`skip_consent`） | 自社の管理画面に対して毎回「許可しますか」と聞く意味が無い |
| ログインの手段 | Better Auth の Google プロバイダー。Google Cloud の OAuth クライアントは**「内部」**（Workspace の組織内のアカウントだけ） | 組織外の Google アカウントは同意画面の段階で通らない（TA-04 の 8 節の GSC と同じ扱い） |
| ドメインの検査 | **ID トークンの `hd` クレームが `comegin.com` であることをサーバー側で検査する** | 認可リクエストの `hd` パラメータは画面の候補を絞るだけで、制限にはならない |
| 認可（誰を通すか） | **管理者の許可リスト**（`admin_auth` データベースに持つ）に載っている email だけを通す | Workspace のアカウントを持つことと、管理画面に入ってよいことは別である |
| MFA | **Google Workspace の 2 段階認証を組織で必須にする** | Better Auth 側では MFA を持たない。ログインの強さは Google 側で担保する |
| ALB のセッション | **12 時間**（43,200 秒） | 既定の 7 日では、端末を離れた後も長く通れてしまう。1 日の作業で 1 回のログインに収まる長さにする |
| ホスト名 | `auth.comegin.com`（同じ ALB。ACM の証明書に含める） | ALB の OIDC は、IdP の DNS が公開で名前解決でき、証明書が公的な認証局の発行であることを求める |

- **Better Auth は製品の SSO ではなく、製品の手前にかける関門である**（TA-04 の 6 節の「SSO を導入しない」判断とは別の層）。関門を通った後も、各製品のアカウントでログインする。
- **管理画面への通信は `admin-auth` を通らない。** `admin-auth` が関わるのはログインのときだけで、その後は ALB が自分のセッション Cookie で判定して製品に直接転送する。自作のコードをすべての管理操作の経路に挟まない。
- **`admin-auth` が止まると、新しいログインだけができなくなる。** ALB のセッションが残っている間は管理画面を使い続けられ、訪問者向けの機能には影響しない。
- **許可リストの追加と削除は BA-05 の参加時・離任時チェックリストに含める。** 離任時は Google Workspace のアカウントの停止と、許可リストからの削除の両方を行う。
- **ベンダーは増えない。** Google Workspace は既に使っており（GSC の OAuth。TA-04 の 8 節）、Better Auth はライブラリで、`admin-auth` は自作のサービスである。

### 5.3 訪問者向けに認証なしで通すパス（許可リスト）

**パスの一覧は製品のバージョンに依存する**（TA-04 の 7 節）。次の表は設計時点の想定であり、**実装時に各製品の実際のリクエストを DevTools で観測して確定する。**

| システム | パス（想定） | 用途 |
|---|---|---|
| Umami | `/script.js`（`TRACKER_SCRIPT_NAME` で変えた場合はその名前）、`/api/send` | トラッカーの配信とイベント受信（`I-05`） |
| Chatwoot | `/packs/*`、`/widget*`、`/api/v1/widget/*`、`/cable`、`/rails/active_storage/*` | ウィジェットの配信・会話 API・WebSocket・添付ファイル（`I-07`） |
| Mautic | `/form/submit*`、`/mtc.js`、`/mtc/event`、`/mtracking.gif` | フォーム受付とトラッキング（`I-08`） |
| Mautic | `/email/*`、`/r/*`、`/media/images/*` | **配信したメール**の開封計測・クリック計測・配信停止・画像。**訪問者だけでなく、メールの受信者も無認証で到達する** |

- **`/cable` は訪問者と運用者の両方が使う。** Chatwoot のウィジェットと管理画面は同じ WebSocket のエンドポイントを使うため、無認証で通し、製品側の認証に任せる。
- **Mautic の `/api/*` と `/oauth/*` は訪問者向けに含めない。** 機械向けの API（5.4）として扱う。

### 5.4 機械向けの API（ALB の認証なしで通すパス）

**オンプレの MCP サーバと n8n はブラウザでのログインができない**ため、API のパスは管理者の認証の外に置く。代わりに次の 2 つで守る。

| システム | パス（想定） | 製品側の認証 | 開けるか |
|---|---|---|---|
| Chatwoot | `/api/v1/accounts/*`、`/api/v2/accounts/*` | `api_access_token`（ユーザーに紐づく） | **開ける**（`chatwoot-mcp`、n8n の `I-17` `I-19`） |
| Mautic | `/api/*`、`/oauth/v2/token` | OAuth2 client_credentials | **開ける**（`mautic-mcp`、n8n） |
| Umami | **`/mcp` だけ**（Umami 自身の MCP エンドポイント。`MCP_ENABLED=1` で有効にする） | **API キー**（Umami の設定画面で発行。Bearer で送る） | **開ける**（Umami MCP。下記） |

- **パスの一覧は実装時に MCP サーバの `resources.ts` と照合して確定する**（5.3 と同じく、製品のバージョンに依存する）。
- **パスワードで入れる API を管理者の認証の外に出さない。** Mautic の API の Basic 認証（`api_enable_basic_auth`）は既定の無効のままにする。有効にすると、`/api/*` がパスワード総当たりの入口になる。Chatwoot のパスワードログイン（`/auth/sign_in`）は優先度 4（管理者の認証の内側）に残る。
- **Umami MCP は本番の自前の Umami に接続する**（`R1` の 2026-09-18 の決定。計測データの置き場所は自前の Umami に寄せ、Umami Cloud は使わない）。**Umami は v3.4.0（2026-09-17 公開）から、自前で動かす場合にも API キーと MCP のエンドポイント（`/mcp`）を持つ。** そこで、Umami の機械向けのパスは **`/mcp` の 1 本だけ**を開け、`/api/*` は開けない。
  - **パスワードでログインする口（`/api/auth/login`）は管理者の認証の内側に残る。** API キーは Umami の設定画面で発行し、失効もそこで行える。
  - **API キーは閲覧専用のユーザーで発行する。** Umami の MCP のツールは読み取り専用で、キーの持ち主の権限の範囲でしか見えない。
  - **本番の Umami は v3.4.0 以上に固定する。** 取り込み済みのソース（`middleware/umami-master`）は **2026-09-18 に上流の v3.4.0 へ取り込み直した**（それまでの 3.3.1 には API キーも `/mcp` も無かった）。開発環境でも API キーと `/mcp` を試せる。
  - 旧版は「自前の Umami には API キーの仕組みが無い」として Umami の API を開けないとしていたが、**3.4.0 で前提が変わったため撤回する。**
- **WAF のレート制限を機械向けの API にかける。** 送信元 IP で絞れないため、総当たりや乱用に対する防御はレート制限だけになる。トークンが漏れた場合の被害は製品側の権限の範囲に限られる（Chatwoot のトークンは発行したユーザーの権限、Mautic は API クライアントの権限。TA-04 の 1 節）。

### 5.5 WAF

**ALB に WAF の WebACL を関連付ける。** 内容は TA-02 の CloudFront 側と同じ方針（マネージドルールとレート制限）にする。**訪問者向けのパス（5.3）には、認証の代わりにレート制限を必ずかける。** 訪問者側の守りはこれだけである（5.2）。

- **CloudFront のフラットレートプランは ALB に付けた WAF を含まない。** WebACL・ルール・リクエスト数に応じて課金される（9 節）。
- **機械向けの API（5.4）にもレート制限をかける。** 送信元 IP で絞らないため、この経路の防御は製品側の認証とレート制限の 2 つだけになる。
- **Mautic のフォーム受付（`/form/submit*`）にレート制限をかける。** 無認証で開いている唯一の書き込み口であり、スパムの投稿がそのまま `E-09` を汚す（DD-01 の 6.3 の冪等キーは二重送信を畳むが、別々の偽の送信は防げない）。

### 5.6 ネットワーク

| 要素 | 配置 | 規則 |
|---|---|---|
| VPC | 新規（デフォルト VPC は使わない） | 2 つの AZ に public / private のサブネットを 1 つずつ |
| ALB・NAT Gateway | public サブネット | ALB はインターネットから 443 のみ受ける |
| Fargate のタスク・RDS・ElastiCache・EFS | **private サブネット** | タスクは ALB からだけ、RDS・ElastiCache・EFS はタスクのセキュリティグループからだけ受ける |
| NAT Gateway | 1 つ（単一 AZ。4.6 で決定） | タスクからインターネットへの送信（n8n への Webhook、SES、ECR など）に使う |
| VPC エンドポイント | S3（ゲートウェイ型。無料） | S3 への通信を NAT Gateway に通さない |

- **DB と ElastiCache をインターネットに面させない。** 運用者が DB に入る必要があるときは、踏み台サーバーを置かず、ECS Exec か Session Manager のポートフォワードを使う。
- **NAT Gateway は固定費がかかる。** 単一 AZ にするのは費用のためであり（4.6 で決定）、その AZ が落ちるとタスクから外への送信（Webhook・メール）が止まる。

## 6. 顧客向けメール（Amazon SES）

**Mautic と Chatwoot のメールは、SES の SMTP インターフェースから送る。** 開発環境はこれまでどおり MailHog に送る。

| 項目 | 内容 |
|---|---|
| 送るもの | Mautic のメール配信（キャンペーン・フォームの自動返信）、Chatwoot のメール（通知・メールでの返信） |
| 送信元ドメイン | `comegin.com`（Route 53 のホストゾーンに DKIM・SPF・DMARC を登録する） |
| 認証 | SES の SMTP 認証情報（Mautic と Chatwoot で別々に発行する） |
| **本番アクセス** | **現在はサンドボックス**（1 節）。検証済みの宛先にしか送れず、24 時間で 200 通まで。**本番で顧客に送る前に申請が必要**で、申請には配信停止と苦情の扱いの説明が求められる |

- **社内向けの通知は SES に載せない。** 通知は SNS に集約する決定（ADR-08）を変えない。SES は顧客向けで、SNS は社内向けである。
- **Mautic のメール送信は BA-05 で `承認`（`R3`）に分類されている。** SES に移ってもこの分類は変わらない。SES はメールを運ぶ手段であり、送るかどうかの判断はこれまでどおり承認ゲートを通る。
- **バウンスと苦情を Mautic に返す経路が要る。** 返さないと、届かない宛先に送り続けて SES の送信停止の基準に近づく。SES のイベント（SNS 経由）を Mautic の配信停止に反映する方法は 11 節に上げる。

## 7. 秘密値

| 秘密値 | 置き場所 | 渡し方 |
|---|---|---|
| RDS のマスターパスワード | Secrets Manager（**RDS に管理させる**） | タスクには渡さない。アプリ用のユーザーを別に作る |
| アプリ用の DB パスワード・ElastiCache の AUTH トークン・SES の SMTP 認証情報 | Secrets Manager | タスク定義の `secrets` で環境変数として注入する |
| **暗号化の鍵**（Chatwoot の `SECRET_KEY_BASE`・`ACTIVE_RECORD_ENCRYPTION_*`、Umami の `APP_SECRET`、Mautic の `secret_key`、`admin-auth` の `BETTER_AUTH_SECRET`） | Secrets Manager | 同上 |
| `admin-auth` の Google の OAuth クライアントシークレット／ALB 用のクライアントシークレット | Secrets Manager（後者は ALB のリスナールールにも設定する） | 前者はタスクに注入する。後者は ALB と `admin-auth` の両方が知る必要がある |
| S3 への権限 | **タスクロール**（IAM ロール） | アクセスキーを発行しない |

- **開発環境の値を本番で使い回さない。** `dev/init-env.sh` が生成した値は開発機の中だけで使う。
- **暗号化の鍵を失うと、既存のデータを復号できなくなる**（`.claude/CLAUDE.md` の Docker スタックの共通方針と同じ）。Secrets Manager の値を消したり作り直したりしない。削除には復旧期間を設定する。
- **Chatwoot の S3 をタスクロールで使えるかは実地で確認する。** Chatwoot の `.env.example` は `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` を前提に書かれている。空にしたときに SDK の既定の認証情報の探索（タスクロール）に倒れるかを、実装時に確かめる（11 節）。倒れない場合でも、アクセスキーは対象のバケットにだけ権限を持つ専用の IAM ユーザーで発行する。
- 設計の詳細（ローテーション・権限の範囲）は TA-04 の 1 節に従う。

## 8. デプロイ

| # | 手順 | 内容 |
|---|---|---|
| 1 | イメージの用意 | 固定したバージョンのイメージを ECR に置く（3.2） |
| 2 | DB の移行 | 1 回だけのタスクで移行を実行する（3.3）。失敗したら 3 に進まない |
| 3 | サービスの更新 | ECS サービスのタスク定義を新しいリビジョンに更新する（ローリング更新） |
| 4 | 確認 | 5.3 の訪問者向けのパスが無認証で 200 を返すこと、5.4 の API がトークン無しでは製品側で 401 になること、管理画面のパスが `auth.comegin.com` を経由して Google のログインに転送されること |

- **4 の確認をデプロイごとに行う。** 製品を更新すると訪問者向けのパスが変わりうる（5.3）。パスが変わると、許可リスト方式ではその機能が止まる側に倒れる（管理画面が開く側には倒れない）。
- **デプロイは運用者が実行する。** エージェントに ECS・RDS の変更権限を渡さない（TA-02 のデプロイ用 IAM と同じ理由で、BA-05 の `禁止` 分類「エージェントが自分の権限や実行条件を変える操作」に到達させない）。
- **IaC を使うかは TA-02 の 9 節の未決定事項と一体で決める。** 本ファイルの構成は要素が多く、手作業で作ると TA-05 の構成管理の「管理外」が一気に増える。

## 9. 費用

**見積もりは未実施である。** 固定費がかかる要素だけを列挙する。

| 要素 | 課金の単位 | 備考 |
|---|---|---|
| ALB | 時間 ＋ LCU | 1 台に集約する（5.1） |
| WAF（ALB 用） | WebACL・ルール・リクエスト数 | **CloudFront のフラットレートプランの対象外** |
| Fargate | vCPU と メモリの時間 | 6 サービス（3.1。`admin-auth` を含む） |
| RDS | インスタンスの時間 ＋ ストレージ ＋ バックアップ | 2 台（MySQL・PostgreSQL） |
| ElastiCache | ノードの時間 | 1 ノード |
| NAT Gateway | 時間 ＋ 処理したデータ量 | 1 つ |
| EFS・S3 | 保存量 | 小さい |
| SES | 送信数 | Mautic の配信量に比例する |
| Secrets Manager | シークレット数 | 約 10 個 |
| CloudWatch のアラーム・カスタムメトリクス | アラーム数・メトリクス数 | ハートビート（TA-05）と AWS 側の監視 |
| CloudWatch Logs | 取り込み量と保存量 | タスクのログ |

**これまでの AWS の費用は CloudFront のフラットレート Free（$0/月）と SNS の無料枠だけだった。** ADR-12 によって、事業の規模にかかわらず毎月の固定費が発生するようになる。見積もりは AWS の料金 API で行い、ADR-12 の「覆すのに必要な根拠」（固定費が規模に見合わない）の判断材料にする。

## 10. 開発環境との対応

| 要素 | 開発環境（ローカル） | 本番（AWS） |
|---|---|---|
| 実行 | Docker compose ／ PHP ビルトインサーバー | ECS on Fargate |
| MySQL | `mysql:8.4` | RDS for MySQL 8.4 |
| PostgreSQL | `pgvector/pgvector:pg16`、`postgres:15-alpine` | RDS for PostgreSQL 16（共有） |
| Redis | `redis:alpine` | ElastiCache（Valkey、クラスターモード無効） |
| ファイル | ホストのディスク | S3（Chatwoot）・EFS（Mautic） |
| メール | MailHog | SES（顧客向け）・SNS（社内向け。ADR-08） |
| 入口 | `127.0.0.1` ＋ ngrok | ALB ＋ WAF ＋ `admin-auth`（Better Auth） |
| 秘密値 | `dev/init-env.sh` が作る環境変数ファイル | Secrets Manager |

**差が大きいのは「入口」と「Redis のクラスターモード」である。** 入口は 5 節の許可リストが開発環境には無いため、パスの漏れは本番で初めて見つかる。Redis はローカルで動いても ElastiCache Serverless では動かない（4.2）。

## 11. 未決定事項

- **`admin-auth` の実装と置き場所。** 自作のコードになる（`.claude/CLAUDE.md` の自作コードの一覧に加わる）。置き場所は `backend/admin-auth`、開発環境のポートは 3103（TA-01 の 5 節の表で空いている番号）を想定する。**Better Auth の OAuth 2.1 Provider と ALB の組み合わせを実地で確認していない**（トークンエンドポイントのクライアント認証方式が ALB と合うかなど）。判断者 `R1`。
- **Umami MCP の接続設定の付け替え。** 現在のローカルの MCP 設定は Umami Cloud 用の API キーだけで動いており、Umami Cloud にはサイトが 1 件も無い（2026-09-18 に確認）。本番の Umami を立てた後、接続先を `https://stats.comegin.com/mcp`（API キーは閲覧専用のユーザーで発行）に付け替える。**付け替えるまで、エージェントは訪問者のデータを読めない。**
- **Mautic の公式イメージが 7.x を提供しているか。** 3.2。無ければ取り込み済みのソースからイメージを作る作業が増える。
- **Umami のイメージが起動時に DB を自動で移行するか。** 3.3。
- **Chatwoot の S3 をタスクロールで使えるか。** 7 節。
- **SES の本番アクセスの申請と、バウンス・苦情を Mautic に返す経路。** 6 節。申請は顧客にメールを送る前に済ませる必要があり、BA-04 のトスアップ（フォームの自動返信）を始める前提になる。
- **費用の見積もり。** 9 節。
- **IaC の選定。** TA-02 の 9 節と一体で決める。

### 2026-09-18 に決まったこと

| 項目 | 決定 | 節 |
|---|---|---|
| オンプレの送信元 IP による許可 | **採らない**（IP が固定ではない）。機械向けの API は製品側の認証と WAF のレート制限で守る | 5.2・5.4 |
| 管理画面の関門 | **Better Auth（`admin-auth`）を IdP にした ALB の OIDC 認証。ログインは Google Workspace**（当初案の Cognito は採らない。ADR-13） | 5.2.1 |
| 訪問者側の守り | **認証・認可をしない。WAF のレート制限だけ** | 5.2・5.5 |
| ホスト名 | **`chat.` / `mkt.` / `stats.comegin.com` で確定** | 5.1 |
| 可用性 | **単一構成**（RDS は Single-AZ、タスクは 1、NAT Gateway は 1、ElastiCache は 1 ノード） | 4.6 |
| Umami MCP の接続先 | **自前の Umami（本番は AWS）の `/mcp`**。Umami Cloud は使わない。機械向けに開けるのは `/mcp` だけ | 5.4 |
| 取り込み済みの Umami | **上流の v3.4.0 に取り込み直した**（無改変。3.3.1 と差分が無いことを確認してから置き換えた） | 3.2・5.4 |
| オンプレの全滅の検知 | **CloudWatch のアラームから SNS へ直接送る**（オンプレからのハートビートが途絶えたら通知。TA-05） | — |
