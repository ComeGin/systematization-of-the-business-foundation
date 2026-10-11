import { describe, expect, it } from "vitest";
import { InvalidEventError, parseEvent } from "../../src/chatwoot/events.js";
import { questionPayload, selectionPayload, welcomePayload } from "../helpers/chatwoot.js";

describe("parseEvent", () => {
  describe("正常系", () => {
    it("訪問者の発言は question", () => {
      expect(parseEvent(questionPayload())).toEqual({ kind: "question", accountId: 1, conversationId: 12, messageId: 101, text: "料金は税込ですか？" });
    });

    it("ボットの選択肢が選ばれたら selection", () => {
      expect(parseEvent(selectionPayload("top-3"))).toEqual({ kind: "selection", accountId: 1, conversationId: 12, messageId: 205, value: "top-3" });
    });

    it("1000 文字を超える質問は切り詰める", () => {
      const event = parseEvent(questionPayload({ content: "あ".repeat(5_000) }));
      expect(event.kind === "question" && Array.from(event.text).length).toBe(1_000);
    });

    it("扱わないイベントは ignore", () => {
      expect(parseEvent({ event: "conversation_status_changed", id: 12 })).toMatchObject({ kind: "ignore" });
    });

    it("ボット自身の発言（outgoing）の message_created は ignore", () => {
      expect(parseEvent(questionPayload({ message_type: "outgoing", sender: { type: "agent_bot" } }))).toMatchObject({ kind: "ignore" });
    });

    it("社内メモは ignore", () => {
      expect(parseEvent(questionPayload({ private: true }))).toMatchObject({ kind: "ignore" });
    });

    it("選択の無い message_updated は ignore", () => {
      expect(parseEvent(selectionPayload("x", { content_attributes: { items: [] } }))).toMatchObject({ kind: "ignore" });
    });

    it("担当者（user）の input_select の更新は ignore", () => {
      expect(parseEvent(selectionPayload("top-3", { sender: { type: "user" } }))).toMatchObject({ kind: "ignore" });
    });

    it("空入力: 本文の無い発言（添付だけ・空白だけ）は空の質問にする（判定で担当者に引き継がれ、pending のまま放置されない）", () => {
      expect(parseEvent(questionPayload({ content: "   " }))).toMatchObject({ kind: "question", text: "" });
      expect(parseEvent(questionPayload({ content: null, attachments: [{ file_type: "image" }] }))).toMatchObject({ kind: "question", text: "" });
    });

    it("会話の無い訪問者がウィジェットを開いたら welcome（currentStatus は null）", () => {
      expect(parseEvent(welcomePayload())).toEqual({
        kind: "welcome",
        accountId: 1,
        inboxId: 3,
        sourceId: "3f1c2b9e-0000-4000-8000-000000000000",
        currentStatus: null,
      });
    });

    it("直前の会話があれば、そのステータスを currentStatus に入れる", () => {
      expect(parseEvent(welcomePayload({ current_conversation: { id: 40, status: "resolved" } }))).toMatchObject({ kind: "welcome", currentStatus: "resolved" });
      expect(parseEvent(welcomePayload({ current_conversation: { id: 41, status: "pending" } }))).toMatchObject({ kind: "welcome", currentStatus: "pending" });
    });
  });

  describe("異常系", () => {
    it("空入力: 空のオブジェクトは InvalidEventError", () => {
      expect(() => parseEvent({})).toThrow(InvalidEventError);
      expect(() => parseEvent(null)).toThrow(InvalidEventError);
    });

    it("入力: message_created に conversation が無ければ InvalidEventError", () => {
      const { conversation: _omit, ...rest } = questionPayload();
      expect(() => parseEvent(rest)).toThrow(InvalidEventError);
    });

    it("入力: id が数値でなければ InvalidEventError", () => {
      expect(() => parseEvent(questionPayload({ id: "101" }))).toThrow(InvalidEventError);
    });

    it("空入力: source_id が空の webwidget_triggered は InvalidEventError", () => {
      expect(() => parseEvent(welcomePayload({ source_id: "" }))).toThrow(InvalidEventError);
    });

    it("入力: inbox か account の無い webwidget_triggered は InvalidEventError", () => {
      const { inbox: _inbox, ...noInbox } = welcomePayload();
      const { account: _account, ...noAccount } = welcomePayload();
      expect(() => parseEvent(noInbox)).toThrow(InvalidEventError);
      expect(() => parseEvent(noAccount)).toThrow(InvalidEventError);
    });

    it("入力: 知らないステータスの current_conversation は InvalidEventError", () => {
      expect(() => parseEvent(welcomePayload({ current_conversation: { id: 40, status: "bot" } }))).toThrow(InvalidEventError);
    });
  });
});
