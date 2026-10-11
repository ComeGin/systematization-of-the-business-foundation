import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { loadConfig } from "./config.js";
import type { Handle, HttpRequest } from "./handler.js";
import { createRuntime } from "./runtime.js";

// 本番の入口（Lambda の関数 URL。payload format 2.0）。SAM の Handler は index.handler（bundle が dist-lambda/index.mjs を作る）
export interface FunctionUrlEvent {
  readonly rawPath?: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly requestContext?: { readonly http?: { readonly method?: string } };
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export function toRequest(event: FunctionUrlEvent): HttpRequest {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(event.headers ?? {})) headers[name.toLowerCase()] = value;
  const body = event.body === undefined ? Buffer.alloc(0) : Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8");
  return { method: event.requestContext?.http?.method ?? "GET", path: event.rawPath ?? "/", headers, body };
}

/** コールドスタートで 1 回だけ読む。値はログに出さない（名前だけ） */
export async function loadSecrets(client: SecretsManagerClient, prefix: string): Promise<{ token: string; secret: string }> {
  if (!prefix) throw new Error("SECRETS_PREFIX が未設定");
  const read = async (name: string) => {
    const out = await client.send(new GetSecretValueCommand({ SecretId: `${prefix}/${name}` }));
    if (!out.SecretString) throw new Error(`${prefix}/${name} に値が無い`);
    return out.SecretString;
  };
  const [token, secret] = await Promise.all([read("CHATWOOT_BOT_TOKEN"), read("CHATWOOT_BOT_SECRET")]);
  return { token, secret };
}

/** 初期化は最初の呼び出しで 1 回だけ（失敗したら次の呼び出しでやり直す）。handle の例外はそのまま投げる（Errors に数え、関数 URL は 502） */
export function createLambdaHandler(init: () => Promise<Handle>): (event: FunctionUrlEvent) => Promise<FunctionUrlResult> {
  let ready: Promise<Handle> | null = null;
  return async (event) => {
    ready ??= init().catch((error: unknown) => {
      ready = null;
      throw error;
    });
    const handle = await ready;
    const res = await handle(toRequest(event));
    return { statusCode: res.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: res.body };
  };
}

async function defaultInit(): Promise<Handle> {
  const { token, secret } = await loadSecrets(new SecretsManagerClient({}), process.env.SECRETS_PREFIX ?? "");
  return createRuntime(loadConfig({ ...process.env, CHATWOOT_BOT_TOKEN: token, CHATWOOT_BOT_SECRET: secret })).handle;
}

export const handler = createLambdaHandler(defaultInit);
