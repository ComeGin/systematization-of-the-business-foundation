/* =============================================================================
 * Web サイト Figma の検査スクリプト（qa-audit）
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
 *   3. 戻り値の JSON を読む。違反はすべて件数 0 が正常
 *   ※ 複数ページを見るときは、1 回の `use_figma` につき 1 ページ。
 *      `setCurrentPageAsync` は 1 回だけ呼ぶこと（スキルの Page Rules）。
 *      並行して見たいときは、ページごとに別の `use_figma` 呼び出しを同じメッセージで並べる。
 *
 * ■ 前提
 *   fileKey : JRYPLER6E0liA7cUurIhSo
 *   許可フォント : Noto Sans JP（和文）/ Inter（欧文・数字）。これ以外は違反（特に kit の Geist）
 *   ページ ID :
 *     0:1  00 Cover            4:2  01 Sitemap         4:3  02 Foundations
 *     4:4  03 Components       4:5  10 Top             4:6  11 Services
 *     4:7  12 Pricing          4:8  13 About           4:9  14 Contact
 *     4:10 15 Blog             4:11 16 System
 *
 * ■ 検査する 18 項目
 *    1. フォント          許可フォント以外が使われていないか
 *    2. プレースホルダ    kit 既定の文言（"Title" "Label" "Lorem" など）が残っていないか
 *    3. 変数バインド      instance の外の SOLID の塗り・線が変数にバインドされているか
 *    4. 幅                Desktop 1440 / 1152、Mobile 390 / 358 になっているか
 *    5. CTA 規則          main の中の主 CTA が 1 種類か（ボタンの variant を棚卸し）
 *    6. コントラスト      WCAG AA（本文 4.5:1、24px 以上と 18.66px 以上の Bold は 3:1）
 *    7. ダミー            「準備中」「【要記入】」「【要確認】」の所在
 *    8. コピー一致        EXPECTED に入れた期待値との突き合わせ（欠落を返す）
 *    9. 注記              dev annotation から cta_id を抽出
 *   10. 視覚              このスクリプトの対象外。返ったノード ID を `get_screenshot` で見る
 *   11. 和欧混植          半角英数字に Inter / 和文に Noto Sans JP が当たっているか
 *   12. Device スタイル   Mobile のフレームに `JP/Desktop/*` が混ざっていないか
 *   13. 段組みの字数      1 列あたりの実効字数（03-handoff.md の H-5）
 *   14. 複製と本体の一致  CLONE_PAIRS に入れた組の文言を突き合わせる
 *   15. placeholder      作りかけを示すシマーが残っていないか
 *   16. 壊れた instance   mainComponent が失われていないか
 *   17. 壊れたバインド    削除された変数を参照していないか
 *   18. プロパティの値    componentProperties（非表示レイヤーの値）を読む
 *
 * ■ 件数が 0 にならない項目について
 *   項目 12（Device スタイル）と項目 13（段組みの字数）は、**判断のうえ許容した**
 *   ものが件数に出る。違反として扱う前に `03-handoff.md` §8 の許容事項を確認すること。
 *     - 項目 12: Body・Small・Caption は Desktop と Mobile で値が完全に同じなので、
 *       部品に Device variant が無い箇所では `JP/Desktop/*` が出る（見た目への影響ゼロ）。
 *       値が違う Display・H1〜H4・Body L が出たときだけ本物の違反。
 *     - 項目 13: `IconCard` を 3 列で使う箇所は構造的に約 19.3 字になる（許容済み）。
 *       目安を割っていても、語の途中で改行していなければ問題にしない。
 *   ほかの項目は 0 が正常。0 でなければ直す。
 *
 * ■ 過去に踏んだ落とし穴（このスクリプトで塞いである）
 *   - 非表示レイヤーは instance に展開されない。走査に出ないことを「存在しない」と
 *     判定してはいけない。値は componentProperties に残っている → 項目 18
 *   - 注記は label と labelMarkdown の 2 つがあり、labelMarkdown 側はアンダースコアが
 *     `\_` にエスケープされる。片方だけを見ると cta_id の検索が空振りする → annText()
 *   - kit の Badge の中のテキストも名前が `Label`。FAQ の質問文は Question を経由して
 *     辿らないと、バッジ側を掴む → faqItems()
 *   - 部品を数えるときは種別で絞る。page.children をそのまま数えると、
 *     部品ではない FRAME（`Page header` など）まで部品数に入る → countComponents()
 *   - 報告には必ず走査時刻を添え、指摘を送る直前に測り直す。修正と検査が数分差で
 *     重なると、修正前の状態を見たまま報告してしまう → 戻り値の `走査時刻`
 * ========================================================================== */

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------
const PAGE_ID = '4:5';          // ← 検査するページの ID（上の一覧から選ぶ）
const IS_MOBILE_FRAME = /Mobile|\/ M$|390/;  // Mobile フレームの判定（項目 12 で使う）
const CAP = 40;                 // 一覧に載せる件数の上限（件数自体は全件数える）

