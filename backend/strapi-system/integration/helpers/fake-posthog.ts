// PostHog の偽物（node:http）。POSTHOG_HOST をここに向けると、posthog-node が送るバッチ（POST /batch/）を受けて記録する。
// Strapi は dist の CommonJS を Node の require で読むため vi.mock は効かない。送り先の HTTP をテストの中で差し替える。
//
// mode で応答を変え、サーバ側の障害を起こす:
//   ok      200 を返す
//   error   500 を返す（PostHog の障害）
//   slow    delayMs だけ待ってから 200（posthog-node の requestTimeout と src/posthog.ts の 5 秒の見切りを通す）
//   down    応答せずに接続を切る（通信失敗）
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';

export interface CapturedEvent {
  event: string;
  distinct_id?: string;
  properties: Record<string, unknown>;
}

export type FakeMode = 'ok' | 'error' | 'slow' | 'down';

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

/** posthog-node は本文を gzip で送ることがある（Content-Encoding か先頭の 2 バイトで見分ける） */
const decode = (req: IncomingMessage, body: Buffer): string => {
  const gzipped = req.headers['content-encoding'] === 'gzip' || (body[0] === 0x1f && body[1] === 0x8b);
  return (gzipped ? gunzipSync(body) : body).toString('utf8');
};

export class FakePostHog {
  readonly events: CapturedEvent[] = [];
  /** 受けたリクエストの数（mode に関わらず数える。down・slow でも「送ろうとした」ことは分かる） */
  requests = 0;
  mode: FakeMode = 'ok';
  delayMs = 8_000;
  #server: Server | undefined;

  async start(): Promise<string> {
    this.#server = createServer(async (req, res) => {
      this.requests += 1;
      if (this.mode === 'down') {
        req.socket.destroy();
        return;
      }
      const body = await readBody(req);
      // 記録するのは ok で受けたものだけ（500・遅延で失敗させたバッチは「届かなかった」扱い）
      if (req.method === 'POST' && this.mode === 'ok') {
        try {
          const parsed = JSON.parse(decode(req, body)) as { batch?: CapturedEvent[] };
          this.events.push(...(parsed.batch ?? []));
        } catch {
          // バッチでない送信（無い想定）は数えるだけ
        }
      }
      if (this.mode === 'error') {
        res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"it-fake-500"}');
        return;
      }
      if (this.mode === 'slow') {
        const timer = setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":1}'), this.delayMs);
        res.on('close', () => clearTimeout(timer));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":1}');
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  /** document_id ごとのイベント名（届いた順） */
  eventsFor(documentId: string): string[] {
    return this.events.filter((e) => e.properties.document_id === documentId).map((e) => e.event);
  }

  /** $exception のうち、例外のメッセージに marker を含むもの */
  exceptionsWith(marker: string): CapturedEvent[] {
    return this.events.filter((e) => e.event === '$exception' && JSON.stringify(e.properties.$exception_list ?? '').includes(marker));
  }

  async stop(): Promise<void> {
    if (!this.#server) return;
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server!.close(() => resolve()));
  }
}
