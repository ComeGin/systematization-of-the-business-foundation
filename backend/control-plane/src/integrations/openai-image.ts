// OpenAI の Images API（記事のアイキャッチ画像の生成。builtin article-cover が使う。spec 5.7）。
// - GPT Image 系のモデルは常に base64（b64_json）で返す。response_format は渡さない（旧モデル用で、GPT Image では未対応）。
// - 出力は PNG に固定する（output_format）。Strapi へは image/png でアップロードする。
// - 再試行はしない（maxRetries: 0）。生成は 1 回ごとに課金されるため、失敗は次の日の実行にまかせる。
// - API キーとエラーの本文はログにも結果にも出さない（401 のメッセージにキーの一部が入りうる）。分類と HTTP ステータスだけを残す。
import OpenAI from "openai";
import { IntegrationError } from "./http.js";

/** 1 回の生成のタイムアウト。大きめの画像・高い品質では 1 分を超えることがある。builtin 全体の打ち切りは signal が受け持つ */
const GENERATE_TIMEOUT_MS = 180_000;

/**
 * 画質。1 枚あたりの費用の上限を決めるため "medium" に固定する（設定にはしない）。
 * GPT Image 系は low・medium・high を受け付ける（gpt-image-2.5-sunburst・flare はさらに xhigh・max）。2026-11-09 に OpenAI の公式ドキュメントで確認。
 */
const COVER_QUALITY = "medium";

export function createOpenAiClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey, maxRetries: 0, timeout: GENERATE_TIMEOUT_MS });
}

function classify(error: unknown): IntegrationError {
  // タイムアウトは APIUserAbortError ではなく APIConnectionTimeoutError。停止要求・タイムアウトはどちらも timeout にそろえる（http.ts と同じ）
  if (error instanceof OpenAI.APIUserAbortError || error instanceof OpenAI.APIConnectionTimeoutError) {
    return new IntegrationError("timeout", "OpenAI の画像生成が打ち切られた（タイムアウトか停止要求）");
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new IntegrationError("unreachable", "OpenAI に接続できなかった");
  }
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    if (status === 401) return new IntegrationError("auth_failed", "OpenAI の画像生成: auth_failed (HTTP 401)");
    if (status === 403) return new IntegrationError("permission_denied", "OpenAI の画像生成: permission_denied (HTTP 403)");
    if (status === 429) return new IntegrationError("rate_limited", "OpenAI の画像生成: rate_limited (HTTP 429)");
    // 安全性の審査で断られたときも 400。プロンプトを変えない限り同じなので invalid_response として記事ごとに記録する
    return new IntegrationError("invalid_response", `OpenAI の画像生成: invalid_response (HTTP ${status ?? "なし"})`);
  }
  return new IntegrationError("invalid_response", "OpenAI の画像生成: 想定外のエラー");
}

/**
 * 画像を 1 枚生成して PNG のバイト列を返す。
 * 失敗は IntegrationError（failureClass 付き）。応答に画像が無い・base64 でなければ invalid_response。
 */
export async function generateCoverImage(
  client: OpenAI,
  prompt: string,
  model: string,
  size: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  let b64: string | undefined;
  try {
    const response = await client.images.generate({ model, prompt, size, quality: COVER_QUALITY, n: 1, output_format: "png" }, { signal });
    b64 = response.data?.[0]?.b64_json;
  } catch (error) {
    throw classify(error);
  }
  if (!b64) throw new IntegrationError("invalid_response", "OpenAI の応答に画像（b64_json）が無い");
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0) throw new IntegrationError("invalid_response", "OpenAI の応答の画像が空");
  return new Uint8Array(bytes);
}