const ALLOWED_FONTS = ['Noto Sans JP', 'Inter'];

// 項目 2: kit 既定のプレースホルダ文言（完全一致で判定する。部分一致にすると和文に誤爆する）
const KIT_PLACEHOLDERS = new Set([
  'title', 'heading', 'button', 'label', 'lorem', 'lorem ipsum', 'placeholder',
  'subtitle', 'body', 'text', 'value', 'description', 'nav label', 'tooltip text',
  'select an item', 'card title', 'cn', 'short text', 'question', 'answer',
  'price', 'period', 'product', 'excerpt', 'date', 'caption', 'logo',
  'copyright', 'helper', 'error', 'number', 'name', 'link', 'lead', 'note', 'tab', 'item',
]);

// 項目 8: コピー一致で突き合わせる期待値（01-content-spec.md から写す。空なら検査しない）
const EXPECTED = [
  // 例: '料金：環境構築・受託開発・コンサル・業務提携', '23,000 円', '表示価格はすべて税別です。',
];

// 項目 14: 複製と本体の組（[本体のノード ID, 複製のノード ID, 説明]）。空なら検査しない
const CLONE_PAIRS = [
  // 例: ['42:2', '42:4861', 'Top/Desktop と Cookie バナー表示中の中の表示領域'],
];

// 項目 18: 値を確かめたいノード（カナリア）。生値をそのまま返す
const CANARY_IDS = [
  // 例: '23:455', '45:7951', '42:3873',
];

// ---------------------------------------------------------------------------
// 判定に使う正規表現
// ---------------------------------------------------------------------------
const LATIN = /[0-9A-Za-z]/;                    // 半角英数字（全角カタカナは一致しない）
const JP = /[ぁ-んァ-ヶ一-龥。、]/;              // 和文
const BOLDISH = /bold|black|heavy|extra ?bold|semi ?bold|demi/i;
const DUMMY = /準備中|サンプル|【要記入】|【要確認】/;

// ---------------------------------------------------------------------------
// 判定器の自己テスト（既知の正例・負例で毎回検算する）
// 「ご連絡はこの…」「姓」は半角英数字を含まないので、Inter 漏れとして判定されないのが正しい。
// ここが崩れたら、以降の結果は信用できない。
// ---------------------------------------------------------------------------
const SELF_TEST = [
  ['23,000 円', true, true, '和欧混在 → Inter と Noto Sans JP の両方が要る'],
  ['姓', false, true, '和文のみ → Noto Sans JP 単独が正しい'],
  ['ご連絡はこのメールアドレスにお送りします。', false, true, 'カタカナは半角英数字ではない'],
  ['name@example.com', true, false, '欧文のみ → Inter 単独が正しい'],
  ['© 2026 ComeGin', true, false, '© は和文判定に入れない'],
].map(([s, latin, jp, note]) => ({
  文字列: s, LATIN判定: LATIN.test(s), 期待LATIN: latin,
  JP判定: JP.test(s), 期待JP: jp,
  合格: LATIN.test(s) === latin && JP.test(s) === jp, 意味: note,
}));

