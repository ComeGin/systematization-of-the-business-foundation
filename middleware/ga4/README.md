# GA4（アクセス解析の正本。本番のプロパティの設定の記録）

**ADR-25（`docs/RequirementDefinition/AA/05-application-decisions.md`）で、流入・ページ・参照元の数字の正本を Google Analytics 4（GA4）にし、Umami をやめた。**
GA4 は Google の SaaS で、こちらで動かすものは無い。このディレクトリには**プロパティの設定値・タグの仕様・OpenSEO からの読み取りの記録**と、
値が揃っているかを確かめる setup（`setup/index.mjs`、id `ga4`）だけを置く（`middleware/n8n` と同じ「設定・運用のみ」の扱い）。

- 指標の定義（`SESSION-count`・`ORGANIC-share` など）は DA-02、同意の扱いは DD-02 の 4 節・8 節にある。ここには書かない
- TA-01 の 8 節の SaaS の基準は変えない。ADR-24（Cal.com）と同じ「ユーザーの決定による例外」

## 1. プロパティ（本番の 1 つだけ）

開発環境用のプロパティは作らない。**開発の公開サイト（`astro dev`）にはタグを出さない**（ユーザーの決定）。

| 項目 | 値 | Admin API での名前（確かめるとき用） |
|---|---|---|
| プロパティ | 本番の 1 つだけ（例: `ComeGin（本番）`） | `properties/{GA4_PROPERTY_ID}` |
| レポートのタイムゾーン | `Asia/Tokyo`（日本） | `Property.timeZone` |
| 通貨 | `JPY`（日本円） | `Property.currencyCode` |
| データ保持（イベント・ユーザー） | **14 か月**（作成直後は 2 か月のことがあるので必ず確かめる〈既定値は未確認〉。26 か月以上は 360 だけなので、無償版の上限は 14 か月） | `DataRetentionSettings.eventDataRetention`／`userDataRetention` = `FOURTEEN_MONTHS` |
| Google シグナル | **オフ** | `GoogleSignalsSettings.state` = `GOOGLE_SIGNALS_DISABLED`（未選択は `GOOGLE_SIGNALS_STATE_UNSPECIFIED`） |
| ユーザー提供データの収集 | **オフ** | `UserProvidedDataSettings.userProvidedDataCollectionEnabled` = `false` |
| 広告のリンク（Google 広告など） | **作らない** | `properties.googleAdsLinks` が空 |
| Web データストリーム | 1 つ。URL `https://comegin.com` | `properties.dataStreams`（`webStreamData.measurementId` が測定 ID） |
| 拡張計測（2026-10-06 リード決定） | ページビュー（ブラウザの履歴の変更を含む）・スクロール・離脱クリック・サイト内検索・ファイルのダウンロードは**オン**。**フォームの操作はオフ**（CV の正本は Mautic。GA4 に 2 つ目の CV の数字を作らない）。**動画エンゲージメントはオフ**（動画が無い）。拡張計測のイベントはエージェントからは見えない（下の 6 節） | `EnhancedMeasurementSettings`: `streamEnabled`・`pageChangesEnabled`・`scrollsEnabled`・`outboundClicksEnabled`・`siteSearchEnabled`・`fileDownloadsEnabled` = `true`、`formInteractionsEnabled`・`videoEngagementEnabled` = `false` |

setup の設定キー（`~/.config/comegin/setup/prod.conf`。`--target prod` だけで使う。どちらも秘密値ではない）:

| キー | 形式 | どこで見るか |
|---|---|---|
| `GA4_PROPERTY_ID` | 数字だけ | GA4 の 管理 → プロパティの設定 → プロパティの詳細 の「プロパティ ID」 |
| `GA4_MEASUREMENT_ID` | `G-` で始まる英大文字・数字 | 管理 → データの収集と修正 → データストリーム → Web ストリームの「測定 ID」 |

## 2. タグ（公開サイト `frontend/verdant-virgo`）

| 項目 | 仕様 |
|---|---|
| 読み込み | **gtag.js を直接置く**（`https://www.googletagmanager.com/gtag/js?id=<測定 ID>`）。**GTM は使わない**（GTM の画面から PR を通らずにスクリプトを足せてしまい、コードを正本にする方針〈ADR-18〉と合わない） |
| 環境変数 | `PUBLIC_GA4_MEASUREMENT_ID`（`G-` で始まる。秘密値ではない）。**未設定ならタグを出さない。開発環境では設定しない** |
| Cookie | `_ga`（ユーザーの区別）・`_ga_<ID>`（セッションの状態）。どちらも既定の有効期限は 2 年。**同意の対象**（Umami は Cookie を使わず同意の前でも数えていたが、GA4 は同意の後だけ） |

**Consent Mode v2 の basic**（同意の前はタグそのものを読み込まない。同意しない訪問者のデータは、同意の状態も含めて Google に送られない）:

