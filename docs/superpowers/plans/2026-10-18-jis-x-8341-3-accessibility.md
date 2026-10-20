# 公開サイトの JIS X 8341-3:2016 AA 準拠 — `frontend/verdant-virgo` の改修と自己改善ループへの監査の組み込み（Agent teams 実行用）

## Context

創業計画書（`~/ComeGin/comegin/documents/創業計画書.md`）は「体験の約束 3」で、**納品する画面は JIS X 8341-3:2016 の AA を標準の仕様とする**と約束している。別紙 1 第 8 章では、納品前に AA 適合を確かめて記録を渡すことも約束している。公開サイトのトップ（`site-content/top.ts:241`、仕様 `01-content-spec.md:488-490`）も同じ約束を載せている。したがって、自社サイトが同じ水準を満たしていることが信用の前提になる（`03-handoff.md:59`）。

**現状**（2026-10-18 の調査結果）

- Lighthouse の accessibility は 3 ページとも 1.0。ただし機械検査で見つけられるのは一部だけである。
- 次の点が未対応である。
  - 見出しの階層の飛び（`/contact`・`/services`・`/pricing`）
  - 新しいタブで開くことの告知（7 か所）
  - 本文リンクのコントラスト: 薄い地の上で 4.22:1
  - 入力欄の枠: 1.29:1（WCAG 2.1 の 1.4.11）
  - CTA バナーの上のフォーカスリング: 2.91:1
  - `prefers-reduced-motion` への対応（どこにもない）
  - 文字の切り詰め
  - `autocomplete`
  - Cal.com の iframe の `title`
  - 複数の到達手段（2.4.5。HTML のサイトマップが無い）
- a11y のテスト基盤（Playwright・axe）は無い。
- 設計書にはアクセシビリティの非機能要件も ADR も無い。
- React Bits のコンポーネントは今は 0 個（`SplitText` は削除済み。`@react-bits` のレジストリと gsap は残っている）。今後足すときの規則が要る。

この計画は、公開サイトを **AA 準拠**（WAIC の対応度表記ガイドラインの表記）にし、方針と試験結果を公開する。さらに、改修した水準が後の変更（人の変更とエージェントの変更）で落ちないように、オンプレの再帰的自己改善ループに a11y の監査を組み込む。

あわせて、**React Bits のモーフィング 4 種**を入れる。目的は、訪問者がワクワクする体験をインタラクションデザイナーの視点で設計することである。**「動きは誰も締め出さない」ことをこのサイトの実演にする。** 具体的には、すべての動きに次の 4 つを持たせる。
- 意味がある
- 止められる
- reduced-motion で静止する
- WebGL が無くても内容が欠けない

この両立自体が、ComeGin の「AA を標準にする」約束の説得力になる。

### ユーザーの決定（2026-10-18）

| # | 論点 | 決定 |
|---|---|---|
| U-1 | 表記 | **AA 準拠を表明する。** 「ウェブアクセシビリティ方針」と試験結果（達成基準チェックリスト）を公開する |
| U-2 | 検証 | **テストコードの作成と実行、`pnpm build`・`pnpm lh`、Playwright MCP での確認を許可する** |
| U-3 | ループ | **含める。** ADR・要件・指標・builtin ジョブ・quality-checker・proposal-writer の止め線まで、設計と実装を行う |
| U-4 | 基準 | **表明は JIS X 8341-3:2016（= WCAG 2.0 の A/AA、38 基準）で行う。改修は WCAG 2.1/2.2 の AA で増えた基準も満たす**（1.3.4・1.3.5・1.4.10・1.4.11・1.4.12・1.4.13・2.1.4・2.4.11・2.5.1〜2.5.4・2.5.7・2.5.8・3.2.6・3.3.7・3.3.8・4.1.3） |
| U-5 | モーフィング | **React Bits の 4 種をすべて入れる**（ShapeBlur／MetaBalls、StatusMark、MorphSlider、GooeyNav）。目標は「訪れてワクワクする UX」。**インタラクションデザイナーの視点を取り入れる** |

### 計画の側で決めたこと（リードの既定。ゲート G-1 で覆せる）

| # | 決定 | 理由 |
|---|---|---|
| P-1 | 試験の対象は**全ページ**とする（ページの抽出はしない）。ブログ記事はテンプレート単位で、公開済みの全記事を axe で回す | ページ数が少ない（約 15 ルート）。WAIC の表記ガイドラインで「準拠」を名乗るには、対象のすべてのページで試験する必要がある |
| P-2 | 新しいページを 2 つ作る。`/accessibility/`（方針と試験結果）と `/sitemap/`（HTML のサイトマップ。2.4.5 の 2 つ目の手段）。どちらもフッターからリンクする | 方針と結果の公開（U-1）と、2.4.5 を満たすため |
| P-3 | **ブランドの色は変えない。** 不足は次の 3 つで補い、`theme.css` の役割トークンとして足す。ブランドガイドラインの改訂は申し送りにする（正本は別リポジトリ）<br>・薄い地の上のリンク: `blue.600` #0471C0（4.74:1 以上）<br>・入力欄の枠: `neutral.500` #6F7F92（3:1 以上）<br>・暗い地の上のフォーカスリング: 白 | `tokens.css` は生成物で、直接直さない（`theme.css:3-5`） |
| P-4 | 新しいモジュール `src/modules/a11y/` を作る。公開する部品と関数は次のとおり（`index.ts` と `client.ts`）<br>・`NewTabNotice`: sr-only の「（新しいタブで開きます）」。文言は site-content から渡す<br>・`VisuallyHidden`<br>・`prefersReducedMotion()` と React 用の `useReducedMotion()`<br>・`MotionPause`: 5 秒を超えて動くものの一時停止ボタン<br>・`contrastRatio()` | 横断の処理を各モジュールにばらまかない。React Bits を足すときに、この口を必ず通させる |
| P-5 | `prefers-reduced-motion: reduce` のときは、`global.css` で transition と animation を 0.01ms にする。Spinner は回転をやめ、文字で「読み込み中」と示す | 2.3.3（AAA）は対象外だが、2.2.2 と前庭障害への配慮を最小の JS で行える |
| P-6 | **React Bits の規則**（`AGENTS.md` と `design-implementer.md` に書く）<br>・`useReducedMotion()` のときは静止させる<br>・5 秒を超えて自動で動くものには `MotionPause` を付ける<br>・1 秒に 3 回を超える点滅をしない<br>・装飾の canvas には `aria-hidden` を付ける<br>・`SplitText` のように文字を分割する部品は、元の文を `aria-label` か sr-only で 1 回だけ読ませる<br>・`gsap` は MorphSlider が使うので残す | ユーザーは「Astro, React Bits」で構築している。今後の追加で 2.2.2・2.3.1・1.3.1 を壊さない |
| P-7 | 第三者の埋め込み（Chatwoot のウィジェット、Cal.com）は試験の対象に含める。満たせない基準がこちらで直せない場合は、G-2 でユーザーが選ぶ。選択肢は次の 2 つ<br>・(a) JIS の部分適合の記述（第三者のコンテンツ）を付けて表明する<br>・(b) 代わりの手段（問い合わせフォーム）を示し、埋め込みを外す | 準拠の表明に関わる判断で、リードだけでは決められない |
| P-8 | 自動テストは `frontend/verdant-virgo/e2e/`（`@playwright/test` と `@axe-core/playwright`）に置く。preview は**ポート 4323**（4321・4322 と衝突させない）。結果の JSON は `.a11y/` に出し、Git では管理しない | builtin ジョブが lighthouse と同じ形で結果を写せるようにする。CLAUDE.md のポート表を崩さない |
| P-10 | モーションの部品は新しいモジュール `src/modules/motion/` にまとめる。React Bits の原本は shadcn CLI（`@react-bits/<Name>-TS-TW`）で取り込み、`src/modules/motion/vendor/react-bits/<Name>/` に置く。冒頭に出典の URL と取り込み日を書く。a11y と性能のための変更には `// a11y:`／`// perf:` の印を付ける。ページとレイアウトは、`motion/index.ts` が公開するラッパー（下の「インタラクションデザイン」）だけを使う | 取り込んだ原本と、こちらの変更の境界を後から追えるようにする |
| P-9 | AWS には新しいリソースを足さない。保存先は次のとおり<br>・試験の生データ: `.a11y/`（Git 管理外）<br>・観測: `E-12`（`docs/audits/quality/`）<br>・実行ログ: 既存の runlog（S3）<br>・公開する試験結果: 静的サイト（S3／CloudFront）のページ | 自己改善ループはオンプレ、成果物はクラウドという分担を変えない |

