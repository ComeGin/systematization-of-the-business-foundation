# Web サイト（公開サイト）の画面実装 — Figma → `frontend/verdant-virgo`（Agent teams 実行用）

## Context

公式サイトのデザインは Figma `JRYPLER6E0liA7cUurIhSo`（10 画面 × Desktop 1440 / Mobile 390 ＋ 状態の派生 10 枚 ＝ 34 フレーム。2026-10-08 改訂済み）と画面仕様 4 ファイル（`MarketingDepartment/WebsiteOperations/docs/BasicDesign/DesignSpec/website/00〜03`）で確定している。一方、`frontend/verdant-virgo` は Astro の basics テンプレートのままで、ページは `index.astro`（Welcome）1 枚、shadcn は `button.tsx` だけ、`global.css` は neutral の既定値、外部連携（Strapi・GA4・同意・Chatwoot・Mautic・Cal.com）は 1 つも無い。

この計画は、Figma の全画面と状態を Astro に実装し、**フロント側の外部連携をすべて DD-02（`docs/DetailedDesign/02-public-path-flows.md`）どおりに配線する**。

### ユーザーの決定（2026-10-09）

| # | 論点 | 決定 |
|---|---|---|
| U-1 | 範囲 | **画面 ＋ フロント側の配線すべて**（Mautic への送信・consent-api・GA4/PostHog/Chatwoot の同意後の読み込み・Cal.com の埋め込み・Strapi からの記事の取得）。**外部製品の設定変更（Mautic のフォーム・カスタムフィールド・CORS、Cal.com のイベント、Chatwoot の初回メッセージ、GA4 のプロパティ）は含めず `03-handoff.md` に申し送る** |
| U-2 | 検証 | `pnpm build`・`pnpm lh`・Playwright（`playwright-host`）での画面確認を**許可** |
| U-3 | フォルダ | **機能モジュール `src/modules/<名前>/`**。`pages/` は組み立てだけ。shadcn は `src/components/ui/` のまま |

### 計画の側で決めたこと（リードが既定とする。異論があればゲート G-1 で覆せる）

| # | 決定 | 理由 |
|---|---|---|
| P-1 | **静的出力（SSG）のまま**。adapter を足さない。フォーム・同意・計測・予約はブラウザから各受け口へ直接（DD-02 の経路のとおり） | ADR-11（実行時に Strapi を参照しない）・CloudFront 配信。サーバ処理の置き場が要らない |
| P-2 | **正本は Figma ではなく `01-content-spec.md` の文言**。Figma は見た目（寸法・色・構図）の参照にだけ使う | Figma の文字は和欧間の半角スペースと行区切り U+2028 を含む（H-17・H-18）。**文言は仕様書から写し、和欧間は仕様書の半角スペースのまま。CSS の `text-autospace` は使わない**（H-17 の「どちらかに決める」の後者。全ブラウザで同じ結果になる） |
| P-3 | 改行位置: 見出しの指定改行（H-19。トップ h1・会社概要 h1・1-4a の h2）だけ `<br>` を Desktop/Mobile のクラスで出し分ける。それ以外は `word-break: auto-phrase`（対応ブラウザだけ効く漸進的な強化）と `overflow-wrap: anywhere` を当てない | Mobile の h1・h2 は 1 行全角 11 字以内（§4.5） |
| P-4 | **静的な部品は `.astro`、操作のある部品だけ React island**（Mobile の Sheet、ContactForm、SourceDownloadBlock、CookieBanner、BookingEmbed）。FAQ は `<details>`/`<summary>` で JS なし | Lighthouse performance 0.9 を守る |
| P-5 | 書体は `@fontsource`（Poppins・Noto Sans JP・JetBrains Mono の 400/500/600/700）で自前配信。`@fontsource-variable/inter` は外す。和文の 600 は 700 を当てる（H-4） | Google Fonts への外部通信を増やさない（CSP・プライバシー）。`unicode-range` 分割で必要な字だけ読む |
| P-6 | ダークモードは作らない（`.dark` は使わない） | デザインに無い |
| P-7 | 二重送信の記録は DD-02 5.2 のとおり `sessionStorage`、キーは `mautic_form_id + lower(email) + JST の日付` | DD-02 が上位 |
| P-8 | `MAUTIC_FORM_ID_*` は `PUBLIC_` を付けずビルド時に `.astro` で読み、props で island に渡す | 仕様書 §5.1 F9 の変数名を変えない。秘密値ではない |

