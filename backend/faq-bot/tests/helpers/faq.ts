import type { FaqItem } from "../../src/faq/schema.js";

export function makeFaqItem(overrides: Partial<FaqItem> = {}): FaqItem {
  return {
    id: "top-3",
    question: "料金は税込ですか？",
    answer: "表示価格はすべて税別です。",
    url: "https://comegin.com/#top-faq",
    context: null,
    ...overrides,
  };
}

export function makeFaqDocument(items: FaqItem[]): unknown {
  return { version: 1, generated_at: "2026-10-11T00:00:00.000Z", items };
}

/** fetch の差し替え。応答を順に返す（Response か Error） */
export function sequenceFetch(...responses: (Response | Error)[]): typeof fetch & { calls: number } {
  const fn = (async () => {
    fn.calls++;
    const next = responses.shift();
    if (!next) throw new Error("想定外の呼び出し");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch & { calls: number };
  fn.calls = 0;
  return fn;
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
