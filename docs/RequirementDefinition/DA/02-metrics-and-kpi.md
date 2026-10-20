# DA-02 指標と KPI

`CAP-01`（事業戦略・KPI 管理）と `CAP-10`（行動観測・効果測定）が使う指標を、式・測定元・取得手段まで一意に定義する。
ここで決めた指標 ID は `E-13 ImprovementProposal` の `expectation.metric` から参照され、改善の成否判定に直接使われる。

**指標 ID の採番の正本は本ファイルの 4 節である**（索引は [`docs/README.md` の「ID の採番と正本」](../../README.md)）。DA でのみ使うローカルな識別子であり、`E-` / `CAP-` / `R` とは別系統である。

## 1. CVR の定義（確定）

### 1.1 分母

**分母は GA4 のセッション数（`SESSION-count`。`E-07 Session`）とする**（**2026-10-06 に AA-05 の ADR-25 で Umami から変えた**。旧版は「分母は Umami のセッション数」）。

| 候補 | 採否 | 理由 |
|---|---|---|
| **セッション数（GA4）** | **採用**（2026-10-06。ADR-25） | 1 回の来訪という単位が安定しており、月次比較で定義が揺れない。**ADR-25 で流入・母数系の正本を GA4 にした**。ただし同意した訪問者だけを数える（下の注記） |
| セッション数（Umami） | **採用していた**（**ADR-25 で廃止**） | 1 回の来訪という単位が安定しており、月次比較で定義が揺れない。AB テストの割付・評価の単位とも揃えられる |
| 訪問者数（Umami のユニークビジター。**ADR-25 で廃止**） | 不採用 | Umami はプライバシー重視でクロスサイト・長期の識別子を持たないため、期間をまたぐと同一人物が再計測される。分母が計測期間の長さに依存して膨らみ、前期間との比較が成立しない。**GA4 のユーザー数も使わない**（OpenSEO のツールはチャネル別・ページ別の行でしか返さず、行を足すと重複する。4.1 の `VISITOR-count` の廃止） |
| PostHog の person 数 | 不採用 | person の生成は同意の取得状況に依存するため、同意率が変わるだけで分母が動く（DA-05 の個人情報区分と連動する）。母数には使えない |

> **分母と分子の母集団の偏り（2026-10-06。ADR-25 の帰結 6）。** GA4 は Cookie（`_ga`）を使うため、**同意した訪問者のセッションしか数えない**（Consent Mode v2 の basic。同意の前はタグを読み込まない）。分子の Mautic のフォーム送信（1.2）は**同意と無関係に全員**を数える。したがって **CVR は同意しない訪問者の CV の分だけ過大になり、同意率が下がると CVR が見かけ上上がる**（施策の効果と区別できない）。旧版の「PostHog の person 数は同意率で分母が動くので不採用」と同じ欠点を、GA4 のセッション数も持つ。**補正の方法は未決定**（6 節。同意率〈`consent-api` の記録〉を材料にする）。補正が決まるまでは、**同意率が大きく動いた期間の CVR の比較を `E-13` の `evidence` に使わない**。

### 1.2 分子

**分子は Mautic のフォーム送信（`mautic_list_form_submissions`）とする。**

| 候補 | 採否 | 理由 |
|---|---|---|
| Mautic のフォーム送信 | **採用** | **CV に数える CTA 2 種（無料相談・無料 DL。1.3）がどちらもフォーム送信を伴い**、「メールアドレスを取得してリードが成立した」という事業上の定義（`CAP-11`）と一致する。Mautic が `E-09 Contact` の正本でもあるため、CV とリードが同じ正本の中で数えられる（**2026-10-20 の注記**: 無料 DL はフォームをやめて CTA になったので、フォーム送信で数えるのは無料相談だけになった。1.4） |
| Chatwoot の会話開始 | 補助指標として別枠 | 問い合わせはリードの成立ではなく相談であり、匿名のままでも起きる。CV に混ぜるとリード数と一致しなくなるため、`CVR-assist` として独立させる |
| PostHog のカスタムイベント | 分子には使わない | CTA のクリックは計測できるが、クリックしても送信しない離脱を CV に数えると過大評価になる。PostHog は CTA のクリック率（`CTR-cta`）とフォーム離脱率（`FORM-abandon`。4.2・4.4）の計測に使う（**2026-10-20 の注記**: 無料 DL はフォームが無くなったので、`CVR-source-dl` の分子だけはこの `cta_clicked` を使う。1.4） |

### 1.3 CTA 種別ごとの分割

**分割する。** 全体の `CVR-total` に加えて、**サイトに実在する CTA 2 種**ごとに `CVR-consult` / `CVR-source-dl` を定義する。

- 理由: `CAP-02` の検索意図分類（潜在 / 準顕在 / 顕在・指名）に応じた CTA の出し分けが BA の中心的な施策であり、種別を分けないとその施策の効果を測れない（無料 DL が増えて無料相談が減っても、合算では気付けない）。
- 分母は 2 指標とも共通で、対象ページ群のセッション数を使う（CTA 別に分母を変えると合計が `CVR-total` に一致しなくなる）。
- **2026-10-01 に 3 種から 2 種に改めた。** 旧版は README の CTA 3 種（ホワイトペーパー / 無料トライアル / デモ予約）に合わせて `CVR-wp` / `CVR-trial` / `CVR-demo` を定義していたが、**デザインの検討で、サイトの CTA は無料相談と無料 DL の 2 種で、無料トライアルは存在しないことが確定した**（`docs/BasicDesign/DesignSpec/website/01-content-spec.md` の 6.1）。`cta_type` の値も同日に実態の名前へ改められた（DA-01 の 4 節の注記。F7）。詳細は下の「指標 ID を改めた理由」。

#### 指標 ID を改めた理由（2026-10-01）

| 旧 | 新 | 扱い |
|---|---|---|
| `CVR-wp` | **`CVR-source-dl`** | 改名。分子は無料 DL フォーム（Mautic の alias `source_dl`。2026-10-05 に `source-dl` から改めた）の送信数。**2026-10-20 から「ソースコードを無料 DL」の CTA の押下数**（1.4。フォームを消したため） |
| `CVR-demo` | **`CVR-consult`** | 改名。分子は無料相談フォーム（alias `consult`）の送信数 |
| `CVR-trial` | **廃止** | **対応する CTA がサイトに無く、分子が永久に 0 になる。** 0 の指標を残すと、`E-13` の `expectation.metric` から参照できる見かけの選択肢が増え、「測れるのに測っていない」と「そもそも存在しない」の区別がつかなくなる |

- **`cta_type` の `trial` は「使わない」として値を残すのに、指標 ID は廃止する。** 値を残すのは**将来トライアルを始めたときに意味が変わらないようにするため**（DA-01 の 4 節）だが、指標は**いま測るもの**の一覧であり、測れないものを並べない。トライアルを始めたときに `CVR-trial` を**作り直す**。
- **指標 ID を `cta_type` の値に合わせる**（`consult` / `source_dl`）。ただし**指標 ID の区切りはハイフン**（既存の `CVR-total` `CVR-assist` `LH-seo` と同じ）なので `CVR-source-dl` とする。**`cta_type` の値（`source_dl`）とは区切り文字が違う**ことを承知の上でそろえている（指標 ID は DA のローカルな識別子で、イベントのプロパティの値とは別系統である。6 節）。

### 1.4 確定した式

