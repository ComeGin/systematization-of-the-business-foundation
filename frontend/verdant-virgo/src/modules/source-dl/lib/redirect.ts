// 「ソースコードを無料 DL」の CTA（cta_type が source_dl の <a>）を押したときの動き。2026-10-14 にユーザーが決めた。
// 1. 別のタブで zip（SOURCE_ZIP_URL）を開く。GitHub が添付ファイルとして返すので、ダウンロードが始まりタブは閉じる
// 2. 元のタブは無料相談（/contact）へ移る。?cta= に押した CTA の cta_id、?from= にいまのパスを付ける（フォームの hidden に渡る）
//
// - 別のタブにするのは、同じタブでダウンロードを始めてすぐ /contact へ移ると、ダウンロードが取り消されることがあるため
// - /contact と /contact/thanks では 2 をしない（すでに無料相談の画面にいる）
// - 押した印（cta_clicked）は analytics が capture の段階で sendBeacon で送るので、ここで遷移しても途切れない
// - JS が動かない環境では <a> の href のまま（同じページか、トップの #source-dl〈手順書を受け取るフォーム〉）へ移る
// - 修飾キー付き・中ボタンのクリックはブラウザに任せる（新しいタブで #source-dl を開くなど）
import { contactHref, isCtaId } from "@/modules/site-content/cta";

const SELECTOR = 'a[data-cta-type="source_dl"]';

/**
 * cta_type は source_dl でも、ラベルが「手順書を受け取る」もの（メール登録のフォーム #source-dl へ移るのが正しい）。
 * 1-1 告知バナーの「受け取る」と、8-6 記事中 CTA の「構築の手順書を受け取る」
 */
const MANUAL_CTA_IDS: ReadonlySet<string> = new Set([
  "dl_top_banner",
  "dl_article_inline",
]);

export function installSourceDlRedirect(zipUrl: string): void {
  document.addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const link = (event.target as Element | null)?.closest<HTMLAnchorElement>(
      SELECTOR,
    );
    if (!link || MANUAL_CTA_IDS.has(link.dataset.ctaId ?? "")) return;
    event.preventDefault();
    window.open(zipUrl, "_blank", "noopener");

    if (location.pathname.startsWith("/contact")) return;
    const ctaId = link.dataset.ctaId;
    if (!ctaId || !isCtaId(ctaId)) {
      console.error(
        "[source-dl] data-cta-id が CTA の一覧にありません:",
        ctaId,
      );
      return;
    }
    location.assign(contactHref({ cta: ctaId, from: location.pathname }));
  });
}
