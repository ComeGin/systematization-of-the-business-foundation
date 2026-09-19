# 02. コンポーネント・トークン対応表（design-system）

builder がこの文書だけで kit の部品・変数・スタイルを import できるようにまとめた対応表。
前提は `00-brief.md`（fileKey `JRYPLER6E0liA7cUurIhSo`、kit = Obra shadcn/ui kit community edition 2.0.0）。

- 調査日: 2026-09-20
- 正本はコード側（`frontend/verdant-virgo/src/styles/global.css`）。Figma の値が global.css とずれている箇所は「差分」として記録し、実装は global.css を正とする。
- **アクセント色はゲート G1 で「案 B 成長の緑」に決定（2026-09-20）。** builder が使うのは採用トークン `accent/base` ほか（§3.4）だけで、`accent/option-a|b|c` は判断の記録として残してあるだけ。
- サイト固有の部品（`SiteHeader` など 25 個）は Figma の `03 Components`（ページ ID `4:4`）にある。一覧は §7。

## 0. 探索の記録（figma-generate-design Step 2 の順序）

| 手順 | 結果 |
|---|---|
| 2a-i Code Connect | **N/A**。リポジトリに `*.figma.ts(x)` / `*.figma.js` は無い（`rg --files` で確認） |
| 2a-ii 既存画面 | **N/A**。全ページが空（children = 0）。ローカル変数・スタイルも 0 件だった |
| 2a-iii `search_design_system` | `includeLibraryKeys` に kit の libraryKey を渡して 1 クエリずつ実行。変数は `figma.teamLibrary.getVariablesInLibraryCollectionAsync()` で全件列挙して値を読んだ |

## 1. 最重要の注意（kit の癖）

1. **kit の文字は Geist フォント**（`font definitions/font-family = Geist`。kit の文字スタイル heading 1〜4 / paragraph * もすべて Geist）。コード側は Inter、和文は Noto Sans JP なので、**kit instance の文字を書き換えたら必ずローカルの文字スタイル（`JP/UI/*` など）を当て直す**（§5 のレシピ）。Geist には和文グリフが無い。
2. instance 内のテキストを触る前に、**そのノードの現在のフォント（Geist Medium など）を load する**。load しないと `unloaded font "Geist Medium"` で落ちる（instance を `appendChild` するだけでも落ちる）。
3. Button・Badge・Label・Accordion などのラベル文字は **TEXT プロパティで公開されていない**もの が多い。表の「文字の変え方」列を見る。`TEXT プロパティ` とあるものだけ `setProperties()` で変えられる。
4. Card・Sheet・Breadcrumb・Pagination・Navigation Menu・Tabs は **SLOT** プロパティ（中身を差し込む枠）でできている。中身を差し替えるのは不安定なので、サイト用の複合部品は design-system が `03 Components` に作る（T4）。builder はそちらを使う。
5. kit の色変数には **Web のコードシンタックスが設定されていない**。Dev Mode で `var(--…)` は出ないので、対応は §3 の表で引く。

## 2. コンポーネント対応表

`種類` が SET のものは `figma.importComponentSetByKeyAsync(key)`、COMPONENT のものは `figma.importComponentByKeyAsync(key)`。
variant の選び方は `set.children.find(c => c.name.includes('Variant=Primary') && c.name.includes('Size=Large') && c.name.includes('State=Default'))`（variant 名は `Size=…, Variant=…, State=…` の順で並ぶ。順序に依存せず `includes` で探す）。