```
CVR-total      = （CVR-consult の分子 ＋ CVR-source-dl の分子） / 期間内の GA4 セッション数（SESSION-count）
CVR-consult    = 期間内の無料相談フォームの送信数 / 期間内の GA4 セッション数
CVR-source-dl  = 期間内の PostHog の cta_clicked のうち cta_type が source_dl のもの（cta_id が dl_top_banner・dl_article_inline を除く）の数 / 期間内の GA4 セッション数
CVR-assist     = 期間内の Chatwoot の新規会話数 / 期間内の GA4 セッション数
```

- **分母は 2026-10-06 に Umami のセッション数から GA4 のセッション数に変えた**（ADR-25）。**GA4 と Mautic の両方が `ok` か `empty_but_ok` で、両方の取得期間（`fetch.range`）が同じで、かつ `SESSION-count ≥ 1` のときだけ計算する**（どちらかが欠けたら CVR を書かない。0 で割らない）。**1.1 の注記の偏り（分母は同意した訪問者だけ、分子は全員）を、CVR を報告するたびに添える。**

- 期間は月次（`CAP-01` の月次 CVR 改善会議に合わせる）。週次で見る場合も同じ式を使い、分母・分子とも同じ期間で切る。
- **`CVR-total` の「2 種合計」は 2026-10-01 に 3 種から改めた**（1.3）。**フォームは 2 つしか作らない**ため（`MAUTIC_FORM_ID_CONSULT` / `MAUTIC_FORM_ID_SOURCE_DL`）、合計は常に 2 種である。
- **（2026-10-20 にユーザーが決定）`CVR-source-dl` の分子を、無料 DL フォームの送信数から「ソースコードを無料 DL」の CTA の押下数に改めた。** 公開サイトの無料 DL ブロックは、トップ（2026-10-18）に続いてブログ（2026-10-20）もメールのフォームをやめて CTA にし、無料 DL のフォーム（`source_dl`。`MAUTIC_FORM_ID_SOURCE_DL`）は公開サイトと Mautic の準備の手順から消した。CTA を押すと zip のダウンロードと無料相談のフォームへの遷移が同時に起きるので、**押した数を DL の数とみなす**。
  - 数えるのは PostHog の `cta_clicked`（4.1）で `cta_type` が `source_dl` のもの。**`dl_top_banner`・`dl_article_inline` は除く**（ページの中の `#source-dl` へ移るだけで、ダウンロードは起きない。`source-dl` の `lib/redirect.ts`）。
  - **分子も同意した訪問者だけになる**（PostHog は同意の後にだけ動く）。分母（GA4）と同じ偏りなので、`CVR-consult`（分子は全員）とは偏りの向きが違う。`CVR-source-dl` を報告するときは「分子・分母とも同意した訪問者だけ」と添える。
  - `CVR-total` の分子は 2 つの分子の和で、出どころが Mautic（無料相談）と PostHog（無料 DL）に分かれる。両方が `ok` か `empty_but_ok` のときだけ計算する。
  - メールアドレスを取らないので、無料 DL では**リードが成立しない**（1.1 の「メールアドレスを取得してリードが成立した」の定義に当たるのは無料相談だけになった）。お知らせメールの受信の希望（`email_optin`）は、同日から無料相談のフォームの任意のチェックで聞く。
- **オンライン面談の予約（`E-16`。`cta_type` が `booking`）は CVR に入れない。** CV の成立（フォームの送信）より**後ろの段**であり、入れると 1 人を 2 回数える（BA-04 の商談プロセス、4.4）。予約の歩留まりを測るかは 6 節。
- **分母と分子が別システムにあるため、個々のセッションと送信を突合することはできない**（この比率は集計値どうしの比であり、セッション単位の CV フラグではない）。ページ単位の CVR を出すには DA-03 の ID 統合（Mautic のフォームに Umami のセッション ID を hidden field で載せる）が前提になる。**〔2026-10-06 ADR-25: hidden field の `umami_session_id` は廃止し、代わりの識別子を足さない。訪問者単位の突合はできなくなり、CVR は集計値どうしの比だけになる（DA-03 の 2 節）〕**

## 2. README の GA4 記述との矛盾（2026-10-06 に AA-05 の ADR-25 で解消）

**この節の「GA4 を Umami と PostHog に読み替える」は、ADR-25 で置き換えた。** GA4 を流入・ページ・参照元の正本として採用し、Umami をやめた。新しい割り当てを 2.1 に、旧版を 2.2 に残す。

### 2.1 GA4 を採用した後の役割の割り当て（ADR-25）

| 役割 | 割り当て先 | 取得手段（エージェント） | 備考 | 状態 |
|---|---|---|---|---|
| セッション数・チャネル分類 | **GA4** | OpenSEO の `get_google_analytics_traffic_acquisition`（`breakdown: channel_group`） | KPI の分母の正本。チャネル分類は **GA4 の既定チャネルグループ**（`Organic Search` など）に合わせる | 未配線 |
| 参照元 | **GA4** | 同上（`breakdown: source_medium`） | source / medium 別 | 未配線 |
| ページビュー（ページ別） | **GA4** | OpenSEO の `get_google_analytics_page_performance`（`channel: all`） | | 未配線 |
| 自然検索のランディングページ | **GA4** | OpenSEO の `get_google_analytics_organic_landing_pages` | | 未配線 |
| 計測の健全性 | **GA4** | OpenSEO の `get_google_analytics_measurement_health` | 指標にはしない。欠測の確認に使う | 未配線 |
| コンバージョン計測 | **Mautic**（フォーム送信。変わらない） | `mautic_list_form_submissions` | **GA4 のキーイベント（`key_events`）は CV に使わない**（リード数と一致させるため。エージェントにもツールを持たせない） | 未配線 |
| ファネル・経路分析 | PostHog | — | AB テストと同じ場所で見るため（変わらない） | 未着手 |
| AB テスト | PostHog（feature flag / experiment） | — | `E-11 Experiment` の正本（変わらない） | 未着手 |
| エラー・例外の追跡 | PostHog（Error Tracking） | — | 変わらない | 一部実装済み |
| **Core Web Vitals（実測）** | **PostHog**（posthog-js の web vitals の自動取得。イベント `$web_vitals`） | `execute-sql` で p75 に集計 | **ユーザーの決定**（2026-10-06）。旧版は Umami の `get_performance`。**同意した訪問者だけの標本**である | 未着手 |
| 検索クエリ・検索順位 | Google Search Console（OpenSEO 経由。AA-05 の ADR-06） | `get_search_console_performance` | 変わらない | 未着手 |

- **OpenSEO の GA4 連携を使う**（ADR-09 の「使わない」を ADR-25 で置き換えた）。接続するのは本番のプロパティだけで、OAuth のスコープは `analytics.readonly` だけ。接続は人間（`R1`）が行う。
- **指標が GA4 と他のツールで重なるときは GA4 を優先する。** **PostHog のページビュー・セッションの数字は報告に使わない**（デバッグと定性確認に限る。3 節）。
- **OpenSEO の GA4 のツールはカスタムイベントの値を読めない**（ADR-25 の帰結 7）。GA4 に独自のイベントを足しても、エージェントからは件数しか見えないため、CTA・フォームのイベントは PostHog のまま（4.4）。

### 2.2 旧版（ADR-25 より前。GA4 を Umami と PostHog に読み替えていた）

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

