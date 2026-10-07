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

// Chatwoot の応答をモデル向けに整える純粋関数（自分では HTTP を呼ばない）。
// 上流が想定外の形を返したときの振る舞いは「サーバ:」として、ここで直接確かめる

const tz = new TimeZone(9);
const unix = (iso: string) => Date.parse(iso) / 1000;

describe("messageType", () => {
  describe("正常系", () => {
    it("0〜3 を incoming / outgoing / activity / template にする", () => {
      expect([0, 1, 2, 3].map(messageType)).toEqual(["incoming", "outgoing", "activity", "template"]);
    });
  });

  describe("異常系", () => {
    it("入力: 未知の値は数字のまま返す", () => {
      expect(messageType(9)).toBe("9");
    });

    it("空入力: 値がない（undefined）ときも例外にせず文字列にする", () => {
      expect(messageType(undefined as unknown as number)).toBe("undefined");
    });
  });
});

describe("toConversationSummary", () => {
  describe("正常系", () => {
    it("id は Chatwoot が返す表示番号（#42）をそのまま使い、時刻は設定した時差で表す", () => {
      const summary = toConversationSummary(conversation({ created_at: unix("2026-09-16T07:00:00+09:00") }) as unknown as ChatwootConversation, tz);
      expect(summary.id).toBe(42);
      expect(summary.created_at).toBe("2026-09-16T07:00:00+09:00");
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

    it("custom_attributes の秘匿情報らしいキー（token など）の値を伏せ、ほかの値はそのまま残す", () => {
      const summary = toConversationSummary(conversation({ custom_attributes: { plan: "pro", api_token: "t" } }) as unknown as ChatwootConversation, tz);
      expect(summary.custom_attributes).toEqual({ plan: "pro", api_token: "[redacted]" });
    });

    it("空入力: 空値・0・false の項目（未読 0・ミュートなし・返信待ちなし・ラベルなし）は省く", () => {
      const summary = toConversationSummary(conversation() as unknown as ChatwootConversation, tz);
      for (const key of ["priority", "unread_count", "muted", "waiting_since", "snoozed_until", "labels", "assignee", "team", "last_message", "custom_attributes"]) {
        expect(summary).not.toHaveProperty(key);
      }
    });

    it("空入力: meta が空（送信者・担当者・チームなし）でも例外にせず、連絡先を省く", () => {
      const summary = toConversationSummary(conversation({ meta: {} }) as unknown as ChatwootConversation, tz);
      expect(summary).not.toHaveProperty("contact");
      expect(summary.id).toBe(42);
    });
  });

  describe("異常系", () => {
    it("サーバ: meta のない会話（想定外の形の応答）は TypeError を投げる（呼び出し側の errorResult が拾う）", () => {
      expect(() => toConversationSummary({ id: 1 } as unknown as ChatwootConversation, tz)).toThrow(TypeError);
    });
  });
});

describe("toConversationDetail", () => {
  describe("正常系", () => {
    it("additional_attributes の秘匿情報を伏せ、連絡先は詳細の要約にする", () => {
      const detail = toConversationDetail(
        conversation({ additional_attributes: { browser: "Chrome", auth_token: "t" } }) as unknown as ChatwootConversation,
        tz,
      );
      expect(detail.additional_attributes).toEqual({ browser: "Chrome", auth_token: "[redacted]" });
      expect(detail.uuid).toBe("uuid-42");
      expect(detail.contact).toMatchObject({ id: 12, name: "山田 太郎" });
    });

    it("空入力: additional_attributes が null・送信者なしなら、その項目を省く", () => {
      const detail = toConversationDetail(
        conversation({ additional_attributes: null, meta: { sender: null, channel: null, assignee: null, team: null } }) as unknown as ChatwootConversation,
        tz,
      );
      expect(detail).not.toHaveProperty("additional_attributes");
      expect(detail).not.toHaveProperty("contact");
    });
  });

  describe("異常系", () => {
    it("サーバ: meta のない会話（想定外の形の応答）は TypeError を投げる", () => {
      expect(() => toConversationDetail({ id: 1 } as unknown as ChatwootConversation, tz)).toThrow(TypeError);
    });
  });
});

describe("toMessage", () => {
  describe("正常系", () => {
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

    it("空入力: 本文 null・添付なし（undefined）なら content と attachments を省く", () => {
      const result = toMessage(message({ content: null, attachments: undefined }) as unknown as ChatwootMessage, tz, false);
      expect(result).not.toHaveProperty("content");
      expect(result).not.toHaveProperty("attachments");
    });
  });

  describe("異常系", () => {
    it("入力: 長い本文は include_long_text が false なら省略し、true なら全文を返す", () => {
      const long = "m".repeat(LONG_TEXT_LIMIT + 1);
      expect(toMessage(message({ content: long }) as unknown as ChatwootMessage, tz, false).content).toContain("include_long_text=true");
      expect(toMessage(message({ content: long }) as unknown as ChatwootMessage, tz, true).content).toBe(long);
    });

    it("サーバ: 本文のない応答（null）は TypeError を投げる（呼び出し側の errorResult が拾う）", () => {
      expect(() => toMessage(null as unknown as ChatwootMessage, tz, false)).toThrow(TypeError);
    });
  });
});

describe("toContactSummary / toContactDetail", () => {
  const withInbox = contact({
    additional_attributes: { company_name: "Example Inc.", city: "Tokyo", social_token: "x" },
    contact_inboxes: [{ source_id: "src-1", inbox: { id: 3, name: "Web", channel_type: "Channel::WebWidget" } }],
  }) as unknown as ChatwootContact;

  describe("正常系", () => {
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

    it("要約・詳細とも custom_attributes の秘匿情報らしいキーの値を伏せ、ほかの値はそのまま残す", () => {
      const withSecret = contact({ custom_attributes: { plan: "trial", crm_password: "p", hmac_key: "h" } }) as unknown as ChatwootContact;
      const expected = { plan: "trial", crm_password: "[redacted]", hmac_key: "[redacted]" };
      expect(toContactSummary(withSecret, tz).custom_attributes).toEqual(expected);
      expect(toContactDetail(withSecret, tz).custom_attributes).toEqual(expected);
    });

    it("空入力: additional_attributes・contact_inboxes がない（null・undefined）ときは例外にせず、その項目を省く", () => {
      const bare = contact({ additional_attributes: null, contact_inboxes: undefined }) as unknown as ChatwootContact;
      expect(toContactSummary(bare, tz)).not.toHaveProperty("inboxes");
      const detail = toContactDetail(bare, tz);
      expect(detail).not.toHaveProperty("contact_inboxes");
      expect(detail).not.toHaveProperty("additional_attributes");
    });
  });

  describe("異常系", () => {
    it("入力: 受信箱の情報が欠けた contact_inboxes は要約から除く", () => {
      const partial = contact({ contact_inboxes: [{ source_id: "src-9", inbox: null }] }) as unknown as ChatwootContact;
      expect(toContactSummary(partial, tz)).not.toHaveProperty("inboxes");
      expect(toContactDetail(partial, tz).contact_inboxes).toEqual([{ source_id: "src-9" }]);
    });

    it("入力: custom_attributes の秘匿情報らしいキーの値が空文字・null なら伏せずにそのまま返す（伏せる値が無い）", () => {
      const empty = contact({ custom_attributes: { api_token: "", secret_note: null } }) as unknown as ChatwootContact;
      expect(toContactSummary(empty, tz).custom_attributes).toEqual({ api_token: "", secret_note: null });
    });

    it("サーバ: 連絡先のない応答（undefined）は TypeError を投げる（呼び出し側の errorResult が拾う）", () => {
      expect(() => toContactDetail(undefined as unknown as ChatwootContact, tz)).toThrow(TypeError);
    });
  });
});

describe("Markdown の描画（renderConversationItem / renderMessage / renderContactItem）", () => {
  describe("正常系", () => {
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

    it("空入力: 空オブジェクトでも例外にせず、- や (unknown contact)・(no name) で埋めた見出しを返す", () => {
      expect(renderConversationItem({})).toEqual(["## #- (unknown contact) [-]"]);
      expect(renderMessage({})).toEqual(["### [-] - - ()", "-"]);
      expect(renderContactItem({})).toEqual(["## (no name) (ID: -)"]);
    });
  });
});
