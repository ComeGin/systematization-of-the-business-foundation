import { HTTP_TIMEOUT_MS } from "../constants.js";

export interface ChatwootClientOptions {
  baseUrl: string;
  accessToken: string;
  accountId: number;
}

/** 配列は Rails 形式のクエリ（`labels[]=a&labels[]=b`）に展開する */
export type QueryValue = string | number | boolean | null | undefined | (string | number)[];

export interface RequestOptions {
  /** v1: /api/v1/accounts/{id}、v2: /api/v2/accounts/{id}、root: /api/v1（プロフィールなどアカウント外の API） */
  scope?: "v1" | "v2" | "root";
  query?: Record<string, QueryValue>;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class ChatwootApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ChatwootApiError";
    this.status = status;
  }
}

/**
 * fetch 自身が投げた通信失敗（接続できない・名前解決できないなど）。
 * ツール側で応答を整形している最中の TypeError（想定外の形の応答）と区別するため、fetch の TypeError だけをこれに包み直す。
 * 元のエラーの文面は URL などを含みうるため message には入れず、cause にだけ持つ
 */
export class ChatwootNetworkError extends Error {
  constructor(cause: unknown) {
    super("Could not reach Chatwoot", { cause });
    this.name = "ChatwootNetworkError";
  }
}

/**
 * Chatwoot Application API のクライアント。
 * 認証はユーザーのアクセストークン（api_access_token ヘッダー）。権限はトークンを発行したユーザーのロールで決まる。
 */
export class ChatwootClient {
  readonly #options: ChatwootClientOptions;

  constructor(options: ChatwootClientOptions) {
    this.#options = options;
  }

  get accountId(): number {
    return this.#options.accountId;
  }

  async get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, undefined, options);
  }

  /** 成功時に本文がない API（`head :ok`）は null を返す */
  async request<T>(method: HttpMethod, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.#options.baseUrl}${prefix(options.scope ?? "v1", this.#options.accountId)}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) appendQuery(url.searchParams, key, value);

    // ハイフンの綴りにする。本番の ALB（drop_invalid_header_fields）はアンダースコアを含むヘッダーを捨てる。
    // Chatwoot は HTTP_API_ACCESS_TOKEN として読むので、どちらの綴りでも同じトークンとして通る
    const headers: Record<string, string> = { "api-access-token": this.#options.accessToken, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await network(
      fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      }),
    );
    if (!response.ok) throw await toApiError(response);

    // 本文の受信中に接続が切れた場合も fetch と同じく TypeError になるため、通信失敗として扱う
    const text = await network(response.text());
    return (text.trim() === "" ? null : JSON.parse(text)) as T;
  }
}

/** fetch（本文の受信を含む）が投げた TypeError を ChatwootNetworkError にする。タイムアウト（DOMException）などはそのまま投げる */
async function network<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    throw error instanceof TypeError ? new ChatwootNetworkError(error) : error;
  }
}

function prefix(scope: NonNullable<RequestOptions["scope"]>, accountId: number): string {
  switch (scope) {
    case "v1":
      return `/api/v1/accounts/${accountId}`;
    case "v2":
      return `/api/v2/accounts/${accountId}`;
    case "root":
      return "/api/v1";
  }
}

function appendQuery(params: URLSearchParams, key: string, value: QueryValue): void {
  if (value === undefined || value === null || value === "") return;
  if (Array.isArray(value)) {
    for (const item of value) params.append(`${key}[]`, String(item));
  } else {
    params.append(key, String(value));
  }
}

async function toApiError(response: Response): Promise<ChatwootApiError> {
  let message = response.statusText;
  try {
    // Chatwoot のエラー形式は API によって異なる:
    //   { error: "..." } / { error: { field: [...] } } / { message: "...", attributes: [...] } / { errors: [...] }
    const body = (await response.json()) as { error?: unknown; message?: unknown; errors?: unknown; attributes?: unknown };
    const detail = body.error ?? body.message ?? body.errors;
    if (detail !== undefined) message = typeof detail === "string" ? detail : JSON.stringify(detail);
    if (Array.isArray(body.attributes) && body.attributes.length > 0) message += ` (fields: ${body.attributes.join(", ")})`;
  } catch {
    // JSON 以外（プロキシのエラーページや本文なしの 422 など）はステータス文言のみ使う
  }
  return new ChatwootApiError(response.status, message);
}

/**
 * ツール結果としてモデルに返すエラーメッセージ。次に取るべき行動を含める
 * @param notFoundHint 404 のときの案内（ツールごとに適切な次の手順が異なるため）
 */
export function describeError(error: unknown, notFoundHint = "Verify the ID first with the matching list tool."): string {
  if (error instanceof ChatwootApiError) {
    switch (error.status) {
      case 400:
      case 422:
        return `Error: Chatwoot rejected the request (${error.message}). Fix the listed fields or parameters and retry.`;
      case 401:
        // Chatwoot は「トークン不正」と「権限不足」のどちらも 401 で返す
        return error.message === "Invalid Access Token"
          ? "Error: Chatwoot rejected the access token. This cannot be fixed by retrying; ask the operator to check CHATWOOT_API_ACCESS_TOKEN."
          : `Error: Permission denied (${error.message}). The token's user role (agent/administrator) does not allow this action.`;
      case 402:
        return `Error: This feature is not available on the current Chatwoot plan or edition (${error.message}).`;
      case 403:
        return `Error: Forbidden (${error.message}). If API access is disabled, enable it for the account in Chatwoot; otherwise the action is not allowed for this resource.`;
      case 404:
        return `Error: Not found (${error.message}). ${notFoundHint}`;
      case 429:
        return "Error: Rate limit exceeded. Wait a moment before retrying.";
      default:
        return error.status >= 500
          ? `Error: Chatwoot server error (${error.status}). An invalid parameter value often causes this; otherwise retry later (details are in the Chatwoot rails logs).`
          : `Error: Chatwoot API request failed (${error.status}): ${error.message}`;
    }
  }
  // 日付の指定ミスなど、Chatwoot に送る前に弾いたもの
  if (error instanceof RangeError) return `Error: ${error.message}`;
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return `Error: Chatwoot did not respond within ${HTTP_TIMEOUT_MS / 1000}s. Retry, or narrow the request (date range, filters).`;
  }
  if (error instanceof SyntaxError) {
    return "Error: Chatwoot returned a non-JSON response. The endpoint may be unavailable in this Chatwoot version or behind a proxy error page.";
  }
  if (error instanceof ChatwootNetworkError) {
    return "Error: Could not reach Chatwoot (network error). Check that the Chatwoot containers are running and CHATWOOT_BASE_URL is correct.";
  }
  // fetch の TypeError は ChatwootNetworkError に包み直してあるため、ここに来るのは応答の整形中の TypeError（payload がないなど）
  if (error instanceof TypeError) {
    return (
      `Error: Unexpected response shape from Chatwoot (${error.message}). The request reached Chatwoot, but the response lacked expected fields ` +
      "(the Chatwoot version may differ). Check the current state with the matching get or list tool before retrying a write."
    );
  }
  return `Error: Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}
