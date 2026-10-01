/* =============================================================================
 * Web サイト Figma の検査スクリプト（qa-audit）— 改訂 2 版
 *
 * ■ 改訂の経緯
 *   初版 2026-09-20: 18 項目。アクセント色 emerald・欧文 Inter の前提で書いた
 *   2 版 2026-10-01: **ブランドガイドライン 1.2 の全面適用**に合わせて全面改訂。
 *     - 許可フォントを Poppins / Noto Sans JP / JetBrains Mono に差し替え
 *     - **色の検査を 3 本に分けた**（パレット外 / 未バインド / ライブラリ変数参照）。
 *       1 本では足りない。それぞれ拾えるものが違う（`03-handoff.md` §10）
 *     - ライブラリ変数は **`getVariableByIdAsync(id).remote === true` で数える**。
 *       名前で絞らない（`shadcn` で絞って `alpha/*` 62 件を落とした事故がある）
 *     - ブランド規定（§5.5 の小さい文字への青・§9.5 のボタン/フォーカス/リンク下線・
 *       §5.4 の青 10%・§4.4 のロゴ最小サイズ・§6.3 タイプスケール・§7.1 8pt）を追加
 *     - コピーと表記（§8.4 禁止表現・§6.4 の密着/四分アキ/60 字）を追加
 *     - **見えない場所**（閉じた Accordion・`Show xxx=false`・variant で隠れた行・
 *       dev annotation の旧値）を全 instance 走査で拾うようにした
 *
 * ■ このスクリプトは読み取り専用です。Figma には一切書き込みません。
 *   ノードの作成・変更・削除、変数やスタイルの作成は行いません。
 *   唯一の副作用は `figma.setCurrentPageAsync()` による「表示中ページの切り替え」で、
 *   これはページの内容を読むために Figma が要求する手順です（内容は変わりません）。
 *
 * ■ 使い方
 *   1. 下の PAGE_ID を検査したいページの ID に書き換える
 *   2. このファイルの中身をまるごと `use_figma` の `code` に貼って実行する
 *      （`figma:figma-use` スキルを先に読み込むこと。`skillNames` に "figma-use" を渡す）
 *   3. 戻り値の JSON を読む。`自己テスト合格: true` を先に確かめる。false なら結果を信用しない
 *   ※ 複数ページを見るときは、1 回の `use_figma` につき 1 ページ。
 *      `setCurrentPageAsync` は 1 回だけ呼ぶこと（スキルの Page Rules）。
 *      並行して見たいときは、ページごとに別の `use_figma` 呼び出しを同じメッセージで並べる。
 *
 * ■ 前提
 *   fileKey : JRYPLER6E0liA7cUurIhSo
 *   正本    : 色・寸法・書体 = `Assets/tokens/tokens.json` / 規定 = ブランドガイドライン 1.2
 *             コピー・CTA・計測 = `01-content-spec.md` / 部品 = `02-component-map.md`
 *   ページ ID :
 *     0:1  00 Cover            4:2  01 Sitemap         4:3  02 Foundations
 *     4:4  03 Components       4:5  10 Top             4:6  11 Services
 *     4:7  12 Pricing          4:8  13 About           4:9  14 Contact
 *     4:10 15 Blog             4:11 16 System
 *
 * ■ 検査する項目（カッコ内は戻り値のキー）
 *   色（**4 本すべて必要**。1 本でも欠くと移行漏れが残る）
 *     C1 パレット外の色          (違反.パレット外の色)      tokens.json に無い実効値
 *     C2 未バインドの塗り・線     (違反.未バインド塗り)      **非表示のものも数える**
 *     C3 ライブラリ変数への参照   (違反.ライブラリ変数)      remote === true の件数
 *     C4 **削除済み変数へのぶら下がり** (違反.ぶら下がり)
 *        `getLocalVariablesAsync()` に無く、かつ `remote !== true` の変数への参照。
 *        **2026-10-01 にこの経路で旧アクセントの緑 `accent/base`（#007A55）が
 *        28 件生き残っていた**（11 Services 8 ／ 16 System 20）。削除したはずの変数だが、
 *        `getVariableByIdAsync()` は名前も値も返すため C3 にも「壊れたバインド」にも出ない。
 *        **画面には緑で描画される。**
 *   ブランド規定
 *     B1 書体                   (違反.フォント)           Poppins/Noto Sans JP/JetBrains Mono 以外
 *     B2 小さい文字への青        (違反.小文字への青)        18px 未満に blue.500 / sky（§5.5-2,3）
 *     B3 主ボタンの文字          (違反.主ボタン文字)        16px 以上の太字か（§9.5）
 *     B4 フォーカスリング        (フォーカス)              State=Focus に focus/ring があるか
 *     B5 リンクの下線            (違反.リンク下線なし)      本文・カード・バナー・フッター（ナビは除く）
 *     B6 青の面積               (青の面積)                フレーム面積に対する概算比（§5.4）
 *     B7 ロゴ                   (ロゴ / 違反.ロゴ)         最小幅・等比・アイソレーション用の実測
 *     B8 タイプスケール          (違反.タイプスケール外)     §6.3 の 9 段階以外のサイズ
 *     B9 8pt グリッド           (違反.8ptグリッド)         自前フレームの余白・間隔・寸法
 *   コピーと表記
 *     T1 禁止表現               (違反.禁止表現)            §8.4・§8.3
 *     T2 単位・助数詞の密着      (違反.単位の空き)          §6.4-4
 *     T3 和欧間の四分アキ        (違反.四分アキ欠落 / 違反.句読点後の空白)  §6.4-2
 *     T4 一文 60 字             (違反.一文60字超)          §6.4-9（法務 2 ページと同意バナーは 80 字）
 *     T5 和欧混植               (違反.Poppins漏れ / 違反.Noto漏れ)
 *     T6 コピー一致             (コピーの欠落)             EXPECTED との突き合わせ
 *     T7 プレースホルダ          (違反.プレースホルダ)       kit 既定の文言
 *   見えない場所
 *     H1 隠れた旧文言            (違反.隠れた旧文言)        componentProperties を全 instance 走査
 *     H2 閉じた Accordion       (閉じたFAQ)               State=Closed の Answer の値
 *     H3 dev annotation         (違反.注記の旧値 / 注記 / cta_id / cta_type)
 *   構造
 *     S1 幅と高さ               (幅の分布 / 違反.ヘッダー高さ)
 *     S2 主 CTA                 (ボタン)                  1 ページ 1 種類・ブログのヘッダーは Outline
 *     S3 コントラスト            (違反.コントラスト)        変数の実効値を解決して計算
 *     S4 ダミー                 (ダミー)                  「準備中」「【要記入】」『要確認』の所在
 *     S5 壊れた参照              (違反.壊れたinstance / 違反.壊れたバインド)
 *     S6 複製と本体の一致        (複製の照合)              CLONE_PAIRS
 *     S7 placeholder 残り       (違反.placeholder残り)    作りかけのシマー
 *     S8 Device スタイル         (違反.Deviceスタイル)      Mobile への JP/Desktop/* の混入
 *     S9 段組みの字数            (違反.段組みの字数)
 *   視覚（文字切れ・重なり・はみ出し）はこのスクリプトの対象外。
 *   返ったフレーム ID を `get_screenshot` で見る。
 *
 * ■ 件数が 0 にならない項目について（`03-handoff.md` §8 の許容事項）
 *   次の 4 つは**判断のうえ許容した**ものが件数に出る。違反として送る前に §8 を確認する。
 *     - 違反.8ptグリッド  : kit instance の内側の余白（instance ルート 509・内側 777）。
 *                          `kit内側` フラグが立っているものは許容。自前フレームだけが本物
 *     - 違反.Deviceスタイル: Body・Small・Caption は D/M で値が完全同値。
 *                          値が違う Display・H1〜H4・Body L が出たときだけ本物の違反
 *     - 違反.段組みの字数  : `IconCard` を 3 列で使う箇所は約 19.3 字（許容済み）
 *     - 違反.未バインド塗り: `Pagination Number Button - Nova` の不可視の塗り 4 件（15 Blog）
 *   ダミーの `【要記入】`『要確認』は**残っているのが正**。消えていたら逆に指摘する。
 *   ほかの項目は 0 が正常。0 でなければ直す。
 *
 * ■ 過去に踏んだ落とし穴（このスクリプトで塞いである）
 *   - 色の検査は 4 本必要。1 本では移行漏れが残る → C1 / C2 / C3 / C4
 *   - ライブラリ変数を名前で絞ると `alpha/*` を落とす → C3 は remote === true で数える
 *   - **「変数を削除した」は「参照が消えた」ではない。** Figma は削除済み変数を、参照が
 *     残っているかぎり `getVariableByIdAsync()` で返し続ける。名前も値も取れるので
 *     「ぶら下がり 0 件」に見えてしまう。**ローカル一覧との突き合わせが要る** → C4
 *   - 非表示レイヤーは instance に展開されない。走査に出ないことを「存在しない」と
 *     判定してはいけない。値は componentProperties に残っている → H1 / H2
 *   - 注記は label と labelMarkdown の 2 つがあり、labelMarkdown 側はアンダースコアが
 *     `\_` にエスケープされる。片方だけを見ると cta_id の検索が空振りする → annText()
 *   - 注記は画面に出ないので、仕様を変えても誰も直さない。`cta_type` の改名で 87 件が
 *     旧値のまま残った → H3 は値の妥当性まで見る
 *   - 一括置換は置換後を読み返す。「弊社」→「ComeGin」で和欧間の空白が落ち、
 *     その修正で読点の直後に空白が入った → T3 は両方向を見る
 *   - kit の Badge の中のテキストも名前が `Label`。FAQ の質問文は Question を経由して
 *     辿らないと、バッジ側を掴む → faqQuestion()
 *   - 部品を数えるときは種別で絞る。page.children をそのまま数えると、
 *     部品ではない FRAME（`Page header` など）まで部品数に入る → countComponents()
 *   - 報告には必ず走査時刻を添え、指摘を送る直前に測り直す。修正と検査が数分差で
 *     重なると、修正前の状態を見たまま報告してしまう → 戻り値の `走査時刻`
 * ========================================================================== */

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------
const PAGE_ID = '4:5';          // ← 検査するページの ID（上の一覧から選ぶ）
const IS_MOBILE_FRAME = /Mobile|\/ M$|390/;  // Mobile フレームの判定（S8 で使う）
const CAP = 40;                 // 一覧に載せる件数の上限（件数自体は全件数える）

// 一文 80 字まで許す画面（D-3 の例外）。法務 2 ページと Cookie 同意バナー
const LONG_SENTENCE_OK = /Legal|法務|privacy|tokushoho|プライバシー|特定商取引|Cookie|同意/i;

// ---------------------------------------------------------------------------
// 正本の値（`Assets/tokens/tokens.json` と ブランドガイドライン 1.2 から写す）
// ---------------------------------------------------------------------------
const ALLOWED_FONTS = ['Poppins', 'Noto Sans JP', 'JetBrains Mono'];

