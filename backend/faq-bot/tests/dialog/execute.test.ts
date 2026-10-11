import { describe, expect, it, vi } from "vitest";
import { ChatwootApiError, type ChatwootClient, type CreatedConversation } from "../../src/chatwoot/client.js";
import type { ConversationView } from "../../src/chatwoot/types.js";
import type { Action } from "../../src/dialog/decide.js";
import { execute, executeWelcome } from "../../src/dialog/execute.js";

const ANSWER: Action = {
  decision: "answer",
  reply: { kind: "select", content: "答え", items: [{ title: "解決しました", value: "__resolved" }] },
  addLabels: ["faq-answered"],
  status: null,
  faqIds: ["top-3"],
  topScore: 1,
};
const HANDOFF: Action = { ...ANSWER, decision: "unmatched", reply: { kind: "text", content: "引き継ぎ" }, addLabels: ["faq-unmatched"], status: "open", faqIds: [] };
const TARGET = { conversationId: 12, messageId: 101 };

function fakeClient(view: ConversationView, failOn?: keyof ChatwootClient, created: CreatedConversation = { id: 31, status: "pending" }) {
  const calls: string[] = [];
  const step = (name: keyof ChatwootClient) => async () => {
    calls.push(name);
    if (failOn === name) throw new ChatwootApiError(503, name, "HTTP 503");
  };
  const client = {
    getConversation: vi.fn(async () => {
      await step("getConversation")();
      return view;
    }),
    createConversation: vi.fn(async () => {
      await step("createConversation")();
      return created;
    }),
    sendMessage: vi.fn(step("sendMessage")),
    setLabels: vi.fn(step("setLabels")),
    setStatus: vi.fn(step("setStatus")),
  } satisfies ChatwootClient;
  return { client, calls };
}

const pending = (overrides: Partial<ConversationView> = {}): ConversationView => ({
  status: "pending",
  labels: [],
  lastMessage: { id: 101, messageType: 0, senderType: "contact", inReplyTo: null },
  ...overrides,
});

describe("execute", () => {
  describe("正常系", () => {
    it("まだ答えていなければ、送ってからラベルを足す", async () => {
      const { client, calls } = fakeClient(pending());
      expect(await execute(client, TARGET, ANSWER)).toEqual({ outcome: "done", sent: true });
      expect(calls).toEqual(["getConversation", "sendMessage", "setLabels"]);
      expect(client.sendMessage).toHaveBeenCalledWith(12, ANSWER.reply, 101);
      expect(client.setLabels).toHaveBeenCalledWith(12, ["faq-answered"]);
    });

    it("引き継ぎは、送る → ラベル → ステータスの順", async () => {
      const { client, calls } = fakeClient(pending());
      await execute(client, TARGET, HANDOFF);
      expect(calls).toEqual(["getConversation", "sendMessage", "setLabels", "setStatus"]);
      expect(client.setStatus).toHaveBeenCalledWith(12, "open");
    });

    it("今のラベルを残して足す", async () => {
      const { client } = fakeClient(pending({ labels: ["vip"] }));
      await execute(client, TARGET, ANSWER);
      expect(client.setLabels).toHaveBeenCalledWith(12, ["vip", "faq-answered"]);
    });

    it("ラベルが既にあれば付け替えない", async () => {
      const { client } = fakeClient(pending({ labels: ["faq-answered"] }));
      await execute(client, TARGET, ANSWER);
      expect(client.setLabels).not.toHaveBeenCalled();
    });

    it("ボットが対象より新しい返事を出していれば、送らずにラベルとステータスだけやり直す（送り直し）", async () => {
      const { client, calls } = fakeClient(pending({ lastMessage: { id: 150, messageType: 1, senderType: "agent_bot", inReplyTo: 101 } }));
      expect(await execute(client, TARGET, HANDOFF)).toEqual({ outcome: "done", sent: false });
      expect(calls).toEqual(["getConversation", "setLabels", "setStatus"]);
    });

    it("Chatwoot が自動で足したテンプレート（連絡先の入力欄。message_type 3）が対象より新しくても、まだ答えていないとみなして送る", async () => {
      // ウィジェットの最初の発言の直後に、受信箱の設定で「ご連絡先をご入力ください」の input_email が template として入る（開発の結合テストで確認）
      const { client, calls } = fakeClient(pending({ lastMessage: { id: 103, messageType: 3, senderType: null, inReplyTo: null } }));
      expect(await execute(client, TARGET, ANSWER)).toEqual({ outcome: "done", sent: true });
      expect(calls).toEqual(["getConversation", "sendMessage", "setLabels"]);
    });

    it("pending でなければ何もしない（人の担当）", async () => {
      const { client, calls } = fakeClient(pending({ status: "open" }));
      expect(await execute(client, TARGET, ANSWER)).toEqual({ outcome: "not-pending", sent: false });
      expect(calls).toEqual(["getConversation"]);
    });

    it("訪問者がその後に発言していれば、古いイベントとして何もしない（古い選択肢を後から押した場合も）", async () => {
      const { client, calls } = fakeClient(pending({ lastMessage: { id: 210, messageType: 0, senderType: "contact", inReplyTo: null } }));
      expect(await execute(client, { conversationId: 12, messageId: 205 }, ANSWER)).toEqual({ outcome: "stale", sent: false });
      expect(calls).toEqual(["getConversation"]);
    });

    it("ボットがもっと後の発言に返事をした後で古い選択肢を押しても、何もしない（解決・引き継ぎを黙って実行しない）", async () => {
      // 質問 9 → 回答 10（選択肢つき）→ 質問 11 → 候補 12（in_reply_to 11）→ 訪問者が 10 の［解決しました］を押す
      const { client, calls } = fakeClient(pending({ lastMessage: { id: 12, messageType: 1, senderType: "agent_bot", inReplyTo: 11 } }));
      expect(await execute(client, { conversationId: 12, messageId: 10 }, { ...ANSWER, status: "resolved" })).toEqual({ outcome: "stale", sent: false });
      expect(calls).toEqual(["getConversation"]);
    });

    it("続けて送られた 2 つの質問: 前の質問への返事が後の質問より新しくても、後の質問に答える", async () => {
      // 質問 9 → 質問 11 → 9 への返事 12（in_reply_to 9）→ 11 のイベント
      const { client, calls } = fakeClient(pending({ lastMessage: { id: 12, messageType: 1, senderType: "agent_bot", inReplyTo: 9 } }));
      expect(await execute(client, { conversationId: 12, messageId: 11 }, ANSWER)).toEqual({ outcome: "done", sent: true });
      expect(calls).toEqual(["getConversation", "sendMessage", "setLabels"]);
    });

    it("in_reply_to の無いボットのメッセージが最新なら、古いイベントとして何もしない", async () => {
      const { client } = fakeClient(pending({ lastMessage: { id: 150, messageType: 1, senderType: "agent_bot", inReplyTo: null } }));
      expect(await execute(client, TARGET, ANSWER)).toEqual({ outcome: "stale", sent: false });
    });

    it("空入力: 会話にメッセージが無ければ、古いイベントとして何もしない", async () => {
      const { client } = fakeClient(pending({ lastMessage: null }));
      expect(await execute(client, TARGET, ANSWER)).toEqual({ outcome: "stale", sent: false });
    });
  });

  describe("異常系", () => {
    it("サーバ: 会話を読めなければ例外（何も送らない）", async () => {
      const { client } = fakeClient(pending(), "getConversation");
      await expect(execute(client, TARGET, ANSWER)).rejects.toBeInstanceOf(ChatwootApiError);
      expect(client.sendMessage).not.toHaveBeenCalled();
    });

    it("サーバ: 送信に失敗したら例外（ラベルを足さない）", async () => {
      const { client } = fakeClient(pending(), "sendMessage");
      await expect(execute(client, TARGET, ANSWER)).rejects.toBeInstanceOf(ChatwootApiError);
      expect(client.setLabels).not.toHaveBeenCalled();
    });

    it("サーバ: 送った後のラベルの失敗も例外（送り直しで送信を飛ばしてやり直す）", async () => {
      const { client } = fakeClient(pending(), "setLabels");
      await expect(execute(client, TARGET, HANDOFF)).rejects.toBeInstanceOf(ChatwootApiError);
      expect(client.setStatus).not.toHaveBeenCalled();
    });
  });
});

