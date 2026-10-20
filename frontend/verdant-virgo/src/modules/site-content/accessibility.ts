// 画面 11 ウェブアクセシビリティ方針（/accessibility）の文言と、試験の結果のデータ。
// 文言の正本は 01-content-spec.md §4.11（2026-10-18 に G-1 で承認）、表の様式は 04-accessibility-spec.md §5。
// 試験の結果は 2026-10-19 の試験（自動の試験・手動の試験。L4-1）で確定させた。下書きは verifier の Q2。
// 「SR」の印の基準（1.1.1・1.3.1・1.3.2・2.1.1・2.4.3・2.4.4・2.4.6・3.3.1・4.1.2・4.1.3）は、
// 2026-10-19 の G-2（ユーザーによるスクリーンリーダーの確認。NVDA＋Chrome）で確定した。
// データの正本はこの 1 か所。表 1 の行の数は 38 で固定し、テストで数える（04-accessibility-spec.md §5）。

export type CriterionLevel = "A" | "AA";
export type CriterionResult = "pass" | "fail";

export interface Criterion {
  /** 番号（「1.1.1」） */
  id: string;
  /** 達成基準の名称（JIS の訳語。読点は全角のカンマ「，」） */
  name: string;
  level: CriterionLevel;
  /** 適用／適用なし */
  applicable: boolean;
  /** 適合／不適合。適用なしの行は null（画面では空欄）。確定していない行も null（画面では PENDING の印） */
  result: CriterionResult | null;
  /** 部分適合の記述、該当なしの理由など */
  note?: string;
}

/** 確定していない値の印（§0.1。確定するまでページを公開しないので、画面に出るのは確認のときだけ） */
export const PENDING = "【要記入】";

/** 表の値の語（§4.11 の 11-4） */
export const CRITERION_VALUE_LABELS = {
  applicable: "適用",
  notApplicable: "適用なし",
  pass: "適合",
  fail: "不適合",
} as const;

/** 試験の日付（11-2。§0.2 の日付の例外で、和文と数字の間を空けない） */
const TEST_DATE = "2026年10月19日";

/**
 * 行の判定。適用の行は結果（pass／fail）を、適用なしの行は理由（注記）を必ず書く。
 * 結果を既定値にしない（行を足したときに、試験をしないまま「適合」と出さないため）。
 */
type Outcome = CriterionResult | { notApplicable: string };

const criterion = (
  id: string,
  name: string,
  level: CriterionLevel,
  outcome: Outcome,
): Criterion =>
  typeof outcome === "string"
    ? { id, name, level, applicable: true, result: outcome }
    : {
        id,
        name,
        level,
        applicable: false,
        result: null,
        note: outcome.notApplicable,
      };

// 適用なしの行の注記（§4.11 の 11-4。2026-10-19 の試験で、04-accessibility-spec.md §2.3 の判定どおりと確かめた）
const NO_MEDIA = { notApplicable: "このサイトには音声と映像がありません。" };

/**
 * 部分適合で除いた部分がある行の注記（§4.11 の 11-4。2026-10-18 の G-2）。
 * 試験で第三者の部分（Chatwoot・Cal.com）だけが満たさなかった基準の行に付ける。適用は「適用」のまま。
 * 2026-10-19 の試験では、表 1 の 4.1.2（Chatwoot のウィジェットの中の閉じるボタンに名前が無い）と、
 * 表 2 の 2.5.3（Cal.com の時間枠のボタン 2 つ）だけだった。
 */
const THIRD_PARTY_NOTE =
  "外部のサービス（チャット・予約の時間枠）を除く。上の「外部のサービスについて」をご覧ください。";
const excludingThirdParty = (row: Criterion): Criterion => ({
  ...row,
  note: THIRD_PARTY_NOTE,
});

