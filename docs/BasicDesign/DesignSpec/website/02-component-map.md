# 02. コンポーネント・トークン対応表（design-system）

builder がこの文書だけで部品・変数・スタイルを引けるようにまとめた対応表。
前提は `00-brief.md`（fileKey `JRYPLER6E0liA7cUurIhSo`、UI キット = Obra shadcn/ui kit community edition 2.0.0）。

- 改訂日: **2026-10-01**（ブランドガイドライン 1.2 の全面適用。初版 2026-09-20 の内容はすべて置き換わっている）
- **色・寸法・書体の正本は `Assets/tokens/tokens.json`。** 人間が読む正本は `ブランドガイドライン_ComeGin.pdf`（版 1.2）。両者が食い違うときは tokens.json を正とする（ガイドライン §10.3-5）。
- 以前の方針「色の出どころは kit（`global.css`）だけ」は**廃止**。色は ComeGin のブランドトークンが正本で、kit の色変数は Figma 上から全廃した。
- 実装先は `frontend/verdant-virgo`（Astro ＋ shadcn/ui `base-nova` ＋ Tailwind v4）。`global.css` へのトークン追加提案は `03-handoff.md` に出す。

---

## 0. 適用後の実測（2026-10-01 17:53〜17:57 JST に走査）

> ### 走査と置換のときに守ること（2 文。`01-content-spec.md` §0.4 と同じものを置いている）
>
> 1. **検査・走査の結果を報告するときは、母数と対象範囲を添える。** 何件中の何件か、どこを見てどこを見ていないか。
> 2. **一括置換をしたら、置換後に「逆向きの条件」で走査する。** 直したものを数えるのではなく、**直しすぎたもの**を探す。
>
> 2026-10-01 までに design-system・ia-copy・lead で **13 件**の見落としが出た。**1 が 12 件を、2 が残る 1 件を覆う。**
> 2 が要るのは、一括置換は**母数を添えても件数が正しくても**検出できないため（ia-copy の D-1 で、和欧間のスペースまで消した 14 か所が「136 か所を密着表記にした」という正しい報告の裏で起きていた）。
> **両方の文書に同じものを置いてある。** 片方だけに置くと、もう一方の担当が「自分の文書ではない」と読まなくなる。


| 検査項目 | 対象 | 結果 |
|---|---|---|
| ブランドパレット外の色 | `03 Components` 2,851 ノード / 塗り・線 1,962 件 | **0 件** |
| 同上 | `02 Foundations` 790 ノード / 塗り・線 629 件 | **0 件** |
| 未バインドの塗り・線 | 同上 合計 2,591 件 | **0 件** |
| ぶら下がり（削除済み変数への参照） | 全 11 ページ | **この検査は成立していなかった**（本書 §9.3 の C4 を参照）。`getVariableByIdAsync()` が `null` を返すかで判定していたが、**Figma は削除済み変数を参照が残るかぎり返し続ける**ため、構造上 0 件しか返らない。実際には `accent/base` #007A55 への参照が **22 ノード**（11 Services 8・16 System 10・15 Blog 4）残り、緑で描画されていた（qa-reviewer が発見。当初「16 System 20 件」としていたのは**バインド数とノード数の混同**で、正しくは 10 ノード / 20 バインド） |
| Poppins / Noto Sans JP / JetBrains Mono 以外の書体 | `03 Components` 文字ノード 740 件 | **0 件**（Inter・Geist は残っていない） |
| 18px 未満の文字に `brand.blue.500` / `brand.sky` を使用（§5.5-2,3） | 同上 | **0 件** |
| kit（Obra）の色変数への参照 | 同上 | **0 件**（1,066 バインドをブランドトークンに移行） |
| §5.3 コントラスト適合表との突き合わせ | 15 色を Figma 上で実測 | **15/15 一致**（乖離 0.00。`02 Foundations` の表に実測値と記載値を並べてある） |

部品は **28 個 / variant 合計 133**、ローカル変数 **92 件**、文字スタイル **55 件**、エフェクトスタイル **5 件**（2026-10-01 20:17 JST 実測）。

**2026-10-08 の変更**: `FormField` に `Type=Select`・`Type=Radio` を 4 状態ずつ足したため、**variant 合計は 141**（COMPONENT_SET の中の variant 135 ＋ 単体 6）。部品数・変数・スタイルの数は変わらない（§7 の `FormField` の行）。

**数え方**（次に数える人が同じ数を出せるように）:

| 数値 | 数え方 |
|---|---|
| 部品 **28 個** | `03 Components` ページ直下の **COMPONENT_SET 22 ＋ 単体 COMPONENT 6**。variant は含めない |
| variant 合計 **133** | **COMPONENT_SET の中の variant 127 ＋ 単体 COMPONENT 6**。「置ける単位」の数 |
| ローカル変数 **92 件** | `ComeGin / primitives` 48 ＋ `ComeGin / tokens` 44 |
| 文字スタイル **55 件** | `JP|Latin` × `Desktop|Mobile` × 9 段階 ＝ 36、`JP|Latin/UI/*` 8 種 ＝ 16、`Mono/*` 3 |

> **節番号の読み方**: 本書の中の `§x.y` は、断りがなければ**ブランドガイドライン**の節を指す（例 `§9.5` ＝ GL の Web サイト）。**本書自身の節を指すときは「本書 §x.y」と書く。**

**2026-10-01 の後追い修正**: `SiteFooter` の `Device=Mobile` の `Description`（`32:661`）が `role/text-link` にバインドされていた（Desktop は `role/text-muted` で正しい）。**同じ文が Desktop ではグレー、Mobile では青**になり、下線の無いリンク色という §9.5 から外れた状態だった。`role/text-muted` に修正。instance 側に上書きは無いので全 11 ページに伝わる。builder-sales の「`role/text-link` にバインドされているのに下線が無い TEXT」という検査で見つかった。

`BookingEmbed` も同じ基準で検査済み（38 ノード・塗り/線 26 件: パレット外 0 件・未バインド 0 件・kit の色バインド 0 件・規定外の書体 0 件。2026-10-01 18:21 JST）。

### 0.1 ファイル全体のリンク下線（2026-10-01 19:03 JST に全 11 ページを走査）

| ページ | ノード | リンクの TEXT | 下線漏れ |
|---|---|---|---|
| 00 Cover / 01 Sitemap / 02 Foundations | 274 / 340 / 790 | 0 / 0 / 0 | 0 |
| 03 Components | 2,904 | 55 | **0** |
| 10 Top / 11 Services / 12 Pricing | 2,467 / 1,360 / 833 | 67 / 50 / 26 | **0** |
| 13 About / 14 Contact / 15 Blog / 16 System | 514 / 2,204 / 1,087 / 1,521 | 24 / 122 / 52 / 72 | **0** |
| **合計** | **14,294** | **468** | **0** |

§9.5 の「リンクには下線」はファイル全体で満たされている。走査のやり方は §8.4 を参照（`findAll(述語)` を他ページに使うと取りこぼす）。

**名前に頼らない突き合わせでも確認した**（2026-10-01 19:05 JST）。`03 Components` で下線が入っている TEXT の**部品内ノード ID 36 件**を集め、全ページの instance サブレイヤーを **ID の末尾で突き合わせて 495 件**を検査した結果、**ずれは 0 件**。

```js
// instance サブレイヤーの ID は "I<instanceのパス>;<部品内ノードID>" の形
const raw = t.id.includes(';') ? t.id.split(';').pop() : t.id;
```

この方法は**名前が一致しないリンクも拾える**（kit の Link variant のラベルはノード名が `Label` で、名前での検索では引っかからない）。部品の修正が instance に伝わっているかを確かめるときは、名前ではなくこの ID の突き合わせを使う。

---

### 0.2 部品ページの旧表記の走査（2026-10-01 11:38 JST）

`builder-sales` のページでレイヤー名に旧表記が 24 件見つかったため、部品ページも同じ観点で走査した（lead 依頼）。**ノード名・テキスト内容・コンポーネントプロパティ名・プロパティ既定値・variant 値**を母数にしている。

当てた条件: 禁止表現（弊社・当社・お気軽）、旧トークン（`accent` / `emerald` / `option-a|b|c`）、旧フォント（`Inter`）、旧プロパティ（`cta_type`）、数字と単位の間の空白、emerald の hex、`sky` / `blue.500` への言及。

| ページ | ノード | プロパティ所有者 | 当たり | 旧表記として直したもの |
|---|---|---|---|---|
| `03 Components` | 2,791 | 28 | 1 | **1** |
| `02 Foundations` | 796 | — | 24 | **2** |

**当たり 25 件のうち、旧表記は 3 件だけだった。残り 22 件は現行トークン名で、直してはいけないもの。**

直した 3 件（範囲の文字スタイルを壊さないよう、`characters` を丸ごと代入せず `deleteCharacters` ＋ `insertCharacters` で 1 文字だけ差し替えた。セグメント数は 17→17 / 8→8 / 3→3 で保たれている）:

| ノード | 誤 | 正 | なぜ旧表記か |
|---|---|---|---|
| `19:680`（`03 Components` の説明） | `role/surface-brand（brand.blue.500）` | `brand.blue.600` | C-1 で `role/surface-brand` を blue.600 に差し替えたのに説明文が追随していなかった |
| `140:13463`（§5.4 の 60:30:10） | `10% 強調・図版 blue.500` | `blue.600` | 同じ理由。10% のアクセントは `role/surface-brand` ＝ blue.600 |
| `87:53` / `19:680` | `assets/tokens/tokens.json` | `Assets/tokens/tokens.json` | 実パスは大文字始まり。**Linux では大文字小文字を区別するため、このまま辿れない** |

**直さなかった 22 件の判断根拠**（変数の実値と突き合わせた）:

| 当たった文字列 | 判定 | 根拠 |
|---|---|---|
| `role/text-accent-subtle` / `role/surface-accent-subtle` | **現行** | 存在する現行トークン（navy/700 `#003577` / blue/50 `#E9F5FE`）。退役させたのは emerald の `accent/*` と `accent/option-a|b|c` だけで、`*-accent-subtle` は別物 |
| `swatch / brand-blue/500`・`blue.500`・`brand.sky` | **現行** | プリミティブの見本。`brand-blue/500` は現役で、`role/focus-ring` が参照している |
| `blue.500 の 2px アウトライン＋2px オフセット`（`89:85`） | **現行** | `role/focus-ring` → `brand-blue/500` `#0581DB`。フォーカスリングだけは blue.500 のまま |
| `brand.blue.500 #0581DB は 4.06:1 で本文に使えない…本文リンクは role.text-link #0579CE`（`88:214`） | **現行** | §5.3 の記述として正しい。`role/text-link` → `raw/info` `#0579CE` |

**「`accent` という語が出たら旧表記」と機械的に判定すると 4 件を壊すところだった。** 語の一致ではなく、**その名前の変数が今も存在し何を指しているかを変数側で確かめる**こと。`role/focus-ring` が blue.500 を指し続けている以上、「blue.500 への言及はすべて古い」とも言えない。

### 0.3 レイヤー名の取り残し（2026-10-01 11:42〜11:44 JST）

§0.2 の語彙による走査では**レイヤー名の取り残しを 1 件も検出できなかった**。語彙の当たりに頼らない条件で測り直したら **3 件見つかった**。検出条件の作り方そのものが論点なので手順を残す。

**ボツにした条件: 「レイヤー名 ≠ 本文」。** Figma は自動命名なら名前が本文に追随するので、食い違い＝手で改名された印にはなる。しかし部品ページの命名規約は**役割名**（`Label` / `Helper` / `Error` / `Link`）なので、`03 Components` では **758 件中 756 件が食い違う**。指標として使えない。

**使えた条件: 「レイヤー名が『コピーらしい』のに本文と一致しない」。** コピーらしさは「日本語を含む、または 20 文字超」で判定した。さらに**空白・改行の畳み込みだけの差を除く**（Figma の自動命名は連続スペースを 1 つに、改行を半角スペースに畳むため、`norm = s.replace(/[\s　]+/g, ' ').trim()` で正規化してから比べる）。

| ページ | TEXT | 名前＝本文 | 役割名 | 空白の畳み込みだけ | **取り残し** |
|---|---|---|---|---|---|
| `02 Foundations` | 366 | 334 | 14 | 18 | **0** |
| `03 Components` | 758 | 2 | 732 | 0 | **24** |

**`03 Components` の 24 件は `SiteFooter` のリンクで、`Link / <文言>` という命名規約だった。** 規約として名前に文言を埋めているので「名前 ≠ 本文」は正常。**そのうち 2 件だけが本当の取り残し**だった。

| ノード | 誤 | 正 |
|---|---|---|
| `32:648` / `32:674` | `Link / ソースコード無料DL` | **`Link / ソースコード無料 DL`** |
| `42:4283`（親フレーム） | `Row / ソースコード無料DL` | **`Row / ソースコード無料 DL`** |

**`DL` の前の半角スペースが名前側だけ抜けていた。** 本文は `ソースコード無料 DL` で正しい。文言を直したときに名前を追わなかった形で、**`builder-sales` のページで 24 件見つかったのと同じ種類**。

容器側も別に測った。**`接頭辞 / 文言` の形で日本語を含む非 TEXT ノードが 66 件**あり、配下の TEXT の本文と突き合わせて**空白のずれ 1 件（上の `42:4283`）・不一致 0 件**。

**レイヤー名に文言を埋める規約は、文言を直すたびに必ず腐る。** `SiteFooter` の 12 リンク（× 2 variant）はこの形なので、文言を変えるときは名前も同時に変える。`MobileMenuSheet` の 6 件は `Label` という役割名なので腐らない。**命名規約を選ぶ時点で、同期の手間を引き受けるかどうかが決まっている。**

---
---
## 1. ガイドライン適用で変わったこと（旧版からの差分）

| 項目 | 旧（2026-09-20） | 新（2026-10-01） |
|---|---|---|
| アクセント色 | emerald 系 `accent/base` ほか 5 件（ゲート G1 で「案 B 成長の緑」） | **廃止・削除**。ブランドの `role/surface-brand`（brand.blue.500）ほかに置換 |
| 色の出どころ | kit の `shadcn colors/*` | **ComeGin のブランドトークン**。kit 色変数への参照は 0 件 |
| 欧文書体 | Inter | **Poppins**（§6.1） |
| 等幅書体 | なし | **JetBrains Mono**（`Mono/Body|Small|Caption`） |
| タイプスケール | 独自（Desktop H1 48px ほか） | **§6.3 のスケール**（H1 36px・H2 30px ほか） |
| 和文の字間 | +2〜3% | **§6.3 のとおり 0 / −1% / +4%** |
| 角丸 | kit の 6/8/10/14/16/22px | **§7.3 の 4 / 8 / 12px（＋ピル・2px）** |
| 影 | kit の shadow-xs〜2xl（グレー） | **`shadow/sm|md|lg`（ネイビー透過）の 3 段階のみ** |
| フォーカス | 表現なし（State=Focus の variant が 0 件） | **`focus/ring` を作り、CTAButton・FormField・ConsentCheckbox に State=Focus を追加** |
| ロゴ | 文字「ComeGin」（`UI/Logo` スタイル） | **`Logo` 部品（SVG マスター・16 variant）** |
| ヘッダー | 高さ 64px / 文字ロゴ | **高さ 56px / シンボル単体 32px**（本書 §6。当初は横組み 160px としたが撤回した） |

削除した変数 29 件（**削除前の「参照 0 件」の確認は成立していなかった**。本書 §9.3 の C4 を参照。28 件の参照が残っていた）: `accent/{base,hover,foreground,subtle,subtle-foreground}`、`accent/option-{a,b,c}/*` 15 件、旧 primitives `blue|emerald|orange/{50,700,800}` 9 件。

---

## 2. 変数

コレクションは 2 つ。**部品に当てるのは `ComeGin / tokens` の役割トークンだけ**で、primitives を直接指定しない。
取り方: `(await figma.variables.getLocalVariablesAsync()).find(v => v.name === 'role/surface-brand')`。同じファイル内なので import は不要。

### 2.1 `ComeGin / primitives`（モード `Value`・48 件・scope は空＝ピッカーに出ない）

