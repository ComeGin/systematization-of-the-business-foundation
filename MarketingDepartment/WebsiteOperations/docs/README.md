# エンタープライズアーキテクチャ

SaaS 販売事業の「事業経営基盤」を、再帰的自己改善型のシステムとして構築するためのアーキテクチャ文書。
リポジトリルートの `README.md` が事業スキームの原典で、この文書群はそれを 4 層に分解して整合を取ったものである。

対象範囲はマーケティング部門の Web サイト運用・SEO 対策（`MarketingDepartment/WebsiteOperations`）。

> **（2026-10-05）配置の基準が変わった（[ADR-21](RequirementDefinition/AA/05-application-decisions.md)）。** 再帰的自己改善の仕組み（**Strapi・n8n**・監視アプリ・MCP・ビルド）はオンプレ、成果物（Astro・Mautic・Chatwoot・Umami）はクラウド、データの置き場（RDS・ElastiCache・S3）は AWS。`consent-api`・Cal.com・`admin-auth` はクラウドに置く例外。オンプレと VPC は小さな EC2 の WireGuard でつなぐ。**下の表や本文の「Strapi・n8n は AWS（ADR-16）」は、ADR-21 の前の記述である。**

## この文書群の読み方

4 層は **BA → DA → AA → TA** の順で依存する。逆順に読むと「ツールありき」になり、なぜその構成なのかが追えない。

| 層 | 問い | 決めること |
|---|---|---|
| **BA** Business Architecture | 誰が何をするか | 役割、ケイパビリティ、業務プロセス、承認ゲート |
| **DA** Data Architecture | 何を測り、何を貯めるか | エンティティ、指標の定義、正本の所在、個人情報の扱い |
| **AA** Application Architecture | どのアプリ／エージェントが担うか | 連携点、エージェントの権限、改善ループの制御仕様 |
| **TA** Technology Architecture | どこで動かすか | 配置、トリガー、秘匿値、監視 |

**As-Is と To-Be を必ず書き分けている。** 表の「状態」列は次の 3 値を取る。

- `実装済み` — 現に動いている
- `未配線` — 部品はあるが繋がっていない
- `未着手` — 部品から無い

図はすべて To-Be を描いている。**現状がどこまで通っているかは、図の直下の注記と表の「状態」列で確認する**（図と表の両方に状態を書くと二重管理になり、片方だけ更新されて食い違うため、状態の正本は表に置いた）。

## 索引

### BA — Business Architecture

| ファイル | 内容 |
|---|---|
| [BA/01-business-model.md](RequirementDefinition/BA/01-business-model.md) | 事業目的、バリューストリーム、KPI ツリー |
| [BA/02-capability-map.md](RequirementDefinition/BA/02-capability-map.md) | ケイパビリティマップ、外注 → 内製の対応 |
| [BA/03-roles-and-raci.md](RequirementDefinition/BA/03-roles-and-raci.md) | 役割定義の正規化、RACI |
| [BA/04-business-processes.md](RequirementDefinition/BA/04-business-processes.md) | 更新ワークフロー、PDCA、キーワード＆CV 設計 |
| [BA/05-governance.md](RequirementDefinition/BA/05-governance.md) | SSO、権限、担当者変更、**承認ゲートの一覧** |

### DA — Data Architecture

| ファイル | 内容 |
|---|---|
| [DA/01-conceptual-data-model.md](RequirementDefinition/DA/01-conceptual-data-model.md) | 概念データモデル、**`E-13` の型定義**、**`E-16 Booking`（面談の予約。2026-10-01 に追加）**、**`cta_type` の値（2026-10-01 に改名）** |
| [DA/02-metrics-and-kpi.md](RequirementDefinition/DA/02-metrics-and-kpi.md) | CVR の定義（**CTA 2 種。`CVR-consult` / `CVR-source-dl`**）、指標一覧、**CTA とフォームと予約の計測イベント**、データ契約 |
| [DA/03-identity-resolution.md](RequirementDefinition/DA/03-identity-resolution.md) | ID 統合、匿名から実名への昇格 |
| [DA/04-data-flow.md](RequirementDefinition/DA/04-data-flow.md) | データフロー、System of Record |
| [DA/05-data-governance.md](RequirementDefinition/DA/05-data-governance.md) | 個人情報の区分、保持期間、`sanitize()` |

### AA — Application Architecture

| ファイル | 内容 |
|---|---|
| [AA/01-application-landscape.md](RequirementDefinition/AA/01-application-landscape.md) | C4 コンテキスト／コンテナ図、アプリ一覧 |
| [AA/02-integration-architecture.md](RequirementDefinition/AA/02-integration-architecture.md) | 連携点カタログ、露出経路の 2 分類、**着手順** |
| [AA/03-agent-architecture.md](RequirementDefinition/AA/03-agent-architecture.md) | **エージェント 12 本の設計と権限** |
| [AA/04-recursive-improvement-loop.md](RequirementDefinition/AA/04-recursive-improvement-loop.md) | **改善ループの制御仕様、安全装置、暴走条件** |
| [AA/05-application-decisions.md](RequirementDefinition/AA/05-application-decisions.md) | 適用判断の記録（ADR-01〜20。**ADR-19 面談の予約（Cal.com）をセルフホストし、同意の受け口（`consent-api`）も ALB 配下の ECS に置く・予約が成立したら訪問者を Google Calendar の予定に招待する（氏名・メール・日時が Google LLC に渡る）・SaaS 依存の基準と配置の基準はどちらも変えない**、**ADR-09 OpenSEO の採用と GSC の統合、ADR-10 OpenSEO の MCP と費用の上限、ADR-11 Strapi の画像をビルド時に `dist/` へ取り込む、ADR-12 訪問者が触れるシステムを AWS に置く、ADR-13 管理画面の関門を Better Auth（Google Workspace）で作る、ADR-14 本番はクラウド・オンプレは開発環境と管制、ADR-15 ローカルの Claude Code が MCP で本番の Mautic・Chatwoot・Umami も読み書きする・配信は人間の承認（Strapi をオンプレだけにした部分は ADR-16 で置き換え）、ADR-16 正本のデータを持つシステム〈Astro・Strapi・Mautic・Chatwoot・Umami・n8n〉はすべてクラウド、ローカルには道具だけ・ビルドは本番の Strapi を読む・顧客への送信は許可・本番は `read_write` で確定・PostHog は開発と本番で分ける・設定はそろえ続ける、ADR-17 エージェントの定期実行は監視アプリ（ローカル）から起動し `I-13` の起票もローカルへ（ADR-05 の一部を置き換え）・Chatwoot の社内メモと顧客への送信を分ける・`strapi-prod` は下書きまでで記事の公開は `R2` が管理画面で行う・誤った書き込みはエージェント専用ユーザーの送信の記録で突き合わせる、ADR-18 `E-15 AgentRun` の正本を監視アプリ（ローカル）の実行記録にする（ADR-16 の基準の唯一の例外）・本番の n8n に登録する Strapi の資格情報も下書きまで・記録は要約と ID だけで S3 に追記専用で写す・定期実行の定義は Git で持ち承認済みの `main` を読む**、**ADR-20 マネタイズモデル: 利用者の自前サーバでの採掘（XMRig → unMineable〈SaaS〉で POL に変換し ComeGin へ）と譲渡不可ポイントの付与（thirdweb〈SaaS〉）・AWS では採掘しない・本システムの完成後に着手し承認ゲート G-1〜G-3 が前提（2026-10-03）**） |

### TA — Technology Architecture

