import type { Handle } from "../../src/handler.js";

export interface InvokeOptions {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

export interface InvokeResult {
  status: number;
  /** ヘッダー名は小文字 */
  headers: Record<string, string>;
  text: string;
  json: unknown;
}

/** 入口（server.ts・lambda.ts）を通さずに handle を呼ぶ。ヘッダー名は入口と同じく小文字にそろえる */
export async function invoke(handle: Handle, options: InvokeOptions = {}): Promise<InvokeResult> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) headers[name.toLowerCase()] = value;
  const body = options.body === undefined ? Buffer.alloc(0) : Buffer.from(options.body);
  const res = await handle({ method: options.method ?? "GET", path: options.path ?? "/v1/consent", headers, body });
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(res.headers)) lower[name.toLowerCase()] = value;
  let json: unknown;
  try {
    json = res.body ? JSON.parse(res.body) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: lower, text: res.body, json };
}
