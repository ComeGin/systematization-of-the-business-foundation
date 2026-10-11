import http from "node:http";
import * as z from "zod/v4";
import type { Config } from "./config.js";
import {
  CONSENT_PATH,
  HEADERS_TIMEOUT_MS,
  HEALTH_PATH,
  KEEP_ALIVE_TIMEOUT_MS,
  MAX_BODY_BYTES,
  MAX_RECORDS_PER_ID,
  REQUEST_TIMEOUT_MS,
} from "./constants.js";
import { buildSetCookie, issueId, readCookieId } from "./cookie.js";
import { type ConsentStore, StoreUnavailableError } from "./store.js";

// 受け取る本文は state だけ。ポリシーの版・識別子・時刻は受け取らない（サーバーが決める）
const BodySchema = z.strictObject({ state: z.enum(["granted", "denied"]) });

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly headers: http.OutgoingHttpHeaders = {},
  ) {
    super(code);
  }
}

export function createServer(config: Config, store: ConsentStore): http.Server {
  const send = (
    res: http.ServerResponse,
    status: number,
    body: unknown,
    headers: http.OutgoingHttpHeaders = {},
  ): void => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    });
    res.end(JSON.stringify(body));
  };

  // 公開サイトのオリジンと一致したときだけ CORS を許す（資格情報つき。* は使わない）
  const corsHeaders = (origin: string | undefined): http.OutgoingHttpHeaders => {
    const headers: http.OutgoingHttpHeaders = { Vary: "Origin" };
    if (origin === config.SITE_URL) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Credentials"] = "true";
    }
    return headers;
  };

  const readBody = async (req: http.IncomingMessage): Promise<Buffer> => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      throw new HttpError(413, "payload_too_large", { Connection: "close" });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", { Connection: "close" });
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  };

  const handleGet = async (req: http.IncomingMessage, res: http.ServerResponse, cors: http.OutgoingHttpHeaders) => {
    const id = readCookieId(req.headers.cookie);
    const record = id ? await store.latest(id) : null;
    if (!record) return send(res, 200, { state: "unset" }, cors);
    send(res, 200, { state: record.state, policy_version: record.policy, recorded_at: record.at }, cors);
  };

  const handlePost = async (req: http.IncomingMessage, res: http.ServerResponse, cors: http.OutgoingHttpHeaders) => {
    const mediaType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") throw new HttpError(415, "unsupported_media_type");

    let json: unknown;
    try {
      json = JSON.parse((await readBody(req)).toString("utf8"));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "invalid_json");
    }
    const parsed = BodySchema.safeParse(json);
    if (!parsed.success) throw new HttpError(400, "invalid_body");
    const { state } = parsed.data;

    // Cookie の識別子は、形式が正しく、かつサーバーが発行済み（Stream がある）ときだけ引き継ぐ。
    // それ以外は新しく発行する。訪問者が好きな識別子で記録を作れないようにするため
    let id: string | null = null;
    const cookieId = readCookieId(req.headers.cookie);
    if (cookieId) {
      const { exists, count } = await store.inspect(cookieId);
      if (exists) {
        if (count >= MAX_RECORDS_PER_ID) throw new HttpError(429, "too_many_records");
        id = cookieId;
      }
    }
    id ??= issueId();

    const at = new Date().toISOString();
    await store.append(id, { state, at, policy: config.CONSENT_POLICY_VERSION });

    // Cookie は記録に成功したときだけ書く
    send(
      res,
      201,
      { state, policy_version: config.CONSENT_POLICY_VERSION, recorded_at: at },
      { ...cors, "Set-Cookie": buildSetCookie(config, state, id) },
    );
  };

  const route = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    if (pathname === HEALTH_PATH) {
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method_not_allowed", { Allow: "GET, HEAD" });
      // プロセスが生きているかだけを見る。Valkey の瞬断でタスクが外れ、ALB が 503 を返すのを避けるため
      return send(res, 200, { ok: true });
    }

    if (pathname !== CONSENT_PATH) throw new HttpError(404, "not_found");

    const origin = req.headers.origin;
    const cors = corsHeaders(origin);

    if (method === "OPTIONS") {
      if (origin !== config.SITE_URL) throw new HttpError(403, "origin_not_allowed", cors);
      res.writeHead(204, {
        ...cors,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return;
    }

    if (method !== "GET" && method !== "POST") {
      throw new HttpError(405, "method_not_allowed", { ...cors, Allow: "GET, POST, OPTIONS" });
    }
    // 書き込みは必ず公開サイトのオリジンから。GET は Origin が付いたときだけ照合する
    if (method === "POST" ? origin !== config.SITE_URL : origin !== undefined && origin !== config.SITE_URL) {
      throw new HttpError(403, "origin_not_allowed", cors);
    }

    try {
      if (method === "GET") await handleGet(req, res, cors);
      else await handlePost(req, res, cors);
    } catch (error) {
      if (error instanceof HttpError) throw new HttpError(error.status, error.code, { ...cors, ...error.headers });
      throw error;
    }
  };

  const server = http.createServer((req, res) => {
    const startedAt = Date.now();
    res.on("finish", () => {
      // 識別子と IP は記録しない
      console.error(
        JSON.stringify({
          t: new Date().toISOString(),
          method: req.method,
          path: (req.url ?? "").split("?")[0],
          status: res.statusCode,
          ms: Date.now() - startedAt,
        }),
      );
    });

    route(req, res).catch((error: unknown) => {
      if (res.headersSent) return void res.end();
      if (error instanceof HttpError) return send(res, error.status, { error: error.code }, error.headers);
      if (error instanceof StoreUnavailableError) {
        console.error(`[store] ${error.message}: ${(error.cause as Error | undefined)?.message ?? "unknown"}`);
        return send(res, 503, { error: "unavailable" }, corsHeaders(req.headers.origin));
      }
      console.error("[server] unexpected error", error);
      send(res, 500, { error: "internal" }, corsHeaders(req.headers.origin));
    });
  });

  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}