| ファイル | 内容 |
|---|---|
| [TA/01-deployment-topology.md](RequirementDefinition/TA/01-deployment-topology.md) | 配置境界（**正本のデータを持つ本番〈Astro・Strapi・Mautic・Chatwoot・Umami・n8n〉は AWS、ローカルは道具〈Claude Code・MCP サーバ・監視アプリ・OpenSEO・Lighthouse CI・ビルド〉と全システムの開発環境**。ADR-16）、ポート割当、境界越え通信、**利用者環境（採掘。2026-10-03）** |
| [TA/02-aws-product-delivery.md](RequirementDefinition/TA/02-aws-product-delivery.md) | Astro の AWS 構成、Cloudflare 代替、**ビルドはローカルで本番の Strapi を読み、配信は人間の承認**（ADR-15・ADR-16） |
| [TA/03-triggers-and-cicd.md](RequirementDefinition/TA/03-triggers-and-cicd.md) | トリガー 4 系統、n8n の Git 管理外問題 |
| [TA/04-security-and-secrets.md](RequirementDefinition/TA/04-security-and-secrets.md) | 秘匿値（本番は Secrets Manager）、**経路分離（本番は ALB。Webhook は VPC の中。ngrok は Astro dev サーバーの共有だけ。ADR-16）**、MCP の権限、**OpenSEO と GSC の OAuth** |
| [TA/05-observability-and-ops.md](RequirementDefinition/TA/05-observability-and-ops.md) | 監視、バックアップ、構成管理 |
| [TA/06-aws-runtime.md](RequirementDefinition/TA/06-aws-runtime.md) | **Strapi・Mautic・Chatwoot・Umami・n8n・Cal.com・同意の受け口の本番実行環境**（ECS on Fargate、RDS・ElastiCache・S3・EFS、ALB の経路分離、SES。**Strapi と n8n は ADR-16 で追加。n8n のサンドボックスは置かない。ADR-18 で監視アプリの実行記録〈`E-15`〉の写しの S3〈追記専用〉を追加。2026-10-01 に `calcom`〈Cal.com をセルフホスト〉と `consent-api`〈Cookie 同意の受け口〉を追加**。**`points-api` と `E-19` の写しの S3（Object Lock）。2026-10-03**） |
| [TA/07-onprem-control-plane.md](RequirementDefinition/TA/07-onprem-control-plane.md) | **オンプレの管制環境**（全システムの開発環境、**監視アプリ（Next.js）**、Claude Code への指示の経路、**MCP の開発用と本番用の登録**、本番への作用の経路、**開発環境と本番をそろえ続ける手順、誤った書き込みの検知、エージェントの定期実行、実行記録（`E-15` の正本）**。ADR-14・ADR-15・ADR-16・ADR-17・ADR-18） |

### 詳細設計（`DetailedDesign/`）

上の 4 層が「何を作るか」を決めたのに対し、**連携点 `I-01`〜`I-30` とループ 6 段階を実装着手できる粒度まで下ろした**もの。AA-02 のカタログと AA-04 の制御仕様が入口にあたる。

| ファイル | 内容 |
|---|---|
| [DetailedDesign/README.md](DetailedDesign/README.md) | 索引、連携点とファイルの対応、**詳細設計の完成度** |
| [DetailedDesign/01-flow-specification-rules.md](DetailedDesign/01-flow-specification-rules.md) | **横断規約。** 相関 ID、失敗分類 9 値、リトライ、冪等キー、タイムアウト、`E-13` の状態遷移 |
| [DetailedDesign/02-public-path-flows.md](DetailedDesign/02-public-path-flows.md) | 公開経路（ブラウザ発信の **5 本 ＋ 同意の受け口**。**2026-10-01 に `I-25`〈Cal.com の予約〉と同意の受け口を追加**） |
| [DetailedDesign/03-operation-path-flows.md](DetailedDesign/03-operation-path-flows.md) | 運用経路（エージェント発信の 5 本。**OpenSEO の MCP を含む**） |
| [DetailedDesign/04-server-to-server-flows.md](DetailedDesign/04-server-to-server-flows.md) | サーバ間通知の 9 本（**DataForSEO への問い合わせとサイト監査を含む**） |
| [DetailedDesign/05-build-and-delivery-flows.md](DetailedDesign/05-build-and-delivery-flows.md) | ビルドと配信の 3 本 |
| [DetailedDesign/06-proposal-loop-flows.md](DetailedDesign/06-proposal-loop-flows.md) | 提案と承認、**起票前チェックリスト 14 項目** |
| [DetailedDesign/07-failure-and-degradation.md](DetailedDesign/07-failure-and-degradation.md) | 異常系、縮退運転、**暴走条件 13 件と検出手段の対応** |
| [DetailedDesign/08-monetization-flows.md](DetailedDesign/08-monetization-flows.md) | **（2026-10-03 に追加）収益化の 5 本**（`I-26`〜`I-30`）、`E-19` の状態遷移、月次の締め |

**実装状態（`実装済み` / `未配線` / `未着手`）の正本はこの 4 層側にあり、詳細設計層では繰り返さない。** 詳細設計層は「仕様が確定しているか」という別の軸（`仕様確定` / `条件付き` / `前提待ち`）で状態を持つ。

## 層間トレーサビリティ

この表が EA 全体の**目次でありチェックサム**である。ある Capability に対応する役割・データ・アプリ・基盤のいずれかが空欄なら、そこが設計漏れになる。

| Capability | 主担当 | 主なデータ | アプリケーション | 基盤 | 状態 |
|---|---|---|---|---|---|
| `CAP-01` 事業戦略・KPI 管理 | `R2` | `E-12` 指標 | Umami + PostHog + Mautic | AWS（Umami・Mautic の本番。ADR-12）+ SaaS | `未配線` |
| `CAP-02` キーワード戦略 | `R2` | `E-01` `E-02` | Strapi `api::keyword.keyword` ＋ **OpenSEO**（調査） | **AWS（Strapi。ADR-16）**＋ オンプレ（OpenSEO）＋ DataForSEO | `未配線` |
| `CAP-03` コンテンツ企画 | `R2` | `E-03` | Strapi `api::content-plan.content-plan` | **AWS（Strapi。ADR-16）** | `未着手` |
| `CAP-04` コンテンツ制作 | `R4` | `E-04` | **監視アプリ（Next.js）→** Claude Code + strapi-mcp（本番は `strapi-prod`。**記事の正本は本番の Strapi**。ADR-16。**エージェントは下書きまで**。ADR-17） | **AWS（Strapi。ECS + RDS + S3。TA-06）**＋ オンプレ（監視アプリ。TA-07） | `未配線` |
| `CAP-05` デザイン制作 | `R1` | `E-05` `E-06` | Astro + shadcn/ui + Tailwind v4 | ビルド時 | `未配線` |
| `CAP-06` 品質保証・承認 | `R2` | `E-14` | Lighthouse CI + GitHub の PR レビュー | ローカル + GitHub | `未配線` |
| `CAP-07` コンテンツ公開・配信 | `R1` | `E-04` `E-05` | Strapi の `publishedAt`（**`R2` が本番の管理画面で公開**。ADR-17）+ Astro 再ビルド（ローカル。本番の Strapi を読む。**監視アプリの定期実行が公開を見つけて起こす**。ADR-17。案）＋ **人間の承認で配信**（ADR-15・ADR-16） | AWS（Strapi）＋ オンプレ（ビルド・監視アプリ）＋ AWS S3 + CloudFront | `未着手` |
| `CAP-08` エッジ配信・可用性 | `R1` | `E-05` | CloudFront（Cloudflare の代替） | AWS | `未着手` |
| `CAP-09` テクニカル SEO | `R1` | `E-12` | Lighthouse CI + Astro ＋ **OpenSEO**（GSC・サイト監査） | ローカル ＋ Google | **`実装済み`**（Lighthouse のみ。GSC は未接続） |
| `CAP-10` 行動観測・効果測定 | `R3` | `E-07` `E-08` `E-12` | Umami（母数）+ PostHog（行動）＋ **`consent-api`**（Cookie 同意の受け口。**PostHog と Chatwoot は同意後にだけ動く**。2026-10-01） | **AWS**（ECS + RDS + **ElastiCache**〈同意の記録〉+ ALB。TA-06）+ SaaS | `未着手` |
| `CAP-11` リード獲得・育成 | `R3` | `E-06` `E-09` | Mautic + mautic-mcp + **Amazon SNS**（通知）+ **Amazon SES**（顧客向けメール） | **AWS**（ECS + RDS + EFS + ALB、n8n。Webhook は VPC の中。TA-06・ADR-16）＋ オンプレ（MCP） | `未配線` |
| `CAP-12` Web 接客 | `R3` | `E-10` **`E-16`** | Chatwoot + chatwoot-mcp + **Amazon SNS**（通知）＋ **Cal.com**（セルフホスト。オンライン面談の予約。商談プロセスの段 2。2026-10-01） | **AWS**（ECS + RDS + ElastiCache + S3 + ALB、n8n、**calcom**。Webhook は VPC の中。TA-06・ADR-16）＋ オンプレ（MCP） | `未配線` |
| `CAP-13` 監視・障害対応 | `R1` | `E-12` | PostHog（Error Tracking） + **Amazon SNS**（障害通知）+ CloudWatch（本番の AWS 側）+ **監視アプリ（表示。TA-07）** | SaaS + healthcheck + AWS + オンプレ（監視アプリ） | `未配線` |
| `CAP-14` 改善提案の生成と承認 | `R2` | `E-13` `E-14` `E-15` | Git / GitHub ＋ **監視アプリ**（エージェントの定期実行と `I-13` の起票の起動元。ADR-17。**実行記録が `E-15` の正本**。ADR-18） | GitHub ＋ オンプレ（監視アプリ。**`E-15` の正本がローカルにある**。ADR-18） | `未着手` |
| `CAP-15` ガバナンス・アクセス管理 | `R1` | **未定義**（下記参照） | MCP の `ACCESS_LEVEL` と `MCP_AUTH_TOKEN` | 各システム個別 | `実装済み`（MCP 側のみ） |
| `CAP-16` 戦略知見の獲得 | `R2` | `E-01` `E-03` `E-12`（`source: market`。知見メモは**未定義**） | Claude Code ＋ **OpenSEO**（競合・SERP） | Git（`docs/knowledge/`）＋ DataForSEO | `未配線` |
| `CAP-17` 計算資源の受け入れ（採掘）（2026-10-03 に追加） | `R1` | `E-17` `E-18` `E-20` | miner（XMRig。利用者環境）＋ **unMineable**（SaaS）＋ points-api | **利用者環境**（採掘）＋ AWS（points-api。**AWS では採掘しない**）＋ SaaS | `未着手`（**承認ゲート G-1〜G-3 が前提**） |
| `CAP-18` ポイントの付与と消化（2026-10-03 に追加） | `R1` | `E-19` `E-20` | points-api ＋ **thirdweb**（SaaS）＋ Polygon PoS | AWS（ECS + RDS + **S3 Object Lock**）＋ SaaS ＋ 公開チェーン | `未着手`（同上） |

