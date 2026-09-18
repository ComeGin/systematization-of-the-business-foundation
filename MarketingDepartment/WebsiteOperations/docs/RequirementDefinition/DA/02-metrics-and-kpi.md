# DA-02 指標と KPI

`CAP-01`（事業戦略・KPI 管理）と `CAP-10`（行動観測・効果測定）が使う指標を、式・測定元・取得手段まで一意に定義する。
ここで決めた指標 ID は `E-13 ImprovementProposal` の `expectation.metric` から参照され、改善の成否判定に直接使われる。

指標 ID は DA でのみ使うローカルな識別子（用語集の `E-` / `CAP-` / `R` とは別系統）。

## 1. CVR の定義（確定）

### 1.1 分母

**分母は Umami のセッション数（`E-07 Session`）とする。**

| 候補 | 採否 | 理由 |
|---|---|---|
| セッション数（Umami） | **採用** | 1 回の来訪という単位が安定しており、月次比較で定義が揺れない。AB テストの割付・評価の単位とも揃えられる |
| 訪問者数（Umami のユニークビジター） | 不採用 | Umami はプライバシー重視でクロスサイト・長期の識別子を持たないため、期間をまたぐと同一人物が再計測される。分母が計測期間の長さに依存して膨らみ、前期間との比較が成立しない |
| PostHog の person 数 | 不採用 | person の生成は同意の取得状況に依存するため、同意率が変わるだけで分母が動く（DA-05 の個人情報区分と連動する）。母数には使えない |

### 1.2 分子

**分子は Mautic のフォーム送信（`mautic_list_form_submissions`）とする。**

| 候補 | 採否 | 理由 |
|---|---|---|
| Mautic のフォーム送信 | **採用** | CTA 3 種すべてがフォーム送信を伴い、「メールアドレスを取得してリードが成立した」という事業上の定義（`CAP-11`）と一致する。Mautic が `E-09 Contact` の正本でもあるため、CV とリードが同じ正本の中で数えられる |
| Chatwoot の会話開始 | 補助指標として別枠 | 問い合わせはリードの成立ではなく相談であり、匿名のままでも起きる。CV に混ぜるとリード数と一致しなくなるため、`CVR-assist` として独立させる |
| PostHog のカスタムイベント | 分子には使わない | CTA のクリックは計測できるが、クリックしても送信しない離脱を CV に数えると過大評価になる。PostHog は CTA のクリック率（`CTR-cta`）とフォーム離脱率の計測に使う |

### 1.3 CTA 種別ごとの分割

**分割する。** 全体の `CVR-total` に加えて、CTA 3 種ごとに `CVR-wp` / `CVR-trial` / `CVR-demo` を定義する。

- 理由: `CAP-02` の検索意図分類（潜在 / 準顕在 / 顕在・指名）に応じた CTA の出し分けが BA の中心的な施策であり、種別を分けないとその施策の効果を測れない（ホワイトペーパーが増えてデモ予約が減っても、合算では気付けない）。
- 分母は 3 指標とも共通で、対象ページ群のセッション数を使う（CTA 別に分母を変えると合計が `CVR-total` に一致しなくなる）。

### 1.4 確定した式

```
CVR-total = 期間内の Mautic フォーム送信数（3 種合計） / 期間内の Umami セッション数
CVR-wp    = 期間内のホワイトペーパー用フォームの送信数 / 期間内の Umami セッション数
CVR-trial = 期間内の無料トライアル用フォームの送信数 / 期間内の Umami セッション数
CVR-demo  = 期間内のデモ予約用フォームの送信数 / 期間内の Umami セッション数
CVR-assist = 期間内の Chatwoot の新規会話数 / 期間内の Umami セッション数
```

- 期間は月次（`CAP-01` の月次 CVR 改善会議に合わせる）。週次で見る場合も同じ式を使い、分母・分子とも同じ期間で切る。
- **分母と分子が別システムにあるため、個々のセッションと送信を突合することはできない**（この比率は集計値どうしの比であり、セッション単位の CV フラグではない）。ページ単位の CVR を出すには DA-03 の ID 統合（Mautic のフォームに Umami のセッション ID を hidden field で載せる）が前提になる。

## 2. README の GA4 記述との矛盾

