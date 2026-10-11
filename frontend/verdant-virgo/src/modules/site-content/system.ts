// 画面 9 404 の文言。正本は 01-content-spec.md §4.9。
// noindex。パンくずは置かない。CTA（無料相談・無料 DL）は本文に置かない。

export const notFound = {
  // 9-2 本文（FOUND）
  // 大きい数字。仕様書は Inter だが、書体は Poppins にする（計画 P-5 で Inter を外すため。2026-10-09 にリードが判断）
  display: '404',
  h1: 'ページが見つかりません',
  body: 'お探しのページは、移動または削除された可能性があります。URL に誤りがないかをご確認ください。',
  // Mobile は全幅で縦積み
  buttons: [
    { label: 'トップページへ戻る', href: '/', variant: 'primary' },
    { label: 'ブログを見る', href: '/blog', variant: 'outline' },
  ],
} as const;
