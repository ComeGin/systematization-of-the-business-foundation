# 01. デプロイメント配置図

TA（Technology Architecture）層。ロール ID・Capability ID・エンティティ ID は EA 共通用語集の定義をそのまま使う。
ファイルパスは `MarketingDepartment/WebsiteOperations/` を起点とした相対で書く。

## 1. 配置の原則

**クラウドに展開するのは製品（Astro のビルド成果物）のみ。それ以外の構成要素はすべてオンプレミスに置く。**

この制約は本層の設計の出発点であり、以降のすべての判断がここから導かれる（配信するものと運用するものを分けることで、**常時すべての訪問者に開いている面を「静的ファイルの配信」1 点に絞り込める**。運用基盤の側は既定では外部に面しておらず、必要な経路だけをトンネルとして明示的に開く形になる。開いた経路は 7 節で 1 本ずつ列挙できる数に収まる）。

| 層 | 対象 | 配置先 | 状態 |
|---|---|---|---|
| 製品 | Astro のビルド成果物（`E-05` `Page`） | AWS（S3 + CloudFront）。設計は TA-02 | `未着手` |
| 制作・配信の裏側 | Strapi（`E-04` の正本）、Mautic、Chatwoot、Umami、n8n、MCP サーバ、**OpenSEO** | オンプレミス（開発機のローカルホスト） | `実装済み`（各スタックは起動できる） |
| 観測の一部 | PostHog | SaaS（行動観測の例外。後述） | `部分的` |
| **検索データの取得元** | **Google Search Console、DataForSEO**（どちらも OpenSEO から呼ぶ） | SaaS（**自前で持てないデータの取得元**。8 節） | `部分的`（DataForSEO のみ設定済み） |
| 監査 | Lighthouse CI | オンプレミス（結果は `frontend/verdant-virgo/.lighthouse/`） | `実装済み` |
| **通知** | **Amazon SNS**（`comegin-lead-alert` / `comegin-ops-alert`） | **AWS（`ap-northeast-1`）。設計は ADR-08** | `未着手` |

**通知が AWS にあるのは原則の例外ではなく、原則からの要請にあたる。** 「製品のみクラウド」は**展開するもの**についての原則であり、SNS は展開するシステムではなくマネージドサービスの呼び出しである。加えて決定的な理由がある。**通知経路がオンプレにあると、オンプレが落ちたときに「落ちた」という通知も届かない**（監視対象が通知経路を兼ねる。TA-05 の 4 節）。監視を成立させるには、通知経路だけはオンプレの外に無ければならない。**ベンダーは増えていない**（AWS は製品の配信先として既に使う前提。8 節）。

「オンプレミス」はここでは**専用のデータセンターではなく、運用担当者の開発機**を指す。構成上の意味は「AWS 以外のどこか」ではなく「**インターネットから直接は到達できず、到達させたい経路だけをトンネルで明示的に開く場所**」である（この定義が後述のバインドアドレスの表と、7 節の ngrok による露出の両方に直結する。ループバックバインドが既定であり、外部から見える経路はトンネルとして 1 本ずつ定義した分だけ存在する、という構造になっている）。

## 2. 図 1 配置境界の全体像（To-Be）

```mermaid
flowchart TB
    VIS["サイト訪問者"]
    subgraph AWS["AWS 製品の配信のみ"]
        CDN["静的サイト配信<br/>S3 + CloudFront"]
    end
    subgraph ONPREM["オンプレミス"]
        OPS["運用基盤<br/>Strapi / Mautic / Umami<br/>Chatwoot / n8n / MCP / OpenSEO"]
    end
    PH["PostHog<br/>行動観測の SaaS"]
    SRC["GSC と DataForSEO<br/>検索データの取得元"]
    VIS -->|"HTTPS で閲覧"| CDN
    OPS -->|"デプロイ"| CDN
    OPS -->|"イベント送信"| PH
    OPS -->|"検索データを取得"| SRC
```

