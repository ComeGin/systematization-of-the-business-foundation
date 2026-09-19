# 03. 実装への引き継ぎ

Figma でのデザインを `frontend/verdant-virgo`（Astro ＋ shadcn/ui `base-nova` ＋ Tailwind v4）に実装するときの申し送り。

- デザインの正本は**コード側**（`src/styles/global.css` のトークンと shadcn/ui のコンポーネント）。`docs/RequirementDefinition/BA/02-capability-map.md:106` の方針は変えていない。
- Figma ファイル `JRYPLER6E0liA7cUurIhSo` はその**派生物**。実装後に Figma を保守し続けることはしない。
- コピー・CTA・計測の正本は `01-content-spec.md`。部品と変数の対応は `02-component-map.md`。

## 1. global.css への変更提案

Figma 側では `global.css` の値を 1 つも変えていない（ローカル変数はアクセント色と `layout/container-max` のみ）。実装時に次を検討する。

| # | 提案 | 内容 | 理由 |
|---|---|---|---|
| H-1 | アクセント色の追加 | `--brand`（base）`--brand-hover` `--brand-foreground` `--brand-subtle` `--brand-subtle-foreground` を追加。値は Tailwind v4 の emerald（`--color-emerald-700` = `oklch(0.508 0.118 165.612)` / #007a55、hover は emerald-800、subtle は emerald-50） | G1 でユーザーがアクセント色「B 成長の緑」を採用。Tailwind の既定パレットなので新しい色を定義する必要はない。使いどころは**主 CTA・テキストリンク・強調バッジ・アイコンの強調だけ** |
| H-2 | 和文フォントの追加 | `--font-sans` に `Noto Sans JP` を Inter の後ろに足す | 現状の `--font-sans` は `'Inter Variable'` のみで和文フォントの指定が無い。Figma では和文 Noto Sans JP・欧文 Inter で組んでいる |

## 2. トークンは変えずに構図で守る規則

`global.css` の値を変えずに、**組み方の規則**として守るもの。守らないと Lighthouse の accessibility（しきい値 0.9）に響く。

| # | 規則 | 根拠 |
|---|---|---|
| H-3 | **読ませる文字は白い面（`background` / `card`）に載せる。`bg-muted` の面に `text-muted-foreground` の本文・補足・エラー文を置かない** | `muted-foreground` #737373 on `muted` #f5f5f5 = **4.35:1**（AA 4.5:1 未満）。白の上なら 4.74:1 で通る。`destructive` #dc2626 も muted 面で 4.43:1。面を分けたいときは**白＋ `border`** で分ける。文字を載せない装飾の帯は `muted` のままでよい |
| H-4 | **本文の 1 行は Desktop で 720px までに抑える**（中央揃えのリードは 768px まで） | 1152px 幅の 1 行は和文で 60 字を超え、読み返しの負担が大きい |
| H-5 | **Desktop で本文を横に並べるときは、1 列に 1 行 20 字入る幅を目安にする。3 列（368px）は下限として許容し、4 列以上は本文を載せない場合に限る** | コンテンツ幅 1152・列間 24・**カードの左右余白は各 24**（部品の実測値）。3 列＝カード 368px・本文幅 318px。字数は本文のサイズで決まり、**14px なら約 22.7 字、16px なら約 19.3 字**（`IconCard` だけ本文 16px、ServiceCard・PricingCard・BlogCard は 14px）。5 列（218px・約 13 字）では語の途中で改行が起きた。19.3 字では起きていないため許容する。詳細は `01-content-spec.md` §0.3 |
| H-6 | **Mobile の主 CTA はタップ領域を広げる** | `CTAButton` の高さは Small 28 / Default 32 / Large 36 で `button.tsx` の base-nova（`h-7`/`h-8`/`h-9`）と完全一致。Figma はコードに合わせてある。ただし Mobile の 36px はタップ領域として小さいので、実装側で Mobile のときだけ縦余白を足して実効 44px 程度にすることを検討する |

## 3. 面のトークンの使い分け

Figma で役割ごとに固定した。実装でも同じ使い分けにすると、あとで値を変えたときにずれない。

| トークン | 用途 |
|---|---|
| `background` | ページの地の面（ヘッダー・フッター・ページ導入部） |
| `card` | 枠線や影で浮かせる面（カード類・Cookie バナー・無料 DL ブロック・CTA バナーのインライン版・モバイルメニューのパネル） |
| `muted` | 文字を載せない装飾の面（画像枠・チャット枠・告知バナー） |
| `primary` | 反転面（CTA バナーの標準版）。この面の上の文字は `primary-foreground`。`muted-foreground` 相当を載せない（#737373 on #171717 = 3.5:1 で不足） |

## 4. レイアウトの寸法