ロール（`R1` Web マスター / `R2` SEO ディレクター / `R3` データアナリスト / `R4` コンテンツエディター）の定義は [BA/03](RequirementDefinition/BA/03-roles-and-raci.md)、エンティティ（`E-01`〜`E-15`、2026-10-01 に DA-01 で追加した **`E-16 Booking`**、2026-10-03 に追加した **`E-17`〜`E-20`**（収益化））の定義は [DA/01](RequirementDefinition/DA/01-conceptual-data-model.md) にある。

**`R4` は原則エージェントに委任し、承認責任は `R2` が持つ。** RACI の Accountable は全 18 Capability で人間にあり、エージェントには置かない。

## 現況（2026-09-17 時点、実地確認済み。OpenSEO の行は 2026-09-18 に追記）

EA の記述のうち、実行環境に対して実際に確認した事実を記録する。

| 確認事項 | 結果 |
|---|---|
| コードとして配線済みの連携 | **4 本のみ**（Strapi article lifecycle → PostHog、Strapi 例外 → PostHog、chatwoot-mcp、mautic-mcp） |
| Umami に登録されたサイト | **0 件**（`list_websites` が空を返す）。`E-07 Session` の発生源が存在しない |
| Strapi の記事 | **6 件すべて Strapi スキャフォールドのサンプル、全件 `draft`**（`publishedAt: null`）。公開記事数の実測値は **0** |
| ブラウザ側トラッカー | Umami・PostHog・Chatwoot ウィジェット・Mautic のいずれも `Layout.astro` に未設置 |
| n8n のワークフロー | リポジトリに 0 件（実体は n8n の DB 内のみ。Git 管理外） |
| `.claude/agents/` | 存在しない。AA-03 で設計した 12 本はすべて `未着手` |
| Google Search Console | 認証情報・所有権確認ファイルともに無し。**OpenSEO に統合して取得すると決めた**（2026-09-18。[ADR-06](RequirementDefinition/AA/05-application-decisions.md)）。OpenSEO の `/api/health` でも GSC は未設定 |
| **OpenSEO（セルフホスト）** | `middleware/open-seo-main` の Docker が `127.0.0.1:3001` で稼働（healthy、v0.1.8、`AUTH_MODE=local_noauth`）。**DataForSEO は設定済み**、GSC と AI 機能（SAM）は未設定 |
| **OpenSEO の MCP の接続先** | **2026-09-18 にセルフホスト（`http://127.0.0.1:3001/mcp`）へ付け替えた。** ローカルの MCP は `whoami` に `mode: self-hosted`、利用者 `admin@localhost`、残高 `null`（計量しない）を返す。**ローカルのプロジェクトも `Default`（ドメイン未設定・米国／英語）しか無い**ため、`comegin.com`・日本・日本語のプロジェクトを作る必要がある（`R1`）。ホスト版のアカウント（残 10,000 クレジット）は使わないまま残っている |
| Umami の compose | **他スタックと異なり `0.0.0.0` バインドで、鍵がプレースホルダのまま**（[TA/04](RequirementDefinition/TA/04-security-and-secrets.md) の 3 節） |
| リポジトリ管理外の MCP | **`strapi-mcp` と Umami MCP が実行環境に設定され、書き込みツールを含めて実際に呼べる。** リポジトリの `ACCESS_LEVEL` と `sanitize()` の保証が及ばない。**2026-09-17 に `R1` が「現状のまま使い続ける」と判断**（[ADR-07](RequirementDefinition/AA/05-application-decisions.md)。リスク受容） |
| **AWS アカウント** | `798560359429`（`ComeGin`）、**2026-09-16 作成**。`accountPlanType: PAID`。IAM ユーザー `comegin-iam` が `Developer` グループ経由で、この設計に必要な 17 アクションすべてを `allowed` |
| **公開ドメイン** | **`comegin.com` を取得済み**（Route 53 登録、有効期限 2027-09-16、ホストゾーン作成済み）。EA 執筆時点では「未取得」としていたが誤りだった |
| AWS リソース | S3・CloudFront・ACM・WAF・OAC とも **0 件**。`cloud/` が空であることと整合する |
| **Amazon SNS** | **トピック 0 件・サブスクリプション 0 件**（東京リージョン）。`CreateTopic` / `Subscribe` / `Publish` / `SetTopicAttributes` / `ListSubscriptionsByTopic` の権限は**すべて `allowed`**。通知の宛先として採用（[ADR-08](RequirementDefinition/AA/05-application-decisions.md)） |
| **監視アプリ（Next.js。ADR-14）** | `frontend/next-js` に**雛形（Next.js 16.3.5）と Better Auth（1.7.5）の導入だけ**がある（`app/page.tsx` は雛形のまま）。`.env.example` の `BETTER_AUTH_URL` は `http://localhost:3000` で、**Umami（3000）と衝突する**。開発ポートを 3200 にする（[TA/07](RequirementDefinition/TA/07-onprem-control-plane.md) の 4 節） |
| **AWS の実行環境（ADR-12）** | **2026-09-18 に確認。** ECS クラスター 0 件、VPC はデフォルトのみ。`ap-northeast-1` で RDS for MySQL 8.4・PostgreSQL 16 / 17、ElastiCache の Valkey・Redis OSS 7.1 が使える。**SES はサンドボックスのまま**（本番アクセスの申請が必要）（[TA/06](RequirementDefinition/TA/06-aws-runtime.md) の 1 節） |
| **CloudFront の課金方式** | フラットレートプランの **Free（$0/月）**を採用する。CDN・WAF・DDoS 対策・Route 53 DNS・TLS 証明書・S3 クレジットを含み、**超過課金が無い**（[TA/02](RequirementDefinition/TA/02-aws-product-delivery.md) の 8 節） |

BA-01 の KPI ツリーは「現在測定できるのは `公開記事数` のみ」としているが、**その実測値も 0 である**。

## 配線ギャップと着手順

詳細は [AA/02](RequirementDefinition/AA/02-integration-architecture.md) の 4 節。

