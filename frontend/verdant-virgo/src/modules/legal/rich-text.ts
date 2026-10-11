// 文中の太字とリンクを表す最小の形。法務 2 ページのほか、会社概要の表・完了画面の注記でも使う。
// 強調は太字だけ（01-content-spec §0.2「強調」）。色文字・下線の強調は表せないようにしてある。

/** 太字の区間 */
export interface StrongInline {
  readonly strong: string;
}

/** リンクの区間。外部（http/https）は常に新しいタブ。内部でも newTab を立てれば新しいタブ */
export interface LinkInline {
  readonly text: string;
  readonly href: string;
  readonly newTab?: boolean;
}

/** 等幅の区間（Cookie の名前など。仕様書のコードスパン） */
export interface CodeInline {
  readonly code: string;
}

export type Inline = string | StrongInline | LinkInline | CodeInline;

/** 地の文だけなら string、太字・リンクを含むなら区間の配列 */
export type RichText = string | readonly Inline[];

export const strong = (text: string): StrongInline => ({ strong: text });

export const code = (text: string): CodeInline => ({ code: text });

export const link = (text: string, href: string, options: { newTab?: boolean } = {}): LinkInline => ({
  text,
  href,
  ...options,
});

export const isStrong = (node: Inline): node is StrongInline => typeof node === 'object' && 'strong' in node;

export const isLink = (node: Inline): node is LinkInline => typeof node === 'object' && 'href' in node;

export const isCode = (node: Inline): node is CodeInline => typeof node === 'object' && 'code' in node;

export const isExternalHref = (href: string): boolean => /^https?:\/\//.test(href);

/** 新しいタブで開くか。外部リンクは指定がなくても開く（03-handoff §0.3 の 6 節のリンク） */
export const opensInNewTab = (node: LinkInline): boolean => node.newTab === true || isExternalHref(node.href);

export const toInlines = (text: RichText): readonly Inline[] => (typeof text === 'string' ? [text] : text);

/** 画面に出る文字だけを連結する（目次・aria・検査用） */
export const plainText = (text: RichText): string =>
  toInlines(text)
    .map((node) => {
      if (typeof node === 'string') return node;
      if (isStrong(node)) return node.strong;
      if (isCode(node)) return node.code;
      return node.text;
    })
    .join('');

/**
 * 法務の表・箇条書き・目次で、文節の折り返し（phrase）でも語の途中で切れた語（2026-10-09 の qa-reviewer の検査で見つかったもの）。
 * whitespace-nowrap で包む。データの文字列は変えない。Mobile の項目列（112px）に収まらない長い語は入れない
 */
export const LEGAL_KEEP_TOGETHER = [
  'メールアドレス',
  'アナリティクス',
  'ウェブサイト',
  'オンライン面談',
  'お問い合わせ',
  '適格請求書',
  '発行事業者',
  '所在する国',
] as const;
