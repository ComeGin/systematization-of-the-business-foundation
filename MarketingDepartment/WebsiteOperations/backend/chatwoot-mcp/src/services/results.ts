import type { CallToolResult } from "@modelcontextprotocol/server";

import { CHARACTER_LIMIT, LONG_TEXT_LIMIT } from "../constants.js";
import { describeError } from "./chatwoot-client.js";

export type ResponseFormat = "markdown" | "json";

export function errorResult(error: unknown, notFoundHint?: string): CallToolResult {
  return errorText(describeError(error, notFoundHint));
}

export function errorText(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// Webhook / AgentBot の secret、ユーザーやボットの access_token、Inbox の hmac_token など、モデルに渡すべきでない値を持つキー
const SECRET_KEY_PATTERN = /secret|password|token|api_?key|hmac/i;
// 名前に token を含むが秘匿情報ではないキー（Web ウィジェットの埋め込み用トークンは公開ページに埋め込まれる値）
const NON_SECRET_KEYS = new Set(["website_token", "hmac_verified", "hmac_mandatory"]);

/**
 * API レスポンスをモデルに返す前の共通処理（オブジェクト・配列は再帰的に処理）。
 *   - 秘匿情報らしいキーの値を伏せる
 *   - メール本文など、長い文字列を省略する（includeLongText=true のときは省略しない）
 */
export function sanitize(value: unknown, options: { includeLongText?: boolean; maxText?: number } = {}): unknown {
  const maxText = options.maxText ?? LONG_TEXT_LIMIT;
  if (typeof value === "string") {
    return !options.includeLongText && value.length > maxText
      ? `${value.slice(0, 200)}… [omitted ${value.length} chars; call again with include_long_text=true for the full text]`
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, options));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        isSecretKey(key) && child !== null && child !== "" && typeof child !== "boolean" ? "[redacted]" : sanitize(child, options),
      ]),
    );
  }
  return value;
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key) && !NON_SECRET_KEYS.has(key);
}

/** 上限を超えたテキストを切り詰めて案内を付ける */
export function truncate(text: string, hint: string): string {
  return text.length > CHARACTER_LIMIT ? `${text.slice(0, CHARACTER_LIMIT)}\n… [truncated at ${CHARACTER_LIMIT} chars. ${hint}]` : text;
}

/** 形の決まっていない JSON を返すツール用（秘匿情報を伏せ、上限を超えたら切り詰める） */
export function jsonResult(data: unknown, hint: string, options: { includeLongText?: boolean } = {}): CallToolResult {
  return { content: [{ type: "text", text: truncate(JSON.stringify(sanitize(data, options), null, 2), hint) }] };
}

/** Markdown / JSON を選べるツールの共通の返し方。structuredContent には常に JSON を入れる */
export function formattedResult(
  structured: Record<string, unknown>,
  format: ResponseFormat,
  renderMarkdown: () => string,
  hint: string,
): CallToolResult {
  const text = format === "json" ? JSON.stringify(structured, null, 2) : renderMarkdown();
  return { content: [{ type: "text", text: truncate(text, hint) }], structuredContent: structured };
}

export interface PagedOutput<T> {
  page: number;
  count: number;
  /** 条件に一致する全件数（API が返す場合のみ） */
  total?: number;
  has_more: boolean;
  next_page?: number;
  truncation_message?: string;
  items: T[];
}

export function pagedOutput<T>(page: number, items: T[], hasMore: boolean, total?: number): PagedOutput<T> {
  return {
    page,
    count: items.length,
    ...(total === undefined ? {} : { total }),
    has_more: hasMore,
    ...(hasMore ? { next_page: page + 1 } : {}),
    items,
  };
}

/**
 * 応答が CHARACTER_LIMIT を超える場合、件数を半分ずつ減らす。
 * ページサイズは Chatwoot 側で固定のため、減らした分は「次のページ」では取得できない点を案内する
 */
export function fitToLimit<T, O extends PagedOutput<T>>(output: O, render: (o: O) => string, hint: string): [O, string] {
  let current = output;
  let rendered = render(current);
  while (rendered.length > CHARACTER_LIMIT && current.items.length > 1) {
    const items = current.items.slice(0, Math.ceil(current.items.length / 2));
    current = {
      ...current,
      items,
      count: items.length,
      truncation_message: `Response truncated to the first ${items.length} items of this page to fit the size limit. ${hint}`,
    };
    rendered = render(current);
  }
  return [current, rendered];
}

/** 値を Markdown の 1 行に収まる表記にする */
export function inline(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "object") return `\`${JSON.stringify(value)}\``;
  return String(value).replace(/\s*\n\s*/g, " ");
}

/** 空でない値だけを持つオブジェクトにする（一覧の要約用） */
export function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => {
      if (value === null || value === undefined || value === "") return false;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === "object") return Object.keys(value).length > 0;
      return true;
    }),
  );
}

/** オブジェクトを「- **key**: value」の行にする。ネストした値は JSON ブロックにまとめる */
export function renderFields(record: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const nested: [string, unknown][] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object") nested.push([key, value]);
    else lines.push(`- **${key}**: ${inline(value)}`);
  }
  for (const [key, value] of nested) {
    if (Array.isArray(value) && value.every((item) => typeof item !== "object")) {
      if (value.length) lines.push(`- **${key}**: ${value.join(", ")}`);
    } else if (Object.keys(value as object).length) {
      lines.push(`- **${key}**:`, "```json", JSON.stringify(value, null, 2), "```");
    }
  }
  return lines;
}