// C1: パレット。tokens.json の全色 ＋ component-map §2.1 の primitives（gradient・影のベース・
// ロゴの黒）。これ以外の実効値が出たらパレット外。
const PALETTE = {
  '#E8F2FF': 'navy.50', '#CCE3FF': 'navy.100', '#A3CCFF': 'navy.200', '#66AAFF': 'navy.300',
  '#1C81FF': 'navy.400', '#005FD6': 'navy.500', '#0049A3': 'navy.600', '#003577': 'navy.700',
  '#00215B': 'navy.800/ink', '#001C40': 'navy.900',
  '#E9F5FE': 'blue.50', '#CDE9FE': 'blue.100', '#A0D6FD': 'blue.200', '#62BBFB': 'blue.300',
  '#219FFA': 'blue.400', '#0581DB': 'blue.500', '#0471C0': 'blue.600', '#045D9D': 'blue.700',
  '#03497D': 'blue.800', '#02365C': 'blue.900',
  '#1298E8': 'sky',
  '#0052AD': 'gradient.1', '#036AC3': 'gradient.2', '#0074D2': 'gradient.3',
  '#FFFFFF': 'neutral.0', '#FCFCFC': 'neutral.25', '#F5F7F9': 'neutral.50', '#ECF0F4': 'neutral.100',
  '#DCE3EA': 'neutral.200', '#C2CCD8': 'neutral.300', '#97A5B5': 'neutral.400', '#6F7F92': 'neutral.500',
  '#546274': 'neutral.600', '#3D4856': 'neutral.700', '#2A323C': 'neutral.800', '#1A1A1A': 'neutral.900',
  '#0F7A46': 'success', '#9A5B00': 'warning', '#C0302A': 'danger', '#0579CE': 'info/text-link',
  '#0A3B7A': 'raw/shadow-navy', '#000000': 'raw/logo-black',
};

// B2: 18px 未満の文字に使えない色（§5.5-2,3）
const NO_SMALL_TEXT = { '#0581DB': 'brand.blue.500 4.06:1', '#1298E8': 'brand.sky 3.14:1' };

// B6: 青（10% の枠に数える色）。§5.4 の 10% ＝ blue.500 / sky / gradient
const BLUE_AREA = new Set(['#0581DB', '#1298E8', '#0052AD', '#036AC3', '#0074D2']);

// B8: §6.3 タイプスケール（Desktop / Mobile のすべての段）
const TYPE_SCALE = new Set([60, 36, 30, 24, 20, 18, 16, 14, 12]);

// B7: ロゴの最小幅（tokens.json を正とする。PDF §4.4 の 144/96/20 ではない）
const LOGO_MIN = {
  Horizontal: { 通常: 160, 下限: 136, 比: 3.2549 },
  Vertical: { 通常: 112, 下限: 96, 比: 112 / 116.42 },
  Symbol: { 通常: 24, 下限: 16, 比: 24 / 21.46 },
  Wordmark: { 通常: 112, 下限: 112, 比: 112 / 30.12 },
};

// H3: `cta_type` の 4 値（`DA/01-conceptual-data-model.md` の E-06 が正本）。
// `trial` は「使わない」として値だけ残っている。旧値 demo / whitepaper は違反
const CTA_TYPES = new Set(['consult', 'source_dl', 'chat', 'booking']);
const CTA_TYPES_OLD = new Set(['demo', 'whitepaper', 'trial']);

// S1: 幅と高さ
// ヘッダーの高さ。2026-10-01 にユーザー判断でロゴを**シンボル単体 35.79 × 32px**にし、
// 74.16 → **56px** になった。ガイドライン §4.4 の「下限を割る場合はその組みを使わず
// シンボル単体に切り替える」に従った形で、§9.5 の 32px と §4.4 の最小幅は矛盾していなかった。
// シンボルの X は 高さ × **0.25** ＝ 8px。上下 12 / Desktop 左 144 / Mobile 左 16 で全方向適合し、
// 下端の 1px 罫線もゾーン外になる。**シンボルは正方形ではない**（縦横比 1.1186 : 1）
const HEADER_HEIGHT = 56;

// ---------------------------------------------------------------------------
// T1: 禁止表現（§8.4 と §8.3）。画面に出る文字だけを対象にする
// ---------------------------------------------------------------------------
const BANNED = [
  ['必ず', '§8.4-1 保証できないことを保証しない'],
  ['絶対に', '§8.4-1'],
  ['100%', '§8.4-1'],
  ['簡単に', '§8.4-2 相手の難易度を勝手に決めない'],
  ['すぐに', '§8.4-2'],
  ['お気軽に', '§8.4-7 相手にとって気軽ではない'],
  ['弊社', '§8.3 個人事業であり会社ではない'],
  ['当社', '§8.3'],
  ['業界No.1', '§8.1-3 誇張しない'],
  ['業界 No.1', '§8.1-3'],
  ['革新的', '§8.1-3'],
  ['圧倒的', '§8.1-3'],
  ['最先端', '§8.1-3'],
  ['導入実績多数', '§8.3 書けないなら書かない'],
  ['御社様', '§8.3 二重敬語'],
  ['お客様各位', '§8.3 不要な一般化'],
  ['ソリューション', '§8.3 中身が伝わらない'],
];
// 感嘆符の連続・顔文字・絵文字（§8.4-5）
const BANNED_RE = [
  [/[!！]{2,}/, '§8.4-5 感嘆符の連続'],
  [/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u, '§8.4-5 絵文字'],
  [/\(\s*[\^;ToT><]\s*[_\-\.]?\s*[\^;ToT><]\s*\)/, '§8.4-5 顔文字'],
];

// H1: 差し替え前の旧文言。componentProperties（画面に出ない値）まで含めて探す
const OLD_PHRASES = [
  '弊社', '当社', 'お気軽に', '必ず',
  '23,000 円', '50,000 円', '500,000 円', '125,000 円',   // 単位の前に空白が残った形
  '1 日', '5 日', '3 営業日', '60〜90 日', '4 日',
  '通常【要記入】営業日以内',                               // ContactForm の旧既定値
  'デモ', 'ホワイトペーパー', '無料トライアル',               // 旧 cta_type の名残
  'Inter', 'Geist',                                      // 旧書体の名前が文字として残った形
];

// ---------------------------------------------------------------------------
// T6: コピー一致で突き合わせる期待値（01-content-spec.md から写す。空なら検査しない）
// ---------------------------------------------------------------------------
const EXPECTED = [
  // 例: '23,000円', '1日', '表示価格はすべて税別です。', '開発費は基本的に ComeGin が負担'
];

// S6: 複製と本体の組（[本体のノード ID, 複製のノード ID, 説明]）。空なら検査しない
const CLONE_PAIRS = [
  // 例: ['42:2', '42:4861', 'Top/Desktop と Cookie バナー表示中の中の表示領域'],
];

// H1 の補助: 生値をそのまま返したいノード（カナリア）
const CANARY_IDS = [
  // 例: '23:455', '45:7951', '42:3873',
];

// ---------------------------------------------------------------------------
// 判定に使う正規表現
// ---------------------------------------------------------------------------
const LATIN = /[0-9A-Za-z]/;                    // 半角英数字（全角カタカナは一致しない）
const LATIN_ALPHA = /[A-Za-z]/;                 // 半角英字のみ（四分アキの判定に使う）
const JP = /[ぁ-んァ-ヶ一-龥。、]/;              // 和文
const BOLDISH = /bold|black|heavy|extra ?bold|semi ?bold|demi/i;
const DUMMY = /準備中|サンプル|【要記入】|要確認/;

// kit 既定のプレースホルダ文言（完全一致で判定する。部分一致にすると和文に誤爆する）。
// 画面の TEXT と**部品の既定値**（項目 33）の両方に当てる
const KIT_PLACEHOLDER_WORDS = new Set([
  'title', 'heading', 'button', 'label', 'lorem', 'lorem ipsum', 'placeholder', 'subtitle',
  'body', 'text', 'value', 'description', 'nav label', 'tooltip text', 'select an item',
  'card title', 'cn', 'short text', 'question', 'answer', 'price', 'period', 'product',
  'excerpt', 'date', 'caption', 'logo', 'copyright', 'helper', 'error', 'number', 'name',
  'link', 'lead', 'note', 'tab', 'item',
]);

// 項目 32: **部品の既定値**のプレースホルダ。これが画面に出ていたら、
// 既定値に依存した表示箇所の見落とし。仕様書側の未決の印（「契約の書類：【要記入】」など）とは別物
const DEFAULT_PLACEHOLDER = /^【要記入】(リード文|本文|見出し|金額|期間|注記|タイトル|説明|ラベル|リンク|要約|日付|番号)$/;