## モジュール構成（`src/modules/`）と所有者

各モジュールは `index.ts`（公開する部品と関数）と `components/`・`lib/` を持つ。**他モジュールは `index.ts` 経由でだけ import する。**

| モジュール | 中身 | 所有 |
|---|---|---|
| `brand` | `Logo`（横組み・縦組み・シンボル × フルカラー/ネイビー/白。SVG は `~/ComeGin/comegin/assets/logo/` から写す） | foundation |
| `layout` | `BaseLayout`（`<html lang="ja">`、title・description・canonical・robots・OGP・ファビコン、Skip link、計測・同意・チャットの差し込み口）、`SiteHeader`（CTA Primary/Outline）、`MobileMenuSheet`、`SiteFooter`（Cookie 設定ボタンの差し込み口）、`Breadcrumb`、`AnnouncementBanner`、`PageIntro` | foundation |
| `marketing-ui` | `CTAButton`、`SectionHeading`、`ServiceCard`、`PricingCard`、`IconCard`、`Steps`/`StepItem`、`FAQItem`、`CTABanner`、`BlogCard`、`LogoCloud`・`TestimonialCard`・`StatCard`（ダミー）、`ImagePlaceholder`、`Section`（余白 96/64・コンテンツ幅 1152/358） | foundation |
| `site-content` | 料金の表（§2 の 1 か所だけ）、サービス 4 件のデータ（§4.3/4.3+）、ナビ・フッターのリンク、SEO メタ（§7）、`cta_id` の一覧（§6.3） | 料金・サービス＝builder-sales／ナビ・フッター＝foundation／SEO・cta 一覧＝integrations（各ファイルを分けて衝突させない） |
| `analytics` | GA4（Consent Mode v2 basic・`PUBLIC_GA4_MEASUREMENT_ID` 未設定ならタグを出さない）、PostHog（`posthog.astro` のハードコードの key を環境変数へ）、`cta_viewed`/`cta_clicked`（`data-cta-*` 属性 ＋ IntersectionObserver）、`form_*` 4 種、Web Vitals。**同意の前は送らず、溜めて後から送らない** | integrations |
| `consent` | `CookieBanner`（Desktop 左下 420px カード／Mobile 下端パネル）、Cookie `comegin_consent` の読み取り、consent-api への `POST /v1/consent`（応答を待たない）、撤回、「Cookie 設定」での再表示、同意の変化を他モジュールへ知らせるイベント | integrations |
| `chat` | Chatwoot のローダー（同意後だけ、バナー表示中はランチャーを隠す K4） | integrations |
| `forms` | `FormField`・`ConsentCheckbox`・`CheckboxField`、`ContactForm`（7 状態）、`SourceDownloadBlock`（Subtle/Strong × 5 状態）、検証（§5.1 の文言）、Mautic 送信（10 秒・再送なし・email 小文字化・hidden 項目・二重送信）、`?from=`・`?cta=`・`?service=` の受け渡し | integrations |
| `booking` | `BookingEmbed`（Cal.com SaaS の埋め込み、読み込み失敗の代わりの案内、`booking_viewed`/`booking_scheduled`） | integrations |
| `blog` | Strapi の取得（ビルド時だけ・`publishedAt` 有りだけ・0 件や画像の失敗でビルド失敗・`dist/` に Strapi の URL が残ったら失敗。DD-05 の 1 節）、dynamic zone（rich-text・quote・media・slider）の描画、カテゴリ・ページ送り、画像の取り込み（ADR-11） | integrations |
| `legal` | 法務テンプレート（目次・表・外部リンクは新しいタブ）、プライバシーポリシーと特商法の本文（§4.10 の 10-A/10-B） | builder-site |

ページ（`src/pages/`）: `index`、`services/index`、`services/[slug]`（4 件を `getStaticPaths`）、`pricing`、`about`、`contact/index`、`contact/thanks`、`blog/index`（＋ページ送り）、`blog/[slug]`、`404`、`legal/privacy`、`legal/tokushoho`。