ルート `README.md` は「月次の GA4/MA データに基づく CVR 改善会議」と書いているが、**採用ツールの一覧に GA4 は無い**（同 README の「システム（組み込むツール群）」はアクセス解析に Umami、行動分析 / AB テストに PostHog を挙げている）。
GA4 を導入する計画も、実装も存在しない（`frontend/verdant-virgo/src/layouts/Layout.astro` に GA4 を含むいかなるトラッカーのスクリプトも無い）。

したがって **README の「GA4」は、Umami と PostHog の 2 つに読み替える。** GA4 が担っていた役割の割り当ては以下のとおり。

| GA4 の役割 | 割り当て先 | 備考 | 状態 |
|---|---|---|---|
| セッション数・ページビュー・直帰 | Umami | KPI の分母の正本 | 未配線 |
| 参照元・チャネル分類 | Umami（`get_website_metrics` の `referrer`） | チャネル分類は Umami の分類に合わせる（GA4 の既定チャネルグループとは一致しない） | 未配線 |
| ランディングページ別の流入 | Umami（`get_website_metrics` の `path`） | | 未配線 |
| コンバージョン計測 | Mautic（フォーム送信） | GA4 のイベント型 CV ではなく MA 側の実データを CV とする（リード数と一致させるため） | 未配線 |
| ファネル・経路分析 | PostHog（`run_funnel` 相当 / insight） | Umami にもファネル機能はあるが、AB テストと同じ場所で見るため PostHog に寄せる | 未着手 |
| AB テスト（GA4 単体では不可） | PostHog（feature flag / experiment） | `E-11 Experiment` の正本 | 未着手 |
| エラー・例外の追跡 | PostHog（Error Tracking） | Strapi 側のみ配線済み | 一部実装済み |
| 検索クエリ・検索順位 | Google Search Console（**OpenSEO 経由**。AA-05 の ADR-06） | GA4 の役割ではないが README が同じ行に挙げているため併記する | 未着手 |

**OpenSEO にも GA4 の連携機能があるが、接続しない**（AA-05 の ADR-09）。接続すると、ここで Umami と PostHog に読み替えた GA4 が別の経路からランドスケープに戻り、同じ指標に 3 つ目の数字が生まれる。

## 3. Umami と PostHog の使い分け（KPI の正本）

両者ともアクセス解析機能を持つため、同じ指標を両方から出すと数値が食い違い、月次会議で「どちらが正しいか」の議論に時間を取られる。次のとおり**指標ごとに正本を 1 つに固定する**。

- **流入・母数系（セッション・PV・参照元・ランディングページ）の正本は Umami。**
- **行動・実験系（ファネル通過率・AB テストの結果・エラー率・リプレイ）の正本は PostHog。**
- PostHog も「セッション数」を表示できるが、**KPI には使わない**（デバッグと定性確認に限る）。

理由: Umami は cookie を置かず個人を識別しないため、同意の有無によらず全トラフィックを数えられる。PostHog は `E-08 Person` を作る＝個人情報の取り扱いが発生するため、同意のある範囲でしか計測しない。母数を PostHog に置くと同意率の変動で分母が揺れ、前期間との比較が壊れる。
詳細な役割分担表は DA-04 の 3 節に置く。

## 4. 指標一覧

`CAP-01` の KPI ツリー（BA 側で定義）に対応させる。上位ほど事業に近く、下位ほど施策に近い。

### 4.1 上位 KPI（月次・`R2` が管理）

| 指標 | 定義（式） | 測定元ツール | 取得手段 | 更新頻度 | 状態 |
|---|---|---|---|---|---|
| `LEAD-count` | 期間内に新規作成された `E-09 Contact` の件数 | Mautic | `mautic_list_contacts`（`dateAdded` で絞り込み） | 日次集計・月次確定 | 未配線 |
| `CVR-total` | Mautic フォーム送信数 / Umami セッション数 | Mautic + Umami | `mautic_list_form_submissions` + `get_website_stats` | 月次 | 未配線 |
| `SESSION-count` | 期間内のセッション数 | Umami | `get_website_stats` | 日次 | 未配線 |
| `ORGANIC-share` | 検索流入セッション / 全セッション | Umami | `get_website_metrics`（`type=referrer`） | 月次 | 未配線 |

### 4.2 中位 KPI（週次・`R2` / `R3` が管理）