## インタラクションデザイン（React Bits のモーフィング）

### 体験の筋書き（訪問者の旅に沿って、動きに 1 つずつ役割を持たせる）

| 場面 | 部品と置き場所 | 動きの意味（なぜここで動くか） | 振る舞い |
|---|---|---|---|
| **出会う**（トップ 1-3 のヒーロー） | **ShapeBlur**：ロゴのシンボル（`brand` の SVG を `src` に渡す） | ポインターを近づけるとピントが合い、離れるとぼける。「近づくほど、はっきり見えてくる会社」という最初の手触り | ポインターに反応するだけで、勝手には動かない（`idle` と `spin` は 0）。Mobile と、ポインターの無い端末では静止した SVG にする。h1 と写真（LCP）はアニメーションで隠さない |
| **迷わず進む**（全ページのヘッダー、Desktop） | **GooeyNav**：メインのナビ | 現在地を示す形が、液体のように指した先へ流れる。「今どこにいて、次にどこへ行けるか」を形の連続で見せる | 本物の `<a>` と `aria-current` を出す（原本のまま）。hover に加えて **キーボードのフォーカスでも同じように流す**（操作の手段で体験を分けない）。ページ間は CSS のページ遷移（`@view-transition { navigation: auto }` と `view-transition-name`）で、現在地の形を次のページへつなぐ。対応していないブラウザでは通常の遷移になる。Mobile は既存の `<dialog>` のメニューのままにする（React を読まない） |
| **知る**（トップの「業務提携の対象」3 分野：障がい福祉・教育・介護） | **MorphSlider**：`PHOTOS` の `welfareWorkSupport`・`educationChildren`・`careRecreation` | 3 つの現場が溶け合うように移り変わる。「分野は違っても、同じ仕組みでつながる」という主張を絵で見せる | **自動再生はしない。** 訪問者が前へ・次へ・各スライドを選んだときだけ動く。ラベルは日本語にし、文言は site-content から渡す。`role="tab"` を、`aria-current` を持つボタンに直す。写真は `<img alt>` としても DOM に残し、WebGL が無ければそのまま見せる |
| **一緒に考える**（締めの CTA バナー、navy の地） | **MetaBalls**：バナーの右側の装飾（文字の後ろには置かない） | 粒が寄り合って 1 つになる。「福祉の言葉と技術の言葉が合わさる」余韻で、行動の直前の期待を上げる | ゆっくり自動で動くので、**`MotionPause` の一時停止ボタンを付ける**（2.2.2）。画面外とタブが非表示のときは止める。`clickBurst` は使わない（2.3.1 の閃光を避ける）。reduced-motion のときは静止画にする（原本に無いので `// a11y:` で足す） |
| **託す**（無料相談・資料請求の送信） | **StatusMark**：送信ボタンの横の状態表示 | 待機の輪 → 進捗の弧 → チェックへと形が変わり、「ちゃんと届いた」を目と耳の両方で伝える | 状態は `role="status"` の文字でも出す（4.1.3）。形は補助で、意味は文字が持つ。失敗のときはチェックにせず、既存の `Alert` に任せる。`useReducedMotion` は原本に組み込み済み |

### 動きの規則（`05-motion-spec.md` の正本になる。全員が守る）

1. **1 つの画面で、目を引く動きは 1 つまで。** ヒーローの ShapeBlur と CTA の MetaBalls が同時に視界に入らない配置にする。ブランドの配色比率（青は面積の 10% まで）と「余白と数字」を壊さない。
2. **意味は動きに持たせない。** 動きが見えない人・止めた人にも、同じ情報が文字・形・状態で届くこと（1.1.1・1.3.3・4.1.3）。
3. **止められる。** 5 秒を超えて自動で動くものには `MotionPause` を付ける（2.2.2）。押した結果は `sessionStorage` に覚え、ページを移っても止まったままにする（try/catch で囲む）。
4. **reduced-motion では動きを止める。** フェードなどの短い切り替えは残してよい。点滅は 1 秒に 3 回まで（2.3.1）。
5. **段階的に強化する。** 静的な HTML（SVG・`<img>`・`<a>`）で内容が完結し、その上に WebGL と React を載せる。WebGL が無い・JS が失敗したときは、静的な形のままで欠けない。
6. **性能の予算。**
   - WebGL の島は `client:visible`（ヒーローは `client:idle`）で読む。
   - 画面外とタブが非表示のときは `requestAnimationFrame` を止める。
   - 表示の大きさは CSS で先に確保する（CLS 0）。
   - Mobile では ShapeBlur と GooeyNav を読まない（`client:media`）。
   - Lighthouse の performance は Mobile で 0.9 以上を守る。