### モジュール間の契約（Wave 1 の最初に foundation と integrations が `index.ts` の型だけ先に置く）

- `CTAButton`: `{ ctaId, ctaType: 'consult'|'source_dl'|'chat'|'booking', ctaRole: 'primary'|'secondary', href, size, variant, fullWidth }` → `data-cta-id`・`data-cta-type`・`data-cta-role` を出す（analytics が拾う）。Mobile の主 CTA は実効 44px（H-13）
- `contactHref({ cta, from, service? })`（`site-content`）: `/contact?cta=…&from=<ビルド時のパス>&service=…`
- `BaseLayout` の props: `title`・`description`・`noindex`・`headerCta: 'primary'|'outline'`・`breadcrumb`・`ogImage?`
- 同意: `onConsentChange(cb)`・`getConsent()`（`consent` の `index.ts`）

## 守る規則（全員）

1. 最初に `03-handoff.md` を全部、`01-content-spec.md` の §0・§1・担当画面の §4.x・§5〜§8 を読む。文言は**仕様書から一字一句写す**（料金は §2 の表だけから）。`【要記入】`・`『要確認』`・「（準備中）」の印は消さない。架空の社名・人名・数値を足さない
2. 色は役割トークン（`role/*` 相当の CSS 変数）で書く。`brand.blue.500` を文字に使わない（H-5）。リンクは `role/text-link`＋下線、青の強調は `role/text-brand`（H-15）。影はネイビー透過（H-1）。8pt グリッド（H-14）。本文 1 行 720px まで（H-10）。主 CTA は 1 画面 1 種類
3. Figma は `figma:figma-design-to-code` スキルを読んでから `get_design_context`／`get_screenshot` で 1 フレームずつ見る（ノード ID は `00 Cover` の画面一覧の表）。**Figma の文字は貼らない**（P-2）
4. shadcn の部品は shadcn MCP（`get_add_command_for_items`）で入れる（入れるのは foundation だけ）。Astro は astro-docs MCP、外部製品は calcom・posthog・chatwoot・n8n-docs・google-dev-knowledge で確かめる
5. 自分の所有ファイルだけに書く。他モジュールの変更が要るときは所有者に SendMessage
6. git の状態を変えない。`.env` を読まない（値が要るときはリードに頼む）。`pnpm` だけ使う。テストのコードを書かない。**ビルドと Lighthouse はリードと qa-reviewer だけが走らせる**
7. dev サーバーはリードが 1 つだけ起動する（`astro dev --background`、4321）。各自は止めない

## チーム構成（リード ＋ teammate 5 人）

| 名前 | 担当 | 書き込んでよい範囲 | plan approval |
|---|---|---|---|
| **lead**（メインセッション） | Wave 0・4、ゲートの取り次ぎ、`astro.config.mjs`・`lighthouserc.cjs` | 左の 2 ファイル、`03-handoff.md`、`verdant-virgo/README.md` | — |
| `foundation` | トークン・書体・テーマ、shadcn の導入、`brand`・`layout`・`marketing-ui`、ナビ・フッターのデータ | `src/styles/**`、`src/components/ui/**`、`src/lib/**`、`src/modules/{brand,layout,marketing-ui}/**`、`src/modules/site-content/nav.ts`、`public/**`、テンプレートの残骸（`Welcome.astro`・`Layout.astro`・`PostHogLayout.astro`・`SplitText.tsx`・`assets/`）の削除 | 要 |
| `integrations` | `analytics`・`consent`・`chat`・`forms`・`booking`・`blog`、SEO メタと `cta_id` の一覧、環境変数 | `src/modules/{analytics,consent,chat,forms,booking,blog}/**`、`src/modules/site-content/{seo,cta}.ts`、`src/env.d.ts`、`.env.example`、`src/components/posthog.astro`（移して削除） | 要 |
| `builder-sales` | トップ・サービス一覧・サービス詳細 4 件・料金 | `src/pages/{index,pricing}.astro`、`src/pages/services/**`、`src/modules/site-content/{pricing,services,top}.ts` | 要 |
| `builder-site` | 会社概要・無料相談＋完了・ブログ一覧＋記事・404・法務 2 件 | `src/pages/{about,404}.astro`、`src/pages/{contact,blog,legal}/**`、`src/modules/legal/**`、`src/modules/site-content/{about,contact}.ts` | 要 |
| `qa-reviewer` | 見比べ・規則の検査・ビルド・Lighthouse | 書き込みなし（報告は SendMessage。一時ファイルは scratchpad） | 不要 |