| 指標 | 定義（式） | 測定元ツール | 取得手段 | 更新頻度 | 状態 |
|---|---|---|---|---|---|
| `CVR-wp` / `CVR-trial` / `CVR-demo` | 各 CTA のフォーム送信数 / Umami セッション数 | Mautic + Umami | `mautic_list_form_submissions`（`formId` 別）+ `get_website_stats` | 週次 | 未配線 |
| `CVR-assist` | Chatwoot の新規会話数 / Umami セッション数 | Chatwoot + Umami | `chatwoot_get_report_summary` + `get_website_stats` | 週次 | 未配線 |
| `CTR-cta` | CTA クリック数 / CTA 表示回数 | PostHog | カスタムイベント（`cta_viewed` / `cta_clicked`） | 週次 | 未着手 |
| `PAGE-sessions` | ページ別のセッション数 | Umami | `get_website_metrics`（`type=url`） | 週次 | 未配線 |
| `CONTENT-throughput` | 期間内の `article_published` イベント数 | PostHog | `backend/strapi-system/src/index.ts` が送信するイベントの集計 | 週次 | **実装済み** |

### 4.3 下位 KPI・品質指標（`R1` が管理）

| 指標 | 定義（式） | 測定元ツール | 取得手段 | 更新頻度 | 状態 |
|---|---|---|---|---|---|
| `LH-seo` | Lighthouse の SEO カテゴリスコア（3 回計測の中央値） | Lighthouse CI | `frontend/verdant-virgo/.lighthouse/` の JSON（`pnpm lh`） | ビルドごと | **実装済み** |
| `LH-performance` / `LH-a11y` / `LH-best-practices` | 各カテゴリスコア | Lighthouse CI | 同上 | ビルドごと | **実装済み** |
| `ERR-rate` | 期間内の例外発生件数 | PostHog（Error Tracking） | `backend/strapi-system/src/middlewares/posthog-error.ts` 経由の例外 | 日次 | **実装済み**（Strapi のサーバ側のみ） |
| `GSC-impressions` / `GSC-clicks` / `GSC-ctr` / `GSC-position` | 検索結果の表示回数 / クリック数 / クリック率 / 平均掲載順位（ページ単位） | Google Search Console | **OpenSEO の `get_search_console_performance`**（3 日前までの確定分） | 日次（対象期間を 3 日ずらす） | 未着手 |
| `SERP-position` | 採用キーワードの計測時点の順位（モバイル） | DataForSEO（OpenSEO のランク追跡） | OpenSEO の `get_rank_tracker`（保存済みの結果を読むだけ。**費用は計測時に発生する**） | 週次 | 未配線 |
| `INDEX-status` | 公開ページのうちインデックス登録済みのものの割合 | Google Search Console（URL 検査） | OpenSEO の `inspect_urls`（1 回 10 URL まで） | 週次 | 未着手 |
| `SITE-issues` | サイト監査で見つかった問題の件数（重大度別） | OpenSEO のクローラ（自サイト） | OpenSEO の `get_audit_issues`（監査の実行は人間） | 週次 | 未着手 |
| `RESPONSE-first` | 初回応答までの中央値 | Chatwoot | `chatwoot_get_report_summary` | 週次 | 未配線 |

- **`GSC-position` と `SERP-position` は同じ「順位」でも定義が違う。** 前者は期間中に実際に表示されたときの平均、後者は計測した瞬間の 1 回の検索結果である。**KPI ツリーの `平均検索順位` の正本は `GSC-position`** とし、`SERP-position` は**まだ表示されていない狙いのキーワード**の進捗を見る補助に限る（GSC は表示されたクエリしか返さないため）。
- **`LH-seo` と `SITE-issues` と `INDEX-status` は互いの代わりにならない。** `LH-seo` は 1 ページの合成監査、`SITE-issues` はサイト全体の構造監査、`INDEX-status` は Google が実際にどう扱ったかである。
- `LH-seo` のしきい値は 1.0（SEO 対策がこの計測の目的のため死守ライン）。他 3 カテゴリは 0.9。しきい値は `frontend/verdant-virgo/lighthouserc.cjs` に定義されている。
- `ERR-rate` が「Strapi のサーバ側のみ」なのは、ブラウザ側に PostHog のスクリプトが無く、フロントエンドの例外が 1 件も届いていないため。
- `CONTENT-throughput` は現状で唯一実際にデータが流れている指標（`article_created` / `article_published` / `article_updated` / `article_deleted` の 4 イベント）。ただし `distinct_id` は固定値 `strapi_cms` で、`$process_person_profile: false` により person を作らないため、**執筆者別の内訳は取れない**。

