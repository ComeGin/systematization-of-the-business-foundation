# エンタープライズアーキテクチャ

SaaS 販売事業の「事業経営基盤」を、再帰的自己改善型のシステムとして構築するためのアーキテクチャ文書。
リポジトリルートの `README.md` が事業スキームの原典で、この文書群はそれを 4 層に分解して整合を取ったものである。

対象範囲はマーケティング部門の Web サイト運用・SEO 対策（`MarketingDepartment/WebsiteOperations`）。

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
| [BA/01-business-model.md](BA/01-business-model.md) | 事業目的、バリューストリーム、KPI ツリー |
| [BA/02-capability-map.md](BA/02-capability-map.md) | ケイパビリティマップ、外注 → 内製の対応 |
| [BA/03-roles-and-raci.md](BA/03-roles-and-raci.md) | 役割定義の正規化、RACI |
| [BA/04-business-processes.md](BA/04-business-processes.md) | 更新ワークフロー、PDCA、キーワード＆CV 設計 |
| [BA/05-governance.md](BA/05-governance.md) | SSO、権限、担当者変更、**承認ゲートの一覧** |

### DA — Data Architecture

| ファイル | 内容 |
|---|---|
| [DA/01-conceptual-data-model.md](DA/01-conceptual-data-model.md) | 概念データモデル、**`E-13` の型定義** |
| [DA/02-metrics-and-kpi.md](DA/02-metrics-and-kpi.md) | CVR の定義、指標一覧、データ契約 |
| [DA/03-identity-resolution.md](DA/03-identity-resolution.md) | ID 統合、匿名から実名への昇格 |
| [DA/04-data-flow.md](DA/04-data-flow.md) | データフロー、System of Record |
| [DA/05-data-governance.md](DA/05-data-governance.md) | 個人情報の区分、保持期間、`sanitize()` |

### AA — Application Architecture

| ファイル | 内容 |
|---|---|
| [AA/01-application-landscape.md](AA/01-application-landscape.md) | C4 コンテキスト／コンテナ図、アプリ一覧 |
| [AA/02-integration-architecture.md](AA/02-integration-architecture.md) | 連携点カタログ、露出経路の 2 分類、**着手順** |
| [AA/03-agent-architecture.md](AA/03-agent-architecture.md) | **エージェント 12 本の設計と権限** |
| [AA/04-recursive-improvement-loop.md](AA/04-recursive-improvement-loop.md) | **改善ループの制御仕様、安全装置、暴走条件** |
| [AA/05-application-decisions.md](AA/05-application-decisions.md) | 適用判断の記録（ADR-01〜06） |

### TA — Technology Architecture

| ファイル | 内容 |
|---|---|
| [TA/01-deployment-topology.md](TA/01-deployment-topology.md) | 配置境界、ポート割当、境界越え通信 |
| [TA/02-aws-product-delivery.md](TA/02-aws-product-delivery.md) | Astro の AWS 構成、Cloudflare 代替 |
| [TA/03-triggers-and-cicd.md](TA/03-triggers-and-cicd.md) | トリガー 4 系統、n8n の Git 管理外問題 |
| [TA/04-security-and-secrets.md](TA/04-security-and-secrets.md) | 秘匿値、**ngrok の経路分離**、MCP の権限 |
| [TA/05-observability-and-ops.md](TA/05-observability-and-ops.md) | 監視、バックアップ、構成管理 |

## 層間トレーサビリティ

この表が EA 全体の**目次でありチェックサム**である。ある Capability に対応する役割・データ・アプリ・基盤のいずれかが空欄なら、そこが設計漏れになる。

