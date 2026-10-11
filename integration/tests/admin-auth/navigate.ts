// ブラウザの画面遷移（ALB が認可エンドポイントへ送るリダイレクト）として GET する。
// Node の fetch（undici）は Sec-Fetch-Mode: cors を必ず付け、Better Auth はそれを「fetch からの呼び出し」とみなして
// 302 ではなく JSON（{ redirect: true, url }）を返す。画面遷移の 302 を確かめるため、node:http で送る。
import { request } from "node:http";

export interface NavigateResult {
  status: number;
  location: string | undefined;
  text: string;
}

export function navigate(url: string, timeoutMs = 20_000): Promise<NavigateResult> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", headers: { accept: "text/html", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }, timeout: timeoutMs }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, text }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`${url} が ${timeoutMs}ms で応答しない`)));
    req.on("error", reject);
    req.end();
  });
}