## 5. データ契約（エージェントが観測データを読むときの約束）

エージェントが `E-12 AuditResult` を生成するために観測データを読むとき、以下の契約に従う。契約を固定しないと、実行のたびに取得範囲が変わって `E-13` の `evidence` が比較不能になる。

### 5.1 契約の形

| 観測対象 | 経路 | 粒度 | 期間 | 1 回あたりの上限 | 状態 |
|---|---|---|---|---|---|
| セッション・流入 | Umami MCP（`get_website_stats` / `get_website_traffic` / `get_website_metrics`） | 日次、URL 別 / 参照元別 | 直近 35 日（前月比較が取れる最小） | ランキング系は上位 100 件 | 未配線 |
| フォーム送信 | `mautic_list_form_submissions`（`formId` 指定） | 送信 1 件単位 | 判定対象期間のみ | ページングで取得。0 件時は `[]` が返る（null ではない点に注意） | 未配線 |
| コンタクト | `mautic_list_contacts` / `mautic_get_contact` | コンタクト 1 件単位 | 新規は `dateAdded` で絞る | 一覧の 1 ページ分ずつ | 未配線 |
| 会話・応答品質 | `chatwoot_get_report_summary` / `chatwoot_get_report_timeseries` | 期間集計・日次時系列 | 前期間との比較付きで取得 | レポート API は 1 回で完結 | 未配線 |
| 会話の内容 | `chatwoot_list_conversations` / `chatwoot_list_messages` | 会話・メッセージ単位 | 直近の未解決分に限定 | **サーバ固定のページ件数**（後述） | 未配線 |
| 監査ログ | `chatwoot_list_audit_logs` | 操作 1 件単位 | 変更調査時のみ | 25 件／ページ（Enterprise 機能が必要） | 未配線 |
| 品質監査 | `frontend/verdant-virgo/.lighthouse/` の JSON を直接読む | ページ単位、カテゴリ別 | 最新のビルド結果 | ファイル読み取りのみ（外部公開しない） | 実装済み |
| 記事イベント | PostHog の insight / query | イベント単位 | 直近 90 日 | PostHog の API 制限に従う | 実装済み |
| 検索実績 | OpenSEO の `get_search_console_performance` | ページ単位（クエリ単位は `E-01` の実装後） | 直近 35 日のうち **3 日前まで** | **1 回 1,000 行まで**。`hasMore` なら `startRow` で続きを取る | 未着手 |
| インデックス登録 | OpenSEO の `inspect_urls` | URL 単位 | 取得時点 | **1 回 10 URL まで** | 未着手 |
| 順位計測 | OpenSEO の `get_rank_tracker` | キーワード × 端末 | 保存済みの直近の計測 | 読むだけ（**新たな計測をしない**） | 未配線 |
| サイト監査 | OpenSEO の `get_audit_status` / `get_audit_issues` / `get_audit_pages` | 問題の種類 × ページ | 直近に完了した監査 | 読むだけ | 未着手 |
| 市場データ | OpenSEO の調査系ツール（`research_keywords` など） | キーワード・ドメイン単位 | 取得時点 | **1 回の見積もり 2,000 クレジットまで**（AA-05 の ADR-10） | 未配線 |

### 5.2 上流 API の制約が契約に与える影響

- **Chatwoot のページ件数はサーバ側で固定されている**（会話 25 / コンタクト 15 / メッセージ 20 / 監査ログ 25）。クライアント側で 1 ページの件数を増やすことはできないため、「直近 100 件の会話を読む」という契約は必ず 4 回のリクエストになる。契約には**件数ではなくページ数の上限**を書く（`最大 4 ページまで` のように）。
- **Chatwoot は `Rack::Timeout` により 15 秒でリクエストを打ち切る。** 期間の広いレポートや全文検索は打ち切られる可能性があるため、月次より長い期間を 1 回で要求しない。起動直後の初回は 500 になることがあるため、1 回だけ再試行する契約にする。
- MCP の応答は `CHARACTER_LIMIT`（25,000 文字）に収まるよう一覧の件数が自動で半分ずつ削られ、`truncation_message` が付く。**削られた分は「次のページ」では取得できない**（ページ境界ではなく応答サイズで削るため）。エージェントは `truncation_message` を見たら、期間や絞り込み条件を狭めて取り直す。
- MCP の応答に含まれる 1,000 文字超の文字列（メール本文の HTML など）は `include_long_text=true` を指定しない限り省略される。本文の全文が根拠に必要な場合のみ明示的に指定する（既定では省略されたまま判断してよい、という前提で契約を書く）。
- **Mautic の更新は `PATCH` 相当のみ**（`PUT` は存在しない ID で新規作成してしまう）。観測は参照のみなので直接の影響は無いが、提案の適用で Mautic を触る場合はこの制約が効く。
- Mautic は 0 件のとき `[]` を返す。空配列を「取得失敗」と誤認しない（失敗はエラーとして返る）。