## Wave とタスク（共有タスクリストに依存関係つきで登録する）

### Wave 0 — リードのみ

| # | 内容 |
|---|---|
| L0-0 | この計画書を `docs/superpowers/plans/2026-10-09-website-implementation.md` に写す（teammate が読む正本。既存の計画書と同じ置き場所） |
| L0-1 | Figma MCP（`get_screenshot` は読めることを確認済み）・`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`（確認済み）・shadcn / astro-docs MCP が読み込めることを確かめる |
| L0-2 | 開発の Strapi（1337）に**公開済みの記事が 1 件以上**あるかを `strapi-mcp` の `list_article` で確かめる。0 件ならビルドが設計どおり失敗するので、**ユーザーに記事の用意を頼む**（U-1 でテストデータの投入は範囲外） |
| L0-3 | `astro.config.mjs`: sitemap から `/contact/thanks` と 404 を外す、Vite の `allowedHosts` は現状維持、`image` の取り込み設定は integrations の依頼を受けて足す |
| L0-4 | dev サーバーを `astro dev --background` で起動し、teammate に URL を伝える |
| L0-5 | Figma の 34 フレームの参照用スクリーンショットを scratchpad に撮っておく（最後の見比べに使う） |

### Wave 1 — 並行（基盤と配線。builder はデータの写しから）

| # | 担当 | 内容 | 依存 |
|---|---|---|---|
| F1 | foundation | **トークンとテーマ**: `~/ComeGin/comegin/assets/tokens/tokens.css` を `src/styles/tokens.css` に写して `global.css` で取り込み（H-1）。shadcn の変数（`--primary`=`role/surface-brand` #0471C0、`--ring`=blue.500、`--border`=`role/border`、`--radius`=8px など）を `02-component-map.md` §9.1 の対応表で当てる。書体（P-5）とタイプスケール（H-3、Desktop/Mobile）、和文の行送り 1.75。フォーカスリング（H-8）。ファビコン・OGP 画像を `public/` に。**`index.ts` の型を先に置いてから中身を作る** | L0-1 |
| F2 | foundation | shadcn の部品の導入（badge・separator・sheet・input・textarea・select・radio-group・checkbox・label・alert・breadcrumb・spinner など、`02-component-map.md` §7 の kit の対応から必要なもの） | F1 |
| F3 | foundation | `brand`・`layout`（ヘッダー 56px・シンボル 35.79×32、Mobile は Sheet、ナビの `aria-current`、フッター 4 列／Mobile 縦積み） | F2 |
| F4 | foundation | `marketing-ui` の部品（§7 の 28 部品のうちフォーム・同意・予約・チャット以外）。既定値に完成した文を入れない（H-16） | F2 |
| I1 | integrations | `site-content/{seo,cta}.ts`（§7・§6.3 を写す。`cta_id` の重複が無いことを型か一覧で保証）、`.env.example`（`PUBLIC_GA4_MEASUREMENT_ID`・`PUBLIC_POSTHOG_*`・`PUBLIC_CHATWOOT_BASE`・`PUBLIC_CHATWOOT_WEBSITE_TOKEN`・`PUBLIC_MAUTIC_BASE`・`MAUTIC_FORM_ID_CONSULT`・`MAUTIC_FORM_ID_SOURCE_DL`・`PUBLIC_CALCOM_*`・`PUBLIC_CONSENT_BASE`・`CONSENT_POLICY_VERSION`・`STRAPI_URL` ほか。名前は DD-02 1.1 と DD-05 に合わせる） | L0-1 |
| I2 | integrations | `consent`・`analytics`・`chat`（§8、DD-02 の 2〜4・8 節、consent-api の README の API） | I1、F2 |
| I3 | integrations | `forms`（§5.1・5.2、DD-02 5 節。Mautic のフォーム送信の受け口とリクエストの形は Mautic のドキュメントで確かめる） | I1、F2 |
| I4 | integrations | `booking`（§4.6 の 6'-1・6'-2、DD-02 7 節） | I1、F2 |
| I5 | integrations | `blog`（DD-05 の 1 節、ADR-11、Strapi の `article` のスキーマ）。ビルドの失敗条件はリードに `astro.config.mjs` への登録を頼む | I1、L0-2 |
| S0 | builder-sales | `site-content/{pricing,services,top}.ts` に仕様書の文言を写す（§2、§4.1〜4.4、§4.3+） | L0-1 |
| T0 | builder-site | `site-content/{about,contact}.ts` と `modules/legal` の本文（§4.5・4.6・4.10） | L0-1 |
| L1-1 | lead | integrations から届いた `.env.example` を見て、**ユーザーに開発用の `.env` の値を入れてもらう**（Mautic 8000・consent-api 3104・Chatwoot 3100・開発の Strapi。GA4 は開発では入れない） | I1 |