| 変数 | 値 | 備考 |
|---|---|---|
| `brand-navy/50 … 900` | #E8F2FF / #CCE3FF / #A3CCFF / #66AAFF / #1C81FF / #005FD6 / #0049A3 / **#003577** / **#00215B** / #001C40 | 700 がワードマーク Come、800 がカタカナの濃部（ロゴ実値） |
| `brand-blue/50 … 900` | #E9F5FE / #CDE9FE / #A0D6FD / #62BBFB / #219FFA / **#0581DB** / #0471C0 / #045D9D / #03497D / #02365C | 500 がワードマーク Gin（ロゴ実値） |
| `brand-sky` | #1298E8 | シンボル最明部 |
| `brand-ink` | #00215B | brand-navy/800 と同値 |
| `gradient/1 … 5` | #0052AD / #036AC3 / #0074D2 / #0581DB / #1298E8 | シンボルの階調。**並び順を入れ替えない**（§5.5-7） |
| `neutral/0,25,50,100,200,300,400,500,600,700,800,900` | #FFFFFF / #FCFCFC / #F5F7F9 / #ECF0F4 / #DCE3EA / #C2CCD8 / #97A5B5 / #6F7F92 / #546274 / #3D4856 / #2A323C / #1A1A1A | 無彩色ではなくわずかにブルー寄り |
| `raw/success|warning|danger|info` | #0F7A46 / #9A5B00 / #C0302A / #0579CE | semantic の素の値 |
| `raw/shadow-navy` | #0A3B7A | `rgba(10, 59, 122, a)` の RGB。影のベース |
| `raw/logo-black` | #000000 | §4.2 の単色黒版専用。**UI の色には使わない** |

WEB コードシンタックスは `tokens.css` の名前に一致させてある（例 `var(--color-brand-navy-700)`）。

### 2.2 `ComeGin / tokens`（モード `Light`・44 件）

**色**（すべて primitives への alias）

| トークン | 参照先 | 白背景コントラスト | 使う場所 |
|---|---|---|---|
| `role/text-primary` | brand-navy/900 #001C40 | 16.93:1 | 最も強い文字・重要な数値 |
| `role/text-heading` ◆ | brand-navy/700 #003577 | 11.83:1 | **見出し全般**（§9.5 ファーストビューの H1） |
| `role/text-body` | neutral/900 #1A1A1A | 17.40:1 | 本文 |
| `role/text-muted` | neutral/600 #546274 | 6.22:1 | 補足・キャプション |
| `role/text-inverse` | neutral/0 #FFFFFF | — | 濃色面の文字 |
| `role/text-link` | raw/info #0579CE | 4.53:1 | **本文リンク。必ず下線を付ける** |
| `role/text-link-hover` ◆ | brand-blue/700 #045D9D | 6.87:1 | リンクのホバー（§9.5） |
| `role/text-brand` ◆ | brand-blue/700 #045D9D | 6.87:1 | **ブランドブルーで見せたい「リンクではない」文字**（タグラインなど）。下線を付けない |
| `role/text-accent-subtle` ◆ | brand-navy/700 | 11.83:1 | accent-subtle 面の文字・強調アイコン |
| `role/surface` | neutral/0 #FFFFFF | — | 紙の面・カード・ヘッダー |
| `role/surface-subtle` | neutral/50 #F5F7F9 | — | **ファーストビューの地**（§9.5）・薄い面 |
| `role/surface-brand` | brand-blue/500 #0581DB | 4.06:1 | **主ボタンの地**。文字は 16px 以上太字 |
| `role/surface-brand-hover` ◆ | brand-blue/700 #045D9D | 6.87:1 | 主ボタンのホバー |
| `role/surface-brand-strong` | brand-navy/700 #003577 | 11.83:1 | 反転面（CTA 帯・OGP） |
| `role/surface-accent-subtle` ◆ | brand-blue/50 #E9F5FE | — | 薄いアクセント面（§5.5-6 に従いランプ 50 を使う） |
| `role/border` | neutral/200 #DCE3EA | — | 罫線・ヘッダー下の 1px |
| `role/border-strong` | neutral/300 #C2CCD8 | — | 表の外枠 |
| `role/border-brand` ◆ | brand-navy/700 #003577 | — | **副ボタンの枠**（§9.5） |
| `role/focus-ring` | brand-blue/500 #0581DB | — | フォーカスリング |
| `semantic/success` | raw/success #0F7A46 | 5.39:1 | 完了・達成 |
| `semantic/warning` | raw/warning #9A5B00 | 5.43:1 | 注意・期限 |
| `semantic/danger` | raw/danger #C0302A | 5.68:1 | **警告専用。アクセントに使わない**（§5.5-5） |
| `semantic/info` | raw/info #0579CE | 4.53:1 | 補足 |

◆ = tokens.json の `color.role` には無い**拡張トークン**。いずれも §9.5・§5.5 の規定から導いた値で、新しい色は足していない（既存ランプの段を指しているだけ）。実装へは `03-handoff.md` で提案する。

**寸法**

| トークン | 値 | 用途（§7.1） |
|---|---|---|
| `space/0 … 10` | 0 / 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96 / 128 | 1 アイコンと文字 ／ 2 関連要素 ／ 3 ラベルと入力欄 ／ 4 段落・カード内 ／ 5 小見出しの前 ／ 6 ブロック間 ／ 7 セクション間 ／ 8 大見出しの前 ／ 9 ページ上下 ／ 10 ヒーロー |
| `radius/none,xs,sm,md,lg,full` | 0 / 2 / 4 / 8 / 12 / 9999 | **sm=入力欄・タグ、md=カード・ボタン、lg=モーダル**（§7.3） |
| `layout/container-max` | 1152 | Desktop のコンテンツ幅 |
| `layout/gutter-desktop` | 144 | (1440−1152)/2 |
| `layout/gutter-mobile` | 16 | space.4 |
| `layout/logo-header` | 32 | §9.5 が書いているヘッダーのロゴ高さ（下記 §6 の要判断事項を参照） |

> `space/0` を 0 の余白にバインドするのはノイズになるため、適用後に 1,357 件を外した。0 の余白は変数を付けない。

### 2.3 エフェクトスタイル（5 件）

| スタイル | 中身 | 用途 |
|---|---|---|
| `shadow/sm` | 0 1px 2px rgba(10,59,122,.08) | カード |
| `shadow/md` | 0 2px 8px rgba(10,59,122,.10) | 固定ヘッダー・Cookie バナー・料金カードの強調 |
| `shadow/lg` | 0 8px 24px rgba(10,59,122,.12) | Sheet・ダイアログ |
| `focus/ring` | 白 2px オフセット ＋ `role/focus-ring` 2px | **フォーカス。絶対に消さない**（§9.5） |
| `focus/ring-error` | 白 2px オフセット ＋ `semantic/danger` 2px | エラー時のフォーカス |

**影はこの 3 段階だけ。グレーの影を使わない（§7.3）。** 色はすべて変数にバインドしてある。

> ⚠ **効果の色に変数をバインドすると、効果側の不透明度は変数の不透明度で上書きされる。**
> `raw/shadow-navy`（不透明なネイビー）をバインドしていたため、**2026-10-01 まで 3 つの影がすべて不透明**だった（ヘッダーの境目が 1px の濃い線として出ていた）。
> 不透明度込みの **`raw/shadow-sm` / `raw/shadow-md` / `raw/shadow-lg`**（rgba(10,59,122,.08/.10/.12)）を作り、そちらをバインドして解決した。
> **効果に色変数を当てるときは、変数側に不透明度を持たせる。**
フォーカスリングは「白 2px → 青 2px」の順で重ねてある。CSS の `outline` ＋ `outline-offset` と同じ見え方で、**白い面・neutral.50 の面の上でのみ正しく見える**。濃色面に置く部品では、オフセットの色を面の色に差し替える必要がある（現状そのような部品は無い）。

---

## 3. 文字スタイル（55 件）

**欧文 Poppins / 和文 Noto Sans JP / 等幅 JetBrains Mono**（§6.1）。Figma の 1 スタイルは 1 書体しか持てないので、`JP/…` と `Latin/…` を組で使う（テキスト全体に JP、半角英数字の連続部分に Latin を範囲適用。§8 のレシピ）。

ウェイトは **Regular 400 / Medium 500 / SemiBold 600 / Bold 700 のみ**。Light（300 以下）と Black（800 以上）は使わない（§6.2）。

> **和文の 600 は Bold(700) を当てている。** Noto Sans JP に SemiBold が無いため。Medium(500) は Poppins SemiBold と並べると和文が明確に細く見え、和文主体の本サイトでは見出しの階層が立たない。また §6.2 は Medium を「表の見出し・ラベル」に割り当てているので、見出しに回すとラベルとの区別が消える。代償として JP では H1(700) と H2〜H4(600) が同ウェイトになるが、§6.3 が 36/30/24/20 とサイズで差を付けているので階層は保てる。

### 3.1 §6.3 タイプスケール（`JP|Latin / Desktop|Mobile / <段階>`）

| 段階 | Desktop | Mobile | 和文ウェイト | 欧文ウェイト | 行送り | 字間 |
|---|---|---|---|---|---|---|
| Display | 60px | 36px | Bold | Bold | 130% | −1% |
| H1 | **36px** | 30px | Bold | Bold | 130% | −1% |
| H2 | **30px** | 24px | Bold | SemiBold | 130% | 0 |
| H3 | 24px | 20px | Bold | SemiBold | 150% | 0 |
| H4 | 20px | 18px | **Bold** | SemiBold | 150% | 0 |
| Body L | 18px | 16px | Regular | Regular | 175% | 0 |
| Body | 16px | 16px | Regular | Regular | 175% | 0 |
| Small | 14px | 14px | Regular | Regular | **175%** | 0 |
| Caption | 12px | 12px | Regular | Regular | 150% | **4%** |

Desktop の値が §6.3 そのもの。Mobile はタイプスケールの 1 段下（Display 60→36、H1 36→30、H2 30→24、H3 24→20、H4 20→18、Body L 18→16）で、**Body・Small・Caption は Desktop と同値**。
和文の行送り 1.75 は §6.3 の基準。見出しだけ 1.3 に詰めて塊として見せる。
**本文を 14px 未満にしない**（§6.5-4）。

### 3.2 UI 用（kit instance の文字を置き換える。行送りは px 固定）

| スタイル | 内容 | 置き換える対象 |
|---|---|---|
| `JP|Latin/UI/Button` | 16 / 24px、JP Bold・Latin Bold | **主ボタンのラベル。§9.5「ボタン文字は 16px 以上太字」** |
| `JP|Latin/UI/Button Subtle` | 16 / 24px、JP Medium・Latin Medium | **副ボタン（Secondary・Outline）のラベル。** 主と同じ 16px でウェイトだけ落として重みの差を付ける |
| `JP|Latin/UI/Label` | 14 / 20px、Medium | Label・Nav・Tab・Accordion Trigger（kit の Geist Medium 14） |
| `JP|Latin/UI/Text` | 14 / 20px、Regular | Input・Select・Textarea の値、Breadcrumb、Accordion 本文 |
| `JP|Latin/UI/Small` | 12 / 16px、Medium | Badge・Tooltip |
| `JP|Latin/UI/Card Title` | 20 / 150%、JP Bold・Latin SemiBold | カードの見出し。§6.3 H4 と同値 |
| `JP|Latin/UI/Price` | **30** / 130%、Bold | 料金カードの金額。旧 32px はタイプスケール外だったため 30px（§6.3 H2 のサイズ）に修正 |
| `JP|Latin/UI/Logo` | 20 / 28px、Bold | **非推奨**。`Logo` 部品に置き換え済み。新規に使わない |
| `Mono/Body` | JetBrains Mono 16 / 175% | コード・API キー・登録番号 |
| `Mono/Small` | JetBrains Mono 14 / 175% | 同上（小） |
| `Mono/Caption` | JetBrains Mono 12 / 150% / 4% | 図版の値・HEX |

kit の文字スタイル（`heading 1〜4`、`paragraph */*`。すべて Geist）は**使わない**。Geist には和文グリフが無い。

---

## 4. `Logo` 部品（`03 Components` / ノード `78:2581` / key `7312e45ec8dafd6fb3bdb556a4ec4bad92e388f0`）

SVG マスター（`Assets/logo/*.svg`）をベクターのまま取り込み、**塗り 102 箇所すべてをブランド変数にバインド**してある。

- variant: `Lockup` = Horizontal / Vertical / Symbol / Wordmark × `Color` = Fullcolor / Navy / White / Black（**16 variant**）
- 既定サイズ（= tokens.json の画面最小幅ちょうど）: **Horizontal 160 × 49.16 / Vertical 112 × 116.42 / Symbol 24 × 21.46 / Wordmark 112 × 30.12**
- 拡大は**等比のみ**。縦横比を変えない・回転させない・効果を足さない・パレット外で塗らない（§4.6）

### 4.1 最小サイズ（幅）— **tokens.json を正とする**

| 組み | 通常（tokens.json） | 絶対下限（tokens.json） | 参考: PDF §4.4 本文 |
|---|---|---|---|
| 縦組み | **112px** | **96px** | 96px / 80px |
| 横組み | **160px** | **136px** | 144px / 120px |
| シンボル | **24px** | **16px** | 20px / 14px |
| ワードマーク | 112px | — | 規定なし（カタカナを含むため縦組みと同幅を下限とした） |

下限を割るときは**その組みを使わずシンボル単体に切り替える**（§4.4）。シンボルが 24px 未満なら `Color=Navy` を使う（輪郭が立つ）。

### 4.2 アイソレーション（§4.3）

X ＝ ワードマーク「C」のキャップハイト。全高に対する比率は **縦組み 16.5% / 横組み 33.6% / シンボル単体 25.0%**。
例: 横組み 160×49.16 なら X ＝ 49.16 × 0.336 ≒ **16.5px** を上下左右に確保する。
この余白に文字・罫線・画像・他社ロゴを入れない。ページ端・断ち落とし・折り目に対しても確保する。

### 4.3 背景別の選び方（§4.5）

| 背景 | Color |
|---|---|
| 白・neutral 25〜100 | Fullcolor |
| neutral 200〜400 などの淡色 | Navy |
| brand navy 700〜900・brand blue 500 以上の濃色、写真 | White |
| 1 色印刷・FAX・捺印を伴う書面 | Black |

判断の目安はロゴ最暗部が背景に対して 3:1 を確保できるか。迷ったら単色版。

### 4.4 取り込み時の処理

§4.7 の既知の残留パス（カタカナ「ギ」の `#918EBC`・不透明度 7.45%）を **3 点削除**した（Horizontal・Vertical・Wordmark）。肉眼では見えないがパレット外の色なので、Figma 側には持ち込んでいない。マスターが更新されたら取り込み直す。

---

## 5. §9.5 Web サイト規定の実装状況

| 箇所 | 規定 | Figma での実装 |
|---|---|---|
| ヘッダー | ロゴ横組み 左、高さ 32px。背景 neutral.0、下に 1px neutral.200 | `SiteHeader` 全 4 variant。**`Logo` の `Lockup=Symbol` を高さ 32px（35.79×32）で左に**、背景 `role/surface`、下に 1px `role/border`。ヘッダーは **56px**。§4.4 の「下限を割る場合はシンボル単体に切り替える」に従った形で、**§9.5 の「高さ 32px」とも一致する**（本書 §6） |
| ファーストビュー | 見出しは navy.700 の H1、背景は neutral.50 | `PageIntro` 2 variant の地を `role/surface-subtle`、見出しを `role/text-heading` に |
| リンク | role.text-link ＋ 下線。ホバーで blue.700 | `Detail link` / `Sub link` / `Link`（9 件）とフッターのリンク列（15 件）に `role/text-link` ＋ 下線。ホバー色は `role/text-link-hover` |
| ボタン（主） | 地 blue.500 ／文字 #FFFFFF。4.06:1 のため 16px 以上太字 | kit `Variant=Primary` の 42 instance。**地は `role/surface-brand` ＝ brand.blue.600 #0471C0（5.09:1 ＝ AA 適合）。** §9.5 の blue.500 は 4.06:1 で 16px 太字では AA に届かないため、2026-10-01 のユーザー判断で 600 に変更した。文字は `role/text-inverse` ＋ `UI/Button`（16px Bold） |
| ボタン（副） | 地 neutral.0 ／枠 navy.700 ／文字 navy.700 | kit `Variant=Secondary|Outline` の 14 instance。地 `role/surface`、枠 `role/border-brand` 1px、文字 `role/text-heading` ＋ `UI/Button Subtle` |
| フォーカスリング | blue.500 の 2px アウトライン ＋ 2px オフセット。絶対に消さない | `focus/ring` を作成。`CTAButton`・`FormField`・`ConsentCheckbox` に **State=Focus を 10 variant 追加** |
| 角丸 | sm 4（入力欄・タグ）／ md 8（カード・ボタン）／ lg 12（モーダル） | 158 ノードを再バインド（10→8 が 57、入力系 10→4 が 16、14→8 が 11、16→12 が 22 ほか） |
| 影 | shadow.sm/md/lg のみ。グレーの影は使わない | 16 ノードを `shadow/sm|md|lg` に差し替え |
| ファビコン・OGP | — | Figma 側の対象外。`03-handoff.md` で実装に申し送る |