/** 表 1: JIS X 8341-3:2016 のレベル A と AA の 38 基準（§4.11 の一覧の順）。適合 30・適用なし 8 */
export const JIS_CRITERIA: readonly Criterion[] = [
  criterion("1.1.1", "非テキストコンテンツ", "A", "pass"),
  criterion("1.2.1", "音声だけ及び映像だけ（収録済み）", "A", NO_MEDIA),
  criterion("1.2.2", "キャプション（収録済み）", "A", NO_MEDIA),
  criterion(
    "1.2.3",
    "音声解説又はメディアに対する代替コンテンツ（収録済み）",
    "A",
    NO_MEDIA,
  ),
  criterion("1.2.4", "キャプション（ライブ）", "AA", NO_MEDIA),
  criterion("1.2.5", "音声解説（収録済み）", "AA", NO_MEDIA),
  criterion("1.3.1", "情報及び関係性", "A", "pass"),
  criterion("1.3.2", "意味のある順序", "A", "pass"),
  criterion("1.3.3", "感覚的な特徴", "A", "pass"),
  criterion("1.4.1", "色の使用", "A", "pass"),
  criterion("1.4.2", "音声の制御", "A", {
    notApplicable: "自動で再生する音声がありません。",
  }),
  criterion("1.4.3", "コントラスト（最低限レベル）", "AA", "pass"),
  criterion("1.4.4", "テキストのサイズ変更", "AA", "pass"),
  criterion("1.4.5", "文字画像", "AA", "pass"),
  criterion("2.1.1", "キーボード", "A", "pass"),
  criterion("2.1.2", "キーボードトラップなし", "A", "pass"),
  criterion("2.2.1", "タイミング調整可能", "A", {
    notApplicable: "操作に時間の制限を設けていません。",
  }),
  criterion("2.2.2", "一時停止，停止及び非表示", "A", "pass"),
  criterion("2.3.1", "3回のせん（閃）光，又はしきい（閾）値以下", "A", "pass"),
  criterion("2.4.1", "ブロックスキップ", "A", "pass"),
  criterion("2.4.2", "ページタイトル", "A", "pass"),
  criterion("2.4.3", "フォーカス順序", "A", "pass"),
  criterion("2.4.4", "リンクの目的（コンテキスト内）", "A", "pass"),
  criterion("2.4.5", "複数の手段", "AA", "pass"),
  criterion("2.4.6", "見出し及びラベル", "AA", "pass"),
  criterion("2.4.7", "フォーカスの可視化", "AA", "pass"),
  criterion("3.1.1", "ページの言語", "A", "pass"),
  criterion("3.1.2", "一部分の言語", "AA", "pass"),
  criterion("3.2.1", "フォーカス時", "A", "pass"),
  criterion("3.2.2", "入力時", "A", "pass"),
  criterion("3.2.3", "一貫したナビゲーション", "AA", "pass"),
  criterion("3.2.4", "一貫した識別性", "AA", "pass"),
  criterion("3.3.1", "エラーの特定", "A", "pass"),
  criterion("3.3.2", "ラベル又は説明", "A", "pass"),
  criterion("3.3.3", "エラー修正の提案", "AA", "pass"),
  criterion("3.3.4", "エラー回避（法的，金融及びデータ）", "AA", {
    notApplicable: "このサイトでは契約や支払いを行いません。",
  }),
  criterion("4.1.1", "構文解析", "A", "pass"),
  excludingThirdParty(
    criterion(
      "4.1.2",
      "名前（name），役割（role）及び値（value）",
      "A",
      "pass",
    ),
  ),
];

/**
 * 表 2（参考）: WCAG 2.1・2.2 で加わった 18 基準（G-1 の A-4 で「載せる」と決定）。表明（一部準拠）の対象ではない。適合 15・適用なし 3。
 * 訳語は、公開の前に WAIC の WCAG 2.2 の日本語訳と突き合わせる（§4.11）。
 * 2.1.4・2.5.4・3.3.8 は「適用なし」。理由の注記は §4.11 の 11-4（2026-10-19 に追加）。
 */