## 3. GA4 と PostHog の使い分け（KPI の正本。2026-10-06 に ADR-25 で Umami を GA4 に置き換えた）

両者ともアクセス解析機能を持つため、同じ指標を両方から出すと数値が食い違い、月次会議で「どちらが正しいか」の議論に時間を取られる。次のとおり**指標ごとに正本を 1 つに固定する**。

- **流入・母数系（セッション・PV・参照元・ランディングページ）の正本は GA4**（旧版は Umami。ADR-25）。
- **行動・実験系（ファネル通過率・AB テストの結果・エラー率・リプレイ）と、実測の Core Web Vitals の正本は PostHog。**
- PostHog も「セッション数」「ページビュー」を表示できるが、**報告にも KPI にも使わない**（デバッグと定性確認に限る）。

理由: **GA4 を正本にしたのはユーザーの決定である**（ADR-25）。重なる指標を GA4 に寄せ、PostHog は GA4 に無い用途（AB テスト・例外の監視・記事のイベント・実測の Core Web Vitals）に限る。
**旧版の理由（「Umami は cookie を置かず、同意の有無によらず全トラフィックを数えられる。母数を PostHog に置くと同意率の変動で分母が揺れる」）は、GA4 では成り立たない。** GA4 も PostHog も同意した訪問者だけを数えるため、**母数は同意率に左右される**（1.1 の注記）。この欠点は ADR-25 で受け入れた。
詳細な役割分担表は DA-04 の 3 節に置く。

## 4. 指標一覧

`CAP-01` の KPI ツリー（BA 側で定義）に対応させる。上位ほど事業に近く、下位ほど施策に近い。

### 4.1 上位 KPI（月次・`R2` が管理）

| 指標 | 定義（式） | 測定元ツール | 取得手段 | 更新頻度 | 状態 |
|---|---|---|---|---|---|
| `LEAD-count` | 期間内に新規作成された `E-09 Contact` の件数 | Mautic | `mautic_list_contacts`（`dateAdded` で絞り込み） | 日次集計・月次確定 | 未配線 |
| `CVR-total` | Mautic フォーム送信数 / GA4 セッション数（`CV-count ÷ SESSION-count`。両方が `ok`/`empty_but_ok` かつ `SESSION-count ≥ 1` のときだけ。**分母は同意した訪問者だけ、分子は全員**。1.1 の注記） | Mautic + GA4 | `mautic_list_form_submissions` + OpenSEO の `get_google_analytics_traffic_acquisition` | 月次 | 未配線 |
| `SESSION-count` | 期間内のセッション数（全チャネルの `sessions` の合計） | GA4 | OpenSEO の `get_google_analytics_traffic_acquisition`（`breakdown: channel_group`） | 日次 | 未配線 |
| `ORGANIC-share` | `Organic Search` のセッション / `SESSION-count`（**2026-10-06 に訪問者ベースからセッションベースに変わった**。ADR-25） | GA4 | 同上 | 月次 | 未配線 |
| `PAGEVIEW-count`（2026-10-06 に追加） | ページ別の views の合計。**全件を取れなかったとき（`hasMore` が残る・応答が打ち切られた）は書かない**（`truncated`） | GA4 | OpenSEO の `get_google_analytics_page_performance`（`channel: all`） | 日次 | 未配線 |

### 4.2 中位 KPI（週次・`R2` / `R3` が管理）

| 指標 | 定義（式） | 測定元ツール | 取得手段 | 更新頻度 | 状態 |
|---|---|---|---|---|---|
| `CVR-consult` / `CVR-source-dl` | `CVR-consult` は無料相談のフォーム送信数、`CVR-source-dl` は無料 DL の CTA の押下数（2026-10-20 から。1.4）/ GA4 セッション数（**2026-10-01 に `CVR-wp` / `CVR-demo` から改名し、`CVR-trial` を廃止**。1.3） | Mautic + PostHog + GA4 | `mautic_list_form_submissions`（`MAUTIC_FORM_ID_CONSULT`）+ PostHog の `execute-sql`（`cta_clicked`）+ OpenSEO の `get_google_analytics_traffic_acquisition` | 週次 | 未配線 |
| `CVR-assist` | Chatwoot の新規会話数 / GA4 セッション数 | Chatwoot + GA4 | `chatwoot_get_report_summary` + OpenSEO の `get_google_analytics_traffic_acquisition` | 週次 | 未配線 |
| `CTR-cta` | CTA クリック数 / CTA 表示回数 | PostHog | カスタムイベント（`cta_viewed` / `cta_clicked`。4.4） | 週次 | 未着手 |
| `FORM-abandon` | 1 − （フォーム送信の成功数 / フォームの入力開始数） | PostHog | カスタムイベント（`form_submitted` / `form_started`。4.4） | 週次 | 未着手 |
| `PAGE-views`（2026-10-06 に `PAGE-sessions` を置き換え。ADR-25） | ページ別の views、上位 100 件 | GA4 | OpenSEO の `get_google_analytics_page_performance`（`channel: all`） | 週次 | 未配線 |
| `REFERRER-sessions`（2026-10-06 に追加） | 参照元（source / medium）別のセッション、上位 100 件 | GA4 | OpenSEO の `get_google_analytics_traffic_acquisition`（`breakdown: source_medium`） | 週次 | 未配線 |
| `ORGANIC-landing`（2026-10-06 に追加） | 自然検索のランディングページ別のセッション、上位 100 件 | GA4 | OpenSEO の `get_google_analytics_organic_landing_pages` | 週次 | 未配線 |
| `CONTENT-throughput` | 期間内の `article_published` イベント数 | PostHog（**本番用のプロジェクト**。ADR-16） | `backend/strapi-system/src/index.ts` が送信するイベントの集計 | 週次 | **実装済み** |

### 4.3 下位 KPI・品質指標（`R1` が管理）

