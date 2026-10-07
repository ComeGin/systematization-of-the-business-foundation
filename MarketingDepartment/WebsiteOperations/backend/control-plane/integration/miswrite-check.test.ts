// 結合テスト: 誤った書き込みの突き合わせ（miswrite-check）。開発の Chatwoot（127.0.0.1:3100）の実データを読む。
// テストの中で it- のコンタクトと会話を作り、エージェント専用ユーザーのトークン（CHATWOOT_AGENT_TOKEN）で社内メモを送って、
// main の承認済み E-13 と E-15 の run（Agent SDK は差し替え。TARGET_IDS で会話を指す）との突き合わせを確かめる。
// 作った会話とコンタクトは管理者の API で消す（afterAll）。他の担当のテストの会話も同じ Chatwoot にあるため、検証は自分の会話の display_id で絞る。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MiswriteCandidate } from "../src/contract.js";
import { deferred } from "../tests/helpers/runner.js";
import { resetAws } from "./helpers/aws-mock.js";
import { init, resetSdk, result, script, sdk } from "./helpers/agent-sdk.js";
import {
  CLOSED_PORT_URL,
  Cleanup,
  createItConversation,
  deleteChatwootContact,
  deleteChatwootConversation,
  miswriteEnv,
  requireValue,
  sendAgentNote,
} from "./helpers/dev-stack.js";
import {
  CHATWOOT_REGISTRY,
  DUMMY_ANTHROPIC_KEY,
  type Fixture,
  Planes,
  captureLogs,
  createFixture,
  e15Bytes,
  waitFinished,
  writeAgent,
  writeProposal,
  writeRegistry,
  writeSchedule,
} from "./helpers/fixtures.js";

vi.mock("@aws-sdk/client-s3", () => import("./helpers/aws-mock.js").then((m) => m.s3Module));
vi.mock("@aws-sdk/client-cloudwatch", () => import("./helpers/aws-mock.js").then((m) => m.cloudWatchModule));
vi.mock("@anthropic-ai/claude-agent-sdk", () => import("./helpers/agent-sdk.js").then((m) => m.sdkModule));

/** 社内メモの本文にだけ現れる値。E-15・候補・ログのどこにも残ってはいけない */
const NOTE_MARKER = "IT-MISWRITE-NOTE-BODY-5c1e";
const cleanup = new Cleanup();

let fx: Fixture;
let planes: Planes;
let logs: () => string;
/** beforeAll で作る会話（どの提案にも run にも対応しない社内メモが 1 件ある） */
let base: { displayId: number; messageId: number };

async function itConversation(label: string): Promise<number> {
  const { contactId, displayId } = await createItConversation(label);
  cleanup.add(`Chatwoot のコンタクト ${contactId}`, () => deleteChatwootContact(contactId));
  cleanup.add(`Chatwoot の会話 ${displayId}`, () => deleteChatwootConversation(displayId));
  return displayId;
}

beforeAll(async () => {
  const displayId = await itConversation("miswrite-base");
  base = { displayId, messageId: await sendAgentNote(displayId, `${NOTE_MARKER} 対応の無い社内メモ`) };
});

afterAll(async () => {
  await cleanup.runAll();
});

beforeEach(() => {
  fx = createFixture("cp-it-miswrite-");
  planes = new Planes();
  logs = captureLogs();
  resetAws();
  resetSdk();
  writeSchedule(fx, "it-miswrite-check", 'enabled: false\ncron: "15 7 * * *"\nkind: builtin\nbuiltin: miswrite-check\n');
  writeAgent(fx, "conversation-triage", ["Read", "mcp__chatwoot__chatwoot_add_private_note"]);
  writeRegistry(fx, CHATWOOT_REGISTRY);
});

afterEach(async () => {
  await planes.stopAll();
  fx.cleanup();
});

const env = (extra: Record<string, string> = {}) => fx.env({ ...miswriteEnv(), ANTHROPIC_API_KEY: DUMMY_ANTHROPIC_KEY, ...extra });

async function runCheck(plane = planes.create(env()), timeoutMs?: number) {
  const { runId } = await plane.runNow({ target: { kind: "job", jobId: "it-miswrite-check" } });
  return { plane, run: await waitFinished(plane, runId, timeoutMs) };
}