図は To-Be を描いている。**As-Is では AWS 境界の中身が存在しない**（`cloud/` は空ディレクトリで、公開サイトそのものが無い）。現在実際に動いている線は「運用基盤 → PostHog」と「運用基盤 → 検索データの取得元」（OpenSEO → DataForSEO。API キー設定済み）の 2 本で、前者はこれは Strapi のライフサイクル購読と例外送信にあたる（`backend/strapi-system/src/index.ts`、`backend/strapi-system/src/middlewares/posthog-error.ts`）。訪問者の線は届く先が無い。

## 3. 図 2 オンプレミス側の内訳（To-Be）

```mermaid
flowchart LR
    N8N["n8n<br/>5678"] --> STRAPI["Strapi<br/>1337"]
    N8N --> CMCP["chatwoot-mcp<br/>3102"]
    N8N --> MMCP["mautic-mcp<br/>stdio"]
    CMCP --> CW["Chatwoot<br/>3100"]
    MMCP --> MA["Mautic<br/>8000"]
    UM["Umami<br/>3000"]
    SEO["OpenSEO<br/>3001"]
```

図は To-Be を描いている。**As-Is では n8n から出る線が 1 本も存在しない**（ワークフローが 0 件のため。TA-03 の 6 節で詳述する）。MCP サーバから上流 API への線（`chatwoot-mcp` → Chatwoot、`mautic-mcp` → Mautic）だけが実装済みで、これはエージェントが直接 MCP を呼ぶ経路として機能している。

**OpenSEO も孤立しているが、Umami とは理由が違う。** OpenSEO はオンプレの他の構成要素とデータをやりとりしない設計であり（入力は外部の GSC と DataForSEO、読み手は Claude Code の MCP 呼び出しで、どちらもこの図の外）、孤立が正しい状態にあたる。採用したキーワードを Strapi に書くのはエージェントであって OpenSEO ではない（DA-04 の 2 節）。

Umami が図の中で孤立しているのは作図の都合ではなく事実である。**Umami は他のどの構成要素とも配線されていない**（ブラウザ側トラッカーが未設置のため入力が無く、出力を読む経路も未実装）。この孤立は後述のセキュリティ上の非対称（Umami だけが全インターフェースに公開されている）と同じ原因、すなわち上流の compose をそのまま取り込んだまま手を入れていないことに由来する。

## 4. 図 3 境界を越える通信（To-Be）

```mermaid
flowchart LR
    BUILD["Astro ビルド<br/>オンプレ"] -->|"s3 sync 無効化"| CF["S3 CloudFront<br/>AWS"]
    VIS["訪問者のブラウザ"] -->|"無認証"| TUN["ngrok<br/>常設トンネル"]
    OPR["運用者"] -->|"要認証"| TUN
    TUN --> OBS["観測 接客系<br/>Umami Chatwoot Mautic"]
    TUN --> ADM["管理画面<br/>n8n Strapi"]
    STRAPI["Strapi"] -->|"記事 例外"| PH["PostHog SaaS"]
```

図は To-Be を描いている。**As-Is で通っているのは最下段の 1 本（Strapi → PostHog）だけ**である。デプロイ経路は未着手、ngrok のトンネルは設定の受け皿（`middleware/n8n/.env.example` の `N8N_WEBHOOK_URL`、`frontend/verdant-virgo/astro.config.mjs` の `vite.server.allowedHosts`、MCP サーバの `MCP_ALLOWED_HOSTS`）だけが用意されている状態にあたる。Astro dev サーバーの共有（経路 6）のみ実装済みだが、これは開発用であり図には含めていない。

図の中央で 2 本の線が 1 つのトンネル機構に入り、別々の行き先に分かれている点が本層の設計の要点にあたる。**入口が同じで要件が正反対**（訪問者は無認証でなければ到達できず、運用者は認証が無ければ守られない）であるため、この分離は運用の工夫ではなく構成として作り込む必要がある（TA-04 の 7 節）。

