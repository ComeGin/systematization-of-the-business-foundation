import type { CallToolResult } from "@modelcontextprotocol/server";

import { CHARACTER_LIMIT, LONG_TEXT_LIMIT } from "../constants.js";
import { describeError } from "./mautic-client.js";

export type ResponseFormat = "markdown" | "json";

export function errorResult(error: unknown, notFoundHint?: string): CallToolResult {
  return errorText(describeError(error, notFoundHint));
}

export function errorText(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// Webhook の secret など、モデルに渡すべきでない値を持つキー
const SECRET_KEY_PATTERN = /secret|password|token|api_?key/i;

/**
 * API レスポンスをモデルに返す前の共通処理（オブジェクト・配列は再帰的に処理）。
 *   - 秘匿情報らしいキーの値を伏せる
 *   - メール本文の HTML など、長い文字列を省略する（includeLongText=true のときは省略しない）
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
        SECRET_KEY_PATTERN.test(key) && child !== null && child !== "" ? "[redacted]" : sanitize(child, options),
      ]),
    );
  }
  return value;
}

/** 形の決まっていない JSON を返すツール用。上限を超えたら末尾を切り詰めて案内を付ける */
export function jsonResult(data: unknown, hint: string): CallToolResult {
  let text = JSON.stringify(sanitize(data), null, 2);
  if (text.length > CHARACTER_LIMIT) {
    text = `${text.slice(0, CHARACTER_LIMIT)}\n… [truncated at ${CHARACTER_LIMIT} chars. ${hint}]`;
  }
  return { content: [{ type: "text", text }] };
}

export interface PagedOutput<T> {
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
  truncation_message?: string;
  items: T[];
}

export function pagedOutput<T>(total: number, offset: number, items: T[]): PagedOutput<T> {
  const hasMore = total > offset + items.length;
  return {
    total,
    count: items.length,
    offset,
    has_more: hasMore,
    ...(hasMore ? { next_offset: offset + items.length } : {}),
    items,
  };
}

/** 応答が CHARACTER_LIMIT を超える場合、件数を半分ずつ減らしてページングを案内する */
export function fitToLimit<T, O extends PagedOutput<T>>(output: O, render: (o: O) => string): [O, string] {
  let current = output;
  let rendered = render(current);
  while (rendered.length > CHARACTER_LIMIT && current.items.length > 1) {
    const items = current.items.slice(0, Math.ceil(current.items.length / 2));
    const nextOffset = current.offset + items.length;
    current = {
      ...current,
      items,
      count: items.length,
      has_more: true,
      next_offset: nextOffset,
      truncation_message: `Response truncated to ${items.length} items to fit the size limit. Use a smaller limit or offset=${nextOffset} to continue.`,
    };
    rendered = render(current);
  }
  return [current, rendered];
}

/** 値を Markdown の 1 行に収まる表記にする */
export function inline(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "object") return `\`${JSON.stringify(value)}\``;
  return String(value);
}