const candidatesOf = (candidates: MiswriteCandidate[], displayId: number) =>
  candidates.filter((candidate) => candidate.conversationDisplayId === displayId);

/**
 * 実行中のエージェントの run（conversation-triage）の間に社内メモを送り、TARGET_IDS で targetConversation を指して終わらせる。
 * 送信時刻が run の期間に重なる状態を作る（重なりの判定は前後 1 分）。
 */
async function noteDuringAgentRun(plane: ReturnType<Planes["create"]>, displayId: number, targetConversation: number) {
  const gate = deferred();
  script([init(), () => gate.promise, result(`SUMMARY: 社内メモを付けた\nTARGET_IDS: chatwoot-conversation:${targetConversation}`)]);
  const { runId } = await plane.runNow({ target: { kind: "agent", agent: "conversation-triage", prompt: "未解決の会話を切り分ける" } });
  await vi.waitFor(() => expect(sdk.query).toHaveBeenCalled());
  const messageId = await sendAgentNote(displayId, `${NOTE_MARKER} 実行中の社内メモ`);
  gate.resolve();
  const agentRun = await waitFinished(plane, runId);
  expect(agentRun.targetIds).toEqual([`chatwoot-conversation:${targetConversation}`]);
  return { agentRun, messageId };
}

describe("miswrite-check（誤った書き込みの突き合わせ）", () => {
  describe("正常系", () => {
    it("どの E-13 にも E-15 にも対応しないエージェントの社内メモを候補にし、ID・時刻・理由だけを残す", async () => {
      const { plane, run } = await runCheck();
      expect(run).toMatchObject({ builtin: "miswrite-check", outcome: "success", failureClass: null });
      expect(run.summary).toMatch(/^突き合わせ: 走査した会話 \d+ 件、エージェントの送信 \d+ 件、候補 \d+ 件（新規 \d+ 件）$/);
      expect(run.targetIds).toContain(`chatwoot-conversation:${base.displayId}`);

      const mine = candidatesOf(await plane.listMiswriteCandidates(), base.displayId);
      expect(mine).toEqual([
        {
          conversationDisplayId: base.displayId,
          messageId: base.messageId,
          sentAt: expect.stringMatching(/\+09:00$/),
          nearestRunId: null,
          reason: "no matching proposal or run",
        },
      ]);
      // 本文は読み捨てる（E-15・ログに残さない）。トークンも出さない
      for (const text of [e15Bytes(fx), logs()]) {
        expect(text).not.toContain(NOTE_MARKER);
        expect(text).not.toContain(requireValue("CHATWOOT_ADMIN_TOKEN"));
      }
    });

    it("(a) main の承認済み E-13 が display_id を対象にしていれば、その会話の送信は候補にしない", async () => {
      writeProposal(fx, "main", {
        id: "PRP-2026-0101",
        state: "approved",
        identifier: `display_id=${base.displayId}`,
        createdAt: "2026-01-01T00:00:00+09:00",
      });
      const { plane } = await runCheck();
      expect(candidatesOf(await plane.listMiswriteCandidates(), base.displayId)).toEqual([]);
    });

    it("(b) 送信時刻に重なる E-15 の run の targetIds がその会話を指していれば、候補にしない", async () => {
      const displayId = await itConversation("miswrite-overlap");
      const plane = planes.create(env());
      await noteDuringAgentRun(plane, displayId, displayId);
      await runCheck(plane);
      expect(candidatesOf(await plane.listMiswriteCandidates(), displayId)).toEqual([]);
    });

    it("(b) 重なる run が別の会話を指していれば候補にし、nearestRunId にその run を入れる", async () => {
      const displayId = await itConversation("miswrite-other");
      const plane = planes.create(env());
      const { agentRun, messageId } = await noteDuringAgentRun(plane, displayId, 999_999_001);
      await runCheck(plane);
      expect(candidatesOf(await plane.listMiswriteCandidates(), displayId)).toEqual([
        expect.objectContaining({ messageId, nearestRunId: agentRun.runId }),
      ]);
    });

    it("2 回目は前回完了から読み、同じメッセージを重複して候補にしない（新規 0 件）", async () => {
      const { plane } = await runCheck();
      const { run } = await runCheck(plane);
      expect(run.summary).toMatch(/（新規 0 件）$/);
      expect(candidatesOf(await plane.listMiswriteCandidates(), base.displayId)).toHaveLength(1);
    });

    // 回帰: Chatwoot のメッセージ一覧は 1 ページ（20 件）を古い順で返す。末尾（最新）を before にしていたため、
    // 1 つの会話でエージェントが 21 件以上送ると同じページを読み直し続け、partial（truncated）になって前回完了の時刻も進まなかった
    it("1 つの会話にエージェントの社内メモが 25 件あっても、遡って全部を読み切り success にする", async () => {
      const displayId = await itConversation("miswrite-many");
      const sent: number[] = [];
      for (let i = 0; i < 25; i++) sent.push(await sendAgentNote(displayId, `${NOTE_MARKER} ${i}`));
      const { plane, run } = await runCheck();
      expect(run).toMatchObject({ outcome: "success", failureClass: null });
      const mine = candidatesOf(await plane.listMiswriteCandidates(), displayId);
      expect(mine.map((candidate) => candidate.messageId).sort((a, b) => a - b)).toEqual(sent);
    });

    it("空入力: 突き合わせの 4 変数が無ければ Chatwoot を読まずに skipped（理由は変数名だけ）", async () => {
      const plane = planes.create(fx.env());
      const { run } = await runCheck(plane);
      expect(run).toMatchObject({
        outcome: "skipped",
        skipReason:
          "設定が無いため見送った（MISWRITE_CHATWOOT_BASE_URL, MISWRITE_CHATWOOT_ACCOUNT_ID, MISWRITE_CHATWOOT_API_TOKEN, MISWRITE_AGENT_USER_ID）",
      });
      expect(await plane.listMiswriteCandidates()).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: 作業ツリーにだけある承認済みの E-13 では対応ありにしない（main から読む）", async () => {
      writeProposal(fx, "worktree", {
        id: "PRP-2026-0102",
        state: "approved",
        identifier: `display_id=${base.displayId}`,
        createdAt: "2026-01-01T00:00:00+09:00",
      });
      const { plane } = await runCheck();
      expect(candidatesOf(await plane.listMiswriteCandidates(), base.displayId)).toHaveLength(1);
    });

    it("入力: draft の E-13 は main にあっても対応ありにしない", async () => {
      writeProposal(fx, "main", { id: "PRP-2026-0103", state: "draft", identifier: `display_id=${base.displayId}`, createdAt: "2026-01-01T00:00:00+09:00" });
      const { plane } = await runCheck();
      expect(candidatesOf(await plane.listMiswriteCandidates(), base.displayId)).toHaveLength(1);
    });

    it("入力: トークンが違えば Chatwoot の 401 を permission_denied として failure にし、候補を作らず、トークンを出さない", async () => {
      const wrongToken = "it-wrong-chatwoot-token-0000";
      const plane = planes.create(env({ MISWRITE_CHATWOOT_API_TOKEN: wrongToken }));
      const { run } = await runCheck(plane);
      expect(run).toMatchObject({
        outcome: "failure",
        failureClass: "permission_denied",
        summary: "誤った書き込みの突き合わせに失敗した（permission_denied）",
      });
      expect(await plane.listMiswriteCandidates()).toEqual([]);
      expect(logs()).not.toContain(wrongToken);
      expect(e15Bytes(fx)).not.toContain(wrongToken);
    });

    it("サーバ: Chatwoot に届かない（閉じたポート）なら、再試行（3 秒 + 9 秒）の後に failure（unreachable）", async () => {
      const plane = planes.create(env({ MISWRITE_CHATWOOT_BASE_URL: CLOSED_PORT_URL }));
      const { run } = await runCheck(plane, 30_000);
      expect(run).toMatchObject({ outcome: "failure", failureClass: "unreachable" });
      expect(await plane.listMiswriteCandidates()).toEqual([]);
    });
  });
});
