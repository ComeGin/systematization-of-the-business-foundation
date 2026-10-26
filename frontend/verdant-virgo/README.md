# verdant-virgo（ComeGin 公式サイト）

ComeGin の公開サイト。Astro 7 の静的出力（SSG）で、CloudFront から配信する前提。
画面は Figma `JRYPLER6E0liA7cUurIhSo` の 10 画面（＋状態）を実装している。文言の正本は Figma ではなく
`docs/BasicDesign/DesignSpec/website/01-content-spec.md`、
実装への申し送りは同じディレクトリの `03-handoff.md`。実装の計画は `docs/superpowers/plans/2026-10-09-website-implementation.md`。

## コマンド

| コマンド           | 内容                                                                                                                                                                                                                    |
| :----------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`     | 依存を入れる                                                                                                                                                                                                            |
| `pnpm dev`         | dev サーバー（`localhost:4321`）。エージェントは `astro dev --background` で起動する（`AGENTS.md`）                                                                                                                     |
| `pnpm build`       | `./dist/` に静的出力。`SITE_URL` が未設定なら止まる。Strapi に届かない・記事が 0 件・`dist` に Strapi／S3 の URL が残る場合も止まる                                                                                     |
| `pnpm preview`     | ビルド結果を配信して確かめる                                                                                                                                                                                            |
| `pnpm astro check` | 型の検査                                                                                                                                                                                                                |
| `pnpm lh`          | ビルドして Lighthouse CI（トップ・`/blog/`・`/contact/`・記事 1 本を 5 回ずつ。accessibility／best-practices 0.9、SEO 1.0。performance 0.9 は warn〈ADR-29〉）                                                          |
| `pnpm lh:report`   | 直近の Lighthouse のレポートを開く                                                                                                                                                                                      |
| `pnpm a11y`        | ビルド済みの `dist` を preview（`localhost:4323`）で配信し、Playwright ＋ axe で全ルートを Desktop・Mobile で検査する（WCAG 2.0〜2.2 の A・AA のタグ）。結果は `./.a11y/`（`summary.json`・`results.json`。追跡しない） |
| `pnpm a11y:ci`     | ビルドしてから `pnpm a11y`。control-plane の builtin `a11y` ジョブが使う（Lighthouse とは別に走らせるため）                                                                                                             |
| `pnpm e2e`         | E2E（Playwright。`playwright.e2e.config.ts`）。E2E 専用の dev サーバー（`127.0.0.1:4324`）を起動し、開発スタックを本物として通す（下の「E2E」）。ビルドはしない                                                         |
| `pnpm e2e:report`  | 直近の E2E の HTML レポートを開く（`./playwright-report/e2e/`。追跡しない）                                                                                                                                             |

## ディレクトリ

```text
src/
├── pages/                 ルーティングと組み立てだけ（文言・部品は modules から読む）
│   ├── index.astro        トップ
│   ├── services/          一覧と詳細 4 件（[slug].astro）
│   ├── pricing.astro・about.astro・404.astro
│   ├── contact/           無料相談・完了（thanks）
│   ├── blog/              一覧・ページ送り・カテゴリ別・記事（[slug].astro）
│   ├── legal/             プライバシーポリシー・特定商取引法に基づく表記
│   └── accessibility.astro・sitemap.astro  ウェブアクセシビリティ方針（対応度と試験結果）・HTML のサイトマップ
├── modules/               機能ごとのモジュール。他モジュールは index.ts（ブラウザ側は client.ts）経由で使う
│   ├── brand/             ロゴ、和文フォントのサブセット化（integration.ts）
│   ├── layout/            BaseLayout・ヘッダー・Mobile メニュー・フッター・パンくず・告知帯・ページ導入
│   ├── marketing-ui/      CTAButton・カード類・Steps・FAQ・CTA バナー・改行指定の見出しなど
│   ├── site-content/      文言のデータ（料金・サービス・トップ・会社概要・無料相談・ブログ・404・ナビ・SEO・cta_id）
│   ├── consent/           Cookie 同意バナー（静的 HTML＋インラインの表示判定）と consent-api への記録
│   ├── analytics/         GA4（Consent Mode v2 basic）・PostHog・cta_viewed / cta_clicked・form_*
│   ├── chat/              Chatwoot（同意の後だけ読み込む）
│   ├── forms/             無料相談・無料 DL のフォーム、Mautic への送信、入力の検証
│   ├── booking/           完了画面の Cal.com の埋め込み
│   ├── blog/              Strapi の記事の取得（ビルド時だけ）・本文の描画・ビルドの失敗条件（integration.ts）
│   ├── legal/             法務 2 ページの本文と表・目次の部品
│   ├── a11y/              新しいタブの告知・VisuallyHidden・MotionPause・reduced-motion の判定・contrastRatio
│   └── motion/            React Bits のモーフィング（vendor/react-bits に原本）と、ページが使うラッパー
├── components/ui/         shadcn/ui（base-nova）
├── styles/                tokens.css（ブランドのトークンの写し）・theme.css（役割トークン・モーションのトークン）・fonts.css・global.css・typeset.css
└── lib/
e2e/a11y/                  axe の全ルート検査と、状態・キーボード・表示・フォーム・構造・モーションの検査（playwright.config.ts）
e2e/flows/                 E2E。訪問者の流れを開発スタックの本物に通す（playwright.e2e.config.ts。下の「E2E」）
tests/modules/a11y/        a11y モジュールとトークンの組み合わせのコントラストの単体テスト
```

アクセシビリティ（JIS X 8341-3:2016 の AA に一部準拠）の仕様は `docs/BasicDesign/DesignSpec/website/04-accessibility-spec.md`、
モーションの仕様は `05-motion-spec.md`、決定は ADR-27・ADR-28。改修の計画は `docs/superpowers/plans/2026-10-18-jis-x-8341-3-accessibility.md`。

## E2E（`pnpm e2e`）

a11y の検査（`pnpm a11y`。ビルド済みの `dist` を、送信を差し替えて見る）とは別に、**訪問者の流れを開発スタックの本物に通す**。テストは `e2e/flows/`。

| spec         | 流れ                                                                                                                                                                                    |
| :----------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `navigation` | ヘッダーのナビ・無料相談のボタンの `from`・404                                                                                                                                          |
| `blog`       | Strapi の記事（本物）が一覧・カテゴリ・記事に出る。検索意図で CTA が変わる。下書きは出ない                                                                                              |
| `consult`    | CTA から申し込み、Mautic（本物）にコンタクトと送信結果（`page_url`・`cta_id`・`service_interest`・`distinct_id`）が残り、MailHog に受付確認が届く。入力の誤り・二重送信・改ざんした URL |
| `consent`    | 同意・拒否・撤回が Cookie・consent-api の記録（Valkey）・PostHog とチャットの読み込みに効く。古い版・壊れた Cookie・偽の識別子                                                          |
| `chat`       | ウィジェットを開き、FAQ ボット（本物）が原文で答えてラベルを付ける。解決・引き継ぎ                                                                                                      |
| `booking`    | 完了画面の予約枠（Cal.com の偽物）。同意の後だけ `booking_*` を送る。読み込みの失敗・15 秒の無通知で代わりの案内                                                                        |
| `cors`       | 開発スタックの CORS の許可（ブラウザを使わない）                                                                                                                                        |
| `faults/`    | consent-api の Valkey・Mautic の MySQL を `docker pause` で止めても行き止まりにならない                                                                                                 |

- **境界（2026-10-25 にユーザーが決めた）**: オンプレの開発スタック（Strapi・Mautic・Chatwoot・consent-api・faq-bot・MailHog）は本物に繋ぐ。オンプレの外（Cal.com・PostHog・GA4・ngrok）は差し替え、それ以外の外への通信は止める（`e2e/flows/support/fixtures.ts`）。開発の環境変数ファイルの `PUBLIC_*_BASE` は ngrok の URL なので、E2E の dev サーバーは `127.0.0.1` に向け直して起動する（`playwright.e2e.config.ts` の `webServer.env`）。
- **CORS**: E2E のページのオリジン（`127.0.0.1:4324`）は開発スタックの許可に入っていないので、fixture が Mautic・consent-api への送信を本物に転送するときに `Origin` を `SITE_URL` に置き換える（送信の中身は本物が処理する）。許可の設定そのものは `cors.spec.ts` が確かめる。
- **テスト用データ**: `global-setup.ts` が開発の Strapi に記事 3 本（顕在・潜在の公開記事と、公開しない下書き。名前は `e2e-<実行の ID>-`）を作り、終わったら消す。申し込み（Mautic のコンタクト・MailHog の受付確認）・同意の記録（Valkey）・チャットの会話（Chatwoot）はテストごとに作り、fixture の `cleanup` で消す（失敗しても必ず実行し、消せなければテストを失敗にする）。**Mautic のフォームの送信結果は API で消せないので残る**（メールの接頭辞 `e2e-` で見分ける）。Chatwoot のウィジェットの訪問者は最後の接続から 90 秒は消せない（`CONTACT_PRESENCE_DURATION`）ので、全テストの後にまとめて消す（`test-results/e2e-pending/`）。
- **障害**: プロジェクト `faults` は、ほかのテストを巻き込まないよう `flows` がすべて通った後にだけ流れる（`flows` に失敗があると「did not run」になる）。Valkey を止めている間の同意は 503 になり、Valkey が戻った後にも記録が残らないことを確かめる（consent-api は書き込みに期限を付けている。2026-10-26。開発のコンテナが古いイメージのままだと落ちるので、`backend/consent-api` で `docker compose up -d --build` をしてから流す）。
- **PostHog**: posthog-js は自動のブラウザ（`HeadlessChrome`・`webdriver`）をボットとして扱い、イベントを捨てる。イベントの中身を見るテストだけ fixture の `looksHuman` でブラウザを普通の Chrome に見せる。
- **前提**: `node setup/setup.mjs --target dev` と `node setup/frontend.mjs --target dev` が済み、Strapi と faq-bot の `pnpm dev` が動いていること。機械の負荷が高いと操作の待ちが延びて落ちる（`pnpm lh` などと同時に走らせない）。

## 環境変数

値の説明は `.env.example` にある。秘密値を含む `.env` は追跡しない。
**開発の `.env` は `node setup/frontend.mjs --target dev` が書く**（リポジトリのルートで。バックエンドの setup が作ったトークン・ID を写し、依存・計測の道具・dev サーバーまで用意する）。本番のビルド用の `.env.production` は `--target prod` が書く（`setup/README.md` の「フロントエンド全体」）。

| 変数                                                                              | 用途                                           | 開発                                                | 本番                                                  |
| :-------------------------------------------------------------------------------- | :--------------------------------------------- | :-------------------------------------------------- | :---------------------------------------------------- |
| `SITE_URL`                                                                        | canonical・sitemap・OGP の基点                 | ngrok の URL など                                   | `https://comegin.com`（apex か www かは未確定）       |
| `BUILD_TARGET`                                                                    | `production` のとき localhost の Strapi を拒否 | `development`                                       | `production`                                          |
| `STRAPI_URL` / `STRAPI_API_TOKEN`                                                 | 記事の取得（ビルド時だけ）                     | `http://localhost:1337`／開発のトークン             | `https://cms.comegin.com`／本番の読み取り専用トークン |
| `UPLOAD_S3_BUCKET` / `UPLOAD_S3_REGION`                                           | `dist` に S3 の URL が残っていないかの検査     | 空                                                  | 本番のバケット                                        |
| `PUBLIC_GA4_MEASUREMENT_ID`                                                       | GA4                                            | 空（タグを出さない）                                | 本番のプロパティ                                      |
| `PUBLIC_POSTHOG_PROJECT_TOKEN` / `PUBLIC_POSTHOG_HOST`                            | PostHog                                        | 開発のプロジェクト                                  | 本番のプロジェクト                                    |
| `PUBLIC_CHATWOOT_BASE` / `PUBLIC_CHATWOOT_WEBSITE_TOKEN`                          | Chatwoot                                       | `http://localhost:3100`／開発の受信箱               | `https://chat.comegin.com`／本番の受信箱              |
| `PUBLIC_MAUTIC_BASE` / `MAUTIC_FORM_ID_CONSULT`                                   | フォームの送信先                               | `http://localhost:8000`／空でも可（送信は失敗表示） | `https://mkt.comegin.com`／採番した ID                |
| `PUBLIC_CALCOM_BASE` / `PUBLIC_CALCOM_LINK`                                       | 完了画面の予約枠                               | `https://app.cal.com`／テストのイベント             | 無料相談のイベント                                    |
| `PUBLIC_CONSENT_BASE` / `PUBLIC_CONSENT_COOKIE_DOMAIN` / `CONSENT_POLICY_VERSION` | 同意の記録と Cookie                            | `http://localhost:3104`／空／consent-api と同じ版   | `https://consent.comegin.com`／`.comegin.com`／同じ版 |