| Capability | 主担当 | 主なデータ | アプリケーション | 基盤 | 状態 |
|---|---|---|---|---|---|
| `CAP-01` 事業戦略・KPI 管理 | `R2` | `E-12` 指標 | Umami + PostHog + Mautic | オンプレ Docker | `未配線` |
| `CAP-02` キーワード戦略 | `R2` | `E-01` `E-02` | Strapi `api::keyword.keyword` | オンプレ Docker | `未着手` |
| `CAP-03` コンテンツ企画 | `R2` | `E-03` | Strapi `api::content-plan.content-plan` | オンプレ Docker | `未着手` |
| `CAP-04` コンテンツ制作 | `R4` | `E-04` | Claude Code + strapi-mcp | オンプレ Docker | `未配線` |
| `CAP-05` デザイン制作 | `R1` | `E-05` `E-06` | Astro + shadcn/ui + Tailwind v4 | ビルド時 | `未配線` |
| `CAP-06` 品質保証・承認 | `R2` | `E-14` | Lighthouse CI + GitHub の PR レビュー | ローカル + GitHub | `未配線` |
| `CAP-07` コンテンツ公開・配信 | `R1` | `E-04` `E-05` | Strapi の `publishedAt` + Astro 再ビルド | AWS S3 + CloudFront | `未着手` |
| `CAP-08` エッジ配信・可用性 | `R1` | `E-05` | CloudFront（Cloudflare の代替） | AWS | `未着手` |
| `CAP-09` テクニカル SEO | `R1` | `E-12` | Lighthouse CI + Astro | ローカル | **`実装済み`** |
| `CAP-10` 行動観測・効果測定 | `R3` | `E-07` `E-08` `E-12` | Umami（母数）+ PostHog（行動） | オンプレ + **ngrok** | `未着手` |
| `CAP-11` リード獲得・育成 | `R3` | `E-06` `E-09` | Mautic + mautic-mcp | オンプレ + ngrok | `未配線` |
| `CAP-12` Web 接客 | `R3` | `E-10` | Chatwoot + chatwoot-mcp | オンプレ + ngrok | `未配線` |
| `CAP-13` 監視・障害対応 | `R1` | `E-12` | PostHog（Error Tracking） | SaaS + healthcheck | `未配線` |
| `CAP-14` 改善提案の生成と承認 | `R2` | `E-13` `E-14` `E-15` | Git / GitHub | GitHub | `未着手` |
| `CAP-15` ガバナンス・アクセス管理 | `R1` | **未定義**（下記参照） | MCP の `ACCESS_LEVEL` と `MCP_AUTH_TOKEN` | 各システム個別 | `実装済み`（MCP 側のみ） |
| `CAP-16` 戦略知見の獲得 | `R2` | `E-01` `E-03`（知見メモは**未定義**） | Claude Code | Git（`docs/knowledge/`） | `未着手` |

ロール（`R1` Web マスター / `R2` SEO ディレクター / `R3` データアナリスト / `R4` コンテンツエディター）の定義は [BA/03](BA/03-roles-and-raci.md)、エンティティ（`E-01`〜`E-15`）の定義は [DA/01](DA/01-conceptual-data-model.md) にある。

**`R4` は原則エージェントに委任し、承認責任は `R2` が持つ。** RACI の Accountable は全 16 Capability で人間にあり、エージェントには置かない。

## 現況（2026-09-16 時点、実地確認済み）

EA の記述のうち、実行環境に対して実際に確認した事実を記録する。

| 確認事項 | 結果 |
|---|---|
| コードとして配線済みの連携 | **4 本のみ**（Strapi article lifecycle → PostHog、Strapi 例外 → PostHog、chatwoot-mcp、mautic-mcp） |
| Umami に登録されたサイト | **0 件**（`list_websites` が空を返す）。`E-07 Session` の発生源が存在しない |
| Strapi の記事 | **6 件すべて Strapi スキャフォールドのサンプル、全件 `draft`**（`publishedAt: null`）。公開記事数の実測値は **0** |
| ブラウザ側トラッカー | Umami・PostHog・Chatwoot ウィジェット・Mautic のいずれも `Layout.astro` に未設置 |
| n8n のワークフロー | リポジトリに 0 件（実体は n8n の DB 内のみ。Git 管理外） |
| `.claude/agents/` | 存在しない。AA-03 で設計した 12 本はすべて `未着手` |
| Google Search Console | 認証情報・所有権確認ファイルともに無し |
| Umami の compose | **他スタックと異なり `0.0.0.0` バインドで、鍵がプレースホルダのまま**（[TA/04](TA/04-security-and-secrets.md) の 3 節） |
| リポジトリ管理外の MCP | **`strapi-mcp` と Umami MCP が実行環境に設定され、書き込みツールを含めて実際に呼べる。** リポジトリの `ACCESS_LEVEL` と `sanitize()` の保証が及ばない（[AA/05](AA/05-application-decisions.md)） |

BA-01 の KPI ツリーは「現在測定できるのは `公開記事数` のみ」としているが、**その実測値も 0 である**。

## 配線ギャップと着手順

詳細は [AA/02](AA/02-integration-architecture.md) の 4 節。

| 順 | やること | これが通ると何ができるか |
|---|---|---|
| **0** | **ngrok の常設トンネル** | 1・4 の前提。オンプレの観測系にブラウザから到達できるようになる |
| 1 | Umami トラッカー | セッション数が測れる。CVR の分母が立つ |
| 2 | Astro ← Strapi のデータ取得 | 記事ページが公開でき、観測の対象が生まれる（**手順 0 に依存しない**） |
| 3 | Lighthouse CI の蓄積 | `E-12` が継続的に溜まる（**手順 0 に依存しない**） |
| 4 | CTA フォーム | CV 数と CVR が測れる |
| 5 | PostHog トラッカー | ファネルと AB テストが測れる（PostHog は SaaS のため手順 0 に依存しない） |
| 6 | Google Search Console | 平均検索順位が測れる。**SEO という目的に対する測定が初めて成立する** |
| 7 | webhook → n8n | 観測の日次バッチと通知が自動化できる |
| 8 | 提案の起票と通知 | ループが 1 周する |

