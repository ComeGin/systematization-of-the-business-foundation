import { describe, expect, it } from "vitest";

import { LONG_TEXT_LIMIT } from "../../src/constants.js";
import {
  messageType,
  renderContactItem,
  renderConversationItem,
  renderMessage,
  toContactDetail,
  toContactSummary,
  toConversationDetail,
  toConversationSummary,
  toMessage,
} from "../../src/services/format.js";
import { TimeZone } from "../../src/services/time.js";
import type { ChatwootContact, ChatwootConversation, ChatwootMessage } from "../../src/types.js";
import { contact, conversation, message } from "../helpers/server.js";

const tz = new TimeZone(9);
const unix = (iso: string) => Date.parse(iso) / 1000;

describe("messageType", () => {
  it("0〜3 を incoming / outgoing / activity / template にし、未知の値は数字のまま返す", () => {
    expect([0, 1, 2, 3, 9].map(messageType)).toEqual(["incoming", "outgoing", "activity", "template", "9"]);
  });
});

describe("toConversationSummary", () => {
  it("id は Chatwoot が返す表示番号（#42）をそのまま使い、時刻は設定した時差で表す", () => {
    const summary = toConversationSummary(conversation({ created_at: unix("2026-09-16T07:00:00+09:00") }) as unknown as ChatwootConversation, tz);
    expect(summary.id).toBe(42);
    expect(summary.created_at).toBe("2026-09-16T07:00:00+09:00");
  });

  it("空値・0・false の項目（未読 0・ミュートなし・返信待ちなし）は省く", () => {
    const summary = toConversationSummary(conversation() as unknown as ChatwootConversation, tz);
    for (const key of ["priority", "unread_count", "muted", "waiting_since", "snoozed_until", "labels", "assignee", "team", "last_message", "custom_attributes"]) {
      expect(summary).not.toHaveProperty(key);
    }
  });

  it("担当者・チーム・連絡先を要約する", () => {
    const summary = toConversationSummary(
      conversation({
        meta: {
          sender: contact(),
          channel: "Channel::WebWidget",
          assignee: { id: 5, name: "Hanako", available_name: "Hanako S" },
          assignee_type: "User",
          team: { id: 2, name: "sales" },
        },
      }) as unknown as ChatwootConversation,
      tz,
    );
    expect(summary.assignee).toEqual({ id: 5, name: "Hanako S", type: "User" });
    expect(summary.team).toEqual({ id: 2, name: "sales" });
    expect(summary.contact).toEqual({ id: 12, name: "山田 太郎", email: "taro@example.com" });
  });

  it("最後のメッセージは改行をまとめて 200 文字で切る", () => {
    const summary = toConversationSummary(
      conversation({ last_non_activity_message: message({ content: "a\n\n" + "b".repeat(300), private: true }) }) as unknown as ChatwootConversation,
      tz,
    );
    const last = summary.last_message as Record<string, unknown>;
    expect(last.content).toBe(`a ${"b".repeat(198)}…`);
    expect(last.private).toBe(true);
    expect(last.sender).toBe("山田 太郎 (contact)");
  });
});

describe("toConversationDetail", () => {
  it("additional_attributes の秘匿情報を伏せ、連絡先は詳細の要約にする", () => {
    const detail = toConversationDetail(
      conversation({ additional_attributes: { browser: "Chrome", auth_token: "t" } }) as unknown as ChatwootConversation,
      tz,
    );
    expect(detail.additional_attributes).toEqual({ browser: "Chrome", auth_token: "[redacted]" });
    expect(detail.uuid).toBe("uuid-42");
    expect(detail.contact).toMatchObject({ id: 12, name: "山田 太郎" });
  });
});