const WELCOME = { kind: "select" as const, content: "よくあるご質問です。", items: [{ title: "料金は税込ですか？", value: "top-3" }] };
const OPENED = { sourceId: "3f1c2b9e-0000-4000-8000-000000000000", inboxId: 3 };

describe("executeWelcome", () => {
  describe("正常系", () => {
    it("会話を作ってから、in_reply_to なしで一覧を 1 通送る", async () => {
      const { client, calls } = fakeClient(pending());
      expect(await executeWelcome(client, OPENED, WELCOME)).toEqual({ outcome: "sent", conversationId: 31 });
      expect(calls).toEqual(["createConversation", "sendMessage"]);
      expect(client.createConversation).toHaveBeenCalledWith(OPENED.sourceId, 3);
      expect(client.sendMessage).toHaveBeenCalledWith(31, WELCOME, null);
    });

    it("作った会話が pending でなければ送らない（受信箱が lock_to_single_conversation で、解決済みの会話が返った場合）", async () => {
      const { client, calls } = fakeClient(pending(), undefined, { id: 40, status: "resolved" });
      expect(await executeWelcome(client, OPENED, WELCOME)).toEqual({ outcome: "not-pending", conversationId: 40 });
      expect(calls).toEqual(["createConversation"]);
    });
  });

  describe("異常系", () => {
    it("サーバ: 会話を作れなければ例外（送らない）", async () => {
      const { client, calls } = fakeClient(pending(), "createConversation");
      await expect(executeWelcome(client, OPENED, WELCOME)).rejects.toBeInstanceOf(ChatwootApiError);
      expect(calls).toEqual(["createConversation"]);
    });

    it("サーバ: 送信に失敗したら例外（空の pending の会話が残る。仕様 5 節）", async () => {
      const { client, calls } = fakeClient(pending(), "sendMessage");
      await expect(executeWelcome(client, OPENED, WELCOME)).rejects.toBeInstanceOf(ChatwootApiError);
      expect(calls).toEqual(["createConversation", "sendMessage"]);
    });
  });
});