**本番のビルドは本番の値で行う。** 開発の `.env` のままビルドすると、canonical・sitemap・各受け口が開発の宛先で焼き込まれる。

## dev サーバーの注意

- island（`.tsx`）で新しい依存を import したら、`astro.config.mjs` の `vite.optimizeDeps.include` にも足す。足さないと、途中で依存の事前最適化がやり直され、island が 504（Outdated Optimize Dep）で水和しなくなる。
- 依存の追加や `astro check` のあとに 504 や古い CSS が出たら、`astro dev stop` → `node_modules/.vite` を消す → `astro dev --background` で直る。
- `pnpm build` の後に dev の island が水和しなくなる（`_jsxDEV is not a function`）ことがある。ビルドで依存の事前最適化が production 版になるため。上と同じ手順（stop → `node_modules/.vite` を消す → 起動）で直る。
- Astro 7.3 の preview は AI エージェントの環境を検出すると自動で背景に回り、ロック（`.astro/preview.json`）で 1 プロジェクト 1 つに制限する。`lighthouserc.cjs`（4322）と `playwright.config.ts`（4323）は `ASTRO_PREVIEW_BACKGROUND=1` と `--ignore-lock` で前景に起動し、同時に動けるようにしている。
- 和文フォントは dev では `@fontsource` の分割フォントのまま。ビルドのときだけ、使っている字のサブセット（400・500・700 を各 1 ファイル）に差し替わる。
- **スマホの実機で試すとき**は、サイトを ngrok（`https://comegin-astro-dev.ngrok.app`）で開くだけでなく、ブラウザから届く受け口も https の ngrok にする。`PUBLIC_CHATWOOT_BASE`・`PUBLIC_CONSENT_BASE` が `localhost` のままだと、スマホからは届かず（https のページから http も読めない）、チャットが開かない。Chatwoot は `FRONTEND_URL` を、consent-api は `SITE_URL` をそれぞれ ngrok の URL に合わせる。`ngrok.yml` を変えたら ngrok を起動し直す（起動し直すまで `ERR_NGROK_3200` になる）。
