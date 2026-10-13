import { STATUS_CODES } from "node:http";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createAuth } from "./auth.js";
import { type Config, parseConfig } from "./config.js";
import { DB_QUERY_TIMEOUT_MS, LAMBDA_DB_POOL_MAX, LAMBDA_IDLE_RECYCLE_MS } from "./constants.js";
import { createPool } from "./db.js";
import { createHandler, type Handle } from "./handler.js";
import { secretReader } from "./secrets.js";

// 本番の入口（ALB のターゲット。マルチバリューヘッダーは有効。仕様 2.1・3.2）。
// SAM の Handler は index.handler（bundle が dist-lambda/index.mjs を作る）
export interface AlbEvent {
  readonly httpMethod?: string;
  readonly path?: string;
  readonly multiValueHeaders?: Readonly<Record<string, readonly string[] | undefined>> | null;
  readonly multiValueQueryStringParameters?: Readonly<Record<string, readonly string[] | undefined>> | null;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
}

export interface AlbResult {
  statusCode: number;
  statusDescription: string;
  multiValueHeaders: Record<string, string[]>;
  body: string;
  isBase64Encoded: boolean;
}

export interface Runtime {
  /** host ヘッダーが無いときに使う（BETTER_AUTH_URL） */
  readonly origin: string;
  readonly handle: Handle;
  close(): Promise<void>;
}

/** ALB のイベント → Request。クエリは ALB がデコードしていないので、そのまま戻す。GET・HEAD には本文を付けない */
export function toRequest(event: AlbEvent, fallbackOrigin: string): Request {
  const headers = new Headers();
  for (const [name, values] of Object.entries(event.multiValueHeaders ?? {})) {
    for (const value of values ?? []) headers.append(name, value);
  }
  const host = headers.get("host") ?? new URL(fallbackOrigin).host;
  const query = Object.entries(event.multiValueQueryStringParameters ?? {})
    .flatMap(([key, values]) => (values ?? []).map((value) => `${key}=${value}`))
    .join("&");
  const method = event.httpMethod ?? "GET";
  const withBody = method !== "GET" && method !== "HEAD" && !!event.body;
  return new Request(`https://${host}${event.path ?? "/"}${query ? `?${query}` : ""}`, {
    method,
    headers,
    body: withBody ? Buffer.from(event.body!, event.isBase64Encoded ? "base64" : "utf8") : undefined,
  });
}

const TEXT_TYPE = /^(text\/|application\/(json|javascript|xml)\b|application\/[\w.+-]+\+(json|xml)\b)/i;

/** Response → ALB の応答。Set-Cookie は 1 つずつ配列にする（Headers の反復はつなげてしまう） */
export async function toResult(res: Response): Promise<AlbResult> {
  const multiValueHeaders: Record<string, string[]> = {};
  res.headers.forEach((value, name) => {
    if (name !== "set-cookie") multiValueHeaders[name] = [value];
  });
  const cookies = res.headers.getSetCookie();
  if (cookies.length > 0) multiValueHeaders["set-cookie"] = cookies;
  const bytes = Buffer.from(await res.arrayBuffer());
  const isText = bytes.length === 0 || TEXT_TYPE.test(res.headers.get("content-type") ?? "");
  const reason = STATUS_CODES[res.status];
  return {
    statusCode: res.status,
    statusDescription: reason ? `${res.status} ${reason}` : String(res.status),
    multiValueHeaders,
    body: isText ? bytes.toString("utf8") : bytes.toString("base64"),
    isBase64Encoded: !isText,
  };
}

/** 秘密値を 3 つ読み、設定を検証する（不正なら例外。process.exit は使わない）。ALB_CLIENT_SECRET は読まない（仕様 3.6） */
export async function loadBaseConfig(env: NodeJS.ProcessEnv, readSecret: (name: string) => Promise<string>): Promise<Config> {
  const [betterAuthSecret, dbPassword, googleSecret] = await Promise.all([
    readSecret("BETTER_AUTH_SECRET"),
    readSecret("DB_PASSWORD"),
    readSecret("GOOGLE_CLIENT_SECRET"),
  ]);
  return parseConfig({ ...env, BETTER_AUTH_SECRET: betterAuthSecret, DATABASE_PASSWORD: dbPassword, GOOGLE_CLIENT_SECRET: googleSecret });
}

/** プール（Lambda 用の大きさと問い合わせのタイムアウト）・auth・handler を組み立てる（仕様 3.4） */
export function buildRuntime(config: Config, makePool: typeof createPool = createPool): Runtime {
  const pool = makePool(config, { max: LAMBDA_DB_POOL_MAX, queryTimeoutMs: DB_QUERY_TIMEOUT_MS });
  return { origin: config.BETTER_AUTH_URL, handle: createHandler({ auth: createAuth(config, pool) }), close: () => pool.end() };
}

const badRequest = (): Response =>
  new Response("bad request", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

/**
 * 秘密値と設定の読み込み（load）は最初の呼び出しで 1 回だけ（失敗したら次でやり直す。例外は Errors に数え、ALB は 502）。
 * 前の呼び出しの終わりから idleMs 以上空いたら、処理の前に Runtime（プール・auth）を作り直す。凍結のあいだに
 * 通り道が接続を黙って捨てても、古い接続で問い合わせが固まらないようにするため（仕様 3.4）
 */
export function createLambdaHandler<B>(deps: {
  load: () => Promise<B>;
  build: (base: B) => Runtime;
  now?: () => number;
  idleMs?: number;
}): (event: AlbEvent) => Promise<AlbResult> {
  const now = deps.now ?? (() => Date.now());
  const idleMs = deps.idleMs ?? LAMBDA_IDLE_RECYCLE_MS;
  let base: Promise<B> | null = null;
  let runtime: Runtime | null = null;
  let lastDoneAt = 0;
  return async (event) => {
    base ??= deps.load().catch((error: unknown) => {
      base = null;
      throw error;
    });
    const loaded = await base;
    if (runtime && now() - lastDoneAt >= idleMs) {
      const old = runtime;
      runtime = null;
      void old.close().catch(() => {});
    }
    runtime ??= deps.build(loaded);
    try {
      let request: Request;
      try {
        request = toRequest(event, runtime.origin);
      } catch {
        // URL を組み立てられないイベント（不正な host など）は、利用者の誤りとして 400 にする（Errors にしない）
        return await toResult(badRequest());
      }
      return await toResult(await runtime.handle(request));
    } finally {
      lastDoneAt = now();
    }
  };
}

export const handler = createLambdaHandler({
  load: () => loadBaseConfig(process.env, secretReader(new SecretsManagerClient({}), process.env.SECRETS_PREFIX ?? "")),
  build: (config: Config) => buildRuntime(config),
});