1. 同意（Cookie `comegin_consent` の `s=granted`）が無いうちは、gtag.js も `gtag()` の呼び出しも置かない
2. 同意があれば（またはバナーで同意した直後に）、次の順で動かす。`consent default` は `config` より前でなければ効かない

```html
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('consent', 'default', {
    ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
    analytics_storage: 'denied',
  });
</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
  gtag('js', new Date());
  // Google シグナルと広告のパーソナライズはタグ側でも止める（プロパティの設定が誤って変わっても効かないように）
  gtag('config', 'G-XXXXXXXXXX', { allow_google_signals: false, allow_ad_personalization_signals: false });
  // 同意済みなので analytics_storage だけを granted にする。広告の 3 つは常に denied のまま
  gtag('consent', 'update', { analytics_storage: 'granted' });
</script>
```

3. 同意を取り消したら `gtag('consent', 'update', { analytics_storage: 'denied' })` を送り、以後のページではタグを読み込まない

実装の正本は公開サイトのコード（DD-02 の 6.1 の設置の順序）。上は仕様の確認用の形で、そのまま貼るものではない。

## 3. CSP（公開サイトの応答ヘッダー）

旧構成（Umami）の `stats.comegin.com` は外す。足すのは Google のガイドの**広告の機能を使わない Google Analytics** の値（広告のリンクを作らないので、広告用の `*.g.doubleclick.net` などは足さない）。

| ディレクティブ | 足すもの |
|---|---|
| `script-src-elem` | `https://www.googletagmanager.com` |
| `img-src` | `https://www.googletagmanager.com`・`https://*.google-analytics.com` |
| `connect-src` | `https://www.googletagmanager.com`・`https://*.google-analytics.com`・`https://*.google.com` |

- gtag の初期化のインラインスクリプト（`consent default`・`config`）は `'unsafe-inline'` ではなく nonce かハッシュで許す
- `cloud/` には CSP が無い（CloudFront の AWS 管理のレスポンスヘッダーポリシーは CSP を含まない）。CSP を足すのは公開サイトの実装のとき
- 足りないものがあれば、Tag Assistant の「CSP issue」か CSP の違反の報告（`report-to`）に出る

## 4. OpenSEO の接続（読み取りの口）

エージェントは GA4 を直接読まない。**オンプレの OpenSEO（`127.0.0.1:3001`、MCP の登録名 `openseo`）の GA4 連携**を通して読む。
OpenSEO に接続するのは本番のプロパティだけ。

| 項目 | 値 |
|---|---|
| OAuth クライアント | Search Console と同じ Google Cloud のプロジェクト・同じ Web アプリケーションのクライアント（同意は GSC とは別に 1 回要る） |
| 有効にする API | **Google Analytics Admin API**（接続時のプロパティの一覧）と **Google Analytics Data API**（レポート） |
| リダイレクト URI | `http://localhost:3001/api/ga4/oauth/callback`（GSC の `/api/gsc/oauth/callback` は残す） |
| スコープ | `https://www.googleapis.com/auth/analytics.readonly`（と `openid`・`email`・`profile`）。書き込みのスコープは無い |
| 接続 | OpenSEO の画面のプロジェクトのダッシュボードか Project settings → Analytics の **Connect with Google** → プロパティを選ぶ |
| setup の設定キー | 済んだら `OPENSEO_GA4_CONNECTED=yes`、接続しないと決めたら `OPENSEO_SKIP_GA4=yes`（`middleware/open-seo-main/dev/setup/index.mjs`。接続の有無は OpenSEO の DB の中で `/api/health` には出ないので申告制） |

`analytics-reporter` に持たせる GA4 のツールは `get_google_analytics_traffic_acquisition`・`get_google_analytics_page_performance`・
`get_google_analytics_organic_landing_pages`・`get_google_analytics_organic_overview`・`get_google_analytics_measurement_health` の 5 本
（と `list_projects`・`get_project_context`）。定義は `.claude/agents/analytics-reporter.md`。

## 5. 手で行う操作（setup が止まって頼むもの）

setup は GA4 の API を呼ばない。**`--target dev` では 1〜6 を飛ばし、7 だけを確かめる**（開発の時点では公開サイトが AWS に展開されておらず、本番のプロパティに送るものも読むものも無い）。公開サイトが Route 53 から配信された後に `node setup/setup.mjs --target prod --phase google` を実行すると、値が `prod.conf` に無ければ次の手順を表示して止まる（id `ga4:property`）。OpenSEO への接続（`openseo:ga4-connect`）も prod だけで出る。