| 指標 | 定義（式） | 測定元ツール | 取得手段 | 更新頻度 | 状態 |
|---|---|---|---|---|---|
| `LH-seo` | Lighthouse の SEO カテゴリスコア（3 回計測の中央値） | Lighthouse CI | `frontend/verdant-virgo/.lighthouse/` の JSON（`pnpm lh`） | ビルドごと | **実装済み** |
| `LH-performance` / `LH-a11y` / `LH-best-practices` | 各カテゴリスコア | Lighthouse CI | 同上 | ビルドごと | **実装済み** |
| `QC-a11y-violations`（2026-10-18 に追加。ADR-27） | axe（`wcag2a`・`wcag2aa`・`wcag21a`・`wcag21aa`・`wcag22aa`）の違反の件数（全ルート × Desktop・Mobile の合計） | Playwright ＋ axe（`frontend/verdant-virgo/e2e/`） | `.a11y/summary.json`（version 1。builtin `a11y` が `pnpm a11y:ci` で作り、作業ツリーに写す）の `totals.violations` を `agent/quality-checker` の項目 6 が読む（DD-09 の 3 節） | 週次（`weekly-a11y` → `weekly-observe-a11y`） | 未配線（定期実行は `enabled: false`） |
| `QC-a11y-serious`（同上） | 違反のうち影響度が critical と serious のものの件数。**AA-04 の 3.8 の止め線** | 同上 | 同上 | 同上 | 未配線 |
| `QC-a11y-pages-failed`（同上） | 違反が 1 件以上あったページ（ルート × 端末）の数 | 同上 | 同上 | 同上 | 未配線 |
| `QC-a11y-incomplete`（同上） | axe が判定できず、人の判断が要るもの（`incomplete`）の件数。**合格・不合格には数えない** | 同上 | 同上 | 同上 | 未配線 |
| `ERR-rate` | 期間内の例外発生件数 | PostHog（Error Tracking。**本番用のプロジェクト**。ADR-16） | `backend/strapi-system/src/middlewares/posthog-error.ts` 経由の例外 | 日次 | **実装済み**（Strapi のサーバ側のみ） |
| `GSC-impressions` / `GSC-clicks` / `GSC-ctr` / `GSC-position` | 検索結果の表示回数 / クリック数 / クリック率 / 平均掲載順位（ページ単位） | Google Search Console | **OpenSEO の `get_search_console_performance`**（3 日前までの確定分） | 日次（対象期間を 3 日ずらす） | 未着手 |
| `SERP-position` | 採用キーワードの計測時点の順位（モバイル） | DataForSEO（OpenSEO のランク追跡） | OpenSEO の `get_rank_tracker`（保存済みの結果を読むだけ。**費用は計測時に発生する**） | 週次 | 未配線 |
| `INDEX-status` | 公開ページのうちインデックス登録済みのものの割合 | Google Search Console（URL 検査） | OpenSEO の `inspect_urls`（1 回 10 URL まで） | 週次 | 未着手 |
| `SITE-issues` | サイト監査で見つかった問題の件数（重大度別） | OpenSEO のクローラ（自サイト） | OpenSEO の `get_audit_issues`（監査の実行は人間） | 週次 | 未着手 |
| `CWV-lcp-p75` / `CWV-inp-p75` / `CWV-cls-p75`（2026-10-06 に追加） | 実測の LCP / INP / CLS の 75 パーセンタイル | PostHog（`$web_vitals`。**本番用のプロジェクト**） | `execute-sql` で `quantile(0.75)`（プロパティは `$web_vitals_LCP_value` / `$web_vitals_INP_value` / `$web_vitals_CLS_value`。下の注記） | 週次 | 未着手 |
| `RESPONSE-first` | 初回応答までの中央値 | Chatwoot | `chatwoot_get_report_summary` | 週次 | 未配線 |
| `FORM-failure` | フォーム送信の失敗数 /（成功数 ＋ 失敗数） | PostHog | カスタムイベント（`form_submit_failed` / `form_submitted`。4.4。`error_kind` 別の内訳も取る） | 日次 | 未着手 |
| `FORM-invalid` | 入力エラーの発生数 / フォームの入力開始数 | PostHog | カスタムイベント（`form_validation_failed` / `form_started`。4.4。`fields` 別の内訳も取る） | 週次 | 未着手 |

- **`GSC-position` と `SERP-position` は同じ「順位」でも定義が違う。** 前者は期間中に実際に表示されたときの平均、後者は計測した瞬間の 1 回の検索結果である。**KPI ツリーの `平均検索順位` の正本は `GSC-position`** とし、`SERP-position` は**まだ表示されていない狙いのキーワード**の進捗を見る補助に限る（GSC は表示されたクエリしか返さないため）。
- **`QC-a11y-*` と `LH-a11y` は互いの代わりにならない**（2026-10-18。ADR-27）。`LH-a11y` は 3 ページの合成監査のスコア（0.9 が目標値）で、axe のルールの一部しか見ない。`QC-a11y-*` は全ページ・全状態の axe の違反の件数で、JIS X 8341-3 の AA の対応度の表明（`/accessibility/`。一部準拠）を守るための観測である。**どちらも機械で判定できる基準しか見ない**（手動とスクリーンリーダーの試験は `docs/BasicDesign/DesignSpec/website/04-accessibility-spec.md` の §4）。計画の「`A11Y-*` 指標」は、`quality-checker` が `E-12` に書くキーと同じ `QC-a11y-*` の名前で持つ（2 つの名前を持たない）
- **`LH-seo` と `SITE-issues` と `INDEX-status` は互いの代わりにならない。** `LH-seo` は 1 ページの合成監査、`SITE-issues` はサイト全体の構造監査、`INDEX-status` は Google が実際にどう扱ったかである。
- **`CWV-*` は実測（フィールド）、`LH-performance` は合成（ラボ）であり、互いの代わりにならない。** `CWV-*` は **PostHog の `$web_vitals` を同意した訪問者だけから集めた標本**で（2026-10-06。ユーザーの決定。旧版は Umami の `get_performance`）、同意率と端末の偏りを持つ。p75 は Core Web Vitals の評価の慣例に合わせた（PostHog の Web 分析の画面も LCP を p75 で出す。https://posthog.com/docs/web-analytics/dashboard）。**プロパティ名は `$web_vitals_LCP_value` / `$web_vitals_INP_value` / `$web_vitals_CLS_value`**（posthog-js の `packages/browser/src/extensions/web-vitals/index.ts` が `` `$web_vitals_${metric.name}_value` `` の形で送る。同リポジトリのテスト `web-vitals.test.ts` にも `$web_vitals_LCP_value` がある。`.claude/agents/analytics-reporter.md` の集計もこの名前を使う。PostHog の docs〈https://posthog.com/docs/web-analytics/web-vitals〉にはイベント名 `$web_vitals` だけが載り、プロパティ名は載っていない）。**値の単位（LCP・INP はミリ秒）は実データで確かめる。** 日付は JST でそろえる（`toDate(toTimeZone(timestamp, 'Asia/Tokyo'))`）。
- **`VISITOR-count` は廃止した**（2026-10-06。ADR-25。定期実行の定義〈`ops/schedules/daily-observe-analytics.yaml`〉にあった）。GA4 のユーザー数はチャネル別の行を足すと重複し、OpenSEO のツールに全体のユーザー数を返すものが無い。
- **GA4 由来の指標（`SESSION-count` `ORGANIC-share` `PAGEVIEW-count` `PAGE-views` `REFERRER-sessions` `ORGANIC-landing`）は、少ない数が `null` になるか行ごと欠けることがある**（GA4 のしきい値。OpenSEO の `specs/0007`）。**欠けた値を 0 で埋めない**（`hasLimitedData` が真なら「限られた値」と注記する）。
- `LH-seo` のしきい値は 1.0（SEO 対策がこの計測の目的のため死守ライン）。他 3 カテゴリは 0.9。しきい値は `frontend/verdant-virgo/lighthouserc.cjs` に定義されている。
- `ERR-rate` が「Strapi のサーバ側のみ」なのは、ブラウザ側に PostHog のスクリプトが無く、フロントエンドの例外が 1 件も届いていないため。
- `CONTENT-throughput` は現状で唯一実際にデータが流れている指標（`article_created` / `article_published` / `article_updated` / `article_deleted` の 4 イベント）。ただし `distinct_id` は固定値 `strapi_cms` で、`$process_person_profile: false` により person を作らないため、**執筆者別の内訳は取れない**。
- **`CONTENT-throughput` と `ERR-rate` は本番用の PostHog のプロジェクトから数える**（ADR-16）。PostHog のプロジェクトを開発と本番で分けたため、開発環境の Strapi（試験用）の記事イベントと例外は開発用のプロジェクトに入り、KPI に混ざらない。**今流れているデータは開発環境の Strapi のもの**であり、本番の Strapi（`E-04` の正本。ADR-16）を立てるまでは本番の `CONTENT-throughput` の実測値は無い（状態の `実装済み` は「計測の仕組み」の状態である）。
- **`CONTENT-throughput` と `公開記事数` は、Strapi での公開の時点で数える。訪問者に届く配信の時点ではない。** ADR-17 で、本番の記事は `R2` が管理画面で公開し、その後に監視アプリの定期実行がビルドと計測を起こし、人間が配信する 2 段階になった。`article_published` は公開の操作で出るため、公開したが配信していない記事も数える。`E-13` の `applied_at` は配信の完了で記録する（DA-01 の 6.2）ため、効果の検証の起点とはずれる（6 節）。