## 5. ポート割当

複数スタックを同時に起動する前提で調整済みの割当。新しくポートを使うときはこの表を崩さない。

| ポート | 用途 | 定義箇所 | 状態 |
|---|---|---|---|
| 1025 | Mautic の MailHog（SMTP） | `backend/mautic-system/docker/compose.yaml` | `実装済み` |
| 1337 | Strapi | `backend/strapi-system` | `実装済み` |
| 3000 | Umami | `middleware/umami-master/docker-compose.yml` | `実装済み` |
| **3001** | **OpenSEO**（UI と MCP の `/mcp`） | `middleware/open-seo-main/compose.yaml`（`PORT` の既定。上流のまま） | `実装済み` |
| 3100 | Chatwoot 本体（`CHATWOOT_PORT`） | `backend/chatwoot-system/docker-compose.yaml` | `実装済み` |
| 3100 | **mautic-mcp の HTTP 既定値**（衝突。後述） | `backend/mautic-mcp/src/config.ts` | `実装済み` |
| 3102 | chatwoot-mcp（HTTP 時） | `backend/chatwoot-mcp/src/config.ts` | `実装済み` |
| 3306 | Mautic の MySQL 8.4 | `backend/mautic-system/docker/compose.yaml` | `実装済み` |
| 4321 | Astro dev | `frontend/verdant-virgo` | `実装済み` |
| 4322 | Lighthouse CI が使う preview（固定） | `frontend/verdant-virgo/lighthouserc.cjs` | `実装済み` |
| 5432 | Chatwoot の PostgreSQL（pgvector pg16） | `backend/chatwoot-system/docker-compose.yaml` | `実装済み` |
| 5433 | n8n の PostgreSQL 18 | `middleware/n8n/compose.yml` | `実装済み` |
| 5678 | n8n | `middleware/n8n/compose.yml` | `実装済み` |
| 6379 | Chatwoot の Redis | `backend/chatwoot-system/docker-compose.yaml` | `実装済み` |
| 8000 | Mautic（PHP ビルトインサーバー） | `backend/mautic-system/dev/serve.sh` | `実装済み` |
| 8025 | Mautic の MailHog（UI） | `backend/mautic-system/docker/compose.yaml` | `実装済み` |
| 8026 | Chatwoot の MailHog（UI） | `backend/chatwoot-system/docker-compose.yaml` | `実装済み` |

### 3100 の衝突と回避策

Chatwoot 本体（`CHATWOOT_PORT` の既定 3100）と `mautic-mcp` の HTTP 既定ポート（`backend/mautic-mcp/src/config.ts` の `PORT` 既定 3100）が衝突する。
`mautic-mcp` は `TRANSPORT` の既定が `http` であるため（`chatwoot-mcp` は既定が `stdio` で、2 つのサーバは既定トランスポートが逆）、**何も指定せずに `pnpm start` すると 3100 を掴みにいく**。Chatwoot が先に起動していれば bind に失敗し、起動していなければ後から Chatwoot が失敗する。

採る回避策は次の優先順で決める。

1. **`mautic-mcp` を stdio で動かす**（`pnpm start:stdio`）。エージェントがローカルから使う限り HTTP は不要で、stdio ならポートを一切使わず認証も不要になる（`MCP_AUTH_TOKEN` はトランスポートが HTTP のときだけ必須。`backend/mautic-mcp/src/config.ts` の `refine`）。これを既定の運用とする。
2. HTTP が必要な場合（遠隔のクライアントから使う場合）は **`PORT=3101` を与える**（3101 は本表のどこにも使われていない）。
3. Chatwoot 側の `CHATWOOT_PORT` は動かさない（変更すると `FRONTEND_URL` と Web サイトに埋め込むウィジェットのスクリプト URL まで追随が必要になり、影響範囲が MCP 側の変更よりはるかに広いため）。

## 6. バインドアドレスの非対称

ホストへ公開するポートのバインド先を一覧にする。**Umami だけが全インターフェースに公開されている。**

