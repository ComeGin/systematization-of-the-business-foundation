import http from "node:http";
import type { AddressInfo } from "node:net";

export const FIXTURE_FAQ = {
  version: 1,
  generated_at: "2026-10-11T00:00:00.000Z",
  items: [
    { id: "top-1", question: "ソースコードは本当に無料ですか？", answer: "はい。ソースコードを無料で公開しています。", url: "http://localhost:4321/#top-faq", context: null },
    { id: "top-3", question: "料金は税込ですか？", answer: "表示価格はすべて税別です。", url: "http://localhost:4321/#top-faq", context: null },
    {
      id: "it-contract-consulting",
      question: "契約の期間と解約を教えてください",
      answer: "コンサルの契約期間は 1か月です。",
      url: "http://localhost:4321/services/consulting#detail-faq",
      context: "コンサル",
    },
    {
      id: "it-contract-partnership",
      question: "契約の期間と解約を教えてください",
      answer: "業務提携の契約期間は 1年です。",
      url: "http://localhost:4321/services/partnership#detail-faq",
      context: "業務提携",
    },
  ],
};

/** faq.json を返す偽の HTTP サーバー（127.0.0.1 のあいているポート） */
export async function startFaqServer(body: unknown = FIXTURE_FAQ): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/faq.json`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