| 順 | やること | これが通ると何ができるか |
|---|---|---|
| **0** | **AWS の実行環境**（[TA/06](RequirementDefinition/TA/06-aws-runtime.md)。旧版は「ngrok の常設トンネル」） | 1・2・4・7 の前提。訪問者のブラウザから Umami・Chatwoot・Mautic に到達できるようになり（ADR-12）、記事の正本（本番の Strapi）と Webhook の受け口（本番の n8n）ができる（ADR-16） |
| 1 | Umami トラッカー | セッション数が測れる。CVR の分母が立つ |
| 2 | Astro ← Strapi のデータ取得 | 記事ページが公開でき、観測の対象が生まれる（**ADR-16 で記事の正本が本番の Strapi に移ったため、手順 0 に依存する**。ADR-15 の間はオンプレの Strapi を読むため依存しなかった。取得処理の実装と検証は開発環境の Strapi で先に進められる） |
| 3 | Lighthouse CI の蓄積 | `E-12` が継続的に溜まる（**手順 0 に依存しない**） |
| 4 | CTA フォーム | CV 数と CVR が測れる |
| 5 | PostHog トラッカー | ファネルと AB テストが測れる（PostHog は SaaS のため手順 0 に依存しない） |
| 6 | Google Search Console（**OpenSEO 経由**） | 平均検索順位が測れる。**SEO という目的に対する測定が初めて成立する**。ドメインプロパティなら公開 URL の確定を待たずに登録できる |
| 7 | webhook → n8n | Webhook を起点にした処理と通知が自動化できる（**ADR-16 で n8n も AWS に移り、Mautic・Chatwoot からの Webhook は VPC の中で届く**。旧版はオンプレの n8n へ ngrok の常設トンネルを通していた。ワークフローの本番での有効化は人間〈`R1`〉）。**観測の日次バッチは ADR-17 で監視アプリの定期実行に移り、この手順から外れた** |
| 8 | 提案の起票と通知 | ループが 1 周する（**起票はローカルから行い、定期で起票するなら監視アプリの定期実行が前提**。ADR-17。手順 7 には依存しない。通知は GitHub の PR の機能） |
| 9 | **Amazon SNS の通知**（`I-21`） | **顧客からの要求に気づけるようになる。** BA-04 のトスアップ条件の「通知」が初めて成立する |
| **並行** | **OpenSEO の調査**（`I-22` `I-23`） | **キーワードの候補・検索ボリューム・競合が、記事を 1 本も公開していない今から取れる。** どの手順にも依存しない（MCP の付け替えは済んだ。残るのはプロジェクトの作成と月次予算の設定） |

**手順 0 と 4 に続くものが、2026-10-01 に 2 つ、2026-10-03 に 1 つ増えた**（番号は振らない。着手の可否を決めるのが配線ではなく人間の作業だからである。[AA/02](RequirementDefinition/AA/02-integration-architecture.md) の 4 節）。

- **`I-25`（Cal.com の面談の予約）** — **0 と 4 の両方に依存する**（セルフホストのため AWS の実行環境が要り、完了画面に置くためフォームが通っている必要がある）。これが通ると**商談プロセスの段 2 が成立する**（[BA/04](RequirementDefinition/BA/04-business-processes.md)）。
- **同意の受け口（`consent-api`）** — **0 に依存する。** **手順 5（PostHog トラッカー）の前提が増えた**: 旧版は「PostHog は SaaS のため手順 0 に依存しない」としていたが、**同意をサーバに記録すると決めた以上、受け口が無ければ記録が残らない**。送信そのものは Cookie があれば続くため、「0 に依存しない」は**同意の記録を諦める場合に限って**成り立つ（[DD-02](DetailedDesign/02-public-path-flows.md) の 8.3・8.4）。**あわせて、Chatwoot のウィジェットの設置も同意の実装を待つことになった**（同意の対象に加えたため。同 4.4。この表には現れないが、DD-02 の 6.1 のトラッカーの設置順では 2 番目にあたる）。
- **（2026-10-03 に追加）収益化（`I-26`〜`I-30`）** — **本システムの完成後**に置く（手順 0〜9 の後）。着手の可否を決めるのは配線ではなく**承認ゲート G-1〜G-3**（弁護士・税理士・AWS の規約。BA-05）。依存は **0**（`points-api` を AWS に置く）と **9**（SNS の通知）。これが通ると**利用者の採掘が受注（発注代金の値引き）につながる**（BA-01 のキャッシュの流れ）。

### ループを最初に 1 周させる最短経路

**全部を揃える必要は無い。Lighthouse CI だけで 1 周できる。** Umami・PostHog・Mautic・Chatwoot・GSC・n8n をいずれも必要とせず、**AWS の実行環境も ngrok のトンネルも、監視アプリの定期実行（ADR-17）も必要としない**（Lighthouse CI だけが同一ホスト内で完結し、各手順は人間が起動するため）。手順は [AA/04](RequirementDefinition/AA/04-recursive-improvement-loop.md) の 5.2 にある。

人間の手作業（コミットと PR レビュー）は**最初の 1 周から含める**。後から人間ゲートを足すと、動いている自動化に人間を割り込ませることになり、外す圧力が生じる。

## 横断的な未決定事項

各層に閉じないもの。層ごとの未決定事項は各ファイル末尾の節にある。

**2026-10-01 に、Web サイトのデザインの検討から 6 件が決まった**（ユーザーの決定。デザインの正本は `docs/BasicDesign/DesignSpec/website/01-content-spec.md`）。この表には**決まったことと、そこから新しく生じた未決**の両方を載せる。

