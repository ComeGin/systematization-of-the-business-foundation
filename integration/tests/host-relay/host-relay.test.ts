// host-relay（開発環境だけの中継）を、呼ぶ側のコンテナ（n8n）の中から確かめる結合テスト。
// 設計は middleware/host-relay/README.md。コンテナから host.docker.internal（docker0 のアドレス）の
// 8000（Mautic）・1025（MailHog の SMTP）・5678（n8n）・3100（Chatwoot）・3001（OpenSEO の GET /api/health だけ）に届き、
// それ以外のポートとパスには届かないこと（費用の出る無認証の OpenSEO の /mcp を守る不変条件）を見る。
//
// n8n のコンテナには node（fetch）と nc がある。fetch は URL の ../ を送る前に正規化するので、生のパスは nc で送る。
import { describe, expect, it } from "vitest";

import { execIn, withPaused } from "../helpers/docker.ts";
import { CONTAINERS } from "../helpers/services.ts";
import { waitFor } from "../helpers/wait.ts";

const RELAY_HOST = "host.docker.internal";
const OPENSEO_CONTAINER = "open-seo-main-open-seo-1";

// コンテナの中で 1 回だけ fetch し、状態と本文の先頭を JSON の 1 行で出す（失敗しても終了コード 0 で、理由を返す）
const FETCH_SCRIPT = `
const [url, method, timeout] = process.argv.slice(1);
fetch(url, { method: method || "GET", redirect: "manual", signal: AbortSignal.timeout(Number(timeout) || 8000) })
  .then(async (r) => console.log(JSON.stringify({ status: r.status, body: (await r.text()).slice(0, 4000) })))
  .catch((e) => console.log(JSON.stringify({ error: String(e.cause?.code ?? e.name) })));
`;

interface FetchResult {
  status?: number;
  body?: string;
  error?: string;
}

async function fetchFromContainer(port: number, path: string, method = "GET", timeoutMs = 8_000): Promise<FetchResult> {
  const out = await execIn(CONTAINERS.n8n, ["node", "-e", FETCH_SCRIPT, `http://${RELAY_HOST}:${port}${path}`, method, String(timeoutMs)]);
  return JSON.parse(out) as FetchResult;
}

/** 生の HTTP リクエストを nc で送り、ステータス行だけを返す */
async function rawRequestLine(port: number, requestTarget: string): Promise<string> {
  const out = await execIn(CONTAINERS.n8n, [
    "sh",
    "-c",
    'printf "GET %s HTTP/1.1\\r\\nHost: %s\\r\\nConnection: close\\r\\n\\r\\n" "$1" "$2" | nc -w 5 "$2" "$3" | head -1',
    "sh",
    requestTarget,
    RELAY_HOST,
    String(port),
  ]);
  return out.trim();
}

/** TCP で接続できるか（nc -z） */
async function tcpOpen(port: number): Promise<boolean> {
  try {
    await execIn(CONTAINERS.n8n, ["nc", "-z", "-w", "3", RELAY_HOST, String(port)]);
    return true;
  } catch {
    return false;
  }
}

describe("host-relay（n8n のコンテナ → host.docker.internal）", () => {
  describe("正常系", () => {
    it("8000 の Mautic のログイン画面に届く", async () => {
      const res = await fetchFromContainer(8000, "/s/login");

      expect(res.status).toBe(200);
      expect(res.body).toContain("Mautic");
    });

    it("5678 の n8n の healthz に届く（Chatwoot の Webhook の経路）", async () => {
      const res = await fetchFromContainer(5678, "/healthz");

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({ status: "ok" });
    });

    it("3100 の Chatwoot の API に届く（週次の問い合わせの棚卸しの経路）", async () => {
      const res = await fetchFromContainer(3100, "/api");

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body!)).toHaveProperty("version");
    });

    it("1025 の MailHog の SMTP に TCP で届く（I-21 の開発の配信）", async () => {
      expect(await tcpOpen(1025)).toBe(true);
    });

    it("3001 の OpenSEO は GET /api/health だけが届き、上流の応答をそのまま返す", async () => {
      const res = await fetchFromContainer(3001, "/api/health");

      expect(res.status).toBe(200);
      expect(res.body).toContain(`"status":"ok"`);
    });

    it("空入力: /api/health に空のクエリが付いても同じ場所として届く", async () => {
      const res = await fetchFromContainer(3001, "/api/health?");

      expect(res.status).toBe(200);
    });
  });

  describe("異常系", () => {
    it.each(["/mcp", "/", "/api/projects", "/API/health", "/api/health/"])("入力: OpenSEO の %s には届かず、固定の 404 not found", async (path) => {
      const res = await fetchFromContainer(3001, path);

      expect(res.status).toBe(404);
      expect(res.body).toBe("not found");
    });

    it.each(["POST", "PUT", "DELETE"])("入力: OpenSEO の /api/health でも %s は 404", async (method) => {
      const res = await fetchFromContainer(3001, "/api/health", method);

      expect(res.status).toBe(404);
    });

    it("入力: OpenSEO の /mcp への POST（MCP の呼び出しの形）も 404", async () => {
      const res = await fetchFromContainer(3001, "/mcp", "POST");

      expect(res.status).toBe(404);
      expect(res.body).toBe("not found");
    });

    it.each(["/api/health/../mcp", "/api/health/%2e%2e/mcp", "/api/health%2F..%2Fmcp"])("入力: パスをたどる生のリクエスト %s も /mcp に届かず 404", async (target) => {
      expect(await rawRequestLine(3001, target)).toBe("HTTP/1.1 404 Not Found");
    });

    it.each([
      [3103, "admin-auth"],
      [3104, "consent-api"],
      [3200, "監視アプリ"],
      [8025, "MailHog の画面"],
    ])("入力: 中継に無いポート %i（%s）には届かない", async (port) => {
      expect(await tcpOpen(port)).toBe(false);
    });

    it("サーバ: 上流の OpenSEO が応答しない間は、中継が 504 を返して待ち続けない。再開後は 200 に戻る", async () => {
      const res = await withPaused(OPENSEO_CONTAINER, () => fetchFromContainer(3001, "/api/health", "GET", 20_000));

      // proxy_read_timeout（10 秒）で打ち切る。本文は nginx の既定のエラーページで、上流の情報を含まない
      expect(res.status).toBe(504);
      expect(res.body).not.toContain("authMode");
      await waitFor(async () => (await fetchFromContainer(3001, "/api/health")).status === 200, { timeoutMs: 30_000, what: "再開後に OpenSEO の health が 200 になる" });
    });
  });
});
