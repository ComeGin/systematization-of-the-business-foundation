# 00. Web サイト Figma 制作ブリーフ（チーム共通の前提）

Agent teams の teammate 全員が最初に読む文書。リードの会話履歴は teammate から見えないため、共通の前提はここに集める。
計画の全文は `~/.claude/plans/marketingdepartment-websiteoperations-p-delightful-giraffe.md`。

## 0'''. 2026-10-13 の更新（創業計画書の体験の約束とブランドガイドライン v1.4）

**下の 0''・0'・0 節と食い違う場合はこの節が優先する。** 決定と書いた文言の一覧は `01-content-spec.md` の §10.0.4、実装と Figma の差分は `03-handoff.md` の 0' 節。

**正本**（文言はこの節の要約ではなく、正本の該当節を開いて写す）

| 正本 | パス |
|---|---|
| 創業計画書（2026-10-13 改訂。comegin `d3f96ab`） | `~/ComeGin/comegin/documents/創業計画書.md`（第3項「体験の約束」、別紙1 の 4-1・第7章の KPI・第8章「体験の品質基準」、別紙2 の要確認事項 6・10・11） |
| ブランドガイドライン **v1.4** | `~/ComeGin/comegin/documents/ブランドガイドライン.md`（v1.3 からの変更は介護労働実態調査の引用〈令和7年度版。72.2%・53.8%〉だけ） |
| トークン・ロゴ・料金 | **変更なし** |

**ユーザーの決定（2026-10-13）**

| # | 決定 |
|---|---|
| E-1 | トップの「体験の約束」は、1-4c「ComeGin がお約束すること」を変えずに、**新セクション 1-4d を 1-4c の直後に足す**（3 枚） |
| E-2 | 約束 1 の違約金なし・値上げの不適用・引渡し物を、**料金ページの契約の表と各サービスの FAQ「契約の期間と解約」にも書く**。通知期限は `【要記入】`。特商法の表記は変えない |
| E-3 | 別紙1 第8章の品質基準からは「**見積の計算式と当日の概算**」「**研修・手順書は料金に含む**」の 2 つだけを画面に入れる |
| E-4 | **Figma は更新しない**（docs と実装だけ） |

## 0''. 2026-10-08 の更新（創業計画書の GTM とブランドガイドライン v1.3）

**下の 0'・0 節・4 節と食い違う場合はこの節が優先する。** 計画の全文は `docs/superpowers/plans/2026-10-08-website-figma-gl13-gtm.md`（リポジトリ直下から）。**変更点の一覧（A-1〜C-3）、状態フレームの一覧、全員に課す規則はそちらにある。必ず読む。**

**正本**（文言はこの計画書の要約ではなく、正本の該当節を開いて写す）

| 正本 | パス |
|---|---|
| 創業計画書（2026-10-08 改訂） | `~/ComeGin/comegin/documents/創業計画書.md`（第1項 業務理念、第3項 ICP・バリュープロポジション・GTM モーション、別紙1 GTM プレイブック） |
| ブランドガイドライン **v1.3** | `~/ComeGin/comegin/documents/ブランドガイドライン.md`（0 節が指す `/ブランドガイドライン_ComeGin.pdf` 版 1.2 はリポジトリに無い。**こちらを使う**） |
| トークン・ロゴ | `~/ComeGin/comegin/assets/`（**1.2 から変更なし**。`02 Foundations` は触らない） |

**ユーザーの決定（2026-10-08）**

| # | 決定 |
|---|---|
| D-A | **トップ h1 ＝ ミッション**「社内に IT がいなくても、1人分の予算で業務を変える。」。業務理念「社内に IT がいなくても、1人分の予算で実現する業務改善。」は「5つの方法」セクションの見出しへ。**会社概要 h1 ＝ ビジョン**「障がいの有無にかかわらず、働く者に等しく賃金が渡る社会。」 |
| D-B | ソースコードは**公開リポジトリ**に切り替える |
| D-C | ブログは**業界を限らない書き方**（読者はペルソナ C）。IPA の 50.8% を主、介護の 75.4%／49.4% は例として残す。「大阪府」は書かない（D-5 は維持） |
| D-D | GTM から 4 つを画面に入れる: 無料相談＝無料の業務棚卸し／トップに「選ばれる理由」／サービス詳細の進め方を CS の段階に／無料相談フォームに任意 2 項目（従業員数・IT の担当部署） |
| G-A | 副 CTA はメール登録と `cta_type: source_dl` を残し、渡すものを「構築の手順書（公開リポジトリの案内つき）」にする。ソースコードは無料 DL ブロックとフッターの「ソースコードを見る（GitHub）」リンクで見られる。**URL と公開時期は未定 → `【要記入】`** |

**変わったもの（ガイドライン v1.3）**: タグライン「**現場の言葉と、技術の言葉を。**」（旧「福祉の言葉と、技術の言葉を。」は使わない）／ミッションとビジョンの 2 層／ペルソナ A〜D／事業内容の短縮「現場の業務改善 ／ システム開発・IT コンサルティング」／バリュー 6「囲い込まない」／一次資料に「上場企業の開示資料」を追加。**料金の数値は変わっていない。**