### 4.4 CTA とフォームの計測イベント（PostHog）

4.2 の `CTR-cta` と `FORM-abandon`、4.3 の `FORM-failure` と `FORM-invalid` が使うブラウザ側のイベントを、名前・発火条件・プロパティまで固定する。

**命名規則は「対象_過去分詞」の `snake_case`** とする（Strapi のサーバ側イベント `article_created` / `article_published` と同じ形。`I-01`）。**目的（無料相談か無料 DL か）をイベント名に入れない。** 名前に目的を混ぜると、CTA の種類が増えるたびに指標の式が増える。目的はプロパティ（`cta_type` / `form_key`）に入れ、`CTR-cta` を 1 組のイベントで出して内訳をプロパティで切る。

| イベント | 発火条件 | プロパティ | 使う指標 |
|---|---|---|---|
| `cta_viewed` | CTA の要素が画面内に 50% 以上入ったとき（1 ページの表示につき、1 つの CTA で 1 回） | `cta_id` `cta_type` `cta_role`（`primary` / `secondary` / `assist`） `page_path` | `CTR-cta` の分母 |
| `cta_clicked` | CTA のボタン・リンクを押したとき | 上と同じ ＋ `destination` | `CTR-cta` の分子 |
| `form_started` | フォームのいずれかの入力欄に初めてフォーカスしたとき | `form_key`（`consult`。`source_dl` は 2026-10-20 にフォームを消した） `mautic_form_id` `cta_id` `page_path` | `FORM-abandon` `FORM-invalid` の分母 |
| `form_validation_failed` | 送信ボタンを押して入力エラーが出たとき | 上と同じ ＋ `fields`（エラーのあった項目名の配列。**入力された値は送らない**） | `FORM-invalid` の分子 |
| `form_submitted` | Mautic から成功の応答が返ったとき（`I-08`） | `form_key` `mautic_form_id` `cta_id` `page_path` | `FORM-abandon` の分子、`FORM-failure` の分母の一部 |
| `form_submit_failed` | エラー応答・通信断・10 秒の無応答のとき（`I-08` のタイムアウトは DD-01 の 7.2） | 上と同じ ＋ `error_kind`（`timeout` / `network` / `http_4xx` / `http_5xx` / `duplicate`） | `FORM-failure` の分子 |
| `booking_viewed` | 無料相談の完了画面の予約枠が画面内に 50% 以上入ったとき（1 ページの表示につき 1 回） | `cta_id`（`booking_thanks_embed`） `cta_type`（`booking`） `cta_role`（`primary`） `page_path` | 商談プロセスの段 2 の歩留まり（下記） |
| `booking_scheduled` | Cal.com の埋め込みから「予約が完了した」通知を受けたとき（`I-25`） | 上と同じ | 同上 |

- **`cta_viewed` / `cta_clicked` の 2 つは 4.2 の `CTR-cta` の行で既に名前が決まっていたもの**で、ここで足したのはプロパティである。**フォームの 4 つは新規**であり、どちらも 2026-09-20 の G2 で承認された（`docs/BasicDesign/DesignSpec/website/01-content-spec.md` の 6.2。同 10.3 の F8' がこの表への取り込みを残していた。**2026-10-01 に反映**）。
- **予約の 2 つ（`booking_*`）も 2026-10-01 に足した**（同文書の 10.3 の F11）。商談プロセスの段 2（BA-04）を測るためのもので、**既存のイベントでは表せない**（予約は自前のフォームの送信でもリンクの遷移でもなく、**第三者の埋め込みの中で完了する**）。`form_submitted` を流用すると Mautic のフォーム送信と Cal.com の予約が同じ名前に混ざり、「CV の正本は Mautic のフォーム送信」（1.2）が曖昧になる。
- **`booking_clicked` は作らない。** 埋め込みの中のクリックはこちらから観測できないため、`cta_clicked` を無理に出すと「押していないのに出る」「押しても出ない」の両方が起きる。観測できるのは「枠が見えた」と「予約が完了した」の 2 点だけである。
- **`form_submitted` と `booking_scheduled` の比が、商談プロセスの段 2 の歩留まり**（相談を申し込んだが面談の予約まで進まなかった割合）になる。**指標 ID を与えるかは未決**（6 節。予約の件数を Cal.com 側から取る手段も決まっていない）。
- **`booking_scheduled` を CV に数えない。** 予約は CV の後に起きる段であり、数えると 1 人を 2 回数える（BA-04 の商談プロセスの「予約を CV の条件にしない」と同じ理由）。`booking_*` のプロパティに**氏名・メールアドレス・予約した日時を入れない**（Cal.com の埋め込みが通知する値のうち、個人に関わるものは受け取っても送らない）。
- **`cta_type` の値は 2026-10-01 に実態に合わせて改められた**（`consult` / `source_dl` / `chat` / `booking`。`trial` は「使わない」として値を残す）。**正本の DA-01 にも同日に反映済み**（DA-01 の 4 節の注記）。この表のプロパティ名（`cta_type`）は変わらない。**指標 ID も同日に合わせた**（1.3）。
- **`CV 数` と `CVR` を `form_submitted` で数えない。** CV の正本は Mautic のフォーム送信（1.2）であり、PostHog のイベントは `CTR-cta` とフォームの離脱・失敗の計測に使う。**両者は必ずずれる**（PostHog は同意した訪問者の分しか無く、Mautic は同意と無関係に全件を受ける）。`form_submitted` の件数を CV として報告しない。
- **ずれの向きは一方向である。** 同意した訪問者は Mautic にも PostHog にも載り、同意していない訪問者は Mautic にだけ載る。したがって `form_submitted` ≦ Mautic のフォーム送信数が常に成り立つ。**逆転したら計測の異常**（二重送信か、イベントの重複発火）として扱う。
- **どのイベントも Cookie の同意の後にだけ送る**（DD-02 の 3 節。PostHog は同意まで初期化しない）。**同意の前の操作を溜めて後から送らない**（DA-03 の 2.1 が実質的に破れる）。
- **プロパティにメールアドレス・氏名・会社名・相談内容を入れない**（`distinct_id` に email を入れない規則と同じ扱い。DA-05 の 1.2）。`form_validation_failed` の `fields` は**項目名だけ**で、入力された値を含めない。
- **`cta_id` は画面をまたいで重複させない**（`cta_id` 単位の集計が混ざる）。同じ文言・同じ見た目でも画面が違えば別の ID にする。`cta_id` の一覧の正本は `01-content-spec.md` の 6.3 で、CTA の定義は `E-06` にあたる。
- **Umami にはイベントを足さない**（DD-02 の 2.3）。Umami は同意と無関係にページビューだけを数え、CVR の分母（`SESSION-count`）を持つ役に徹する。イベントを両方に入れると、同意の有無で母数の揃わない 2 系統の数字ができる。**〔2026-10-06 ADR-25: Umami は廃止した。**後継の **GA4 にもイベントを足さない**。OpenSEO の GA4 のツールはカスタムイベントの値を読めず（ADR-25 の帰結 7）、GA4 のキーイベントを CV に使わないため（1.2）。GA4 は CVR の分母（`SESSION-count`）を持つ役に徹する。**GA4 も PostHog も同意した訪問者だけを数える**ため、旧版の「同意の有無で母数の揃わない 2 系統」の問題は、GA4 と PostHog の間では生じない（揃わないのは Mautic と Chatwoot の全件との間。1.1）〕
- 状態はいずれも `未着手`（ブラウザ側に PostHog のスクリプトが無く、CTA もフォームも未実装）。