**ナビゲーションに下線を付けていない。** §9.5 の「リンク ＋ 下線」は本文・カード・バナー・フッターのテキストリンクに当てた。ヘッダーのグローバルナビとモバイルメニューの主要ナビは `role/text-heading`（navy.700）のままにしてある。ナビ全体を青＋下線にすると §5.4 の配色比 60:30:10 の「青 10%」を大きく超えるため。

---

## 6. 判断の記録: ヘッダーのロゴ（2026-10-01 ユーザー確定）

**結論: ヘッダーのロゴは `Lockup=Symbol` を高さ 32px で置く。ヘッダーは 56px、下端の 1px 罫線はそのまま。**

| | 当初の判断（撤回） | 確定 |
|---|---|---|
| ロゴ | 横組み 160 × 49.16px | **シンボル単体 35.79 × 32px** |
| ヘッダーの高さ | 74.16px | **56px**（32 ＋ 12 × 2。8pt グリッドに乗る） |
| 下端 | 1px 罫線 → 一時的に `shadow/sm` | **1px 罫線に戻す** |
| アイソレーション X | 16.52px（上下 12px では不足） | **8px**（32 × 0.25。上下 12px で足りる） |

**これで GL §4.3（アイソレーション）・§4.4（最小サイズと切り替えの指示）・§4.6-8（ゾーン内に罫線を入れない）・§9.5（高さ 32px）のすべてを満たす。** Mobile の左 16px も 8px を超えるので足りる。

### 当初の判断は誤りだった

**私（design-system）は「§9.5 の 32px と §4.4 の最小幅 160px が矛盾している」と読み、可読性を優先して横組み 160px を提案した。lead が承認した。**

**しかし矛盾ではなかった。** §4.4 は「**下限を割る場合はその組みを使わずシンボル単体に切り替える**」と**解決を用意しており、ヘッダーはまさにその場面**だった。§9.5 の「高さ 32px」は、シンボル単体を前提にした寸法として読める。**ガイドラインは正しく、こちらの読み落としだった。**

**気づけなかった原因は、最小サイズだけを見てアイソレーションを計算しなかったこと。** 横組みは「160px 以上 **＋ 上下左右に 16.52px 以上**」を要求するので、**高さの限られたヘッダーには構造的に収まらない**。この計算を当初していれば、§4.4 の切り替えの指示が「まさにこの場面の話」だと読めたはずだった。

**寸法の判断をするときは、§4.3（アイソレーション）・§4.4（最小サイズ）・§4.5（背景）をセットで確かめる。** 1 つの節だけを見て「矛盾している」と結論しない。

### ヘッダーだけがシンボル

**`SiteHeader` 以外のロゴは横組みのままで正しい**（`Logo` の instance は全体で 42 件）。§4.4 の切り替えの指示は**高さが限られた面に対する規定**で、フッター・OGP・提案書・名刺などは高さに余裕があり、**横組みの最小幅 160px を満たせるうえワードマークを出せる**。サイト全体からワードマークが消えるわけではない。

### ガイドラインへの指摘は 2 件撤回した

「§9.5 の 32px が §4.4 の最小幅と矛盾する」と「§4.3 のアイソレーションと §9.5 のヘッダーが噛み合わない」の 2 件は、**どちらも読み落としが原因なので撤回**した（`01-content-spec.md` の R-1）。**指摘を立てたまま GL を直すと、正しい規定を壊すことになっていた。**

残る食い違いは**数値そのものの誤り**なので有効。

| # | 食い違い | tokens.json（採用） | PDF 本文 |
|---|---|---|---|
| 1 | ロゴ最小サイズ・画面（幅） | 縦 112 / 横 160 / 記号 24、下限 96 / 136 / 16 | §4.4 縦 96 / 横 144 / 記号 20、下限 80 / 120 / 14 |
| 2 | **ロゴ最小サイズ・印刷（幅）** | **縦 20mm / 横 32mm / 記号 8mm** | §4.4 縦 18mm / 横 28mm / 記号 6mm |
| 3 | 影のベース色 | `rgba(10, 59, 122, a)` | §7.3 `rgba(0, 53, 119, a)` |
| 4 | ワードマークの最小サイズ | 規定なし | 規定なし（縦組みと同幅 112px を下限として本書で補った） |

**#1 と #2 は §4.4 の同じ表の中の別の行。** 画面と印刷の両方がずれているので、**§4.4 の表は全体が古い版のまま残っている**と読むのが妥当。直すときは 1 行ではなく表ごと差し替える。

### 6.1 ガイドライン自体の矛盾（2026-10-01 にユーザー判断で解決）

**寸法の食い違い（上の表）とは別に、GL の規定どうしが噛み合っていない箇所が 1 つ見つかった。** Figma 側では解決済みだが、**GL を直すべき指摘**として `03-handoff.md` と `01-content-spec.md` §11.6 に記録してある。

| # | GL の箇所 | 矛盾の内容 | 解決 |
|---|---|---|---|
| A | **§9.5「ボタンの地は blue.500 ／ 文字は 16px 以上の太字」** | この処方では **AA を満たせない**。WCAG の「大きい文字」は 18.66px 以上の太字なので、**16px Bold には 4.5:1 が必要**。blue.500 は 4.06:1。**§5.3 の適合表（blue.500 ＝ 本文 ✕ / 大文字・UI ○）と §9.5 の処方が噛み合っていない** | **地を `brand.blue.600` #0471C0（5.09:1）に変更。** 文字サイズは 16px 太字のまま。トークン 1 つの差し替えで済み、実装も `--color-role-surface-brand` の 1 行 |

**B（アイソレーション）として挙げていた項目は撤回した。** §6 のとおり、ガイドラインの矛盾ではなく読み落としだった。

---

## 7. サイト部品（28 個 / variant 141。2026-10-08 に 133 から `FormField` の 8 variant を追加）

すべて Figma ページ `03 Components`（ID `4:4`）。**同じファイル内なので import は不要**で、
`const set = await figma.getNodeByIdAsync('<ノード ID>')` → variant を選んで `createInstance()`。別ファイルからは `figma.importComponentSetByKeyAsync('<key>')`。

variant の選び方: `set.children.find(c => ['Device=Desktop','CTA=Primary'].every(q => c.name.includes(q)))`。
文言の差し替え: `inst.setProperties({ 'Title#29:0': '…' })`。

