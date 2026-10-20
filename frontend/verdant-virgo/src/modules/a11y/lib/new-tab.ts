/**
 * 新しいタブで開くことの告知（sr-only の文）を HTML の文字列で作る。
 * 記事本文（blog/lib/body.ts）のように、部品ではなく HTML の文字列でリンクを組む箇所で使う。
 * 部品で組むときは NewTabNotice を使う。文言は site-content から渡す（既定値を持たない。H-16）。
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function newTabNoticeHtml(text: string): string {
  const escaped = text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
  return `<span class="sr-only">${escaped}</span>`;
}