| shadcn/ui 名 | kit コンポーネント名 | componentKey | 種類 | 主要 variant（既定値を先頭） | TEXT プロパティ or 文字の変え方 |
|---|---|---|---|---|---|
| Button | Button - Nova | `22936fd168a2a7dc4850c1de73260d0c19ab09a4` | SET（120） | Size: Default / Small / Large / Extra small。Variant: Primary / Secondary / Outline / Ghost / Destructive / Link。State: Default / Hover & Active / Focus / Disabled / Invalid | **TEXT プロパティなし**。子の TEXT ノード `Label`（Geist Medium 14）を直接書き換え → `JP/UI/Label` を当てる。BOOLEAN `Show left icon#1495:483` / `Show right icon#1495:0` / `Show spinner#6046:3`、INSTANCE_SWAP `⮑ Left icon#1495:322` / `⮑ Right icon#1495:161` |
| Button（アイコンのみ） | Icon Button - Nova | `f0e46dcd729212c589f2963150bc90ebcf9b3d78` | SET（100） | Size: Default / Large / Small / Extra small。Variant: Primary / Secondary / Outline / Ghost / Destructive。State: Button と同じ | 文字なし。INSTANCE_SWAP `Icon#1531:702` にアイコン（§2.1）を入れる。ハンバーガー・閉じるボタンに使う |
| Badge | Badge | `8ed8477b69ce4a43766d80bedf22ee958ab344fa` | SET（10） | Variant: Primary / Secondary / Outline / Ghost / Destructive。State: Default / Focus | **TEXT プロパティ `Label#1530:99`** で変えられる（Geist SemiBold 12）。変えたあと子の TEXT に `JP/UI/Small` を当てる。BOOLEAN `Show left icon#1530:36` / `Show right icon#1530:57`、INSTANCE_SWAP `⮑ Icon left#1530:15` / `⮑ Icon right#1530:78` |
| Card | Card - Nova | `815374b06553050e72c84d634d6bba04dfbc56f8` | SET（3） | Slot count: 1 / 2 / 3 | 文字なし（SLOT 構造）。BOOLEAN `Show header#5841:0` / `Show content#5841:1` / `Show footer#5841:2`。**直接は使わず** 03 Components のカード系部品を使う |
| Input | Input - Nova | `63624c22752ff97231a31a43d96173918f2026b8` | SET（128） | Position: Default / Left / Right / Middle。Size: Regular / Large / Small / Extra small。State: Empty / Placeholder / Value / Focus / Error / Error Focus / Disabled / Error Placeholder | **TEXT プロパティ `Value#1533:897`**（Placeholder 状態でもこの文字が出る）。変えたあと `JP/UI/Text` を当てる。BOOLEAN `Show decoration left#20:38` / `right#20:57` / `Show prepend text#1703:0` / `Show append text#1703:57` / `Show cursor#22:0` |
| Textarea | Textarea - Nova | `9613af4146f90b2ea37903289f11959292ba06e3` | SET（7） | State: Empty / Placeholder / Value / Focus / Error / Error Focus / Disabled | TEXT プロパティなし。Empty 以外の state で子の TEXT を書き換え → `JP/UI/Text`。BOOLEAN `Show resizable#761:0` |
| Select | Select & Combobox - Nova | `717b3328bfea9a4149215afc2e04d483fd3ee277` | SET（72） | Size: Default / Large / Small / Extra small。State: Placeholder / Default / Focus / Error focus / Disabled / Error。Lines: 1 Line / 2 Lines / 2 Lines Alt | TEXT プロパティなし。子の TEXT `Select an item`（Geist Regular 14）を書き換え → `JP/UI/Text`。chevron-down は内包済み |
| Checkbox | Checkbox - Nova | `3877d60af70c87f150a4b5e0413bee439259182c` | SET（11） | Checked?: False / True / Indeterminate。State: Default / Focus / Error Focus / Disabled | 文字なし（16×16 の箱だけ）。ラベルは Label と横並びにする。群なら Checkbox Group - Nova `28ca64d04f840e0bd96d3939fdeab0379b702df0`（SET） |
| Label | Label | `ac0d65e4ae6cdcc6aa33c6f60971535451f8bf8a` | SET（8） | Layout: Inline / Block。State: Default / Error。Weight: Medium / Normal | TEXT プロパティなし。子の TEXT `Label`（Geist Medium 14）を書き換え → `JP/UI/Label` |
| Field（Label＋入力＋説明） | Vertical Field - Nova | `d5d9cc173aaec17abf2cc4ac4634f71598b955d3` | SET（12） | Type: Select / Text Value / Radio / Textarea / Checkbox / Slider。State: Default / Error | 中の `Label`・`Input - Nova` instance を個別に書き換える（Input は `Value#1533:897`）。BOOLEAN `Show error#2301:0`（既定 true。通常は false にする）/ `Show description#5677:5`。横並びは Horizontal Field - Nova `44b789aaa092b63101537af6b1e6feced9127780` |
| Radio Group | Radio Group - Nova | `32551771f0f2bacf3c33c4de2135c34f08b8699a` | SET | （未検査。お問い合わせ種別で使うなら要確認） | 単体は Radio - Nova `a45d0bb461d14b3d2c4f5e576ecf3a534b24b6d6`（SET） |
| Switch | Switch - Nova | `5b3905ad5369947722105d2891c6958a71f3bdcc` | SET | （未検査。Cookie 設定で使う候補） | — |
| Accordion（FAQ） | Line Accordion Trigger - Nova | `07f42fbdf10611c5b0a098a20f323c5595c90f6f` | SET（5） | State: Closed / Open / Focus / Hover / Disabled | TEXT プロパティなし。子の TEXT `Label`（Geist Medium 14）を書き換え → `JP/UI/Label` または `JP/Desktop/Body`。chevron-down 内包 |
| Accordion（枠付き） | Bordered Accordion Trigger - Nova | `1c3cb01534663ef6c0480be896a4071bea00f2c9` | SET（20） | State: Closed / Open / Focus / Hover / Disabled。Position: First / Middle / Last / Single | 同上。BOOLEAN `Show border#1779:0` |
| Accordion の本文 | Bordered Accordion Content - Nova | `cd49022b177463f9629bd182c792510ff3a82591` | SET（2） | Type: Default / End | TEXT プロパティなし。子の TEXT（Geist Regular 14）を書き換え → `JP/UI/Text` か `JP/Desktop/Small` |
| Table（セル） | Basic Table Cell - Nova | `c06ba7e922521c1e0499fb6672bba3a01f2fdd10` | SET（4） | Parity: Odd / Even。Alignment: Right / Left | TEXT プロパティなし。子の TEXT `Value`（Geist Regular 16）→ `JP/Desktop/Body`。料金表・特商法表記の表に使う |
| Table（見出しセル） | Basic Table Header - Nova | `14081f47f709a918dc90ea13f068a2fa0eb1cb80` | SET（1） | Cell Type: Heading | 子の TEXT `Value`（Geist Medium 16）→ `JP/Desktop/H4` 相当なら `JP/UI/Label` |
| Tabs | Tabs (segmented) - Nova | `4989867590990168f52ddbb3429aeb4ca5fe49e1` | SET（3） | Size: Default / Large / Small | SLOT 構造。中の Tab を個別に書き換える |
| Tab（1 個） | Tab (segmented) - Nova | `c5822592fcfa4f37621b1539f24adbc108f3e4f8` | SET（54） | Size: Default / Large / Small。Content: Label / Icon / Icon + Label。State: Inactive / Inactive Hover / Inactive Focus / Active / Active Focus / Disabled | 子の TEXT `Label`（Geist Medium 14）→ `JP/UI/Label`。Blog のカテゴリ切替に使える |
| Breadcrumb | Breadcrumb | `4cdd93918846266b80217cac0836613ca76c058b` | COMPONENT | variant なし（既定 6 階層） | SLOT `Breadcrumb Items#1962:0`。中の `.Breadcrumb item` instance ごとに **TEXT プロパティ `⮑ Label#1354:0`** がある。不要な階層は item と separator の `visible=false` |
| Navigation Menu | Navigation Menu - Nova | `0d689aecfedf03661076c229ca4426710efdef63` | COMPONENT | variant なし | SLOT 構造。中の `Navigation Menu Button - Nova` の TEXT `Nav Label` を書き換える。**SiteHeader は 03 Components の部品を使う** |
| Navigation Menu のボタン | Navigation Menu Button - Nova | `b32f041255d4ec5c033f1b9b62e2b0129650d70b` | SET（3） | State: Default / Hover & Active / Focus | TEXT プロパティなし。子の TEXT `Nav Label`（Geist Medium 14）→ `JP/UI/Label`。BOOLEAN `Show Left Icon#6857:0` / `Show Right Icon#6983:0` |
| Navigation Menu のドロップダウン項目 | Navigation Menu Item - Nova | `895e6cbc269fb65e5e674a5ec0b9b67289498eea` | SET（3） | State: Default / Hover & Active / Focus | 子の TEXT `Nav dropdown item` → `JP/UI/Label`。BOOLEAN `Show Line 2#6856:1` |
| Sheet（モバイルメニュー） | Sheet | `13c5e42af74e0e865d65f0efb946fd825b8a80e0` | SET（2） | Scrollable: False / True | SLOT `Slot#5685:0`。ヘッダー（x ボタン）とフッター（Button 2 個）内包。342×844 |
| Separator | Separator | `9ff39d4c590213c98d528a88a7c66c04b39a2a0b` | SET（6） | Spacing: Regular / None / Spacious。Direction: Default / Vertical | 文字なし。親が auto-layout なら `layoutSizingHorizontal='FILL'` |
| Alert | Alert - Nova | `82c2d62c289d9faf98389822d93d4f92777a3049` | SET（2） | Type: Neutral / Error | **TEXT プロパティ `Title#1530:5` / `⮑  Description#1530:10`**（Description は全角空白ではなく半角スペース 2 個）。BOOLEAN `Show Title#8104:0` / `Show Description#58:0` / `Show Button#279:1`、INSTANCE_SWAP `⮑ Icon#1530:0`。フォームのエラー・送信完了に使う |
| Avatar | Avatar Placeholder | `066a327523a62d1f177d03eac36ec1d154046340` | SET（3） | Size: Default / Small / Large | 子の TEXT `CN`（イニシャル）。画像は使わない方針なのでダミー枠はこれで足りる。画像版は Avatar With Image `e4fe77495007f6e74ff6473fce20de3f316cfc46` |
| Pagination | Pagination | `0e019e06c21983e28498a37d1b7eedbb88d1a19b` | COMPONENT | variant なし | SLOT `Pages#1962:1`。中身は Button - Nova（Previous / Next）と Pagination Number Button。Previous / Next の TEXT `Label` を「前へ」「次へ」に書き換える |
| Pagination の番号 | Pagination Number Button - Nova | `348107600d713aecc0908056240cb75c923cfc20` | SET | Active: On / Off | 子の TEXT `Label`（番号） |
| Skeleton | Skeleton | `c89c129d3e0a0a989d053a792f4b56ecc116fcf9` | COMPONENT | variant なし（320×160） | 文字なし。部品単位は Skeleton / Placeholder Line `5144aeac96c4612e6fe46655ddeb6f342aa0b44a`、Placeholder Object `2f43eadca56d2599f8d52653baadaf9ec0a5eb86`、Placeholder Avatar `b5a40cb0e2bd620596d2111db278efd1df9c9214` |
| Tooltip | Tooltip - Nova | `0977f598a79680b30157a021b01c5285b507e531` | SET（12） | Side: Top / Bottom / Left / Right。Type: Default / Formatted / Shortcut | **TEXT プロパティ `Tooltip text#1586:419`**（Geist Regular 12）→ 変えたあと `JP/UI/Small` |
| Dialog | Dialog - Nova | `6587310bed2366d56b73641c53dda6d2424be9e6` | SET | （未検査） | — |

### 2.1 Lucide アイコン（すべて COMPONENT。`importComponentByKeyAsync`）

Button などの INSTANCE_SWAP には `setProperties({ '⮑ Right icon#1495:161': iconComponent.id })` のように**コンポーネントの node ID** を渡す。