export const WCAG_ADDED_CRITERIA: readonly Criterion[] = [
  criterion("1.3.4", "表示の向き", "AA", "pass"),
  criterion("1.3.5", "入力目的の特定", "AA", "pass"),
  criterion("1.4.10", "リフロー", "AA", "pass"),
  criterion("1.4.11", "非テキストのコントラスト", "AA", "pass"),
  criterion("1.4.12", "テキストの間隔", "AA", "pass"),
  criterion(
    "1.4.13",
    "ホバー又はフォーカスで表示されるコンテンツ",
    "AA",
    "pass",
  ),
  criterion("2.1.4", "文字キーのショートカット", "A", {
    notApplicable: "1 文字のキーで動くショートカットがありません。",
  }),
  criterion("2.4.11", "フォーカスの非隠蔽（最低限）", "AA", "pass"),
  criterion("2.5.1", "ポインタのジェスチャ", "A", "pass"),
  criterion("2.5.2", "ポインタのキャンセル", "A", "pass"),
  excludingThirdParty(
    criterion("2.5.3", "ラベルを含む名前（name）", "A", "pass"),
  ),
  criterion("2.5.4", "動きによる起動", "A", {
    notApplicable: "端末を傾けたり振ったりして動く機能がありません。",
  }),
  criterion("2.5.7", "ドラッグ動作", "AA", "pass"),
  criterion("2.5.8", "ターゲットのサイズ（最低限）", "AA", "pass"),
  criterion("3.2.6", "一貫したヘルプ", "A", "pass"),
  criterion("3.3.7", "冗長な入力", "A", "pass"),
  criterion("3.3.8", "アクセシブルな認証（最低限）", "AA", {
    notApplicable: "このサイトにはログインや認証がありません。",
  }),
  criterion("4.1.3", "ステータスメッセージ", "AA", "pass"),
];

/** 問い合わせの先（11-3・11-5。mailto のリンク） */
const CONTACT_EMAIL = "kamegin4@comegin.com";

/**
 * 11-2 の対応度。G-2 で第三者の部分適合の記述を付けたため、WAIC の対応度表記ガイドライン（2021年4月版）の 3.2 では
 * 「一部準拠」になる。2026-10-18 にユーザーが「一部準拠」で確定した（04-accessibility-spec.md §7 の A-6）。
 * 変えるときは、seo.ts の description（「一部準拠しています」）と 11-3 の段落 4（今後の対応方針）も合わせる。
 */
const CONFORMANCE = "一部準拠";