7. **トークン。** 時間と緩急を `theme.css` の CSS 変数（`--motion-duration-{micro,small,medium,large}` は 120/200/320/600ms、`--motion-ease-{standard,emphasized}`）と `motion/lib/tokens.ts` にそろえる。部品ごとに数値を書かない。
8. **入力の手段で体験を分けない。** hover で起きることは focus-visible でも起きる。ポインターの動きだけに頼る操作は作らない（2.1.1・2.5.1）。

### `src/modules/motion/` の公開口（`index.ts`。型は Wave 1 で先に置く）

- `MotionSymbol`（ShapeBlur ＋ 静止 SVG の代わり）
- `MotionNav`（GooeyNav ＋ 静的な `<nav>`。`SiteHeader` から使う）
- `MorphGallery`（MorphSlider ＋ `<img>` の一覧）
- `MotionBlobs`（MetaBalls ＋ `MotionPause`）
- `SendStatus`（StatusMark ＋ `role="status"`）
- `lib/tokens.ts`
- `lib/run-when-visible.ts`（画面外とタブ非表示で止める共通処理）

reduced-motion の判定は `a11y` モジュールの `useReducedMotion()` を使う。

## モジュールと所有者

各モジュールは `index.ts`（公開する部品・関数・型）と、必要なら `client.ts`・`components/`・`lib/` を持つ（既存の規約。`README.md:31`）。**他のモジュールは `index.ts`／`client.ts` 経由でだけ使う。**

| 対象 | 主な改修 | 所有 |
|---|---|---|
| `src/modules/a11y/`（新規） | P-4 の部品と関数。型を最初に置く | foundation |
| `src/styles/{global,theme}.css`、`src/components/ui/**` | P-3 の役割トークン、P-5 の reduced-motion、暗い地のフォーカスリング、入力欄の枠、Spinner | foundation |
| `layout` | `<main id="main" tabindex="-1">`<br>Mobile メニューの `dialog`／`nav` の名前を「メイン」にそろえる<br>フッターの列見出しを `<p>` から `h2` にする<br>`/accessibility/`・`/sitemap/` へのリンク<br>告知帯・パンくずの `truncate` をやめて折り返す（1.4.4・1.4.10）<br>Cookie バナーが固定表示中は `scroll-padding-bottom` を確保する（2.4.11） | foundation |
| `marketing-ui`・`brand` | `CTAButton`・`BlogCard` の切り詰めと新しいタブの告知、「詳しく見る」の繰り返しを sr-only の対象名で補う、`CTABanner` の上の白いリング | foundation |
| `forms`・`source-dl` | **フォーム**<br>・フォームに名前を付ける（`aria-labelledby`）<br>・姓・名に見えるラベルを付ける（3.3.2）<br>・`aria-required`<br>・`autocomplete`（1.3.5。name・family-name・given-name・email・organization・tel）<br>**通知**<br>・送信失敗のとき、`role=alert` とフォーカス移動で二重に読み上げられるのを解消する<br>・文字数の読み上げは残り 20 字以下と超過のときだけにする<br>・状態の通知は `role=status`（4.1.3）<br>**その他**<br>・同意のリンクの新しいタブの告知<br>・DL の別タブの告知 | integrations |
| `consent` | 同意バナーの DOM の位置とフォーカス順の確認（2.4.3）、`aria-describedby`、撤回の手段が 2 回のキー操作以内で届くこと | integrations |
| `booking`・`chat` | Cal.com の iframe が差し込まれたら `title` を付ける（4.1.2）<br>読み込み失敗時の案内<br>Chatwoot は同意後の読み込みとランチャーのアクセシブルネームを確かめる（P-7） | integrations |
| `blog`・`legal` | 記事本文の見出しを前の見出しから 1 段ずつにそろえる（`blog/lib/body.ts`）<br>外部リンクの告知<br>表の `caption`／`th scope`<br>英語だけの段落に `lang="en"`（3.1.2） | integrations |
| `pages/**`・`site-content/**` | 見出しの飛びを直す（`/contact`・`/services`・`/pricing` は `level` プロパティで直す）<br>新しいページ `/accessibility/`・`/sitemap/`<br>`site-content/accessibility.ts`（方針の文と、試験結果の表のデータ）<br>sr-only の文言 | pages |
| `e2e/**`、`tests/modules/a11y/**`、`playwright.config.ts` | 自動の a11y 検査（下の「検証」）、ベースラインの計測、試験結果の下書き | verifier |
| `backend/control-plane/src/builtin/a11y.ts` ほか、`ops/schedules/*a11y*.yaml`、`.claude/agents/{quality-checker,proposal-writer,design-implementer}.md` | ループへの組み込み（Wave 3 の L 系） | loop-engineer |
| `src/modules/motion/**`（新規） | React Bits の 4 種の取り込みと a11y・性能の修正、ラッパー 5 つ、モーションのトークン | motion |
| 置き場所への組み込み | `SiteHeader` → `MotionNav`（foundation）、トップ → `MotionSymbol`・`MorphGallery`（pages）、`CTABanner` → `MotionBlobs`（foundation）、フォーム → `SendStatus`（integrations） | 各所有者 |
| `docs/**` | ADR-27・ADR-28、非機能要件、a11y の仕様書、モーションの仕様書、DA/AA/BA/TA/DD の更新、`01-content-spec.md` の文言 | spec-writer |

### モジュール間の契約（Wave 1 の最初に foundation が `a11y/index.ts` の型だけ先に置く）

- `NewTabNotice`: props は `{ text: string }`（文言は `site-content/a11y.ts` の `NEW_TAB_NOTICE`）。外部リンク・`target="_blank"` のすべてで使う。
- `prefersReducedMotion(): boolean`（client）。React は `useReducedMotion(): boolean`。
- `MotionPause`: props は `{ label: string; onToggle(paused: boolean) }`。5 秒を超えて自動で動く部品は必ず付ける。
- `contrastRatio(fg: string, bg: string): number`。WCAG 2.x の相対輝度の式で、テストとトークンの検査に使う。
- 役割トークン（`theme.css`）: `--text-link-on-subtle`、`--border-input`、`--ring-on-dark`。

## 守る規則（全員）

1. 最初に次を読む。
   - この計画書
   - `docs/BasicDesign/DesignSpec/website/03-handoff.md`
   - `04-accessibility-spec.md`（Wave 1 で spec-writer が作る。作る前は `docs/data/JIS X 8341-32016 達成基準 早見表(レベルA & AA).pdf`）
   - `frontend/verdant-virgo/AGENTS.md`・`README.md`
