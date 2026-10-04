// 要約の PII 検査（TA-07 の 3.6）。メールアドレスと電話番号の形だけ検出して伏せ字にする。
// 氏名は形で検出できない。エージェント定義の「人は ID で指す」規則に頼る。
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

// 日付・ID・ULID の数字列を巻き込まないよう、先頭が 0 または + の形に絞る
const PHONE_PATTERNS: readonly RegExp[] = [
  /(?<![A-Za-z0-9])\+\d{1,3}[-\s.]?\(?\d{1,4}\)?[-\s.]?\d{2,4}[-\s.]?\d{3,4}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])\(0\d{1,4}\)\s?\d{1,4}-\d{3,4}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])0\d{1,4}[-\s.]\d{1,4}[-\s.]\d{3,4}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])0\d{9,10}(?![A-Za-z0-9])/g,
];

export const SUMMARY_MAX_LENGTH = 500;

export interface RedactedSummary {
  text: string;
  redacted: boolean;
}

export function redactSummary(summary: string): RedactedSummary {
  let text = summary.trim().replace(/\s+/g, " ");
  let redacted = false;
  const replace = (pattern: RegExp, label: string) => {
    text = text.replace(pattern, () => {
      redacted = true;
      return label;
    });
  };
  replace(EMAIL, "[redacted:email]");
  for (const pattern of PHONE_PATTERNS) replace(pattern, "[redacted:phone]");
  if (text.length > SUMMARY_MAX_LENGTH) text = `${text.slice(0, SUMMARY_MAX_LENGTH - 1)}…`;
  return { text, redacted };
}