| 項目 | 内容 | 判断者 |
|---|---|---|
| **（2026-10-03 に決定）マネタイズモデル（採掘と譲渡不可ポイント）** | **利用者の自前サーバでの採掘（オプトイン）と、譲渡不可ポイントの付与に決めた**（[AA/05](RequirementDefinition/AA/05-application-decisions.md) の ADR-20）。構成は XMRig → **unMineable（SaaS。XMR を POL〈Polygon〉に変換）** → ComeGin の **thirdweb（SaaS）**のサーバウォレット → 国内の取引業者。**AWS では採掘しない**（AWS Service Terms 1.25）。**`E-19` は追記だけ＋S3 Object Lock**（QLDB は提供終了）。**TA-01 の 8 節を「自前で持てない外部の台帳」に広げ、「AWS で用意でき、かつ費用と運用が釣り合う場合は AWS を優先」と具体化した。thirdweb はユーザーの決定による例外**。**本システムの完成後に着手し、承認ゲート G-1（弁護士）・G-2（税理士）・G-3（AWS の規約）が前提**。**残件**: 還元率・有効期限・上限、換金先の取引業者（bitbank・SBI VC トレード。GMO コインは未確認）、トラベルルールでの入金の申告で署名を求められるか、thirdweb の資格情報を mint・burn に絞れるか、保持期間（目安 7 年） | ユーザー、`R1` |
| **（2026-10-01 に決定）商談プロセス** | **4 段に確定した**: ①Web サイト・資料請求で興味を持つ → ②**ComeGin の Google Calendar の空き時間でオンライン面談の枠を予約してもらう**（Cal.com。無料相談フォームの完了画面に予約枠を埋め込む）→ ③**電子署名**で契約を締結 → ④サービスの提供（[BA/04](RequirementDefinition/BA/04-business-processes.md) の商談プロセス）。**予約を CV の条件にしない**（CV の正本は Mautic のフォーム送信のまま）。**段 3・4 は BA-01 が「受注」として本基盤の対象外に置いた範囲**である。**残件**: **電子署名の製品が未定**（製品が決まるまで連携点を立てない。[AA/02](RequirementDefinition/AA/02-integration-architecture.md) の 5 節）、面談の枠の出し方（1 枠の長さ・直前の予約・カレンダーの公開範囲） | ユーザー、`R3` |
| **（2026-10-01 に決定）Cal.com をセルフホストする** | **SaaS として使わない。** Cal.com は [TA/01](RequirementDefinition/TA/01-deployment-topology.md) の 8 節の「SaaS に依存してよい 2 種類」のどちらにも当たらず（自前で立てられる）、**8 節の基準を変えずに運用対象を 1 つ増やす側を選んだ**。ECS の `calcom`・RDS の `calcom` データベース・`cal.comegin.com`（案）（[TA/06](RequirementDefinition/TA/06-aws-runtime.md) の 3.1、[AA/02](RequirementDefinition/AA/02-integration-architecture.md) の 3.9、`I-25`）。**予約の正本（`E-16`）は `ap-northeast-1` に留まる**。**ただし同日の追加の決定で、予約の成立時に訪問者を Google Calendar の予定に招待することになり、氏名・メールアドレス・日時が Google LLC（米国）に渡る**（下の行）。**残件**: **ライセンスの確認**（機能によって条件が分かれる。確かめずに動かさない）、公式イメージの有無、訪問者向けと管理者向けのパスの切り分け、予約の濫用の防御 | `R1` |
| **（2026-10-01 に決定）面談の予定を Google Calendar に入れる** | **予約が成立したとき、訪問者を Google Calendar の予定に招待する**（ユーザーの決定）。**氏名・メールアドレス・面談の日時が Google LLC（米国）に渡る**ため、**「訪問者・顧客の個人データが国外に出る先は PostHog だけ」が成り立たなくなり、PostHog と Google Calendar の 2 つになった**（[DA/05](RequirementDefinition/DA/05-data-governance.md) の 1.2・1.2.2、[TA/01](RequirementDefinition/TA/01-deployment-topology.md) の 8 節）。**境目**: Cal.com 自体（セルフホスト）は越境せず、**予約の成立後に Google Calendar へ予定を作る部分だけ**が越境する。正本（`E-16`）は `ap-northeast-1`、Google に渡るのは複製（予定）である。**削除請求の対象に加えた**（対象は `E-08` `E-09` `E-10` `E-16` と Google の予定の 5 つ。手順は DA-05 の 2 節）。**ベンダーは増えない**（Google Workspace は既存）が、**越境は増えた**。**残件**: **`E-16` と Google の予定の保持期間**（Google Calendar に自動削除の設定が無く、消すには仕組みか手作業が要る）、**予定の削除を誰が行うか**（Cal.com 側だけ消えて Google に残る消し忘れが外から分からない）、面談の記録を商談の記録として残す必要があるか、予約の確認メールの送信経路 | `R1` `R3` |
| **（2026-10-01 に決定）Cookie 同意の保存先と対象** | **保存先は Cookie とサーバの両方**（`localStorage` は使わない）。サーバ側は**既存の ElastiCache（Valkey）**で、受け口は **ALB の後ろの自作のサービス `consent-api`（ECS on Fargate）**にする（Lambda・API Gateway・CloudFront Function は実行基盤を増やすため採らない）。**同意の対象は PostHog と Chatwoot の 2 つ**（Umami は同意の前でも送る。Cookie を使わず識別しないため）。**撤回は以後の送信を止めるだけ**にし、過去のイベントを撤回だけでは削除しない（[DD-02](DetailedDesign/02-public-path-flows.md) の 3.3・3.4・4.4・8 節、[TA/06](RequirementDefinition/TA/06-aws-runtime.md) の 4.8）。**残件**: **同意の記録の保持期間（TTL）**（決まるまで増え続ける側に倒れている）、**Cookie を受け口の応答だけで書くか、サイト側でも書くか**（応答だけなら受け口の障害で同意が成立しない）、**同意の記録に対応する型が無い**（DA-03。そのため受け口に I-ID を振っていない）、同意率を測る手段、Cal.com を同意の対象にするか（ユーザーの確認待ち） | `R1` |
| **（2026-10-01 に決定）`cta_type` の値と CVR の指標 ID** | **`cta_type` を実態に合わせて改めた**（`demo` → `consult`、`whitepaper` → `source_dl`、`chat` と `booking` を追加、`trial` は「使わない」として値を残す。[DA/01](RequirementDefinition/DA/01-conceptual-data-model.md) の 4 節）。**指標 ID も合わせた**（`CVR-wp` → `CVR-source-dl`、`CVR-demo` → `CVR-consult`、**`CVR-trial` は廃止**。対応する CTA がサイトに無く分子が永久に 0 になるため。[DA/02](RequirementDefinition/DA/02-metrics-and-kpi.md) の 1.3）。**（2026-10-01 に解決）CTA は実態の 2 種に統一した。** [BA/04](RequirementDefinition/BA/04-business-processes.md) の CTA 出し分けマトリクスとトスアップ条件、[DA/02](RequirementDefinition/DA/02-metrics-and-kpi.md) の指標 ID、[DA/01](RequirementDefinition/DA/01-conceptual-data-model.md) の `cta_type`、**およびリポジトリルートの `README.md`**（ユーザーが「実態に直す」と決定）を、**無料相談（`consult`）とソースコードの無料 DL（`source_dl`）の 2 種**にそろえた。**無料トライアルは提供していない。** 将来始める場合の設計（Mautic のステージ・セグメント・ポイント）は BA/04 のトスアップ条件に「使わない」として残し、`cta_type` の値 `trial` も残した（指標 ID の `CVR-trial` は廃止。理由は DA/02 の 1.3） | `R2` `R3` |
| **（2026-10-01 に追加）`E-16 Booking`** | 面談の予約を表す型を立てた（正本は**本番の Cal.com**。[DA/01](RequirementDefinition/DA/01-conceptual-data-model.md) の 4.1）。`E-09` の属性にしなかったのは**1 人が複数回予約しうる**ため。**DA-04（System of Record 表）と DA-05（個人情報の区分・保持期間・削除請求）への反映は 2026-10-01 に済んだ**（用語集は作らないと決まったため、採番は上の「ID の採番と正本」に書いた）。**残件**: `invitee_email`（実名情報）の保持期間、**Cal.com の予約を削除請求の対象に含めるか**、予約の歩留まりを指標にするか（候補 `BOOKING-rate`） | `R1` `R3` |
| **（2026-10-01 に反映）フォームが送る項目と計測イベント** | hidden に `cta_id` / `service_interest` と**同意の 3 項目**（`privacy_consent_at` / `privacy_consent_version` / `email_optin`）を加えた（[DD-02](DetailedDesign/02-public-path-flows.md) の 5.3）。計測イベントは **CTA 2 種・フォーム 4 種・予約 2 種の 8 イベント**を定義した（[DA/02](RequirementDefinition/DA/02-metrics-and-kpi.md) の 4.4）。**CV は `form_submitted` で数えない**（正本は Mautic のフォーム送信）。**残件**: Mautic のカスタムフィールド 3 つの作成（無いまま公開すると、プライバシーポリシーに書いた記録が残らない）、Mautic のフォーム ID（`MAUTIC_FORM_ID_*`） | `R3` |
| **集計限定を権限で表現できない** | `agent/analytics-reporter` に個票を読ませない制約が `ACCESS_LEVEL` では表せない（`mautic_get_contact` と `mautic_query_stats` がどちらも `read_only` に登録されるため）。DA が「個人情報の保護は `ACCESS_LEVEL` と取得範囲で行う」と決めた以上、**取得範囲でしか守れない箇所が 1 つ残る** | `R1` `R3` |
| **エンティティの定義漏れ 2 件** | **トレーサビリティ表の検査で発覚。** `CAP-15` の監査ログと `CAP-16` の知見メモに対応する型が `E-01`〜`E-20` に無い。DA-05 は「`E-13` を経由しない変更を監査対象にする」と定めているが、**その監査ログを表す型が存在しない**ため、検出の仕組みを設計できない。**2026-10-01 に 3 件目（面談の予約）が生じたが、こちらは `E-16 Booking` を立てて解消した**（DA-01 の 4.1）。残る 2 件は変わらない | `R1` |
| **`E-15 AgentRun` の正本**（2026-09-19 に ADR-18 で解決） | **4 層すべてで解決できなかった唯一の項目だった。** 大半のエージェントが Claude Code から直接走るため実行履歴が記録されず、「エージェントが自分の実行履歴を書き換える」暴走条件の歯止めが不完全なまま残っていた。ADR-17 でエージェントの起動元が手動・定期とも監視アプリに一本化され、監視アプリの実行記録を正本にする条件が揃った。**ADR-18 で、監視アプリの実行記録を `E-15` の正本にした。** 監視アプリはローカルに置いたまま、記録もローカルに保存する（**ADR-16 の基準「正本のデータを持つものはクラウド」の唯一の例外**。監視アプリをクラウドに置く案は採らない）。記録は監視アプリのサーバー側だけが書き、エージェントには書かせない。1 回の起動（手動・定期）を 1 件とし、相関 ID（ULID）で `E-13`・`E-14`・本番への書き込みと結ぶ。n8n の実行履歴は `E-15` の正本ではない（エージェントの実行が残らない）（[AA/05](RequirementDefinition/AA/05-application-decisions.md) の ADR-18、[TA/07](RequirementDefinition/TA/07-onprem-control-plane.md) の 3.6）。**同日の追加の決定で、記録は要約と ID だけにし、S3 に追記専用で写すことにした。** **残件は下の「監視アプリの実行記録（`E-15`）の範囲・保持・写し」の行** | `R1` |
| **n8n ワークフローを `E-13` の対象にしてよいか** | 適用先が Git の外にあり取り消せない。ワークフローが承認ゲートの迂回路になりうる以上、対象から外して人間が直接設計する選択肢もある。**ADR-16 で、本番へはエージェントが `n8n-prod` で置き、有効化は人間（`R1`）が行う形にした**（承認なしに動き出すことは無くなったが、有効化した後に戻せないことは変わらない。[AA/04](RequirementDefinition/AA/04-recursive-improvement-loop.md) の 3.3.1） | `R1` |
| **Umami の compose の扱い** | 上流無改変の取り込み方針とセキュリティ要件が構造的に衝突している。TA は自作 compose への移行（案 C）を推奨。**ADR-12 の後は開発環境だけの課題**（本番の Umami は ECS で動き、この compose を使わない。TA-04 の 3 節） | `R1` |
| **トスアップ条件の数値の置き場** | BA-04 は「暫定値・運用開始後に見直す前提」としているが、置き場の Mautic キャンペーン定義には**見直した履歴が残らない** | `R1` `R3` |
| **誤った書き込みの突き合わせ**（旧「Chatwoot の監査ログ」。2026-09-19 に ADR-17 で一部決着） | 検出の方式は ADR-16 で「監査ログと `E-13` を突き合わせる。Enterprise の `audit_logs` が使えなければエージェント専用のユーザーのメッセージ〈`sender`〉で代える」と決まり、版と頻度が残っていた。**ADR-17 で、監査ログ（Enterprise）には頼らず、エージェント専用ユーザーの送信の記録で行うと決めた**（Community 版で運用できるように。[TA/07](RequirementDefinition/TA/07-onprem-control-plane.md) の 6.2）。版の論点は決着した。**残るのは頻度と取得手段**である。拾えるのは送信だけで、会話の属性（ラベル・担当者・状態）の変更は拾えず、「`E-13` を経由しない変更の検出」は部分的のまま。加えて `chatwoot-mcp` に送信者で横断して引く手段が無く、会話を順に読むと会話本文に触れる（[AA/02](RequirementDefinition/AA/02-integration-architecture.md) の 5 節、[DA/05](RequirementDefinition/DA/05-data-governance.md) の 5 節） | `R1` |
| **Google Search Console** | **取得手段は OpenSEO に決まった**（2026-09-18。[ADR-06](RequirementDefinition/AA/05-application-decisions.md)）。ドメインプロパティで登録するため**ホスト名の確定にも依存しない**。`comegin.com` は Google Workspace であり、**OAuth 同意画面を「内部」にする**と決めた（7 日の失効は起きない）。残るのは人間の作業（DNS での所有権確認・OAuth クライアントの発行・接続） | `R1` |
| **OpenSEO の MCP と費用** | リポジトリの `ACCESS_LEVEL` も `sanitize()` も及ばず、**費用を発生させるツールを含む**。リスクを受容し、接続先 3 本・ツールの許可リスト・前払い残高・月次予算 10 USD で縛った（[ADR-10](RequirementDefinition/AA/05-application-decisions.md)）。**1 回あたりの上限は約束にとどまり、月次の支出を取得する手段も未定**（暴走条件 #11 の検出が部分的） | `R1` `R2` |
| **SaaS 依存の原則の書き直し** | 「SaaS は PostHog のみ」を「自前で持つと一巡が遅くなる機能」と「自前で持てないデータの取得元」の 2 基準に置き換えた（[TA/01](RequirementDefinition/TA/01-deployment-topology.md) の 8 節）。**個人に関わるデータが越境する SaaS は PostHog だけ**という点は変わらない | `R1` |
| **本番の管理画面の関門の方式**（2026-09-18 に解決） | **自作の `admin-auth`（Better Auth）を IdP にした ALB の OIDC 認証**に決めた（[ADR-13](RequirementDefinition/AA/05-application-decisions.md)）。ログインは Google Workspace（`hd` クレームを検査。2 段階認証は Workspace で必須）、認可は管理者の許可リスト。製品の SSO ではなく製品の手前の関門であり、SSO を導入しないという結論とは別の層。許可リストの追加と削除は BA-05 のチェックリストに入れた（[TA/04](RequirementDefinition/TA/04-security-and-secrets.md) の 6 節）。**訪問者側は認証・認可をせず、WAF のレート制限だけ**。**Better Auth の OAuth 2.1 Provider と ALB の組み合わせは実地で未確認**（[TA/06](RequirementDefinition/TA/06-aws-runtime.md) の 11 節） | `R1` |
| **オンプレの送信元 IP の固定可否**（2026-09-18 に解決） | 固定ではない。**IP による許可はやめ**、MCP サーバから本番の API は製品側の認証と WAF のレート制限で守る（[TA/04](RequirementDefinition/TA/04-security-and-secrets.md) の 7 節）。n8n は ADR-16 で AWS に移り、本番の Chatwoot・Mautic の API を VPC の中から呼ぶ | `R1` |
| **Umami MCP の接続設定の付け替え** | **接続先は 2026-09-18 に決定した**: 計測データは自前の Umami（本番は AWS）に置き、Umami Cloud は使わない。Umami v3.4.0 から自前の Umami にも API キーと `/mcp` があるため、ALB で開けるのは `/mcp` だけにする（[TA/06](RequirementDefinition/TA/06-aws-runtime.md) の 5.4）。**残件**: 本番の Umami を立てた後に `umami-prod`（本番の `/mcp`）を登録すること（ADR-15。現在の Umami MCP は Umami Cloud を向き、サイト 0 件。**登録するまでエージェントは訪問者のデータを読めない**）。取り込み済みの `middleware/umami-master` は 2026-09-18 に v3.4.0 へ取り込み直した | `R1` |
| **通知経路の監視をどう閉じるか** | 通知を Amazon SNS に集約した（[ADR-08](RequirementDefinition/AA/05-application-decisions.md)）ことで「監視対象が通知経路を兼ねる」問題は解けたが、**SNS の購読が解除されたことを SNS 自身では知らせられない**。監視の連鎖が閉じていないのはこの 1 点だけ（[TA/05](RequirementDefinition/TA/05-observability-and-ops.md) の 8 節） | `R1` |
| **本番への作用と計測値の読み取り**（2026-09-19 に ADR-15 で解決） | ローカルの Claude Code が MCP の本番用の登録（`chatwoot-prod` `mautic-prod` `umami-prod`。`read_write` まで）で本番を読み書きする。Astro の配信は人間が承認する（[TA/07](RequirementDefinition/TA/07-onprem-control-plane.md) の 6 節・7 節）。ADR-15 は Strapi をオンプレだけに戻したが、**同日の ADR-16 で本番に Strapi を置き、`strapi-prod` と `n8n-prod` の登録を加えた**。記事は本番にだけ書くため、開発から本番へ移す手段は引き続き不要 | `R1` |
| **本番の配置の基準**（2026-09-19 に ADR-16 で解決） | **正本のデータを持つもの（Astro・Strapi・Mautic・Chatwoot・Umami・n8n）はクラウド、道具（Claude Code・MCP サーバ・監視アプリ・OpenSEO・Lighthouse CI・ビルド）と開発環境はローカル**。記事の正本と本番の自動化が開発機に依存しなくなり、ngrok は Astro dev サーバーの共有だけに残る。n8n は Fargate が privileged を受け付けないため、サンドボックスを置かずに動かす（[AA/05](RequirementDefinition/AA/05-application-decisions.md) の ADR-16、[TA/06](RequirementDefinition/TA/06-aws-runtime.md)）。**ADR-18 で例外が 1 つできた**（`E-15 AgentRun` の正本＝監視アプリの実行記録はローカルに置く。**写しは S3 に追記専用で置く**。写しは正本ではない） | `R1` |
| **本番の Chatwoot で顧客へのメッセージ送信を許すか**（2026-09-19 に ADR-16 で解決） | **許す。** 送信系のツールを外さず、送信は BA-05 のとおり `承認`（`R3`）で扱う（[BA/05](RequirementDefinition/BA/05-governance.md)） | `R1` `R3` |
| **本番の `ACCESS_LEVEL` の上限**（2026-09-19 に ADR-16 で解決） | **`read_write` で確定。** `strapi-prod` は Admin トークンの権限で同等に絞る（**ADR-17 で下書きまでに絞った**）。本番のレコード削除・統合は人間が本番の管理画面で行う（[TA/07](RequirementDefinition/TA/07-onprem-control-plane.md) の 3.3） | `R1` |
| **`applied_at` の記録者と、開発と本番の設定のずれ**（2026-09-19 に ADR-16 で解決） | `applied_at` は**配信した人間**（n8n の有効化も有効にした人間、MCP での書き込みは Claude Code）が記録する。開発と本番の設定は**そろえ続ける**（開発用の登録で確かめ、`-prod` で本番に適用する。[TA/07](RequirementDefinition/TA/07-onprem-control-plane.md) の 6.1）。**n8n のワークフローの本番での有効化は新しい承認点（`承認`・`R1`）**になった（[BA/05](RequirementDefinition/BA/05-governance.md)） | `R1` |
| **監視アプリに「承認して配信」の操作を置くか**（ADR-15） | 置く場合、配信用の IAM はサーバー側にだけ置き、Claude Code の実行環境には置かない。置かない場合、人間が端末で配信のコマンドを実行する（[TA/07](RequirementDefinition/TA/07-onprem-control-plane.md) の 7 節） | `R1` |
| **監視アプリのログインと Agent SDK の仕様**（ADR-14） | ログインを本番の関門（Google Workspace）に合わせるか、オンプレ専用にするか。Agent SDK で MCP の接続先・許可するツール・権限モードを実行ごとに渡せるかを実装時に確認する（[TA/07](RequirementDefinition/TA/07-onprem-control-plane.md) の 3.3・3.4） | `R1` |
| **PostHog のプロジェクトを開発と本番で分けるか**（2026-09-19 に ADR-16 で解決） | **分ける。** 開発環境の Strapi は開発用、本番の Strapi は本番用のプロジェクトに送る。**残件**: 既存のプロジェクト（project 610214）をどちらにするか（[DA/02](RequirementDefinition/DA/02-metrics-and-kpi.md) の 6 節） | `R1` |
| **`strapi-prod` の Admin トークンで記事の公開を外せるか**（ADR-16 の反映で生じ、2026-09-19 に ADR-17 で決着） | 記事の公開は `承認`（`R2`）だが、Admin トークンに公開の権限が含まれるとエージェントが承認なしに公開できる、という論点だった。**ADR-17 で、`strapi-prod` に公開・非公開化・削除の権限を与えず下書きまでにし、記事の公開は `R2` が本番の管理画面で自ら行うと決めた**（承認を約束ではなく仕組みで守る）。**残件**: Strapi 5 の Admin トークンで「公開だけを外す」権限の設定ができるかを実装時に確かめる。できなければ ADR-07 の再検討（自作の MCP）に戻る（[BA/05](RequirementDefinition/BA/05-governance.md)、[AA/03](RequirementDefinition/AA/03-agent-architecture.md) の 8 節、[TA/07](RequirementDefinition/TA/07-onprem-control-plane.md) の 9 節） | `R1` `R2` |
| **本番の n8n の資格情報と実行履歴**（ADR-16） | 本番の n8n は全システムの資格情報を持ち、狙われたときの被害が最も大きい。加えて実行履歴に Webhook で受けた email・本文が残る。実行データの保持の設定と、削除請求の対象に含めるかが未定（[DA/05](RequirementDefinition/DA/05-data-governance.md) の 5 節）。**n8n の実行履歴は `E-15` の正本ではない**（ADR-18。n8n 自身のワークフローの実行だけが残る） | `R1` |
| **監視アプリの実行記録（`E-15`）の範囲・保持・写し**（旧「`E-15 AgentRun` の正本の候補」。ADR-14・ADR-17 で生じ、2026-09-19 に ADR-18 で正本の所在は決着。**同日の ADR-18 の追加の決定で範囲と写しも決着し、保持期間が残る**） | ADR-14 の時点では「監視アプリがエージェントの起動元に一本化されるなら、その実行記録を `E-15` の正本にできる可能性がある」という条件付きだった。ADR-17 で一本化され、「ローカルの実行記録を正本にすると ADR-16 の基準に反し、本番の個人情報が開発機に残る」ことが新たな論点になった。**ADR-18 で、ローカルに置くことを基準の例外として受け入れた。** その時点で残っていたのは（1）記録する範囲、（2）保持期間と削除請求、（3）開発機の外に写すか、の 3 点だった。**追加の決定で次のとおり決めた。**（1）**要約と ID だけを残す**（要約・対象の ID・相関 ID・成否・起動の種類。ツールの結果は残さない。要約にも個人情報を書かず、人は ID で指す規則を [AA/03](RequirementDefinition/AA/03-agent-architecture.md) の 3.5 に置き、監視アプリが記録前にメールアドレス・電話番号の形を検査する）。（3）**S3 に追記専用で写す**（写しは正本ではなく開発機を失ったときの復旧用。写しを書く資格情報は監視アプリのサーバー側だけで削除の権限を持たない。バケットは `ap-northeast-1`・パブリックアクセスを全ブロック・バージョニング有効で、削除と上書きを許さない。[TA/06](RequirementDefinition/TA/06-aws-runtime.md) の 4.7）。（2）は、`E-15` に個人情報が入らない前提になったため**削除請求の対象から外れうる**（要約の検査が漏れる余地は残る。[DA/05](RequirementDefinition/DA/05-data-governance.md) の 1.5）。**残るのは、保持期間**（少なくとも改善の検証の期間〈既定 30 日〉と `rollback.deadline` を覆う。S3 の写しの保持も合わせて決める。[DA/05](RequirementDefinition/DA/05-data-governance.md) の 2 節）、**写す頻度と形式**（[TA/05](RequirementDefinition/TA/05-observability-and-ops.md) の 8 節）、**要約の個人情報の検査の方法**、**ローカルの記録にエージェントが届かないことの担保**（[TA/04](RequirementDefinition/TA/04-security-and-secrets.md) の 9 節）である。詳細は [TA/07](RequirementDefinition/TA/07-onprem-control-plane.md) の 3.6・9 節 | `R1` |
| **エージェントの定期実行の起動元**（2026-09-19 に ADR-17 で解決） | ADR-16 で n8n が AWS に移り、本番の n8n からローカルの Claude Code を起動できなくなった（ADR-16 の反映で見つかった）。**エージェントを使う定期処理（観測の日次バッチ・`I-13` の起票・公開された記事の確認・誤った書き込みの突き合わせ）は監視アプリが起動する**。Webhook の受け口とエージェントを使わない決定論的な定期処理は本番の n8n のまま（ADR-05 の一部を置き換え。[TA/07](RequirementDefinition/TA/07-onprem-control-plane.md) の 3.5）。**開発機が止まると改善ループも止まる**（本番のサービスは止まらない）。ハートビートの送り手を監視アプリにするか、スケジュールの仕組み（監視アプリの中か OS のタイマーか）は未決定 | `R1` |
| **定期実行の定義をエージェントが書き換えられないこと**（ADR-17 で生じた論点。**2026-09-19 に ADR-18 の追加の決定で解決**） | 取得の範囲と起動の頻度は監視アプリのスケジュールの定義に固定する（ADR-05 の理由を守るため）。この定義（取得範囲・頻度・使うエージェントとツール）はエージェントの実行条件にあたり、BA-05 の基準では `禁止`（人間が行う）になるが、置き場所が決まっておらず、エージェントが編集できる場所に置くとコミットを経ずに次の実行に効く（たとえば調査の範囲を広げて費用を増やす）、という論点だった。**追加の決定で、定義は Git で持ち、監視アプリは承認済みの `main` から作った別のチェックアウトで読むと決めた。定義の変更は必ず PR を通す**（`E-14` の承認と同じ経路）。エージェントが作業ツリーで書き換えても、承認されて `main` に入るまで次の実行に効かない。BA-05 では `承認`（`R1`）として承認ゲートの一覧に載せた。**残件**: 監視アプリが読む `main` のチェックアウトをいつ・誰が更新するか、定期実行で起動した Claude Code が読むエージェント定義も `main` の版にするか（[AA/03](RequirementDefinition/AA/03-agent-architecture.md) の 8 節）、エージェントが `main` にマージできないことの担保（GitHub のブランチ保護。[TA/04](RequirementDefinition/TA/04-security-and-secrets.md) の 9 節）（旧版の案は「Git で持ち、承認済みの `main` から作った別の場所で監視アプリが読む」。ADR-18 の決定の際に AA-05・TA-07 の未決定事項として明記された。[AA/05](RequirementDefinition/AA/05-application-decisions.md) の未決定事項、[TA/07](RequirementDefinition/TA/07-onprem-control-plane.md) の 3.5・9 節、[AA/04](RequirementDefinition/AA/04-recursive-improvement-loop.md) の 3.5・6 節、[BA/05](RequirementDefinition/BA/05-governance.md)） | `R1` |
| **`I-13` の起票の主体**（ADR-17 で生じた論点） | ADR-17 は「監視アプリから起動したエージェント、またはローカルの処理」とした。**エージェントにすると、リポジトリのルール（状態変更系の git コマンドの禁止）と、「エージェントは PR を作れない」ことを承認機構の安全装置とする設計（[AA/03](RequirementDefinition/AA/03-agent-architecture.md) の 5.3）が崩れる**。エージェントを使わないローカルの処理にすれば維持できる。あわせて、`E-14` を `E-13` に書き戻す主体（[DA/04](RequirementDefinition/DA/04-data-flow.md) の 2 節は n8n としている）も見直す | `R1` |
| **Chatwoot の社内メモと顧客への送信の分け方**（ADR-17） | `chatwoot_send_message` は社内メモと送信を兼ね、`private` の既定値が `false`（顧客に送信）である。社内メモ専用のツールを `chatwoot-mcp` に足すか、社内メモ用の登録を分けるかを決める（実装はまだ）。**登録を分ける方法では `ACCESS_LEVEL` に「社内メモだけ」の段階が無く、クライアント側の許可リストに頼ることになる**（[AA/03](RequirementDefinition/AA/03-agent-architecture.md) の 8 節）。送信を担うエージェントが 12 本の中に無いことも合わせて決める | `R1` `R3` |
| **n8n に登録する Strapi の資格情報**（ADR-17 で生じ、2026-09-19 に ADR-18 で解決） | エージェントのトークンから記事の公開の権限を外しても、本番の n8n に公開の権限を持つ Strapi のトークンを登録すれば、ワークフロー経由で公開できる（n8n のワークフローはエージェントが `n8n-prod` で作れる）、という論点だった。**ADR-18 で、本番の n8n に登録する Strapi の資格情報にも公開・非公開化・削除の権限を与えない（下書きまで）と決めた。** 今の設計で本番の n8n が Strapi に書く処理は無いため、**必要になるまで登録しない**。これで「記事の公開は人間だけ」がどの経路でも崩れない（[AA/05](RequirementDefinition/AA/05-application-decisions.md) の ADR-18、[BA/05](RequirementDefinition/BA/05-governance.md)） | `R1` |

