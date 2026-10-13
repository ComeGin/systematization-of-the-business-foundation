import { STATUS_CODES } from "node:http";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { Redis } from "ioredis";
import { parseConfig } from "./config.js";
import { VALKEY_COMMAND_TIMEOUT_MS, VALKEY_READY_TIMEOUT_MS } from "./constants.js";
import { createHandler, type Handle, type HttpRequest, type HttpResponse } from "./handler.js";
import { ConsentStore } from "./store.js";
import { createValkey, waitReady } from "./valkey.js";

// 本番の入口（ALB のターゲット。マルチバリューヘッダーは無効。仕様 2.1・3.2）。
// SAM の Handler は index.handler（bundle が dist-lambda/index.mjs を作る）
export interface AlbEvent {
  readonly httpMethod?: string;
  readonly path?: string;
  readonly headers?: Readonly<Record<string, string | undefined>> | null;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
}

export interface AlbResult {
  statusCode: number;
  statusDescription: string;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: false;
}

export interface Runtime {
  readonly handle: Handle;
  readonly valkey: Redis;
}

export function toRequest(event: AlbEvent): HttpRequest {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(event.headers ?? {})) headers[name.toLowerCase()] = value;
  const body = event.body ? Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8") : Buffer.alloc(0);
  return { method: event.httpMethod ?? "GET", path: event.path ?? "/", headers, body };
}

export function toResult(res: HttpResponse): AlbResult {
  const reason = STATUS_CODES[res.status];
  return {
    statusCode: res.status,
    statusDescription: reason ? `${res.status} ${reason}` : String(res.status),
    headers: { ...res.headers },
    body: res.body,
    isBase64Encoded: false,
  };
}

/** Valkey の AUTH トークンを Secrets Manager から読む（コールドスタートで 1 回だけ）。値はログに出さない（ID だけ） */
export async function loadValkeyPassword(client: Pick<SecretsManagerClient, "send">, secretId: string): Promise<string> {
  if (!secretId) throw new Error("VALKEY_PASSWORD_SECRET_ID が未設定");
  const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!out.SecretString) throw new Error(`${secretId} に値が無い`);
  return out.SecretString;
}

/**
 * 部品を組み立てる（仕様 3.3）。Valkey の接続はモジュールのスコープに 1 本持ち、呼び出しをまたいで使い回す。
 * ready の前に送ったコマンドはすぐ失敗する（enableOfflineQueue: false）ため、ここで ready を待つ。
 * 3 秒以内に来なければ、再接続を続ける接続を残さないよう閉じてから失敗にする
 */
export async function initRuntime(
  deps: { env?: NodeJS.ProcessEnv; loadPassword?: () => Promise<string> } = {},
): Promise<Runtime> {
  const env = deps.env ?? process.env;
  const loadPassword =
    deps.loadPassword ?? (() => loadValkeyPassword(new SecretsManagerClient({}), env.VALKEY_PASSWORD_SECRET_ID ?? ""));
  const password = await loadPassword();
  // 不正な設定は例外にする（loadConfig の process.exit だと、呼び出しの途中でプロセスが終わる）
  const config = parseConfig({ ...env, VALKEY_PASSWORD: password });
  // 凍結のあいだに通り道が接続を黙って捨てると、status は ready のままソケットだけが死ぬ。ioredis はコマンドの
  // タイムアウトでは再接続しないため、応答が来なければソケットを壊して再接続させる（次の呼び出しで回復する）
  const valkey = createValkey(config, { socketTimeout: VALKEY_COMMAND_TIMEOUT_MS });
  if (!(await waitReady(valkey, VALKEY_READY_TIMEOUT_MS))) {
    valkey.disconnect();
    throw new Error(`Valkey に ${VALKEY_READY_TIMEOUT_MS / 1000} 秒以内に接続できない`);
  }
  return { valkey, handle: createHandler({ config, store: new ConsentStore(valkey, config.VALKEY_KEY_PREFIX) }) };
}

/**
 * 初期化は最初の呼び出しで 1 回だけ（失敗したら次の呼び出しでやり直す。例外は Errors に数え、ALB は 502）。
 * 各呼び出しの前に、接続が ready でなければ最大 readyTimeoutMs 待つ。来なければそのまま処理する（handle が 503 を返す）
 */
export function createLambdaHandler(
  init: () => Promise<Runtime>,
  readyTimeoutMs: number = VALKEY_READY_TIMEOUT_MS,
): (event: AlbEvent) => Promise<AlbResult> {
  let ready: Promise<Runtime> | null = null;
  return async (event) => {
    ready ??= init().catch((error: unknown) => {
      ready = null;
      throw error;
    });
    const runtime = await ready;
    await waitReady(runtime.valkey, readyTimeoutMs);
    return toResult(await runtime.handle(toRequest(event)));
  };
}

export const handler = createLambdaHandler(() => initRuntime());
