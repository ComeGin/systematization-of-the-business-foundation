// OpenAI SDK（公式の `openai` パッケージ）の差し替え。開発時は OpenAI に繋がない（画像の生成は 1 回ごとに課金されるため）。
// テストファイルの vi.mock から `() => import("./helpers/openai-mock.js").then((m) => m.openaiModule)` の形で使う。
//
// src/integrations/openai-image.ts が使う分だけ（default の OpenAI クラス・images.generate・エラーのクラス 4 つ）を持つ。
// エラーのクラスの継承は SDK と同じにする（APIUserAbortError・APIConnectionError は APIError の子、
// APIConnectionTimeoutError は APIConnectionError の子。classify() が instanceof の順に見るため）。
import { vi } from "vitest";

class APIError extends Error {
  constructor(
    readonly status: number | undefined,
    message = `OpenAI API error ${status ?? ""}`,
  ) {
    super(message);
    this.name = "APIError";
  }
}
class APIUserAbortError extends APIError {
  constructor() {
    super(undefined, "Request was aborted.");
    this.name = "APIUserAbortError";
  }
}
class APIConnectionError extends APIError {
  constructor(message = "Connection error.") {
    super(undefined, message);
    this.name = "APIConnectionError";
  }
}
class APIConnectionTimeoutError extends APIConnectionError {
  constructor() {
    super("Request timed out.");
    this.name = "APIConnectionTimeoutError";
  }
}

export interface ImageRequest {
  model: string;
  prompt: string;
  size: string;
  quality: string;
  n: number;
  output_format: string;
}

export const openai = {
  /** images.generate の本体。テストごとに実装を決める（resetOpenAi の既定は「印の入ったプロンプトだけ成功」） */
  generate: vi.fn<(request: ImageRequest) => Promise<{ data?: { b64_json?: string }[] }>>(),
  /** new OpenAI({ apiKey }) に渡された設定（キーがエージェントではなく control-plane で使われたことの確認） */
  clients: [] as { apiKey: string; maxRetries?: number }[],
};

class OpenAI {
  static APIError = APIError;
  static APIUserAbortError = APIUserAbortError;
  static APIConnectionError = APIConnectionError;
  static APIConnectionTimeoutError = APIConnectionTimeoutError;

  readonly images: { generate: (request: ImageRequest, options?: { signal?: AbortSignal }) => Promise<{ data?: { b64_json?: string }[] }> };

  constructor(options: { apiKey: string; maxRetries?: number }) {
    openai.clients.push({ apiKey: options.apiKey, maxRetries: options.maxRetries });
    this.images = {
      generate: async (request, requestOptions) => {
        if (requestOptions?.signal?.aborted) throw new APIUserAbortError();
        return openai.generate(request);
      },
    };
  }
}

export const openaiModule = { default: OpenAI, APIError, APIUserAbortError, APIConnectionError, APIConnectionTimeoutError };
export const openaiErrors = { APIError, APIUserAbortError, APIConnectionError, APIConnectionTimeoutError };

/** 1×1 の PNG（Strapi のメディアライブラリが画像として受け付ける最小のもの） */
export const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * 既定の実装に戻す。プロンプトに marker（このテストの記事のタイトルの一部）を含むときだけ画像を返し、
 * それ以外（開発の Strapi に元からある下書き）は 400 で断る。テストの外の下書きに画像を上げて結ばないための歯止め。
 */
export function resetOpenAi(marker: string): void {
  openai.clients.length = 0;
  openai.generate.mockReset().mockImplementation(async (request) => {
    if (!request.prompt.includes(marker)) throw new APIError(400, "結合テストの外の記事なので生成しない");
    return { data: [{ b64_json: TINY_PNG_BASE64 }] };
  });
}

/** generate に渡されたプロンプトの一覧 */
export function imagePrompts(): string[] {
  return openai.generate.mock.calls.map(([request]) => request.prompt);
}