| 部品 | ノード ID | key | 種類 | variant | TEXT / BOOLEAN / INSTANCE_SWAP プロパティ |
|---|---|---|---|---|---|
| **Logo**（新規） | `78:2581` | `7312e45ec8dafd6fb3bdb556a4ec4bad92e388f0` | SET（16） | Lockup=Horizontal/Vertical/Symbol/Wordmark、Color=Fullcolor/Navy/White/Black | なし |
| CTAButton | `19:800` | `fac92b941ede8d7f133a3096fec13badc8be01b9` | SET（**24**） | Size=Small/Default/Large、State=Default/Hover/**Focus**/Loading、Width=Hug/Full | なし（ラベルは中の TEXT「Label」を直接書き換える。`UI/Button` を当て直す） |
| SiteHeader | `30:854` | `fb8fa1c8789cb08207f68abb0178e7a9779d2637` | SET（4） | Device=Desktop/Mobile、CTA=Primary/Outline | **`Logo#30:0` は削除**（文字ロゴを `Logo` 部品に置き換えたため）。現在地は exposed instance「Nav / 料金」などに `setProperties({State:'Hover & Active'})` |
| MobileMenuSheet | `31:669` | `0acda40d8aac93e5e5a5875eede985f32613da72` | SET（2） | CTA=Primary/Outline | なし |
| SiteFooter | `32:683` | `2448b08a1d851e44653b91389dc4f33923f8d952` | SET（2） | Device=Desktop/Mobile | **`Logo#32:6` は削除**。`Description#32:0`・`Copyright#32:3`。**2026-10-08（G-A）: 列 3 の最後に「ソースコード（GitHub）」を追加**（Desktop `232:13778`／Mobile の行 `232:13779`・文字 `232:13780`。和文 `JP/UI/Text`・欧文 `Latin/UI/Text`、`role/text-link`＋下線）。Desktop の高さは 392 のまま、Mobile は 1055→1107 |
| AnnouncementBanner | `28:509` | `108b0cdb31df7b5463ea1ac896b61e46a65cbb00` | SET（2） | Device=Desktop/Mobile | `Text#28:0`・`Short text#28:3` |
| PageIntro | `29:712` | `b54aee6e44f805dd0e07c71b1c131f43a374883d` | SET（2） | Device=Desktop/Mobile | `Title#29:0`・`Body#29:3`／`Show badge#29:6`・`Show button#29:9`・`Show image#29:12`・`Show breadcrumb#29:15` |
| SectionHeading | `21:383` | `cce2962d041362cd6dbc28933147ab85c30361d0` | SET（4） | Device=Desktop/Mobile、Align=Left/Center | `Title#21:19`・`Lead#21:24`／`Show lead#21:29`・`Show badge#21:34` |
| ServiceCard | `23:476` | `0da4b8d729132de0de28942d5f57a92cdd60a139` | SET（2） | Price rows=1/2 | `Title#23:0`・`Body#23:3`・`Product 1#23:6`・`Price 1#23:9`・`Period 1#23:12`・`Product 2#23:15`・`Price 2#23:18`・`Period 2#23:21`・`Note#23:24`／`Show badge#23:27`・`Show note#23:30`・`Show sub link#23:33` |
| PricingCard | `24:443` | `39cd29f7f8b8a9d0aadd41f94f3571f7c704eb7b` | COMPONENT | — | `Product#24:0`・`Description#24:1`・`Price#24:2`・`Period#24:3`・`Note#24:4`／`Show badge#24:5`・`Show description#24:6`・`Show note#24:7`・`Show sub link#24:8` |
| StepItem | `22:240` | `ac50d7daa7aed9e4c65f948b415784e32b8de245` | SET（2） | Layout=Stacked/Inline | `Number#22:0`・`Title#22:3`・`Body#22:6`・**`Period#232:9`**（既定 `【要記入】期間`）／**`Show body#128:0`**（既定 true。false で本文の行が消える。Stacked は 165→82px）・**`Show period#232:6`**（既定 false。2026-10-08 追加。Title の直下に期間の行〈`JP/Desktop/Caption`・`role/text-muted`〉。サービス詳細 3-6 の 5 段階で使う。`Steps` の中では exposed instance〈`Step 1`〜〉から切り替える） |
| Steps | `22:499` | `5c3b919a167c84b5ce50c70bbbc1df69c892a70f` | SET（6） | Direction=Horizontal/Vertical、Count=4/5/6 | なし（中の「Step 1」… が StepItem の exposed instance）。**variant ごとに既定の文言が入っている**（下記 7.2） |
| FAQItem | `39:2162` | `aa446a2066498ef3f9b4f756d33837ed3841098c` | SET（2） | State=Closed/Open | `Answer#39:0`／`Show marker#50:0` |
| CTABanner | `27:502` | `aa958d4c3db370c83b5bc0b1e032947876a1d9fd` | SET（4） | Type=Standard/Inline、Device=Desktop/Mobile | `Title#27:0`・`Body#27:5`／`Show body#27:10` |
| SourceDownloadBlock | `35:1578` | `8337e7fd91811468a95143ad7060f47c640fcf7a` | SET（20） | Emphasis=Subtle/Strong、State=Default/Error/Loading/Failed/Success、Device=Desktop/Mobile | `Title#35:0`・`Body#35:21`（**どちらも既定値は `【要記入】`**。Title は 2026-10-08 に変更）。**2026-10-08（G-A）: 本文の下に「ソースコードを見る（GitHub）」のリンクを全 20 variant に追加**（`Link / ソースコードを見る（GitHub）`。kit `Button - Nova` Variant=Link・`Lucide / external-link`。Success でも残る）。ボタン「構築の手順書を受け取る」、注記・成功の本文は 01-content-spec §5.2 の現行文。下の 7.6 |
| ContactForm | `36:2481` | `fb2b148716e5a0290a339aa794b5606dce646904` | SET（7） | State=Default/Error/Loading/Failed/Duplicate（Desktop）、Device=Desktop/Mobile | なし（各項目は FormField の instance）。**ボタン下の注記の既定値は 01-content-spec §5.1 の確定文言**（2026-10-01 に 7 variant を差し替え。旧「通常【要記入】営業日以内に…」は残っていない）。**2026-10-08: 会社名の後に任意 2 項目を追加**（計画書 B-5）— `Field / 従業員数`（FormField `Type=Select`）・`Field / 社内の IT の担当部署`（`Type=Radio`）。どちらも `Show required`=false・`Show optional`=true。**Error の variant でも Default のまま**（任意なので空でもエラーにしない）、Loading では `Disabled`。Desktop は既存項目と同じ `maxWidth` 640。variant の高さは Default/Desktop 671→835 など各 +164px。Mobile の段を下げ、下の `CookieBanner`・`IconCard` を 383px 下げた |
| **BookingEmbed**（新規） | `108:8011` | `d957b37bdc9ce084bd43fe235620e4ff6b37a9e3` | SET（4） | Device=Desktop/Mobile、State=Default/Error | なし（文言は 01-content-spec §4.6 の 6'-2 で確定。下記 7.3） |
| FormField | `20:2828` | `886f9ad9fbb4623284ac08fee2b1f9785352a5f3` | SET（**20**。2026-10-08 に 12 から追加） | Type=Input/Textarea/Name/**Select/Radio**、State=Default/Error/Disabled/**Focus** | `Label#20:0`・`Helper#20:10`・`Error#20:20`／`Show required#20:30`・**`Show optional#224:24`**（既定 false。2026-10-08 追加）。下の 7.5 |
| ConsentCheckbox | `21:299` | `11f35dd56c6accf911d33f4bdeb04aedb6152ea8` | SET（**4**） | State=Default/Checked/Error/**Focus** | `Link#21:0`・`Label#21:4`・`Error#21:8`／`Show required#21:12` |
| CheckboxField | `21:334` | `76203a7407c60ea369248a1caa9e80364a16dae7` | SET（2） | State=Default/Checked | `Label#21:16` |
| IconCard | `42:2936` | `8e25a72dc952e791997a95bab64263fb783d3b09` | SET（2） | Device=Desktop/Mobile | `Title#42:0`・`Body#42:3`・`Link#42:89`・**`Caption#232:3`**（既定 `【要記入】注記`）／`Show icon#42:9`・`Show avatar#47:3`・`Show image#42:92`・`Show button#42:95`・`Show link#42:98`・**`Show caption#232:0`**（既定 false。2026-10-08 追加。Body の直下〈Link・Button より上〉に出典の欄。`JP/Desktop|Mobile/Caption`・`role/text-muted`・幅 FILL・高さ追従で、改行で複数行にできる。トップ 1-4c のカード 1 で使う）／INSTANCE_SWAP `Icon#42:6` |
| BlogCard | `26:457` | `f5ee307c4e70821d589f2645c1489946ea972300` | COMPONENT | — | `Title#26:0`・`Excerpt#26:1`・`Date#26:2` |
| LogoCloud（ダミー） | `25:485` | `e0a6130533e7d9c5469a8dc7e0e4ebbb7bb5fce3` | SET（2） | Device=Desktop/Mobile | なし |
| TestimonialCard（ダミー） | `25:445` | `b1a0347ebab9668d5d338ff73ab5da6142fe8e99` | COMPONENT | — | `Title#25:3`・`Body#25:4` |
| StatCard（ダミー） | `25:441` | `a62cdb041e1a98c43631a3ede44a86203a05fc4e` | COMPONENT | — | `Label#25:0`・`Value#25:1`（必ず「—」）・`Caption#25:2`／**`Show caption#99:1`**（既定 true。false で出典・注記の行が消え、カード高が 135→113px） |
| CookieBanner | `37:2137` | `a76ad9a28c761e529a31953b3215de07e5a9554d` | SET（2） | Device=Desktop/Mobile | `Title#37:0`・`Body#37:3`・`Link#37:6`。**`Body` の既定値は 2026-10-08 に 01-content-spec §8.1 の現行文（ADR-25。Google アナリティクスと PostHog）に差し替えた**（下の 7.5） |
| ImagePlaceholder | `19:681` | `024f3fa2b80063f88a835f725cdce6fa95a2d7cc` | COMPONENT | — | `Label#19:1` |
| ChatWidgetPlaceholder | `39:2163` | `881e16cde7562e31548e47a9235578ed2f6b6018` | COMPONENT | — | `Label#39:3` |

各部品の使い方・注意は Figma の description に書いてある（右パネルか `node.description`）。

### 7.1 サイト部品を使うときの約束

1. **kit のボタンのラベルは TEXT プロパティにできない。** instance の中の TEXT（多くは名前が `Label`）を直接書き換え、**主ボタンなら `UI/Button`、副ボタンなら `UI/Button Subtle` を当て直す**（§8 のレシピ）。
2. **variant セットの TEXT プロパティの既定値は、セット全体で 1 つ**（Figma の仕様）。`SourceDownloadBlock` を Strong に切り替えても Title は Subtle の文言のままなので `setProperties()` で差し替える。
3. **exposed instance** は `inst.exposedInstances` で取る。Badge の文言、Input の値、ナビの active、アイコンの差し替えはここから。
4. 幅は置いた先で `layoutSizingHorizontal = 'FILL'`。Desktop はコンテンツ幅 1152（左右 144 = `layout/gutter-desktop`）、Mobile は 358（左右 16）。
5. カードを横並びにして高さをそろえるときは `layoutSizingVertical = 'FILL'` だけでよい（`PricingCard`・`ServiceCard` は外側が `SPACE_BETWEEN` なのでボタンが下端でそろう）。instance 側で `primaryAxisAlignItems` を触らない。
6. **instance の中の層は `resize()` できない**（エラーを出さずに無視される）。ただし **`layoutSizingHorizontal` と `textAutoResize` は設定できる**（builder-site が 2026-10-01 に実地で確認）。固定幅にしたいのでなく「親に合わせたい」「文字の高さに追従させたい」だけなら、この 2 つで足りることが多い。
   - 例: `Basic Table Cell - Nova` は、**セルを縦 HUG・見出しセルを縦 FILL** にしないと行が文字の高さに追従しない（法務ページの表 129 テキスト / 77 行をこれで解決）。
   - 本当に大きさ違いが要るときは design-system に依頼する（部品側に別の枠と BOOLEAN を用意する）。
   - **instance の「ルート」は制約が違う。** ルートなら塗り・線・角丸・余白を上書きできる（`CTAButton` の内側余白 10→16px、`Pagination` の未バインドの塗りはこれで直した）。上書きできないのは**サブレイヤー**の寸法だけ。
7. **非表示のレイヤーは instance に含まれない。** `FAQItem` の Closed の Answer などは `findAll()` に出てこないが、`inst.componentProperties['Answer#39:0'].value` では読める。閉じた FAQ でも Answer は必ず設定する。
8. **INSTANCE_SWAP でアイコンを差し替えたら色を当て直す**（差し替え後は kit の既定色で入る）。強調アイコンは `role/text-accent-subtle`、本文中のアイコンは `role/text-body`。
9. 部品を直さないと収まらないときは **instance を detach せず、design-system に SendMessage で依頼する**。
10. **アクセント色を使ってよい場所**: 主 CTA のボタン（`CTAButton`）、テキストリンク、強調バッジ、強調したいアイコン。**セクションの背景・枠線には使わない**（§5.4 の青 10%）。
11. **テキストリンクには下線が入っている**（§9.5）。`Link` / `Sub link` / `Detail link` / `Link / *` という名前の TEXT ノード **55 件**が `role/text-link` ＋ `UNDERLINE`。instance 側で外さない。
12. **TEXT プロパティの既定値 17 件は `【要記入】…` という印になっている**（本書 §7.4）。`【要記入】見出し` / `リード文` / `本文` / `金額` / `期間` / `注記` / `説明` の 7 種。**置いたら必ず上書きする。** 上書きを忘れると画面に印が出る。
    - **仕様書側の `【要記入】` とは別物。** `01-content-spec.md` の未決事項（契約の書類・契約期間など）は**画面に出すことが決まっている**もので、公開前に埋める。部品由来の印は**出てはいけない**もの。
    - **検査では文字列で区別する。** 部品由来は `【要記入】` の直後に上の 7 語のいずれかが続く。`【要記入】` だけで数えると両方が混ざる（2026-10-01 時点で仕様書側が 34 件ある）。
    - **ページでも区別する。** `03 Components` では印が variant の見本として**出ているのが正常**。違反として数えるのは builder のページ（`4:5`〜`4:11`）だけで、部品ページは既定値の走査だけで見る（qa-reviewer が 55 件の誤検知を直した件）。

### 7.2 `Steps` の既定文言（2026-10-01 追記）

**variant ごとに既定の文言が入っている。** 別の用途で使うときは全段を必ず差し替える。差し替え漏れがあると、その段だけ別セクションの文言が画面に出る。

| variant | 既定の内容 |
|---|---|
| Count=5 | 事業経営基盤の PDCA（観測 / 提案 / 承認 / 反映 / 検証） |
| Count=6 | **2026-10-08 に全段 `【要記入】見出し` / `【要記入】本文` に変えた**（旧: 受託開発の流れ〈要件定義 / 設計 / 開発 / テスト / リリース / 運用保守〉。B-4 で 3-6 が 5 段の別の工程になり、正しい場所が無くなったため。使っているのは 14 Contact の「ご相談の流れ」7 件で、全段の見出しを instance 側で持っており、変更後も印は出ていないことを実測した） |
| Count=4 | Count=5 の先頭 4 段 |

**1 段でも使わないなら、Body に半角スペースを入れるのではなく `Count` を 1 つ小さい variant に変える。** 空の段が残ると矢印と折り返し位置がずれる。

**見出しだけの手順にするときは `Show body#128:0` を false にする（2026-10-01 追加・既定 true）。** Body に半角スペースを入れて空にすると、**その段だけ本文 1 行ぶん高くなって段がそろわない**。実例: 14 Contact の「ご相談の流れ」7 instance では、1〜4 段目は Body を隠し、5 段目だけ半角スペースが残っていたため、**5 段目が 53px・ほかが 40px** と 13px ずれていた。**全段そろえて false にする。**

`Title` と `Number` は **6 variant・全段とも `UI/Card Title`（20px）** で統一してある（部品側に段ごとの差は無い）。1 段だけ `UI/Label`（14px）に落とすと段の高さがそろわなくなるので、変えるなら全段そろえる。部品側に小さい版が要るなら design-system に依頼する（`Size` 軸を足すと Direction 2 × Count 3 × Size 2 = 12 variant になるため、必要性を確認してから入れる）。

### 7.3 `BookingEmbed`（2026-10-01 新規）

完了画面（`/contact/thanks`）の 6'-2 で使うオンライン面談の予約枠。仕様は `01-content-spec.md` §4.6 の 6'-2。

| variant | 幅 | 高さ | 中身 |
|---|---|---|---|
| Device=Desktop, State=Default | 720 | 869 | 見出し（H2・navy.700）＋ 本文 ＋ 予約枠 720×640 ＋ 注記 3 行 |
| Device=Desktop, State=Error | 720 | 141 | 見出し ＋ `Alert`（Type=Neutral・`Lucide / info`） |
| Device=Mobile, State=Default | 358 | 877 | 同上（枠は全幅×560） |
| Device=Mobile, State=Error | 358 | 224 | 同上 |

- **予約枠は実物を作らない。** Cal.com が描画するため、`ImagePlaceholder` と同じ破線（`role/surface-subtle` ＋ `role/border` の 1px・dash 6/4・`radius/md`）の枠を置く。Chatwoot のウィジェットと同じ扱い。
  - **注記 3 行目は「範囲の塗り」で色と下線を当てている。** `くわしくは`＝`role/text-muted` / `プライバシーポリシー`＝`role/text-link` ＋ 下線 / `をご覧ください。`＝`role/text-muted` の 3 セグメント。
    **`characters` で文言を書き換えると、この範囲指定が消えて下地の塗り 1 色に戻る。** 書き換えたら**範囲の色と下線を当て直す**こと（本書 §8.7）。
    下地は `role/text-muted` にバインドしてあるので、万一範囲が消えても**露出するのはブランドの色**で、kit の色には戻らない（2026-10-01 に builder-site の指摘で確認）。
  - **枠の中の文字は「予約枠」だけ**（2026-10-01 に「予約枠（Cal.com の埋め込み）」から短縮）。**説明は dev annotation に書き、枠の中に入れない。** 理由は 2 つ: ①「説明の全文が文言の指定として読まれる」事故を避ける（§1.5 のチャットの枠で実際に起きた）② 6'-2 は**製品名を画面に出さない**と決めており、枠のラベルだけ Cal.com が残るのは意図とずれる。
- **`State=Error` を必ず実装に渡す。** この画面が商談プロセスの唯一の入口で、埋め込みが落ちると予約もメールもできない行き止まりになる。セルフホストの予約システムは ALB の後ろの他の 3 システムと同時に落ちうる（`DetailedDesign/02` の 1.3）。
- **注記 3 行を消さない。** とくに 2 行目「ご予約が成立すると…Google カレンダーに送ります。」は必須。**予約のボタンを押す前に、外に出る情報を知らせる**のがこの注記の役目で、押したあとに知らせても意味がない。3 行目の「プライバシーポリシー」は `/legal/privacy` へのリンク（下線 ＋ `role/text-link` を範囲指定で当ててある。新しいタブ）。
- **`State=Error` では本文と注記を出さない。** 枠が無い以上「空いている日時が表示されます」は事実と違い、予約が成立しないかぎり Google への提供も起きないため。
- 文言は変えない。とくに「確認のメールが届きます」を「ComeGin からお送りします」に書き換えない（送信経路が未確定で、二重に届く可能性がある。01-content-spec §10.5 の B7）。「外部のサービス」とも書かない（Cal.com はセルフホストのため事実と違う）。
- 計測: 枠が 50% 見えたら `booking_viewed`、予約完了の通知で `booking_scheduled`（`DA-02`）。**CV には数えない。**

---

### 7.4 部品の既定値に、特定のセクション向けの文言を入れない（2026-10-01 の規則）

**既定値は `【要記入】` のように、それ自体が異常だと分かる印にする。**

完成した日本語の文を既定値にすると、**差し替えを忘れてもそのまま画面に出てしまい、目視レビューでも検査でも通る**。`Title` や `Lorem` なら一目で分かるが、日本語として成立している文は気づけない。

2026-10-01 に次の 2 件を変更した。

| 部品 | プロパティ | 変更前の既定値 | 変更後 |
|---|---|---|---|
| `SectionHeading` | `Lead#21:24` | 「ComeGin の事業経営基盤は、次の 5 つのステップを繰り返します。AI エージェントが…」 | **`【要記入】リード文`** |
| `CTABanner` | `Body#27:5` | 「どこから手を付けるべきかの整理からご一緒します。相談は無料です。」 | **`【要記入】本文`** |
| `CTABanner` | `Title#27:0` | 「まずは、いまの課題をお聞かせください」（**トップ 1-11 の旧タイトル。仕様書では差し替え済み**） | **`【要記入】見出し`** |
| `SectionHeading` | `Title#21:19` | 「観測から検証までを、ひとつのループに」 | **据え置き**（下記） |

**`Title` のほうが危ない。** `Lead` / `Body` には `Show…` の切り替えがあるが、**`Title` は常に表示される**。新しく置いて入れ忘れると、仕様書から消えたはずのコピーがそのまま画面に出る。

**`SectionHeading` の `Title#21:19` は据え置いている。** 既定値「観測から検証までを、ひとつのループに」は**トップ 1-5 の現在の正しいタイトル**で、10 Top の 5 instance（`42:2978` / `110:3253` / `42:6246` / `110:3335` / `110:3417`）が**上書きを持たずに既定値へ依存している**。先にこの 5 件へ同じ文字列を明示的に入れてから既定値を変える。順序を逆にすると 1-5 の見出しが印に化ける。

`【要記入】` を選んだのは、**既にこのプロジェクトの検査対象の印**だから（`01-content-spec.md` の未決箇所に使っており、`qa-audit.js` でも拾える）。新しい印を作らず既存の検査に乗せる。

**見つかった経緯**: builder-site が「`Show…=false` で隠れている既定値 853 件」を洗い出す過程で、`SectionHeading` の `Lead` にトップ 1-5 専用の文が入っていることに気づいた。builder-sales の実測では、**トップ 1-5 の `Lead` は既定値と書き出しの 30 字がほぼ同一**で（違いは「5 つ」→「5つ」の助数詞の密着と文の分割だけ）、**完全一致で比較していなければ誤判定していた**。この紛らわしさは既定値がそのセクション由来である以上避けられない。

**既定値を変えるときの順序**: 既定値は**上書きしていない instance すべてに伝播する**。変える前に「表示されていて、かつ上書きが無い」instance が 0 件であることを**完全一致で**確かめる。1 件でもあれば、先にその instance へ明示的な値を入れてから既定値を変える（順序を逆にすると、見えている文言が印に書き換わる）。

#### 既定値と同じ値を明示的に持たせたいときの落とし穴（2026-10-01・builder-sales が発見）

**instance のプロパティ上書きは、値が既定値と同一文字列だと「登録されたか」を確認できない。** `componentProperties` は解決後の値しか返さないので既定値由来か上書き由来かを区別できず、`overrides` は node 単位のフィールド（`fills`・`characters` の直接編集）用で、component プロパティの上書きは出てこない。

**確認できるのは既定値を変えた直後だけ**（化ければ登録されていなかった）。したがって、

1. builder が 5 件に明示値を入れる（値は既定値と同じ文字列）
2. design-system が既定値を `【要記入】…` に変える
3. **その直後に** builder が同じ 5 件を実測する
4. 化けていたら、**既定値が別の文字列になった後なら `setProperties()` 1 回で確実に上書きが作れる**ので入れ直す

という**組で動かす**。2 と 3 のあいだに他の確認を挟まない。

実例: `SectionHeading.Title#21:19` の既定値「観測から検証までを、ひとつのループに」は**トップ 1-5 の現行の正しいタイトル**で、10 Top の 5 instance（`42:2978` / `110:3253` / `42:6246` / `110:3335` / `110:3417`）が上書きを持たずに依存していた。**トップのヒーロー直下の H2 なので、化けたまま残ると最も目立つ場所に印が出る。**

これは「書いたことではなく、出た結果を測る」（§8.5）が**原理的に測れない**ケースで、**測れる瞬間を作ってから測る**という形の対処になる。

**確認した実数（最終・2026-10-01 19:36 JST・`setCurrentPageAsync` で 1 ページずつ）**

既定値 17 件を印に変えたあと、7 ページで **`【要記入】{見出し|リード文|本文|金額|期間|注記|説明}` の表示は 0 件**。

| ページ | ノード | 文字 | 部品由来の印 | 仕様書側の `【要記入】` |
|---|---|---|---|---|
| 10 Top | 2,467 | 803 | **0** | 0 |
| 11 Services | 1,360 | 382 | **0** | 0 |
| 12 Pricing | 833 | 243 | **0** | 4 |
| 13 About | 514 | 142 | **0** | 4 |
| 14 Contact | 2,201 | 565 | **0** | 0 |
| 15 Blog | 1,087 | 344 | **0** | 0 |
| 16 System | 1,521 | 533 | **0** | 26 |
| **計** | **9,983** | **3,012** | **0** | **34** |

仕様書側の 34 件は未決項目（契約の書類・契約期間など）で、**この変更とは無関係**。印を数えるときは**部品由来の印と仕様書側のプレースホルダを文字列で区別する**（`【要記入】` だけで数えると混ざる）。

#### 全 53 件の洗い出し（2026-10-01 19:33 JST）

**母数: 28 部品 / 112 プロパティ中 TEXT 型 53 件。** 依存の確認は 7 ページ・instance 2,083 件・プロパティ照合 1,859 回。

| 分類 | 件数 | 扱い |
|---|---|---|
| `【要記入】…` に変更した | **17** | 下の一覧 |
| どこに置いても正しい／それ自体が仮の印 | 21 | そのまま |
| **判断して据え置いた（依存あり）** | **11** | **下の一覧。見落としではない** |
| 判断して据え置いた（項目種別で正しい） | 4 | `FormField.Helper`/`Error`、`CheckboxField.Label`、`IconCard.Link` |

あわせて 53 件を**禁止表現**と**単位の前のスペース**で検査した。結果は下の「既定値も検査の対象にする」。

#### 判断して据え置いた 11 件（依存 72 件）

**これらの既定値は「中立な印」ではなく「最も多く使う正しい値」である。**

| 部品 / プロパティ | 既定値 | 依存 |
|---|---|---|
| `PageIntro / Title#29:0` | 受託開発：バイブコーディングから要件定義〜運用保守まで | 2 |
| ~~`FAQItem / Answer#39:0`~~ | ~~はい。環境構築に使うソースコードは無料で配布しています。…~~ → **2026-10-08 に `【要記入】本文` に変更**（G-A で Q1 の回答が変わり、旧文が正しい場所が無くなった。変更前に全ページで旧文に頼っている instance が 0 件、変更後に印が出ている instance が 0 件であることを実測） | 5 |
| `ServiceCard / Title#23:0` | 環境構築 | 7 |
| `ServiceCard / Product 1#23:6` | 本プロジェクトの環境構築 | 7 |
| `ServiceCard / Product 2#23:15` | 受託開発：要件定義〜運用保守 | 28 |
| `PricingCard / Product#24:0` | 本プロジェクトの環境構築 | 2 |
| `PricingCard / Note#24:4` | ソースコードは無料で配布 | 2 |
| `StepItem / Title#22:3` ／ `Body#22:6` | 観測 ／ 検索順位、流入、問い合わせ、表示速度などの… | 5 ずつ |
| `StatCard / Label#25:0` | 導入社数 | 5 |
| ~~`SourceDownloadBlock / Title#35:0`~~ | ~~環境構築のソースコードを無料で配布しています~~ → **2026-10-08 に `【要記入】見出し` に変更**（下の 7.6。G-A で全ページの見出しが変わり、既定値が正しい場所が無くなったため） | 4 |

据え置いた理由（lead 判断・2026-10-01）:

1. **72 件すべてが「いま正しい使い方」**。`ServiceCard / Product 2` の 28 件はどれも本当に「受託開発：要件定義〜運用保守」のカードで、セクション固有のコピーではなく**最も多く使う正しい値が既定値になっている**状態
2. **72 件の打ち直しは、それ自体が事故の源**。しかも全件が「値が既定値と同一文字列」の問題（上記）を踏むため、1 件ごとに「既定値を変えた直後に実測」が必要になる。**防ごうとしている誤りより、作業で入る誤りのほうが大きい**
3. **Figma は派生物で保守されない**（`BA/02-capability-map.md:106`）。リスクは実装側に移る

**したがって次の 2 点が残る。**

- **`Show…` を true にして差し替えを忘れると、もっともらしい値が出る。** 印は出ない
- **実装（Astro）に写すときは、この既定値を props のデフォルトに持ち込まない**（`03-handoff.md` の H-16）

#### 既定値も検査の対象にする（2026-10-01 に穴が見つかった）

**描画されている TEXT だけを検査していると、`componentPropertyDefinitions` の中が検査されない。**

| 検査 | 変更前 | 変更後 |
|---|---|---|
| 禁止表現（GL §8.3・§8.4） | **1 件** — `ServiceCard / Note#23:24` の「**弊社**」 | **0 件** |
| 単位・助数詞の前のスペース（§6.4-4） | **8 件** — 「23,000 円」「1 日」「60〜90 日」「2 つ」 | **0 件** |

**「弊社」は 2026-10-01 に 21 instance で「ComeGin」に直した語が、部品の既定値に 1 件生き残っていたもの。** 両 builder の「禁止表現 0 件」は描画されている TEXT の走査結果で、既定値は対象外だった。**検査の母数に既定値 53 件を含める。**

#### 分類を誤っていた 2 件（検査が拾った）

`SourceDownloadBlock` の `Title` と `Body` を最初「この部品専用だからどこでも正しい」と (a) に分類したが、**単位スペースの検査で既定値だけ「23,000 円」と空きがあることに気づき**、instance の実値を見たところ **ページごとに文言が違った**。

| | 10 Top | 11 Services / 12 Pricing |
|---|---|---|
| `Title` | 自分の手で立ち上げたい事業所へ、ソースコードと構築の手順をお渡しします | 環境構築のソースコードを無料で配布しています |
| `Body` | お渡しするのは、ComeGin が自分の事業で使っている基盤一式です。… | この基盤をご自身の手で立ち上げたい方へ。… |

つまりセクション固有だった。**`Body` は依存 0 件だったので `【要記入】本文` に変更**、`Title` は依存 4 件のため据え置き。
**部品の用途が 1 つでも、文言が 1 つとは限らない。** 分類は既定値の文面ではなく、**instance の実値を突き合わせて**決める。

**実装側にも同じ罠が移る。** Astro のコンポーネントの既定 props に特定セクションのコピーを入れない（`03-handoff.md`）。

#### 2026-10-08 の追加と変更（design-system）

**TEXT 型プロパティは増えていない（53 件のまま）。** 足したのは BOOLEAN の `FormField / Show optional#224:24` 1 件で、プロパティの母数は 112 → **113**。既定値の 4 分類は、T2 の時点では変わらなかった。**G-B の後に `SourceDownloadBlock / Title#35:0` を据え置きから印に移したので、印 18 / そのまま 21 / 据え置き 10 / 項目種別で正しい 4**（§7.6）。**さらに builder-sales の依頼で TEXT を 2 件足した**（`IconCard / Caption#232:3` ＝ `【要記入】注記`、`StepItem / Period#232:9` ＝ `【要記入】期間`。どちらも印。BOOLEAN の `Show caption#232:0`・`Show period#232:6` は既定 false）。**最新: TEXT 55 件（印 23 / そのまま 19 / 据え置き 9 / 項目種別で正しい 4）、プロパティの母数 117。**（qa-reviewer の 13:31 の走査を受けて `FAQItem / Answer` を据え置きから印に移した。`AnnouncementBanner` の `Text`・`Short text` も lead の指示で `【要記入】本文` にした。10 Top の 5 件は、既定値が旧文だった時点から新しい文を表示していた＝明示値を持っていたので、変更後も表示は変わらないことを実測した）

| 部品 / 対象 | 既定値 | 扱い | 理由 |
|---|---|---|---|
| `CookieBanner / Body#37:3`（「どこに置いても正しい」21 件の 1 つ） | **変更**。旧「サイトの改善のため、同意いただいた場合に限り、行動分析ツール（PostHog）で…アクセス数の集計（Umami）は Cookie を使わず…」→ 01-content-spec §8.1 の現行文 | そのまま（完成した文を既定値に置く） | この部品の本文は全画面で 1 つ。**ただし旧既定値は 2026-10-01 の K3（チャットを足した版）よりさらに前の文だった**。10 Top の 2 instance は 10-01 版を上書きで持っていたため、既定値が古いことに気づけなかった。下の 7.5 の「上書きが残っている instance」 |
| `FormField` `Type=Select` の中の TEXT「選択してください」 | 新規（TEXT プロパティではない。variant の中の文字） | そのまま | 01-content-spec §5.1 のプレースホルダで、Select を置くすべての場所で正しい |
| `FormField` `Type=Radio` の中の TEXT「ある」「ない」「わからない」 | 新規（同上） | **判断して残した**（lead の確認待ち） | 使用は 14 Contact の 1 用途だけで、その用途では正しい。文ではなく 3 択の答えで、別の 3 択に使うなら必ず書き換える（description に明記）。`【要記入】…` の 7 語に「選択肢」は無く、印にすると検査に乗らないため |
| `FormField / Label#20:0` の既定値「メールアドレス」 | 既存のまま | 既存のまま | **`Type=Select`・`Type=Radio` を置いて Label を入れ忘れると「メールアドレス」が出る。** variant セットの既定値はセットで 1 つなので Type ごとに変えられない。置いたら必ず Label を上書きする |

### 7.5 `FormField` の Select・Radio と「任意」の表示（2026-10-08 追加）

計画書 B-5（創業計画書の GTM）で無料相談フォームに任意 2 項目を足したため、`FormField` を広げた。

| 追加 | 中身 |
|---|---|
| `Type=Select` × State 4（`224:14074` Default / `224:14101` Error / `224:14127` Disabled / `224:14153` Focus） | kit の **`Select & Combobox - Nova`**（Size=Large・1 Line。Input の Size=Large と同じ 36px）。State は Default→`Placeholder`、Error→`Error`、Disabled→`Disabled`、Focus→`Focus`。プレースホルダ「選択してください」（`JP/UI/Text`・`role/text-muted`）。**開いた状態（選択肢の一覧）は描かない**。選択肢は 01-content-spec §5.1 を正とする |
| `Type=Radio` × State 4（`224:14179` / `224:14209` / `224:14238` / `224:14268`） | kit の **`Radio Group - Nova`**（Checked?=False・Layout=Inline・Weight=Normal）を 3 個、横並びの `Options`（間隔 `space/6`、折り返しあり・行間 `space/2`）に入れた。ラベル「ある」「ない」「わからない」（`JP/UI/Text`・`role/text-body`）。Disabled は kit の `Disabled=True`、Focus は 1 個目の `Radio - Nova` を `State=Focus` |
| BOOLEAN `Show optional#224:24`（既定 false）と `Label row/Optional` | 全 20 variant の「必須」の右に「任意」の Badge を置いた。**作り方は「必須」と同じ**（kit `Badge` Secondary・地 `role/surface-subtle`・角丸 `radius/full`・`JP/UI/Small`）で、**文字色だけ `role/text-muted`** にして重みを下げた（必須は `role/text-heading`）。既定 false なので既存の instance の見た目は変わらない |

- **任意の項目は `Show required`=false・`Show optional`=true。** 両方 true にしない。
- **「任意」の表示規則（01-content-spec §5.1。2026-10-08 に ia-copy が規定）**: 入力欄（Input・Select・Radio Group・Textarea）は、必須なら「必須」、任意なら「任意」の Badge をラベルの右に付ける。**選んだ variant は kit `Badge` の `Variant=Secondary`（「必須」と同じ）で、文字色を `role/text-muted` に落とした**もの。**例外: 無料 DL フォームの任意のチェックボックス（お知らせメール。`CheckboxField`）には「任意」を付けない**（`CheckboxField` に `Show optional` は無い）。
- `Type=Select`・`Type=Radio` は **Helper を既定で非表示**（Name と同じ）。
- **Radio の Error に Invalid の見た目は無い**（kit の `Radio - Nova` に Error の状態が無い。`Error Focus` はフォーカス時のもの）。Error 文だけで示す。いまの用途は任意項目なので Error は使わない。
- 色は既存の Input の当て方に合わせた。kit の色変数（`general/input`・`general/destructive`・`general/muted foreground`・`alpha/*`）を **枠 `role/border`、エラー枠 `semantic/danger`、矢印 `role/text-muted`、フォーカス時の地 `role/surface`、Radio のフォーカスの輪 `role/focus-ring`** に当て直し、Focus のエフェクトは Input と同じ `focus/ring` スタイル。**`FormField`・`ContactForm`・`CookieBanner` の中の kit 色変数の参照は 0 件**（2026-10-08 実測）。
- `Label row/Optional` の上下余白は「必須」と同じ 2px（kit の変数のまま）。§9.4 の据え置きと同じ扱い。
- **`clone()` で variant を複製すると、中の層のコンポーネントプロパティ参照（`componentPropertyReferences`）が外れる。** 今回 8 variant で踏み、Label・Required・Helper・Error の参照を付け直した。**既存の Focus 3 variant（`85:13024`・`85:13044`・`85:13057`）も参照が外れたままだった**（2026-10-01 の追加時のものと思われる。`Label` を `setProperties` で変えても表示が「メールアドレス」のまま、`Show required` も効かない）。あわせて **`Type=Input, State=Focus` はフォーカスリングが描画されていなかった**（エフェクトは付いている）。どちらも同日に直した（下の「Focus の variant の修正」）。

#### 上書きが残っている instance（2026-10-08 時点・builder の担当ページ）

| ページ | instance | 状態 | 直し方 |
|---|---|---|---|
| 10 Top | `42:4936`（`42:4860` 1-13 Cookie バナー表示中 / Desktop）・`44:5515`（`44:5441` 同 / Mobile） | `Body#37:3` を 2026-10-01 版（「行動分析ツール（PostHog）で…」「アクセス数の集計（Umami）は…」）で上書きしている。**部品の既定値を直しても追従しない** | **対応済み（2026-10-08・builder-sales）**。§8.1 の本文に差し替え、和欧の文字スタイルも当て直した。10 Top の「Umami」は 0 件 |

10 Top 以外のページに `CookieBanner` の instance は無い（2026-10-08 に全 11 ページで実測）。

#### Focus の variant の修正（2026-10-08・lead の指示。H-8 フォーカスリングを消さない）

**2026-10-01 に足した State=Focus の variant 10 件（§1 の表）のうち、リングが描画されていたのは 0 件だった。** 原因は 2 つ。

1. **DROP_SHADOW の spread は、clipsContent が有効なフレームか、矩形・楕円にしか効かない**（Figma の仕様）。`focus/ring` スタイルは spread 2px（白）＋ 4px（`role/focus-ring`）でリングを描くため、条件を外れると何も出ない
   - `FormField` の Input・Textarea・姓（Focus）: clip は有効だが**塗りが空**で、影が文字の形からしか作られなかった → 地に `role/surface` を当てた（入力エラー時の Input と同じ）。姓・名の親 `Name inputs`（`85:13061`）は clip でリングを切っていたので clip を外した
   - `ConsentCheckbox` Focus（`85:13079`）: checkbox の外枠（`85:13081`）が **clip なし**で spread が無視されていた → リングを見えている丸の矩形 `Background` に移し（kit の Radio と同じ作り）、地に `role/surface`。親の `Row` の clip を外した。**この variant はセットの枠の外（y=113、セットの高さ 96）にあって見えなかった**ので、セットを 157px に広げた
   - `CTAButton` Focus 6 variant: 中の kit `Button` が **clip なし** → `clipsContent` を有効にした（ラベルは枠内に収まっている）
2. **`clone()` で作った variant のプロパティ参照が外れていた。** `FormField` Focus 3 件（`85:13024`・`85:13044`・`85:13057`）と `ConsentCheckbox` Focus（`85:13079`。Link・Label・Show required・Error）。**この 4 variant を使う instance はファイル全体で 0 件**（全 11 ページで実測）だったので、消える上書きは無く、そのまま付け直した

**確認**: この 10 variant と、今回足した Select・Radio の Focus 2 件を余白のある一時フレームに置いて撮影し、リングが出ること、Label などの上書きが効くことを確かめた（一時フレームは削除済み）。**部品の枠ちょうどで撮影するとリングは写らない**（リングは枠の外に描かれる）。確認するときは余白のあるフレームに置く。

**`03 Components` の配置**: `FormField` が 2026-10-01 の Focus 追加の時点から `CTAButton`・`ConsentCheckbox`・`CheckboxField` と重なっており、今回の 8 variant でさらに `SectionHeading` とも重なったため、左の列（x < 4000）の 23 部品を前の部品の下端から 160px 空くように**下へだけ**動かした。部品の中身・ID・instance は変わらない。ページ内の重なりは 0 件。

#### 判断済み（2026-10-08・lead）

- `Type=Radio` の既定のラベル「ある」「ない」「わからない」は残す
- `FormField / Label#20:0` の既定値「メールアドレス」は残す。Select・Radio の `FormField` で Label が「メールアドレス」のままのものは qa-reviewer の検出項目にする

### 7.6 `SourceDownloadBlock` と `SiteFooter` の G-A 改訂（2026-10-08・G-B 承認後）

01-content-spec の §4.1 1-9・§4.2 2-7・§5.2・§1.4・§6.3.1 の現行文で反映した。

| 部品 | 変えたもの |
|---|---|
| `SourceDownloadBlock`（全 20 variant） | ① 本文の下（`Text` フレームの末尾）にリンク `Link / ソースコードを見る（GitHub）` を追加（`33:652` の `232:11511` を元に複製）。kit `Button - Nova` の `Size=Default, Variant=Link`、`Show right icon`=true・右アイコン `Lucide / external-link`、左右の余白 0（本文と左端をそろえる）。文字は `JP/UI/Label`＋「GitHub」だけ `Latin/UI/Label`（IconCard の `Link` と同じ段）、`role/text-link`＋下線、アイコンの塗りも `role/text-link`。**CTA ではない**（`cta_id` を付けない）。**Success でも残る**（`Text` フレームは Success でも消えない）。Mobile は見出し → 本文 → リンク → フォームの順になり、高さが 14px 伸びた ② ボタン「ソースコードを受け取る」→「構築の手順書を受け取る」（Loading の「送信中…」以外の 14 variant）③ ボタン下の注記「メールアドレスだけで受け取れます。構築の手順書を、メールでお送りします。」（16 variant）④ 成功の本文 §5.2 の現行文（4 variant）⑤ `Title#35:0` の既定値を `【要記入】見出し` に |
| `SiteFooter`（D/M） | 列 3「ComeGin について」の最後に「ソースコード（GitHub）」（体言止め。§1.4）。既存の「ソースコード無料 DL」を複製して書き換えたので、書式（`JP/UI/Text`＋`Latin/UI/Text`、`role/text-link`、下線）は同じ。外部リンクのアイコンは付けない（§1.4 に指定が無い） |

- **リンクの文言は全ページ共通なので、TEXT プロパティにせず部品に固定で持つ**（§7.4 の「どこに置いても正しい」）。表示・非表示の BOOLEAN も足していない（§6.3.1 で、置くすべてのブロックに出す。8-6 の記事中の小型版は別部品の `CTABanner` で、そちらには置かない）。
- **`Title#35:0` を印にした理由**（H-16）: 既定値「環境構築のソースコードを無料で配布しています」は旧 2-7 の見出しで、G-A で全ページの見出しが「公開しています」の文に変わったため、**既定値が正しい場所が 1 つも無くなった**。2026-10-01 に「依存 4 件のため据え置き」とした 4 件（11 Services・12 Pricing）は、変更の直後に `【要記入】見出し` が出ることを実測した（＝既定値に依存していた。上書きを持っていなかった）。**見えていた文が正しい文から印に変わったのではなく、古い文から印に変わった**ので、§7.4 の「順序」の規則（正しい文を先に明示値にしてから既定値を変える）には当たらない。

#### instance の追従（2026-10-08 に builder の 7 ページで実測）

**部品で変えたもの（リンク・ボタン・注記・成功文、フッターのリンク）は全 instance が追従した。** 追従しないのは instance が上書きで持っている見出しと本文だけで、これは builder が 01-content-spec の文に差し替える。

| ページ | instance | 見出し | 本文 | 差し替えに使う節 |
|---|---|---|---|---|
| 10 Top | `42:3791`（`42:2`）・`110:3294`（`42:4860`）・`42:6844`（`42:5742`）・`110:3376`（`44:5338`）・`110:3458`（`44:5441`） | 旧文「自分の手で立ち上げたい方へ、ソースコードと構築の手順をお渡しします」 | 旧文「お渡しするのは、…」 | §4.1 1-9（本文は 3 文） |
| 11 Services | `46:8608`（`46:8030`）・`46:9326`（`46:8876`） | **`【要記入】見出し`**（既定値に依存していた） | 旧文「この基盤をご自身の手で…」 | §4.2 2-7 |
| 12 Pricing | `45:7876`（`44:6574`）・`46:7392`（`46:486`） | **`【要記入】見出し`** | 旧文 | §4.2 2-7（4-7 は 2-7 を参照） |
| 15 Blog | `42:5599`（`42:4374`）・`42:6112`（`42:5786`）・`44:5121`（`42:6400`）・`44:7169`（`44:6472`） | 旧文「記事で紹介している仕組みのソースコードと構築の手順を、無料でお渡しします」 | 旧文「読むだけで終わらせたくない方へ。メールアドレスだけで受け取れます。」 | §4.7 7-5（8-8 の強調版も同じ文） |
| 13 About・14 Contact・16 System | なし | — | — | — |

- 見出し・本文に欧文が入る（1-9 の本文の「ComeGin」「23,000円・1日」など）ので、差し替えたら和欧の文字スタイルを当て直す（§8.2 の `applyMixed`）。
- **`SiteFooter / Description#32:0` の既定値を §1.4 の現行文にした**（旧「観測・改善提案・人の承認・反映・検証を回し続ける、再帰的自己改善型の事業経営基盤。」）。全ページで同じ文なので H-16 の「最も多く使う正しい値」に当たる（lead 判断）。手順: 32 instance の表示値を実測 → **32 件とも §1.4 と一字一句一致** → 既定値を変更（部品側は「IT」「1」に `Latin/Desktop/Small` を当てた）→ 再実測で **32 件とも表示が変わっていない**ことを確かめた。**instance は 32 件とも Description を上書きで持っていて、文字スタイルが全体 `JP/*/Small` のまま（「IT」が Noto Sans JP）**。文言は正しいので追従の必要は無いが、和欧の当て直しは instance 側（builder）で要る。
- `SiteFooter` の instance は 32 件（10 Top 5・11 Services 4・12 Pricing 2・13 About 2・14 Contact 9・15 Blog 4・16 System 6）で、**全件にリンクが出ている**。Mobile のフッターが 52px 伸びたが、ページのフレームで切れているものは無い（10 Top の状態フレーム 3 件はビューポートの大きさで切り取る作りで、元から切れている）。

#### qa-reviewer の指摘への対応（2026-10-08）

| 指摘 | 原因 | 対応 |
|---|---|---|
| `ContactForm` のライブラリ変数の色 48 件・パレット外 3 件 | **走査の時点の差**。48 件は、T2 の途中で Select・Radio の kit 色変数を当て直す前の状態を数えたものと見られる。当て直した後は、`03 Components` の `ContactForm` も `14 Contact` の 7 instance も 0 件（`qa-audit.js` と同じ `remote === true` で実測）。パレット外 3 件の実体は `CheckboxField` の Badge の文字（#171717）と `Steps` の矢印（#737373）で、ContactForm ではなかった | 0 件を確認。CheckboxField・Steps・FAQItem に残っていた kit の色は、再走査の時点で 0 件だった |
| 「社内の IT の担当部署」の「IT」に Poppins が無い | ContactForm の 7 variant で Label を `setProperties` で入れたため、全体が `JP/UI/Label` になっていた | 7 か所の「IT」に `Latin/UI/Label` を当てた。IconCard の既定の Link「ソースコードを無料 DL」の「DL」も同様に直した |
| リンク「ソースコードを見る（GitHub）」が kit の `alpha/white` を参照 | kit の `Button - Nova` Link のルートの塗り（ほぼ透明の白）が残っていた | 20 variant のリンクのルートの塗りを外した（`fills=[]`）。15 Blog などの instance は部品に追従する |
| SiteFooter のロゴの余白 12px < アイソレーション X 16.52px | 列 1 の `itemSpacing` が `space/3`（12px） | 列 1（Desktop `32:633`・Mobile `32:659`）の間隔を `space/5`（24px）にした（`space/4` は 16px で X に届かない）。Mobile のフッターは 1107→1119 |
| SiteFooter の説明文の「IT」に Poppins が無い | 部品側は直した（上）。instance 32 件は説明文を上書きで持っていて、全体が和文のまま | instance 側は builder の担当 |

**確認**: `qa-audit.js` の判定（C1 パレット外・C3 ライブラリ変数の色・T5 Poppins 漏れ・B7 ロゴのアイソレーションの `isolationGap`）をそのまま抜き出して `03 Components` で回し、**4 項目とも 0 件**（ノード 3,250）。**スクリプト全体は回せていない**。コメントを落として 49,910 字まで縮めたが、`use_figma` に一字一句違えずに貼るのは確実でないため（縮める手順は `qa-audit.js` の冒頭の注記を参照。esbuild が手元に無かった）。

#### 文字スタイル・改行・フッターの再実測（2026-10-08・lead の指示 3 点と builder からの依頼）

**部品で直したもの**

| 対象 | 変更 |
|---|---|
| `ContactForm`・`SourceDownloadBlock`・`SiteFooter` の **Device=Mobile の 13 variant** | 中の文字（入れ子の FormField・ConsentCheckbox・CheckboxField を含む）の `JP|Latin/Desktop/*` を `/Mobile/` に当て替えた（28 ノード）。Body・Small・Caption は D/M で値が同じなので見た目は変わらない。リンクの下線 57 か所が残っていることを確かめた |
| `ChatWidgetPlaceholder`（`39:2164`） | 「チャット」を `JP/Desktop/Caption` → `JP/UI/Small`（Device に依らない段。12px、太さは Regular → Medium）。この部品には Device の軸が無いため |
| `SourceDownloadBlock` の注記（16 variant） | 「メールアドレスだけで受け取れます。」と「構築の手順書を、…」の間に U+2028（末尾 1 字だけの行を解消） |
| `SourceDownloadBlock` のお知らせメールのラベル（入れ子の `CheckboxField`、16 variant の上書き） | 「…受け取る」と「（いつでも配信を停止できます）」の間に U+2028（語の途中の改行を解消）。「ComeGin」に `Latin/UI/Text` |
| `SiteFooter / Description#32:0` の既定値 | 「社内に IT がいなくても、」「1人分の予算で実現する業務改善。」「システム開発と IT コンサルティング。」の 3 行に U+2028 で分けた（「業務改／善」の割れを解消）。Desktop の高さは 392 のまま、Mobile は 1144 |
| `ContactForm` の Error summary（State=Error, Device=Mobile の `36:2473`） | 「入力内容に誤りがあります。」の後に U+2028（「…くださ／い。」の末尾 1 字だけの行を解消。builder-site が 14 Contact の `I47:10878;36:2473` で先に上書きしていた値と同じ）。Desktop（`36:1721`、幅 640）は 1 行に収まるので変えていない |
| `ServiceCard` の Body | **部品側は正常**（既定値 `【要記入】本文`・`JP/Desktop/Small`）。和文が Poppins になっているのは instance の上書き（下） |

**Device スタイルの件数（`qa-audit.js` の S8 と同じ判定。ルートが Mobile のフレームで、文字全体に `/Desktop/` のスタイル）**: `03 Components` は**構造上 0 件**（S8 はルートが FRAME のときだけ数えるため、部品のセットは対象外）。`14 Contact` は **2 件**（`ChatWidgetPlaceholder` だけ。ContactForm の Mobile の分は 0 になった。ChatWidgetPlaceholder は今回直したので次の走査では 0 のはず）。ほかのページで残っているのは **Device の軸を持たない部品**で、部品側では D/M を分けられない: 10 Top 72（ServiceCard 36・Steps 9・TestimonialCard 9・StatCard 9・FAQItem 3・ChatWidgetPlaceholder 3・SiteFooter 3〈説明文の instance の上書き〉）、11 Services 16（ServiceCard 12・PricingCard 4）、12 Pricing 12（PricingCard）、15 Blog 1（IconCard）。**値は D/M で同じ**なので、qa で許容とするか、部品に Device の軸を足すか（既存 instance の切り替えが要る）は lead の判断。

**instance の上書きで追従しないもの（builder の担当）**

| 対象 | ページと instance |
|---|---|
| フッターの説明文（U+2028 の 3 行版に追従していない） | 10 Top `42:6964`・`110:3386`・`110:3468`／13 About `45:6873`・`46:7321`／14 Contact `42:2892`・`42:3678`・`42:4089`・`42:4249`・`47:9416`・`47:9732`・`47:9984`・`47:10885`・`47:11552`／15 Blog `42:5716`・`42:6207`・`44:5312`・`44:7303`／16 System `46:7608`・`46:7677`・`46:8004`・`46:8522`・`46:8850`・`46:9079`（24 件。11 Services 4・12 Pricing 2・10 Top 2 は追従済み）。**2026-10-08: builder-site が 13 About・14 Contact・15 Blog・16 System の 21 件を 3 行版に差し替え済み**（Mobile は `JP|Latin/Mobile/Small`）。10 Top の 3 件も builder-sales が同じ値・`Mobile/Small` にしてあった。**全件対応済み** |
| 無料 DL のお知らせメールのラベル | 10 Top `42:3791`・`110:3294`・`42:6844`・`110:3376`・`110:3458`／11 Services `46:8608`・`46:9326`／12 Pricing `45:7876`・`46:7392`（9 件。15 Blog の 4 件は追従済み）。**2026-10-08: builder-sales が 9 件とも部品と同じ値（U+2028 入り、ComeGin は `Latin/UI/Text`）にした。対応済み** |
| ServiceCard の本文で和文に Poppins | 10 Top `42:6572`・`42:6613`（`42:5742`）・`110:3358`・`110:3359`（`44:5338`）・`110:3440`・`110:3441`（`44:5441`）／11 Services `46:8186`・`46:8236`（`46:8030`）・`46:9157`・`46:9200`（`46:8876`）（10 件。Desktop の 3 件は builder-sales が直し済み）。**2026-10-08: 10 Top の Mobile 6 件は対応済みだった。11 Services の 4 件も builder-sales が和欧を分け直した。対応済み** |

**フッターの切れ・チャットとの重なり**: 32 instance で、ページのフレームの下端で切れているものは無い（10 Top の状態フレーム 3 件はビューポートで切り取る作りで元から切れている）。Mobile の 5 フレーム（10 Top 3・14 Contact 2）で `ChatWidgetPlaceholder` と © の行の**文字枠**が重なるが、チャットは右下固定（制約 MAX）で、© の文字の右端（x≈314）とボタンの左端（x=518）は離れている。**文字には掛かっていない**。

#### ServiceCard・PricingCard の価格行の書体（2026-10-08・builder-sales の指摘）

**部品側は正常**: 金額・期間の既定値は印（`【要記入】金額`・`【要記入】期間`）で、和文に Poppins は当たっていない（ServiceCard 2 variant・PricingCard とも実測）。**TEXT プロパティで入れた値は、範囲ごとの文字スタイルを部品から受け継がない**（§8.7）ので、部品を直しても instance の書体は変わらない。和文まで Poppins になっているのは、どれも**値が数字・欧文で始まる**文字（「7日」「31,250円／回」「4時間／回」「KPI の設計…」「7日間で…」）で、文字全体に 1 つのスタイルが当たった状態。instance 側で `applyMixed` を当て直す（builder-sales の担当）。

| ページ | フレーム | instance と文字 |
|---|---|---|
| 10 Top | `42:2`・`42:4860`（Desktop） | `42:3202`・`110:3276` Period 1「7日」／`42:3250`・`110:3277` Price 1「31,250円／回」・Period 1「4時間／回」 |
| 10 Top | `42:5742`・`44:5338`・`44:5441`（Mobile） | `42:6613`・`110:3359`・`110:3441` Price 1「31,250円／回」 |
| 11 Services | `46:8030`・`46:8876` | `46:8186`・`46:9157` Body「7日間で…」・Period 1「7日」／`46:8236`・`46:9200` Body「KPI の設計…」・Price 1・Period 1 |
| 11 Services | `46:9432`・`47:8950`（サービス詳細） | `47:961`・`47:9067` Period「7日」 |
| 12 Pricing | `44:6574`・`46:486` | `44:7018`・`46:699` Period「7日」／`44:7093`・`46:777` Description「KPI の設計…」・Price「31,250円／回」・Period「4時間／回」 |

#### qa-reviewer の 03 Components の走査（13:31）への対応（2026-10-08）

旧文言 20 件を直した。**変える前に全 7 ページで、既定値に頼って表示されている instance が無いことを確かめ、変えた後に印が画面に出ていないことを実測した。**

| 部品 | 変更 |
|---|---|
| `CTABanner` Type=Inline（D/M） | ボタン「ソースコードを受け取る」→「構築の手順書を受け取る」（G-A。15 Blog の 2 件は instance 側で先に直っていた） |
| `AnnouncementBanner` | Badge「無料配布中」→「無料公開中」。`Text#28:0`・`Short text#28:3` の既定値を `【要記入】本文` に（いったん §4.1 1-1 の現行文にしたが、lead の指示で印にした）。10 Top の 5 件は明示値で新しい文を持っており、変更後も表示は変わらない |
| `FAQItem` | `Answer#39:0` の既定値を `【要記入】本文` に（§7.4） |
| `Steps` Count=6（Horizontal `22:318`・Vertical `22:447`） | 6 段の見出しと本文を印に（§7.2） |
| `BookingEmbed` Device=Mobile の注記 2 行目（`108:7991`） | 「…お知らせするために、」の後に U+2028（「お名／前」の割れを解消） |

**14:05 の再検査を受けて（2026-10-08）**: qa-reviewer の再検査で旧文言・既定値・折り返しの疑いは 0 件。builder-site から預かった 1 件（15 Blog の著者カード `I47:8932;47:11356;19:682` の「画像（準備中）」が Mobile で `JP/Desktop/Caption`）の原因は、**部品 `IconCard` の Mobile の variant の中の Avatar（`47:11356`、既定で非表示）が文字スタイルを上書きで持っていたこと**で、`I47:11356;19:682` を `JP/Mobile/Caption` にした。**`findAll()` は非表示の instance の中まで降りない**ため、先の Mobile の走査で取りこぼしていた。`children` を手で辿る走査で全部品の Mobile の variant（242 ノード）を見直し、もう 1 件（`CookieBanner` の Mobile の本文 `37:2124`。T2' で和文に `JP/Desktop/Small` を当てていた）を `JP/Mobile/Small` にした。**非表示の層まで見る走査では `findAll` ではなく `children` を辿る**（`qa-audit.js` の隠れた既定値の走査と同じ注意）。

## 8. レシピ

### 8.1 フォントの load（毎回スクリプトの先頭で）

```js
await Promise.all([
  ['Noto Sans JP','Regular'],['Noto Sans JP','Medium'],['Noto Sans JP','Bold'],
  ['Poppins','Regular'],['Poppins','Medium'],['Poppins','SemiBold'],['Poppins','Bold'],
  ['JetBrains Mono','Regular'],
  ['Geist','Regular'],['Geist','Medium'],['Geist','SemiBold'], // kit instance を置く・書き換えるとき
].map(([family, style]) => figma.loadFontAsync({ family, style })));
```

Noto Sans JP に SemiBold は無い。**Poppins は `SemiBold`（スペース無し）**、JetBrains Mono も `ExtraBold` のようにスペース無し。Inter の `Semi Bold`（スペース入り）とは別なので取り違えない。

**フォントのロードは `characters` の書き換えだけでなく、文字ノードへのあらゆる書き込みに掛かる。** `textDecoration` / `setRangeTextDecoration` / `setRangeFills` / `setTextStyleIdAsync` / 文字を含むノードの `appendChild` でも `Cannot write to node with unloaded font` で落ちる（builder-sales が 2026-10-01 に `textDecoration` で踏んだ）。**既存のテキストを触るときは、そのノードの現在のフォントを `getStyledTextSegments(['fontName'])` で調べてロードする**（kit instance の中なら Geist が混ざっている）。

### 8.2 和欧混植でテキストを作る / 既存テキストに当てる

```js
const S = Object.fromEntries((await figma.getLocalTextStylesAsync()).map(s => [s.name, s]));
// style は 'Desktop/H1'・'Mobile/Body'・'UI/Button' など（JP/ と Latin/ を除いた部分）
async function applyMixed(t, style) {
  await t.setTextStyleIdAsync(S['JP/' + style].id);
  const re = /[\x21-\x7E]+(?: [\x21-\x7E]+)*/g; // 半角英数字・記号の連続（間の半角スペース 1 個は含める）
  let m;
  while ((m = re.exec(t.characters))) {
    await t.setRangeTextStyleIdAsync(m.index, m.index + m[0].length, S['Latin/' + style].id);
  }
}
```

### 8.3 色・余白・角丸のバインド

```js
const V = Object.fromEntries((await figma.variables.getLocalVariablesAsync()).map(v => [v.name, v]));

