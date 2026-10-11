// Chatwoot の Application API（参照専用トークン）。誤った書き込みの突き合わせだけが使う。
// 会話は display_id（画面の #番号）で扱う。ページ件数は上流で固定（会話 25・メッセージ 20）。
import * as z from "zod/v4";
import type { ControlPlaneConfig } from "../config.js";
import { CONTROL_TIMEOUT_SEC } from "../constants/timeouts.js";
import { fetchJson, IntegrationError, requireSuccess } from "./http.js";

type MiswriteConfig = NonNullable<ControlPlaneConfig["miswrite"]>;

const ConversationPage = z.object({
  data: z.object({
    payload: z.array(z.object({ id: z.number(), last_activity_at: z.number().optional() })),
  }),
});

const MessagePage = z.object({
  payload: z.array(
    z.object({
      id: z.number(),
      created_at: z.number(),
      message_type: z.number().optional(),
      sender: z.object({ id: z.number().optional(), type: z.string().optional() }).nullish(),
    }),
  ),
});

export interface ChatwootMessage {
  id: number;
  createdAtMs: number;
  /** 0: 受信 / 1: 送信 / 2: アクティビティ */
  messageType: number | null;
  senderType: string | null;
  senderId: number | null;
}

export class ChatwootReader {
  private first = true;

  constructor(
    private readonly config: MiswriteConfig,
    private readonly signal?: AbortSignal,
  ) {}

  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const result = await fetchJson<unknown>({
      upstream: "chatwoot",
      url: `${this.config.baseUrl}/api/v1/accounts/${this.config.accountId}${path}`,
      init: { headers: { api_access_token: this.config.apiToken, Accept: "application/json" } },
      timeoutMs: CONTROL_TIMEOUT_SEC.chatwootRead * 1000,
      signal: this.signal,
      firstRequest: this.first,
    });
    this.first = false;
    requireSuccess(result, "Chatwoot の読み取り");
    const parsed = schema.safeParse(result.data);
    if (!parsed.success) throw new IntegrationError("invalid_response", "Chatwoot: 想定外の応答の形");
    return parsed.data;
  }

  /** 更新の新しい順（上流の既定）に 1 ページ（25 件）。 */
  async conversationsPage(page: number): Promise<{ displayId: number; lastActivityMs: number | null }[]> {
    const data = await this.get(`/conversations?status=all&page=${page}`, ConversationPage);
    return data.data.payload.map((c) => ({
      displayId: c.id,
      lastActivityMs: c.last_activity_at === undefined ? null : c.last_activity_at * 1000,
    }));
  }

  /**
   * メッセージを最大 20 件。before が無ければ最新の 20 件、あれば id が before より小さいものの直近 20 件。
   * **並びは古い順（created_at の昇順）**（Chatwoot の MessageFinder#messages_latest / messages_before が
   * 新しい順に 20 件取ってから reverse する）。本文は読み捨てる。
   */
  async messages(displayId: number, before?: number): Promise<ChatwootMessage[]> {
    const query = before === undefined ? "" : `?before=${before}`;
    const data = await this.get(`/conversations/${displayId}/messages${query}`, MessagePage);
    return data.payload.map((m) => ({
      id: m.id,
      createdAtMs: m.created_at * 1000,
      messageType: m.message_type ?? null,
      senderType: m.sender?.type ?? null,
      senderId: m.sender?.id ?? null,
    }));
  }
}
