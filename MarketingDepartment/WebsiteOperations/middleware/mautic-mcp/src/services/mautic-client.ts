import { HTTP_TIMEOUT_MS, TOKEN_REFRESH_MARGIN_SEC } from "../constants.js";
import type { MauticErrorBody, MauticTokenResponse } from "../types.js";

export interface MauticClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

type QueryValue = string | number | boolean | undefined;

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
    const url = new URL(`${this.#options.baseUrl}/api${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let response = await this.#send(url);
    if (response.status === 401) {
      // Mautic 側でトークンが先に無効化された場合に備え、1 回だけ取り直して再試行する
      this.#token = null;
      response = await this.#send(url);
    }
    if (!response.ok) throw await toApiError(response);
    return (await response.json()) as T;
  }

  async #send(url: URL): Promise<Response> {
    return fetch(url, {
      headers: { Authorization: `Bearer ${await this.#accessToken()}`, Accept: "application/json" },
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

async function toApiError(response: Response): Promise<MauticApiError> {
  let message = response.statusText;
  try {
    const body = (await response.json()) as MauticErrorBody & { error_description?: string };
    message = body.errors?.[0]?.message ?? body.error_description ?? message;
  } catch {
    // JSON 以外（ngrok のエラーページなど）はステータス文言のみ使う
  }
  return new MauticApiError(response.status, message);
}

/** ツール結果としてモデルに返すエラーメッセージ。次に取るべき行動を含める */
export function describeError(error: unknown): string {
  if (error instanceof MauticApiError) {
    if (error.message.startsWith("Failed to obtain Mautic access token")) {
      return (
        `Error: ${error.message}. The MCP server's Mautic credentials are invalid or the API credential ` +
        "does not allow the client_credentials grant. This cannot be fixed by retrying; ask the operator to check the server configuration."
      );
    }
    switch (error.status) {
      case 401:
        return "Error: Mautic rejected the access token even after refreshing it. Ask the operator to check the API credential in Mautic.";
      case 403:
        return `Error: Permission denied (${error.message}). The API credential's role in Mautic lacks permission for this resource.`;
      case 404:
        return `Error: Not found (${error.message}). Verify the ID, e.g. by searching with mautic_list_contacts first.`;
      case 429:
        return "Error: Rate limit exceeded. Wait a moment before retrying.";
      default:
        return error.status >= 500
          ? `Error: Mautic server error (${error.status}). Retry later; if it persists, the Mautic logs (var/logs) contain the cause.`
          : `Error: Mautic API request failed (${error.status}): ${error.message}`;
    }
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return `Error: Mautic did not respond within ${HTTP_TIMEOUT_MS / 1000}s. Retry, or narrow the request (smaller limit).`;
  }
  if (error instanceof TypeError) {
    return "Error: Could not reach Mautic (network error). Check that Mautic and its public URL (ngrok) are running.";
  }
  return `Error: Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}