2. **文言の正本は `01-content-spec.md`。** sr-only の文・新しいラベル・新しいページの文は、spec-writer が仕様書に書き、G-1 で承認された後に site-content に写す。部品に文言の既定値を持たせない（H-16）。
3. 色は役割トークンで書く。`brand.blue.500`・`brand.sky` を文字に使わない。`tokens.css` は直さない（P-3）。
4. a11y の修正は **ネイティブの HTML を優先**する（ARIA は足りないときだけ）。React の island を増やさない（Lighthouse performance 0.9 と SEO 1.0 を落とさない）。
5. 自分の所有ファイルだけに書く。他の所有者の変更が要るときは SendMessage で頼む。
6. git の状態を変えない。`.env` を読まない。`pnpm` だけを使う。テストは次の 2 か所だけに書く（U-2）。
   - verifier: verdant-virgo の e2e と単体テスト
   - loop-engineer: control-plane の単体テスト

   テストはメモリの規約（`正常系`／`異常系`、`空入力:`・`入力:`・`サーバ:` の接頭辞、timeout 30 秒）に従う。
7. フォームの送信・同意の記録・予約の確認では、**送信先の実際の URL をネットワークの記録で確かめてから**、`page.route` を**パスで**差し替える（Mautic の `/form/submit`、consent-api の `/v1/consent`）。開発の Mautic に実際に送らない。
8. dev サーバーはリードが 1 つだけ起動する（`astro dev --background`、4321）。ビルド・`pnpm lh`・`pnpm a11y` は verifier だけが走らせ、走らせている間はほかの人は重い処理をしない（Lighthouse の負荷の注意）。

## チーム構成（リード ＋ teammate 7 人）

| 名前 | 担当 | 書き込んでよい範囲 | plan approval |
|---|---|---|---|
| **lead**（メインセッション） | Wave 0・4、ゲートの取り次ぎ、依存の追加、設定 | `frontend/verdant-virgo/{package.json,pnpm-lock.yaml,astro.config.mjs,lighthouserc.cjs,.gitignore,AGENTS.md,README.md}`、リポジトリ直下の `.claude/CLAUDE.md`（ポート表）、`docs/superpowers/plans/` | — |
| `spec-writer` | 設計書と文言 | `docs/**`（`docs/audits/` を除く） | 要 |
| `foundation` | `a11y` モジュール、トークン、レイアウト、共通部品 | `src/modules/{a11y,layout,marketing-ui,brand,media}/**`、`src/styles/**`、`src/components/ui/**`、`src/lib/**` | 要 |
| `integrations` | フォーム・同意・予約・チャット・ブログ・法務 | `src/modules/{forms,source-dl,consent,booking,chat,blog,legal,analytics}/**` | 要 |
| `pages` | ページと文言データ、新しいページ 2 つ | `src/pages/**`、`src/modules/site-content/**` | 要 |
| `motion` | **インタラクションデザイナー兼実装者。** 体験の筋書きと動きの規則を守る責任者として、ほかの所有者の組み込みを見る（直しは SendMessage で頼む） | `src/modules/motion/**` | 要 |
| `verifier` | 自動テストの作成と実行、ビルド、Lighthouse、Playwright MCP での手動確認、試験結果の下書き | `frontend/verdant-virgo/{e2e/**,tests/modules/a11y/**,playwright.config.ts}`、scratchpad | 要 |
| `loop-engineer` | control-plane の builtin、定期実行、エージェント定義 | `backend/control-plane/src/{builtin,contract.ts,definitions,constants}/**` と対応するテスト、`ops/schedules/**`、`ops/README.md`、`.claude/agents/{quality-checker,proposal-writer,design-implementer}.md`、監視アプリ（`frontend/next-js`）のうち builtin の一覧を持つ箇所 | 要 |

## Wave とタスク（共有タスクリストに依存関係つきで登録する）

### Wave 0 — リードのみ