### 4.5 収益化の指標（2026-10-03 に追加。月次・`R1` が管理）

| 指標 ID | 定義 | 集計元 | 粒度 | 状態 |
|---|---|---|---|---|
| `MINE-optin` | 期末時点で同意が有効な利用者の数（`E-17` の `revoked_at` が空） | `points-api` の DB | 月次 | 未着手 |
| `MINE-hashrate` | 期間内の利用者全体の平均ハッシュレート | `E-18` | 日次・月次 | 未着手 |
| `PT-granted` | 期間内に `確定` した付与のポイント数 | `E-19` | 月次 | 未着手 |
| `PT-redeemed` | 期間内に `確定` した消化のポイント数 | `E-19` | 月次 | 未着手 |
| `PT-redeem-rate` | `PT-redeemed ÷ PT-granted`（累計） | 導出値 | 月次 | 未着手 |
| `REV-mining-jpy` | 期間内に受け取った POL の円換算の合計 | `E-20` | 月次 | 未着手 |

- **KPI ツリー（BA-01）の 2 本の式には入れない。** 受注数へのつながりは `PT-redeem-rate` で観測する（ポイントが発注で使われているか）。
- **エージェントは読まない。** 指標は `points-api` の管理画面の月次表で人間が見る（AA-03 の 2.6。収益化の MCP は作らない）。

## 5. データ契約（エージェントが観測データを読むときの約束）

エージェントが `E-12 AuditResult` を生成するために観測データを読むとき、以下の契約に従う。契約を固定しないと、実行のたびに取得範囲が変わって `E-13` の `evidence` が比較不能になる。

**定期実行では、この契約を監視アプリのスケジュールの定義に固定して書く**（AA-05 の ADR-17、TA-07 の 3.5）。ADR-05 は契約の固定を n8n のワークフローに期待していたが、エージェントを使う定期処理の起動は ADR-17 で監視アプリに移った。エージェントが書き換えられる場所に定義を置くと、承認を経ずに次の実行の取得範囲が変わり、この契約が守られなくなる。ADR-18 の反映では定義（取得範囲・頻度・使うエージェントとツール）の置き場所を未決定としていたが、**AA-05 の ADR-18 の追加の決定で、定義は Git で持ち、監視アプリは承認済みの `main` から作った別のチェックアウトで読むと決まった**（TA-07 の 3.5）。**契約の値の変更は必ず PR を通る**（`E-14` の承認と同じ経路）。エージェントが作業ツリーで定義を書き換えても、承認されて `main` に入るまで次の実行には効かない。

### 5.1 契約の形

| 観測対象 | 経路 | 粒度 | 期間 | 1 回あたりの上限 | 状態 |
|---|---|---|---|---|---|
| セッション・流入 | **GA4**（2026-10-06。ADR-25。旧版は Umami MCP）。**OpenSEO の MCP**（`get_google_analytics_traffic_acquisition` / `get_google_analytics_page_performance` / `get_google_analytics_organic_landing_pages` / `get_google_analytics_organic_overview` / `get_google_analytics_measurement_health`）。OpenSEO はオンプレのローカルだけ（`openseo`。本番のプロパティだけに接続） | 日次、チャネル別 / 参照元別 / ページ別 | **直近 35 日、終端は 3 日前の終わり（JST）**（GA4 の反映の遅れ 24〜48 時間。5.2.1） | ランキング系は上位 100 件（`limit` は 1〜1,000）。`PAGEVIEW-count` は `hasMore` が偽になるまで `offset` で取り、取り切れなければ書かない | 未配線 |
| 実測の Core Web Vitals | PostHog の `execute-sql`（`$web_vitals` の `$web_vitals_LCP_value` などの 3 つ。**本番用のプロジェクト**）。**GA4 とは別の `E-12` にする**（PostHog が落ちても GA4 の `E-12` に影響させない） | 指標ごとの p75 | 直近 35 日、終端は 3 日前の終わり（GA4 とそろえる） | 集計値 1 行 | 未着手 |
| フォーム送信 | `mautic_list_form_submissions`（`formId` 指定） | 送信 1 件単位 | 判定対象期間のみ | ページングで取得。0 件時は `[]` が返る（null ではない点に注意） | 未配線 |
| コンタクト | `mautic_list_contacts` / `mautic_get_contact` | コンタクト 1 件単位 | 新規は `dateAdded` で絞る | 一覧の 1 ページ分ずつ | 未配線 |
| 会話・応答品質 | `chatwoot_get_report_summary` / `chatwoot_get_report_timeseries` | 期間集計・日次時系列 | 前期間との比較付きで取得 | レポート API は 1 回で完結 | 未配線 |
| 会話の内容 | `chatwoot_list_conversations` / `chatwoot_list_messages` | 会話・メッセージ単位 | 直近の未解決分に限定 | **サーバ固定のページ件数**（後述） | 未配線 |
| 監査ログ | `chatwoot_list_audit_logs` | 操作 1 件単位 | 変更調査時のみ（**誤った書き込みの突き合わせには使わない**。ADR-16 では突き合わせの主な手段としていたが、ADR-17 で下の行に改めた） | 25 件／ページ（Enterprise 機能が必要） | 未配線 |
| エージェントの送信の記録 | `chatwoot_list_conversations` → `chatwoot_list_messages`（エージェント専用ユーザーの `sender` で絞る） | メッセージ単位 | **本番への誤った書き込みの突き合わせ**（`E-13` と照合する。ADR-17、TA-07 の 6.2。監視アプリの定期実行。頻度は未決定） | **サーバ固定のページ件数**（会話 25・メッセージ 20）。送信者で横断して引く手段が無いため、会話を順に読む。**期間とページ数の上限を定期実行の定義に固定する**（6 節） | 未着手 |
| 品質監査 | `frontend/verdant-virgo/.lighthouse/` の JSON を直接読む | ページ単位、カテゴリ別 | 最新のビルド結果 | ファイル読み取りのみ（外部公開しない） | 実装済み |
| 記事イベント | PostHog の insight / query（**本番用のプロジェクト**。ADR-16） | イベント単位 | 直近 90 日 | PostHog の API 制限に従う | 実装済み |
| 検索実績 | OpenSEO の `get_search_console_performance` | ページ単位（クエリ単位は `E-01` の実装後） | 直近 35 日のうち **3 日前まで** | **1 回 1,000 行まで**。`hasMore` なら `startRow` で続きを取る | 未着手 |
| インデックス登録 | OpenSEO の `inspect_urls` | URL 単位 | 取得時点 | **1 回 10 URL まで** | 未着手 |
| 順位計測 | OpenSEO の `get_rank_tracker` | キーワード × 端末 | 保存済みの直近の計測 | 読むだけ（**新たな計測をしない**） | 未配線 |
| サイト監査 | OpenSEO の `get_audit_status` / `get_audit_issues` / `get_audit_pages` | 問題の種類 × ページ | 直近に完了した監査 | 読むだけ | 未着手 |
| 市場データ | OpenSEO の調査系ツール（`research_keywords` など） | キーワード・ドメイン単位 | 取得時点 | **1 回の見積もり 2,000 クレジットまで**（AA-05 の ADR-10） | 未配線 |