| アイコン | kit 名 | componentKey |
|---|---|---|
| menu（ハンバーガー） | Lucide / menu | `c5245397f5e1244def01370c3908607b669f7284` |
| x（閉じる） | Lucide / x | `04757da4546e3b11401d432f72aff714c35c6db6` |
| check | Lucide / check | `5cc213bcdc1c63e896d0a4dea53119b090a42cf2` |
| circle-check（送信完了） | Lucide / circle-check | `7c9f8a5c2d9b7f2788fe53998afdb43ef46f6cb5` |
| arrow-right | Lucide / arrow-right | `4b05c2dd535328a55b83f5421d48230d2c713b3c` |
| chevron-right | Lucide / chevron-right | `52c0cfe0407a9516bbd2a7464137c37bdc11979c` |
| chevron-down | Lucide / chevron-down | `be8e1894c9a17c0c4d55ade08428d239a65995ef` |
| download（副 CTA） | Lucide / download | `d3a2da3c2d0776ada5ecab33339acdb331089fc5` |
| message-circle（主 CTA） | Lucide / message-circle | `36c14d6b319a02109f9f5019e67cfb2b77177983` |
| mail | Lucide / mail | `a91f315360ff05be1f6222f6e65c8bb21fe570b1` |
| external-link | Lucide / external-link | `5bec4b74091d01515bc6ffd02ed8e06fa167f47c` |
| info | Lucide / info | `2fdec0e879deb0edabc1998ac66293c43c42b4ab` |

ほかのアイコンは `search_design_system` で `Lucide / <lucide の名前>` を 1 語ずつ検索すれば出る。

## 3. 変数（kit）と global.css の対応

`figma.variables.importVariableByKeyAsync(key)` で import し、色は `figma.variables.setBoundVariableForPaint(paint, 'color', v)`、余白・角丸は `node.setBoundVariable('paddingLeft' | 'itemSpacing' | 'topLeftRadius' …, v)` でバインドする。

### 3.1 色（コレクション `shadcn colors`、モード `shadcn` = Light / `shadcn-dark`）

本サイトは Light のみ。kit の値は Tailwind v3 系の hex で、global.css（Tailwind v4 の oklch）と一部ずれる。**差分はどれも見た目ではほぼ判別できない量なので、Figma では kit 変数をそのまま使う**（ローカルに同名の上書き変数は作らない＝色の出どころを 1 つに保つ）。実装は global.css が正。

| kit 変数名 | key | global.css | kit の値 | global.css の値 | 判定 | scope |
|---|---|---|---|---|---|---|
| shadcn colors/general/background | `2c49e73c336348efc4bbd8b2d0c8da57c2fba610` | `--background` | #ffffff | oklch(1 0 0) = #ffffff | 一致 | FRAME_FILL, SHAPE_FILL |
| shadcn colors/general/foreground | `c105bb37aa8ea5d7a0410852d12219e0b35091c5` | `--foreground` | #000000 | oklch(0.145 0 0) = #0a0a0a | 差分 | SHAPE_FILL, TEXT_FILL, STROKE_COLOR |
| shadcn colors/general/card | `30e0495632a74a5bb54597d7f2badfd0a0f560c3` | `--card` | #ffffff | #ffffff | 一致 | FRAME_FILL, SHAPE_FILL |
| shadcn colors/general/card foreground | `b1e7ef8b765a0db60c55a9d89cdd0190387bff74` | `--card-foreground` | #0a0a0a | #0a0a0a | 一致 | TEXT_FILL ほか |
| shadcn colors/general/popover | `f796f5e0dba3214f1c756f87b1615209fb648c49` | `--popover` | #ffffff | #ffffff | 一致 | FRAME_FILL, SHAPE_FILL |
| shadcn colors/general/popover foreground | `273a71c6b87df91216626bd5eb780dbe9fdddd9a` | `--popover-foreground` | #0a0a0a | #0a0a0a | 一致 | TEXT_FILL ほか |
| shadcn colors/general/primary | `0d0ac0d1c699da0616b26e4c9e92270a05984840` | `--primary` | #171717 | oklch(0.205 0 0) = #171717 | 一致 | FRAME_FILL, SHAPE_FILL, STROKE_COLOR |
| shadcn colors/general/primary foreground | `055bb69546ceeb025c7c85b78c2c8dd42e28e3ee` | `--primary-foreground` | #ffffff | oklch(0.985 0 0) = #fafafa | 差分 | TEXT_FILL ほか |
| shadcn colors/general/secondary | `f4b49be3473d33bbdbe4e4a9d8ef820c3a785f66` | `--secondary` | #f5f5f5 | oklch(0.97 0 0) = #f5f5f5 | 一致 | FRAME_FILL, SHAPE_FILL |
| shadcn colors/general/secondary foreground | `da5b3990550ef95a2bbcc83c19fb507c07545a65` | `--secondary-foreground` | #171717 | #171717 | 一致 | TEXT_FILL ほか |
| shadcn colors/general/muted | `2d143e23ee25bc63b3d732833664c06cb9bf73bd` | `--muted` | #f5f5f5 | #f5f5f5 | 一致 | FRAME_FILL, SHAPE_FILL |
| shadcn colors/general/muted foreground | `d3f6f425f4d757939c04b4b83b2f89faa7d72bf9` | `--muted-foreground` | #737373 | oklch(0.556 0 0) = #737373 | 一致 | TEXT_FILL ほか |
| shadcn colors/general/accent | `69b1d746c8b0a5fc63353dff4dd9f09507706b18` | `--accent` | #f5f5f5 | #f5f5f5 | 一致 | FRAME_FILL, SHAPE_FILL |
| shadcn colors/general/accent foreground | `2beb6dd2b21973434ff5505a2eae719dd089cbb1` | `--accent-foreground` | #000000（foreground への alias） | oklch(0.205 0 0) = #171717 | 差分 | TEXT_FILL ほか |
| shadcn colors/general/destructive | `aaa342e351b7a37b7010e0f0e97d2c86b4137cfb` | `--destructive` | #dc2626（v3 red-600） | oklch(0.577 0.245 27.325) = #e7000b（v4 red-600） | 差分 | FRAME_FILL, SHAPE_FILL, TEXT_FILL, STROKE_COLOR |
| shadcn colors/general/border | `c8b03ca6be23e363315d17fcfc24e2e9f73a83b9` | `--border` | #e5e5e5 | oklch(0.922 0 0) = #e5e5e5 | 一致 | FRAME_FILL, SHAPE_FILL, STROKE_COLOR |
| shadcn colors/general/input | `4a865a59138f7d37866829e0fb43e3e72fc97e0d` | `--input` | #e5e5e5 | #e5e5e5 | 一致 | FRAME_FILL, SHAPE_FILL, STROKE_COLOR |
| shadcn colors/focus/ring | `8e0398a9769fd39e450f077f974bf979ef34aac8` | `--ring` | #d4d4d4 | oklch(0.708 0 0) = #a1a1a1 | 差分 | STROKE_COLOR, EFFECT_COLOR |
| shadcn colors/focus/ring error | `928fe06e5bb1fbe419e832dd35387dbb2bda477c` | （global.css に無い） | #fecaca | — | kit のみ | ALL_SCOPES |
| shadcn colors/sidebar/sidebar | `f556ed6664001a45150e8837e296c1e809677e2a` | `--sidebar` | #fafafa | #fafafa | 一致 | サイトでは使わない |
| shadcn colors/sidebar/sidebar foreground | `6c9f361ccbe2c1c593071298e86568f18361b5b7` | `--sidebar-foreground` | #404040 | #0a0a0a | 差分 | 同上 |
| shadcn colors/sidebar/sidebar primary | `b7c0fac6a83a9fa8a48e4e6ebe2edb2051a5f956` | `--sidebar-primary` | #404040 | #171717 | 差分 | 同上 |
| chart colors/chart 1〜5（コレクション `theme`） | `dfce75e3…` ほか | `--chart-1〜5` | 青系（#93c5fd〜#1e40af） | 灰系（0.87〜0.269） | 差分 | サイトでは使わない |

補足: kit にはこのほか `alpha/black|white/*`（透過色 60 個）、`theme/neutrals/0〜1000`（primitive、scope が ALL_SCOPES なので直接バインドしない）、`raw tailwind colors`（`tw-raw/*`、Tailwind **v3** の hex。v4 とは値が違うので使わない）がある。

### 3.2 余白（コレクション `spacing`、scope = WIDTH_HEIGHT, GAP。auto-layout の padding にもバインドできる）

