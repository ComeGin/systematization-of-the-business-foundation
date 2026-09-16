import { HTTP_TIMEOUT_MS, TOKEN_REFRESH_MARGIN_SEC } from "../constants.js";
import type { MauticErrorBody, MauticTokenResponse } from "../types.js";
import { orderedValues } from "./json-order.js";

export interface MauticClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

/** 配列・オブジェクトは PHP 形式のクエリ（`where[0][col]=id`）に展開する */
export type QueryValue = string | number | boolean | null | undefined | QueryValue[] | { [key: string]: QueryValue };

export interface ListResult<T> {
  total: number;
  items: T[];
  /** items 以外のトップレベルの値（filters, types など） */
  meta: Record<string, unknown>;
}

export class MauticApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "MauticApiError";
    this.status = status;
  }
}

/**
 * OAuth2 client_credentials でトークンを取得・キャッシュし、Mautic REST API を呼び出すクライアント。
 * プロセス内で 1 インスタンスを共有する前提（MCP のリクエストごとに作り直さない）。
 */
export class MauticClient {
  readonly #options: MauticClientOptions;
  #token: { value: string; expiresAt: number } | null = null;
  // 同時に期限切れを検知しても、トークン取得は 1 回にまとめる
  #pendingToken: Promise<string> | null = null;

  constructor(options: MauticClientOptions) {
    this.#options = options;
  }

  async get<T>(path: string, query: Record<string, QueryValue> = {}): Promise<T> {
    return JSON.parse(await this.#request("GET", path, query)) as T;
  }

  /** 一覧 API を呼び出し、`property`（例: "emails"）の要素を API の並び順のまま配列で返す */
  async getList<T>(path: string, property: string, query: Record<string, QueryValue> = {}): Promise<ListResult<T>> {
    const raw = await this.#request("GET", path, query);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const items = orderedValues<T>(raw, parsed, property);
    const { [property]: _items, total, ...meta } = parsed;
    return { total: total === undefined ? items.length : Number(total), items, meta };
  }

  /** 書き込み系（POST / PATCH / DELETE）。body は JSON で送る */
  async write<T>(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    return JSON.parse(await this.#request(method, path, {}, body)) as T;
  }

  async #request(method: string, path: string, query: Record<string, QueryValue>, body?: unknown): Promise<string> {
    const url = new URL(`${this.#options.baseUrl}/api${path}`);
    for (const [key, value] of Object.entries(query)) appendQuery(url.searchParams, key, value);

    let response = await this.#send(method, url, body);
    if (response.status === 401) {
      // Mautic 側でトークンが先に無効化された場合に備え、1 回だけ取り直して再試行する（401 は未処理なので書き込みでも安全）
      this.#token = null;
      response = await this.#send(method, url, body);
    }
    if (!response.ok) throw await toApiError(response);
    return response.text();
  }

  async #send(method: string, url: URL, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.#accessToken()}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  }

  async #accessToken(): Promise<string> {
    const nowSec = Date.now() / 1000;
    if (this.#token && this.#token.expiresAt - TOKEN_REFRESH_MARGIN_SEC > nowSec) {
      return this.#token.value;
    }
    this.#pendingToken ??= this.#fetchToken().finally(() => {
      this.#pendingToken = null;
    });
    return this.#pendingToken;
  }

  async #fetchToken(): Promise<string> {
    const response = await fetch(`${this.#options.baseUrl}/oauth/v2/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.#options.clientId,
        client_secret: this.#options.clientSecret,
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) {
      const error = await toApiError(response);
      // トークン取得失敗は API 呼び出しの 401 と区別できるよう専用メッセージにする
      throw new MauticApiError(error.status, `Failed to obtain Mautic access token: ${error.message}`);
    }

    const token = (await response.json()) as MauticTokenResponse;
    this.#token = { value: token.access_token, expiresAt: Date.now() / 1000 + token.expires_in };
    return token.access_token;
  }
}

function appendQuery(params: URLSearchParams, key: string, value: QueryValue): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendQuery(params, `${key}[${index}]`, item));
  } else if (typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) appendQuery(params, `${key}[${childKey}]`, child);
  } else {
    params.append(key, String(value));
  }
}

async function toApiError(response: Response): Promise<MauticApiError> {
  let message = response.statusText;
  try {
    const body = (await response.json()) as MauticErrorBody & { error_description?: string };
    const first = body.errors?.[0];
    message = first?.message ?? body.error_description ?? message;
    // 入力エラーでは details にフィールドごとのエラーが入る（例: { "email": ["A valid email is required."] }）
    if (first?.details && Object.keys(first.details).length > 0) message += ` Details: ${JSON.stringify(first.details)}`;
  } catch {
    // JSON 以外（ngrok のエラーページなど）はステータス文言のみ使う
  }
  return new MauticApiError(response.status, message);
}

/**
 * ツール結果としてモデルに返すエラーメッセージ。次に取るべき行動を含める
 * @param notFoundHint 404 のときの案内（ツールごとに適切な次の手順が異なるため）
 */
export function describeError(error: unknown, notFoundHint = "Verify the ID first with the matching list tool."): string {
  if (error instanceof MauticApiError) {
    if (error.message.startsWith("Failed to obtain Mautic access token")) {
      return (
        `Error: ${error.message}. The MCP server's Mautic credentials are invalid or the API credential ` +
        "does not allow the client_credentials grant. This cannot be fixed by retrying; ask the operator to check the server configuration."
      );
    }
    switch (error.status) {
      case 400:
      case 422:
        return (
          `Error: Mautic rejected the request (${error.message}). Fix the listed fields or parameters ` +
          "(for writes, fetch an existing record with the get tool to see valid field names and value formats)."
        );
      case 401:
        return "Error: Mautic rejected the access token even after refreshing it. Ask the operator to check the API credential in Mautic.";
      case 403:
        return `Error: Permission denied (${error.message}). The API credential's role in Mautic lacks permission for this resource, or the feature is disabled.`;
      case 404:
        return `Error: Not found (${error.message}). ${notFoundHint}`;
      case 429:
        return "Error: Rate limit exceeded. Wait a moment before retrying.";
      default:
        return error.status >= 500
          ? `Error: Mautic server error (${error.status}). An invalid order_by column or filter often causes this; otherwise retry later (details are in the Mautic logs).`
          : `Error: Mautic API request failed (${error.status}): ${error.message}`;
    }
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return `Error: Mautic did not respond within ${HTTP_TIMEOUT_MS / 1000}s. Retry, or narrow the request (smaller limit or date range).`;
  }
  if (error instanceof SyntaxError) {
    return "Error: Mautic returned a non-JSON response. The endpoint may be unavailable in this Mautic version or behind a proxy error page.";
  }
  if (error instanceof TypeError) {
    return "Error: Could not reach Mautic (network error). Check that Mautic and its public URL (ngrok) are running.";
  }
  return `Error: Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}