export const accessibilityPage = {
  breadcrumb: [
    { label: "ホーム", href: "/" },
    { label: "ウェブアクセシビリティ方針" },
  ],
  h1: "ウェブアクセシビリティ方針",

  // 11-1 方針
  policy: {
    id: "accessibility-policy",
    heading: "方針",
    paragraphs: [
      "ComeGin は、障がいの有無や年齢、使っている機器にかかわらず、どなたでもこのサイトの情報を得て、ご相談の申し込みまで進めるように取り組んでいます。",
      "受託開発の要件定義〜運用保守のプランで納品する画面は、JIS X 8341-3:2016 の適合レベル AA を標準の仕様にしています。このサイトも同じ水準で作り、試験の結果を公開します。",
      "動きのある表現は、止められるように作っています。端末で「視差効果を減らす」などの設定をしている場合は、動かさずに表示します。",
    ],
  },

  // 11-2 対応の状況（dl）
  status: {
    id: "accessibility-status",
    heading: "対応の状況",
    items: [
      { term: "規格", value: "JIS X 8341-3:2016" },
      { term: "目標とする適合レベル", value: "AA" },
      { term: "対応度", value: CONFORMANCE },
      { term: "対象のページ", value: "このサイトのすべてのページ" },
      // 試験を終えた日（L4-1）
      { term: "試験の日付", value: TEST_DATE },
      { term: "依存した技術", value: "HTML、CSS、JavaScript、WAI-ARIA、SVG" },
      {
        term: "段階的な強化として使う技術",
        value:
          "WebGL（動きの表現だけに使っています。使えない環境でも、内容は欠けません）",
      },
      // VoiceOver は 2026-10-19 の G-2 で確かめていないので書かない。次の再試験で確かめたら足す（03-handoff §12.1）
      {
        term: "試験の方法",
        value:
          "自動の検査（axe）、キーボードと画面の拡大による確認、スクリーンリーダー（NVDA と Chrome）による確認",
      },
    ],
  },

  // 11-3 外部のサービスについて（部分適合に関する記述。2026-10-18 の G-2 で決定。計画の P-7 の (a)）。
  // Chatwoot の満たさない基準は、2026-10-19 の試験で 4.1.2 だけと確定したので「など」を外した（§4.11 の注。WCAG の 5.4）
  external: {
    id: "accessibility-external",
    heading: "外部のサービスについて",
    intro:
      "このサイトでは、次の 2 つの部分に、外部の事業者が提供するサービスを使っています。これらは ComeGin が直すことのできない部分です。",
    services: [
      "チャット（Chatwoot）：画面の右下に表示するチャットのウィジェットです。Cookie の利用に同意した場合だけ表示します。達成基準 4.1.2 を満たしていません。スマートフォンでは、チャットの画面の中に名前の無いボタンが 1 つあります。開くとチャットの画面の中にフォーカスが移り、その間は Esc キーで閉じられません。閉じるときは、Shift キーを押しながら Tab キーを押して、チャットの画面の外に出てください。そのあと「チャットを閉じる」のボタンを押してください。",
      "オンライン面談の予約（Cal.com）：無料相談の受付の後の画面で、面談の日時の枠を選ぶ部分です。達成基準 2.5.3 を満たしていません。",
    ],
    // 段落 2（部分適合に関する記述）
    statement:
      "このため、このサイトのページは JIS X 8341-3:2016 に適合していません。ただし、上の 2 つの部分を除けば、適合レベル AA に適合しています。",
    // 段落 3（代わりの手段）。メールアドレスは mailto のリンク
    alternatives: {
      before: "チャットが使いにくい場合は、無料相談のフォームか、",
      email: CONTACT_EMAIL,
      after:
        " へのメールでご質問ください。面談の日時の枠が選びにくい場合は、無料相談のフォームを送っていただければ、担当者からのメールで日程を調整します。通常 3営業日以内にご連絡します。",
    },
    // 段落 4（今後の対応方針）。対応度が「一部準拠」なので必ず置く（A-6）
    followUp:
      "外部のサービスの改善の状況を確かめ、基準を満たせる方法が見つかった時点で、試験をやり直してこのページを更新します。",
  },

  // 11-4 達成基準ごとの試験の結果
  results: {
    id: "accessibility-results",
    heading: "達成基準ごとの試験の結果",
    columns: ["番号", "達成基準", "適合レベル", "適用", "結果", "注記"],
    tables: [
      {
        id: "accessibility-results-jis",
        lead: "JIS X 8341-3:2016 のレベル A と AA の 38 の達成基準について、試験の結果を示します。",
        caption: "JIS X 8341-3:2016 の達成基準と試験の結果",
        rows: JIS_CRITERIA,
      },
      {
        id: "accessibility-results-wcag",
        lead: "レベル AA の対象ではありませんが、WCAG 2.1・2.2 で加わった達成基準についても、試験の結果を示します。",
        caption: "WCAG 2.1・2.2 で加わった達成基準と試験の結果（参考）",
        rows: WCAG_ADDED_CRITERIA,
      },
    ],
  },

  // 11-5 お気づきの点のご連絡。メールアドレスは mailto のリンク
  contact: {
    id: "accessibility-contact",
    heading: "お気づきの点のご連絡",
    before: "このサイトで使いにくいところや、読み取れない内容がありましたら、",
    email: CONTACT_EMAIL,
    after: " までお知らせください。通常 3営業日以内にお返事します。",
  },
} as const;