| kit 変数 | key | 値 | Tailwind | サイトでの主な用途 |
|---|---|---|---|---|
| 3xs | `cefc542084e1d2a5538e13eb4a397e6a20045cf1` | 2 | 0.5 | — |
| 2xs | `f99bf1b6b8b3bcc2182e6f9fee7c357a896d7906` | 4 | 1 | ラベルとヒントの間 |
| xs | `b2152ca60b8d44688cec2c6f39473eb18b9fa895` | 8 | 2 | アイコンと文字、ボタン同士 |
| sm | `011fc0693adf6df9065e74503f0f61e2961ce438` | 12 | 3 | 見出しと本文 |
| md | `aa9c3236e382fbd042d14a6f3cde163beed13457` | 16 | 4 | Mobile の左右余白、フォーム項目間 |
| lg | `640e64b418a1927c6514cf87e64d26db2837dcba` | 20 | 5 | — |
| xl | `080e09f34b6063a977300f31759441ad7f8b1368` | 24 | 6 | カード内余白、カード間（Mobile） |
| 2xl | `d5476d04eb9986fa7c469e32c964891eefce8119` | 32 | 8 | カード間（Desktop）、セクション見出しと中身 |
| 3xl | `10d4271c567a2fb37e5e7800904b7db8b2dd527c` | 40 | 10 | — |
| 4xl | `3a08d989979509d14e61d86912330a69b241111f` | 48 | 12 | セクション見出しと中身（Desktop） |
| 5xl | `0deb18e6582929f63bfa04bac5cfb81944463790` | 64 | 16 | **セクション上下（Mobile）**、ヘッダー高さ |
| 6xl | `5e8adfd2894cae1bf9bd28fa2855350b2a7ac02b` | 80 | 20 | — |
| 7xl | `1b630db3e9ece1bbd4e5ae17665c5ff7b99c8e89` | 96 | 24 | **セクション上下（Desktop）** |
| 8xl | `c7498a5a5b84c3a7ff5541cc6d9a5709d4690634` | 112 | 28 | — |
| 9xl | `6cc8568b375bf2284e1281f5198f55511930ebca` | 128 | 32 | Hero 上下 |
| 10xl | `a26edda51d8b11bd51964adf4ce314c2cf170fca` | 144 | 36 | **Desktop の左右余白**（(1440 − 1152) / 2） |

`out-of-scale/*`（3, 5, 5.5, 6, 7, 7.5, 8.5, 9, 9.5, 10, 14, 15.5）は kit 内部の調整用。サイトでは使わない。

### 3.3 角丸（コレクション `border radii`、scope = CORNER_RADIUS）

| kit 変数 | key | kit 値 | global.css | 判定 |
|---|---|---|---|---|
| radius-none | `2bd3fea4512023fa0a8789033968e3fe7faaa8ed` | 0 | — | 一致 |
| radius-sm | `35f36386926923d642d0f4faea1aa1076f3ecd28` | 6 | `--radius-sm` = radius × 0.6 = 6 | 一致 |
| radius-md | `459a5bf13640cd654f0a3238458f4c49d9c0a3b6` | 8 | `--radius-md` = × 0.8 = 8 | 一致 |
| radius-lg (radius) | `8c263013dcc8ca6a91590788123ab567af06e020` | 10 | `--radius-lg` = `--radius` = 0.625rem = 10 | 一致 |
| radius-xl | `52fdad8de64b36a87c6f0946fae479ed39c260a1` | 14 | `--radius-xl` = × 1.4 = 14 | 一致 |
| radius-2xl | `bb6611f41197ee115eb44388d634908f8066eca5` | 16 | `--radius-2xl` = × 1.8 = **18** | 差分 |
| radius-3xl | `e51e362602fb32bc3d83a6c35f7acf82ea5a64fe` | 22 | × 2.2 = 22 | 一致 |
| radius-4xl | `3b673b58ac23fe5e5a319e3e2ecf41f8ac5c45a4` | 26 | × 2.6 = 26 | 一致 |
| radius-full | `f23e0afbe4aa01c7f1e5ca7c87f5f857bea076e6` | 999 | `rounded-full` | 一致 |

目安: ボタン・入力は kit の既定のまま、カードは radius-xl、大きな面（CTA 帯など）は radius-2xl。

### 3.4 ローカル変数（design-system が追加。同じファイル内なので import 不要）

`(await figma.variables.getLocalVariablesAsync()).find(v => v.name === '…')` で取る。