- **（2026-10-06 に追加。ADR-25）GA4 の観測は 2 件の `E-12` に分ける**（`agent/analytics-reporter` の実装。`.claude/agents/analytics-reporter.md`）。(a) 流入: `SESSION-count`・`ORGANIC-share`・表 `REFERRER-sessions`・`ORGANIC-landing`、(b) ページ: `PAGEVIEW-count`・表 `PAGE-views`。**`PAGEVIEW-count` が取り切れず (b) が `truncated` になっても、(a) の `SESSION-count` を CVR の分母に使えるようにするため**である。ページの全件は `limit: 1000` で `nextOffset` をたどり、最大 5 回（5,000 行）まで取る。実測の Core Web Vitals は PostHog の別の `E-12` にする（上の表）。
- **（2026-10-06 に追加。ADR-25）GA4 が OpenSEO に接続されていない（`ga4_not_connected`）ときは `fetch.outcome` を `auth_failed` にする**（`empty_but_ok` にしない。人間が OpenSEO の画面で接続し直すまで取れないため。`seo-auditor` が GSC の未接続を `auth_failed` にしているのと同じ）。`comegin.com` のプロジェクトや Web ストリームを特定できないときは `permission_denied`。どちらも `ok` / `empty_but_ok` ではないため、`E-13` の根拠にも CVR の分母にも使わない。
- **（2026-10-06 に追加。ADR-25）Mautic と PostHog の観測の期間も GA4 と同じ「直近 35 日、終端は 3 日前の終わり（JST）」にそろえる**（旧版は終端が昨日）。CVR の分母（GA4）と分子（Mautic）の期間を同じにするためである。上の表のフォーム送信の「判定対象期間のみ」は、日次の観測ではこの期間を指す。

### 5.2 上流 API の制約が契約に与える影響

- **Chatwoot のページ件数はサーバ側で固定されている**（会話 25 / コンタクト 15 / メッセージ 20 / 監査ログ 25）。クライアント側で 1 ページの件数を増やすことはできないため、「直近 100 件の会話を読む」という契約は必ず 4 回のリクエストになる。契約には**件数ではなくページ数の上限**を書く（`最大 4 ページまで` のように）。
- **Chatwoot は `Rack::Timeout` により 15 秒でリクエストを打ち切る。** 期間の広いレポートや全文検索は打ち切られる可能性があるため、月次より長い期間を 1 回で要求しない。起動直後の初回は 500 になることがあるため、1 回だけ再試行する契約にする。
- MCP の応答は `CHARACTER_LIMIT`（25,000 文字）に収まるよう一覧の件数が自動で半分ずつ削られ、`truncation_message` が付く。**削られた分は「次のページ」では取得できない**（ページ境界ではなく応答サイズで削るため）。エージェントは `truncation_message` を見たら、期間や絞り込み条件を狭めて取り直す。
- MCP の応答に含まれる 1,000 文字超の文字列（メール本文の HTML など）は `include_long_text=true` を指定しない限り省略される。本文の全文が根拠に必要な場合のみ明示的に指定する（既定では省略されたまま判断してよい、という前提で契約を書く）。
- **Mautic の更新は `PATCH` 相当のみ**（`PUT` は存在しない ID で新規作成してしまう）。観測は参照のみなので直接の影響は無いが、提案の適用で Mautic を触る場合はこの制約が効く。
- Mautic は 0 件のとき `[]` を返す。空配列を「取得失敗」と誤認しない（失敗はエラーとして返る）。

### 5.2.1 OpenSEO 経由の取得に固有の制約（GSC・GA4）

- **GSC の日付は太平洋時間である。** OpenSEO のツールは GSC の日付を米国太平洋時間のまま返す。この基盤の他の観測は日本時間で切っているため、**同じ「9 月 1 日」でも GSC だけ 16〜17 時間ずれる**。日次の比較では無視できるが、日単位で他の観測と突き合わせる場合は `E-12` の `range` にタイムゾーンを明記する。
- **直近約 3 日の GSC のデータは不完全である**（OpenSEO のツール説明にも明記）。確定分だけを使う（DA-04 の 4 節）。
- **GSC は 1 回 1,000 行までで、並び順はクリック数の降順に固定されている。** 順位や表示回数での絞り込みは、その上位 1,000 行の中でしか効かない（OpenSEO のツール説明）。ページ数が 1,000 を超えるまでは問題にならない。
- **GSC のさかのぼれる期間は 16 か月まで**である。それより前の実績は取れない（登録した日より前も取れない）。
- **GSC の平均掲載順位は Discover と Google ニュースでは返らない。** 返らないことを失敗ではなく「その種別には順位が無い」として扱う（`empty_but_ok` と同じ構造。DD-01 の 4.2）。
- **（2026-10-06 に追加。ADR-25）GA4 の日付はプロパティのタイムゾーン（`Asia/Tokyo`）である**（OpenSEO の `specs/0007`）。GSC（太平洋時間）とはずれるが、この基盤の他の観測（日本時間）とはそろう。
- **GA4 の直近 24〜48 時間は確定していない**（https://developers.google.com/analytics/devguides/collection/ga4/troubleshoot）。終端を 3 日前にする（GSC と同じ）。OpenSEO は終端を「プロパティの最後の完全な日」で切り、切ったときは `end_date_clamped` を返す。
- **GA4 は少ない数を `null` にするか、行ごと省く**（しきい値。OpenSEO はそれを `hasLimitedData` / `subjectToThresholding` で知らせ、0 で埋めない）。欠けた行を 0 と読まない。
- **GA4 の 1 回の取得は 1,000 行まで**（`limit`。既定 100）。続きは `pageInfo.nextOffset` で取る。
- **カスタムイベントの値は読めない**（ADR-25 の帰結 7）。OpenSEO の GA4 のツールは要求の中身（次元・指標・絞り込み）を固定しており、呼び出し側で変えられない。
- **GA4 の読み取りに費用は出ない**（OpenSEO のクレジットを使わない。`specs/0007`）。ただし GA4 の Data API のクォータを使う。
- **調査系は同じ問い合わせでも毎回費用がかかる。** 再現性の条件（5.3）のために同じ `ref` で取り直すことが、そのまま支出になる。**市場データの再取得は検証に必要な場合に限る。**

### 5.3 観測の再現性

`E-12 AuditResult` には、`metrics` の値だけでなく**取得に使ったクエリそのもの**（`ref` 項目）を必ず残す。
同じ `ref` で再取得すれば同じ値になることを再現性の条件とし、再現できない観測（リアルタイム系・打ち切られた応答）は `E-13` の `evidence` に使わない。

## 6. 未決定事項

