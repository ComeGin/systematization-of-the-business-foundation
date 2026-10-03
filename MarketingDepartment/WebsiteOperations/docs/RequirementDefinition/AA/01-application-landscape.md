# AA-01 アプリケーションランドスケープ

AA（Application Architecture）層。ロール ID `R1`〜`R4`（正本は BA-03）、Capability ID `CAP-01`〜`CAP-18`（BA-02）、エンティティ ID `E-01`〜`E-20`（DA-01）はそれぞれの正本の定義をそのまま使う（索引は [`docs/README.md` の「ID の採番と正本」](../../README.md)）。

この層が答えるのは「BA が定義した Capability と、DA が正本を決めたエンティティを、**どのアプリケーションが実際に担うのか**」の 1 問だけ。物理構成（ホスティング先・コンテナの配置・ネットワーク）は TA の担当で、ここでは扱わない。

図はすべて **To-Be** を描く。状態（`実装済み` / `未配線` / `未着手`）は図に持ち込まず、必ず表の「状態」列と図の直下の As-Is 注記で表す（`docs/README.md` の「この文書群の読み方」と「書式の規約」に従う）。

## 1. C4 Lv1 システムコンテキスト

```mermaid
C4Context
    title Lv1 システムコンテキスト
    Person(team, "運用チーム", "R1 - R4")
    Person_Ext(visitor, "サイト訪問者", "検索から流入")
    System(agents, "エージェント層", "Claude Code + MCP")
    System(site, "公開サイト", "Astro / E-05")
    System(content, "コンテンツ基盤", "Strapi / E-01 E-03 E-04")
    System(engage, "顧客接点基盤", "Mautic / Chatwoot")
    System(observe, "観測基盤", "Umami / PostHog / LHCI / OpenSEO")
    Rel(visitor, site, "閲覧")
    Rel(site, engage, "CTA 送信")
    Rel(site, observe, "行動送信")
    Rel(content, site, "ビルド")
    Rel(agents, content, "起草")
    Rel(agents, observe, "観測")
    Rel(team, agents, "承認")
    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

**As-Is 注記。** この図の 7 本の関係のうち、実際に成立しているのは `エージェント層 → コンテンツ基盤`（`strapi-mcp` 経由の記事操作）と `エージェント層 → 顧客接点基盤`（`chatwoot-mcp` / `mautic-mcp`。図では `観測` の線に含めている）だけ。`サイト訪問者 → 公開サイト` は記事を描画するページが存在せず（`frontend/verdant-virgo/src/pages/` に `index.astro` しかない）、`公開サイト → 顧客接点基盤` と `公開サイト → 観測基盤` はブラウザ側のスクリプトが 1 つも設置されていない（`frontend/verdant-virgo/src/layouts/Layout.astro`）。詳細は 6 節の一覧表と AA-02 の連携点カタログを見る。

`運用チーム → エージェント層` の線は承認の流れであって実行の流れではない。**この線が逆向き（エージェントが人間の承認条件を書き換える）になることは設計上あってはならない**（BA-03 の「Accountable をエージェントに置かない」決定。AA-03 の 5 節で担保方法を述べる）。

## 2. C4 Lv2 コンテナ図（コンテンツ系）

```mermaid
C4Container
    title Lv2 コンテンツ系
    System_Boundary(cb, "コンテンツ基盤") {
        Container(strapi, "Strapi", "Node 22 / 1337", "E-01 E-03 E-04 の正本")
        ContainerDb(sdb, "Strapi DB", "SQLite 既定", "記事・企画・KW")
        Container(astro, "Astro", "Node / 4321", "E-05 を生成")
        Container(lhci, "Lighthouse CI", "preview 4322", "E-12 を出力")
    }
    Container_Ext(ph, "PostHog", "SaaS", "記事イベント受信")
    Rel(strapi, sdb, "読み書き")
    Rel(astro, strapi, "記事取得")
    Rel(lhci, astro, "計測")
    Rel(strapi, ph, "記事イベント")
    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

**As-Is 注記。** 実際に動いているのは `Strapi → Strapi DB` と `Strapi → PostHog`（`backend/strapi-system/src/index.ts` のライフサイクル購読）の 2 本。`Astro → Strapi` は**まだ 1 行も書かれていない**（記事を取得するローダも描画ページも無い）。`Lighthouse CI → Astro` は `pnpm lh` で実行できるが、結果を `E-12 AuditResult` として継続的に蓄積する経路が無い。

- Strapi の DB クライアントは `DATABASE_CLIENT` で切り替わり、既定は SQLite（`backend/strapi-system/config/database.ts`）。**`E-01` `E-03` `E-04` の正本は本番（AWS）の Strapi である**（ADR-16。2026-09-19）。本番の Strapi は ECS on Fargate で動き、DB は RDS for PostgreSQL（共有インスタンスの `strapi` データベース）、メディアは S3 に置く（TA-06）。**図の技術表記（`Node 22 / 1337`・`SQLite 既定`）は開発環境のものである。** 開発環境の Strapi は試験用で、記事を開発と本番の間で移さない（TA-07 の 6 節）。
- **配置の経緯。** ADR-14 で「本番の Strapi を AWS に置く」と決め、同日の ADR-15 で取り消してオンプレだけに戻した（記事は HTML に焼き込まれて配信されるため、本番に Strapi を置く理由が無いとした）。さらに同日の ADR-16 で、**正本が開発機 1 台にしか無い**ことを理由に再び AWS に置いた。
- **`Astro → Strapi`（`I-09`）の接続先は本番の Strapi である**（ADR-16。ADR-15 ではオンプレの Strapi だった）。ビルドはオンプレで行い、読み取り専用の API トークンで本番の Content API を読む。配信は人間が承認する（ADR-15、DD-05 の 1 節）。**エージェントが本番の Strapi に書けるのは下書きまでで、記事の公開は `R2` が本番の管理画面で行う**（ADR-17）。公開された記事は監視アプリの定期実行が見つけてビルドと計測を起こす（案。本番の Strapi からローカルへは通知できないため。TA-07 の 3.5）。画像はビルド時に `dist/` へ取り込み、公開ページから Strapi と S3 へのリクエストを出さない（ADR-11）。
- `E-05 Page` は Astro のビルド成果物であり、直接書き換えられない。作用は必ず `E-04` かコードのどちらかを変えて再ビルドする経路を通る（DA-04 の 1.3）。