| コレクション | 変数名 | ID | 値 | scope | WEB コードシンタックス |
|---|---|---|---|---|---|
| ComeGin / primitives（Value） | blue/50, blue/700, blue/800 | `VariableID:8:3` / `8:4` / `8:5` | #eff6ff / #1447e6 / #193cb8 | なし（非表示） | `var(--color-blue-50)` など |
| 同上 | emerald/50, emerald/700, emerald/800 | `8:6` / `8:7` / `8:8` | #ecfdf5 / #007a55 / #006045 | なし | `var(--color-emerald-*)` |
| 同上 | orange/50, orange/700, orange/800 | `8:9` / `8:10` / `8:11` | #fff7ed / #ca3500 / #9f2d00 | なし | `var(--color-orange-*)` |
| ComeGin / tokens（Light） | **accent/base**（採用） | `VariableID:19:476`（key `d6ab35758b26c47ceab5c085e2645d6c4d6f2bcd`） | emerald-700 #007a55（accent/option-b/base への alias） | 塗り・線・文字 | `var(--brand)` |
| 同上 | **accent/hover** | `19:477`（key `bfd383d805a6285812656dcfe7eb9279f863f390`） | emerald-800 #006045 | 塗り・線・文字 | `var(--brand-hover)` |
| 同上 | **accent/foreground** | `19:478`（key `6e54488576047037fbdbc3abf8943920bcc1e2e0`） | kit primary foreground #ffffff | 文字 | `var(--brand-foreground)` |
| 同上 | **accent/subtle** | `19:479`（key `e5ae69e4c1dc81386e377b70c594009d56813989`） | emerald-50 #ecfdf5 | 塗り | `var(--brand-subtle)` |
| 同上 | **accent/subtle-foreground** | `19:480`（key `4f532580b8b6eb4ac4265355add5ca4b53d6265d`） | emerald-800 #006045 | 文字・線 | `var(--brand-subtle-foreground)` |
| 同上 | accent/option-a/{base, hover, foreground, subtle, subtle-foreground} | `8:13`〜`8:17` | blue 系（**不採用**。判断の記録） | 同上 | 同上 |
| 同上 | accent/option-b/{…} | `8:18`〜`8:22` | emerald 系（**採用**。accent/* が参照する） | 同上 | 同上 |
| 同上 | accent/option-c/{…} | `8:23`〜`8:27` | orange 系（**不採用**） | 同上 | 同上 |
| 同上 | layout/container-max | `VariableID:8:28` | 1152 | WIDTH_HEIGHT | `var(--container-6xl)` |

### 3.5 面と文字の規則（コントラスト。01-content-spec 0.1 と同じ）

**読ませる文字（本文・補足・エラー文・リンク）は白い面（`card` / `background`）に載せる。** 色トークンの値は Figma 側で変えない（正本は global.css）。面の選び方だけで AA を満たす。

| 組み合わせ | 比 | 判定 |
|---|---|---|
| `muted foreground` #737373 × `muted` #f5f5f5 | 4.35 : 1 | **不可**（通常サイズは 4.5 : 1 が必要） |
| `muted foreground` #737373 × 白 #ffffff | 4.74 : 1 | 可 |
| `destructive` #dc2626 × `muted` #f5f5f5 | 4.43 : 1 | **不可** |
| `destructive` #dc2626 × 白 #ffffff | 4.83 : 1 | 可 |
| `foreground` #000000 × `muted` #f5f5f5 | 18.1 : 1 | 可（muted に文字を載せるならこれだけ） |
| `accent/base` #007a55 × 白 #ffffff | 5.37 : 1 | 可（テキストリンク） |
| `accent/base` #007a55 × `muted` #f5f5f5 | 4.88 : 1 | 可 |

反転面（`CTABanner` の Standard）の実測値: 見出し・本文とも `primary foreground` #ffffff × `primary` #171717 = **17.93 : 1**、ボタンのラベル #ffffff × `accent/base` #007a55 = **5.36 : 1**、ボタンの面 × 反転面 = **3.34 : 1**（非テキストの基準 3.0 を満たす）。**反転面に `muted foreground` 相当は置かない**（#737373 × #171717 = 3.5 : 1 で足りない）。

muted の面を使ってよいのは、文字を載せない装飾の帯（`AnnouncementBanner` の帯）と、`foreground` の文字だけを載せる面（画像枠の「画像（準備中）」など）。面を分けたいだけのときは**白＋`border`** にする。

**白い面のトークンの使い分け**（`card` と `background` はどちらも #ffffff だが、役割で固定する。将来どちらかの値が変わってもずれないようにするため）:

| トークン | 使う面 | 部品 |
|---|---|---|
| `background` | ページの地の面 | `SiteHeader`・`SiteFooter`・`PageIntro` |
| `card` | 枠線や影で浮かせる面（カード・パネル・ブロック・Sheet・バナー） | `ServiceCard`・`PricingCard`・`StatCard`・`TestimonialCard`・`BlogCard`・`IconCard`・`CookieBanner`・`SourceDownloadBlock`（控えめ版・強調版とも）・`CTABanner` の Inline・`MobileMenuSheet` のパネル |
| `muted` | 文字を載せない装飾の面 | `ImagePlaceholder`・`ChatWidgetPlaceholder`・`AnnouncementBanner` |
| `primary` | 反転面 | `CTABanner` の Standard |

`SourceDownloadBlock` の控えめ版と強調版の違いは、**見出しの段階（H3 / H2）・影（なし / shadow-md）・ボタン（kit Secondary / CTAButton＝accent）**の 3 つ。面の色では区別しない（01-content-spec 0.1）。

**builder が使うのは `accent/base` など採用トークンの 5 個だけ**（`accent/option-*` は直接使わない）。同じファイル内なので import は不要で、`(await figma.variables.getLocalVariablesAsync()).find(v => v.name === 'accent/base')` で取れる。

**アクセント色を使ってよい場所**: 主 CTA のボタン（= `CTAButton`）、テキストリンク、強調バッジ、強調したいアイコン。それ以外のボタン（Outline・Ghost・Secondary・Link 以外の用途）と、セクションの背景・枠線には使わない。

`--brand*` は global.css にまだ無い（`--accent` は neutral の別トークン）。実装への提案は `03-handoff.md` に載せる。

## 4. 文字スタイル・エフェクトスタイル

### 4.1 ローカル文字スタイル（design-system が追加。和欧混植）

和文は Noto Sans JP、欧文・数字は Inter。Figma の 1 スタイルは 1 書体しか持てないので、**`JP/…` と `Latin/…` を組で使う**（テキスト全体に JP、半角英数字の連続部分に Latin を範囲適用。§5 のレシピ）。
取り方: `(await figma.getLocalTextStylesAsync()).find(s => s.name === 'JP/Desktop/H1')`。

| 段階 | Desktop（サイズ / 行間） | Mobile | ウェイト | 和文の字間 | 欧文の字間 | Tailwind（D / M） |
|---|---|---|---|---|---|---|
| Display | 60 / 130% | 36 / 130% | Bold | 2% | −2% | text-6xl / text-4xl |
| H1 | 48 / 140% | 30 / 140% | Bold | 2% | −1.5% | text-5xl / text-3xl |
| H2 | 36 / 140% | 24 / 140% | Bold | 2% | −1% | text-4xl / text-2xl |
| H3 | 24 / 140% | 20 / 140% | Bold | 2% | −0.5% | text-2xl / text-xl |
| H4 | 20 / 150% | 18 / 150% | Medium | 2% | 0 | text-xl / text-lg |
| Body L | 18 / 180% | 16 / 180% | Regular | 3% | 0 | text-lg / text-base |
| Body | 16 / 175% | 16 / 175% | Regular | 3% | 0 | text-base |
| Small | 14 / 170% | 14 / 170% | Regular | 3% | 0 | text-sm |
| Caption | 12 / 160% | 12 / 160% | Regular | 4% | 0 | text-xs |

スタイル名は `JP/Desktop/<段階>`・`JP/Mobile/<段階>`・`Latin/Desktop/<段階>`・`Latin/Mobile/<段階>`（段階名は表の通り。`Body L` は空白入り）。

**`Body`・`Small`・`Caption` の 3 段階は Desktop と Mobile で値が同じ**（16/175%/3%、14/170%/3%、12/160%/4%）。そのため Device variant を持たない部品（`ServiceCard`・`Steps` の項目・`FAQItem` など）は `JP/Desktop/*` を Mobile の画面でもそのまま使っている。**見た目は変わらない**ので直す必要はない。値が違うのは `Display`・`H1`〜`H4`・`Body L` なので、こちらは Device に合わせて必ず使い分ける。

kit instance の文字を置き換えるための UI 用（行間は px 固定、字間 0）:

| スタイル | 内容 | 置き換える kit の文字 |
|---|---|---|
| `JP/UI/Label` + `Latin/UI/Label` | Medium 14 / 20px | Button・Label・Nav・Tab・Accordion Trigger（Geist Medium 14） |
| `JP/UI/Text` + `Latin/UI/Text` | Regular 14 / 20px | Input・Select・Textarea の値、Breadcrumb、Accordion 本文（Geist Regular 14） |
| `JP/UI/Small` + `Latin/UI/Small` | Medium 12 / 16px | Badge・Tooltip（Geist 12） |
| `JP/UI/Logo` + `Latin/UI/Logo` | Bold 20 / 28px | 文字ロゴ「ComeGin」（ヘッダー・フッター。ロゴ画像が決まるまで） |
| `JP/UI/Card Title` + `Latin/UI/Card Title` | Bold 20 / 140% | カードの見出し（h3）。Desktop / Mobile 共通 |
| `JP/UI/Price` + `Latin/UI/Price` | Bold 32 / 130% | 料金カードの金額、実績数値の「—」 |

kit の文字スタイル（`heading 1〜4`、`paragraph */normal|medium|bold`。すべて Geist）は**使わない**。

### 4.2 エフェクトスタイル（kit。`figma.importStyleByKeyAsync(key)` → `await node.setEffectStyleIdAsync(style.id)`）

| kit スタイル | key | 中身 | 用途の目安 |
|---|---|---|---|
| shadow-2xs | `55f35962c3c43b28bdd0c918170dfcbd977e4aad` | 0 1 0 / 5% | — |
| shadow-xs | `519909e7aea01e34566f191de3ce65ed070c3470` | 0 1 2 / 5% | カード |
| shadow-sm | `9d7913ec91674f1b5ae9bcd7d8bee351667f9d14` | 0 1 3 + 0 1 2 −1 / 10% | 料金カードの強調 |
| shadow-md | `35f2ff7e3704e0793f595df7a61f4a134ab65d14` | 0 4 6 −1 + 0 2 4 −2 / 10% | 固定ヘッダー、Cookie バナー |
| shadow-lg | `59ac7928529c6ac89219ed3d5fd45c8a2a427ea7` | 0 10 15 −3 + 0 4 6 −4 / 10% | Sheet・ダイアログ |
| shadow-xl | `f59eb68c35c9d8f225bd160c2027e508cb7c6077` | 0 20 25 −5 + 0 8 10 −6 / 10% | — |
| shadow-2xl | `94926c1d5bac34915e0c0e3cee59ad816e8e909b` | 0 25 50 −12 / 25% | — |

## 5. レシピ（コピーして使う）

### 5.1 フォントの load（毎回スクリプトの先頭で）

```js
await Promise.all([
  ['Noto Sans JP','Regular'],['Noto Sans JP','Medium'],['Noto Sans JP','Bold'],
  ['Inter','Regular'],['Inter','Medium'],['Inter','Bold'],
  ['Geist','Regular'],['Geist','Medium'],['Geist','SemiBold'], // kit instance を置く・書き換えるとき
].map(([family, style]) => figma.loadFontAsync({ family, style })));
```

Noto Sans JP に SemiBold は無い。Inter の中間ウェイトは `Semi Bold`（空白入り）。

### 5.2 和欧混植でテキストを作る / 既存テキストに当てる

```js
const S = Object.fromEntries((await figma.getLocalTextStylesAsync()).map(s => [s.name, s]));
// style は 'Desktop/H1'・'Mobile/Body'・'UI/Label' など（JP/ と Latin/ を除いた部分）
async function applyMixed(t, style) {
  await t.setTextStyleIdAsync(S['JP/' + style].id);
  const re = /[\x21-\x7E]+(?: [\x21-\x7E]+)*/g; // 半角英数字・記号の連続（間の半角スペース 1 個は含める）
  let m;
  while ((m = re.exec(t.characters))) {
    await t.setRangeTextStyleIdAsync(m.index, m.index + m[0].length, S['Latin/' + style].id);
  }
}
const t = figma.createText();
t.characters = '要件定義〜運用保守 500,000 円／月';
await applyMixed(t, 'Desktop/H3');
t.fills = [figma.variables.setBoundVariableForPaint(
  { type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color',
  await figma.variables.importVariableByKeyAsync('c105bb37aa8ea5d7a0410852d12219e0b35091c5'), // foreground
)];
// 折り返す段落: 親（auto-layout）に append してから
// t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL';
```

### 5.3 kit instance の文字を書き換える（Button の例。TEXT プロパティが無いもの）

```js
const set = await figma.importComponentSetByKeyAsync('22936fd168a2a7dc4850c1de73260d0c19ab09a4');
const v = set.children.find(c => ['Size=Large', 'Variant=Primary', 'State=Default'].every(q => c.name.includes(q)));
const btn = v.createInstance();
parent.appendChild(btn);                        // Geist を load 済みであること
const label = btn.findOne(n => n.type === 'TEXT' && n.name === 'Label');
label.characters = '無料相談する';
await applyMixed(label, 'UI/Label');            // Geist → Noto Sans JP / Inter に置き換え
```

TEXT プロパティがあるもの（Badge `Label#1530:99`、Input `Value#1533:897`、Alert `Title#1530:5`、Tooltip `Tooltip text#1586:419`、Breadcrumb item `⮑ Label#1354:0`）は `inst.setProperties({ 'Label#1530:99': '新着' })` のあと、同じく子の TEXT に `applyMixed()` を当てる。

### 5.4 色・余白・角丸のバインド

```js
const V = k => figma.variables.importVariableByKeyAsync(k);
const paint = v => figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', v);
const frame = figma.createAutoLayout('VERTICAL');
frame.fills = [paint(await V('30e0495632a74a5bb54597d7f2badfd0a0f560c3'))];       // card
frame.strokes = [paint(await V('c8b03ca6be23e363315d17fcfc24e2e9f73a83b9'))];     // border
frame.strokeWeight = 1;
const xl = await V('080e09f34b6063a977300f31759441ad7f8b1368');                  // spacing xl = 24
for (const p of ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'itemSpacing']) frame.setBoundVariable(p, xl);
const r = await V('52fdad8de64b36a87c6f0946fae479ed39c260a1');                   // radius-xl = 14
for (const c of ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius']) frame.setBoundVariable(c, r);
```

**`figma.createAutoLayout()` は既定で白（未バインド）の塗りを持つ。** 背景の要らないレイアウト用フレームは `frame.fills = []` にする（未バインドの hex が残るのを防ぐ）。

## 6. サイト部品（`03 Components`。design-system が作った 26 個）

すべて Figma ページ `03 Components`（ID `4:4`）にある。**同じファイル内なので import は不要**で、
`const set = await figma.getNodeByIdAsync('<ノード ID>')` → variant を選んで `createInstance()`、
または `figma.importComponentSetByKeyAsync('<key>')`（別ファイルから使うとき）で取れる。

variant の選び方: `set.children.find(c => ['Device=Desktop','CTA=Primary'].every(q => c.name.includes(q)))`。
文言の差し替え: `inst.setProperties({ 'Title#29:0': 'サービス：事業経営基盤の構築から運用まで' })`。

| 部品 | ノード ID | key | 種類 | 主要 variant | TEXT / BOOLEAN プロパティ |
|---|---|---|---|---|---|
| CTAButton | `19:800` | `fac92b941ede8d7f133a3096fec13badc8be01b9` | SET（18） | Size=Small/Default/Large、State=Default/Hover/Loading、Width=Hug/Full | なし（ラベルは中の TEXT「Label」を直接書き換える）。アイコンは exposed instance「Button」 |
| SiteHeader | `30:854` | `fb8fa1c8789cb08207f68abb0178e7a9779d2637` | SET（4） | Device=Desktop/Mobile、CTA=Primary/Outline | `Logo#30:0`。現在地は exposed instance「Nav / 料金」などに `setProperties({State:'Hover & Active'})` |
| MobileMenuSheet | `31:669` | `0acda40d8aac93e5e5a5875eede985f32613da72` | SET（2） | CTA=Primary/Outline | なし（リンク文言は中の TEXT を直接書き換える） |
| SiteFooter | `32:683` | `2448b08a1d851e44653b91389dc4f33923f8d952` | SET（2） | Device=Desktop/Mobile | `Logo#32:6`・`Description#32:0`・`Copyright#32:3` |
| AnnouncementBanner | `28:509` | `108b0cdb31df7b5463ea1ac896b61e46a65cbb00` | SET（2） | Device=Desktop/Mobile | `Text#28:0`（Desktop）・`Short text#28:3`（Mobile）。Badge は exposed instance |
| PageIntro | `29:712` | `b54aee6e44f805dd0e07c71b1c131f43a374883d` | SET（2） | Device=Desktop/Mobile | `Title#29:0`・`Body#29:3`／`Show badge#29:6`・`Show button#29:9`・`Show image#29:12`・`Show breadcrumb#29:15` |
| SectionHeading | `21:383` | `cce2962d041362cd6dbc28933147ab85c30361d0` | SET（4） | Device=Desktop/Mobile、Align=Left/Center | `Title#21:19`・`Lead#21:24`／`Show lead#21:29`・`Show badge#21:34` |
| ServiceCard | `23:476` | `0da4b8d729132de0de28942d5f57a92cdd60a139` | SET（2） | Price rows=1/2 | `Title#23:0`・`Body#23:3`・`Product 1#23:6`・`Price 1#23:9`・`Period 1#23:12`・`Product 2#23:15`・`Price 2#23:18`・`Period 2#23:21`・`Note#23:24`／`Show badge#23:27`・`Show note#23:30`・`Show sub link#23:33` |
| PricingCard | `24:443` | `39cd29f7f8b8a9d0aadd41f94f3571f7c704eb7b` | COMPONENT | — | `Product#24:0`・`Description#24:1`・`Price#24:2`・`Period#24:3`・`Note#24:4`／`Show badge#24:5`・`Show description#24:6`・`Show note#24:7`・`Show sub link#24:8`。**Badge は見出しと同じ行。幅が足りないと自動で上の行に回る**（見出しの最小幅 260px。2 列 564 は同じ行、3 列 368 と Mobile 358 は上の行） |
| StepItem | `22:240` | `ac50d7daa7aed9e4c65f948b415784e32b8de245` | SET（2） | Layout=Stacked/Inline | `Number#22:0`・`Title#22:3`・`Body#22:6` |
| Steps | `22:499` | `5c3b919a167c84b5ce50c70bbbc1df69c892a70f` | SET（6） | Direction=Horizontal/Vertical、Count=4/5/6 | なし（中の「Step 1」… が StepItem の exposed instance）。**Desktop はすべて折り返す**（Count=4 は 2＋2 で 1 項目 544px、Count=5 は 3＋2・Count=6 は 3＋3 で 1 項目 346px。折り返し位置の矢印は非表示）。01-content-spec 0.3 の「1 列に 1 行 20 字以上」を満たす |
| FAQItem | `39:2162` | `aa446a2066498ef3f9b4f756d33837ed3841098c` | SET（2） | State=Closed/Open | `Answer#39:0`（質問文は中の「Question」→ TEXT「Label」を直接書き換える）／`Show marker#50:0`（回答に【要記入】【要確認】がある項目に「要確認」バッジを出す。文言は exposed instance の Marker） |
| CTABanner | `27:502` | `aa958d4c3db370c83b5bc0b1e032947876a1d9fd` | SET（4） | Type=Standard/Inline、Device=Desktop/Mobile | `Title#27:0`・`Body#27:5`／`Show body#27:10` |
| SourceDownloadBlock | `35:1578` | `8337e7fd91811468a95143ad7060f47c640fcf7a` | SET（20） | Emphasis=Subtle/Strong、State=Default/Error/Loading/Failed/Success、Device=Desktop/Mobile | `Title#35:0`・`Body#35:21`（フォーム部分は中の FormField / ConsentCheckbox / CheckboxField の instance で変える） |
| ContactForm | `36:2481` | `fb2b148716e5a0290a339aa794b5606dce646904` | SET（7） | State=Default/Error/Loading/Failed/Duplicate（Desktop）、Device=Desktop/Mobile（Mobile は Default と Error のみ） | なし（各項目は FormField の instance）。Desktop は**中身に最大幅 640・左揃え**（カラム幅 736 のまま、送信ボタンが帯のように伸びないようにするため） |
| FormField | `20:2828` | `886f9ad9fbb4623284ac08fee2b1f9785352a5f3` | SET（9） | Type=Input/Textarea/Name、State=Default/Error/Disabled | `Label#20:0`・`Helper#20:10`・`Error#20:20`／`Show required#20:30`。入力値は中の Input の exposed instance |
| ConsentCheckbox | `21:299` | `11f35dd56c6accf911d33f4bdeb04aedb6152ea8` | SET（3） | State=Default/Checked/Error | `Link#21:0`・`Label#21:4`・`Error#21:8`／`Show required#21:12` |
| CheckboxField | `21:334` | `76203a7407c60ea369248a1caa9e80364a16dae7` | SET（2） | State=Default/Checked | `Label#21:16` |
| IconCard | `42:2936` | `8e25a72dc952e791997a95bab64263fb783d3b09` | SET（2） | Device=Desktop/Mobile | `Title#42:0`・`Body#42:3`・`Link#42:89`／`Show icon#42:9`（既定 true）・`Show avatar#47:3`（96 角の画像枠）・`Show image#42:92`（横いっぱいの画像枠）・`Show button#42:95`・`Show link#42:98`（既定 false）／INSTANCE_SWAP `Icon#42:6`（既定 Lucide / file-text） |
| BlogCard | `26:457` | `f5ee307c4e70821d589f2645c1489946ea972300` | COMPONENT | — | `Title#26:0`・`Excerpt#26:1`（2 行で省略）・`Date#26:2`。画像枠とカテゴリ Badge は exposed instance |
| LogoCloud（ダミー） | `25:485` | `e0a6130533e7d9c5469a8dc7e0e4ebbb7bb5fce3` | SET（2） | Device=Desktop（6 列）/Mobile（3 列 ×2） | なし（各枠は ImagePlaceholder「ロゴ（準備中）」） |
| TestimonialCard（ダミー） | `25:445` | `b1a0347ebab9668d5d338ff73ab5da6142fe8e99` | COMPONENT | — | `Title#25:3`・`Body#25:4` |
| StatCard（ダミー） | `25:441` | `a62cdb041e1a98c43631a3ede44a86203a05fc4e` | COMPONENT | — | `Label#25:0`・`Value#25:1`（必ず「—」）・`Caption#25:2` |
| CookieBanner | `37:2137` | `a76ad9a28c761e529a31953b3215de07e5a9554d` | SET（2） | Device=Desktop（420 幅のカード）/Mobile（下端パネル） | `Title#37:0`・`Body#37:3`・`Link#37:6` |
| ImagePlaceholder | `19:681` | `024f3fa2b80063f88a835f725cdce6fa95a2d7cc` | COMPONENT | — | `Label#19:1`（「画像（準備中）」「ロゴ（準備中）」）。置いた先で `resize()` |
| ChatWidgetPlaceholder | `39:2163` | `881e16cde7562e31548e47a9235578ed2f6b6018` | COMPONENT | — | `Label#39:3`。56px の円。トップと無料相談の右下にだけ置く |

各部品の使い方・注意は Figma の description に書いてある（Figma の右パネルか `node.description` で読める）。

**カードの使い分け**: 本文カードは `IconCard` 1 つにまとめてある（2026-09-20、builder-site の依頼で `InfoCard` は取りやめ・削除。部品を二重に持たないため）。

| 使いたい形 | IconCard の設定 | 使う場所 |
|---|---|---|
| アイコン＋見出し＋本文 | 既定のまま（`Show icon` = true） | トップ 1-4「こんな課題はありませんか」 |
| 見出し＋本文だけ | `Show icon` = false | 会社概要 5-4、完了 6'-1 |
| ＋ ボタン | `Show button` = true（kit Button Outline。既定は Lucide / message-circle ＋「チャットで質問する」） | 無料相談 6-5 カード 2 |
| ＋ テキストリンク | `Show link` = true、`Link` に文言 | 無料相談 6-5 カード 3 |
| 画像枠（横いっぱい 180px）＋見出し＋本文 | `Show image` = true、`Show icon` = false | 会社概要 5-7 メンバー |
| 小さい画像枠（96 角）＋見出し＋本文 | `Show avatar` = true、`Show icon` = false | ブログ記事 8-7 著者 |
| 見出し＋本文（Mobile の表の代わり） | `Show icon` = false | サービス一覧 2-5 の Mobile（上に「こんなとき」、下に「おすすめ」） |

番号付きの手順（無料相談 6-5 カード 1「ご相談の流れ」）はカードにせず `Steps`（Direction=Vertical, Count=4）を置く。

**判断の記録（2026-09-20）: `IconCard` の本文は 16px のまま**。Desktop の 3 列（カード 368・本文幅 318）で 1 行 19.3 字となり、01-content-spec §0.3 の「1 列に 1 行 20 字以上」をわずかに下回る。実測（同じ 37 字の文言、318px 幅）は次のとおり。

| 本文のサイズ | 1 行あたり | 行数 | 高さ |
|---|---|---|---|
| **16px（`JP/Desktop/Body`。現状）** | **19 字** | 3 行 | 84px |
| 14px（`JP/Desktop/Small`） | 22 字 | 2 行 | 48px |

14px にすれば字数の規則は満たすが、**規則の目的は語中改行を避けることで、19.3 字では語中改行は起きていない**。通読させたい課題カードの本文を、手段（20 字）のために小さくするのは本末転倒なので現状維持とした（lead 確定）。`03-handoff.md` の H-5 と 01-content-spec §0.3 の前提（カード左右余白は 16 ではなく **24**、本文幅 318px）は実態に合わせて修正済み。本文が 16px なのは `IconCard` だけで、`ServiceCard`・`PricingCard`・`BlogCard` は 14px のため 22 字前後で通っている。

**1 行の長さ**: `PageIntro` の本文は Desktop で `maxWidth = 720`、`SectionHeading` のリードは Desktop の Left が 720・Center が 768（部品側で固定してあるので、画像枠を消しても 1 行が伸びきらない）。builder が instance 側で絞る必要はない。

**面の色**（2026-09-20 に変更。qa-reviewer の B1 と ia-copy の 0.1 に合わせた）: `SiteFooter`・`ServiceCard` の価格行・`CTABanner` の Inline・`SourceDownloadBlock` の控えめ版は、muted の面をやめて**白＋`border`** にした。控えめ版と強調版の違いは、面の色ではなく**枠線と影とボタンの variant**（Secondary か CTAButton か）で表す。

### 6.1 サイト部品を使うときの約束

1. **kit のボタンのラベルは TEXT プロパティにできない。** Figma は instance の中の層にプロパティを結べない（`Cannot set component property references on instance sublayer`）。CTAButton・リンク・アコーディオンの見出しは、instance の中の TEXT（多くは名前が `Label`）を直接書き換える。
   ```js
   await figma.loadFontAsync({family:'Noto Sans JP', style:'Medium'});
   await figma.loadFontAsync({family:'Inter', style:'Medium'});
   const label = btn.findOne(n => n.type === 'TEXT' && n.name === 'Label');
   label.characters = 'このプランで相談する';           // 和文だけならスタイルはそのまま
   // 英数字が混ざるときは §5.2 の applyMixed(label, 'UI/Label') を当て直す
   ```
2. **variant セットの TEXT プロパティの既定値は、セット全体で 1 つ**（Figma の仕様）。例えば `SourceDownloadBlock` を Strong に切り替えても Title は控えめ版の文言のままなので、`setProperties()` で 01-content-spec の文言に差し替える。
3. **exposed instance**（中の kit instance を操作できるようにしたもの）は `inst.exposedInstances` で取る。Badge の文言、Input の値、ナビの active、アイコンの差し替えはここから。
4. 幅は置いた先で `layoutSizingHorizontal = 'FILL'`。Desktop はコンテンツ幅 1152（左右 144）、Mobile は 358（左右 16）を前提に作ってある。
5. **カードを横並びにして高さをそろえるときは、instance を `layoutSizingVertical = 'FILL'` にするだけでよい。** `PricingCard` と `ServiceCard` は中身が「Top（見出し〜備考）」と「Bottom（ボタン・リンク）」の 2 ブロックに分かれていて、外側が `SPACE_BETWEEN` なので、**ボタンがカードの下端でそろう**。1 枚だけ置く（高さ HUG の）ときの見た目は変わらない。instance 側で `primaryAxisAlignItems` を触らないこと。
   - 副リンク（「ソースコードを無料DL」）を出したカードは、その分ボタンが 1 行ぶん上に来る。ボタンの行までそろえたいときは、リンクの無いカードでも `Show sub link` を true にして文言を空にするのではなく、**並べ方（副リンクのあるカードを端に置く）で調整する**。
6. 部品を直さないと収まらないときは **instance を detach せず、design-system に SendMessage で依頼する**。
7. **instance の中の層は大きさを変えられない。** `inst.findOne(...).resize(96, 96)` は**エラーを出さずに無視される**（Figma が instance のサブレイヤーのサイズ上書きを受け付けないため）。`layoutSizingHorizontal` を `FIXED` にしてから呼んでも同じ。大きさ違いが要るときは、部品側に別の枠と BOOLEAN を用意する（例: `IconCard` の `Show avatar` = 96 角 と `Show image` = 横いっぱい）。足りないときは design-system に依頼する。
8. **非表示のレイヤーは instance に含まれない。** 部品側で `visible=false` にしてある層（`FAQItem` の Closed の Answer など）は、instance にノードとして存在しない。**文言は TEXT プロパティの値としては保持される**ので `inst.componentProperties['Answer#39:0'].value` で読めるが、キャンバスにも `findAll()` にも出てこない。
   - そのため **閉じた FAQ でも Answer は必ず設定する**（開いたときに出る／Dev Mode でプロパティとして読める）。
   - 回答に `【要記入】` `【要確認】` が入る項目は、**`Show marker#50:0` を true** にして「要確認」バッジを出す。閉じたままでも印が画面に残る（01-content-spec 0.1）。文言を「要記入」にするときは exposed instance の `Marker` に `setProperties({'Label#1530:99': '要記入'})`。
   - バッジは**質問の行の右端**にある（chevron の内側には置けない。質問の行が kit instance のため）。**質問文の左端は marker の有無にかかわらずそろう**。ただしバッジは 52px ＋ 余白 12px ぶん幅を使うので、**Mobile では質問が 2 行になることがある**（Desktop は 44px で一定）。
   - **区切り線は `FAQItem` の下罫線で引いている**（kit trigger が持っていた線は消した）。バッジで質問の行が縮んでも**線は全幅のまま**。Open のときは線を引かない（kit の元の挙動と同じ）。
   - 判断の記録（2026-09-20）: kit trigger の線のままだと marker のある行だけ線が 64px 短くなる。**variant を増やさず・instance の再設定も不要・Open の挙動も変わらない**ので、item 側に移す形で対応した。バッジ自体は公開前に埋める箇所を見つけるためのもので、**公開時には消える**（marker は 11 件 → 7 件と減っている）。
   - `FAQItem` の中の TEXT を名前で探すときは注意する。**質問は `Question` instance の中の `Label`**、バッジの文字は `Marker label`。`item.findOne(n => n.name === 'Label')` だと状況によってバッジ側を掴むので、`item.findOne(n => n.name === 'Question').findOne(n => n.name === 'Label')` と辿る。
9. **INSTANCE_SWAP でアイコンを差し替えたら、色を当て直す**（差し替え後のアイコンは kit の既定色で入る）。
   ```js
   const card = iconCardDesktop.createInstance();
   const unplug = await figma.importComponentByKeyAsync('9fc0c411287312c74e46522347b8700a583e5624');
   card.setProperties({ 'Icon#42:6': unplug.id, 'Title#42:0': '…', 'Body#42:3': '…' });
   const accentFg = (await figma.variables.getLocalVariablesAsync()).find(v => v.name === 'accent/subtle-foreground');
   const paint = v => figma.variables.setBoundVariableForPaint({type:'SOLID', color:{r:0,g:0,b:0}}, 'color', v);
   for (const vec of card.findOne(n => n.name === 'Icon').findAll(n => n.type === 'VECTOR')) vec.fills = [paint(accentFg)];
   ```
   トップ 1-4 で使うアイコンの key: `Lucide / file-text` = `6ecac9fbfbf8ed4a8c1a56e26cffd499946aa22d`、`Lucide / unplug` = `9fc0c411287312c74e46522347b8700a583e5624`、`Lucide / user-round` = `4f44d0b00ad76c2fb8235a30a1010149a633c9be`。

## 7. 実装（03-handoff.md）への申し送り候補

- global.css の `--font-sans` は `'Inter Variable', sans-serif` だけで、和文フォントの指定が無い。Figma に合わせるなら `'Inter Variable', 'Noto Sans JP', sans-serif`（`@fontsource-variable/noto-sans-jp` の追加）を提案する。
- アクセント色（G1 で案 B に決定）を `:root` に**追加する提案**として渡す。値は Tailwind v4 の既定パレットそのもの。
  ```css
  --brand: var(--color-emerald-700);                 /* oklch(0.508 0.118 165.612) = #007a55 */
  --brand-hover: var(--color-emerald-800);           /* oklch(0.432 0.095 166.913) = #006045 */
  --brand-foreground: var(--color-white);            /* Figma は kit の primary foreground を参照 */
  --brand-subtle: var(--color-emerald-50);           /* oklch(0.979 0.021 166.113) = #ecfdf5 */
  --brand-subtle-foreground: var(--color-emerald-800);
  ```
  `--accent`（neutral の #f5f5f5）は shadcn の既存トークンなので**名前を奪わない**。
- コンテンツ最大幅は `max-w-6xl`（1152）を前提に組んである（Figma のローカル変数 `layout/container-max`）。本文の 1 行は Desktop で 720 までに抑える（`PageIntro`・`SectionHeading` は部品側で `max-width` 相当を入れてある）。
- **`--muted-foreground` を `bg-muted` の上に置かない**（4.35 : 1 で AA に届かない。§3.5）。新しい色トークンは足さず、**面を `bg-card` ＋ `border` にして解決する**方針にした。実装でも同じ規則にそろえる（`text-muted-foreground` は白い面の上だけ）。
- Mobile の主 CTA の高さは base-nova の `h-9`（36px）のまま Figma に写してある。タップ領域を広げるかはコード側の判断（`button.tsx` が正本）。
- kit と global.css の差分（foreground・primary-foreground・accent-foreground・destructive・ring・radius-2xl）は Figma 側の近似。実装は global.css のまま変えない。