// 解決値をリテラルにも入れておく。入れないと、何かの拍子に素の色（黒）が出る
const cache = {};
async function resolve(id, d = 0) {
  if (id in cache) return cache[id];
  const v = await figma.variables.getVariableByIdAsync(id);
  const raw = v.valuesByMode[Object.keys(v.valuesByMode)[0]];
  return (cache[id] = raw && raw.type === 'VARIABLE_ALIAS' ? await resolve(raw.id, d + 1) : raw);
}
async function paint(name) {
  const v = V[name], c = await resolve(v.id);
  return figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b } }, 'color', v);
}

const frame = figma.createAutoLayout('VERTICAL');
frame.fills   = [await paint('role/surface')];
frame.strokes = [await paint('role/border')];
frame.strokeWeight = 1;
for (const p of ['paddingTop','paddingBottom','paddingLeft','paddingRight','itemSpacing']) frame.setBoundVariable(p, V['space/5']);   // 24
for (const c of ['topLeftRadius','topRightRadius','bottomLeftRadius','bottomRightRadius']) frame.setBoundVariable(c, V['radius/md']); // 8
await frame.setEffectStyleIdAsync((await figma.getLocalEffectStylesAsync()).find(s => s.name === 'shadow/sm').id);
```

> **`figma.createAutoLayout()` は既定で白（未バインド）の塗りを持つ。** 背景の要らないレイアウト用フレームは `frame.fills = []` にする。
> **`setBoundVariableForPaint` に渡す素の色を `{r:0,g:0,b:0}` のままにしない。** 渡した値はそのままリテラルに残り、**変数と食い違っていても Figma は直さない**ので黒が描かれる（下の 2 を参照）。上の `paint()` のように解決値を入れる。

#### 色を測るとき、リテラルと解決値のどちらを読むか（2026-10-01 実測）

**事実は 2 つある。混ぜないこと。**

**1. 変数の値を差し替えると、Figma はバインド済み塗りの `paint.color` リテラルも更新する。instance の override 側も含めて。** `role/surface-brand` を blue.500 → blue.600 に差し替えたあとの実測:

| 走査範囲 | バインド済みの塗り | リテラル≠解決値 |
|---|---|---|
| 13 About | 373 | **0** |
| 14 Contact | 1,336（別途 builder-site が 1,209 件で再確認） | **0** |
| 15 Blog | 768 ＋ テキスト範囲塗り 344 | **0** |
| 16 System | 1,229 ＋ テキスト範囲塗り 605 | **0** |
| `03 Components` | 55 | **0** |
| 計 | **4,710** | **0** |

> **14 Contact の 1,336 と builder-site の 1,209 は同じものを数えていない。** 差 127 は走査条件の違いで、builder-site 側は `page.children` のうち `findAll` を持つものだけを起点にしたため、**ページ直下の素の TEXT を母数から落としている**（§8.4 で qa-reviewer が踏んだのと同じ穴）。**どちらの範囲でも食い違いは 0 件**なので結論は変わらない。

古い `#0581DB` は 1 件も残っていなかった。**つまり「変数を差し替えたらリテラルが古いまま残る」という現象は無い。** 差し替え後の検査はリテラルで測っても正しい値が出る（そのほうが速い）。