| ポート | サービス | バインド | 定義箇所 |
|---|---|---|---|
| 3000 | Umami | **`0.0.0.0`（全インターフェース）** | `middleware/umami-master/docker-compose.yml` の `"3000:3000"` |
| **3001** | **OpenSEO** | **`127.0.0.1`** | `middleware/open-seo-main/compose.yaml`（上流のまま） |
| 3100 | Chatwoot（rails） | `127.0.0.1` | `backend/chatwoot-system/docker-compose.yaml` |
| 5432 | Chatwoot の PostgreSQL | `127.0.0.1` | 同上 |
| 6379 | Chatwoot の Redis | `127.0.0.1` | 同上 |
| 8026 | Chatwoot の MailHog | `127.0.0.1` | 同上 |
| 5678 | n8n | `127.0.0.1` | `middleware/n8n/compose.yml` |
| 5433 | n8n の PostgreSQL | `127.0.0.1` | 同上 |
| 3306 | Mautic の MySQL | `127.0.0.1` | `backend/mautic-system/docker/compose.yaml` |
| 1025 / 8025 | Mautic の MailHog | `127.0.0.1` | 同上 |
| 8000 | Mautic（PHP ビルトイン） | `127.0.0.1`（`HOST` の既定） | `backend/mautic-system/dev/serve.sh` |
| （なし） | Umami の PostgreSQL | ホストへ公開しない | `middleware/umami-master/docker-compose.yml` |
| （なし） | n8n の `sandbox-api` / `sandbox-runner-1` / `runners` / `searxng` | ホストへ公開しない | `middleware/n8n/compose.yml` |

n8n・Chatwoot・Mautic の compose にはいずれも「外部ネットワークに公開しないようループバックのみにバインド」というコメントが明示的に付いている。すなわち**この非対称は設計思想の違いではなく、Umami にだけ同じ判断が適用されていないという欠落**である。原因は Umami が上流の compose を無改変で取り込んでいることにある（`middleware/umami-master` は上流 1,677 ファイルをそのまま取り込んでいる）。

**OpenSEO も上流の compose を無改変で使うが、こちらは上流が最初から `127.0.0.1` にバインドしている**（`middleware/open-seo-main/compose.yaml` の `"127.0.0.1:${PORT:-3001}:${PORT:-3001}"`）。上流の作者が「Docker 版は認証が無いので、自分の認証の後ろ以外に出すな」と明記しており（`docs/SELF_HOSTING_DOCKER.md`）、**上流の既定がこの基盤の方針と一致している**。上流無改変という方針とセキュリティ要件が衝突するかどうかは、上流の既定次第で決まる。

この項目を含む Umami の 4 つの課題と、上流無改変の方針との衝突は TA-04 の 3 節で扱う。ここでは配置上の事実として記録するにとどめる。

## 7. 境界を越える通信の一覧

