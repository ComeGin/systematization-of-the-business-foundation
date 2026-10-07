// 結合テストの HTTP。タイムアウト付きで、本文を JSON として読めれば json に入れる（読めなければ undefined）。
export interface HttpResult<T = unknown> {
  status: number;
  headers: Headers;
  text: string;
  json: T | undefined;
}

export interface HttpOptions extends Omit<RequestInit, "body" | "signal"> {
  body?: unknown;
  timeoutMs?: number;
}

/**
 * 1 回だけ送る（リトライしない。結合テストは 1 回目の応答そのものを確かめるため）。
 * body がオブジェクトなら JSON にして Content-Type を付ける。文字列・Buffer・URLSearchParams はそのまま送る。
 */
export async function http<T = unknown>(url: string, options: HttpOptions = {}): Promise<HttpResult<T>> {
  const { body, timeoutMs = 20_000, headers, ...rest } = options;
  const h = new Headers(headers);
  let payload: RequestInit["body"];
  if (body === undefined || body === null) payload = undefined;
  else if (typeof body === "string" || body instanceof URLSearchParams || body instanceof Uint8Array || body instanceof FormData) payload = body as RequestInit["body"];
  else {
    payload = JSON.stringify(body);
    if (!h.has("content-type")) h.set("content-type", "application/json");
  }
  const res = await fetch(url, { ...rest, headers: h, body: payload, signal: AbortSignal.timeout(timeoutMs), redirect: rest.redirect ?? "manual" });
  const text = await res.text();
  let json: T | undefined;
  try {
    json = text ? (JSON.parse(text) as T) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** 接続できるか（応答の状態は問わない）。落ちている・届かないときは false */
export async function reachable(url: string, timeoutMs = 3_000): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}
