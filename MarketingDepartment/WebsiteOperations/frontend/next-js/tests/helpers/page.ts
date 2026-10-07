// Server Component（ページ・レイアウト）のテストで使う道具。ページは描かずに、返した要素の型と props だけを見る
// （子の画面の部品は各テストで vi.mock した関数に差し替える。Cloudscape と control-plane の実体は読み込まない）
export type PageElement<P = Record<string, unknown>> = { type: unknown; props: P };

export function asElement<P = Record<string, unknown>>(node: unknown): PageElement<P> {
  if (typeof node !== "object" || node === null || !("type" in node) || !("props" in node)) {
    throw new Error("React の要素ではない");
  }
  return node as PageElement<P>;
}

/** テストで notFound() の代わりに投げる例外のメッセージ（本物も例外で処理を止める） */
export const NEXT_NOT_FOUND = "NEXT_NOT_FOUND";
