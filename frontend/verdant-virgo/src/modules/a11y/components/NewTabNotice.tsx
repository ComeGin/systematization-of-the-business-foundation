import type { NewTabNoticeProps } from "../lib/types";

/**
 * 新しいタブで開くリンク（target="_blank"）の中に置く告知（WCAG 3.2.5 の配慮。計画書 P-4）。
 * 画面には出さず、リンクの名前の末尾として読ませる。文言は site-content から渡す（既定値を持たない。H-16）。
 * .astro から使うときは client:* を付けない（JS を出さずに静的な HTML になる）。
 */
export default function NewTabNotice({ text }: NewTabNoticeProps) {
  return <span className="sr-only">{text}</span>;
}