### Wave 2 — 画面（各画面 Desktop を作ってから Mobile）

| # | 担当 | 内容 | 依存 |
|---|---|---|---|
| S1 | builder-sales | **トップを最初に**（1-1〜1-13 の 14 セクション、Cookie バナー表示中・Mobile メニュー表示中の状態も実際に動く形で）。終わったら qa-reviewer に渡す | F3、F4、S0、I2、I3 |
| — | **ゲート G-1（ユーザー）** | トップの Desktop/Mobile を Figma と並べてユーザーに見せ、見た目と P-1〜P-8 の承認を取る。**承認までほかの画面に進まない**（型の誤りが 10 画面に広がるのを防ぐ） | S1、Q1 |
| S2 | builder-sales | サービス一覧、サービス詳細 4 件（Figma は受託開発だけ。残り 3 件は §4.3+ の文言で同じ型）、料金 | G-1 |
| T1 | builder-site | 会社概要、無料相談（フォーム＋業務棚卸しのカード 4 枚を 1 部品で）、完了（予約・読み込み失敗）、404、法務 2 件 | G-1、I3、I4 |
| T2 | builder-site | ブログ一覧（ヘッダーは Outline、主 CTA は無料 DL、カテゴリ・ページ送り）、記事（検索意図での CTA の切り替え §4.8） | G-1、I5 |

### Wave 3 — 検査と修正

| # | 担当 | 内容 | 依存 |
|---|---|---|---|
| Q1 | qa-reviewer | トップだけ先に: Playwright で 1440 / 390 を撮り Figma と見比べ、下の「検証」の 2〜6 を当てる | S1 |
| Q2 | qa-reviewer | 全画面に同じ検査。状態（入力エラー・送信中・送信失敗〈エラー応答・10 秒無応答〉・二重送信・完了・予約の読み込み失敗・DL ブロックの 5 状態・Cookie バナー・Mobile メニュー）は Playwright のリクエスト差し替えで再現して撮る | S2、T1、T2 |
| Q3 | qa-reviewer | `pnpm build`（`SITE_URL` を設定）と `pnpm lh`。指摘は所有者へ SendMessage | Q2 |
| L3-1 | lead | `lighthouserc.cjs` の計測 URL をトップ＋ブログ一覧＋記事 1 本に増やす（DD-05 2.6 の案 B） | T2 |
| X | 各担当 | 指摘の修正 → qa-reviewer が再検査 | Q1〜Q3 |

### Wave 4 — 仕上げ（リード）

| # | 内容 |
|---|---|
| L4-1 | `03-handoff.md` に実装の状況と申し送り（下の表）を足す。既存の記述は消さず追記 |
| L4-2 | `verdant-virgo/README.md` にモジュール構成と環境変数の表を足す |
| L4-3 | 全画面の実装のスクリーンショットを Figma と並べ、Lighthouse の結果と合わせてユーザーに報告する |

## `03-handoff.md` に申し送るもの（この計画では実施しない）