| # | 経路 | 方向 | 内容 | 保護 | 状態 |
|---|---|---|---|---|---|
| 1 | オンプレ → AWS | 送信 | `astro build` の成果物を S3 へ同期し、CloudFront を無効化する | IAM（デプロイ専用の権限）。設計は TA-02 | `未着手` |
| 2 | AWS → オンプレ | 受信 | CloudFront / S3 のアクセスログを回収し `E-12` の材料にする | 取得は読み取りのみ | `未着手` |
| 3 | 訪問者 → AWS | 受信 | 公開サイトの閲覧 | ACM の TLS、AWS WAF | `未着手` |
| 4 | 訪問者のブラウザ → オンプレ（ngrok） | 受信 | Umami のトラッカー配信とイベント受信、Chatwoot ウィジェット、Mautic のフォーム受付とトラッキング | **無認証**（訪問者が到達できないと `CAP-10` が成立しないため）。ngrok の常設トンネル ＋ パス単位の制御。設計は TA-04 の 7 節 | `未着手` |
| 5 | 外部 → オンプレ（ngrok） | 受信 | n8n の Webhook 受け口（`N8N_WEBHOOK_URL`、`N8N_PROXY_HOPS`） | ngrok のトンネル ＋ n8n の Webhook パス | `未配線` |
| 6 | 外部 → オンプレ（ngrok） | 受信 | Astro dev サーバーの共有（`comegin-astro-dev.ngrok.app`） | Vite の `allowedHosts` による Host 照合 | `実装済み` |
| 7 | 運用者 → オンプレ（ngrok） | 受信 | 各製品の管理画面（Umami / Chatwoot / Mautic / n8n / Strapi） | **要認証**（ngrok 側の認証。設計は TA-04 の 7 節） | `未着手` |
| 8 | オンプレ → PostHog | 送信 | 記事ライフサイクルのイベントと例外 | `POSTHOG_PROJECT_TOKEN` | `実装済み` |
| 9 | オンプレ → 上流 API | 送信 | MCP サーバから Chatwoot / Mautic の API | Chatwoot は `api_access_token`、Mautic は OAuth2 client_credentials | `実装済み` |
| **10** | **オンプレ → AWS（SNS）** | **送信** | **n8n から通知を発行する**（顧客からの要求・監視の検知）。設計は AA-02 の `I-21` | IAM（**`sns:Publish` のみ**。対象トピックを限定。TA-04 の 1 節） | `未着手` |
| **11** | **オンプレ → DataForSEO** | **送信** | OpenSEO からの検索データの問い合わせ（キーワード・ドメイン・地域コード）。AA-02 の `I-23` | `DATAFORSEO_API_KEY`。**前払い残高が支出の上限** | `実装済み` |
| **12** | **オンプレ → Google（Search Console API）** | **送信** | OpenSEO が OAuth で自サイトの検索実績を取得する。AA-02 の `I-15` | OAuth（スコープ `webmasters.readonly`）。トークンは OpenSEO の DB に `BETTER_AUTH_SECRET` で暗号化 | `未着手` |
| **13** | **オンプレ → AWS（公開サイト）** | **送信** | OpenSEO のサイト監査のクロール。AA-02 の `I-24` | 自サイトのみ（BA-05） | `未着手` |
| **14** | **オンプレ → OpenSEO 開発元の PostHog（米国）** | **送信** | OpenSEO の匿名テレメトリ。送るのは件数（インストール数・ユーザー数・プロジェクト数・機能の利用回数）と無作為なインストール ID、失敗した設定チェックの名前と状態だけで、**URL・キーワード・プロンプト・メール・IP 由来の位置情報は含まない**（上流の `docs/SELF_HOSTING_DOCKER.md`）。インストール後 2 時間は 5 分ごと、以後は 1 日 1 回まで | **無し（送信を許可する。`R1` の 2026-09-18 の判断。AA-05 の ADR-09）** | `実装済み`（既定で有効） |

**OpenSEO は外から中への経路を 1 本も必要としない。** 経路 11〜14 はすべて中から外への送信であり、GSC の OAuth のコールバックも運用者のブラウザから `http://localhost:3001` に戻るだけで完結する。**OpenSEO の UI と MCP にトンネルを張らない**（TA-04 の 7 節）。

### オンプレ側の露出は ngrok の常設トンネルで行う（決定）

経路 4 は本層の最大の未解決点だったが、**方式が決定した。オンプレ側は ngrok の常設トンネルで露出する。**

