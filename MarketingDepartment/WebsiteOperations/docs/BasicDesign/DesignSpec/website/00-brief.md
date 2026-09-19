# 00. Web サイト Figma 制作ブリーフ（チーム共通の前提）

Agent teams の teammate 全員が最初に読む文書。リードの会話履歴は teammate から見えないため、共通の前提はここに集める。
計画の全文は `~/.claude/plans/marketingdepartment-websiteoperations-p-delightful-giraffe.md`。

## 1. 位置づけ

- SaaS 販売事業（ComeGin、`comegin.com`）の公式 Web サイトのデザイン。
- **Figma は派生物**。デザインの正本はコード側（shadcn/ui ＋ `frontend/verdant-virgo/src/styles/global.css` のトークン）のまま（`docs/RequirementDefinition/BA/02-capability-map.md:106`）。Figma のトークンは global.css の値を写す。新しいトークン（アクセント色など）は `03-handoff.md` で**提案**するだけで、global.css は変えない。
- 実装先は `frontend/verdant-virgo`（Astro ＋ shadcn/ui `base-nova` ＋ Tailwind v4、アイコンは lucide）。

## 2. Figma ファイル

| 項目 | 値 |
|---|---|
| fileKey | `JRYPLER6E0liA7cUurIhSo` |
| UI キット | Obra shadcn/ui kit community edition (2.0.0)。ファイルに追加済み |
| libraryKey | `lk-e3ac865c714852f9edf419a2cb4e1cea023773fbd3778a3013d44398abea8d93dff265fe16e872189c69037ff271ecf6e62dfa061655e2bf746147e49c400dc7` |

`search_design_system` には必ず `includeLibraryKeys` に上の libraryKey を渡す（Material 3・Simple Design System・Apple 系のキットも同じファイルに追加されているため、絞らないと混ざる）。

### ページと担当（書き込みは担当ページのみ）

| ページ | ID | 担当 |
|---|---|---|
| 00 Cover | `0:1` | lead |
| 01 Sitemap | `4:2` | ia-copy |
| 02 Foundations | `4:3` | design-system |
| 03 Components | `4:4` | design-system |
| 10 Top | `4:5` | builder-sales |
| 11 Services | `4:6` | builder-sales |
| 12 Pricing | `4:7` | builder-sales |
| 13 About | `4:8` | builder-site |
| 14 Contact | `4:9` | builder-site |
| 15 Blog | `4:10` | builder-site |
| 16 System | `4:11` | builder-site |

ページの追加・削除・並べ替えは lead だけが行う。

## 3. Phase 0 で確認済みの事実（落とし穴）

- **`search_design_system` は 1 回の呼び出しで 1 クエリしか処理しない**（`queries` に複数入れても 1 件に切り詰められる）。1 語ずつ呼ぶ。
- kit のコンポーネント名は **`<名前> - Nova`**（例 `Button - Nova`、`Icon Button - Nova`、`Navigation Menu Button - Nova`）。コード側の style `base-nova` と対応する。アイコンは `Lucide / <icon-name>` のコンポーネント。
- `Button - Nova`（componentKey `22936fd168a2a7dc4850c1de73260d0c19ab09a4`、120 variants）
  - Variant: `Primary` / `Secondary` / `Outline` / `Ghost` / `Destructive` / `Link`
  - Size: `Default` / `Small` / `Large` / `Extra small`
  - State: `Default` / `Hover & Active` / `Focus` / `Disabled` / `Invalid`
  - その他: `Show left icon` / `Show right icon`（BOOLEAN）、`⮑ Left icon` / `⮑ Right icon`（INSTANCE_SWAP）、`Show spinner`
  - **ラベルは TEXT プロパティとして公開されていない**。`setProperties()` では変えられないので、instance 内の TEXT ノードを探し、フォントを load してから `characters` を書き換える。