## 3. C4 Lv2 コンテナ図（顧客接点系）

```mermaid
C4Container
    title Lv2 顧客接点系
    Person_Ext(visitor, "サイト訪問者", "匿名 または 実名")
    System_Boundary(eb, "顧客接点基盤") {
        Container(mautic, "Mautic", "PHP / 8000", "E-06 E-09 の正本")
        ContainerDb(mdb, "MySQL", "Docker", "コンタクト・フォーム")
        Container(chatwoot, "Chatwoot", "Rails / 3100", "E-10 の正本")
        ContainerDb(cdb, "PostgreSQL 5432", "Docker", "会話・メッセージ")
    }
    Rel(visitor, mautic, "フォーム送信")
    Rel(visitor, chatwoot, "ウィジェット")
    Rel(mautic, mdb, "読み書き")
    Rel(chatwoot, cdb, "読み書き")
    Rel(chatwoot, mautic, "email で突合")
    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

**As-Is 注記。** Mautic と Chatwoot は本体・DB とも起動できるが、**訪問者からの 2 本の線は成立していない**（Mautic のフォームが未作成、Chatwoot のウィジェットがサイトに未設置）。`Chatwoot → Mautic` の email 突合も未着手で、両者を繋ぐ経路は現時点で存在しない。MailHog（8025）は Mautic の送信メールを開発環境で受けるためのもので、本番の配信経路ではない。**本番の顧客向けメールは Amazon SES から送る**（ADR-12、TA-06 の 6 節。`未着手`）。

- **図の技術表記（`PHP / 8000`・`Docker`・`PostgreSQL 5432`）は開発環境のものである。** 本番では Mautic・Chatwoot は AWS の ECS on Fargate で動き、DB は RDS for MySQL / RDS for PostgreSQL、Chatwoot の Redis は ElastiCache、添付ファイルは S3、Mautic の `media/` は EFS に置く（ADR-12、TA-06）。物理構成は TA の担当であり、この図では描き分けない。

- Chatwoot のホスト側ポート 3100 は **`mautic-mcp` の HTTP 既定値と衝突する**（`.claude/CLAUDE.md` のポート表）。両方を HTTP で動かす構成を採るなら、`mautic-mcp` 側の `PORT` を変える（AA-05 の未決定事項に記録）。
- `E-06 CTA` は表示定義（Strapi のコンポーネント）と受付定義（Mautic のフォーム）に分割保持される（DA-01 の 4 節）。図では受付定義側だけを Mautic に置いている。

## 4. C4 Lv2 コンテナ図（観測系）

```mermaid
C4Container
    title Lv2 観測系
    Container_Ext(browser, "ブラウザ", "訪問者の端末", "E-07 E-08 の発生源")
    System_Boundary(ob, "観測基盤") {
        Container(umami, "Umami", "Node / 3000", "E-07 の正本")
        ContainerDb(udb, "PostgreSQL", "Docker", "セッション")
        Container(lh, "Lighthouse CI", "ローカル実行", "E-12 の正本")
        Container(seo, "OpenSEO", "Docker / 3001", "検索実績と市場データ")
    }
    Container_Ext(ph, "PostHog", "SaaS 米国", "E-08 E-11 の正本")
    Container_Ext(gsc, "Search Console", "Google", "E-12 source=gsc")
    Container_Ext(dfs, "DataForSEO", "SaaS 従量課金", "SERP と検索ボリューム")
    Rel(browser, umami, "ページビュー")
    Rel(browser, ph, "同意後 identify")
    Rel(umami, udb, "読み書き")
    Rel(seo, gsc, "OAuth で取得")
    Rel(seo, dfs, "調査 API")
    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

**As-Is 注記。** ブラウザからの 2 本はどちらも未着手（トラッカーのスクリプトが無い）。Umami は起動できるがセッションが 0 件。PostHog に届いているのは Strapi のサーバ側イベントだけで、訪問者の `E-08 Person` は 1 件も存在しない（DA-03 の 1.2）。Google Search Console はサイト登録も所有権確認も行っていない。**OpenSEO は Docker で稼働しており、`OpenSEO → DataForSEO` だけが成立している**（API キー設定済み）。`OpenSEO → Search Console` は OAuth クライアントが未発行のため未接続。

- **GSC は OpenSEO に統合した**（`R1` の 2026-09-18 の決定。ADR-06・ADR-09）。当初の図にあった `Search Console → Lighthouse CI` の線（順位データを `E-12` の別ソースとして同じ入れ物に入れる、という論理的な関係）は廃した。**実装上は `agent/seo-auditor` が `.lighthouse/` と OpenSEO の MCP の両方を読んで `E-12` に正規化する**（AA-03）。
- **OpenSEO を観測基盤の境界の内側に、DataForSEO と Search Console を外側（`Container_Ext`）に置いたのは配置の違いを表すため**である。OpenSEO はセルフホストでオンプレに留まり、外に出るのは DataForSEO への問い合わせと GSC からの取得だけになる。

- **訪問者・顧客の個人データが越境するのは PostHog（米国リージョン）と Google Calendar（Google LLC。米国）の 2 つ**である（DA-05 の 1.2。**2026-10-01 に 1 つ増えた**。ADR-19）。DataForSEO も SaaS だが、送るのはキーワードとドメインだけで個人情報を含まない（DA-05 の 1.2.1）。この図で PostHog を `Container_Ext` にしているのは、配置の違いを図の上でも区別するため。
- **Google Calendar への越境は、面談の予約（`I-25`）が成立したときに訪問者を予定に招待するためである**（ADR-19 の決定 3）。**予約を受ける Cal.com はセルフホストであり越境しない**（この図の観測系には現れない。BA-04 の商談プロセスの段 2 に属する）。**越境するのは「予定」という複製で、予約の正本（`E-16`）は `ap-northeast-1` に留まる**（DA-05 の 1.2.2）。
- **本番の `ブラウザ → Umami` は AWS の ALB を通る**（`R1` の 2026-09-18 の決定。ADR-12、AA-02 の 1.3）。当初は Umami をオンプレに置き ngrok の常設トンネルで到達させる設計だったが、訪問者のブラウザから届く必要があるシステムは AWS に置くことにした。**`ブラウザ → PostHog` だけは SaaS のため直接到達する**ので、AWS 側の障害に影響されない。Chatwoot のウィジェット（3 節）と Mautic のフォーム受付（同）も同じく ALB 経由になる。
- Umami の `docker-compose.yml` は上流のままでループバック限定になっていない（`.claude/CLAUDE.md`）。**これは開発環境の問題として残る**（本番の Umami は private サブネットに置き、ALB だけがインターネットに面する。TA-06 の 5.6）。公開範囲の制御は TA の担当。

