import { vi } from "vitest";

/** テスト内で使う Chatwoot のアカウント ID と API のパスの接頭辞 */
export const ACCOUNT_ID = 1;
export const V1 = `/api/v1/accounts/${ACCOUNT_ID}`;
export const V2 = `/api/v2/accounts/${ACCOUNT_ID}`;

export interface RecordedCall {
  method: string;
  url: URL;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  /** JSON の本文（本文なしは undefined） */
  body: unknown;
  rawBody: unknown;
  signal: AbortSignal | null | undefined;
}

export interface MockResponse {
  status?: number;
  statusText?: string;
  /** JSON にして返す本文 */
  json?: unknown;
  /** そのまま返す本文（json より優先） */
  text?: string;
}

export type Responder = (call: RecordedCall) => MockResponse | Promise<MockResponse>;

/** fetch を差し替え、呼び出しを記録する。実ネットワークには繋がない */
export function installFetch(responder: Responder) {
  const calls: RecordedCall[] = [];
  const fn = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const call: RecordedCall = {
      method: init.method ?? "GET",
      url,
      path: url.pathname,
      query: url.searchParams,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      rawBody: init.body,
      signal: init.signal,
    };
    calls.push(call);
    const response = await responder(call);
    const status = response.status ?? 200;
    const text = response.text ?? (response.json === undefined ? "" : JSON.stringify(response.json));
    return new Response(status === 204 ? null : text, { status, statusText: response.statusText ?? "" });
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

/**
 * 「METHOD パス」→ 応答 の表から responder を作る。表にない要求は 404 にする（想定外の呼び出しを見逃さないため）。
 * 値に関数を渡すと、呼び出しごとに応答を組み立てられる。
 */
export function routes(table: Record<string, MockResponse | ((call: RecordedCall) => MockResponse)>): Responder {
  return (call) => {
    const entry = table[`${call.method} ${call.path}`];
    if (entry === undefined) return { status: 404, json: { error: `not mocked: ${call.method} ${call.path}` } };
    return typeof entry === "function" ? entry(call) : entry;
  };
}

/** 記録した呼び出しを「METHOD パス」の列にする（順序の検証用） */
export function callKeys(calls: RecordedCall[]): string[] {
  return calls.map((call) => `${call.method} ${call.path}`);
}