1. https://analytics.google.com/ で、本番のプロパティを作る（アカウントが無ければ先に作る）。タイムゾーン `日本`、通貨 `日本円（JPY）`
2. Web データストリームを作る（URL `https://comegin.com`）。拡張計測の歯車で、ページビュー（詳細設定の「ブラウザの履歴イベントに基づくページの変更」を含む）・スクロール数・離脱クリック・サイト内検索・ファイルのダウンロードをオン、**フォームの操作と動画エンゲージメントをオフ**にする（1 節の表）
3. 管理 → データの収集と修正 → **データの保持** で、イベントデータとユーザーデータの保持を **14 か月** にする
4. 管理 → データの収集と修正 → **データ収集** で、Google シグナルのデータ収集と、ユーザー提供データの収集が **オフ** であることを確かめる
5. 管理 → サービス間のリンク設定 で、Google 広告などのリンクを作らない
6. プロパティ ID（数字）と測定 ID（`G-…`）を `prod.conf` の `GA4_PROPERTY_ID`・`GA4_MEASUREMENT_ID` に書く
7. 開発の公開サイトの環境変数（`frontend/verdant-virgo` の `.env`・`.env.local`・`.env.development`・`.env.development.local`）に `PUBLIC_GA4_MEASUREMENT_ID` を書かない（書いてあると setup が失敗する。消してから `--from ga4` で実行し直す）

本番のビルドに `PUBLIC_GA4_MEASUREMENT_ID` を渡すのは本番のビルドの設定（`cloud/`）。画面の表記は Google 側で変わることがある。

## 6. 受け入れたこと（ADR-25 の結果。詳細は ADR-25）

- 同意しない訪問者の数は失う（basic のため、モデリングも無い）
- Google LLC（米国）への越境移転。プライバシーポリシーと同意のポリシーの版（`CONSENT_POLICY_VERSION`）を上げる
- 反映の遅れ（24〜48 時間）。観測の期間の終端は 3 日前
- しきい値・行の省略（少ない数は `null` か行ごと欠ける。0 で埋めない。OpenSEO の `specs/0007`）
- OpenSEO の GA4 ツールはカスタムイベントの値を読めない。拡張計測や独自のイベントは、エージェントからは `key_events` の件数しか見えない

## 7. Umami から変わった点

| 項目 | Umami（〜2026-10-06） | GA4（ADR-25） |
|---|---|---|
| 動かす場所 | 開発は `middleware/umami`（自作の compose、`127.0.0.1:3000`。削除済み）、本番は ECS（旧 `stats.comegin.com`。ADR-25 で廃止し、CSP からも外す） | Google の SaaS。こちらで動かすものは無い（**ポート 3000 は空き**） |
| 開発環境 | 開発用の Umami に送っていた | **タグを出さない**（測定 ID を設定しない） |
| Cookie・同意 | Cookie なし。同意の前でも送っていた | `_ga`・`_ga_<ID>`。**同意の後だけ** |
| 読み取り | Umami の MCP（`umami`・`umami-prod`） | OpenSEO の MCP（`openseo`）の `get_google_analytics_*` |
| フォームの hidden field | `umami_session_id` | **廃止し、代わりを足さない**（訪問者単位の突合はしない。DA-03） |
| setup のモジュール | `umami`（起動・管理者・API キー・`umami-dev.env`） | `ga4`（設定値の確認だけ） |

開発環境に残るもの（スクリプトは消さない。不要ならユーザーが消す）: Docker のボリューム `umami_db-data`・`umami_umami-db-data`・`umami-master_umami-db-data`、
状態ファイル `~/.config/comegin/setup/dev.state.json` の `UMAMI_*`、`~/.config/comegin/mcp/umami-dev.env`。

## 出典

- Consent Mode（basic と advanced の違い、同意の種類）: https://developers.google.com/tag-platform/security/concepts/consent-mode
- Consent Mode の実装（`consent default` を `config` より前に呼ぶ、`update` の書き方、v2 の `ad_user_data`・`ad_personalization`）: https://developers.google.com/tag-platform/security/guides/consent
- CSP（Google Analytics の表と、広告の機能を使わない場合の表）: https://developers.google.com/tag-platform/security/guides/csp
- gtag.js の Cookie（`_ga`・`_ga_<container-id>`、2 年）: https://developers.google.com/analytics/devguides/collection/ga4/tag-options
- プロパティ（`timeZone`・`currencyCode`）: https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/properties
- データ保持（`FOURTEEN_MONTHS`）: https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/DataRetentionSettings
- Google シグナル（`GOOGLE_SIGNALS_DISABLED`）: https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1alpha/GoogleSignalsSettings
- ユーザー提供データ（`userProvidedDataCollectionEnabled`）: https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1alpha/UserProvidedDataSettings
- 拡張計測（項目の名前。`formInteractionsEnabled` は既定 `false`）: https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1alpha/EnhancedMeasurementSettings
- gtag の config（`allow_google_signals`・`allow_ad_personalization_signals`。どちらも既定は `true`）: https://developers.google.com/analytics/devguides/collection/ga4/reference/config
- Vite の環境変数ファイル（開発では `.env`・`.env.local`・`.env.development`・`.env.development.local` を読む）: https://vite.dev/guide/env-and-mode#env-files
- OpenSEO の GA4 連携: `middleware/open-seo-main/docs/SELF_HOSTING_GOOGLE_ANALYTICS.md`、`src/shared/ga4.ts`（スコープ）、`src/server/features/google/selfHostedOAuth.ts`（`/api/ga4/oauth/callback`）
