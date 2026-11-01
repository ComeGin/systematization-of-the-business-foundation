import * as z from "zod/v4";
import type { ConversationStatus, ConversationView, Reply } from "./types.js";

export class ChatwootApiError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
    detail: string,
  ) {
    super(`${operation}: ${detail}`);
    this.name = "ChatwootApiError";
  }
}

export interface CreatedConversation {
  /** display_id（会話の番号。他の API のパスに使う） */
  readonly id: number;
  readonly status: ConversationStatus;
}

/**
 * ボットのトークンで呼べる API だけ（access_token_auth_helper.rb の BOT_ACCESSIBLE_ENDPOINTS）。
 * メッセージの一覧は呼べないため、二重回答の判定は会話の show の last_non_activity_message で行う（仕様 7.4）
 */
export interface ChatwootClient {
  getConversation(conversationId: number): Promise<ConversationView>;
  /** ウィジェットを開いた訪問者の会話を作る（2026-10-12 の仕様 3 節）。status は渡さない（ボットの付いた受信箱では pending になる） */
  createConversation(sourceId: string, inboxId: number): Promise<CreatedConversation>;
  /** inReplyTo が null なら in_reply_to を送らない（一覧のメッセージは訪問者の発言への返事でない） */
  sendMessage(conversationId: number, reply: Reply, inReplyTo: number | null): Promise<void>;
  /** 会話の今のラベル（labels#index）。付け替えの直前に読み直し、ほかの処理が足したラベルを消さないために使う */
  getLabels(conversationId: number): Promise<readonly string[]>;
  setLabels(conversationId: number, labels: readonly string[]): Promise<void>;
  setStatus(conversationId: number, status: "open" | "resolved"): Promise<void>;
}

export interface ChatwootClientOptions {
  baseUrl: string;
  accountId: number;
  token: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

const ConversationSchema = z.object({
  status: z.enum(["open", "resolved", "pending", "snoozed"]),
  labels: z.array(z.string()).nullish(),
  last_non_activity_message: z
    .object({
      id: z.number().int(),
      message_type: z.number().int(),
      content_attributes: z.object({ in_reply_to: z.number().int().nullish() }).passthrough().nullish(),
      sender: z.object({ type: z.string().nullish() }).passthrough().nullish(),
    })
    .passthrough()
    .nullish(),
});

const LabelsSchema = z.object({ payload: z.array(z.string()) });

const CreatedSchema = z.object({
  id: z.number().int().positive(),
  status: z.enum(["open", "resolved", "pending", "snoozed"]),
});

export function createChatwootClient(options: ChatwootClientOptions): ChatwootClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = `${options.baseUrl}/api/v1/accounts/${options.accountId}/conversations`;

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const operation = `${method} conversations${path}`;
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          // ハイフンの綴りにする。本番の ALB（drop_invalid_header_fields）はアンダースコアを含むヘッダーを捨てる。
          // Chatwoot は HTTP_API_ACCESS_TOKEN として読むので、どちらの綴りでも同じトークンとして通る
          "api-access-token": options.token,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      throw new ChatwootApiError(0, operation, (error as Error).name === "TimeoutError" ? "タイムアウト" : "接続できない");
    }
    // 応答の本文は個人情報を含みうるので、エラーのメッセージに入れない
    if (!res.ok) throw new ChatwootApiError(res.status, operation, `HTTP ${res.status}`);
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new ChatwootApiError(res.status, operation, "応答が JSON でない");
    }
  }

  return {
    async getConversation(conversationId) {
      const parsed = ConversationSchema.safeParse(await call("GET", `/${conversationId}`));
      if (!parsed.success) throw new ChatwootApiError(200, `GET conversations/${conversationId}`, "応答の形が違う");
      const last = parsed.data.last_non_activity_message;
      return {
        status: parsed.data.status,
        labels: parsed.data.labels ?? [],
        lastMessage: last
          ? { id: last.id, messageType: last.message_type, senderType: last.sender?.type ?? null, inReplyTo: last.content_attributes?.in_reply_to ?? null }
          : null,
      };
    },

    async createConversation(sourceId, inboxId) {
      const parsed = CreatedSchema.safeParse(await call("POST", "", { source_id: sourceId, inbox_id: inboxId }));
      if (!parsed.success) throw new ChatwootApiError(200, "POST conversations", "応答の形が違う");
      return { id: parsed.data.id, status: parsed.data.status };
    },

    async sendMessage(conversationId, reply, inReplyTo) {
      const replyTo = inReplyTo === null ? {} : { in_reply_to: inReplyTo };
      const body =
        reply.kind === "text"
          ? { content: reply.content, message_type: "outgoing", private: false, ...(inReplyTo === null ? {} : { content_attributes: replyTo }) }
          : {
              content: reply.content,
              message_type: "outgoing",
              private: false,
              content_type: "input_select",
              content_attributes: { items: reply.items, ...replyTo },
            };
      await call("POST", `/${conversationId}/messages`, body);
    },

    async getLabels(conversationId) {
      const parsed = LabelsSchema.safeParse(await call("GET", `/${conversationId}/labels`));
      if (!parsed.success) throw new ChatwootApiError(200, `GET conversations/${conversationId}/labels`, "応答の形が違う");
      return parsed.data.payload;
    },

    async setLabels(conversationId, labels) {
      await call("POST", `/${conversationId}/labels`, { labels });
    },

    async setStatus(conversationId, status) {
      await call("POST", `/${conversationId}/toggle_status`, { status });
    },
  };
}
