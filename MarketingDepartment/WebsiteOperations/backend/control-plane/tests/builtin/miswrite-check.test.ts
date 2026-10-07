import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { miswriteCheck } from "../../src/builtin/miswrite-check.js";
import type { BuiltinInput } from "../../src/context.js";
import type { ChatwootMessage } from "../../src/integrations/chatwoot.js";
import { IntegrationError } from "../../src/integrations/http.js";
import { toIsoJst } from "../../src/time.js";
import { makeConfig, makeCtx, proposalText, tempDir, writeAt } from "../helpers/runner.js";

const cw = vi.hoisted(() => ({
  pages: [] as { displayId: number; lastActivityMs: number | null }[][],
  messages: new Map<number, ChatwootMessage[]>(),
  conversationsPage: vi.fn(),
  messagesCall: vi.fn(),
}));
vi.mock("../../src/integrations/chatwoot.js", () => ({
  ChatwootReader: class {
    async conversationsPage(page: number) {
      cw.conversationsPage(page);
      return cw.pages[page - 1] ?? [];
    }
    // Chatwoot の MessageFinder と同じ: id が before より小さいもの（無ければ全部）の新しい方から 20 件を、古い順に並べて返す
    async messages(displayId: number, before?: number) {
      cw.messagesCall(displayId, before);
      const all = cw.messages.get(displayId) ?? [];
      return all
        .filter((m) => before === undefined || m.id < before)
        .slice(0, 20)
        .reverse();
    }
  },
}));

const NOW = Date.parse("2026-10-05T12:00:00+09:00");
const MIN = 60_000;
const AGENT_USER = 9;
const RUN_ID = "01K6PZ3T8Q4M2N7R9S5V1W3X6Y";
const miswrite = { baseUrl: "https://chat.example.test", accountId: 1, apiToken: "t", agentUserId: AGENT_USER };

let root: string;
let cleanup: () => void;
let ctx: ReturnType<typeof makeCtx>;

/** 新しい順に並べる（上流の既定）。 */
function conversation(displayId: number, messages: ChatwootMessage[], lastActivityMs = NOW - MIN) {
  cw.messages.set(displayId, [...messages].sort((a, b) => b.id - a.id));
  return { displayId, lastActivityMs };
}

const agentMessage = (id: number, createdAtMs: number, overrides: Partial<ChatwootMessage> = {}): ChatwootMessage => ({
  id,
  createdAtMs,
  messageType: 1,
  senderType: "user",
  senderId: AGENT_USER,
  ...overrides,
});

let runSeq = 0;
function agentRun(startMs: number, finishMs: number | null, targetIds: string[], agentName: string | null = "conversation-triage") {
  const runId = `01K6PZ3T8Q4M2N7R9S5V1W3X${String.fromCharCode(65 + runSeq++)}0`.slice(0, 26);
  ctx.runs.insertRunning({ runId, jobId: null, agentName, builtin: null, trigger: "schedule", startedAt: toIsoJst(new Date(startMs)) });
  if (finishMs !== null) {
    ctx.runs.finish(runId, {
      finishedAt: toIsoJst(new Date(finishMs)),
      outcome: "success",
      summary: "s",
      summaryRedacted: false,
      targetIds,
      skipReason: null,
      failureClass: null,
      sdkSubtype: null,
      costUsd: null,
    });
  }
  return runId;
}

const input = (overrides: Partial<BuiltinInput> = {}): BuiltinInput => ({
  ctx,
  runId: RUN_ID,
  signal: new AbortController().signal,
  timeoutSec: 60,
  job: null,
  ...overrides,
});