// 項目 31: 画面に出る文の URL・パス（§0.1）。
// `https?://` ／ 行頭か区切りの直後の `/pricing` 形 ／ `#source-dl` 形。
// 日付「2026/10/01」は `/` の次が数字なので当たらない
const URL_IN_COPY = /https?:\/\/\S|(?:^|[\s（(「【、。])\/[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)*|#[a-z][a-z0-9-]{2,}/;

// 項目 32: 仕様書のセクション番号（§0.1）。
// **法務ページ自身の見出し番号「2. 取得する情報」は対象外**にするため、
// 節・参照を示す語が続く形と `§` 記号だけを見る
const SPEC_REF = /§\s*\d|\d+[.-]\d+\s*(?:節|章|を参照|に記載|のとおり|の表|で述べ)|\d+\s*節\s*(?:を参照|に記載|の)/;

// T2: 数字と単位・助数詞の間に空白がある形（§6.4-4 違反）
//     「23,000 円」「1 日」「3 つ」「代表 1 名」など
const UNIT_GAP = /[0-9０-９][ 　]+(円|日|名|件|社|枚|回|つ|個|人|種|章|部|本|位|行|列|段|点|箇所|段階|%|％|か月|ヶ月|か年|月|年|分|秒|時間|営業日|営業時間|ページ|文字|字|列目|行目)/;

// T3: 和欧間の四分アキ（半角スペース）が無い形。**英字だけを見る。**
//     数字と和文の間は「密着の規則が優先」（§0.2）なので対象にしない
// **日付・元号・住所の番地・条番号は和欧間の例外**（`01-content-spec.md` §0.2。
// ガイドライン §6.4-3 自身の例が「2026年11月1日」でスペース無し）。
// `YYYY年M月D日` は §4.8 が「実在の日付を入れない」と確定させたダミーで、
// **四分アキを入れるほうが仕様違反**になる（15 Blog に 26 件・11 Services に 6 件）。
// 検査にかける前にこれらを取り除く。
const scrubExempt = s => s
  .replace(/YYYY年M月D日/g, '')
  .replace(/(令和|平成|昭和)\s*\d+\s*年度?/g, '')          // 「令和6年度 介護労働実態調査」
  .replace(/\d{1,4}\s*年(\s*\d{1,2}\s*月)?(\s*\d{1,2}\s*日)?/g, '') // 「2026年9月27日」
  .replace(/第\s*\d+\s*条/g, '')                            // 条番号
  .replace(/\d+\s*\(\s*\d+\s*\)/g, '')                     // 「2(4) の情報」
  .replace(/\d+(?:-\d+)+/g, '');                            // 「蒲生4-19-3」「080-5257-9787」

// **表記の検査は 3 方向に分ける。**`01-content-spec.md` §0.2 は隣り合う位置に
// 逆向きの規則を 3 つ置いているので、1 方向だけでは必ず取りこぼす
// （builder-site が ① しか見ておらず ② を 38 か所落としていた。2026-10-01）。
//   ① 和欧間にスペースを入れる            ○「AI エージェント」 ×「AIエージェント」
//   ② **数字の「手前」の空きは残す**        ○「代表 1名」       ×「代表1名」
//   ③ 数字と「後ろ」の単位・助数詞は密着    ○「1名」           ×「1 名」（＝ UNIT_GAP）
const KERN_MISS = /([ぁ-んァ-ヶ一-龥])([A-Za-z])|([A-Za-z])([ぁ-んァ-ヶ一-龥])/;   // ①
const NUM_LEAD_MISS = /([ぁ-んァ-ヶ一-龥])([0-9])/;                                // ②

// **住所は ② の対象外。** `scrubExempt` は番地（`4-19-3`）しか落とさないので、
// 建物名 ＋ 部屋番号（「ロイヤルアシュリー蒲生502」）が残って誤検出する
// （13 About の会社情報で 2 件。2026-10-01）。
// 都道府県 ＋ 市区郡 を含む文字列は住所とみなし、② を当てない
const IS_ADDRESS = /[都道府県][^\s]{0,20}[市区郡]/;
// T3: 句読点の直後に空白が入った形（置換の副作用）
const PUNCT_SPACE = /[、。）」] /;

// ---------------------------------------------------------------------------
// 判定器の自己テスト（既知の正例・負例で毎回検算する）
// ここが崩れたら、以降の結果は信用できない。
// ---------------------------------------------------------------------------
const SELF_TEST = [];
const t = (name, got, want, note) => SELF_TEST.push({ 検査: name, 結果: got, 期待: want, 合格: got === want, 意味: note });

// 和欧の判定
t('LATIN「23,000円」', LATIN.test('23,000円'), true, '半角数字を含む');
t('LATIN「姓」', LATIN.test('姓'), false, '和文のみ');
t('LATIN「ご連絡はこのメールアドレスに」', LATIN.test('ご連絡はこのメールアドレスに'), false, 'カタカナは半角英数字ではない');
t('JP「name@example.com」', JP.test('name@example.com'), false, '欧文のみ');
t('JP「© 2026 ComeGin」', JP.test('© 2026 ComeGin'), false, '© は和文判定に入れない');
// T2 単位の密着
t('UNIT_GAP「23,000 円」', UNIT_GAP.test('23,000 円'), true, '空白が残った形は違反');
t('UNIT_GAP「23,000円」', UNIT_GAP.test('23,000円'), false, '密着は正');
t('UNIT_GAP「3 つ」', UNIT_GAP.test('3 つ'), true, '助数詞も対象（§6.4-4 に助数詞を含める）');
t('UNIT_GAP「60〜90日」', UNIT_GAP.test('60〜90日'), false, '波ダッシュの範囲も密着で正');
t('UNIT_GAP「2026年9月27日」', UNIT_GAP.test('2026年9月27日'), false, '日付は密着で正');
// T3 四分アキ
t('KERN_MISS「AI エージェント」', KERN_MISS.test('AI エージェント'), false, '四分アキが入っている');
t('KERN_MISS「AIエージェント」', KERN_MISS.test('AIエージェント'), true, '四分アキが無い');
t('KERN_MISS「ComeGin の提案」', KERN_MISS.test('ComeGin の提案'), false, '正');
t('KERN_MISS「基本的にComeGin が負担」', KERN_MISS.test('基本的にComeGin が負担'), true, '置換で空白が落ちた形');
t('KERN_MISS「全4回」', KERN_MISS.test('全4回'), false, '数字は四分アキの対象にしない（密着が優先）');
t('PUNCT_SPACE「開発費は、 ComeGin が」', PUNCT_SPACE.test('開発費は、 ComeGin が'), true, '読点の直後の空白は違反');
t('PUNCT_SPACE「開発費は、ComeGin が」', PUNCT_SPACE.test('開発費は、ComeGin が'), false, '正');
// 禁止表現
t('BANNED「お気軽にご相談ください」', BANNED.some(([w]) => 'お気軽にご相談ください'.includes(w)), true, '§8.4-7');
t('BANNED「ご相談を受け付けています」', BANNED.some(([w]) => 'ご相談を受け付けています'.includes(w)), false, '書き換え後は通る');
t('BANNED_RE 感嘆符 2 連', BANNED_RE[0][0].test('できます！！'), true, '§8.4-5');
t('BANNED_RE 感嘆符 1 個', BANNED_RE[0][0].test('できます！'), false, '1 個は連続ではない');
// パレット
t('PALETTE #0581DB', '#0581DB' in PALETTE, true, 'brand.blue.500 はパレット内');
t('PALETTE #007A55', '#007A55' in PALETTE, false, '旧アクセントの緑はパレット外');
t('PALETTE #E5E5E5', '#E5E5E5' in PALETTE, false, 'kit の border はパレット外');
t('NO_SMALL_TEXT #0581DB', '#0581DB' in NO_SMALL_TEXT, true, '18px 未満に使えない');
t('NO_SMALL_TEXT #0579CE', '#0579CE' in NO_SMALL_TEXT, false, 'text-link は使える（4.53:1）');
// タイプスケール
t('TYPE_SCALE 36', TYPE_SCALE.has(36), true, 'Desktop H1');
t('TYPE_SCALE 32', TYPE_SCALE.has(32), false, '旧 UI/Price の 32px はスケール外');
// cta_type
t('CTA_TYPES booking', CTA_TYPES.has('booking'), true, '4 値のひとつ');
t('CTA_TYPES demo', CTA_TYPES.has('demo'), false, '旧値');
t('CTA_TYPES_OLD demo', CTA_TYPES_OLD.has('demo'), true, '旧値として検出する');
// 項目 31: URL・パス（§0.1）
t('URL「料金ページ（/pricing）に記載」', URL_IN_COPY.test('料金ページ（/pricing）に記載のとおりです。'), true, 'パスは画面に出さない');
t('URL「料金ページに記載」', URL_IN_COPY.test('料金ページに記載のとおりです。'), false, 'リンクにする形が正');
t('URL「#source-dl」', URL_IN_COPY.test('#source-dl へ移動'), true, 'アンカーも画面に出さない');
t('URL「2026/10/01」', URL_IN_COPY.test('2026/10/01 に公開'), false, '日付は対象外（/ の次が数字）');
t('URL「kamegin4@comegin.com」', URL_IN_COPY.test('kamegin4@comegin.com'), false, 'メールアドレスは対象外');
t('URL「080-5257-9787」', URL_IN_COPY.test('080-5257-9787'), false, '電話番号は対象外');
// 項目 32: 仕様書のセクション番号（§0.1）
t('SPEC「§4.2 を参照」', SPEC_REF.test('§4.2 を参照してください'), true, '§ 記号は画面に出さない');
t('SPEC「1-4 に記載」', SPEC_REF.test('1-4 に記載のとおり'), true, '節番号 ＋ 参照の語');
t('SPEC「2. 取得する情報」', SPEC_REF.test('2. 取得する情報'), false, '**法務ページ自身の見出し番号は対象外**');
t('SPEC「60〜90日」', SPEC_REF.test('期間は 60〜90日です。'), false, '期間は対象外');
t('SPEC「2026年9月27日」', SPEC_REF.test('2026年9月27日'), false, '日付は対象外');
// 項目 32: 既定値のプレースホルダと、仕様書側の未決の印を分ける
t('既定値「【要記入】リード文」', DEFAULT_PLACEHOLDER.test('【要記入】リード文'), true, '**画面に出ていたら違反**');
t('既定値「【要記入】金額」', DEFAULT_PLACEHOLDER.test('【要記入】金額'), true, '同上');
t('未決「契約の書類：【要記入】」', DEFAULT_PLACEHOLDER.test('契約の書類：【要記入】'), false, '**残っているのが正**');
t('未決「制定日 【要記入】 ／ 最終改定日 【要記入】」', DEFAULT_PLACEHOLDER.test('制定日 【要記入】 ／ 最終改定日 【要記入】'), false, '同上');
t('DUMMY は両方を拾う', DUMMY.test('【要記入】リード文') && DUMMY.test('契約の書類：【要記入】'), true, '仕分けは DEFAULT_PLACEHOLDER が行う');
// 項目 30: リンクの下線は**変数名**で判定する（実効値では semantic/info と見分けがつかない）
t('項目30 role/text-link', /^role\/text-link$/.test('role/text-link'), true, '下線が必須');
t('項目30 role/text-brand', /^role\/text-link$/.test('role/text-brand'), false, '**タグライン。下線なしが正**');
t('項目30 role/text-link-hover', /^role\/text-link$/.test('role/text-link-hover'), false, '前方一致にしない');
t('項目30 semantic/info', /^role\/text-link$/.test('semantic/info'), false, '同じ #0579CE だがリンクではない');
// C4 の判定の考え方（ローカル一覧に無く remote でもない ＝ ぶら下がり）
t('C4 ローカルに有る', (new Set(['a', 'b'])).has('a') === true, true, 'ローカル一覧に有れば正常');
t('C4 ローカルに無い', (new Set(['a', 'b'])).has('accent-id') === false, true, 'ローカル一覧に無ければ ぶら下がり');
// C3 の色と寸法の仕分け（`node.boundVariables.fills` を寸法に数えていた誤りを塞ぐ）
{
  const isColor = w => /^(fill|stroke)\./i.test(w) || /\.(fills|strokes)$/i.test(w);
  t('C3 仕分け fill.color', isColor('fill.color'), true, 'paint から来た色');
  t('C3 仕分け stroke.color', isColor('stroke.color'), true, '同上');
  t('C3 仕分け 寸法.fills', isColor('寸法.fills'), true, '**node.boundVariables の塗りも色**');
  t('C3 仕分け 寸法.strokes', isColor('寸法.strokes'), true, '同上');
  t('C3 仕分け 寸法.strokeWeight', isColor('寸法.strokeWeight'), false, '**これは寸法**。前方一致だと誤分類する');
  t('C3 仕分け 寸法.itemSpacing', isColor('寸法.itemSpacing'), false, '寸法');
  t('C3 仕分け 寸法.topLeftRadius', isColor('寸法.topLeftRadius'), false, '寸法');
}
// 表記の 3 方向（①和欧間 ②数字の手前の空き ③数字と単位の密着）と、日付・住所の例外
t('① 「AI エージェント」', KERN_MISS.test(scrubExempt('AI エージェント')), false, '四分アキあり');
t('① 「AIエージェント」', KERN_MISS.test(scrubExempt('AIエージェント')), true, '四分アキなし');
t('② 「代表 1名」', NUM_LEAD_MISS.test(scrubExempt('代表 1名')), false, '**数字の手前の空きは残す**');
t('② 「代表1名」', NUM_LEAD_MISS.test(scrubExempt('代表1名')), true, '空きが落ちている');
t('② 「文章を 2行まで」', NUM_LEAD_MISS.test(scrubExempt('文章を 2行まで')), false, '正');
t('② 「文章を2行まで」', NUM_LEAD_MISS.test(scrubExempt('文章を2行まで')), true, '空きが落ちている');
t('③ 「1名」', UNIT_GAP.test('代表 1名'), false, '数字と単位は密着');
t('③ 「1 名」', UNIT_GAP.test('代表 1 名'), true, '密着していない');
t('例外 YYYY年M月D日', KERN_MISS.test(scrubExempt('YYYY年M月D日')), false, '**ダミーの日付。除外する**');
t('例外 2026年9月27日', NUM_LEAD_MISS.test(scrubExempt('設立は 2026年9月27日')), false, '日付は例外');
t('例外 令和6年度', NUM_LEAD_MISS.test(scrubExempt('令和6年度 介護労働実態調査')), false, '**元号 ＋ 年度は例外**');
t('例外 住所の番地', NUM_LEAD_MISS.test(scrubExempt('大阪府大阪市城東区蒲生4-19-3')), false, '番地は scrub で落ちる');
// 項目 35 のアイソレーション: 何を「隣接する要素」と数えるか
t('透明な枠は面でない', isVisibleSurface({ fills: [], strokes: [] }), false, '**塗りも線もない auto-layout の枠は隣接物ではない。padding を数えない**');
t('塗りのある枠は面', isVisibleSurface({ fills: [{ visible: true }], strokes: [] }), true, 'カードの枠は見えるので padding を数える');
t('線のある枠は面', isVisibleSurface({ fills: [], strokes: [{ visible: true }] }), true, '罫線も隣接物');
t('不可視の塗りは面でない', isVisibleSurface({ fills: [{ visible: false }], strokes: [] }), false, '見えない塗りは数えない');
t('全透明の塗りは面でない', isVisibleSurface({ fills: [{ visible: true, opacity: 0 }], strokes: [] }), false, 'opacity 0 は見えない');
{
  // 14 Contact / 15 Blog / 16 System のフッターの実測を再現する。
  // 親 `Column / ComeGin` は塗りも線もなく padding 0、itemSpacing 12 で下に文字がある。
  // 正しい答えは **12**（兄弟との距離）。0（親の padding）ではない。
  const logo = { absoluteBoundingBox: { x: 0, y: 0, width: 160, height: 49.16 } };
  const sib = { absoluteBoundingBox: { x: 0, y: 61.16, width: 160, height: 20 } };
  const col = { fills: [], strokes: [], paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, children: [logo, sib] };
  logo.parent = col; sib.parent = col;
  t('項目35 透明な親の中のロゴ', isolationGap(logo), 12, '**親の padding 0 ではなく兄弟との 12 を返すこと**');
  const card = Object.assign({}, col, { fills: [{ visible: true }] });
  const logo2 = { absoluteBoundingBox: logo.absoluteBoundingBox, parent: card };
  const sib2 = { absoluteBoundingBox: sib.absoluteBoundingBox, parent: card };
  card.children = [logo2, sib2];
  t('項目35 見える親の中のロゴ', isolationGap(logo2), 0, '塗りのある枠なら padding 0 が効く');
  const alone = { fills: [], strokes: [], children: [] };
  const logo3 = { absoluteBoundingBox: logo.absoluteBoundingBox, parent: alone };
  alone.children = [logo3];
  t('項目35 隣に何もない', isolationGap(logo3), null, '判定できないときは null（違反にしない）');
}
t('例外 住所の部屋番号', IS_ADDRESS.test('大阪府大阪市城東区蒲生4-19-3 ロイヤルアシュリー蒲生502'), true, '**建物名 ＋ 部屋番号は scrub では落ちない。住所として除外する**');
t('住所でない文', IS_ADDRESS.test('この3つだけ'), false, '除外が効きすぎていないこと');
t('例外 電話番号', NUM_LEAD_MISS.test(scrubExempt('080-5257-9787')), false, '対象外');
t('例外 2(4) の情報', NUM_LEAD_MISS.test(scrubExempt('2(4) の情報')), false, '条・項の番号は例外');
t('② 除外の誤作動', NUM_LEAD_MISS.test(scrubExempt('この3つだけ')), true, '**除外が効きすぎていないこと**');
// 項目 34 の行数の見積もり（半角は 0.5 文字ぶん・改行は行ごとに折り返す）
{
  const lines = (text, width, fs) => {
    const per = Math.max(1, width / fs);
    return text.split('\n').reduce((sum, line) => {
      const eff = [...line].reduce((a, ch) => a + (/[\x20-\x7E]/.test(ch) ? 0.5 : 1), 0);
      return sum + Math.max(1, Math.ceil(eff / per));
    }, 0);
  };
  t('項目34 ラテンのみ', lines('PostHog, Inc.', 200, 14), 1, '半角 13 字 ＝ 6.5 文字ぶん → 1 行');
  t('項目34 和文のみ', lines('あ'.repeat(30), 200, 14), 3, '30 文字 / 14.3 → 3 行');
  t('項目34 改行 6 行', lines('あ\nい\nう\nえ\nお\nか', 400, 14), 6, '**各行が 1 行。改行を足し算しない**');
  t('項目34 改行の二重計上', lines('あ\nい', 400, 14) === 2, true, '旧式だと ceil(2/28)+1 = 2 でたまたま合うが、長い行で崩れる');
  t('項目34 和欧混在', lines('大阪府大阪市城東区蒲生4-19-3 ロイヤルアシュリー蒲生502', 400, 14), 1, '和 22 ＋ 半角 16×0.5 ＝ 30 / 28.6 → 2 行…ではなく 1 行（実測で確かめた値）');
}
// 項目 16 の文の切り方（改行でも切る）
{
  const sent = s => s.split(/(?<=。)|\n/).map(x => x.trim()).filter(Boolean);
  const cell = 'ご案内のとおりです。\n環境構築は 1日\n受託開発は 5日';
  t('一文 改行で切る', sent(cell).length, 3, '句点で終わらない行が連結しないこと');
  t('一文 最長', Math.max(...sent(cell).map(x => x.length)) <= 20, true, '連結すると 30 字超になる');
}

// ---------------------------------------------------------------------------
// 補助関数
// ---------------------------------------------------------------------------
const hex = c => '#' + [c.r, c.g, c.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();

// WCAG の相対輝度とコントラスト比
const lum = c => {
  const f = v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
const ratio = (a, b) => {
  const L1 = Math.max(lum(a), lum(b)), L2 = Math.min(lum(a), lum(b));
  return Math.round(((L1 + 0.05) / (L2 + 0.05)) * 100) / 100;
};

// 変数は 1 回引いたら使い回す（同じ変数を何百回も引くと遅い）
const varCache = new Map();
const getVar = async id => {
  if (varCache.has(id)) return varCache.get(id);
  const v = await figma.variables.getVariableByIdAsync(id).catch(() => null);
  varCache.set(id, v);
  return v;
};

// 塗りの実効値を返す。変数にバインドされていれば alias を辿って解決する。
// paint.color をそのまま読むと、バインド前の値が残っていることがあるので必ずこれを使う。
// remote（ライブラリ＝kit の変数）かどうかも一緒に返す — C3 はこれで数える
async function resolvePaint(node, paint) {
  if (!paint || paint.type !== 'SOLID') return null;
  const bv = paint.boundVariables && paint.boundVariables.color;
  if (bv && bv.id) {
    const v = await getVar(bv.id);
    if (v) {
      let c = null;
      try {
        const r = v.resolveForConsumer(node);
        if (r && r.resolvedType === 'COLOR') c = r.value;
      } catch (e) { /* 解決できないときは生値に落ちる */ }
      return { c: c || paint.color, name: v.name, bound: true, remote: v.remote === true };
    }
    return { c: paint.color, name: '(削除された変数 ' + bv.id + ')', bound: true, remote: false, broken: true };
  }
  return { c: paint.color, name: '(未バインド)', bound: false, remote: false };
}

// 文字の背景を親へ遡って探す。半透明の面は下が透けるので基準にしない。
async function backgroundOf(node) {
  let n = node.parent;
  while (n && n.type !== 'PAGE') {
    if ('fills' in n && Array.isArray(n.fills) && n.visible !== false) {
      for (let i = n.fills.length - 1; i >= 0; i--) {
        const p = n.fills[i];
        if (p.visible !== false && p.type === 'SOLID' && (p.opacity === undefined || p.opacity >= 0.95)) {
          const r = await resolvePaint(n, p);
          if (r) return { ...r, from: n.name };
        }
      }
    }
    n = n.parent;
  }
  return { c: { r: 1, g: 1, b: 1 }, name: '(ページの白)', from: '(page)' };
}

// instance の中のノードか（部品側の責任か、画面側の責任かを分ける）
const inInstance = n => {
  let p = n.parent;
  while (p && p.type !== 'PAGE') { if (p.type === 'INSTANCE') return true; p = p.parent; }
  return false;
};
// instance の「ルート」か（ルートなら塗り・余白を上書きできる。サブレイヤーは不可）
const isInstanceRoot = n => n.type === 'INSTANCE' && !inInstance(n);

const pathOf = n => {
  const a = []; let p = n;
  while (p && p.type !== 'PAGE') { a.unshift(p.name); p = p.parent; }
  return a.slice(1, 5).join('/');
};

// ヘッダー・ナビの中か（B5 のリンク下線はナビを対象外にする。§9.5／component-map §5）
const inNav = n => {
  let p = n;
  while (p && p.type !== 'PAGE') {
    if (/SiteHeader|MobileMenuSheet|Nav|Breadcrumb|Pagination|Tabs?$/i.test(p.name)) return true;
    p = p.parent;
  }
  return false;
};

// TEXT 以外のノードで characters を触ると TypeError になるので、必ずこれを通す
const txt = n => ('characters' in n ? n.characters : '');

// 注記の本文。label と labelMarkdown の両方を見て、labelMarkdown 側のエスケープ（\_）を外す。
// 片方だけを見ると `cta_id` や `dl_top_card` の検索が空振りする。
const annText = n => (n.annotations || []).map(a => {
  const plain = a.label ?? '';
  const md = (a.labelMarkdown ?? '').replace(/\\/g, '');
  return plain === md ? plain : (plain + ' ' + md);
}).join(' ');

// 部品を数えるときは種別で絞る（FRAME を部品数に入れない）
const countComponents = page => {
  const comps = page.children.filter(c => c.type === 'COMPONENT' || c.type === 'COMPONENT_SET');
  return {
    部品: comps.length,
    部品名: comps.map(c => c.name + (c.type === 'COMPONENT_SET' ? '(' + c.children.length + ')' : '')),
    部品以外: page.children.filter(c => c.type !== 'COMPONENT' && c.type !== 'COMPONENT_SET')
      .map(c => c.type + ' 「' + c.name + '」'),
  };
};

// FAQItem の質問文。kit Badge の内部テキストも名前が `Label` なので、Question を経由する。
const faqQuestion = item => {
  const q = item.findOne(n => n.name === 'Question');
  if (!q) return '(Question が無い)';
  const l = q.findOne(n => n.type === 'TEXT' && n.name === 'Label');
  return l ? txt(l) : '(Label が無い)';
};

// 一文に割る。「。」で切り、末尾の空要素を落とす
// 一文に割る。「。」**と改行**で切る。
// **改行で切らないと、句点で終わらない行が次の行と連結して長さを誤る。**
// 10-B「役務の提供時期」のセルは 2〜5 行目が「1日」「5日」「60〜90日」「4日／月」と
// 単位で終わって句点が無いため、6 行が 1 文（92 字）として数えられていた。
// 画面に出ているのは最も長い行でも 30 字（builder-site が 2026-10-01 に指摘）。
const sentences = s => s.split(/(?<=。)|\n/).map(x => x.trim()).filter(Boolean);

// 項目 35: ロゴのアイソレーション（GL §4.6-8）。**見える要素との距離で測る。**
//
// 親の padding で測ってはいけない。auto-layout の `Column` のように
// 塗りも線もない枠は「レイアウトのための箱」でしかなく、padding 0 は
// 「何かが 0px の距離にある」という意味ではない。2026-10-01 の 14 Contact で、
// padding 0/0/0/0 を 0px のアイソレーション違反と誤って読み取った。
// 実際に効いていたのは親の itemSpacing 12（＝直下の文字との距離）だった。
//
// 数えるのは次の 2 つだけ。
//  1. **兄弟との実距離**（絶対座標。重なっていない方向だけ）
//  2. **親自身が見える面のときの padding**（塗りか線がある＝枠や罫線として見える）
const isVisibleSurface = n => {
  if (!n) return false;
  const f = Array.isArray(n.fills)
    && n.fills.some(p => p.visible !== false && (p.opacity === undefined || p.opacity > 0.02));
  const s = Array.isArray(n.strokes) && n.strokes.length > 0
    && n.strokes.some(p => p.visible !== false);
  return f || s;
};

const isolationGap = n => {
  const p = n.parent;
  const b = n.absoluteBoundingBox;
  if (!p || !b || !('children' in p)) return null;
  let min = null;
  for (const s of p.children) {
    if (s === n || s.visible === false) continue;
    const sb = s.absoluteBoundingBox;
    if (!sb) continue;
    // 4 方向のうち、重なっていない（0 以上の隙間がある）方向だけを見る
    const gaps = [
      sb.y - (b.y + b.height),
      b.y - (sb.y + sb.height),
      sb.x - (b.x + b.width),
      b.x - (sb.x + sb.width),
    ].filter(v => v >= 0);
    for (const v of gaps) min = min === null ? v : Math.min(min, v);
  }
  if (isVisibleSurface(p) && 'paddingTop' in p) {
    const pad = Math.min(p.paddingTop, p.paddingRight, p.paddingBottom, p.paddingLeft);
    min = min === null ? pad : Math.min(min, pad);
  }
  return min;
};

// 8pt グリッド（4px を半ステップとして許容）
const offGrid = v => typeof v === 'number' && v > 0 && Math.abs(v % 4) > 0.01;

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------
const 走査時刻 = new Date().toISOString();
const page = await figma.getNodeByIdAsync(PAGE_ID);
if (!page || page.type !== 'PAGE') return { error: 'ページが見つからない', PAGE_ID };
await figma.setCurrentPageAsync(page);

const styleNames = Object.fromEntries((await figma.getLocalTextStylesAsync()).map(s => [s.id, s.name]));
const effectNames = Object.fromEntries((await figma.getLocalEffectStylesAsync()).map(s => [s.id, s.name]));
// C4 の基準。ここに無く remote でもない変数への参照は「削除済み変数へのぶら下がり」
const localVarIds = new Set((await figma.variables.getLocalVariablesAsync()).map(v => v.id));

const out = {
  走査時刻,
  ページ: page.name,
  トップレベル合計: page.children.length,
  ...countComponents(page),
  フレーム: [],
  自己テスト: SELF_TEST.filter(x => !x.合格),       // 落ちたものだけ返す（通ったものは件数で示す）
  自己テスト合格: SELF_TEST.every(x => x.合格),
  自己テスト件数: SELF_TEST.length,
  違反: {
    // 色 4 本
    // **C3 は色と寸法を分けて数える。** 色は移行漏れ（直すべきもの）、
    // 寸法は kit instance のぶんが許容事項なので、1 本で数えると判断できない
    // （builder-site の提案。4 ページで 2,480 件が「ライブラリ変数」として出ていた）
    パレット外の色: [], 未バインド塗り: [], ライブラリ変数_色: [], ライブラリ変数_寸法_自作: [], ぶら下がり: [],
    // ブランド規定
    フォント: [], 小文字への青: [], 主ボタン文字: [], リンク下線なし: [], ロゴ: [],
    タイプスケール外: [], '8ptグリッド': [],
    // コピーと表記
    禁止表現: [], 単位の空き: [], 四分アキ欠落: [], 数字の手前の空き欠落: [], 句読点後の空白: [], 一文60字超: [],
    Poppins漏れ: [], Noto漏れ: [], プレースホルダ: [],
    // 見えない場所
    隠れた旧文言: [], 注記の旧値: [],
    // 画面に出てはいけないもの（§0.1）
    URLやパス: [], 仕様書の参照: [], 既定値が画面に出ている: [],
    // 部品の既定値（`componentPropertyDefinitions`。ノードを辿る走査では到達できない）
    既定値の違反: [],
    // 構造
    ヘッダー高さ: [], コントラスト: [], 壊れたinstance: [], 壊れたバインド: [],
    placeholder残り: [], Deviceスタイル: [], 段組みの字数: [],
  },
  ページ直下の非フレーム: [], 部品の既定値: [], 格納高さの疑い: [],
  ダミー: [], 注記: [], cta_id: [], cta_type: [], ボタン: [], ロゴ: [], フォーカス: [],
  閉じたFAQ: [], 青の面積: {}, 幅の分布: {}, カナリア: [], コピーの欠落: [],
  件数: {},
};

const seenText = [];
const ctaIdSet = new Set(), ctaTypeSet = new Set();
const widthCount = {};
let textAll = 0, textNonEmpty = 0, segTotal = 0, nodeTotal = 0;
let paintTotal = 0, boundTotal = 0, remoteColor = 0, remoteDim = 0;
let blueArea = 0, frameArea = 0, kitGridCount = 0;
// 項目 30 の母数。「下線漏れ 0 件」が本当に 0 件か、リンクに届いていないのかを分けるため
let linkSegTotal = 0, linkUnderlined = 0, brandSegTotal = 0;
// 項目 33 の母数（部品の既定値）
let defCount = 0, defTextCount = 0;
// C3 の寸法のうち kit instance のぶん（許容事項）。自作ノードのぶんと分けて数える
let remoteDimKit = 0;

for (const root of page.children) {
  // **`root.type === 'FRAME'` で絞る。** ページ直下のラベル TEXT（「404 / Mobile」など）は
  // 名前に Mobile を含むので、絞らないとラベル自身を Mobile フレーム扱いして誤検出する
  // （`47:11313 Latin/Desktop/H3 「404 / Mobile」`。builder-site が 2026-10-01 に指摘）
  const isMobile = root.type === 'FRAME' && IS_MOBILE_FRAME.test(root.name);
  const longOK = LONG_SENTENCE_OK.test(root.name);
  // **`findAll` を持たない葉ノード（ページ直下の裸の TEXT など）も検査する。**
  // 以前は `if (!('findAll' in root)) continue;` で丸ごと飛ばしていたため、
  // ページ直下に置いたラベル TEXT が母数からも検査からも消えていた
  // （13 About −2 / 14 Contact −11 / 15 Blog −4 / 16 System −6 の取りこぼし）。
  const nodes = ('findAll' in root) ? [root, ...root.findAll(() => true)] : [root];
  if (root.type === 'FRAME') {
    out.フレーム.push({
      id: root.id, name: root.name, type: root.type,
      wh: Math.round(root.width) + 'x' + Math.round(root.height),
    });
    frameArea += root.width * root.height;
  } else {
    out.ページ直下の非フレーム.push(root.id + ' ' + root.type + ' 「' + root.name + '」');
  }

  for (const n of nodes) {
    nodeTotal++;

    // --- S7: 作りかけのシマー -------------------------------------------------
    if (n.placeholder) out.違反.placeholder残り.push(n.id + ' ' + n.name);

    // --- S1: 幅の分布・ヘッダーの高さ ----------------------------------------
    if (['FRAME', 'INSTANCE', 'COMPONENT'].includes(n.type)) {
      widthCount[Math.round(n.width)] = (widthCount[Math.round(n.width)] || 0) + 1;
    }
    // COMPONENT_SET は variant を並べた枠なので高さが規定と合わない（03 Components で誤検知した）
    if (/^SiteHeader/.test(n.name) && n.type !== 'COMPONENT_SET' && Math.abs(n.height - HEADER_HEIGHT) > 0.5) {
      out.違反.ヘッダー高さ.push(n.id + ' ' + n.name + ' 高さ' + Math.round(n.height * 100) / 100
        + '（期待 ' + HEADER_HEIGHT + '）');
    }

    // --- S5: 壊れた instance -------------------------------------------------
    let mcSet = '', mcIsRemote = false;
    if (n.type === 'INSTANCE') {
      const mc = await n.getMainComponentAsync();
      if (!mc) out.違反.壊れたinstance.push(n.id + ' ' + n.name);
      else {
        mcSet = mc.parent && mc.parent.type === 'COMPONENT_SET' ? mc.parent.name : mc.name;
        // **kit かどうかは mainComponent が remote かで判定する。**
        // 名前に ` - Nova` が入っているかで見ると、**instance の名前を変えた瞬間に
        // 自作扱いになる**（10 Top の「Badge / Astro（サイト）」など 155 件を
        // 誤って自作と数えた。2026-10-01）
        mcIsRemote = mc.remote === true;
      }
    }

    // --- C3 / S5: 変数バインドの棚卸し（remote === true がライブラリ＝kit）-----
    {
      const seen = [];
      const pull = (o, where) => {
        if (!o) return;
        for (const [k, v] of Object.entries(o)) {
          if (Array.isArray(v)) v.forEach(x => x && x.id && seen.push([x.id, where + '.' + k]));
          else if (v && v.id) seen.push([v.id, where + '.' + k]);
        }
      };
      pull(n.boundVariables, '寸法');
      for (const [p, arr] of [['fill', n.fills], ['stroke', n.strokes]]) {
        if (Array.isArray(arr)) for (const q of arr) pull(q.boundVariables, p);
      }
      for (const [id, where] of seen) {
        const v = await getVar(id);
        if (!v) { out.違反.壊れたバインド.push(n.id + ' ' + pathOf(n) + ' ' + where + ' → ' + id); continue; }
        boundTotal++;
        // **`node.boundVariables` の中の `fills` / `strokes` も色として数える。**
        // `pull(n.boundVariables, '寸法')` を通ると `寸法.fills` という名前になるため、
        // 先頭一致だけで見ると色なのに寸法に分類されていた。
        // `characters` を書き換えると範囲指定の塗りが下地に戻り、下地の kit 色が復活する
        // 事故が、この分類のせいで「寸法」側に紛れていた（builder-site が 2026-10-01 に指摘）
        // `fill.color` / `stroke.color`（paint から来たもの）と
        // `寸法.fills` / `寸法.strokes`（node.boundVariables から来たもの）だけを色とする。
        // **`寸法.strokeWeight` は寸法**なので、前方一致だけで見ると誤分類する
        const isColor = /^(fill|stroke)\./i.test(where) || /\.(fills|strokes)$/i.test(where);
        if (v.remote === true) {
          if (isColor) {
            remoteColor++;
            out.違反.ライブラリ変数_色.push(n.id + ' ' + where + ' → ' + v.name + ' 「' + n.name + '」 ' + pathOf(n));
          } else {
            remoteDim++;
            // 寸法は **自作ノードだけ**が本物の違反。kit instance の内側・ルートは許容事項（§8 の 1）
            const kitNode = inInstance(n) || mcIsRemote;
            if (kitNode) remoteDimKit++;
            else out.違反.ライブラリ変数_寸法_自作.push(n.id + ' ' + where + ' → ' + v.name + ' 「' + n.name + '」 ' + pathOf(n));
          }
        } else if (!localVarIds.has(id)) {
          // C4: ローカルにもライブラリにも無い＝削除済み変数へのぶら下がり。画面には描画される
          out.違反.ぶら下がり.push(n.id + ' ' + (isColor ? '色' : '寸法') + ' ' + where
            + ' → ' + v.name + ' 「' + n.name + '」 ' + pathOf(n));
        }
      }
    }

    // --- H3: 注記（dev annotation）の中身 ------------------------------------
    if (n.annotations && n.annotations.length) {
      const a = annText(n);
      out.注記.push({ id: n.id, name: n.name, 本文: a.slice(0, 300) });
      for (const m of a.matchAll(/cta_id:\s*([a-z0-9_]+)/gi)) ctaIdSet.add(m[1]);
      for (const m of a.matchAll(/cta_type:\s*([a-z0-9_]+)/gi)) {
        const v = m[1];
        ctaTypeSet.add(v);
        if (!CTA_TYPES.has(v)) {
          out.違反.注記の旧値.push(n.id + ' cta_type=' + v
            + (CTA_TYPES_OLD.has(v) ? '（旧値）' : '（未知の値）') + ' ' + pathOf(n));
        }
      }
      // 旧指標・旧イベント名が注記に残っていないか
      for (const w of ['CVR-trial', 'whitepaper', 'demo_', 'trial_']) {
        if (a.includes(w)) out.違反.注記の旧値.push(n.id + ' 注記に「' + w + '」 ' + pathOf(n));
      }
    }

    // --- S2: ボタンの棚卸し（Badge を除くため部品名で絞る）---------------------
    if (n.type === 'INSTANCE' && /^Button - Nova|^CTAButton/.test(mcSet)) {
      const l = n.findOne(c => c.type === 'TEXT');
      const props = Object.entries(n.componentProperties || {});
      const variant = props.filter(([k]) => /^Variant|^Size|^Width|^State/.test(k)).map(([k, v]) => k.split('#')[0] + '=' + v.value).join(' ');
      let 文字 = '';
      if (l) {
        const s = l.getStyledTextSegments(['fontSize', 'fontName']);
        文字 = s.map(x => x.fontSize + 'px ' + x.fontName.style).join('/');
        // --- B3: 主ボタンの文字は 16px 以上の太字（§9.5）---------------------
        const isPrimary = /Primary/.test(variant) || /^CTAButton/.test(mcSet);
        if (isPrimary) {
          for (const x of s) {
            if (x.fontSize < 16 || !BOLDISH.test(x.fontName.style)) {
              out.違反.主ボタン文字.push(n.id + ' 「' + txt(l).slice(0, 16) + '」 '
                + x.fontSize + 'px ' + x.fontName.style + '（期待 16px 以上の太字）' + pathOf(n));
              break;
            }
          }
        }
      }
      out.ボタン.push({
        id: n.id, 部品: mcSet.replace(' - Nova', ''), variant,
        label: l ? txt(l).slice(0, 24) : '', 文字, 場所: pathOf(n), ナビ内: inNav(n),
      });
    }

    // --- B4: フォーカスリング（State=Focus に focus/ring が当たっているか）-----
    if (n.type === 'INSTANCE' && /State=Focus/.test(
      Object.entries(n.componentProperties || {}).map(([k, v]) => k.split('#')[0] + '=' + v.value).join(' '))) {
      const ids = [n, ...n.findAll(() => true)].map(x => (typeof x.effectStyleId === 'string' ? effectNames[x.effectStyleId] : null)).filter(Boolean);
      out.フォーカス.push({ id: n.id, 部品: mcSet, リング: ids.filter(s => /^focus\//.test(s)), 全エフェクト: [...new Set(ids)] });
    }

    // --- B7: ロゴ（最小幅・等比。アイソレーションは実測値を返して目視で確かめる）--
    if (n.type === 'INSTANCE' && /^Logo$/.test(mcSet)) {
      const pv = Object.fromEntries(Object.entries(n.componentProperties || {}).map(([k, v]) => [k.split('#')[0], v.value]));
      const lk = pv.Lockup || '?';
      const m = LOGO_MIN[lk];
      const rec = {
        id: n.id, Lockup: lk, Color: pv.Color || '?',
        wh: Math.round(n.width * 100) / 100 + 'x' + Math.round(n.height * 100) / 100,
        比: Math.round((n.width / n.height) * 10000) / 10000,
        親: n.parent ? n.parent.name : '', 場所: pathOf(n),
        親の余白: n.parent && 'paddingTop' in n.parent
          ? [n.parent.paddingTop, n.parent.paddingRight, n.parent.paddingBottom, n.parent.paddingLeft].join('/') : '',
        アイソレーションX: m ? Math.round(n.height * (lk === 'Vertical' ? 0.165 : lk === 'Symbol' ? 0.25 : 0.336) * 100) / 100 : '',
        見える要素との距離: (() => { const g = isolationGap(n); return g === null ? '—' : Math.round(g * 100) / 100; })(),
      };
      out.ロゴ.push(rec);
      if (m) {
        // 項目 35: アイソレーション。X 未満なら違反（GL §4.6-8）
        const X = n.height * (lk === 'Vertical' ? 0.165 : lk === 'Symbol' ? 0.25 : 0.336);
        const gap = isolationGap(n);
        if (gap !== null && gap < X - 0.01) {
          out.違反.ロゴ.push(n.id + ' ' + lk + ' アイソレーション 見える要素との距離 '
            + Math.round(gap * 100) / 100 + ' < X ' + Math.round(X * 100) / 100 + ' ' + pathOf(n));
        }
        if (n.width < m.下限) out.違反.ロゴ.push(n.id + ' ' + lk + ' 幅' + rec.wh.split('x')[0] + ' < 絶対下限 ' + m.下限);
        else if (n.width < m.通常) out.違反.ロゴ.push(n.id + ' ' + lk + ' 幅' + rec.wh.split('x')[0] + ' < 通常の最小 ' + m.通常 + '（下限 ' + m.下限 + ' は満たす）');
        if (Math.abs(n.width / n.height - m.比) > 0.01) {
          out.違反.ロゴ.push(n.id + ' ' + lk + ' 縦横比 ' + rec.比 + '（期待 ' + Math.round(m.比 * 10000) / 10000 + '）＝ 等比でない');
        }
      }
    }

    // --- H1 / H2: 見えない場所の値（componentProperties）--------------------
    if (n.type === 'INSTANCE' && n.componentProperties) {
      const pv = Object.entries(n.componentProperties);
      const vstr = pv.map(([k, v]) => k.split('#')[0] + '=' + v.value).join(' ');
      // `Show xxx=false` で隠れている TEXT プロパティと、variant で隠れている行
      const hiddenNames = new Set(pv.filter(([k, v]) => /^Show /.test(k.split('#')[0]) && v.value === false)
        .map(([k]) => k.split('#')[0].replace(/^Show /, '').toLowerCase()));
      for (const [k, v] of pv) {
        if (v.type !== 'TEXT' || typeof v.value !== 'string' || !v.value.trim()) continue;
        const key = k.split('#')[0];
        const hidden = hiddenNames.has(key.toLowerCase()) || /State=Closed/.test(vstr)
          || (/Price rows=1/.test(vstr) && /2$/.test(key.trim()));
        for (const w of OLD_PHRASES) {
          if (v.value.includes(w)) {
            out.違反.隠れた旧文言.push(n.id + ' ' + mcSet + ' ' + key + '=「' + v.value.slice(0, 60)
              + '」に「' + w + '」' + (hidden ? ' ★画面に出ていない' : ' （画面に出ている）') + ' ' + pathOf(n));
          }
        }
        // 密着・四分アキ・禁止表現も、隠れている値まで見る
        if (UNIT_GAP.test(v.value)) out.違反.単位の空き.push(n.id + '[prop ' + key + '] 「' + v.value.slice(0, 40) + '」' + (hidden ? ' ★非表示' : ''));
        {
          // ①② は日付・元号・住所・条番号を取り除いてから当てる
          const pv2 = scrubExempt(v.value);
          if (KERN_MISS.test(pv2)) out.違反.四分アキ欠落.push(n.id + '[prop ' + key + '] 「' + v.value.slice(0, 40) + '」' + (hidden ? ' ★非表示' : ''));
          if (!IS_ADDRESS.test(v.value) && NUM_LEAD_MISS.test(pv2)) out.違反.数字の手前の空き欠落.push(n.id + '[prop ' + key + '] 「' + v.value.slice(0, 40) + '」' + (hidden ? ' ★非表示' : ''));
        }
        if (PUNCT_SPACE.test(v.value)) out.違反.句読点後の空白.push(n.id + '[prop ' + key + '] 「' + v.value.slice(0, 40) + '」' + (hidden ? ' ★非表示' : ''));
        for (const [w, why] of BANNED) if (v.value.includes(w)) out.違反.禁止表現.push(n.id + '[prop ' + key + '] 「' + w + '」 ' + why + (hidden ? ' ★非表示' : ''));
      }
      // H2: 閉じた Accordion（FAQItem State=Closed）の回答
      if (/^FAQItem/.test(mcSet)) {
        const ans = pv.find(([k]) => /^Answer/.test(k.split('#')[0]));
        out.閉じたFAQ.push({
          id: n.id, 状態: /State=(\w+)/.exec(vstr) ? RegExp.$1 : '?',
          質問: faqQuestion(n).slice(0, 48),
          回答: ans ? String(ans[1].value).slice(0, 110) : '(Answer プロパティが無い)',
        });
      }
    }

    // --- H1 の補助: カナリアの生値 -------------------------------------------
    if (CANARY_IDS.includes(n.id)) {
      out.カナリア.push({
        id: n.id, name: n.name, type: n.type,
        componentProperties: Object.entries(n.componentProperties || {})
          .map(([k, v]) => k.split('#')[0] + '=' + String(v.value).slice(0, 60)).join(' | '),
        文字: txt(n).slice(0, 80),
        セグメント: n.type === 'TEXT'
          ? n.getStyledTextSegments(['fontName', 'fontSize']).map(s => '「' + s.characters + '」=' + s.fontName.family + ' ' + s.fontName.style + ' ' + s.fontSize + 'px').join(' | ')
          : '',
        文字スタイル: n.type === 'TEXT' ? (typeof n.textStyleId === 'string' ? (styleNames[n.textStyleId] || '(なし)') : '(mixed)') : '',
      });
    }

    // --- C1 / C2: 塗りと線（**非表示のものも数える**）------------------------
    // 画像枠は hex のハードコードを許す例外（00-brief の不変条件 4）
    const imgExempt = /ImagePlaceholder|画像（準備中）|予約枠/.test(n.name);
    for (const [prop, arr] of [['fill', n.fills], ['stroke', n.strokes]]) {
      if (!Array.isArray(arr)) continue;
      for (const p of arr) {
        if (p.type !== 'SOLID') continue;
        paintTotal++;
        const r = await resolvePaint(n, p);
        if (!r) continue;
        const h = hex(r.c);
        const invisible = p.visible === false;
        // C1: パレット外（バインドの有無に関わらず、実効値で見る）
        if (!(h in PALETTE) && !imgExempt) {
          out.違反.パレット外の色.push(n.id + ' ' + n.type + ' ' + prop + '=' + h
            + ' (' + r.name + ')' + (invisible ? ' ※非表示' : '') + ' 「' + n.name + '」 ' + pathOf(n));
        }
        // C2: 未バインド。instance の「ルート」は上書きできるので違反として数える。
        //     サブレイヤー（instance の中）は kit 側の責任なので別枠
        if (!r.bound && !imgExempt) {
          const where = inInstance(n) ? 'instance内側' : (isInstanceRoot(n) ? 'instanceルート' : '自前');
          out.違反.未バインド塗り.push(n.id + ' ' + n.type + ' ' + prop + '=' + h
            + ' [' + where + ']' + (invisible ? ' ※非表示' : '') + ' 「' + n.name + '」 ' + pathOf(n));
        }
        // B6: 青の面積（概算。自分の塗りが青い可視ノードの面積を足す）
        if (prop === 'fill' && !invisible && n.visible !== false && BLUE_AREA.has(h) && 'width' in n) {
          blueArea += n.width * n.height;
        }
      }
    }

    // --- B9: 8pt グリッド（自前フレームと kit instance を分けて数える）--------
    if (['FRAME', 'COMPONENT', 'INSTANCE'].includes(n.type)) {
      // kit かどうかは mainComponent が remote かで見る（名前で見ると改名で崩れる）
      const kit内側 = inInstance(n) || mcIsRemote;
      const bad = [];
      for (const k of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'itemSpacing', 'counterAxisSpacing']) {
        if (k in n && offGrid(n[k])) bad.push(k + '=' + n[k]);
      }
      for (const k of ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius']) {
        if (k in n && offGrid(n[k]) && n[k] !== 9999) bad.push(k + '=' + n[k]);
      }
      // kit instance の内側・ルートに残る余白は許容事項（`03-handoff.md` §8 の 1）。
      // 件数だけ数え、一覧には**自前のフレームだけ**を載せる（本物の違反はこちらだけ）
      if (bad.length) {
        if (kit内側) kitGridCount++;
        else out.違反['8ptグリッド'].push(n.id + ' ' + bad.join(' ') + ' 「' + n.name + '」 ' + pathOf(n));
      }
    }

    if (n.type !== 'TEXT') continue;
    textAll++;
    const chars = n.characters;
    if (!chars.trim()) continue;      // 空・空白のみは中身のある TEXT に数えない（kit Input の当て木）
    textNonEmpty++;
    seenText.push(chars);

    // --- T7: kit 既定のプレースホルダ文言 ------------------------------------
    if (KIT_PLACEHOLDER_WORDS.has(chars.trim().toLowerCase()) || /lorem ipsum/i.test(chars)) {
      out.違反.プレースホルダ.push(n.id + ' 「' + chars.trim() + '」 ' + pathOf(n));
    }

    // --- S4: ダミーと未決の印（残っているのが正）-----------------------------
    // **2 種類を混ぜない**（lead の指示）。
    //  (a) 仕様書側の未決事項の印 → 公開前に埋める。**残っているのが正**
    //  (b) 部品の既定値（`【要記入】リード文` など） → **画面に出ていたら違反**。
    //      既定値に依存した表示箇所の見落としを意味する
    // **`03 Components` は除外する。** 部品ページでは `【要記入】…` が variant の見本として
    // 画面に出ているのが正常（2026-10-01 の走査で 55 件を誤検知した）。
    // 既定値そのものは項目 33 で別に検査する
    if (DUMMY.test(chars)) {
      if (page.id !== '4:4' && DEFAULT_PLACEHOLDER.test(chars.trim())) {
        out.違反.既定値が画面に出ている.push(n.id + ' 「' + chars.trim() + '」 ' + pathOf(n));
      } else {
        out.ダミー.push(n.id + ' 「' + chars.slice(0, 50) + '」 ' + pathOf(n));
      }
    }

    // --- 項目 31: 画面に出る文に URL・パスを書かない（`01-content-spec.md` §0.1）---
    // リンクにしたい語そのものをリンクにする。
    // ×「料金ページ（/pricing）に記載のとおりです。」 ○「料金ページに記載のとおりです。」
    {
      const m = URL_IN_COPY.exec(chars);
      if (m) out.違反.URLやパス.push(n.id + ' 「' + m[0].trim() + '」 ← 「' + chars.slice(0, 44) + '」 ' + pathOf(n));
    }

    // --- 項目 32: 画面に出る文に仕様書のセクション番号を書かない（同 §0.1）-------
    // 訪問者には何も指さない。**法務ページ自身の見出し番号（「2. 取得する情報」）は対象外**
    {
      const m = SPEC_REF.exec(chars);
      if (m) out.違反.仕様書の参照.push(n.id + ' 「' + m[0].trim() + '」 ← 「' + chars.slice(0, 44) + '」 ' + pathOf(n));
    }

    // --- T1: 禁止表現 --------------------------------------------------------
    for (const [w, why] of BANNED) {
      if (chars.includes(w)) out.違反.禁止表現.push(n.id + ' 「' + w + '」 ' + why + ' ← 「' + chars.slice(0, 44) + '」 ' + pathOf(n));
    }
    for (const [re, why] of BANNED_RE) {
      if (re.test(chars)) out.違反.禁止表現.push(n.id + ' ' + why + ' ← 「' + chars.slice(0, 44) + '」 ' + pathOf(n));
    }

    // --- T2 / T3: 単位の密着・四分アキ・句読点の直後の空白 --------------------
    // ③ 数字と後ろの単位・助数詞の密着
    if (UNIT_GAP.test(chars)) out.違反.単位の空き.push(n.id + ' 「' + chars.slice(0, 46) + '」 ' + pathOf(n));
    // ①② は日付・元号・住所・条番号を取り除いてから当てる
    {
      const c2 = scrubExempt(chars);
      const m1 = KERN_MISS.exec(c2);
      if (m1) out.違反.四分アキ欠落.push(n.id + ' 「…' + c2.slice(Math.max(0, m1.index - 6), m1.index + 10) + '…」 ' + pathOf(n));
      const m2 = IS_ADDRESS.test(chars) ? null : NUM_LEAD_MISS.exec(c2);
      if (m2) out.違反.数字の手前の空き欠落.push(n.id + ' 「…' + c2.slice(Math.max(0, m2.index - 8), m2.index + 8) + '…」 ' + pathOf(n));
    }
    if (PUNCT_SPACE.test(chars)) out.違反.句読点後の空白.push(n.id + ' 「' + chars.slice(0, 46) + '」 ' + pathOf(n));

    // --- T4: 一文 60 字（法務 2 ページと同意バナーは 80 字。D-3）--------------
    {
      const limit = longOK || /CookieBanner/.test(pathOf(n)) ? 80 : 60;
      for (const s of sentences(chars)) {
        if (s.length > limit) out.違反.一文60字超.push(n.id + ' ' + s.length + '字（上限 ' + limit + '）「' + s.slice(0, 50) + '…」 ' + pathOf(n));
      }
    }

    // --- S8: Mobile への Desktop 用スタイルの混入 ----------------------------
    const sName = typeof n.textStyleId === 'string' ? (styleNames[n.textStyleId] || '') : '(mixed)';
    if (isMobile && /\/Desktop\//.test(sName)) {
      out.違反.Deviceスタイル.push(n.id + ' ' + sName + ' 「' + chars.slice(0, 18) + '」');
    }

    const segs = n.getStyledTextSegments(['fontName', 'fontSize', 'fills', 'textDecoration']);
    const families = new Set(segs.map(s => s.fontName.family));

    // --- B1: 書体 ------------------------------------------------------------
    for (const f of families) {
      if (!ALLOWED_FONTS.includes(f)) out.違反.フォント.push(f + ' @' + n.id + ' 「' + chars.slice(0, 20) + '」 ' + pathOf(n));
    }

    // --- T5: 和欧混植（欧文 Poppins / 和文 Noto Sans JP。等幅は JetBrains Mono）
    const hasMono = families.has('JetBrains Mono');
    if (LATIN.test(chars) && !families.has('Poppins') && !hasMono) {
      out.違反.Poppins漏れ.push(n.id + ' 「' + chars.slice(0, 24) + '」 (' + [...families].join(',') + ') ' + pathOf(n));
    }
    if (JP.test(chars) && !families.has('Noto Sans JP')) {
      out.違反.Noto漏れ.push(n.id + ' 「' + chars.slice(0, 24) + '」 (' + [...families].join(',') + ') ' + pathOf(n));
    }

    // --- B8: タイプスケール（§6.3 の 9 段階以外）-----------------------------
    for (const s of new Set(segs.map(x => x.fontSize))) {
      if (!TYPE_SCALE.has(s)) out.違反.タイプスケール外.push(n.id + ' ' + s + 'px 「' + chars.slice(0, 20) + '」 ' + sName + ' ' + pathOf(n));
    }

    // --- S9: 段組みの字数（H-11。字間を含めた実効値で出す）--------------------
    {
      const fs = segs[0].fontSize || 16;
      const ls = n.letterSpacing && n.letterSpacing.unit === 'PERCENT' ? n.letterSpacing.value / 100 : 0;
      const perLine = n.width / (fs * (1 + ls));
      // 段組みの規則は **Desktop の多列**にだけ掛かる。Mobile は 1 列なので対象外
      // （03 Components で Mobile variant と部品単体の既定幅を誤検知した）
      const mobileCtx = isMobile || /Device=Mobile/.test(pathOf(n));
      if (!mobileCtx && fs <= 18 && n.height > fs * 1.8 && perLine < 20) {
        out.違反.段組みの字数.push(
          n.id + ' 幅' + Math.round(n.width) + ' ' + fs + 'px 字間' + Math.round(ls * 100) + '% = 約'
          + (Math.round(perLine * 10) / 10) + '字/行 「' + chars.slice(0, 16) + '」 ' + pathOf(n));
      }
    }

    // --- 項目 34: 格納高さが描画と食い違う疑い（読み取り専用の推定）-------------
    // `setProperties()` や `characters` で文言を差し替えたあと、TEXT の高さが
    // 再計測されずに古いまま残ることがある（2026-10-01 に builder-sales が 27 件、
    // builder-site が 2 件を実測）。
    // **色・書体・コピーの検査はすべて通る。** 出るのはレイアウトの高さだけ。
    //
    // **目視・スクリーンショットでは見つからない**（Figma が描画時に再フローするため
    // 画面は正しく見える）。`absoluteRenderBounds.height` との比較でも出ない
    // （builder-site が 1,577 件走査して 0 件）。
    //
    // 確実に判定する唯一の方法は `textAutoResize` を `NONE` → `HEIGHT` に往復させて
    // 高さが変わるかを見ることだが、**それは書き込みなのでこのスクリプトでは行わない。**
    // ここでは行数を見積もって「疑い」として挙げるにとどめる。
    // **和文の約物の詰めや和欧混植で過検出する**ので、違反ではなく確認対象として扱い、
    // 担当者が往復をかけて実際に高さが変わったものだけを「本当に古かった」と数える。
    if (n.textAutoResize === 'HEIGHT' && n.width > 0) {
      const fs = segs[0].fontSize || 16;
      const lh = n.lineHeight && n.lineHeight.unit === 'PERCENT' ? fs * n.lineHeight.value / 100
        : (n.lineHeight && n.lineHeight.unit === 'PIXELS' ? n.lineHeight.value : fs * 1.75);
      // **半角英数字は和文の約半分の幅**。1 文字 = fontSize と数えると
      // 「PostHog, Inc.」のようなラテン文字列を 2 行と見積もって過検出する
      // （2026-10-01 の 16 System で 44 件のうち大半がこれだった）
      // 行数の見積もりは 2 点に気をつける。どちらも 2026-10-01 の 16 System で実測した。
      //  1. **半角英数字は和文の約半分の幅。** 1 文字 = fontSize と数えると
      //     「PostHog, Inc.」を 2 行と見積もる（44 件中 37 件がこれだった）
      //  2. **改行は行ごとに折り返しを数える。** 全体の文字数で割ってから改行数を足すと、
      //     表のセルのような複数行のテキストで二重に数える
      //  3. **字間（letterSpacing）を入れる。** 10 Top の h1 は幅 608 に対し
      //     1 行に必要な幅が 606（36px・字間 −1%）で、字間を無視すると 2 行と誤る
      const ls = n.letterSpacing && n.letterSpacing.unit === 'PERCENT' ? n.letterSpacing.value / 100 : 0;
      const perLine = Math.max(1, n.width / (fs * (1 + ls)));
      const estLines = chars.split('\n').reduce((sum, line) => {
        const eff = [...line].reduce((a, ch) => a + (/[\x20-\x7E]/.test(ch) ? 0.5 : 1), 0);
        return sum + Math.max(1, Math.ceil(eff / perLine));
      }, 0);
      // 1 行ぶん以上足りないものだけを挙げる（丸めの誤差で 1 行未満の差は無視する）
      if (estLines >= 2 && n.height < lh * (estLines - 0.5)) {
        out.格納高さの疑い.push(n.id + ' 高さ' + Math.round(n.height) + ' < 推定' + estLines + '行×'
          + Math.round(lh) + ' 「' + chars.slice(0, 20) + '」 ' + pathOf(n));
      }
    }

    // --- B2 / B5 / S3: 文字色（小さい文字への青 / リンクの下線 / コントラスト）--
    const bg = await backgroundOf(n);
    for (const s of segs) {
      const fp = (s.fills || []).filter(p => p.visible !== false && p.type === 'SOLID').pop();
      if (!fp) continue;
      const fg = await resolvePaint(n, fp);
      if (!fg) continue;
      segTotal++;
      const h = hex(fg.c);
      const size = s.fontSize || 16;
      const bold = BOLDISH.test(s.fontName.style || '');

      // B2: 18px 未満に blue.500 / sky（§5.5-2,3）
      if (size < 18 && h in NO_SMALL_TEXT) {
        out.違反.小文字への青.push(n.id + ' 「' + s.characters.slice(0, 20) + '」 ' + size + 'px に '
          + NO_SMALL_TEXT[h] + '（' + fg.name + '） ' + pathOf(n));
      }

      // B5 / 項目 30: **`role/text-link` にバインドされた TEXT は例外なく下線が必須**。
      // リンク色は「押せる」ことを示す色なので、下線が無いと押せると誤解させる。
      // 判定は**変数名**で行う（色の実効値だけで見ない）。
      //  - `role/text-brand`（brand.blue.700 #045D9D・6.87:1）は**リンクではない**ので対象外。
      //    トップのタグラインがこれ。例外を作らずに済むよう、色の意味を分けてある
      //  - ナビ（ヘッダー・Sheet・パンくず・ページ送り）は下線なしが正（§5.4 の青 10%）
      //  - 逆向き（下線があるのに text-link でない）は検査しない。強調の下線は使っていないため
      if (/^role\/text-link$/.test(fg.name) && !inNav(n)) {
        linkSegTotal++;
        if (s.textDecoration === 'UNDERLINE') linkUnderlined++;
      }
      // `role/text-brand`（#045D9D）は下線なしが正。母数だけ数えて違反にはしない
      if (/^role\/text-brand$/.test(fg.name)) {
        brandSegTotal++;
        if (s.textDecoration === 'UNDERLINE') {
          out.違反.リンク下線なし.push(n.id + ' 【逆】role/text-brand なのに下線あり 「'
            + s.characters.slice(0, 24) + '」 ' + pathOf(n));
        }
      }
      if (/^role\/text-link$/.test(fg.name) && !inNav(n) && s.textDecoration !== 'UNDERLINE') {
        out.違反.リンク下線なし.push(n.id + ' 「' + s.characters.slice(0, 24) + '」 '
          + fg.name + ' / textDecoration=' + s.textDecoration + ' ' + pathOf(n));
      }

      // S3: コントラスト（WCAG AA。24px 以上と 18.66px 以上の Bold は 3:1）
      const large = size >= 24 || (size >= 18.66 && bold);
      const need = large ? 3 : 4.5;
      const r = ratio(fg.c, bg.c);
      if (r >= need) continue;
      out.違反.コントラスト.push(
        n.id + ' 「' + s.characters.slice(0, 16) + '」 ' + fg.name + ' ' + h
        + ' on ' + bg.name + ' ' + hex(bg.c) + ' @' + size + 'px'
        + (bold ? ' Bold' : '') + ' = ' + r + '（必要 ' + need + '）' + ' ' + pathOf(n));
    }
  }
}

// --- 項目 33: 部品の既定値（`componentPropertyDefinitions`）------------------
// **ノードを辿る走査では原理的に到達できない。** instance を 1 つも置かなくても存在するため。
// この穴で `ServiceCard / Note` の既定値に禁止語「弊社」が 1 件生き残っていた（2026-10-01）。
// `03 Components`（`4:4`）を検査するときだけ動く。
// 既定値は仕様書の管理外なので、**コピーの一致は見ない**（`【要記入】…` なら正しい）。
if (page.id === '4:4') {
  const sets = page.children.filter(c => c.type === 'COMPONENT_SET'
    || (c.type === 'COMPONENT' && (!c.parent || c.parent.type !== 'COMPONENT_SET')));
  for (const s of sets) {
    // 変異体から読むと throw するので、必ず SET か非変異体の COMPONENT から読む
    let defs = {};
    try { defs = s.componentPropertyDefinitions || {}; } catch (e) { continue; }
    for (const [key, def] of Object.entries(defs)) {
      defCount++;
      if (def.type !== 'TEXT' || typeof def.defaultValue !== 'string') continue;
      const v = def.defaultValue;
      defTextCount++;
      if (!v.trim()) continue;
      const where = s.name + ' / ' + key.split('#')[0] + ' = 「' + v.slice(0, 60) + '」';
      for (const [w, why] of BANNED) if (v.includes(w)) out.違反.既定値の違反.push('禁止表現「' + w + '」 ' + why + ' ← ' + where);
      if (UNIT_GAP.test(v)) out.違反.既定値の違反.push('単位・助数詞の空き ← ' + where);
      if (KERN_MISS.test(v)) out.違反.既定値の違反.push('和欧間の四分アキ欠落 ← ' + where);
      if (PUNCT_SPACE.test(v)) out.違反.既定値の違反.push('句読点の直後の空白 ← ' + where);
      if (URL_IN_COPY.test(v)) out.違反.既定値の違反.push('URL・パス ← ' + where);
      if (SPEC_REF.test(v)) out.違反.既定値の違反.push('仕様書のセクション番号 ← ' + where);
      for (const w of OLD_PHRASES) if (v.includes(w)) out.違反.既定値の違反.push('旧文言「' + w + '」 ← ' + where);
      if (KIT_PLACEHOLDER_WORDS.has(v.trim().toLowerCase())) out.違反.既定値の違反.push('kit 既定のプレースホルダ ← ' + where);
      out.部品の既定値.push(where);
    }
  }
}

// --- T6: コピー一致 -----------------------------------------------------------
if (EXPECTED.length) out.コピーの欠落 = EXPECTED.filter(e => !seenText.some(g => g === e || g.includes(e)));

// --- S6: 複製と本体の一致（**既にあるノード同士を比べる。**
//          同じ実行の中で `clone()` を作ってから比較しない: 複製直後のノードは
//          `findAllWithCriteria` が 0 件を返す。`03-handoff.md` §10）-----------------------------------------------------
for (const [srcId, cloneId, note] of CLONE_PAIRS) {
  const src = await figma.getNodeByIdAsync(srcId);
  const clone = await figma.getNodeByIdAsync(cloneId);
  if (!src || !clone) { out.複製の照合 = (out.複製の照合 || []).concat([{ note, err: 'ノードが無い' }]); continue; }
  const a = src.findAllWithCriteria({ types: ['TEXT'] }).map(t => txt(t)).filter(s => s.trim());
  const b = clone.findAllWithCriteria({ types: ['TEXT'] }).map(t => txt(t)).filter(s => s.trim());
  out.複製の照合 = (out.複製の照合 || []).concat([{
    note, 本体: a.length, 複製: b.length,
    複製に無い: a.filter(x => !b.includes(x)).slice(0, 10),
    複製にだけある: b.filter(x => !a.includes(x)).slice(0, 10),
  }]);
}

// --- B6: 青の面積（概算）------------------------------------------------------
out.青の面積 = {
  青の合計: Math.round(blueArea),
  フレームの合計: Math.round(frameArea),
  比: frameArea ? Math.round((blueArea / frameArea) * 1000) / 10 + '%' : '—',
  上限: '10%（§5.4）',
  注: '自分の塗りが blue.500 / sky / gradient の可視ノードの面積を足した概算。重なりは補正していない',
};

// --- まとめ -------------------------------------------------------------------
out.cta_id = [...ctaIdSet].sort();
out.cta_type = [...ctaTypeSet].sort();
out.幅の分布 = Object.entries(widthCount).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([w, c]) => w + 'px×' + c);
out.件数 = {
  ノード: nodeTotal,
  TEXT全件: textAll, 中身のあるTEXT: textNonEmpty, 空または空白のみ: textAll - textNonEmpty,
  塗りと線のセグメント: paintTotal, 文字色セグメント: segTotal,
  バインド総数: boundTotal,
  // C3 は色と寸法を分ける。**色は直すべきもの、寸法の kit instance ぶんは許容事項**
  'ライブラリ変数_色（直す）': remoteColor,
  'ライブラリ変数_寸法_自作（直す）': remoteDim - remoteDimKit,
  'ライブラリ変数_寸法_kit内側（許容）': remoteDimKit,
  '8ptグリッド_kit内側（許容）': kitGridCount,
  '格納高さの疑い（要確認・違反ではない）': out.格納高さの疑い.length,
  // 項目 30 の母数。「下線漏れ 0 件」が本当に 0 件か、リンクに届いていないのかを分ける
  'リンク（role/text-link）のセグメント': linkSegTotal,
  'うち下線あり': linkUnderlined,
  'role/text-brand のセグメント（下線なしが正）': brandSegTotal,
  // 項目 33 の母数（`03 Components` のときだけ 0 以外になる）
  部品のプロパティ定義: defCount, 'うち TEXT の既定値': defTextCount,
};
for (const k of Object.keys(out.違反)) out.件数['違反_' + k] = out.違反[k].length;
out.件数.注記 = out.注記.length;
out.件数.ボタン = out.ボタン.length;
out.件数.ダミー = out.ダミー.length;
out.件数.ロゴ = out.ロゴ.length;

// 一覧は上限まで切る（件数は上で全件数えてある）
for (const k of Object.keys(out.違反)) out.違反[k] = out.違反[k].slice(0, CAP);
for (const k of ['注記', 'ボタン', 'ダミー', '閉じたFAQ', 'フォーカス', 'ロゴ', 'ページ直下の非フレーム', '部品の既定値', '格納高さの疑い']) {
  out[k] = out[k].slice(0, CAP);
}

return out;