## ID の採番と正本

**ID の採番の正本は層ごとのファイルにあり、この表がその索引である。**

**2026-10-01 までは、20 以上のファイルが冒頭で「ID は EA 共通用語集の定義をそのまま使う」と書いていたが、`EA 共通用語集` という文書はリポジトリに存在しなかった**（`E-16` と `I-25` を登録しようとして判明した）。**同日にユーザーが「用語集は作らず、参照のほうを書き換える」と決定**し、各ファイルの冒頭をこの表を指す形に改めた。**ID の定義は各文書に置き、索引だけを 1 か所にまとめる**という形である（1 枚の用語集を作ると、**定義の正本が用語集と各層のファイルの 2 か所になる**ため採らなかった）。

| ID の系統 | 採番の正本 | 備考 |
|---|---|---|
| `E-01`〜**`E-20`** エンティティ | [DA/01](RequirementDefinition/DA/01-conceptual-data-model.md) の 4 節 | **`E-16 Booking` は 2026-10-01 に DA-01 の 4.1 で追加した**（`E-15` までは既存）。型を立てた理由も同じ節にある。**`E-17`〜`E-20`（収益化）は 2026-10-03 に DA-01 の 4.2 で追加した** |
| `I-01`〜**`I-30`** 連携点 | [AA/02](RequirementDefinition/AA/02-integration-architecture.md) の 1 節 | `I-14` は廃止（再利用しない）。`I-22`〜`I-24` は 2026-09-18、**`I-25`（Cal.com の面談の予約）は 2026-10-01** に追加。**同意の受け口は E-ID を運ばないため I-ID を振っていない**（AA-02 の 1.3）。**`I-26`〜`I-30`（収益化）は 2026-10-03** に追加。`I-26` で種別 `Stratum` を足した |
| `CAP-01`〜`CAP-18` ケイパビリティ | [BA/02](RequirementDefinition/BA/02-capability-map.md) | **ID・名称・主担当ロールの採番の正本。** グルーピングと成熟度も同ファイルで定義する。**`CAP-17` `CAP-18`（収益化群）は 2026-10-03 に追加** |
| `R1`〜`R4` ロール | [BA/03](RequirementDefinition/BA/03-roles-and-raci.md) | 同上 |
| `ADR-01`〜**`ADR-20`** 適用判断 | [AA/05](RequirementDefinition/AA/05-application-decisions.md) | **`ADR-19`（Cal.com のセルフホストと同意の受け口）は 2026-10-01 に起票**。**`ADR-20`（マネタイズモデル）は 2026-10-03 に起票** |
| 指標 ID（`CVR-total` など） | [DA/02](RequirementDefinition/DA/02-metrics-and-kpi.md) の 4 節 | **DA でのみ使うローカルな識別子**であり、他の系統とは別（DA/02 の 6 節） |
| 承認ゲート `G-1`〜`G-3`（2026-10-03 に追加） | [AA/05](RequirementDefinition/AA/05-application-decisions.md) の ADR-20 | 収益化の着手の前提。BA-05 の承認ゲートの一覧にも載せる |