const PROPOSALS = "MarketingDepartment/WebsiteOperations/docs/proposals";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  ({ dir: root, cleanup } = tempDir("cp-miswrite-"));
  ctx = makeCtx(makeConfig({ mainCheckout: join(root, "main"), worktree: join(root, "wt"), miswrite }));
  cw.pages = [];
  cw.messages = new Map();
  runSeq = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("miswriteCheck の候補の判定", () => {
  describe("正常系", () => {
    it("空入力: 会話が 0 件なら候補なしの success で、前回完了の時刻を進める", async () => {
      const result = await miswriteCheck(input());
      expect(result).toEqual({
        outcome: "success",
        summary: "突き合わせ: 走査した会話 0 件、エージェントの送信 0 件、候補 0 件（新規 0 件）",
        targetIds: [],
        failureClass: null,
      });
      expect(cw.messagesCall).not.toHaveBeenCalled();
      expect(ctx.kv.get("miswrite.cursor")).toBe(new Date(NOW).toISOString());
    });

    it("空入力: 会話はあるがメッセージが 0 件なら、次のページを読まずに候補なし", async () => {
      cw.pages = [[conversation(12, [])]];
      const result = await miswriteCheck(input());
      expect(cw.messagesCall.mock.calls).toEqual([[12, undefined]]);
      expect(ctx.miswrite.list()).toEqual([]);
      expect(result.summary).toBe("突き合わせ: 走査した会話 1 件、エージェントの送信 0 件、候補 0 件（新規 0 件）");
    });

    it("どの提案にも run にも対応しないエージェントの送信を候補にし、ID・時刻・理由だけを残す", async () => {
      cw.pages = [[conversation(12, [agentMessage(500, NOW - 10 * MIN)])]];
      const result = await miswriteCheck(input());
      expect(ctx.miswrite.list()).toEqual([
        {
          conversationDisplayId: 12,
          messageId: 500,
          sentAt: toIsoJst(new Date(NOW - 10 * MIN)),
          nearestRunId: null,
          reason: "no matching proposal or run",
        },
      ]);
      expect(result).toEqual({
        outcome: "success",
        summary: "突き合わせ: 走査した会話 1 件、エージェントの送信 1 件、候補 1 件（新規 1 件）",
        targetIds: ["chatwoot-conversation:12"],
        failureClass: null,
      });
    });

    it("エージェント専用ユーザーの送信（message_type=1・sender.type=user・id 一致）だけを見る", async () => {
      cw.pages = [
        [
          conversation(12, [
            agentMessage(501, NOW - MIN, { messageType: 0 }),
            agentMessage(502, NOW - MIN, { messageType: 2 }),
            agentMessage(503, NOW - MIN, { senderId: 10 }),
            agentMessage(504, NOW - MIN, { senderType: "agent_bot" }),
            agentMessage(505, NOW - MIN, { senderType: null, senderId: null }),
          ]),
        ],
      ];
      const result = await miswriteCheck(input());
      expect(ctx.miswrite.list()).toEqual([]);
      expect(result.summary).toContain("エージェントの送信 0 件");
    });

    it("(a) main の承認済み提案が display_id を対象にし、送信が created_at 以降なら対応あり", async () => {
      writeAt(
        root,
        `main/${PROPOSALS}/PRP-2026-0001.md`,
        proposalText({ state: "approved", identifier: "display_id=12", createdAt: toIsoJst(new Date(NOW - 60 * MIN)) }),
      );
      writeAt(
        root,
        `main/${PROPOSALS}/PRP-2026-0002.md`,
        proposalText({ id: "PRP-2026-0002", state: "applied", alsoAffects: ["E-10 display_id: 13"], createdAt: toIsoJst(new Date(NOW - 60 * MIN)) }),
      );
      cw.pages = [[conversation(12, [agentMessage(500, NOW - 10 * MIN)]), conversation(13, [agentMessage(600, NOW - 10 * MIN)])]];
      await miswriteCheck(input());
      expect(ctx.miswrite.list()).toEqual([]);
    });

    it("(a) 送信が提案の created_at より前なら対応なし", async () => {
      writeAt(
        root,
        `main/${PROPOSALS}/PRP-2026-0001.md`,
        proposalText({ state: "approved", identifier: "display_id=12", createdAt: toIsoJst(new Date(NOW - 5 * MIN)) }),
      );
      cw.pages = [[conversation(12, [agentMessage(500, NOW - 10 * MIN)])]];
      await miswriteCheck(input());
      expect(ctx.miswrite.list().map((c) => c.messageId)).toEqual([500]);
    });

    it.each(["draft", "review", "rejected", "rolled_back"])("(a) approval.state=%s の提案は対応として数えない", async (state) => {
      writeAt(root, `main/${PROPOSALS}/PRP-2026-0001.md`, proposalText({ state, identifier: "display_id=12", createdAt: "2026-10-01T00:00:00+09:00" }));
      cw.pages = [[conversation(12, [agentMessage(500, NOW - 10 * MIN)])]];
      await miswriteCheck(input());
      expect(ctx.miswrite.list()).toHaveLength(1);
    });

    it("(b) 送信時刻に重なる run の targetIds に chatwoot-conversation:<n> があれば対応あり", async () => {
      agentRun(NOW - 20 * MIN, NOW - 5 * MIN, ["chatwoot-conversation:12"]);
      cw.pages = [[conversation(12, [agentMessage(500, NOW - 10 * MIN)])]];
      await miswriteCheck(input());
      expect(ctx.miswrite.list()).toEqual([]);
    });

    it("(b) 重なりの幅は前後 1 分（境界ちょうどは対応あり、それを超えたら対応なし）", async () => {
      agentRun(NOW - 30 * MIN, NOW - 20 * MIN, ["chatwoot-conversation:12"]);
      cw.pages = [
        [
          conversation(12, [
            agentMessage(500, NOW - 31 * MIN), // 開始の 1 分前ちょうど
            agentMessage(501, NOW - 19 * MIN), // 終了の 1 分後ちょうど
            agentMessage(502, NOW - 31 * MIN - 1),
            agentMessage(503, NOW - 19 * MIN + 1),
          ]),
        ],
      ];
      await miswriteCheck(input());
      expect(ctx.miswrite.list().map((c) => c.messageId).sort()).toEqual([502, 503]);
    });

    it("(b) 実行中の run は今までを範囲とみなす", async () => {
      agentRun(NOW - 20 * MIN, null, []);
      // 実行中は targetIds が空なので対応にはならないが、nearestRunId には入る
      cw.pages = [[conversation(12, [agentMessage(500, NOW - 10 * MIN)])]];
      await miswriteCheck(input());
      expect(ctx.miswrite.list()[0]!.nearestRunId).not.toBeNull();
    });

    it("(b) 別の会話を対象にした run は対応にならず、nearestRunId にその run を入れる", async () => {
      const other = agentRun(NOW - 20 * MIN, NOW - 5 * MIN, ["chatwoot-conversation:99"]);
      cw.pages = [[conversation(12, [agentMessage(500, NOW - 10 * MIN)])]];
      await miswriteCheck(input());
      expect(ctx.miswrite.list()).toEqual([expect.objectContaining({ messageId: 500, nearestRunId: other })]);
    });

    it("(b) builtin の run（agentName が null）は照合に使わない", async () => {
      agentRun(NOW - 20 * MIN, NOW - 5 * MIN, ["chatwoot-conversation:12"], null);
      cw.pages = [[conversation(12, [agentMessage(500, NOW - 10 * MIN)])]];
      await miswriteCheck(input());
      expect(ctx.miswrite.list()).toEqual([expect.objectContaining({ messageId: 500, nearestRunId: null })]);
    });

    it("重なりの 5 分で再び読んだ同じ message_id は 1 件だけ（新規 0 件）", async () => {
      cw.pages = [[conversation(12, [agentMessage(500, NOW - 2 * MIN)])]];
      await miswriteCheck(input());
      const second = await miswriteCheck(input());
      expect(ctx.miswrite.list()).toHaveLength(1);
      expect(second.summary).toContain("候補 1 件（新規 0 件）");
      expect(second.targetIds).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("空入力: 突き合わせの設定が無ければ例外", async () => {
      ctx.config.miswrite = null;
      await expect(miswriteCheck(input())).rejects.toThrow("突き合わせの設定が無い");
      expect(cw.conversationsPage).not.toHaveBeenCalled();
    });

    it("入力: (a) 作業ツリーにだけある承認済みの提案では対応ありにしない（main から読む）", async () => {
      writeAt(root, `wt/${PROPOSALS}/PRP-2026-0001.md`, proposalText({ state: "approved", identifier: "display_id=12", createdAt: "2026-10-01T00:00:00+09:00" }));
      cw.pages = [[conversation(12, [agentMessage(500, NOW - 10 * MIN)])]];
      await miswriteCheck(input());
      expect(ctx.miswrite.list()).toHaveLength(1);
    });

    it("入力: (a) frontmatter が不正・空の提案ファイルは照合に使わず、例外にもしない", async () => {
      writeAt(root, `main/${PROPOSALS}/PRP-2026-0001.md`, "---\nproposal_id: PRP-2026-0001\n---\ndisplay_id=12\n");
      writeAt(root, `main/${PROPOSALS}/PRP-2026-0002.md`, "");
      cw.pages = [[conversation(12, [agentMessage(500, NOW - 10 * MIN)])]];
      const result = await miswriteCheck(input());
      expect(result.outcome).toBe("success");
      expect(ctx.miswrite.list().map((c) => c.messageId)).toEqual([500]);
    });
  });
});

describe("miswriteCheck の範囲と打ち切り", () => {
  describe("正常系", () => {
    it("初回は 24 時間 + 重なり 5 分前から、完了したら前回完了の時刻を進める", async () => {
      cw.pages = [
        [
          conversation(12, [
            agentMessage(500, NOW - 24 * 60 * MIN - 5 * MIN + 1),
            agentMessage(501, NOW - 24 * 60 * MIN - 5 * MIN - 1),
          ]),
        ],
      ];
      await miswriteCheck(input());
      expect(ctx.miswrite.list().map((c) => c.messageId)).toEqual([500]);
      expect(ctx.kv.get("miswrite.cursor")).toBe(new Date(NOW).toISOString());
    });

    it("2 回目以降は前回完了の 5 分前から読む", async () => {
      ctx.kv.set("miswrite.cursor", new Date(NOW - 60 * MIN).toISOString());
      cw.pages = [[conversation(12, [agentMessage(500, NOW - 64 * MIN), agentMessage(501, NOW - 66 * MIN)])]];
      await miswriteCheck(input());
      expect(ctx.miswrite.list().map((c) => c.messageId)).toEqual([500]);
    });

    it("最終更新が範囲より古い会話は読まず、そのページに新しい会話が無ければ次のページに進まない", async () => {
      ctx.kv.set("miswrite.cursor", new Date(NOW - 60 * MIN).toISOString());
      cw.pages = [
        [conversation(12, [agentMessage(500, NOW - 10 * MIN)]), conversation(13, [], NOW - 120 * MIN)],
        [conversation(14, [], NOW - 120 * MIN)],
        [conversation(15, [agentMessage(700, NOW - MIN)])],
      ];
      await miswriteCheck(input());
      expect(cw.conversationsPage.mock.calls.map((c) => c[0])).toEqual([1, 2]);
      expect(cw.messagesCall.mock.calls.map((c) => c[0])).toEqual([12]);
    });

    it("メッセージが 20 件ちょうどなら before で古い方を読み、20 件未満のページで止める", async () => {
      const messages = Array.from({ length: 25 }, (_, i) => agentMessage(1000 + i, NOW - (30 - i) * MIN, { messageType: 0 }));
      cw.pages = [[conversation(12, messages)]];
      await miswriteCheck(input());
      expect(cw.messagesCall.mock.calls).toEqual([
        [12, undefined],
        [12, 1005],
      ]);
    });

    // 回帰: 上流は 1 ページを古い順で返す。末尾（最新）を before にしていたため、1 つの会話でエージェントが 21 件以上送ると
    // 同じページを読み直し続けて 10 ページで打ち切られ、partial（truncated）になって前回完了の時刻も進まなかった
    it("エージェントが 31 件送った会話は、最も古い id を before にして 2 ページで読み切り、success にして前回完了の時刻を進める", async () => {
      const messages = Array.from({ length: 31 }, (_, i) => agentMessage(2000 + i, NOW - (40 - i) * MIN));
      cw.pages = [[conversation(12, messages)]];
      const result = await miswriteCheck(input());
      expect(cw.messagesCall.mock.calls).toEqual([
        [12, undefined],
        [12, 2011],
      ]);
      expect(result).toMatchObject({ outcome: "success", failureClass: null });
      expect(result.summary).toContain("エージェントの送信 31 件、候補 31 件（新規 31 件）");
      expect(ctx.miswrite.list().map((c) => c.messageId).sort()).toEqual(messages.map((m) => m.id));
      expect(ctx.kv.get("miswrite.cursor")).toBe(new Date(NOW).toISOString());
    });

    it("ページの最も古いメッセージが範囲より古ければ、次のページを読まない", async () => {
      ctx.kv.set("miswrite.cursor", new Date(NOW - 60 * MIN).toISOString());
      const messages = Array.from({ length: 40 }, (_, i) => agentMessage(1000 + i, NOW - (40 - i) * 4 * MIN, { messageType: 0 }));
      cw.pages = [[conversation(12, messages)]];
      await miswriteCheck(input());
      expect(cw.messagesCall).toHaveBeenCalledTimes(1);
    });
  });

  describe("異常系", () => {
    it("サーバ: メッセージが 10 ページ分あれば打ち切って partial（truncated）にし、前回完了の時刻を進めない", async () => {
      const messages = Array.from({ length: 220 }, (_, i) => agentMessage(1000 + i, NOW - (300 - i) * 1000, { messageType: 0 }));
      cw.pages = [[conversation(12, messages)]];
      const result = await miswriteCheck(input());
      expect(cw.messagesCall).toHaveBeenCalledTimes(10);
      expect(result).toMatchObject({ outcome: "partial", failureClass: "truncated" });
      expect(result.summary).toContain("走査の上限に達した");
      expect(ctx.kv.get("miswrite.cursor")).toBeNull();
    });

    it("サーバ: 会話が 40 ページ分あれば打ち切って partial（truncated）にする", async () => {
      cw.pages = Array.from({ length: 41 }, (_, i) => [conversation(100 + i, [])]);
      const result = await miswriteCheck(input());
      expect(cw.conversationsPage).toHaveBeenCalledTimes(40);
      expect(result).toMatchObject({ outcome: "partial", failureClass: "truncated" });
      expect(ctx.kv.get("miswrite.cursor")).toBeNull();
    });

    it("サーバ: Chatwoot の失敗は、その分類の failure にし、前回完了の時刻を進めない", async () => {
      cw.pages = [[conversation(12, [])]];
      cw.conversationsPage.mockImplementationOnce(() => {
        throw new IntegrationError("permission_denied", "Chatwoot の読み取り: permission_denied (HTTP 401)");
      });
      const result = await miswriteCheck(input());
      expect(result).toEqual({
        outcome: "failure",
        summary: "誤った書き込みの突き合わせに失敗した（permission_denied）",
        targetIds: [],
        failureClass: "permission_denied",
      });
      expect(ctx.kv.get("miswrite.cursor")).toBeNull();
    });

    it.each(["rate_limited", "timeout", "unreachable", "invalid_response"] as const)(
      "サーバ: メッセージの取得が %s なら、その分類の failure にし、候補を記録せず前回完了の時刻を進めない",
      async (failureClass) => {
        cw.pages = [[conversation(12, [agentMessage(500, NOW - MIN)]), conversation(13, [agentMessage(600, NOW - MIN)])]];
        cw.messagesCall.mockImplementationOnce(() => undefined).mockImplementationOnce(() => {
          throw new IntegrationError(failureClass, `Chatwoot の読み取り: ${failureClass}`);
        });
        const result = await miswriteCheck(input());
        expect(result).toEqual({
          outcome: "failure",
          summary: `誤った書き込みの突き合わせに失敗した（${failureClass}）`,
          targetIds: [],
          failureClass,
        });
        expect(ctx.miswrite.list()).toEqual([]);
        expect(ctx.kv.get("miswrite.cursor")).toBeNull();
      },
    );

    it("サーバ: 失敗の要約とログに Chatwoot のトークンを出さない", async () => {
      ctx.config.miswrite = { ...miswrite, apiToken: "cw_secret_token_value" };
      cw.conversationsPage.mockImplementationOnce(() => {
        throw new IntegrationError("auth_failed", "Chatwoot の読み取り: auth_failed (HTTP 401)");
      });
      const result = await miswriteCheck(input());
      const logged = vi.mocked(console.error).mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("auth_failed");
      expect(result.summary).not.toContain("cw_secret_token_value");
      expect(logged).not.toContain("cw_secret_token_value");
    });

    it("サーバ: IntegrationError でない例外はそのまま投げる", async () => {
      cw.conversationsPage.mockImplementationOnce(() => {
        throw new TypeError("bug");
      });
      await expect(miswriteCheck(input())).rejects.toThrow("bug");
    });

    it("入力: 打ち切られていれば読まず、前回完了の時刻も進めない", async () => {
      cw.pages = [[conversation(12, [agentMessage(500, NOW - MIN)])]];
      const stop = new AbortController();
      stop.abort();
      await miswriteCheck(input({ signal: stop.signal }));
      expect(cw.conversationsPage).not.toHaveBeenCalled();
      expect(ctx.kv.get("miswrite.cursor")).toBeNull();
    });
  });
});