**2. 一方、こちらが `setBoundVariableForPaint` に渡したリテラルが変数とずれている場合、Figma はそれを直さない。** ヘッダーが黒く出た事故（§上）がこれで、バインドはあったのにリテラルに `{r:0,g:0,b:0}` が入ったまま残り、黒が描かれた。

**Figma がリテラルを更新するのは「変数の値が変わったとき」だけで、「バインド時に渡された値が変数と違うとき」ではない。書く側のミスは検出も修正もされない。**

**したがって検査は `boundVariables.color` から alias を辿る。** 理由は「リテラルが古いから」ではなく、**リテラルが一致していてもその値が仕様どおりである根拠にならない**ため。違反を報告するときに「どの変数が悪いのか」まで言うには、どちらにしても変数名まで遡る必要がある。

**テキストの文字色は `node.fills` では母数から落ちる。** 範囲ごとに色が違うテキストで `node.fills` は `figma.mixed` になり、`Array.isArray()` で弾かれる。`role/text-link` ＋ UNDERLINE のリンクはまさにこの形。**`getStyledTextSegments(['fills'])` を併用する**（15 Blog 344 件・16 System 605 件がこの経路でしか取れなかった）。

コントラスト判定のしきい値（builder-site の実装、4 ページ 1,620 件で違反 0）: **24px 以上、または 18.66px 以上かつ Bold / Black / Medium は 3.0、それ以外は 4.5。**