- **「製品のみクラウド」の原則は保つ。** 新たに AWS へ展開するシステムは無く、TA-02 の構成要素表は変わらない（Umami や Chatwoot を AWS 側に出す案は採らない。1 つでも出すと「製品のみ」という境界の説明が列挙になり、判断基準が失われる。これは 8 節で SaaS への依存を基準で絞っているのと同じ理由である）。
- **既存の実践の延長であり、新しい依存を増やさない。** ngrok は既にこの基盤で使われている。`frontend/verdant-virgo/astro.config.mjs` の `vite.server.allowedHosts` には `comegin-astro-dev.ngrok.app` という固定ドメインが書かれており（経路 6、実装済み）、`middleware/n8n/.env.example` には `N8N_WEBHOOK_URL` と `N8N_PROXY_HOPS` がコメントアウトの形で用意されている（経路 5 の受け皿）。MCP サーバにも `MCP_ALLOWED_HOSTS` が用意されている。**トンネルを前提とした設定項目が既に 3 か所に存在する**のであり、決定はそれらを使う側に倒しただけである。
- **経路 4 と経路 7 は要件が正反対である。** 経路 4 は無認証でなければ成立せず（訪問者にログインを求めることはできない）、経路 7 は認証が無ければ成立しない（管理画面が誰でも開ける状態になる）。**同じ ngrok 機構でこの 2 種類を分離する設計が必須**であり、TA-04 の 7 節で扱う。
- **常設トンネルには固定ドメインが要る。** 動的に払い出される URL では、`SITE_URL`・`N8N_WEBHOOK_URL`・`MCP_ALLOWED_HOSTS`・Vite の `allowedHosts` の 4 か所が再起動のたびに変わる。固定ドメインは ngrok の有料プランの機能にあたる（**本セッションでは ngrok のプラン要件を実地に確認していない**ため、着手前に確認すること）。
- この決定により、`CAP-10`（行動観測・効果測定）の着手を妨げていた前提が解けた。残る作業は経路の分離（TA-04 の 7 節）とトラッカーの設置である。

## 8. SaaS 依存の基準

**当初この節は「SaaS 依存は PostHog のみ」としていた。** 2026-09-18 に OpenSEO（セルフホスト）を採用し、その取得元として DataForSEO が加わったことで、この一文は成り立たなくなった（AA-05 の ADR-09）。**原則を一文で言える状態を保つために、例外を列挙するのではなく、認める基準を書き直す。**

**外部の SaaS に依存してよいのは、次の 2 種類に限る。**

| 種類 | 該当するもの | 基準の意味 |
|---|---|---|
| **自前で持つと観測の一巡が遅くなる機能** | PostHog（行動観測・実験・エラー追跡） | 当初からの唯一の例外（下記） |
| **自前で持てないデータの取得元** | Google Search Console、DataForSEO | 検索結果での扱い・検索ボリューム・競合の順位は**Google の外に存在しない**。自前で立てる選択肢そのものが無い |

加えて、**既存のベンダーの中のサービスはベンダーを増やさない**（Amazon SNS。ADR-08）。境界の説明は**「製品と通知は AWS、他はオンプレ、行動観測は PostHog、検索データは Google と DataForSEO から取るだけ」**の一文に収まる。

### PostHog を例外とする理由

- **例外を認める理由**: PostHog に求めている機能（セッションリプレイ、エラー追跡、Scout による自動巡回）は、自前で立てると運用対象が 1 つ増えるうえ、Scout やリプレイ解析は自己ホスト版でも同等に動くとは限らない。観測基盤の運用に人手を取られると、この事業基盤が最適化しようとしている「観測から改善までの一巡の時間」がかえって延びる（BA-01 の目的と直接矛盾する）。
- **例外であることの帰結**: `E-08` `Person`（PostHog）と `E-11` `Experiment`（PostHog）の正本が外部にある。すなわち**この 2 つのエンティティだけは、オンプレのバックアップを取っても復旧できない**（TA-05 の 5 節で扱う）。
- **PostHog に送るデータの範囲**: DA-05 の `sanitize()` 方針と保持期間の判断に従う。Strapi のライフサイクルイベントは `$process_person_profile: false` を付けて person を作らない（`backend/strapi-system/src/index.ts`）。

### 検索データの取得元を認める条件