describe("toMessage", () => {
  it("種別・送信者・時刻を整え、既定値（text・sent・private=false）は省く", () => {
    const result = toMessage(message() as unknown as ChatwootMessage, tz, false);
    expect(result).toEqual({ id: 100, type: "incoming", sender: "山田 太郎 (contact)", content: "こんにちは", created_at: tz.format(1_789_000_000) });
  });

  it("送信失敗などの状態と content_attributes を残し、content_attributes の秘匿情報は伏せる", () => {
    const result = toMessage(
      message({ status: "failed", content_attributes: { external_error: "bounced", api_key: "k" } }) as unknown as ChatwootMessage,
      tz,
      false,
    );
    expect(result.status).toBe("failed");
    expect(result.content_attributes).toEqual({ external_error: "bounced", api_key: "[redacted]" });
  });

  it("長い本文は include_long_text が false なら省略し、true なら全文を返す", () => {
    const long = "m".repeat(LONG_TEXT_LIMIT + 1);
    expect(toMessage(message({ content: long }) as unknown as ChatwootMessage, tz, false).content).toContain("include_long_text=true");
    expect(toMessage(message({ content: long }) as unknown as ChatwootMessage, tz, true).content).toBe(long);
  });

  it("添付は種類と URL に要約する", () => {
    const result = toMessage(
      message({ attachments: [{ id: 1, file_type: "image", data_url: "https://x/a.png", extension: null }] }) as unknown as ChatwootMessage,
      tz,
      false,
    );
    expect(result.attachments).toEqual([{ id: 1, file_type: "image", url: "https://x/a.png" }]);
  });

  it("送信者がないときは sender を省き、名前がないときは #ID にする", () => {
    expect(toMessage(message({ sender: null }) as unknown as ChatwootMessage, tz, false)).not.toHaveProperty("sender");
    expect(toMessage(message({ sender: { id: 9 } }) as unknown as ChatwootMessage, tz, false).sender).toBe("#9");
  });
});

describe("toContactSummary / toContactDetail", () => {
  const withInbox = contact({
    additional_attributes: { company_name: "Example Inc.", city: "Tokyo", social_token: "x" },
    contact_inboxes: [{ source_id: "src-1", inbox: { id: 3, name: "Web", channel_type: "Channel::WebWidget" } }],
  }) as unknown as ChatwootContact;

  it("要約は会社名・市区と受信箱名を持つ", () => {
    const summary = toContactSummary(withInbox, tz);
    expect(summary).toMatchObject({ id: 12, company: "Example Inc.", city: "Tokyo", inboxes: ["Web (inbox 3)"] });
  });

  it("詳細は受信箱を source_id 付きで持ち、additional_attributes の秘匿情報を伏せる", () => {
    const detail = toContactDetail(withInbox, tz);
    expect(detail.contact_inboxes).toEqual([{ inbox_id: 3, inbox_name: "Web", channel_type: "Channel::WebWidget", source_id: "src-1" }]);
    expect(detail).not.toHaveProperty("inboxes");
    expect((detail.additional_attributes as Record<string, unknown>).social_token).toBe("[redacted]");
  });
});

describe("Markdown の描画", () => {
  it("会話は「## #番号 連絡先 [状態]」の見出しで始める", () => {
    const lines = renderConversationItem({ id: 42, status: "open", contact: { id: 12, name: "山田" }, inbox_id: 1, labels: ["a", "b"] });
    expect(lines[0]).toBe("## #42 山田 [open]");
    expect(lines).toContain("- **labels**: a, b");
  });

  it("会話の連絡先に名前がないときはメール・電話・ID の順で代わりに使う", () => {
    expect(renderConversationItem({ id: 1, status: "open", contact: { id: 7, email: "a@example.com" } })[0]).toBe("## #1 a@example.com [open]");
    expect(renderConversationItem({ id: 1, status: "open" })[0]).toBe("## #1 (unknown contact) [open]");
  });

  it("メッセージは社内メモであることを見出しに出す", () => {
    expect(renderMessage({ id: 5, type: "outgoing", private: true, created_at: "t", sender: "Bot", content: "memo" })[0]).toBe(
      "### [5] t Bot (outgoing, private note)",
    );
  });

  it("連絡先は名前と ID の見出しで始める", () => {
    expect(renderContactItem({ id: 12, name: "山田", email: "a@example.com" })).toEqual(["## 山田 (ID: 12)", "- **email**: a@example.com"]);
  });
});