### 8.4 ほかのページを走査するときの注意（2026-10-01 に 2 回踏んだ）

**`page.loadAsync()` だけでは中身が全部読めない。検査の走査は必ず `setCurrentPageAsync` で 1 ページずつ行う。**

同じ 10 Top を 3 通りで数えた実測値:

| 方法 | ノード数 | 文字数 |
|---|---|---|
| `loadAsync()` ＋ `findAll(述語)` | — | **リンク 0 件**（誤り） |
| `loadAsync()` ＋ `findAll(() => true)` | **421**（誤り） | **50**（誤り） |
| **`setCurrentPageAsync()` ＋ `findAll(() => true)`** | **2,467** | **803** |

`loadAsync()` は解決しても中身が揃っていないことがあり、**同じコードでも実行ごとに結果が変わる**（19:03 の走査では正しい件数が出て、19:17 の走査では桁が落ちた）。ページをまたぐ検査は、**対象ページごとに `use_figma` を分けて `setCurrentPageAsync` する**。読み取りだけなら並列に投げてよい。

**検査の結果を出すときは、必ずノード数・文字数も一緒に返して桁を確かめる。** 「0 件でした」が「本当に 0 件」なのか「走査が届いていない」のかは、母数を見ないと区別できない。**母数が前回と違っていたら、まず走査を疑う。**

#### `findAll()` は自分自身を含まない（2026-10-01・builder-sales が発見）

**`node.findAll(...)` は子孫だけを返し、`node` 自身は入らない。** ヘッダーの罫線は**ルートのノード**に付いているので、`header.findAll(n => n.strokes...)` では出てこない。

```js
// 危ない — ルートに付いた塗り・線・効果を取りこぼす
const hits = header.findAll(n => Array.isArray(n.strokes) && n.strokes.length);

// 安全 — 自分自身を足す
const hits = [header, ...header.findAll(() => true)].filter(n => Array.isArray(n.strokes) && n.strokes.length);
```

**この取りこぼしは「無いものを有る」ではなく「有るものを無い」と読む向きに出る。** builder-sales は「罫線 0 件」と出て**罫線が消えたと誤認しかけた**（実際は付いていた）。**同じスクリプトの中で、影の検査では自分自身を足していたのに罫線の検査では足し忘れていた**、という形だった。

**部品のルートに付く property（背景の塗り・枠線・影・角丸・余白）を検査するときは、必ず自分自身を含める。**

### 8.5 部品を直しても instance に伝わらないとき

**instance 側に同じプロパティの上書きが残っていると、部品の修正は反映されない。**
`IconCard` のリンクに下線を足したとき、部品側は `UNDERLINE` になったのに、builder のページの instance は `textDecoration` の上書きが残っていたため `NONE` のままだった（builder-site が 2026-10-01 に発見）。

- **部品を直したら、instance 側を実測して確かめる。** 「部品を直したから伝わっているはず」で済ませない。
  ```js
  t.getStyledTextSegments(['textDecoration']).map(s => s.textDecoration)
  ```
- 上書きを外すなら `inst.resetOverrides()`。ただし**文言の差し替えなど意図した上書きも一緒に消える**ので、何が上書きされているかを確かめてから使う（`ContactForm` の注記の差し替えはこれで正しく動いた）。
- **塗り・変数バインドは上書きが無ければ素直に伝わる**（`ConsentCheckbox` の下線は instance 側で何もせずに反映された）。伝わらないのは、その instance に同じプロパティの上書きが残っている場合だけ。

### 8.6 文の一部だけ色や下線を変える（範囲の塗り）

文の途中に 1 語だけリンクがあるときは、**文を分割せず範囲で塗る**（分割すると折り返しが語の途中で固定される）。

```js
const t = /* …テキストノード… */;
const idx = t.characters.indexOf('プライバシーポリシー');
t.setRangeTextDecoration(idx, idx + 'プライバシーポリシー'.length, 'UNDERLINE');
t.setRangeFills(idx, idx + 'プライバシーポリシー'.length, [await paint('role/text-link')]);
```

**守ること 2 つ。**

1. **`characters` で文言を書き換えると範囲指定が消え、下地の塗り 1 色に戻る。** 書き換えたら**必ず当て直す**。順序は「`characters` → 文字スタイル → 範囲の色と下線」。
   - **`editComponentProperty` で既定値を変えた場合も同じ。** 部品側のノードの文字が内部的に書き換わるため、範囲の下線や色が落ちる。
     2026-10-01 に「無料DL」→「無料 DL」を `IconCard / Link#42:89` の既定値で直したとき、**範囲の下線が 2 件落ちた**（qa-reviewer が発見）。**この §8.6 を書いた直後に自分で踏んでいる。**
   - **一括で文言を直すときは、対象に範囲指定を持つノードが含まれていないかを先に確かめる**（`getStyledTextSegments(['fills','textDecoration']).length > 1` で判定できる）。
2. **下地（`node.fills`）もブランドトークンにバインドしておく。** 万一範囲が消えても、露出するのはブランドの色になる。下地が kit の色のままだと、**範囲が消えた瞬間に kit の色が復活する**（builder-site が特商法の表で踏んだ）。

**検査での見え方に注意。** 範囲の塗りは `node.fills` が `figma.mixed` になるため、`fills[0]` だけを見る検査は素通りする。`getStyledTextSegments(['fills'])` でセグメントごとに見る。`qa-audit.js` では C3 が「寸法」側に分類して出す（`boundVariables.fills` の `where` が `寸法.fills` になるため）ので、**色の問題なのに寸法の欄に出る**。

`03 Components` で範囲の塗りを使っているのは **`BookingEmbed` の注記 3 行目の 2 件だけ**（本書 §7.3）。

### 8.7 ロゴを置く

```js
const set = await figma.getNodeByIdAsync('78:2581');
const comp = set.children.find(c => c.name === 'Lockup=Horizontal, Color=Fullcolor');
const logo = comp.createInstance();
const W = 160;                       // tokens.json の画面最小幅。これを下回らない
logo.resize(W, logo.height * (W / logo.width));   // 必ず等比
```

---

## 9. kit（Obra shadcn/ui kit）との関係

**色と角丸は全廃した。** `03 Components` に kit の色変数への参照は **0 件**、kit の角丸変数への参照も **0 件**（2026-10-01 17:53 / 18:02 JST に走査）。
部品の骨格（Button・Input・Checkbox などの instance）は kit のまま使っているので、**残っているのは余白・間隔だけ**。

**下の件数の単位は「バインドの件数」で、ノード数ではない。** 1 つのフレームが `paddingTop` / `paddingBottom` / `paddingLeft` / `paddingRight` / `itemSpacing` で 5 件を持つため、**ノード数の数倍になる**。「509 個のノードに kit の余白が残っている」とは読まないこと。ノード単位で把握したいときは別に走査する。

