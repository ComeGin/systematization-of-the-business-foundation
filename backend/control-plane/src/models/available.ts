// 選べる実行モデルの一覧（2026-11-12）。Anthropic の Models API と OpenAI の models.list から読む。
// - 画面を開くたびに外へ出ないよう、プロセス内で 10 分だけ覚える（失敗は覚えない。次に開いたときにもう一度読む）
// - API キーとエラーの本文は画面にもログにも出さない（401 の本文にキーの一部が入りうる）。HTTP ステータスと分類だけ
// - OpenAI は画像のモデル（gpt-image・dall-e）だけに絞る（使うのはアイキャッチ画像だけ。チャットのモデルを選ばせない）
// 出典: Anthropic「List Models」GET /v1/models（x-api-key・anthropic-version: 2023-06-01。data[].id・display_name・created_at、
//       has_more と last_id で次のページ。limit は 1〜1000）、OpenAI「List models」GET /v1/models（data[].id・created）
import OpenAI from "openai";
import type { AvailableModels } from "../contract.js";

const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 15_000;
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";
/** 画像の生成に使えるモデルの id の形（OpenAI。2026-11 時点で gpt-image 系。旧い dall-e も残す） */
const OPENAI_IMAGE_MODEL = /^(gpt-image|chatgpt-image|dall-e)/;

type Provider = "anthropic" | "openai";
const cache = new Map<Provider, { at: number; value: AvailableModels }>();

function cached(provider: Provider): AvailableModels | null {
  const hit = cache.get(provider);
  return hit && Date.now() - hit.at < CACHE_MS ? hit.value : null;
}

function remember(provider: Provider, value: AvailableModels): AvailableModels {
  if (value.ok) cache.set(provider, { at: Date.now(), value });
  return value;
}

const unavailable = (reason: string): AvailableModels => ({ ok: false, reason, models: [] });

/** Anthropic の、今の API キーで使えるモデル（新しい順。API の返す順のまま） */
export async function listAnthropicModels(apiKey: string | null): Promise<AvailableModels> {
  if (!apiKey) return unavailable("ANTHROPIC_API_KEY が無い");
  const hit = cached("anthropic");
  if (hit) return hit;
  const models: AvailableModels["models"] = [];
  let after: string | null = null;
  try {
    // 念のためページの数に上限を置く（1 ページ 1000 件なので、通常は 1 回で終わる）
    for (let page = 0; page < 5; page++) {
      const url = new URL(ANTHROPIC_MODELS_URL);
      url.searchParams.set("limit", "1000");
      if (after) url.searchParams.set("after_id", after);
      const response = await fetch(url, {
        headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) return unavailable(`Anthropic の Models API が HTTP ${response.status} を返した`);
      const body = (await response.json()) as { data?: { id?: unknown; display_name?: unknown; created_at?: unknown }[]; has_more?: boolean; last_id?: string | null };
      for (const entry of body.data ?? []) {
        if (typeof entry.id !== "string") continue;
        models.push({
          id: entry.id,
          displayName: typeof entry.display_name === "string" ? entry.display_name : entry.id,
          createdAt: typeof entry.created_at === "string" ? entry.created_at : null,
        });
      }
      if (!body.has_more || !body.last_id) break;
      after = body.last_id;
    }
  } catch (error) {
    return unavailable(error instanceof Error && error.name === "TimeoutError" ? "Anthropic の Models API が時間内に応答しなかった" : "Anthropic の Models API に接続できなかった");
  }
  if (models.length === 0) return unavailable("Anthropic の Models API が 1 件も返さなかった");
  return remember("anthropic", { ok: true, reason: null, models });
}

/** OpenAI の、今の API キーで使える画像のモデル（新しい順） */
export async function listOpenAiImageModels(apiKey: string | null): Promise<AvailableModels> {
  if (!apiKey) return unavailable("OPENAI_API_KEY が無い");
  const hit = cached("openai");
  if (hit) return hit;
  const client = new OpenAI({ apiKey, maxRetries: 0, timeout: TIMEOUT_MS });
  const found: { id: string; created: number }[] = [];
  try {
    for await (const model of client.models.list()) {
      if (OPENAI_IMAGE_MODEL.test(model.id)) found.push({ id: model.id, created: model.created });
    }
  } catch (error) {
    if (error instanceof OpenAI.APIError && error.status) return unavailable(`OpenAI の models.list が HTTP ${error.status} を返した`);
    return unavailable("OpenAI の models.list に接続できなかった");
  }
  if (found.length === 0) return unavailable("OpenAI の models.list に画像のモデルが無かった（キーのプロジェクトで画像のモデルが許可されているかを確かめる）");
  found.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
  return remember("openai", {
    ok: true,
    reason: null,
    models: found.map((m) => ({ id: m.id, displayName: m.id, createdAt: new Date(m.created * 1000).toISOString() })),
  });
}

/** テスト・キーの入れ替えのあとに、覚えた一覧を捨てる */
export function clearAvailableModelsCache(): void {
  cache.clear();
}