- **新しい ID を足すときは、上の正本のファイルに足し、この表の採番の範囲を更新する。** 「勝手に増やさない」という既存の表記ルールは残す。**増やすなら、増やした理由を正本のファイルに書く**（`E-16` の例は DA/01 の 4.1、`ADR-19` は AA/05）。
- **各層のファイルの冒頭は、この表を指す形に統一した**（2026-10-01）。採番の正本を持つファイルは、その旨を自分の冒頭に書いている（`E-` は DA/01、`I-` は AA/02 の 1 節、`CAP-` は BA/02、`R` は BA/03、`ADR-` は AA/05、指標 ID は DA/02 の 4 節）。
- **ID の重複と食い違いの検査は、この表を起点に各正本を見る形で行う**（1 か所にまとまった定義表は持たない）。

## 書式の規約

この文書群は既存リポジトリの慣習（`.claude/CLAUDE.md`、`backend/chatwoot-mcp/README.md`）に合わせている。

- 日本語・常体。日本語と英数字の間には半角スペースを入れる
- 箇条書きは `-` 固定。設計判断には理由を括弧書きで併記する
- 図は Mermaid。AA・TA の全体図は C4 記法
- **1 図あたり 7±2 ノード。** 超える場合は階層を分けて複数図にする（Mermaid の C4 は段組み制御が弱く、ノードが増えるとラベルが重なって判読できなくなる）
- **C4 の `Rel()` の第 4 引数に状態を入れない。** 技術タグとして描画され、境界のタイトルと重なる
- レイヤー間の実現関係（realization）は Mermaid で表現できないため、**トレーサビリティは必ず表で担保する**
- 未確定事項は「TODO」と書かず、各ファイル末尾の「未決定事項」節に理由つきで記録する