| 項目 | Desktop | Mobile |
|---|---|---|
| フレーム幅 | 1440px | 390px |
| コンテンツ幅 | 1152px（左右余白 144） | 358px（左右余白 16） |
| セクションの上下余白 | 96px（ヒーロー上は 128） | 64px |
| 記事本文の幅 | 720px | 358px |
| フォームの中身の最大幅 | 640px | 全幅 |

## 5. Figma の部品と実装の対応

`02-component-map.md` に、kit コンポーネント（`<名前> - Nova`）・shadcn/ui 名・componentKey・variant・TEXT プロパティの対応表がある。サイト固有に作った部品は 26 個で、Astro のコンポーネントに落とすときの単位もこれに合わせる。

主なもの: `SiteHeader`（CTA の強弱 Primary/Outline を持つ）、`SiteFooter`、`PageIntro`、`SectionHeading`、`CTAButton`（主 CTA 専用。塗りがアクセント色）、`CTABanner`（標準版＝反転面 / インライン版）、`ServiceCard`、`PricingCard`、`IconCard`、`BlogCard`、`Steps`、`FAQItem`、`SourceDownloadBlock`（控えめ版 / 強調版）、`ContactForm`、`CookieBanner`、`LogoCloud`・`TestimonialCard`・`StatCard`（すべてダミー）、`ImagePlaceholder`、`ChatWidgetPlaceholder`。

## 6. 計測

- CTA・フォームのイベント名と `cta_id` は `01-content-spec.md` §6.3 の表（全 31 行）が正本。Figma の各 CTA には dev annotation で `cta_id` / `cta_type` / `cta_role` / 遷移先・送信先 / イベント名が書いてある
- イベント名は `DA/02-metrics-and-kpi.md` の規則に合わせて `cta_viewed` / `cta_clicked` を使い、目的は `cta_type` などのプロパティで分ける。フォームは `form_started` / `form_validation_failed` / `form_submitted` / `form_submit_failed`
- **同じ `cta_id` を 2 画面で使わない**（トップ＝`dl_top_card` / サービス一覧＝`dl_services_card` / 料金＝`dl_pricing_card`）
- PostHog は Cookie の同意後にだけ送る。CV は Mautic のフォーム送信で数える（`DetailedDesign/02-public-path-flows.md`）
- フォームは Mautic の埋め込みではなく Astro で描く自前フォーム。hidden で `cta_id` / `page_url` / `service_interest` を渡す

## 7. 実装前に決めておくこと

`01-content-spec.md` §10.2 の未決事項。画面には `【要記入】`『要確認』の印が残してある。

- 会社情報（会社名の正式表記・代表者名・所在地・設立・連絡先）と法務 2 ページの本文
- Mautic のフォーム ID（`TBD` のまま）
- 配布するソースコードのライセンスと置き場所
- クラウドに構築する場合のクラウド利用料の負担（C10）
- 著作権を譲渡する条件（C11）
- チャットの `cta_type` の値（F7）
- **上位の設計書への反映**: `01-content-spec.md` で決めた次の 2 件が、まだ設計書に書かれていない。実装前に反映する
  - `DetailedDesign/02-public-path-flows.md` — フォームの hidden 項目（`cta_id` / `page_url` / `service_interest`）の受け渡し
  - `RequirementDefinition/DA/02-metrics-and-kpi.md` — フォームのイベント 4 種（`form_started` / `form_validation_failed` / `form_submitted` / `form_submit_failed`）
- Cookie 同意の状態の保存先と撤回時の扱い、Mobile で Cookie バナーとチャットボタンが重なる件（K4。Figma の `1-13 Cookie バナー表示中 / Mobile` で重なりを見られる）

## 8. 残る既知の許容事項

判断のうえで残したもの。**いずれも対応不要**。実装時に「直し忘れ」と誤解しないための記録。

| # | 内容 | 実測値 | 判断の理由 |
|---|---|---|---|
| 1 | `IconCard` を 3 列で使う箇所（トップ 1-4・会社概要 5-4）の本文が 1 行 19.3 字 | カード 368px・余白 24 → 本文 318px・16px | 規則の目的は語中改行の回避で、19.3 字では起きていない。本文を 14px に落とすのは読みやすさを行長の規則のために下げることになり、向きが逆 |
| 2 | 料金カード 2 の見出しが 2 行 | 「受託開発：バイブコーディングのみ」16 字 / 枠 318px（約 15.9 字） | プロダクト名は正本から一字一句写す決まりで変えられない。`JP/UI/Card Title` は 4 部品で共通なので 1 枚のために動かさない。金額・期間・CTA の位置はそろっている |
| 3 | FAQ の「要確認」バッジで Mobile の質問が 2 行になる（1 件） | バッジ 52px ＋ 余白 12px ぶん幅を使う | このバッジは**公開前に埋める箇所を見つけるためのもので、公開時には消える**（確定が進むたび減り、11 件 → 7 件）。同じリストは印の無い長い質問でも 2 行になる |
| 4 | Mobile のフレームに `JP/Desktop/*` の文字スタイルが 69 件 | Body・Small・Caption は D/M で**値が完全同値**（16/175%/3%、14/170%/3%、12/160%/4%） | 見た目への影響ゼロ。値が違う Body L・H3 の混入は 0 件。部品に Device variant を足すと variant が倍になる割に得るものが無い |
| 5 | `CTAButton` の高さ 28 / 32 / 36 が Mobile ではタップ領域として小さい | `button.tsx` の base-nova（`h-7`/`h-8`/`h-9`）と**完全一致** | Figma はコードに合わせるのが正。実装側で Mobile だけ縦余白を足す（H-6） |
| 6 | 無料 DL ブロックの控えめ版と強調版が同じ白い面 | 差は 見出し `H3`/`H2`・影 なし/`shadow-md`・ボタン `Secondary`/`CTAButton` の 3 点 | 「控えめは面の色ではなく枠線とボタンで表す」という決定（`01-content-spec.md` §0.1）どおり |

