import * as z from "zod/v4";
import type { Config } from "./config.js";
import { CONSENT_PATH, HEALTH_PATH, MAX_BODY_BYTES, MAX_RECORDS_PER_ID } from "./constants.js";
import { buildSetCookie, issueId, readCookieId } from "./cookie.js";
import { type ConsentStore, StoreUnavailableError } from "./store.js";

/** 入口に依存しない要求（ヘッダー名は小文字）。開発は server.ts、本番は lambda.ts が作る */
export interface HttpRequest {
  readonly method: string;
  /** 要求ターゲット。クエリを含んでよい（ここで URL として解釈してパスだけを使う） */
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Buffer;
}

export interface HttpResponse {
  readonly status: number;
  /** Set-Cookie は 1 つだけ（ALB のマルチバリューヘッダーは無効。仕様 2.1） */
  readonly headers: Readonly<Record<string, string>>;
  /** 204 は空文字 */
  readonly body: string;
}

export type Handle = (req: HttpRequest) => Promise<HttpResponse>;

export interface HandlerDeps {
  config: Config;
  store: ConsentStore;
}

// 受け取る本文は state だけ。ポリシーの版・識別子・時刻は受け取らない（サーバーが決める）
const BodySchema = z.strictObject({ state: z.enum(["granted", "denied"]) });

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(code);
  }
}

const respond = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  },
  body: JSON.stringify(body),
});

/**
 * 同意の API の本体（仕様 3.1）。例外を投げない（Valkey の障害は 503、想定外の失敗は 500 を返す）。
 * ログは 1 件 1 行（時刻・メソッド・パス・ステータス・所要時間）。識別子と IP は出さない
 */
export function createHandler({ config, store }: HandlerDeps): Handle {
  // 公開サイトのオリジンと一致したときだけ CORS を許す（資格情報つき。* は使わない）
  const corsHeaders = (origin: string | undefined): Record<string, string> => {
    const headers: Record<string, string> = { Vary: "Origin" };
    if (origin === config.SITE_URL) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Credentials"] = "true";
    }
    return headers;
  };

  const handleGet = async (req: HttpRequest, cors: Record<string, string>): Promise<HttpResponse> => {
    const id = readCookieId(req.headers.cookie);
    const record = id ? await store.latest(id) : null;
    if (!record) return respond(200, { state: "unset" }, cors);
    return respond(200, { state: record.state, policy_version: record.policy, recorded_at: record.at }, cors);
  };

  const handlePost = async (req: HttpRequest, cors: Record<string, string>): Promise<HttpResponse> => {
    const mediaType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") throw new HttpError(415, "unsupported_media_type");

    // 開発の入口は上限を超えた本文を途中で打ち切って渡す。ALB からは本文が全部届く。どちらもここで判定する
    const declared = Number(req.headers["content-length"]);
    if ((Number.isFinite(declared) && declared > MAX_BODY_BYTES) || req.body.length > MAX_BODY_BYTES) {
      throw new HttpError(413, "payload_too_large");
    }

    let json: unknown;
    try {
      json = JSON.parse(req.body.toString("utf8"));
    } catch {
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
    return respond(
      201,
      { state, policy_version: config.CONSENT_POLICY_VERSION, recorded_at: at },
      { ...cors, "Set-Cookie": buildSetCookie(config, state, id) },
    );
  };

  const route = async (req: HttpRequest): Promise<HttpResponse> => {
    const { pathname } = new URL(req.path, "http://localhost");
    const method = req.method;

    if (pathname === HEALTH_PATH) {
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method_not_allowed", { Allow: "GET, HEAD" });
      // プロセスが生きているかだけを見る（開発用。本番の ALB には出さない）
      return respond(200, { ok: true });
    }

    if (pathname !== CONSENT_PATH) throw new HttpError(404, "not_found");

    const origin = req.headers.origin;
    const cors = corsHeaders(origin);

    if (method === "OPTIONS") {
      if (origin !== config.SITE_URL) throw new HttpError(403, "origin_not_allowed", cors);
      return {
        status: 204,
        headers: {
          ...cors,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
        },
        body: "",
      };
    }

    if (method !== "GET" && method !== "POST") {
      throw new HttpError(405, "method_not_allowed", { ...cors, Allow: "GET, POST, OPTIONS" });
    }
    // 書き込みは必ず公開サイトのオリジンから。GET は Origin が付いたときだけ照合する
    if (method === "POST" ? origin !== config.SITE_URL : origin !== undefined && origin !== config.SITE_URL) {
      throw new HttpError(403, "origin_not_allowed", cors);
    }

    try {
      return method === "GET" ? await handleGet(req, cors) : await handlePost(req, cors);
    } catch (error) {
      if (error instanceof HttpError) throw new HttpError(error.status, error.code, { ...cors, ...error.headers });
      throw error;
    }
  };

  return async (req) => {
    const startedAt = Date.now();
    let res: HttpResponse;
    try {
      res = await route(req);
    } catch (error) {
      if (error instanceof HttpError) {
        res = respond(error.status, { error: error.code }, error.headers);
      } else if (error instanceof StoreUnavailableError) {
        console.error(`[store] ${error.message}: ${(error.cause as Error | undefined)?.message ?? "unknown"}`);
        res = respond(503, { error: "unavailable" }, corsHeaders(req.headers.origin));
      } else {
        console.error("[server] unexpected error", error);
        res = respond(500, { error: "internal" }, corsHeaders(req.headers.origin));
      }
    }
    // 識別子と IP は記録しない
    console.error(
      JSON.stringify({
        t: new Date().toISOString(),
        method: req.method,
        path: req.path.split("?")[0],
        status: res.status,
        ms: Date.now() - startedAt,
      }),
    );
    return res;
  };
}