- **取得元にとどめ、正本を置かない。** GSC と DataForSEO から取った値は、OpenSEO（オンプレ）と `E-12` に残る。**DataForSEO には何も保管させない**（問い合わせを送って結果を受け取るだけ）。
- **個人情報を送らない。** DataForSEO に送るのはキーワード・ドメイン・地域コードだけである（DA-05 の 1.2.1）。**個人に関わるデータが越境する SaaS は依然として PostHog だけ**であり、その点で PostHog の例外は 1 つのまま保たれている。
- **テレメトリは依存に数えない。** 経路 14（OpenSEO の匿名テレメトリ）は OpenSEO 開発元の PostHog への送信だが、**この基盤はその送信から何も受け取らず、止まっても何も困らない**。8 節の基準は「依存してよい SaaS」を絞るものであり、依存の無い送信は 7 節の一覧で管理する（送るものに個人情報を含まないことが条件。DA-05 の 1.2.1）。
- **取得元を増やさない。** 「検索データの取得元」を理由に、同じ役割の別サービス（別の SEO データ提供元）を足さない。足すなら基準そのものを見直す。
- **OpenSEO 自体は SaaS 版を使わない。** OpenSEO のホスト版（openseo.so）は検索データの取得元ではなく**処理と保管の場所**であり、この基準に当たらない（ADR-09 でセルフホストを選んだ理由）。

### 境界に関わるその他の約束

- **PostHog を増やさない**: 「行動観測の SaaS が 1 つ入っているのだから 2 つ目も」という拡張は行わない。
- **Amazon SNS は新しい事業者への依存ではない**（ADR-08）。`CAP-07` `CAP-08` の配信先として既に使う AWS アカウント内のサービスだからである。判断基準は「ベンダーを増やさないこと」であり、「AWS のサービスを増やさないこと」ではない。

## 9. 未決定事項

- **ngrok の固定ドメインのプラン要件を実地に確認していない。** 常設トンネルに固定ドメインが要ることは設計上の前提だが、必要なプランと費用を本セッションでは確認していない。経路 4・5・7 の着手前に確認する。
- **ngrok のトンネルが落ちたときの影響範囲の合意が無い。** 経路 4 が止まると観測データの収集が止まり、経路 7 が止まると管理画面に到達できなくなる。**しかもどちらも静かに止まる**（訪問者からは何も見えず、運用者は次にログインしようとするまで気づかない）。監視項目としては TA-05 の 4 節に追加したが、「止まってよい時間」の合意は無い。
- **AWS 側のアクセスログを回収する手段が未定（経路 2）。** CloudFront の標準ログを S3 に出すところまでは決まるが、それをオンプレに引き込んで `E-12` に変換する経路（定期取得か、PostHog / Umami 側に寄せるか）は DA-04 の鮮度要件（観測は日次）と合わせて決める必要がある。
- **オンプレミスの実体が単一の開発機であることの可用性上の扱いが未定。** 現状は運用担当者の 1 台にすべての運用基盤が載っており、その 1 台が落ちると `CAP-12`（問い合わせ対応）と `CAP-14`（改善提案）が止まる。製品（AWS 側）は影響を受けないため公開は継続するが、「止まってよい時間」の合意が無い。TA-05 のバックアップ方針だけでは埋まらない（復旧手順があっても、復旧を始める人が 1 人しかいない）。
- **Umami を 3000 のままループバックに変更するか、ポートごと見直すかが未定。** ループバック化は TA-04 の対処方針に含めるが、実施すると上流 compose との差分が生じる。差分を持つ方針に切り替えるかどうかは TA-04 の 3 節の判断と一体で決める。
- **OpenSEO を開発機の外から使う方法が無い。** Docker 版は無認証（`local_noauth`）であり、トンネルを張らないと決めた（7 節）。運用者が 2 名を超えて別の端末から使いたくなった場合、**ngrok の認証の後ろに置く**か、OpenSEO の Cloudflare 版（Cloudflare Access の認証付き）に移るかを決める必要がある。後者はホスト先が増えるため 8 節の基準に照らした判断が要る。判断者 `R1`。