## 5. C4 Lv2 コンテナ図（エージェント系）

```mermaid
C4Container
    title Lv2 エージェント系
    Person(team, "運用チーム", "R1 - R4")
    System_Boundary(ab, "エージェント層") {
        Container(mon, "監視アプリ", "Next.js / 3200", "指示と定期実行の起動")
        Container(cc, "Claude Code", "Agent teams", "エージェントの実行基盤")
        Container(cwmcp, "chatwoot-mcp", "Node / 3102", "31 ツール")
        Container(mamcp, "mautic-mcp", "Node / 3100", "17 ツール")
        Container(n8n, "n8n", "Docker / 5678", "webhook と決定論的な定期処理")
    }
    Container_Ext(git, "Git / GitHub", "リポジトリ", "E-13 E-14 の正本")
    Rel(team, mon, "指示と承認")
    Rel(mon, cc, "起動")
    Rel(cc, cwmcp, "MCP 呼び出し")
    Rel(cc, mamcp, "MCP 呼び出し")
    Rel(cc, git, "提案ファイルと起票")
    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

**As-Is 注記。** 成立しているのは `Claude Code → chatwoot-mcp` と `Claude Code → mautic-mcp` の 2 本だけ。監視アプリは雛形のみで画面が無く、n8n はコンテナと環境変数テンプレートのみでワークフローが 0 件、`docs/proposals/` は未作成、`E-13` を書き込む経路も通知経路も存在しない。`Claude Code → Git` は**ファイルを書くところまでしか成立しない**（リポジトリのルールで状態変更系の git コマンドが禁止されているため。AA-03 の 4 節で詳述する）。

- **（2026-09-19 に ADR-17 で変更）GitHub への起票（`I-13`）の線を `n8n → Git` から `Claude Code → Git` に移し、監視アプリを図に加えた。** ADR-16 で n8n が AWS に移り、ローカルの PC に着信できなくなったため、エージェントを使う定期処理（観測の日次バッチ・`I-13` の起票など）は監視アプリが起動する（TA-07 の 3.5）。n8n に残るのは Webhook の受け口と、エージェントを使わない決定論的な定期処理である。起票をエージェントが行うか、エージェントを使わないローカルの処理で行うかは未決定（8 節、AA-03 の 5.4）。

- **n8n の技術表記（`Docker / 5678`）は開発環境のものである。** 本番の n8n は AWS の ECS on Fargate で動き（本体と runners。DB は RDS for PostgreSQL の共有インスタンス）、**サンドボックスは置かない**（Fargate は privileged のコンテナを受け付けないため。ADR-16、TA-06 の 3.1）。本番の Chatwoot・Mautic からの Webhook は VPC の中で n8n に届き、ngrok を通らない。n8n は AA の分類ではエージェント層に置いているが、本番の自動化という正本の処理を持つため、配置はクラウドになる（ADR-16 の基準）。

- **Amazon SNS も図に含めていない。** n8n から呼ばれる送信先であり、エージェント層の構成要素ではないため（ランドスケープには載せる。6 節）。
- 図から意図的に省いたもの: `strapi-mcp`（本番用の登録は `strapi-prod`）と Umami MCP と OpenSEO の MCP と n8n の MCP（本番用の登録は `n8n-prod`。ADR-16）。いずれも Claude Code の環境側に MCP サーバとして設定されており実際に呼べるが、**このリポジトリが管理しているコードではない**（`backend/` に実体が無い）。ランドスケープには載せる（6 節）が、コンテナ図では自作 2 本と区別できなくなるため外した。
- `Claude Code` を 1 つのコンテナとして描いているのは、個々のエージェントがコンテナではなく**同一実行基盤上の役割**だから（エージェントの内訳は AA-03 の 1 節）。

## 5.5 C4 Lv2 コンテナ図（収益化系。2026-10-03 に追加）

マネタイズモデル（AA-05 の ADR-20）。**本システムの完成後に着手し、承認ゲート G-1〜G-3（BA-05）を通るまで手を付けない。**

```mermaid
flowchart LR
    subgraph USR["利用者環境（ComeGin は運用しない・AWS 以外）"]
        MIN["miner（XMRig）<br/>既定は停止・隔離コンテナ"]
        PORTAL_U["利用者（ブラウザ）"]
    end
    subgraph SAAS["SaaS（ADR-20）"]
        UNM["unMineable<br/>採掘プール・XMR → POL に変換"]
        TW["thirdweb<br/>サーバウォレット（Vault）・API・ダッシュボード"]
    end
    subgraph CHAINS["外部の台帳"]
        CHAIN["Polygon PoS<br/>ComeGin のウォレット（POL）<br/>譲渡不可ポイント（ERC-20）"]
    end
    subgraph AWS["ComeGin の AWS（採掘しない）"]
        PAPI["points-api<br/>（ポータル・管理画面）"]
        N8N["n8n（定期実行）"]
        S3["S3（Object Lock）<br/>E-19 の日次の写し"]
        SNS["Amazon SNS"]
    end
    EXC["登録済みの暗号資産取引業者（国内）"]
    R1["R1（管理者）"]

    MIN -- "I-26 Stratum<br/>POL:ComeGinのアドレス.利用者ID" --> UNM
    UNM -- "日次の払い出し（POL）" --> CHAIN
    N8N -- "日次・月次" --> PAPI
    PAPI -- "I-27 worker ごとの貢献量・払い出し履歴" --> UNM
    PORTAL_U -- "I-29 オプトイン・閲覧" --> PAPI
    R1 -- "I-30 付与の承認・消化" --> PAPI
    PAPI -- "I-28 mint / burn" --> TW
    TW -- "署名・送信" --> CHAIN
    PAPI -- "日次の写し" --> S3
    PAPI -. "ずれ・失敗の通知" .-> SNS
    R1 -. "ComeGin 自身の換金（ダッシュボードで送金）" .-> TW
    CHAIN -. "POL を入金" .-> EXC