**Figma の落とし穴（2026-10-08 に確認）**: トップの「Cookie バナー表示中」「Mobile メニュー表示中」のフレームは、ページ全体の**複製**を内側に持つ（instance ではない）。**本体だけ直すと複製に旧文言が残る**。対象のフレーム ID は計画書の「Figma の現状」の表。

## 0'. 2026-10-04 の更新（販売ターゲットと業務理念）

ユーザーの指示で、次の 4 点を画面と創業計画書（`~/ComeGin/comegin/documents/創業計画書.md`）に反映した。**下の 0 節・4 節と食い違う場合はこの節が優先する。**

| 項目 | 変更前 | 変更後 |
|---|---|---|
| 販売ターゲット | 福祉・介護・教育事業者／福祉・教育分野向け BtoB 企業 | **販売: BtoB・BtoC 企業（業界を限らない）。業務提携: 福祉・介護・教育事業を行う中小企業／社会福祉法人／非営利団体** |
| トップの読者 | 福祉事業所の理事長・管理者 | 業界を限らない企業（社内に IT 人材がいない中小企業） |
| 業務理念（新設） | — | **社内に IT がいなくても、1人分の予算で実現する業務改善。** 実現方法: ①人を雇わない（外部委託もしない） ②福祉と IT の現場経験による再現性の高い開発 ③余剰リソースでの暗号資産採掘への協力を、発注代金に使えるポイントで還元（準備中） ④プロダクトを順次無料で提供 |
| 業務提携の開発費 | 開発費は基本的に ComeGin が負担 | **記述を削除。** レベニューシェアによる回収計画（要相談） |

料金表も 4 節のとおり改訂した（創業計画書の商品構成にそろえた）。

## 0. 2026-10-01 の更新（ブランドガイドラインの適用）

**ブランドガイドライン（`/home/kamegin/ComeGin/systematization-of-the-business-foundation/ブランドガイドライン_ComeGin.pdf` 版 1.2）が見つかり、全面適用することになった。** 下の内容は、それ以前に決めたもの。食い違う場合は**ガイドラインが優先**する。

| 項目 | このブリーフの記述 | 適用後 |
|---|---|---|
| アクセント色 | 緑 emerald #007a55 | **ブランドのネイビー #003577 ／ ブルー #0581DB**（`Assets/tokens/tokens.json` が正本） |
| 欧文フォント | Inter | **Poppins**（和文 Noto Sans JP は変更なし、等幅は JetBrains Mono） |
| ロゴ | 文字ロゴ「ComeGin」 | **`Assets/logo/` の実ロゴ**（Web ヘッダーは `comegin-logo-horizontal.svg`、高さ 32px） |
| 読者 | BtoB 一般 | **トップとブログは福祉・介護・教育事業者**。サービス詳細・料金・会社概要は業界を限らない |
| 言葉づかい | 制限なし | ガイドライン §8 の禁止表現に従う（「弊社」「お気軽に」などは使わない） |
| 数字と単位 | 「23,000 円」 | **「23,000円」**（密着させる） |

- **色・寸法の正本は `Assets/tokens/tokens.json`。** PDF の本文と食い違ったら JSON を正とする（ガイドライン §10.3）
- Web サイト固有の規定はガイドライン §9.5（ヘッダーの高さ、リンク色、ボタンの地と文字、フォーカスリング、ファビコン、OGP）

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

| プロダクト | 金額（税込） | 期間 | 備考 |
|---|---|---|---|
| 本プロジェクトの環境構築 | 23,000円 | 1日 | ソースコードは無料で配布（副 CTA と連動） |
| 受託開発：バイブコーディングのみ | 50,000円 | 7日 | |
| 受託開発：要件定義〜運用保守 | 500,000円／月 | 60〜90日 | 保守のみ 150,000円／月 |
| コンサル | 31,250円／回 | 4時間／回 | 初回相談は無料・4回から |
| 業務提携 | 要相談 | — | レベニューシェアによる回収計画（対象: 福祉・介護・教育事業を行う中小企業／社会福祉法人／非営利団体） |

**2026-10-04 に改訂**（0' 節）。旧表: バイブコーディング 5日、コンサル 125,000円／月・4日／月、業務提携（福祉業界のみ）の備考「開発費は基本的に ComeGin が負担」。

**原文からの変更 2 件**（2026-10-01、ブランドガイドラインに合わせてユーザーが決定）。
1. **数字と単位を密着させる**（「23,000 円」→「23,000円」）。ガイドライン §6.4-4 の規定
2. **「弊社」→「ComeGin」**。ガイドライン §8.3 は「弊社・当社」を禁じている（個人事業であり会社ではないため）

金額・期間の数値そのものは変えない。

料金ページとカードの下に「表示価格はすべて税込」と注記する。

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
| `04-accessibility-spec.md`（2026-10-18 に追加。JIS X 8341-3:2016 の AA。ADR-27） | spec-writer |
| `05-motion-spec.md`（2026-10-18 に追加。React Bits のモーション。ADR-28） | spec-writer（振る舞いの責任者は motion） |