## 9. 最終の検査結果

`qa-reviewer` による全ページ検査（2026-09-20 実施）。**全 9 ページで未処理ゼロ**。

| 検査項目 | 結果 |
|---|---|
| コントラスト（WCAG AA。変数の実効値を解決して計算） | 違反 0 |
| 許可外フォント（Geist など） | 0 |
| 和欧混植の漏れ（Inter 漏れ / Noto Sans JP 漏れ） | 0 / 0 |
| instance 外の未バインドの塗り・線 | 0 |
| kit 既定のプレースホルダ文言 | 0 |
| 壊れた instance・削除された変数への参照 | 0 |
| 未完成を示す placeholder の残り | 0 |
| コピーの一致（`01-content-spec.md` との突き合わせ） | 欠落 0 |
| 複製フレームと本体の一致 | 差分 0 |

走査した規模: ノード 9,204 / TEXT 3,550（中身のあるもの 3,533、空 17）/ 塗りのセグメント 5,328。空の 17 件は kit の Input の `Value`（半角スペース 1 個）で、空文字を渡すと既定値に戻るための当て木。意図的なもの。

検査項目は当初の 10 項目から、作業中に見つかった問題に応じて 18 項目まで増えた（和欧混植、Mobile への Desktop 用スタイルの混入、段組みの字数、複製と本体の一致、壊れた instance、削除された変数への参照、`componentProperties` の値、placeholder の残り）。

## 10. Figma を機械で操作するときの落とし穴

同じ検査を再現するスクリプトが `qa-audit.js` にある（読み取り専用。先頭の `PAGE_ID` を書き換えて `use_figma` に貼る）。下の落とし穴は、このスクリプトを書く過程で実際に踏んだもの。

同じ作業を再開するとき用。詳細は `02-component-map.md` §6.1。

- kit のボタンのラベルは TEXT プロパティにできない（instance の中の層にプロパティを結べない）。中の TEXT を直接書き換える
- **`setProperties()` や `characters` で差し替えると和欧の当て分けが失われる。** 差し替えのたびに `applyMixed()` で半角英数字に Inter を当て直す
- **注記は `label` と `labelMarkdown` の両方を見る。** `labelMarkdown` 側はアンダースコアが `\_` にエスケープされて保存される
- **非表示レイヤーは instance に展開されない。** 走査に出なくても値は `componentProperties` に残っている
- kit の Badge の中のテキストも `Label` という名前。名前で探すと質問文をバッジに書き込んでしまう
- **`setProperties()` の直後は、先に `findAllWithCriteria()` で取った instance の参照が無効になることがある**（`The node with id "…" does not exist` で全ロールバックされる）。対象のノード ID を先に配列で確定させ、1 件ずつ `getNodeByIdAsync()` で取り直してから書き換える
- **空文字で `figma.createText()` したテキストに後から `characters` を入れると、幅 0 のまま折り返して高さが爆発する**（1 文字ずつ改行され、カードが 4579px になった）。`layoutSizingHorizontal = 'FILL'` を当て直しても直らず、`FIXED` にして `resize()` で幅を与えてから `textAutoResize = 'HEIGHT'` → `FILL` の順で復旧する。**空のテキストを先に作って後から流し込む書き方は避ける**
- **`figma.createText()` で作った TEXT は、塗りを明示しない限り未バインドの黒（#000000）になる。** 手で作るときと初期状態が違う。作るたびに `foreground` などの変数をバインドする（この漏れが 83 件出た）
- `03 Components` の部品は publish していないので `importComponentByKeyAsync` は失敗する。`getNodeByIdAsync` で取る
- instance の中の層は `resize()` が黙って無視される。大きさを変えたいときは部品側に枠と BOOLEAN を足す
- 折り返しの auto-layout では `counterAxisAlignItems = 'STRETCH'` が使えない。高さ揃えは子の `layoutSizingVertical = 'FILL'` で行う