- ここで定義した指標 ID（`CVR-total` など）は **DA ローカルの識別子**であり、`E-` / `CAP-` / `R` とは別系統である（`docs/README.md` の「ID の採番と正本」）。`E-13` の `expectation.metric` から参照する以上、全層で共有する名前として扱うべきかを BA と調整する必要がある。
- CVR の分母を「全セッション」にするか「対象ページ群のセッション」にするか。全体 CVR は前者、ページ別 CVR は後者になるが、CTA 別 CVR をどちらの分母で出すかは BA の KPI ツリーの形（CTA 別の目標値を全体に対して置くのか、ページ群に対して置くのか）が確定していないため決められない。
- `CVR-assist`（Chatwoot 経由）を上位 KPI に昇格させるかどうか。Web 接客（`CAP-12`）の貢献をリード数に含めるかは事業側の判断であり、DA では決められない。現状は補助指標に留める。
- **（2026-09-18 に解決）Google Search Console の指標（`GSC-*`）の取得手段。** OpenSEO の OAuth 連携で取り、OpenSEO の MCP で読むと決めた（AA-05 の ADR-06・ADR-09）。残るのは人間の作業（ドメインプロパティの登録、OAuth クライアントの発行、接続）だけである。
- `SERP-position` と `GSC-position` のどちらを `E-13` の `expectation.metric` に使うか。4.3 で KPI の正本は `GSC-position` としたが、表示回数が少ないうちは GSC の平均掲載順位が大きく揺れる。**表示回数の下限（たとえば 50 以上）を判定の条件に含めるか**を、実データが溜まってから決める。判断者 `R3`。
- **既存の PostHog のプロジェクトを開発用と本番用のどちらにするか**（ADR-16）。今の Strapi（開発環境）のイベントが入っているプロジェクトを開発用として残し、本番用を新しく作るのか、その逆にするのかを決めていない。今のプロジェクトを本番用にすると、試験用の記事イベントが本番の `CONTENT-throughput` の履歴に残る。PostHog 側の Self-driving（AA-03 の 7.2）がどちらのプロジェクトで動くかも同時に決まる。判断者 `R1` `R3`。
- **`CONTENT-throughput` を公開の時点で数えるか、配信の時点で数えるか**（ADR-17。4.3 の注記）。公開と配信が別の人間の操作に分かれたため、公開したが配信していない記事が `公開記事数` に入る。配信の時点で数えるなら、配信の記録（監視アプリの「承認して配信」の記録か、`E-13` の `applied_at`）を別に数える必要がある。公開の確認の頻度（DA-04 の 5 節）が高ければ差は小さい。判断者 `R2` `R3`。
- **誤った書き込みの突き合わせの取得範囲**（ADR-17。5.1）。エージェント専用ユーザーの送信を横断して引く手段が `chatwoot-mcp` に無いため、会話を順に読む。直近の期間と最大ページ数を定期実行の定義に固定する必要があるが、値が決まっていない。範囲の外に落ちた送信は突き合わせから漏れる。`chatwoot_list_reporting_events` で送信者別に取れるかも確かめていない。判断者 `R1`。
- **（2026-09-19 に AA-05 の ADR-18 の追加の決定で解決）データ契約を固定する定期実行の定義の置き場所**（ADR-17 で生じ、ADR-18 の決定の際に AA-05・TA-07 に明記された。5 節の冒頭）。契約の値をいくら決めても、定義をエージェントが書き換えられる場所に置けば契約は約束にとどまる、としていた。**Git で持ち、監視アプリは承認済みの `main` のチェックアウトで読む。変更は PR を通す。** 残るのは、そのチェックアウトをいつ・誰が更新するか（TA-07 の 9 節）である。
- **（2026-10-01 に解決）指標 ID が `cta_type` の新しい値と対応しない**（`docs/BasicDesign/DesignSpec/website/01-content-spec.md` の 10.3 の F7'）。**`CVR-wp` → `CVR-source-dl`、`CVR-demo` → `CVR-consult` に改名し、`CVR-trial` は廃止した**（1.3。対応する CTA がサイトに無く、分子が永久に 0 になるため）。`cta_type` の値そのものは**正本の DA-01 で同日に改めた**（`consult` / `source_dl` / `chat` / `booking`。`trial` は「使わない」として値を残す）。**残件**: `E-13` の `expectation.metric` に旧 ID を書いた提案はまだ 1 件も無い（`E-13` は 0 件）ため移行の作業は無いが、**今後 `CVR-trial` を見かけたらこの決定より前の記述である**。
- **オンライン面談の予約（`E-16`）の歩留まりを指標として持つか**（4.4。2026-10-01 に `booking_*` を足したことで生じた）。`form_submitted` と `booking_scheduled` の比が商談プロセスの段 2 の歩留まりになるが、**指標 ID も更新頻度も与えていない**。候補の名前は `BOOKING-rate`（既存の `CTR-cta` `FORM-abandon` と同じ「対象-内容」の形）。**正本をどちらにするかも決める**: PostHog のイベント（同意した訪問者に限られる）か、**本番の Cal.com の予約の件数（`E-16`。全件だが取得手段が未確認）**か。**`CVR-*` には入れない**（CV の後ろの段。1.4）。BA-04 の未決定事項「予約を指標として持つか」と同じ論点である。判断者 `R3`。
- **（2026-10-06 に追加。ADR-25）CVR の分母と分子の母集団の偏りの補正**（1.1 の注記）。分母（GA4 のセッション）は同意した訪問者だけ、分子（Mautic のフォーム送信）は全員のため、同意率が下がると CVR が見かけ上上がる。**同意率（`consent-api` の記録の `granted` の割合）で分母を割り戻すか、補正せず注記と比較の除外（1.1）だけで扱うか**を決める。割り戻すなら、同意率の定義（記録の単位が訪問者かセッションか）と GA4 のセッションの単位がそろうかを確かめる必要がある。下の「同意率を測る手段」と一体で決める。判断者 `R3`。
- **（2026-10-06 に追加。ADR-25）GA4 の BigQuery エクスポートを使うか。** 使えばしきい値・行の省略を避けられ、カスタムイベントも読める。費用（Google Cloud）と、OpenSEO の外の読み取りの経路が増えることと引き換えになる。判断者 `R1`。
- **（2026-10-06 に追加。ADR-25）GA4 のデータ保持（14 か月）が、OpenSEO のツールが読むレポートに効くか。** 前年同月比（DA-05 の 2 節）が取れるかに効く。確かめていない。判断者 `R3`。
- **同意率を測る手段**（2026-10-01 の決定で生じた。DD-02 の 4.4・7 節）。**（2026-10-06 の注記）ADR-25 で GA4 も同意の対象に入り、`CVR-assist` だけでなく `CVR-total` `CVR-consult` `CVR-source-dl` の分母も同意率に左右されるようになった**（上の項）。Chatwoot が同意の対象に入ったため、`CVR-assist` の分子が同意した訪問者の会話だけになり、**同意率が下がると `CVR-assist` も下がる**。同意率そのものを持たないと切り分けられないが、同意バナーの操作は計測しないと決めている（同意の前は PostHog が動かない）。同意の記録（サーバ側。DD-02 の 3.3）の件数で代えられるかを決める必要がある。判断者 `R3`。
- 実験（`E-11`）の有意差判定の基準（有意水準・最小サンプルサイズ）。PostHog の実験機能に任せるか、`R3` が独自に判定するかが未確定。ブラウザ側トラッカーが無く実データで検証できないため、配線後に決める。
- **（2026-10-03 に追加）`REV-mining-jpy` の円換算の基準。** 受け取った時点の価格か、換金した時点の約定か（税理士の確認〈承認ゲート G-2〉に従う）。