### ループを最初に 1 周させる最短経路

**全部を揃える必要は無い。Lighthouse CI だけで 1 周できる。** Umami・PostHog・Mautic・Chatwoot・GSC・n8n をいずれも必要とせず、**ngrok のトンネルも必要としない**（Lighthouse CI だけが同一ホスト内で完結するため）。手順は [AA/04](AA/04-recursive-improvement-loop.md) の 5.2 にある。

人間の手作業（コミットと PR レビュー）は**最初の 1 周から含める**。後から人間ゲートを足すと、動いている自動化に人間を割り込ませることになり、外す圧力が生じる。

## 横断的な未決定事項

各層に閉じないもの。層ごとの未決定事項は各ファイル末尾の節にある。

| 項目 | 内容 | 判断者 |
|---|---|---|
| **リポジトリの保証が及ばない MCP 経路**（[ADR-07](AA/05-application-decisions.md)） | `strapi-mcp` と Umami MCP が実行環境にあり書き込みツールも呼べるが、`sanitize()`・`ACCESS_LEVEL` 相当の境界・**副作用を持つ API の除外**のいずれも未確認。**BA-05・TA-04・AA-03 の 3 層が「`禁止` 分類に対応する MCP ツールは存在しない」という前提に立っているが、その保証は管理下の 2 本に限られる。** さらに `CAP-04` の実務がこの経路に依存しており、`使わない` と決めると BA-02 の成熟度 `部分的` の根拠が崩れる | `R1` |
| **集計限定を権限で表現できない** | `agent/analytics-reporter` に個票を読ませない制約が `ACCESS_LEVEL` では表せない（`mautic_get_contact` と `mautic_query_stats` がどちらも `read_only` に登録されるため）。DA が「個人情報の保護は `ACCESS_LEVEL` と取得範囲で行う」と決めた以上、**取得範囲でしか守れない箇所が 1 つ残る** | `R1` `R3` |
| **エンティティの定義漏れ 2 件** | **トレーサビリティ表の検査で発覚。** `CAP-15` の監査ログと `CAP-16` の知見メモに対応する型が `E-01`〜`E-15` に無い。DA-05 は「`E-13` を経由しない変更を監査対象にする」と定めているが、**その監査ログを表す型が存在しない**ため、検出の仕組みを設計できない | `R1` |
| **`E-15 AgentRun` の正本** | **4 層すべてで解決できなかった唯一の項目。** 大半のエージェントが Claude Code から直接走るため実行履歴が記録されず、「エージェントが自分の実行履歴を書き換える」暴走条件の歯止めが不完全なまま残る | `R1` |
| **n8n ワークフローを `E-13` の対象にしてよいか** | 適用先が Git の外にあり取り消せない。ワークフローが承認ゲートの迂回路になりうる以上、対象から外して人間が直接設計する選択肢もある | `R1` |
| **Umami の compose の扱い** | 上流無改変の取り込み方針とセキュリティ要件が構造的に衝突している。TA は自作 compose への移行（案 C）を推奨 | `R1` |
| **トスアップ条件の数値の置き場** | BA-04 は「暫定値・運用開始後に見直す前提」としているが、置き場の Mautic キャンペーン定義には**見直した履歴が残らない** | `R1` `R3` |
| **Chatwoot の監査ログ** | Enterprise 機能のため使えない場合、「`E-13` を経由しない変更の検出」が成立しない | `R1` |
| **Google Search Console** | SEO が目的なのに検索順位を測る手段が無い。優先度は高いが 1 番ではない（公開ドメインの確定が前提） | `R2` |
| **ngrok の認証方式** | OAuth / Basic 認証 / IP 制限の選択。OAuth を選ぶと IdP が要り、SSO を導入しないという結論と絡む | `R1` |

## 書式の規約

この文書群は既存リポジトリの慣習（`.claude/CLAUDE.md`、`backend/chatwoot-mcp/README.md`）に合わせている。

- 日本語・常体。日本語と英数字の間には半角スペースを入れる
- 箇条書きは `-` 固定。設計判断には理由を括弧書きで併記する
- 図は Mermaid。AA・TA の全体図は C4 記法
- **1 図あたり 7±2 ノード。** 超える場合は階層を分けて複数図にする（Mermaid の C4 は段組み制御が弱く、ノードが増えるとラベルが重なって判読できなくなる）
- **C4 の `Rel()` の第 4 引数に状態を入れない。** 技術タグとして描画され、境界のタイトルと重なる
- レイヤー間の実現関係（realization）は Mermaid で表現できないため、**トレーサビリティは必ず表で担保する**
- 未確定事項は「TODO」と書かず、各ファイル末尾の「未決定事項」節に理由つきで記録する