| 残っているもの | 件数 | 扱い |
|---|---|---|
| ブランドトークンにバインド済みの寸法（角丸を含む） | **2,633** | これが正 |
| kit の**色**変数への参照 | **0** | 全廃 |
| kit の**角丸**変数への参照 | **0** | 全廃。§7.3 の 4 / 8 / 12px（＋ピル・2px）だけになっている |
| kit instance の**ルート**に残る kit の余白・間隔 | **509** | 上書きは可能だが、変えると部品の寸法が動いて builder の 32 フレームに波及するため手を付けていない。内訳は `xs`(8px) 172・`out-of-scale/1,5`(6px) 93・`out-of-scale/2,5`(10px) 74・`3xs`(2px) 64・`2xs`(4px) 56・`sm`(12px) 28・`out-of-scale/1,375`(5.5px) 16・`md`(16px) 6 |
| kit instance の**内側**に残る kit の余白・間隔 | **777** | **Figma の仕様で上書きできない**（instance のサブレイヤーの auto-layout 値は変更不可）。detach しない限り解消しない |

> ⚠ **kit の部品かどうかを「名前」で判定しない。** `<名前> - Nova` のような名前で判定すると、**instance を改名した瞬間に自作扱いになる**。
> **`(await inst.getMainComponentAsync()).remote` で判定する。** qa-reviewer が名前で判定していたため、`Required` を含む **162 件を「自作のノードに kit の寸法変数が残っている」と誤検出**しかけた（実際は全件 kit instance。10 Top でも 155 件）。
> 変数の出どころを見るときも同じで、**`variable.remote`** を使う（本書 §9.3 の C3）。

**見た目に効く差は残っていない。** 角丸は 100% ブランド値（カードやボタンが 10px のまま残る、といった状態は無い）。残る 1,286 件はすべて kit 部品の内側の余白・間隔で、いずれも数 px の詰めであり面の形や色には出ない。**許容事項として扱う。**

### 9.4 判断して据え置いた 15 件（自前のノードだが波及を避けた）

**`FormField` 12 variant と `ConsentCheckbox` 3 variant の `Label row/Required` の上下余白が 2px** で、§7.1 の 8pt グリッド（4px 半ステップ）から外れている。**kit 由来ではなく自前のノードなので直せるが、据え置いた**（2026-10-01 lead 判断）。

1. **4px にするとフォームの各行が 4px ずつ高くなり、builder 7 ページのフォーム全部の高さが変わる。** 両 builder が高さを実測し終えた直後で、再検証の手間に見合わない
2. qa-reviewer も「見た目への影響は小さいので優先度は低い」としている
3. **8pt グリッドの 4px 半ステップは「余白・サイズ」の規則**であり、`Required` の印のような微細な内側の余白まで律する意図ではないと読める

**見落としではなく判断して残したもの。** qa-reviewer には指摘不要と伝えてある。

6px・10px・2px・5.5px は §7.1 の 8pt グリッド（4px 半ステップ）から外れる。**これは kit 側の内部値であって、こちらが置いた余白ではない。** 自前のフレームで 8pt グリッドから外れていたのは 3 ノード 8 箇所だけで、20px→24px（`space/5`）・6px→8px（`space/2`）に寄せて解消済み。

**主ボタンだけは例外的に kit の内側余白を上書きした。** §9.5 がラベルを 16px 太字と定めており、kit の既定（左右 10px）では文字が枠に接して読めなくなるため、`CTAButton` 24 variant の `Button` instance の左右余白を `space/4`（16px）にしてある。instance ルートの余白は上書きできることを確認済み（24/24 成功）。

### 9.1 kit 色変数 → ブランドトークンの対応表（正本）

**この表が唯一の対応表。** `03 Components` の 1,066 バインドはこの表で移行した。builder のページに残っている kit 色変数を直すときも、**必ずこの表を使う**（別々の対応表を作ると画面ごとに色がずれる）。

| kit 変数 | ブランドトークン | 備考 |
|---|---|---|
| `shadcn colors/general/foreground` | `role/text-body` | **ただし見出しスタイル（Display / H1〜H4 / Card Title / Price）が当たった TEXT は `role/text-heading`**（navy.700。§9.5） |
| `shadcn colors/general/card foreground` | `role/text-body` | 同上 |
| `shadcn colors/general/muted foreground` | `role/text-muted` | neutral.600。白地 6.22:1 で、kit の #737373（4.35:1）より改善する |
| `shadcn colors/general/muted` | `role/surface-subtle` | neutral.50 |
| `shadcn colors/general/card` | `role/surface` | |
| `shadcn colors/general/background` | `role/surface` | |
| `shadcn colors/general/popover` | `role/surface` | |
| `shadcn colors/general/border` | `role/border` | neutral.200 |
| `shadcn colors/general/input` | `role/border` | |
| `shadcn colors/general/secondary` | `role/surface-subtle` | |
| `shadcn colors/general/secondary foreground` | `role/text-heading` | 副ボタンの文字 navy.700（§9.5） |
| `shadcn colors/general/destructive` | `semantic/danger` | |
| `shadcn colors/general/primary` | `role/surface-brand-strong` | 反転面 navy.700 |
| `shadcn colors/general/primary foreground` | `role/text-inverse` | |
| `shadcn colors/focus/ring` | `role/focus-ring` | 効果に当てるなら `focus/ring` スタイルを使う |
| `shadcn colors/focus/ring error` | `semantic/danger` | 同じく `focus/ring-error` |
| `alpha/white/outline-bg` | `role/surface` | 副ボタンの地（§9.5） |
| `alpha/white/switch/alpha-001` | `role/surface` | **元の変数が持つ透明度を paint の `opacity` に移して見た目を保つ** |
| `alpha/white/switch/alpha-100` | `role/surface` | |
| `alpha/black/no-switch/alpha-50` | `role/text-body` | スクリム。同じく透明度を移す |

旧 `accent/*` は削除済み。**付け替え先は対象で分ける**（2026-10-01 に builder-site・builder-sales と合意）: **テキストのリンク**なら `role/text-link` ＋ 下線、**アイコンや図形（VECTOR）**なら `role/text-accent-subtle`、**面**なら `role/surface-brand`。もし残骸があれば `accent/base` → 上の分け方で、`accent/hover` → `role/surface-brand-hover`、`accent/foreground` → `role/text-inverse`、`accent/subtle` → `role/surface-accent-subtle`、`accent/subtle-foreground` → `role/text-accent-subtle`。

**寸法の対応**（値が一致するものは機械的に。一致しないものは下の寄せ方で確定）

| kit | 値 | 寄せ先 | 理由 |
|---|---|---|---|
| `2xs` / `xs` / `sm` / `md` / `xl` / `2xl` / `4xl` / `7xl` / `9xl` | 4 / 8 / 12 / 16 / 24 / 32 / 48 / 96 / 128 | `space/1`〜`space/10` の同値 | 一致 |
| `10xl` | 144 | `layout/gutter-desktop` | Desktop の左右余白。`space/*` には無い値 |
| `md`（**Mobile のページ左右余白として使っている箇所だけ**） | 16 | `layout/gutter-mobile` | **それ以外の 16px は `space/4`。** ページの左右余白とそれ以外を取り違えない |
| `3xl` | 40 | `space/6`（32） | §7.1 に 40 が無い。**近い値ではなく用途で選ぶ**: セクション内のブロック間なら `space/6`(32)、セクション間なら `space/7`(48) |
| `radius-lg (radius)` | 10 | `radius/md`（8） | §7.3 のカード・ボタン。ただし**入力欄・タグは `radius/sm`（4）** |
| `radius-xl` | 14 | `radius/md`（8） | カード |
| `radius-2xl` | 16 | `radius/lg`（12） | 大きな面・モーダル |
| `out-of-scale/2` | 2 | `radius/xs`（2） | チェックボックス |

**付け替えのスクリプトは §8.3 の `paint()` を使う。** リテラルの色を `{r:0,g:0,b:0}` のままにすると、バインドが解決されない場面で黒が出る（実際にヘッダーが真っ黒になった）。

**新しく kit の instance を置くと、kit の色バインドが一緒に入ってくる。** `BookingEmbed` を作ったときも `Alert` が `#E5E5E5`（kit border）を 2 件持ち込んだ。**kit instance を置いた部品は、置いたあとに必ずこの表で付け替えて検査し直す。**

### 9.2 kit instance が持ち込む「未バインドの塗り」（2026-10-01 検証）

kit の部品には、**変数にバインドされていない生の塗りを instance のルートに持つもの**がある。入ってくる経路は 9.1 の kit 色変数と同じだが、**バインドされていないので「パレット外の色」検査にも「remote バインド」検査にも引っかからない**。見つかるのは未バインド検査だけ。

| 部品 | 箇所 | 件数 | 状態 |
|---|---|---|---|
| `Pagination Number Button - Nova` | instance ルートの塗り `#FFFFFF` | 4（15 Blog の Desktop 3・Mobile 1） | **`visible = false` の不可視の塗り**。描画には出ない |

**これは instance の「ルート」にあるので上書きできる。**（サブレイヤーの塗りと違って制約が無い。`03 Components` に捨てインスタンスを置いて検証済み: バインドは成功し、`visible = false` も保たれる。）
対処は `role/surface` にバインドするだけでよく、**サイト固有のページ送り部品を作る必要は無い**（15 Blog の 2 か所でしか使っておらず、不可視なので見た目の問題も無いため）。

```js
// instance ルートの未バインドの塗りをブランドトークンに寄せる。visible / opacity は元のまま保つ
for (const n of page.findAll(x => x.type === 'INSTANCE' && /Pagination Number Button/.test(x.name))) {
  const out = [];
  for (const p of n.fills) {
    out.push(p.type === 'SOLID' && !(p.boundVariables && p.boundVariables.color) ? await paint('role/surface', p) : p);
  }
  n.fills = out;   // paint() は §8.3。opacity と visible を引き継ぐこと
}
```

---

### 9.3 色の検査は 4 本必要（2026-10-01・qa-reviewer が 4 本目を発見）

**1 本でも欠けると、残った色が検査をすり抜ける。** 3 本で足りると思っていたのは誤りだった。

| # | 検査 | 何を拾うか | 拾えないもの |
|---|---|---|---|
| C1 | **パレット外の色** | ブランドパレットに無い HEX | バインド済みでパレット内の色 |
| C2 | **未バインドの塗り・線** | 変数に結ばれていない塗り（本書 §9.2 の kit instance ルートなど） | バインドされていれば素通り |
| C3 | **remote バインド** | kit（library）の変数への参照 | ローカル変数への参照は素通り |
| C4 | **削除済み変数への参照** | **ローカル一覧にも無く `remote` でもない変数への参照** | — |

**C4 が必要な理由。Figma は削除した変数を、参照が残っているかぎり `getVariableByIdAsync()` で名前も値も返し続ける。**
そのため「`getVariableByIdAsync()` が `null` を返したら、ぶら下がり」という検査は**原理的に 0 件しか返さない**。2026-10-01 に `accent/*` を削除したあと「全 11 ページでぶら下がり 0 件」と報告したが、**その検査はこの事象を検出できない作りだった**。実際には **22 ノード**（11 Services 8・16 System 10・15 Blog 4）**が `accent/base`（#007A55）を参照したまま緑で描画されていた**（qa-reviewer が発見）。

C4 の判定:

```js
const local = new Set((await figma.variables.getLocalVariablesAsync()).map(v => v.id));
// 参照先が「ローカル一覧に無い」かつ「remote でもない」なら、削除済み変数への参照
const v = await figma.variables.getVariableByIdAsync(id);
const dangling = v && !v.remote && !local.has(v.id);
```

**変数を削除する前には、全ページで参照 0 件を C4 の形で確かめる。** 削除してからでは、描画は正しく見えるのに検査だけが通ってしまう。

## 10. 実装（`03-handoff.md`）への申し送り候補

- **`global.css` のトークンを tokens.css に寄せる。** `Assets/tokens/tokens.css` がそのまま使える形で生成されているので、`--color-brand-*` / `--color-neutral-*` / `--color-role-*` / `--space-*` / `--radius-*` / `--shadow-*` を取り込み、shadcn の `--background` ほかをそれらの alias にする案を出す。Figma の変数のコードシンタックスは tokens.css の名前に一致させてある。
- **書体を Inter → Poppins に差し替える。** `--font-sans` は `"Poppins", "Noto Sans JP", Montserrat, "Century Gothic", "Helvetica Neue", Arial, sans-serif`。等幅は `"JetBrains Mono", …`。`@fontsource` のパッケージ追加が要る。
- **主ボタンの文字は 16px 以上の太字にする**（§9.5）。`base-nova` の既定（14px medium）では blue.500 の 4.06:1 を救えない。
- **フォーカスリングを消さない。** `outline: 2px solid var(--color-role-focus-ring); outline-offset: 2px;` を全フォーカス可能要素に。`outline: none` を書かない。
- **リンクに下線を付ける**（`text-decoration: underline`）。色は `--color-role-text-link` #0579CE、ホバーで `--color-brand-blue-700`。
- **ヘッダーのロゴは横組み 160px 幅**（§6 の要判断が案 A のままなら）。`Assets/logo/comegin-logo-horizontal.svg` をそのまま使う。ファビコンは `Assets/logo/favicon/` を 16/32/48/180/512 すべて設置（§9.5）。
- **本文に `brand.blue.500`・`brand.sky` を使わない**（§5.5-2,3）。本文リンクは `role.text-link` #0579CE。
- **青の面積を全体の 10% 以内に抑える**（§5.4）。公開前チェックリスト（付録 A）の項目として `03-handoff.md` に入れる。
- Mobile の主 CTA の高さは `base-nova` の `h-9`（36px）のまま Figma に写してある。16px ラベルにしたことで Figma 上は 36〜40px。タップ領域を広げるかはコード側の判断（`button.tsx` が正本）。
- `JP|Latin/UI/Logo` の文字スタイルは非推奨。実装でも文字ロゴを使わない。
- **和欧間の空きを、Figma からそのままコピーしない。** GL §6.4-2 は「CSS では `text-spacing-trim` ／手動の場合は半角スペース」と定めているが、**Figma の文字スタイルには `text-spacing-trim` 相当の設定が無い**ため、Figma のテキストは**必ず文字としての半角スペース込み**になる（例「ComeGin の提案」「ソースコードを無料 DL」）。実装で CSS に任せるなら、**和欧の境目のスペースだけを除く処理**が要る（単語間のスペースは残すので単純な置換ではできない）。入れたままにすると二重に空く。`01-content-spec.md` §0.2 と対になる申し送り。

---

## 11. 公開前チェックリスト（付録 A のうち Figma で確認できるもの）

- [x] ロゴ: 背景に応じた Color を使っている／最小サイズを下回っていない／縦横比を変えていない／効果を追加していない
- [x] カラー: パレット外の色を使っていない（走査 0 件）
- [x] カラー: 本文の文字色が白背景で 4.5:1 以上ある（`role/text-body` 17.40:1・`role/text-muted` 6.22:1）
- [x] カラー: `brand.sky` を文字色に使っていない（走査 0 件）
- [ ] カラー: 青の面積が全体の 10% を超えていない — **ページを組んだ段階で builder／lead が目視で確認する**
- [x] 文字: 指定書体（Poppins / Noto Sans JP / JetBrains Mono）を使っている（走査 0 件の違反）
- [x] 文字: 本文 14px 以上・行送り 1.75
- [ ] 文字: 和欧間に四分アキが入っている — Figma の文字スタイルでは表現できない。実装側（`text-spacing-trim`）で担保する
- [ ] 言葉・表記の項目 — ia-copy の担当

## 8. コードだけの部品: 基盤の模型（2026-10-28 に追加）

`HERO` 分類の作り直し（`docs/superpowers/specs/2026-10-28-hero-diorama-design.md`）で足した部品。Figma には無い（模型の正本は Blender のスクリプト `frontend/verdant-virgo/src/modules/diorama/tools/blender/build_diorama.py` と、書き出した `diorama.glb`）。

| 部品 | 置き場所 | 役割 |
|---|---|---|
| `DioramaHero` | トップ 1-3 | 触れる模型（部品のボタン・パネル） |
| `DioramaIntro` | サービス一覧・詳細の `PageIntro`（`slot="backdrop"`） | 眺める模型 |
| `DioramaStill` | B の 5 ページの `PageIntro`（`slot="media"`） | 模型の静止画（4:3） |

文言の正本は `src/modules/site-content/diorama.ts`（部品のパネル）と `cases.ts`（実績）。