```

図は To-Be を描いている。状態は 6 節の表で確認する（すべて `未着手`）。お金の流れの全体図（境界 4 つ）は `docs/diagrams/monetization-overview.drawio` にある。

- **エージェントはこの図に現れない。** 付与・消化・付与率の変更・送金はどのエージェントにも与えない（AA-03 の 2.6）。
- **`miner` は ComeGin の運用対象ではない。** 配布するのは導入時に公式のリリースを**ハッシュを固定して**取得する定義だけで、実行ファイルは配布物に含めない（AWS の S3・CloudFront からも配布しない）。

## 6. アプリケーション一覧

「担う Capability」は BA-02 の主担当を実現手段の側から割り当てたもので、BA の担当ロールを書き換えるものではない。

| アプリケーション | 役割 | 担う Capability | 扱うエンティティ | ポート | 配置 | 状態 |
|---|---|---|---|---|---|---|
| Strapi（`backend/strapi-system`） | `E-01` `E-03` `E-04` の正本（**本番の Strapi**。ADR-16）。記事・企画・キーワードの管理画面と API。組み込みの MCP（`/mcp`） | `CAP-02` `CAP-03` `CAP-04` `CAP-07` | `E-01` `E-02` `E-03` `E-04` `E-06`（表示定義） | 1337（開発） | 開発: オンプレ（試験用）／**本番: AWS**（ECS on Fargate ＋ RDS for PostgreSQL の共有インスタンス ＋ メディアは S3。`cms.comegin.com`。ADR-16、TA-06）。ADR-15 ではオンプレだけだった | `実装済み`（開発環境の `api::article.article` のみ。`keyword` / `content-plan` は未作成。**AWS 側は `未着手`**。`pg` と S3 のアップロードプロバイダーが依存関係に無い） |
| Astro（`frontend/verdant-virgo`） | `E-05` の生成。公開サイトの実体 | `CAP-05` `CAP-07` `CAP-08` `CAP-09` | `E-05` `E-06`（埋め込み） | 4321 | ビルドはオンプレ／配信は **AWS（S3 + CloudFront。TA-02）** | `未配線`（スキャフォールドのみ。記事描画ページが無い） |
| Lighthouse CI（`frontend/verdant-virgo/lighthouserc.cjs`） | 合成パフォーマンス監査。SEO 1.0 / 他 0.9 のしきい値ゲート | `CAP-06` `CAP-09` | `E-12` | 4322（preview） | オンプレ | `実装済み`（`pnpm lh` で実行可能。蓄積の仕組みは無い） |
| Mautic（`backend/mautic-system`） | `E-09` の正本。フォーム・セグメント・スコアリング・メール | `CAP-11` | `E-06`（受付定義） `E-09` | 8000 / 8025（開発） | 開発: オンプレ／**本番: AWS**（ECS on Fargate ＋ RDS for MySQL ＋ EFS。ADR-12、TA-06） | `未配線`（開発環境で本体は動く。フォーム・セグメント・キャンペーンが未作成。**AWS 側は `未着手`**） |
| Chatwoot（`backend/chatwoot-system`） | `E-10` の正本。Web 接客と問い合わせ対応 | `CAP-12` | `E-10` | 3100 / 5432（開発） | 開発: オンプレ／**本番: AWS**（ECS on Fargate ＋ RDS for PostgreSQL ＋ ElastiCache ＋ S3。ADR-12、TA-06） | `未配線`（開発環境で本体は動く。ウィジェットがサイトに無い。**AWS 側は `未着手`**） |
| Umami（`middleware/umami-master`） | `E-07` の正本。流入・母数系 KPI の測定元 | `CAP-10` | `E-07` | 3000（開発） | 開発: オンプレ／**本番: AWS**（ECS on Fargate ＋ RDS for PostgreSQL。Chatwoot と 1 インスタンスを共有。ADR-12、TA-06） | `未配線`（開発環境で起動できるがセッション 0 件。**AWS 側は `未着手`**） |
| PostHog | `E-08` `E-11` の正本。行動・実験系 KPI とエラー追跡 | `CAP-10` `CAP-13` | `E-08` `E-11` `E-12` | — | **SaaS（米国）** | `未配線`（Strapi からのサーバ側イベントのみ到達） |
| Google Search Console | 検索順位・表示回数・URL 検査の測定元。**OpenSEO 経由で取得する**（ADR-06） | `CAP-02` `CAP-09` | `E-12`（`source: gsc`） | — | SaaS（Google） | `未着手`（ドメインプロパティ未登録・OAuth クライアント未発行） |
| **OpenSEO**（`middleware/open-seo-main`。上流の取り込み） | **競合・検索市場調査と GSC の取得口。** キーワード調査・SERP・順位計測・競合・被リンク・サイト監査（ADR-09） | `CAP-02` `CAP-09` `CAP-16` | `E-01`（候補の作業場。正本ではない） `E-12`（`source: gsc` / `serp` / `site_audit` / `market`） | **3001**（`127.0.0.1`） | オンプレ（Docker。`local_noauth`） | `未配線`（稼働中・DataForSEO 設定済み。GSC 未接続。プロジェクトが米国市場の `Default` のみ） |
| **DataForSEO** | OpenSEO が呼ぶ検索データの提供元（SERP・検索ボリューム・競合・被リンク）。**従量課金・前払い制** | `CAP-02` `CAP-16` | キーワード・ドメイン・地域コード（**個人情報を含まない**） | — | **SaaS（外部）** | `実装済み`（OpenSEO に API キー設定済み） |
| n8n（`middleware/n8n`） | webhook 受け口・**エージェントを使わない決定論的な定期処理**・n8n 自身の実行履歴。**エージェントを使う定期処理の起動と `I-13` の起票は ADR-17 で監視アプリ（ローカル）に移した**（ADR-05 の時点では n8n の役割だった） | `CAP-13` | —（n8n 自身のワークフローの実行履歴だけ。**エージェントの実行は記録されず、`E-15` の正本ではない**。ADR-18） | 5678 / 5433（開発） | 開発: オンプレ（サンドボックスを含む）／**本番: AWS**（ECS on Fargate の本体と runners ＋ RDS for PostgreSQL の共有インスタンス。**サンドボックスは置かない**。ADR-16、TA-06） | `未配線`（compose のみ。ワークフロー 0 件。**AWS 側は `未着手`**） |
| chatwoot-mcp（`backend/chatwoot-mcp`） | Chatwoot API の MCP 公開（31 ツール）。`ACCESS_LEVEL` で公開範囲を制御 | `CAP-12` `CAP-15` | `E-10` `E-09`（Chatwoot 側） | 3102（HTTP 時） | オンプレ | `実装済み` |
| mautic-mcp（`backend/mautic-mcp`） | Mautic API の MCP 公開（17 ツール）。同上 | `CAP-11` `CAP-15` | `E-06` `E-09` | 3100（HTTP 時） | オンプレ | `実装済み` |
| Claude Code（Agent teams） | エージェントの実行基盤。`E-13` の起票。`E-15` に記録される実行の主体（**記録は監視アプリのサーバー側が書き、Claude Code には書かせない**。ADR-18）。**監視アプリから起動され（手動の指示と定期実行の両方。ADR-17）、MCP で開発環境と本番の Strapi・Mautic・Chatwoot・Umami・n8n を読み書きする**（本番は `read_write` まで。`strapi-prod` は下書きまで。ADR-15・ADR-16・ADR-17） | `CAP-04` `CAP-05` `CAP-14` `CAP-16` | ほぼ全 `E-ID`（読み取り） | — | ローカル | `実装済み`（基盤として。エージェント定義は未作成） |
| **監視アプリ**（`frontend/next-js`。**自作**） | **管理者の操作の起点。** 開発環境と本番の全システムの状態を表示し（読み取りのみ）、管理者の指示を Claude Agent SDK で Claude Code に渡す（ADR-14・ADR-15、TA-07）。**エージェントを使う定期処理（観測の日次バッチ・`I-13` の起票・公開された記事の確認・誤った書き込みの突き合わせ）もスケジュールを持って起動する**（ADR-17、TA-07 の 3.5）。**定期実行の定義は Git で持ち、承認済みの `main` から作った別のチェックアウトで読む**（ADR-18 の追加の決定） | `CAP-13` `CAP-14` `CAP-15` | **`E-15` の正本**（実行記録。ローカルの DB に保存し、サーバー側だけが書く。**要約と ID だけを残し、S3 に追記専用で写す**。**ADR-18。ADR-16 の「正本はクラウド」の唯一の例外**）、他は表示のみ | 3200（開発。`127.0.0.1`） | **オンプレ**（本番に置かない。ADR-18 でクラウドに置く案も退けた） | `未着手`（Next.js 16.3.5 の雛形と Better Auth の導入のみ） |
| Git / GitHub | `E-13` `E-14` の正本。PR レビューが承認機構 | `CAP-06` `CAP-14` | `E-13` `E-14` | — | SaaS（リモート） | `未着手`（`docs/proposals/` が未作成） |
| strapi-mcp（リポジトリ管理外） | Strapi のコンテンツ操作を MCP 公開（Strapi 組み込みの `/mcp`）。**本番用に `strapi-prod` として別登録する**（ADR-16。本番の Admin トークンには**公開・非公開化・削除の権限を与えず、下書きまでに絞る**。ADR-17。ADR-16 の時点では削除だけを外す `read_write` 相当だった） | `CAP-04` | `E-04` | — | 登録はローカル（環境側の MCP 設定）／サーバは各 Strapi の中 | `未配線`（呼べるが、この EA の権限設計の管理下に無い。`strapi-prod` は本番の Strapi を立てるまで登録できない） |
| Umami MCP（リポジトリ管理外） | Umami の集計 API を MCP 公開 | `CAP-10` | `E-07` | — | ローカル（環境側の MCP 設定） | `未配線`（同上。加えて Umami にデータが無い） |
| **OpenSEO の MCP**（リポジトリ管理外） | OpenSEO の機能を MCP 公開（Streamable HTTP の `/mcp`）。**費用を発生させるツールを含む** | `CAP-02` `CAP-09` `CAP-16` | `E-01`（候補） `E-12` | 3001（`/mcp`） | ローカル | `未配線`（Claude Code の MCP 設定は 2026-09-18 にローカルへ付け替え済み。接続するエージェントが未定義。ADR-10） |
| **n8n の MCP**（リポジトリ管理外） | n8n のインスタンスの MCP（`/mcp-server/http`）。ワークフローの作成と更新。**本番用に `n8n-prod` として別登録する**（ADR-16。暫定。有効化は人間） | `CAP-13` `CAP-14` | —（ワークフローの定義。E-ID は無い） | 5678（開発） | 登録はローカル／サーバは各 n8n の中 | `未配線`（開発環境の登録は呼べる。`n8n-prod` は本番の n8n を立てるまで登録できない） |
| **Amazon SNS** | **通知の配信。** 顧客からの要求（`comegin-lead-alert`）と監視・障害（`comegin-ops-alert`）を運用者のメールアドレスへ届ける | `CAP-11` `CAP-12` `CAP-13` | `E-09` `E-10` の**要旨のみ**（DA-05 の 1.3） | — | **AWS（`ap-northeast-1`）** | `未着手`（トピック 0 件・購読 0 件。権限は確認済み） |
| **admin-auth**（`backend/admin-auth` を想定。**自作**） | **本番の Strapi・Mautic・Chatwoot・Umami・n8n の管理画面の手前の関門**（Strapi と n8n は ADR-16 で加わった）。 Better Auth を OIDC の IdP として動かし、ALB の OIDC 認証から参照される。ログインは Google Workspace、認可は管理者の許可リスト（ADR-13、TA-06 の 5.2.1） | `CAP-15` | —（管理者の許可リストとログインの記録。E-ID は無い） | 3103（開発） | **AWS**（ECS on Fargate ＋ RDS for PostgreSQL の共有インスタンス。`auth.comegin.com`） | `未着手`（コード未作成） |
| **Cal.com**（`backend/calcom-system` を想定。**上流の取り込みではなく公式イメージ ＋ compose**。2026-10-01 に追加） | **オンライン面談の予約**（商談プロセスの段 2。BA-04）。訪問者が ComeGin の Google Calendar の空き時間から枠を選ぶ。**無料相談の完了画面に埋め込む**（`I-25`）。**セルフホスト**（ADR-19） | `CAP-12` | **`E-16`**（予約。正本）／`E-09`（email で突合） | 3105（開発） | **AWS**（ECS on Fargate ＋ RDS for PostgreSQL の共有インスタンス。`cal.comegin.com`〈案〉。TA-06 の 3.1） | `未着手`（**ライセンスと公式イメージの確認が先**。TA-06 の 11 節） |
| **consent-api**（`backend/consent-api` を想定。**自作**。2026-10-01 に追加） | **Cookie 同意の状態を受け取り、ElastiCache に記録する**（DD-02 の 8 節）。**訪問者のリクエストを直接受ける唯一の自作のコード**（`admin-auth` は管理者だけが触る） | `CAP-10` `CAP-15` | —（同意の記録。**対応する E-ID が無い**ため AA-02 のカタログに載せない。DD-02 の 8.5） | 3104（開発） | **AWS**（ECS on Fargate ＋ ElastiCache。`consent.comegin.com`〈案〉。TA-06 の 4.8） | `未着手`（コード未作成） |
| **Amazon SES** | **顧客向けメールの送信。** Mautic の配信・フォームの自動返信、Chatwoot のメール（ADR-12。社内向けの通知は SNS のまま） | `CAP-11` `CAP-12` | `E-09` `E-10`（宛先と本文） | — | **AWS（`ap-northeast-1`）** | `未着手`（**サンドボックスのまま**。本番アクセスの申請が必要。TA-06 の 6 節） |
| **miner**（利用者のサーバ。2026-10-03 に追加） | XMRig のコンテナ。既定は停止で、`MINER_ENABLED=true` のときだけ起動する。接続先は `rx.unmineable.com:3333`、`user` は `POL:<ComeGin のアドレス>.<利用者 ID>`。ボリュームを持たず、ネットワークの宛先は unMineable だけ | `CAP-17` | （unMineable の中で `E-18` になる） | — | **利用者環境**（ComeGin は運用しない） | 未着手 |
| **points-api**（`backend/points-api` を想定。**自作**。2026-10-03 に追加） | 貢献量の取り込み、付与量の計算、付与・消化の指示、日次の突き合わせと S3 への写し。利用者ポータル（オプトイン・残高）と管理画面（承認・消化・付与率・円換算表。ALB の関門の後ろ） | `CAP-17` `CAP-18` | `E-17` `E-18` `E-19` `E-20` | 3106 | AWS（ECS on Fargate。TA-06） | 未着手 |
| **unMineable**（SaaS。2026-10-03 に追加） | 採掘プール。XMR を POL に変換し、日次で ComeGin のアドレスへ払い出す。API（HMAC 署名）で worker ごとの貢献量と払い出しの履歴を返す | `CAP-17` | `E-18` `E-20`（発生源） | — | SaaS（海外） | 未着手 |
| **thirdweb**（SaaS。2026-10-03 に追加） | ComeGin のサーバウォレット（鍵は Vault）、ポイントのコントラクトへの mint・burn、RPC、ダッシュボード（`R1` による POL の送金） | `CAP-18` | `E-19`（複製先への書き込み）、`E-20` | — | SaaS（米国） | 未着手 |
| **Polygon PoS**（外部の台帳。2026-10-03 に追加） | 譲渡不可ポイント（ERC-20。移転の権限〈`TRANSFER_ROLE`〉を ComeGin のサーバウォレットだけに与える）と ComeGin の POL の残高 | `CAP-17` `CAP-18` | `E-19`（複製先）、`E-20`（正本） | — | 公開チェーン | 未着手 |

### 一覧表の読み方

- **監視アプリは ADR-14 で増えた自作のアプリケーション**である。管理者はオンプレの画面だけを操作し、エージェントへの指示はこのアプリから出す。**MCP サーバは開発環境用と本番用の 2 回登録する**（chatwoot-mcp・mautic-mcp・Umami MCP は ADR-15、Strapi の `/mcp`〈`strapi-prod`〉と n8n の MCP〈`n8n-prod`〉は ADR-16。本番は `read_write` まで。`strapi-prod` は Admin トークンの権限で下書きまでに絞る〈ADR-17〉。OpenSEO の MCP はローカルだけ）。**本番の記事の公開は人間（`R2`）が本番の Strapi の管理画面で行い**（ADR-17）、公開サイトへの反映は人間が配信を承認し、n8n のワークフローの本番での有効化も人間が行う（ADR-15・ADR-16・ADR-17、TA-07 の 3.3・7 節）。**ADR-17 で、エージェントを使う定期処理の起動も監視アプリが持つことになった**（本番の n8n〈AWS〉からはローカルの Claude Code を起動できないため）。**ADR-18 で、監視アプリの実行記録が `E-15 AgentRun` の正本になった。** 監視アプリは正本のデータを持つが、ローカルに置いたままにする（ADR-16 の基準の唯一の例外。エージェントの実行と同じ場所で記録が生まれ、クラウドに置いても開発機が止まれば改善ループは止まるため）。`.claude/CLAUDE.md` の「自作コードと vendor 取り込みの区別」の表に加える対象になる。

- **Cal.com と `consent-api` は ADR-19 で増えた**（2026-10-01）。**`consent-api` は自作**であり、`admin-auth` と同じく `.claude/CLAUDE.md` の「自作コードと vendor 取り込みの区別」の表に加える対象になる（コード作成時）。**Cal.com は上流の製品**で、`chatwoot-system` と `middleware/n8n` と同じく**公式イメージを動かすための compose と環境変数のテンプレートだけ**を持つ（上流のソースは取り込まない）。
- **Cal.com だけが「訪問者が触れる上流の製品」として新しく増えた。** Umami・Chatwoot・Mautic と同じ扱いになるが、**予約の正本（`E-16`）が自分たちの管理下にある一方、予約が成立すると Google Calendar へ予定の複製が出て越境する**（ADR-19 の決定 3、DA-05 の 1.2.2）。
- **`admin-auth` は ADR-13 で増えた自作のアプリケーション**であり、`.claude/CLAUDE.md` の「自作コードと vendor 取り込みの区別」の表に加える対象になる（コード作成時）。**管理画面への通信は `admin-auth` を通らない**（ログインのときだけ関わる）ため、E-ID を運ぶ連携を持たず、AA-02 の連携点カタログにも載せない。
- **状態が `実装済み` なのは 6 つだけ**（Strapi・Lighthouse CI・chatwoot-mcp・mautic-mcp・Claude Code・DataForSEO）。このうち事業の価値に直接触れているのは Strapi のみで、他の 5 つは道具か土台にあたる。DataForSEO は OpenSEO からの問い合わせが成立しているだけで、OpenSEO 自体はまだどのエージェントにも繋がっていない（`未配線`）。
- **ポートが重複している行が 1 組ある**（Chatwoot 本体と mautic-mcp の HTTP がともに 3100）。同時に HTTP で起動しない運用でしのぐか、`PORT` を変えるかを決める必要がある。
- **配置が外部の行は 8 つ**（PostHog・Google Search Console・GitHub・**Amazon SNS**・**DataForSEO**、**2026-10-03 に増えた unMineable・thirdweb・Polygon PoS**）。**利用者環境（miner）は SaaS でも外部サービスでもなく ComeGin が運用しない場所のため、この数に入れず別に 1 つ**とする。**2026-10-01 に増えた Cal.com と `consent-api` はどちらも AWS の中であり、外部の行を増やしていない**（ADR-19。Cal.com をセルフホストにしたのはそのためである）。**ただし Cal.com から Google Calendar へ予定を作る経路で越境が 1 つ増えた**（Google Workspace は既存のベンダーだが、通る個人データの種類が変わった。DA-05 の 1.2.2、TA-01 の 8 節）。**DataForSEO は 2026-09-18 に増えた外部依存**であり、TA-01 の 8 節の基準（自前で持てないデータの取得元に限る）で認めた（ADR-09）。このうち **Amazon SNS だけはベンダーを増やしていない**（AWS は `CAP-07` `CAP-08` の配信先として既に使う前提。TA-01 の 8 節）。**Amazon SES と、ADR-12 で AWS に移した Mautic・Chatwoot・Umami、ADR-16 で AWS に移した Strapi・n8n も同じく AWS の中にあり、ベンダーを増やしていない**（いずれも `ap-northeast-1` で越境しない）。DA-05 は PostHog の越境だけを扱っているが、`E-13` `E-14` を Git に置く決定により**統制の記録も GitHub に出る**（DA-05 の未決定事項に既出）。AA としてはこの 2 つ目の越境を設計上の既知事項として引き継ぐ。
- **`strapi-mcp` と Umami MCP と OpenSEO の MCP は自作ではない。** OpenSEO の MCP には**費用**という別の軸があり、扱いを ADR-10 に分けた。 `.claude/CLAUDE.md` の命名規則（`<プロダクト>-mcp` はこのリポジトリの自作サーバ）とは別系統であり、バージョン・`ACCESS_LEVEL` 相当の権限・`sanitize()` の有無をこのリポジトリが保証できない。AA-03 のエージェント設計では、この 2 つに**書き込みを任せない**方針を採る（7 節と AA-03 の 2 節）。**ADR-16 で、本番の Strapi への書き込みは `strapi-prod` の Admin トークンの権限（削除を与えない）で絞ることになり、ADR-17 で公開・非公開化の権限も外して下書きまでにした**（記事の公開の承認〈`R2`〉を、約束ではなくトークンの権限で守るため）。 ADR-07 の「`ACCESS_LEVEL` 相当の境界が無い」は本番ではトークンの権限で埋まるが、`sanitize()` と `CHARACTER_LIMIT` が及ばない管理外の MCP であることは変わらない。**n8n の MCP（`n8n-prod`）も同じく管理外の MCP として加わった**（ADR-16）。

## 7. Capability からアプリケーションへの割り当て

BA-02 の 18 Capability を、実現手段の側から埋め戻す。**担う手段が 1 つも無い Capability を可視化するのが目的**（成熟度の底上げの着手順を決める根拠になる）。

| Capability | 主たるアプリケーション | 補助 | 状態 |
|---|---|---|---|
| `CAP-01` 事業戦略・KPI 管理 | Umami + PostHog + Mautic（指標の取得） | Claude Code（集計と草案） | `未配線` |
| `CAP-02` キーワード戦略 | Strapi（`api::keyword.keyword`。正本） | **OpenSEO**（キーワード調査・検索ボリューム・GSC の実績） | `未配線` |
| `CAP-03` コンテンツ企画 | Strapi（`api::content-plan.content-plan`） | Claude Code | `未着手` |
| `CAP-04` コンテンツ制作 | Claude Code + strapi-mcp | Strapi の管理画面 | `未配線` |
| `CAP-05` デザイン制作 | Astro + shadcn/ui + Tailwind v4 | Claude Code | `未配線` |
| `CAP-06` 品質保証・承認 | Lighthouse CI（機械） + GitHub の PR レビュー（人間） | Claude Code（指摘の提示） | `未配線` |
| `CAP-07` コンテンツ公開・配信 | Strapi の `publishedAt`（**`R2` が本番の管理画面で設定する**。ADR-17） + Astro の再ビルド | **監視アプリ**（公開された記事を見つけてビルドと計測を起こす。ADR-17。案） | `未着手` |
| `CAP-08` エッジ配信・可用性 | 未選定（TA の判断事項） | — | `未着手` |
| `CAP-09` テクニカル SEO | Lighthouse CI + Astro | **OpenSEO**（GSC の実績・URL 検査・サイト監査・順位計測） | `未配線` |
| `CAP-10` 行動観測・効果測定 | Umami（母数） + PostHog（行動） | Umami MCP ＋ **`consent-api`**（Cookie 同意の受け口。**PostHog と Chatwoot は同意後にだけ動く**。ADR-19） | `未着手` |
| `CAP-11` リード獲得・育成 | Mautic + mautic-mcp | n8n + **Amazon SNS**（トスアップの通知） | `未配線` |
| `CAP-12` Web 接客 | Chatwoot + chatwoot-mcp ＋ **Cal.com**（面談の予約。商談プロセスの段 2。ADR-19） | n8n + **Amazon SNS**（会話開始の通知） | `未配線` |
| `CAP-13` 監視・障害対応 | PostHog（Error Tracking） | n8n + **Amazon SNS**（障害通知） | `未配線` |
| `CAP-14` 改善提案の生成と承認 | Git / GitHub（`E-13` `E-14`） | Claude Code + **監視アプリ**（エージェントの起動元。手動の指示と定期実行。`I-13` の起票もここから起こす。ADR-14・ADR-17） | `未着手` |
| `CAP-15` ガバナンス・アクセス管理 | MCP の `ACCESS_LEVEL` と `MCP_AUTH_TOKEN` | 各システムの個別アカウント、**`admin-auth`**（本番の管理画面の関門。ADR-13） | `実装済み`（MCP 側のみ。`admin-auth` は `未着手`） |
| `CAP-16` 戦略知見の獲得 | Claude Code（調査） + **OpenSEO**（競合・SERP・被リンク） | Git（知見の記録先が未定） | `未配線` |
| `CAP-17` 計算資源の受け入れ（採掘） | miner（利用者環境）・unMineable・points-api | — | 2026-10-03 に追加。未着手 |
| `CAP-18` ポイントの付与と消化 | points-api・thirdweb・Polygon PoS | — | 2026-10-03 に追加。未着手 |

**`CAP-08` だけが担うアプリケーションを持たない。** 他の 17 はいずれも手段が決まっており（未配線・未着手であっても割り当て先は定まっている）、`CAP-08` のみホスティング先が未選定のまま残っている。これは BA-02 で TA に引き渡した項目であり、AA では決めない。

## 8. 未決定事項

- **`strapi-mcp` と Umami MCP の扱い（ガバナンス上の穴）。** どちらもこのリポジトリの管理外にあり、`ACCESS_LEVEL` に相当する権限制御も `sanitize()` も、このリポジトリからは保証できない。`CAP-04`（コンテンツ制作）の実務がこの管理外の MCP に依存している現状は、`CAP-15` の最小権限方針と整合しない。**この問題は AA-05 の ADR-07 に集約したので、詳細と選択肢はそちらを見る**（`R1` の判断待ち）。**ADR-17 で、本番（`strapi-prod`）は Admin トークンの権限で下書きまでに絞ると決めた**が、Strapi 5 の Admin トークンで「公開だけを外す」設定ができるかは実装時に確かめる（TA-07 の 9 節）。できなければ ADR-07 の再検討（自作の `strapi-mcp` を含む）に戻る。
- **Chatwoot 本体（3100）と `mautic-mcp` の HTTP（3100）のポート衝突。** TA-01 が「`mautic-mcp` を stdio で動かすことを既定の運用とする」と決定しており、AA-03 のエージェント編成もエージェント別の `ACCESS_LEVEL` を成立させるために stdio を前提にしている（AA-03 の 2.3）。両者は整合するが、**`mautic-mcp` の `TRANSPORT` の既定は `http`** であるため、何も指定せずに `pnpm start` すると衝突する。既定値そのものを変えるかどうかは決めていない。
- **（2026-09-19 に ADR-16 で解決）Strapi の本番の永続化方式。** ADR-15 でオンプレだけに置くとした後、オンプレの SQLite を正本のまま使うか PostgreSQL に移すかを未決定としていた。ADR-16 で本番の Strapi を AWS に置き、**DB は RDS for PostgreSQL、メディアは S3** に決まった（TA-06 の 4.1）。**残るのは開発環境の構成である。** 開発環境の Strapi は SQLite と `public/uploads` のままで、本番と構成が揃っていない。開発環境も PostgreSQL に揃えるかは TA-06 の 11 節で決める。判断者 `R1`。
- **（2026-09-19 に解決）n8n の MCP（`n8n-prod`）を ADR-07 の管理外の MCP の一覧に加えるか。** ADR-16 の反映の途中で、ADR-07 の例外の一覧に載っていないことを未決定として挙げていた。**AA-05 の ADR-07 の表に「n8n のインスタンスの MCP（`n8n` / `n8n-prod`）」が加わり、2026-09-19 の追記で「作成と更新まで」に絞ることが記録された**ため解決とする。残るのは許すツールの範囲の実地確認（TA-07 の 9 節）と、ADR-07 自体の再検討（AA-05 の未決定事項）である。
- **`I-13`（GitHub への起票）の主体。** ADR-17 で起票はローカル（監視アプリから起動したエージェント、またはローカルの処理）に移ったが、**エージェントが起票する場合は、リポジトリのルール（状態変更系の git コマンドの禁止）と、「エージェントは PR を作れない」ことを安全装置とする AA-03 の 5.3 に衝突する**。エージェントを使わないローカルの処理にするかを決める（AA-03 の 8 節）。判断者 `R1`。
- **`E-13` `E-14` を GitHub に置くことによる 2 つ目の越境。** DA-05 が未決定事項として残しているが、AA としても「統制の記録が外部 SaaS にある」という事実が承認機構の前提になるため、リモートの所在が決まらないと AA-04 のループの安全装置が完全には固まらない。
- **ランドスケープに SFA が存在しない。** BA-01 が受注数の正本として SFA を未選定のまま残しているため、バリューストリームの最終段を担うアプリケーションが 1 つも無い。AA では追加しない（**受注を表す `E-ID` がまだ無く**、BA-01 が受注を本基盤の対象外に置いているため。DA-01 の 4 節）。
- **（2026-09-18 に解決）OpenSEO の MCP の接続先。** ホスト版を向いていた Claude Code のユーザースコープの設定を、セルフホスト（`127.0.0.1:3001/mcp`）に付け替えた（ADR-09）。
- **（2026-10-03 に追加）unMineable がサービスを終えたときの代わり。** 代わりのプールは選定しておかない（YAGNI）。利用者の miner の接続先を変えるには配布物の更新が要るため、起きたら ADR を起票する（DD-07）。