- フォント（`listAvailableFontsAsync` で確認済み）
  - `Noto Sans JP`: Thin / Light / DemiLight / Regular / Medium / Bold / Black（**SemiBold は無い**）
  - `Inter`: Regular / Medium / **Semi Bold** / Bold / Extra Bold など（スペース入りの表記）
  - 和文は `Noto Sans JP`、欧文・数字は global.css の `--font-sans` に合わせて `Inter`。この 2 ファミリー以外は使わない。

## 4. 合意済みの要件

| 項目 | 決定 |
|---|---|
| 画面 | Top／Services 一覧／Service 詳細テンプレート（受託開発を例にする）／Pricing／About／Contact（フォーム＋完了）／Blog 一覧／Blog 記事／404／法務（プライバシーポリシー・特定商取引法に基づく表記） |
| 幅 | Desktop 1440px と Mobile 390px の両方。Desktop を作り終えてから Mobile を作る |
| 実績・お客様の声 | 「導入事例（準備中）」のように**明示したダミー枠**。架空の社名・人名・証言・数値は入れない |
| 主 CTA | **無料相談**（会社名・氏名・メール・相談内容） |
| 副 CTA | **環境構築ソースコードの無料 DL**（メールのみ） |
| CTA の規則 | 1 ページに主 CTA は 1 種類。副 CTA は見た目の重みを下げる（`BA/04-business-processes.md`）。ヘッダーの「無料相談」は同じ CTA なので数えない |
| ブランド色 | neutral ＋ アクセント 1 色。design-system が 3 案を出し、**ユーザーが選ぶ**（ゲート G1） |
| フォーム | Mautic の埋め込みではなく、Astro で描く自前フォーム（`DetailedDesign/02-public-path-flows.md`） |
| 画像 | 使わない。「画像（準備中）」と明示した枠で置く |

### 料金（原文。数値・表記を変えない）

| プロダクト | 金額（税別） | 期間 | 備考 |
|---|---|---|---|
| 本プロジェクトの環境構築 | 23,000 円 | 1 日 | ソースコードは無料で配布（副 CTA と連動） |
| 受託開発：バイブコーディングのみ | 50,000 円 | 5 日 | |
| 受託開発：要件定義〜運用保守 | 500,000 円／月 | 60〜90 日 | |
| コンサル | 125,000 円／月 | 4 日／月 | |
| 業務提携（福祉業界のみ） | 要相談 | — | 開発費は基本的に弊社負担 |

料金ページとカードの下に「表示価格はすべて税別」と注記する。

### ユーザー指定のセクション 6 分類

Hero, Banners & Landing Intros／Site Navigation & Headers／Trust & Social Proof／Content & Editorial／Pricing & Conversion／Website Foundations。
各分類の置き場所は計画書の「ページとセクションの構成」を参照。

## 5. 全員が守る不変条件

1. 担当の Figma ページと担当ファイルにだけ書き込む。コンポーネントを変えたいときは design-system に SendMessage で依頼する（instance の detach は禁止）。
2. `use_figma` を呼ぶ前に `figma:figma-use` スキルを読み込む（画面を組むときは `figma:figma-generate-design` も）。`skillNames` を渡す。
3. `use_figma` 1 回につき 1 セクション・論理操作 10 個まで。`setCurrentPageAsync` は 1 回だけ。作成・変更したノード ID はすべて `return` する。
4. 色は kit の変数、文字は文字スタイル、余白と角丸は変数にバインドする。hex のハードコードは使わない（画像枠のプレースホルダだけ例外）。
5. 作業が終わったら、lead に SendMessage で報告する（作ったもの、ノード ID、未解決の点）。
6. git の状態を変えるコマンドは使わない。ビルド・デプロイ・テストはしない。`.env` は読まない。

## 6. 成果物の置き場所

| ファイル | 担当 |
|---|---|
| `00-brief.md`（この文書） | lead |
| `01-content-spec.md` | ia-copy |
| `02-component-map.md` | design-system |
| `03-handoff.md` | lead |