// ---------------------------------------------------------------------------
// 補助関数
// ---------------------------------------------------------------------------
const hex = c => '#' + [c.r, c.g, c.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');

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
async function resolvePaint(node, paint) {
  if (!paint || paint.type !== 'SOLID') return null;
  const bv = paint.boundVariables && paint.boundVariables.color;
  if (bv && bv.id) {
    const v = await getVar(bv.id);
    if (v) {
      try {
        const r = v.resolveForConsumer(node);
        if (r && r.resolvedType === 'COLOR') return { c: r.value, name: v.name };
      } catch (e) { /* 解決できないときは生値に落ちる */ }
    }
  }
  return { c: paint.color, name: '(未バインド)' };
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

const pathOf = n => {
  const a = []; let p = n;
  while (p && p.type !== 'PAGE') { a.unshift(p.name); p = p.parent; }
  return a.slice(1, 5).join('/');
};

// TEXT 以外のノードで characters を触ると TypeError になるので、必ずこれを通す
const txt = n => ('characters' in n ? n.characters : '');

// 注記の本文。label と labelMarkdown の両方を見て、labelMarkdown 側のエスケープ（\_）を外す。
// 片方だけを見ると `cta_id` や `dl_top_card` の検索が空振りする。
// 2 つの値が同じ内容のときは重複させない（同じ文が 2 回並ぶと人が読みにくい）。
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
    部品名: comps.map(c => c.name),
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

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------
const 走査時刻 = new Date().toISOString();
const page = await figma.getNodeByIdAsync(PAGE_ID);
if (!page || page.type !== 'PAGE') return { error: 'ページが見つからない', PAGE_ID };
await figma.setCurrentPageAsync(page);

const styleNames = Object.fromEntries((await figma.getLocalTextStylesAsync()).map(s => [s.id, s.name]));

const out = {
  走査時刻,
  ページ: page.name,
  トップレベル合計: page.children.length,
  ...countComponents(page),                                  // 項目 3 の補助・部品数の取り違え防止
  フレーム: [],
  自己テスト: SELF_TEST,
  自己テスト合格: SELF_TEST.every(t => t.合格),
  違反: {
    フォント: [], プレースホルダ: [], 未バインド塗り: [], コントラスト: [],
    Inter漏れ: [], Noto漏れ: [], Deviceスタイル: [], 壊れたinstance: [], 壊れたバインド: [],
    placeholder残り: [], 段組みの字数: [],
  },
  ダミー: [], 注記: [], cta_id: [], ボタン: [], 幅の分布: {}, カナリア: [], コピーの欠落: [],
  件数: {},
};

const seenText = [];            // 項目 8・14 で使う
const ctaIdSet = new Set();
const widthCount = {};
let textAll = 0, textNonEmpty = 0, segTotal = 0, nodeTotal = 0;

for (const root of page.children) {
  if (!('findAll' in root)) continue;
  const isMobile = IS_MOBILE_FRAME.test(root.name);
  out.フレーム.push({
    id: root.id, name: root.name, type: root.type,
    wh: Math.round(root.width) + 'x' + Math.round(root.height),
  });

  for (const n of [root, ...root.findAll(() => true)]) {
    nodeTotal++;

    // --- 項目 15: 作りかけのシマー -------------------------------------------
    if (n.placeholder) out.違反.placeholder残り.push(n.id + ' ' + n.name);

    // --- 項目 4: 幅の分布 ---------------------------------------------------
    if (['FRAME', 'INSTANCE', 'COMPONENT'].includes(n.type)) {
      const w = Math.round(n.width);
      widthCount[w] = (widthCount[w] || 0) + 1;
    }

    // --- 項目 16: 壊れた instance ------------------------------------------
    if (n.type === 'INSTANCE') {
      const mc = await n.getMainComponentAsync();
      if (!mc) out.違反.壊れたinstance.push(n.id + ' ' + n.name);
    }

    // --- 項目 17: 削除された変数への参照 ------------------------------------
    {
      const ids = [];
      const pull = o => {
        if (!o) return;
        for (const v of Object.values(o)) {
          if (Array.isArray(v)) v.forEach(x => x && x.id && ids.push(x.id));
          else if (v && v.id) ids.push(v.id);
        }
      };
      pull(n.boundVariables);
      for (const arr of [n.fills, n.strokes]) {
        if (Array.isArray(arr)) for (const p of arr) pull(p.boundVariables);
      }
      for (const id of ids) {
        if (!(await getVar(id))) out.違反.壊れたバインド.push(n.id + ' ' + pathOf(n) + ' → ' + id);
      }
    }

    // --- 項目 9: 注記と cta_id ----------------------------------------------
    if (n.annotations && n.annotations.length) {
      const t = annText(n);
      out.注記.push({ id: n.id, name: n.name, 本文: t.slice(0, 260) });
      for (const m of t.matchAll(/cta_id:\s*([a-z_]+)/g)) ctaIdSet.add(m[1]);
    }

    // --- 項目 5: ボタンの棚卸し（Badge を除くため部品名で絞る）----------------
    if (n.type === 'INSTANCE') {
      const mc = await n.getMainComponentAsync();
      if (mc) {
        const set = mc.parent && mc.parent.type === 'COMPONENT_SET' ? mc.parent.name : mc.name;
        if (/^Button - Nova|^CTAButton/.test(set)) {
          const l = n.findOne(c => c.type === 'TEXT');
          out.ボタン.push({
            id: n.id, 部品: set.replace(' - Nova', ''),
            variant: Object.entries(n.componentProperties || {})
              .filter(([k]) => /^Variant|^Size|^Width/.test(k)).map(([, v]) => v.value).join('/'),
            label: l ? txt(l).slice(0, 20) : '', 場所: pathOf(n),
          });
        }
      }
    }

    // --- 項目 18: カナリアの生値 --------------------------------------------
    if (CANARY_IDS.includes(n.id)) {
      out.カナリア.push({
        id: n.id, name: n.name, type: n.type,
        componentProperties: Object.entries(n.componentProperties || {})
          .map(([k, v]) => k.split('#')[0] + '=' + String(v.value).slice(0, 50)).join(' | '),
        文字: txt(n).slice(0, 60),
        セグメント: n.type === 'TEXT'
          ? n.getStyledTextSegments(['fontName']).map(s => '「' + s.characters + '」=' + s.fontName.family).join(' | ')
          : '',
      });
    }

    // --- 項目 3: instance の外の未バインドの塗り・線 --------------------------
    // 画像枠は hex のハードコードを許す例外（00-brief の不変条件 4）
    if (!inInstance(n) && !/ImagePlaceholder|画像（準備中）/.test(n.name)) {
      for (const [prop, arr] of [['fill', n.fills], ['stroke', n.strokes]]) {
        if (!Array.isArray(arr)) continue;
        for (const p of arr) {
          if (p.visible === false || p.type !== 'SOLID') continue;
          if (!(p.boundVariables && p.boundVariables.color)) {
            out.違反.未バインド塗り.push(n.id + ' ' + n.type + ' ' + prop + '=' + hex(p.color) + ' 「' + n.name + '」');
          }
        }
      }
    }

    if (n.type !== 'TEXT') continue;
    textAll++;
    const chars = n.characters;
    if (!chars.trim()) continue;      // 空・空白のみは中身のある TEXT に数えない（kit Input の当て木）
    textNonEmpty++;
    seenText.push(chars);

    // --- 項目 2: kit 既定のプレースホルダ文言 --------------------------------
    if (KIT_PLACEHOLDERS.has(chars.trim().toLowerCase()) || /lorem ipsum/i.test(chars)) {
      out.違反.プレースホルダ.push(n.id + ' 「' + chars.trim() + '」 ' + pathOf(n));
    }

    // --- 項目 7: ダミーと未決の印 --------------------------------------------
    if (DUMMY.test(chars)) out.ダミー.push(n.id + ' 「' + chars.slice(0, 50) + '」');

    // --- 項目 12: Mobile への Desktop 用スタイルの混入 -----------------------
    const sName = typeof n.textStyleId === 'string' ? (styleNames[n.textStyleId] || '') : '(mixed)';
    if (isMobile && /\/Desktop\//.test(sName)) {
      out.違反.Deviceスタイル.push(n.id + ' ' + sName + ' 「' + chars.slice(0, 18) + '」');
    }

    const segs = n.getStyledTextSegments(['fontName', 'fontSize', 'fills']);
    const families = new Set(segs.map(s => s.fontName.family));

    // --- 項目 1: フォント ----------------------------------------------------
    for (const f of families) {
      if (!ALLOWED_FONTS.includes(f)) out.違反.フォント.push(f + ' @' + n.id + ' ' + pathOf(n));
    }

    // --- 項目 11: 和欧混植 ---------------------------------------------------
    // 半角英数字を含むのに Inter が無い／和文を含むのに Noto Sans JP が無い
    if (LATIN.test(chars) && !families.has('Inter')) {
      out.違反.Inter漏れ.push(n.id + ' 「' + chars.slice(0, 22) + '」');
    }
    if (JP.test(chars) && !families.has('Noto Sans JP')) {
      out.違反.Noto漏れ.push(n.id + ' 「' + chars.slice(0, 22) + '」');
    }

    // --- 項目 13: 段組みの字数（H-5。字間を含めた実効値で出す）----------------
    {
      const fs = segs[0].fontSize || 16;
      const ls = n.letterSpacing && n.letterSpacing.unit === 'PERCENT' ? n.letterSpacing.value / 100 : 0;
      const perLine = n.width / (fs * (1 + ls));
      // 折り返している本文サイズの TEXT だけを見る（見出しや 1 行の短文は対象外）
      if (fs <= 18 && n.height > fs * 1.8 && perLine < 20) {
        out.違反.段組みの字数.push(
          n.id + ' 幅' + Math.round(n.width) + ' ' + fs + 'px 字間' + Math.round(ls * 100) + '% = 約'
          + (Math.round(perLine * 10) / 10) + '字/行 「' + chars.slice(0, 16) + '」');
      }
    }

    // --- 項目 6: コントラスト ------------------------------------------------
    const bg = await backgroundOf(n);
    for (const s of segs) {
      const fp = (s.fills || []).filter(p => p.visible !== false && p.type === 'SOLID').pop();
      if (!fp) continue;
      const fg = await resolvePaint(n, fp);
      if (!fg) continue;
      segTotal++;
      const size = s.fontSize || 16;
      const large = size >= 24 || (size >= 18.66 && BOLDISH.test(s.fontName.style || ''));
      const need = large ? 3 : 4.5;
      const r = ratio(fg.c, bg.c);
      if (r >= need) continue;
      out.違反.コントラスト.push(
        n.id + ' 「' + s.characters.slice(0, 16) + '」 '
        + fg.name + ' ' + hex(fg.c) + ' on ' + bg.name + ' ' + hex(bg.c)
        + ' @' + size + 'px = ' + r + '（必要 ' + need + '）');
    }
  }
}

// --- 項目 8: コピー一致 -------------------------------------------------------
if (EXPECTED.length) {
  out.コピーの欠落 = EXPECTED.filter(e => !seenText.some(g => g === e || g.includes(e)));
}

// --- 項目 14: 複製と本体の一致 -------------------------------------------------
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

// --- まとめ -------------------------------------------------------------------
out.cta_id = [...ctaIdSet].sort();
out.幅の分布 = Object.entries(widthCount).sort((a, b) => b[1] - a[1]).slice(0, 14)
  .map(([w, c]) => w + 'px×' + c);
out.件数 = {
  ノード: nodeTotal,
  TEXT全件: textAll, 中身のあるTEXT: textNonEmpty, 空または空白のみ: textAll - textNonEmpty,
  塗りセグメント: segTotal,
  フォント違反: out.違反.フォント.length,
  プレースホルダ: out.違反.プレースホルダ.length,
  未バインド塗り: out.違反.未バインド塗り.length,
  コントラスト違反: out.違反.コントラスト.length,
  Inter漏れ: out.違反.Inter漏れ.length,
  Noto漏れ: out.違反.Noto漏れ.length,
  Deviceスタイル混入: out.違反.Deviceスタイル.length,
  壊れたinstance: out.違反.壊れたinstance.length,
  壊れたバインド: out.違反.壊れたバインド.length,
  placeholder残り: out.違反.placeholder残り.length,
  段組みの字数: out.違反.段組みの字数.length,
  注記: out.注記.length, ボタン: out.ボタン.length, ダミー: out.ダミー.length,
};

// 一覧は上限まで切る（件数は上で全件数えてある）
for (const k of Object.keys(out.違反)) out.違反[k] = out.違反[k].slice(0, CAP);
out.注記 = out.注記.slice(0, CAP);
out.ボタン = out.ボタン.slice(0, CAP);
out.ダミー = out.ダミー.slice(0, CAP);

return out;