| # | 内容 |
|---|---|
| L0-0 | この計画書を `docs/superpowers/plans/2026-10-18-jis-x-8341-3-accessibility.md` に写す（teammate が読む正本） |
| L0-1 | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` を確かめる。astro-docs・shadcn・docling・Playwright の MCP が読み込めるかも確かめる。**`playwright-host` は今は接続できない**（ECONNREFUSED）ので、ユーザーに起動を頼むか、プラグインの `playwright` MCP で代える |
| L0-2 | 依存を追加する。`@playwright/test`、`@axe-core/playwright`（devDependencies）を入れ、`pnpm exec playwright install chromium` を実行する。`package.json` に `"a11y": "playwright test"` を足す。`.gitignore` に `.a11y/`・`test-results/`・`playwright-report/` を足す |
| L0-2b | React Bits の 4 種を取り込む: `pnpm dlx shadcn@latest add @react-bits/{ShapeBlur,MetaBalls,MorphSlider,GooeyNav,StatusMark}-TS-TW`。取り込んだファイルは `src/modules/motion/vendor/react-bits/` に移す（P-10）。依存の `motion`・`ogl` を足す（`gsap` は既にある。`minimumReleaseAge` に従う）。island で使う依存を `astro.config.mjs` の `optimizeDeps.include` に足す |
| L0-3 | 開発の Strapi に公開済みの記事があるかを確かめる（無いとビルドが失敗する）。dev サーバーを `astro dev --background` で起動し、teammate に URL を伝える |
| L0-4 | `.claude/CLAUDE.md` のポート表に **4323**（a11y 検査の preview）を足す |

### Wave 1 — 並行（ベースライン・仕様・基盤・ループの土台）

| # | 担当 | 内容 | 依存 |
|---|---|---|---|
| V1 | verifier | `playwright.config.ts` を作る。設定は次のとおり<br>・`webServer`: `astro preview --port 4323`<br>・projects: Desktop 1440、Mobile 390<br>・reporter: list と JSON（`.a11y/`）<br>次に `e2e/a11y/pages.spec.ts` で全ルートを axe で回す（タグは `wcag2a`・`wcag2aa`・`wcag21a`・`wcag21aa`・`wcag22aa`）。**改修前のベースライン**（違反の一覧と、ルール・ページ・要素）を scratchpad に出し、リードと各所有者に配る | L0-2、L0-3 |
| D1 | spec-writer | `docs/BasicDesign/DesignSpec/website/04-accessibility-spec.md` を新しく書く。内容は次のとおり<br>・38 基準と U-4 の追加基準を、このサイトの部品・ページに対応づけた表（該当の有無と満たし方）<br>・P-3〜P-7 の規則<br>・試験の方法（P-1、ツール、手動の手順、スクリーンリーダーの手順）<br>・試験結果の様式<br>早見表の PDF は docling か pdf スキルで読む | L0-0 |
| D2 | spec-writer | `01-content-spec.md` に文言の案を書く<br>・`/accessibility/` の方針の文と、表明の項目（規格・適合レベル・対応度・対象ページ・試験日・依存した技術・チェックリスト）<br>・`/sitemap/`<br>・sr-only の文（新しいタブ、「詳しく見る」の補い、読み込み中）<br>・姓・名の見えるラベル<br>・フッターのリンク 2 つ<br>`03-handoff.md` には H 系の規則（a11y）を足す | D1 |
| F1 | foundation | `a11y/index.ts`・`client.ts` の型（契約）を先に置き、中身を実装する。`theme.css` に P-3 の 3 トークンを足す。`global.css` に P-5 を入れる | L0-0 |
| F2 | foundation | `layout` の改修（表を参照）、Spinner、入力欄の枠、暗い地のフォーカスリング | F1 |
| M1 | motion | `motion/index.ts` の型（ラッパー 5 つの props）を先に置く。トークン（`theme.css` への追加は foundation に頼む）と `run-when-visible.ts` を作る。原本 5 本を読み、a11y と性能の差分を一覧にしてリードに出す。少なくとも次を含める<br>・MorphSlider の英語ラベルと tab の誤用<br>・MetaBalls の reduced-motion<br>・GooeyNav のフォーカスでの流れ<br>・画面外での停止 | L0-2b |
| M2 | motion | ラッパー 5 つを実装する。まず**トップに組み込んだ試作**を作る（組み込みは foundation・pages に頼む）。Playwright で動画（通常と reduced-motion、Desktop と Mobile）を撮り、G-1 に出す | M1、F1 |
| L1 | loop-engineer | builtin `a11y` を作る（`backend/control-plane/src/builtin/a11y.ts`）。`lighthouse.ts` と同じ安全設計にする<br>・実行元は承認済み main のチェックアウト<br>・env は許可リスト<br>・HOME は使い捨て<br>・`node_modules` と Chromium が無ければ `skipped`<br>・`.a11y/*.json` だけを作業ツリーに写し、シンボリックリンクはたどらない<br>あわせて `contract.ts` の `BuiltinJob` に足し、`BUILTIN_HANDLERS`・`missingConfigFor` に登録し、単体テストを書く。監視アプリで builtin の一覧を持つ箇所も `rg` で探して足す | L0-0 |

**ゲート G-1（ユーザー）**: 次の 4 つをユーザーに見せて承認を取る。**承認まで、文言を変える作業（I・P 系）と、モーションをほかの場所へ広げる作業（M3）に進まない。**
- D1・D2 の文言（新しいページ 2 つの文、sr-only の文、姓・名のラベル）
- P-3 のトークン（ブランドガイドラインからの逸脱）
- V1 のベースライン
- **M2 のモーションの試作の動画**（体験の筋書き・置き場所・強さ・速さの承認）

### Wave 2 — 改修（各所有者が並行。V1 のベースラインの違反を担当ごとに 0 にする）

| # | 担当 | 内容 | 依存 |
|---|---|---|---|
| F3 | foundation | `marketing-ui`・`brand` の改修（表を参照） | G-1、F2 |
| I1 | integrations | `forms`・`source-dl`（表を参照）。エラー・送信中・送信失敗・二重送信・完了の各状態で、フォーカスの行き先と読み上げを 1 回にそろえる | G-1、F1 |
| I2 | integrations | `consent`・`booking`・`chat` | G-1、F1 |
| I3 | integrations | `blog`・`legal`（見出しの正規化、外部リンク、表、`lang`） | G-1、F1 |
| P1 | pages | 見出しの階層の修正と、sr-only の文言の受け渡し。`site-content/a11y.ts` を作る | G-1、F1 |
| P2 | pages | `/accessibility/`（方針。試験結果の表は `site-content/accessibility.ts` のデータから描く。表は `caption`・`th scope` 付き）と `/sitemap/`（`site-content/nav.ts` とブログのカテゴリから作る）。sitemap.xml とフッターに載せる | G-1、F2 |
| V2 | verifier | e2e の検査を足す（下の「検証」の 2〜7）と、単体テスト `tests/modules/a11y/`（`contrastRatio`、トークンの組み合わせの比、`prefersReducedMotion`） | V1、F1 |
| M3 | motion | G-1 の指摘を反映し、残りの場所（全ページのヘッダーの `MotionNav` とページ遷移、`CTABanner` の `MotionBlobs`、フォームの `SendStatus`）へ広げる。組み込みは各所有者が行い、motion が筋書きと規則どおりかを確かめる | G-1、M2 |
| L2 | loop-engineer | `ops/schedules/weekly-a11y.yaml` を作る。builtin `a11y`、`enabled: false`、`after: [weekly-lighthouse]`。負荷を重ねないため、lighthouse と同時に走らせない | L1 |
| D3 | spec-writer | 設計書を更新する（下の「設計書の更新」） | D1 |

### Wave 3 — 検査・試験・ループの仕上げ

| # | 担当 | 内容 | 依存 |
|---|---|---|---|
| Q1 | verifier | `pnpm build`（`SITE_URL` を設定）、`pnpm a11y`、`pnpm lh`。違反は所有者に SendMessage で伝え、直ったら再検査する | Wave 2 |
| Q2 | verifier | **手動の試験**を Playwright MCP で行い、全ページを Desktop と Mobile で確かめる<br>・キーボードだけで一周できる（スキップリンク、フォーカス順、トラップなし、Esc）<br>・フォーカスが見える<br>・200% の拡大と幅 320px でリフローする<br>・文字の間隔を広げても切れない（1.4.12）<br>・reduced-motion<br>・ホバーとフォーカスで出る内容（1.4.13）<br>・Cal.com と Chatwoot（同意後）<br>結果を、38 基準と追加の基準ごとの「適用／適合」の下書きにまとめる | Q1 |
| Q3 | verifier | スクリーンリーダーの確認手順書を scratchpad に書く。NVDA＋Chrome（Windows）と VoiceOver（iOS Safari）で、ページごとの確認項目と期待する読み上げを並べる | Q2 |
| L3 | loop-engineer | **quality-checker の改修**<br>・項目 6「WCAG の機械検査」を足す。`.a11y/` の最新の結果を読み、`metrics` のキーは `QC-a11y-violations`・`QC-a11y-serious`（critical と serious の合計）・`QC-a11y-pages-failed`・`QC-a11y-incomplete`（人の判断が要る件数）。`fetch.outcome` の規則は既存どおり<br>**定期実行**<br>・`ops/schedules/weekly-observe-a11y.yaml` を作る（agent は quality-checker、項目 6 だけ、`after: [weekly-a11y]`）<br>**proposal-writer の改修**<br>・`QC-a11y-serious > 0` の間は、a11y の修正の提案をほかの UI 変更より先にする<br>・違反を増やす提案は起票しない（止め線）<br>**design-implementer の改修**<br>・P-6 と `04-accessibility-spec.md` のチェックリストを守る規則を足す<br>**その他**<br>・`ops/README.md` の表を更新する | L2、D3 |

**ゲート G-2（ユーザー）**: 次をユーザーに頼み、結果を受け取る。
- Q3 の手順で、スクリーンリーダーで確かめる。
- P-7 の判断（第三者の埋め込みが満たせない基準があった場合）。

指摘があれば所有者が直し、verifier が再検査する（タスク X）。

### Wave 4 — 表明と仕上げ（リード）

| # | 内容 |
|---|---|
| L4-1 | Q2 と G-2 の結果を `site-content/accessibility.ts` の試験結果に確定させ（pages に頼む）、試験日・対象ページ・依存した技術を入れる。最後に `pnpm a11y` と `pnpm lh` をもう一度全部通す |
| L4-2 | `03-handoff.md` に実装の状況と申し送り（下の表）を足す。`verdant-virgo/README.md` に `pnpm a11y` とポート 4323、`AGENTS.md` に P-6 を足す |
| L4-3 | ユーザーに報告する（ベースラインからの違反の推移、Lighthouse、試験結果の表、ループの構成） |

## 設計書の更新（D3。spec-writer）

- **`docs/RequirementDefinition/AA/05-application-decisions.md`**
  - **ADR-27「公開サイトは JIS X 8341-3:2016 の AA 準拠を表明し、試験結果を公開する」** を足す。
    - 書式: 文脈 → 選択肢 → 決定 → 理由 → 帰結 → 再検討の契機
    - 内容: U-1〜U-4 と P-1・P-7・P-9
  - 末尾の「決定の一覧」に 1 行足す。
  - 件数の古い記述を直す（`docs/README.md:63`・`:240`、AA-05 の `:5`）。
- **非機能要件**: アクセシビリティの節を新しく作る（どの層に置くかは既存の構成で決める。TA か BA の品質の節が候補）。
- **ADR-28「公開サイトのモーションは React Bits を段階的な強化として島で載せる」** を足す。内容は U-5、P-10、動きの規則 1〜8、性能の予算。
- **`docs/BasicDesign/DesignSpec/website/05-motion-spec.md`** を新しく書く。内容は次のとおり。
  - 体験の筋書きの表
  - 動きの規則
  - トークン
  - 各部品の振る舞い（通常・reduced-motion・WebGL なし・Mobile）
  - `01-content-spec.md` への置き場所の追記（MorphGallery のキャプションとラベルの文言、一時停止ボタンの文言）
- **`DA/02` 4.3**
  - `A11Y-*` 指標（`QC-a11y-*` と対応）を足す。
  - `LH-a11y`／`LH-accessibility` の表記ゆれを `LH-a11y` にそろえる（`DetailedDesign/05-build-and-delivery-flows.md:194`）。
- **`AA/04`**: 3 節の安全装置に a11y の止め線（SEO 1.0 と同じ扱い）を足す。
- **`DetailedDesign/06-proposal-loop-flows.md`**: 起票前チェックに 1 項目足す。
- **change.kind**: `accessibility` を足すかを決め、足す場合は次の 3 か所を直す。
  - `DA/01:353`
  - `AA/04` 2.2
  - `DD/01` 8.3
- **`BA/04` 3b**: 「UI を変える公開の前に、変えたページを人がスクリーンリーダーで確かめる」を足す。
- **`TA/03`・`TA/05`**: builtin `a11y` のジョブ、ポート 4323、Chromium を main のチェックアウトに入れておく前提を書く。
- **`DetailedDesign/`**: 新しい節（または新しいファイル `09-accessibility-audit-flows.md`）に、次の流れを書く。
  - `weekly-a11y` → `weekly-observe-a11y` → `E-12` → proposal-writer
  - `fetch.outcome` の当てはめ

## `03-handoff.md` に申し送るもの（この計画では実施しない）

| 対象 | 内容 |
|---|---|
| ブランドガイドライン（`~/ComeGin/comegin`） | P-3 の 3 トークン（薄い地のリンク、入力欄の枠、暗い地のリング）を §5 に足す改訂 |
| 本番のオンプレ | main のチェックアウトでの `pnpm install` と `playwright install chromium`、`weekly-a11y`・`weekly-observe-a11y` の有効化 |
| 再試験 | UI を変えたときは変えたページを、年に 1 回は全ページを試験し直し、`/accessibility/` の試験日を更新する |
| 受託開発 | 同じ手順（axe の e2e と手動とスクリーンリーダー）を、創業計画書の別紙 1 第 8 章「納品前の確認記録」の様式として流用する（要確認事項 10 の工数見積もりの材料） |

## 検証

1. **ビルド**: `SITE_URL` を設定して `pnpm build` が通る。sitemap.xml に `/accessibility/`・`/sitemap/` が載る。
2. **axe（自動）**: `pnpm a11y` で全ルート × Desktop/Mobile の違反が 0。次の状態でも 0 であること（`page.route` はパスで差し替える）。
   - Cookie バナーの表示中
   - Mobile メニューを開いたとき
   - フォームの入力エラー・送信失敗（エラーの応答と 10 秒の無応答）・二重送信・完了
   - DL ブロックの 5 状態
   - 予約の読み込み失敗
3. **キーボード（自動）**:
   - Tab で全部の操作できる要素に届き、順序が見た目と合う。
   - スキップリンクで `#main` にフォーカスが移る。
   - Mobile メニューは Esc で閉じ、フォーカスが戻る。
   - フォーカスしている要素の outline の幅が 0 でなく、Cookie バナーに隠れない。
4. **表示（自動）**:
   - 幅 320px で横スクロールが出ない。
   - 200% に拡大し、WCAG 1.4.12 の文字の間隔を当てても、文字が切れたり重なったりしない。
   - `emulateMedia({ reducedMotion: 'reduce' })` で、transition と animation が実質 0 になる。
5. **コントラスト（単体）**: `theme.css` の役割トークンの組み合わせ（文字と地、リンクと地、リングと地、枠と地）が 4.5:1（大きい文字・UI は 3:1）以上。
6. **フォーム**:
   - すべての欄に見えるラベルと `autocomplete` がある。
   - エラーは欄と `aria-describedby` で結ばれ、最初のエラーにフォーカスが移る。
   - 通知の読み上げが 1 回である（`role` とフォーカスの重複がない）。
7. **見出しと名前**:
   - 各ページで h1 が 1 つで、見出しの段が飛ばない。
   - ランドマークの名前が重複しない。
   - `target="_blank"` のすべてに新しいタブの告知がある。
   - iframe に `title` がある。
8. **Lighthouse**: performance・accessibility・best-practices が 0.9 以上で、**accessibility は 1.0 を保つ**。**SEO は 1.0。**
   - 計測対象に `/contact/` を足す（リードが `lighthouserc.cjs` を変える）。
   - モーションを入れた後のトップは、Desktop の preset でも 1 回測る（GooeyNav・ShapeBlur は Desktop だけで読むため）。
9. **モーション**（e2e で自動。V2 に含める）
   - **reduced-motion**: 4 種とも静止する。`requestAnimationFrame` のコールバックが一定時間に 0 回になることで確かめる。
   - **一時停止**: `MotionBlobs` の一時停止ボタンが Tab で届き、Enter・Space で止まって名前が「再開」に変わる。ページを移っても止まったまま。
   - **WebGL なし**: WebGL を無効にした起動でも、静止 SVG・`<img>`・`<a>` で内容が欠けず、コンソールにエラーが出ない。
   - **省電力**: 画面外とタブ非表示で描画が止まる。
   - **フォーカス**:
     - GooeyNav は Tab でフォーカスしたときも形が流れ、フォーカスリングが見える。
     - MorphSlider は日本語の名前を持ち、矢印キーとボタンで操作でき、切り替えは操作したときだけ読み上げる。
   - **SendStatus**: 送信中・完了の文字が `role="status"` で 1 回読み上げられる。
   - **CLS**: 0。
   - 動きのある部品の上に重なる文字が 4.5:1 以上（キャンバスを含めたスクリーンショットで測る）。
   - **人の確認**（Q2・G-2）: 閃光が 1 秒に 3 回を超えないことを目で確かめる。Mobile で ShapeBlur と GooeyNav が読み込まれないことをネットワークの記録で確かめる。
10. **ループ**:
   - control-plane の単体テストが通る。
   - `weekly-a11y` を手動で 1 回実行し、`.a11y/` が作業ツリーに写ることを確かめる。
   - `weekly-observe-a11y` で `docs/audits/quality/` に `QC-a11y-*` 付きの `E-12` ができることを確かめる。
   - 結果が 0 件なら `ok`、Chromium が無ければ `skipped`。
11. **人の確認**（G-2）: スクリーンリーダーの手順書の全項目が期待どおりに読み上げられる。`/accessibility/` の試験結果の表が、Q2 と G-2 の結果と一致する。

## リードへの起動プロンプト（Wave 0 の後にそのまま使える）

```
Agent team を作成して。チーム名 a11y-jis-1018。
計画書 docs/superpowers/plans/2026-10-18-jis-x-8341-3-accessibility.md の「モジュールと所有者」「チーム構成」「Wave とタスク」に従い、
teammate 7 人（spec-writer, foundation, integrations, pages, motion, verifier, loop-engineer）を spawn する。
motion には「インタラクションデザイナーとして、計画書の『インタラクションデザイン』の体験の筋書きと動きの規則を守る責任者」であることを伝える。
各 teammate の起動時の指示には、計画書と docs/BasicDesign/DesignSpec/website/03-handoff.md を最初に読むこと、
担当タスク ID、書き込んでよい範囲、計画書の「守る規則」「モジュール間の契約」、dev サーバーの URL を書く。
全員 plan approval を必須にし、承認の条件は次の 4 点とする。
「書き込んでよい範囲だけに書く」
「文言は 01-content-spec から写す（G-1 の前に文言を変えない）」
「ネイティブの HTML を優先し、色は役割トークンで書く」
「他モジュールは index.ts / client.ts 経由で使う」
共有タスクリストに、次をすべて依存関係つきで登録すること。
V1〜V2, Q1〜Q3, D1〜D3, F1〜F3, I1〜I3, P1〜P2, M1〜M3, L1〜L3、ゲート G-1・G-2。
G-1・G-2・P-7 の判断と、記事が 0 件のときの対応は、リードが判断・代行せず、必ず私（ユーザー）に確認すること。
```

## 実行中に決めたこと（リード。2026-10-18）

| # | 決定 | 理由 |
|---|---|---|
| R-1 | **MorphGallery は `/services/partnership` の既存の gallery**（`site-content/services.ts` の `partnership.gallery`、01-content-spec §4.3.3）を置き換える。トップには新しい節を作らない | 写真 3 枚と見出し「提携する事業」が既にそこにあり、新しい文言が要らない。トップの目を引く動きを ShapeBlur の 1 つに保てる（動きの規則 1） |
| R-2 | 定期実行の a11y 検査は `weekly-lighthouse` の後に続けない（`after` を外す）。builtin `a11y` は `pnpm a11y:ci`（`astro build && playwright test`）を 05:45 に実行する | lighthouse の失敗で a11y の検査まで止まらないようにするため。lighthouse の古い dist を黙って測らないため |
| R-3 | 同意の撤回の「2 回のキー操作以内」はやめる。要件は「全ページのフッターの『Cookie 設定』からキーボードだけで撤回まで届き、再表示のときに見出しへフォーカスが移る」 | 計画の側で置いた目安で、WCAG の要件ではない。今の作りで満たす |
| R-4 | Cookie 同意バナーは、DOM ではスキップリンクの直後・告知帯の前に置く（見た目は下端に固定のまま） | 2.4.3。初めて訪れた人が最初に気づける |
| R-5 | 無料相談のフォームの名前は `/contact` の h1 を指す。Cal.com の iframe の `title` は、BookingEmbed の h2 の文字を仮に使う | 新しい文言を増やさない |
| R-6 | `sharp` 0.35.4 を直接の依存にする | 依存の追加で並びが変わり、ビルドの画像の最適化が `sharp` を解決できなくなったため |

## ゲート G-1 の結果（ユーザー。2026-10-18 22:50 ごろ）

| # | 論点 | 決定 |
|---|---|---|
| G1-1 | 文言（01-content-spec の 12 件）と P-3 の 3 つの色のトークン | **承認**。ブランドガイドラインの改訂は申し送り |
| G1-2 | モーションの試作 4 種（MO-5: ロゴのシンボルにネイビーの単色でぼかし、最初はピントが合っている／MO-6: Mobile ではシンボルと CTA の粒を出さない） | **この形で進める**（M3 で広げる） |
| G1-3 | A-2: Cal.com の二重入力（WCAG 2.2 の 3.3.7。38 基準の外） | **今のまま**（事前入力しない。予約しない人の氏名・メールを Cal.com に渡さない） |
| G1-4 | A-4: /accessibility/ に WCAG 2.1・2.2 の追加の 18 基準の表 | **参考として載せる** |
| R-7 | MorphGallery の操作 | 前へ・次へのボタンではなく、**ネイティブのラジオ 3 つ**（既存の 3 分野の語。新しい文言なし。通知なし） |
| R-8 | SendStatus | 形（SendStatusMark、ボタンの中、aria-hidden）と読み上げ（SendStatusAnnouncer、ボタンの外、送信中の「送信中…」1 回だけ）に分ける。完了は読まない |
| R-9 | 止め線（検査 15） | 最新の QC-a11y-serious が確認できないときも通らない（検査 8 と同じ）。a11y の 2 つの定期実行を有効にすることが、UI を変える提案を自動で起票する前提 |
| R-10 | `playwright test` を走らせるのは verifier だけ | globalSetup が `.a11y/pages/` を消すので、同時に走らせると結果を壊す |

## ゲート G-2 の前倒しの判断（ユーザー。2026-10-18 23:35 ごろ。P-7）

| # | 論点 | 決定 |
|---|---|---|
| G2-1 | Chatwoot のウィジェット（ランチャーの名前が英語、閉じるボタンと iframe に名前が無い、開いてもフォーカスが移らない） | **属性で名前を補い、あわせて部分適合を明記する**。ランチャー「チャットで質問する」、閉じるボタン「チャットを閉じる」（新しい文言）、iframe「ComeGin へのご質問」。ウィジェットの中身は第三者のコンテンツとして /accessibility/ に明記し、代わりに無料相談のフォームを示す |
| G2-2 | Cal.com の埋め込みの中の時間枠のボタン（2.5.3）など | **部分適合を明記して残す**（埋め込みは今のまま） |
| R-11 | /blog のカテゴリのタブ（Mobile） | 横スクロールをやめて折り返す（320px で最後のタブにフォーカスしても枠が送られず見えないため。2.4.11・1.4.10） |
| R-12 | 見出し・表のセルの `overflow-wrap: anywhere` | 2026-10-09 の P-3 を改め、1.4.10 のために当てる（副作用は foundation が見比べる） |

スクリーンリーダーでの確認（G-2 の残り）は、Wave 3 の Q3 の手順書ができてからユーザーに頼む。

## 対応度の判断（ユーザー。2026-10-19 0:05 ごろ。A-6）

| # | 論点 | 決定 |
|---|---|---|
| A-6 | WAIC の対応度表記ガイドライン（2021 年 4 月版）では、JIS の 5.3「部分適合に関する記述－第三者によるコンテンツ」を適用するページがあると「準拠」と書けず、部分適合の記述をしたうえで「一部準拠」と表記する。Chatwoot は同意の後に全ページで読み込む | **「AA 一部準拠」で表明する**（U-1 の「準拠」を改める）。部分適合の記述と「今後の対応方針」を /accessibility/ に載せる。自社の部分は AA の全基準を満たすことを目標に試験する。埋め込みを外して「準拠」を保つ案は採らない（チャットと予約の経路を保つ） |
| R-13 | Chatwoot を開いたときのフォーカス | iframe へ移す（2.4.3 を優先）。代わりに Esc で閉じられなくなる（WCAG の要件ではない）ことを /accessibility/ に記す |
| R-14 | `overflow-wrap: anywhere` | global.css では 360px 未満の幅だけに当てる。部品の側（LegalTable・accessibility・about の表のセル）の anywhere は外す |

## Wave 3 の Q1 で決めたこと（リード。2026-10-19 3:45 ごろ）

| # | 論点 | 決定 |
|---|---|---|
| R-15 | トップの CLS（Desktop 0.0030・Mobile 0.0029。検証 9 の「CLS 0」） | Desktop は GooeyNav の canvas の寸法の変化（300×150 → 402×159）で、モーションが起こすずれなので motion が直す。Mobile は欧文の Poppins の差し替えで行が数 px 縮むもので、モーションの部品は描かれない（改修前からの性質）。この改修では直さず、03-handoff に申し送る（Poppins の寸法に合わせた fallback の @font-face）。motion.spec の判定は「motion のラッパーの中の要素が sources に出るずれが 0」に改め、合計の CLS は参考として記録する |
| R-16 | 主ボタンの hover の `opacity-90` | 白 on 透けた blue.600 で 4.28:1 になるので外し、hover は地を blue.700（6.87:1）にするだけにする。destructive の hover も地を濃くせず枠で示す（button・badge） |
| R-15 改 | トップの Mobile の CLS（R-15 を改める。3:50 ごろ） | 原因は和文の Noto Sans JP の差し替え（pages が woff2 の遅延で再現）。`brand/integration.ts` は寸法合わせの fallback（`Noto Sans JP Fallback`）を `defer` のときだけ入れる作りで、今の設定（defer なし）では入っていなかった。値は既にあり実測で詰める必要が無いので、**この改修で直す**（defer でないときも fallback の @font-face と書体の並びへの追加を入れる。foundation）。確かめは、ビルドし直した dist に pages の台本（woff2 を遅らせる）を当てる。03-handoff のフォントの行は、直した結果に合わせて書き直す |
| R-17 | motion.spec の CLS の判定（R-15 を改める。4:35 ごろ） | 「sources がすべて motion の要素であるずれの合計が 0」とする。フォントの差し替えでヘッダーの箱が縮み、GooeyNav の canvas が一緒に動くずれは motion が起こしたものではないので外す。Desktop のトップに残る 0.0001〜0.0005（欧文の Poppins の差し替えの見込み）は 03-handoff に申し送る |

## ゲート G-2 の結果（ユーザー。2026-10-19 5:40 ごろ）

| # | 論点 | 結果 |
|---|---|---|
| G2-3 | スクリーンリーダーの確認（Q3 の手順書） | NVDA＋Chrome（Windows）で全項目が期待どおり。「SR」の印の 10 基準を適合で確定する。VoiceOver（iOS）は確かめていないので、`/accessibility/` の「試験の方法」を NVDA と Chrome に改め、iOS は次の再試験に申し送る |
| R-18 | 試行で作った E-12（`AUD-2026-1019-quality-0001.md`） | 検証 10 の試行として作り、ユーザーの判断で消した（E-12 ができることは確かめた） |
| G2-4 | 検証 8 の Lighthouse の performance（2026-10-19 5:52〜。Mobile の模擬、5 回の中央値: / 0.90・/blog/ 0.74・/contact/ 0.81・記事 1.0。Desktop の preset のトップ 0.98。a11y・bp・SEO は 20 回すべて 1.0、CLS はすべて 0） | **申し送りにする**（ユーザー）。同じ配信・設定で改修前の dist の /blog/ は 0.68、今回は 0.87〜0.89 で、改修による悪化ではない。落ちているのは模擬の LCP で、和文フォント 3 本（計 約 560KB）と preview の TTFB（約 460ms）が主因。フォントを軽くする作業（使う字の見直し・ウェイトを 2 本に・本文以外を後から読む）を 03-handoff に別件として申し送る。`pnpm lh` は /blog/ の performance の assertion で失敗のまま |