| 対象 | 内容 |
|---|---|
| Mautic | フォーム 2 つ（alias `consult`・`source_dl`）と数値 ID、カスタムフィールド（同意 3 つ・`employee_range`・`has_it_department`）、**公開サイトのオリジンからの CORS の許可**（無いとブラウザからの送信が通らない） |
| Cal.com | 無料相談のイベントの説明文・所要時間（C14）、無料プランで足りるか、データの置き場 |
| Chatwoot | 初回メッセージ（§8.3）、Web サイトの受信箱の `website_token` |
| GA4 | 本番のプロパティの測定 ID |
| 配信 | サイト全体の CSP（GA4・PostHog・Chatwoot・Cal.com・consent の許可）、`consent.comegin.com` の発行と consent-api のデプロイ |
| 公開前 | `【要記入】`・『要確認』の値（公開リポジトリの URL など）、法務 2 ページの専門家の確認 |

## 検証

1. **ビルド**: `SITE_URL` を設定して `pnpm build` が通る（記事 0 件・画像の失敗・`dist/` に Strapi の URL が残る場合は失敗することも 1 回ずつ確かめる）
2. **見た目**: 全 34 フレームを Playwright（1440 / 390）で撮り、Figma の `get_screenshot` と並べて差を一覧にする。許容事項（`03-handoff.md` §8）は差として数えない
3. **文言**: 各画面の見出し・CTA・料金 5 行・フォームの文言が `01-content-spec.md` と一字一句一致（料金は §2）。h1 は 1 画面 1 つ。旧文言（「福祉の言葉と、技術の言葉を。」「非公開リポジトリ」など）が 0 件
4. **CTA と計測**: 1 画面に主 CTA 1 種類、`cta_id` が §6.3 と一致し 2 画面で重複しない、`/contact` へのリンクに `?cta=`・`?from=` が付く。同意の前は GA4・PostHog・Chatwoot のリクエストが 0 件、同意後に読み込まれ `cta_viewed`/`cta_clicked` が出る（Playwright のネットワーク一覧で確認）。撤回後に止まる。consent-api に `POST /v1/consent` が飛ぶ
5. **フォーム**: §5.1 の検証の文言・フォーカス移動・送信中の無効化・10 秒の打ち切り・失敗時に入力が残る・二重送信の表示・email の小文字化・hidden 項目（ペイロードを Playwright で捕まえて DD-02 5.3 と突き合わせる）。開発の Mautic で CORS とフォームが用意されていれば実送信も確かめる（無ければ申し送り）
6. **規則**: 文字に blue.500 が無い、リンクに下線、フォーカスリングが見える、コントラスト AA、ブログ一覧・記事のヘッダーが Outline、noindex（完了・404）、sitemap に完了・404 が無い、`<html lang="ja">`
7. **Lighthouse**: トップ・ブログ一覧・記事 1 本で performance / accessibility / best-practices 0.9 以上、**SEO 1.0**
8. **最終確認**（リード → ユーザー）: Figma と実装のスクリーンショットの対照と、Lighthouse の結果

## リードへの起動プロンプト（Wave 0 の後にそのまま使える）

```
Agent team を作成して。チーム名 website-impl-1009。
計画書 docs/superpowers/plans/2026-10-09-website-implementation.md の「モジュール構成」「チーム構成」「Wave とタスク」に従い、
teammate 5 人（foundation, integrations, builder-sales, builder-site, qa-reviewer）を spawn する。
各 teammate の起動時の指示には、
MarketingDepartment/WebsiteOperations/docs/BasicDesign/DesignSpec/website/03-handoff.md と
01-content-spec.md の §0・§1 を最初に読むこと、担当タスク ID、書き込んでよい範囲、
計画書の「守る規則」「モジュール間の契約」、dev サーバーの URL を書く。
qa-reviewer 以外は plan approval を必須にし、承認の条件は
「書き込んでよい範囲だけに書く」「文言は 01-content-spec から写す（Figma の文字を貼らない）」
「色は役割トークン・部品は shadcn と marketing-ui を使う」「他モジュールは index.ts 経由で使う」の 4 点とする。
共有タスクリストに F1〜F4・I1〜I5・S0〜S2・T0〜T2・Q1〜Q3・L1-1・L3-1 とゲート G-1 を依存関係つきで登録すること。
G-1 と L0-2（記事が 0 件のとき）・L1-1（.env の値）はリードが判断・代行せず、必ず私（ユーザー）に確認すること。
```