### 5.2.1 OpenSEO 経由の取得に固有の制約

- **GSC の日付は太平洋時間である。** OpenSEO のツールは GSC の日付を米国太平洋時間のまま返す。この基盤の他の観測は日本時間で切っているため、**同じ「9 月 1 日」でも GSC だけ 16〜17 時間ずれる**。日次の比較では無視できるが、日単位で他の観測と突き合わせる場合は `E-12` の `range` にタイムゾーンを明記する。
- **直近約 3 日の GSC のデータは不完全である**（OpenSEO のツール説明にも明記）。確定分だけを使う（DA-04 の 4 節）。
- **GSC は 1 回 1,000 行までで、並び順はクリック数の降順に固定されている。** 順位や表示回数での絞り込みは、その上位 1,000 行の中でしか効かない（OpenSEO のツール説明）。ページ数が 1,000 を超えるまでは問題にならない。
- **GSC のさかのぼれる期間は 16 か月まで**である。それより前の実績は取れない（登録した日より前も取れない）。
- **GSC の平均掲載順位は Discover と Google ニュースでは返らない。** 返らないことを失敗ではなく「その種別には順位が無い」として扱う（`empty_but_ok` と同じ構造。DD-01 の 4.2）。
- **調査系は同じ問い合わせでも毎回費用がかかる。** 再現性の条件（5.3）のために同じ `ref` で取り直すことが、そのまま支出になる。**市場データの再取得は検証に必要な場合に限る。**

### 5.3 観測の再現性

`E-12 AuditResult` には、`metrics` の値だけでなく**取得に使ったクエリそのもの**（`ref` 項目）を必ず残す。
同じ `ref` で再取得すれば同じ値になることを再現性の条件とし、再現できない観測（リアルタイム系・打ち切られた応答）は `E-13` の `evidence` に使わない。

## 6. 未決定事項

- ここで定義した指標 ID（`CVR-total` など）は用語集に登録されていない DA ローカルの識別子。`E-13` の `expectation.metric` から参照する以上、全層で共有すべきかを BA と調整する必要がある（勝手に用語集へ追加しない、という表記ルールに従いここに記録する）。
- CVR の分母を「全セッション」にするか「対象ページ群のセッション」にするか。全体 CVR は前者、ページ別 CVR は後者になるが、CTA 別 CVR をどちらの分母で出すかは BA の KPI ツリーの形（CTA 別の目標値を全体に対して置くのか、ページ群に対して置くのか）が確定していないため決められない。
- `CVR-assist`（Chatwoot 経由）を上位 KPI に昇格させるかどうか。Web 接客（`CAP-12`）の貢献をリード数に含めるかは事業側の判断であり、DA では決められない。現状は補助指標に留める。
- **（2026-09-18 に解決）Google Search Console の指標（`GSC-*`）の取得手段。** OpenSEO の OAuth 連携で取り、OpenSEO の MCP で読むと決めた（AA-05 の ADR-06・ADR-09）。残るのは人間の作業（ドメインプロパティの登録、OAuth クライアントの発行、接続）だけである。
- `SERP-position` と `GSC-position` のどちらを `E-13` の `expectation.metric` に使うか。4.3 で KPI の正本は `GSC-position` としたが、表示回数が少ないうちは GSC の平均掲載順位が大きく揺れる。**表示回数の下限（たとえば 50 以上）を判定の条件に含めるか**を、実データが溜まってから決める。判断者 `R3`。
- 実験（`E-11`）の有意差判定の基準（有意水準・最小サンプルサイズ）。PostHog の実験機能に任せるか、`R3` が独自に判定するかが未確定。ブラウザ側トラッカーが無く実データで検証できないため、配線後に決める。
