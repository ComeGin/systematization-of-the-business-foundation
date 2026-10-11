import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManualRunAccepted, MiswriteCandidate, RunRecord } from "control-plane";
import { initMessage, resultMessage, scripted } from "../helpers/agent-sdk";
import { CHATWOOT_URL, createConversation, deleteConversationAndContact, sendOutgoing, stateValue } from "../helpers/chatwoot";
import {
  ADMIN_EMAIL,
  AGENTS_DIR,
  PROPOSALS_DIR,
  SCHEDULES_DIR,
  agentDefinition,
  apiRequest,
  applyEnv,
  callRoute,
  createSandbox,
  createUserAndSession,
  itEmail,
  itName,
  leakedFragments,
  proposalText,
  resetControlPlane,
  restoreEnv,
  scheduleYaml,
  waitForRun,
  writeAt,
  type Sandbox,
} from "../helpers/harness";

// POST /api/runs（miswrite-check の定義）→ control-plane（本物）→ 開発の Chatwoot（本物。127.0.0.1:3100 を読むだけ）→
// E-15・候補の表 → GET /api/miswrite-candidates。
// 会話とエージェント専用ユーザー（ADR-17）の送信は、このファイルで作って afterAll で消す（名前は it- で始める）。
// 差し替えは Agent SDK（実行と送信の時間の重なりを作るため）と next/headers だけ。
const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));
vi.mock("next/headers", async () => {
  const { requestScope } = await import("../helpers/request-scope");
  return { headers: async () => requestScope.headers };
});

import { GET as candidatesGET } from "@/app/api/miswrite-candidates/route";
import { POST as runsPOST } from "@/app/api/runs/route";

const JOB = "it-miswrite";
const AGENT = "it-probe";

let sandbox: Sandbox;
let cookie: string;
const created: { contactId: number; displayId: number }[] = [];

const listCandidates = (requestCookie: string | undefined = cookie) =>
  callRoute<{ candidates: MiswriteCandidate[]; error?: string }>(candidatesGET, apiRequest("/api/miswrite-candidates", { cookie: requestCookie }));
const post = (body: unknown) => callRoute<ManualRunAccepted>(runsPOST, apiRequest("/api/runs", { method: "POST", cookie, body }));

/** 突き合わせを 1 回動かし、完了した記録を返す */
async function runMiswriteCheck(): Promise<RunRecord> {
  const res = await post({ target: { kind: "job", jobId: JOB } });
  expect(res.status).toBe(202);
  return waitForRun(cookie, res.json.runId, (run) => run.status === "finished", 45_000);
}

async function candidatesOf(displayId: number): Promise<MiswriteCandidate[]> {
  return (await listCandidates()).json.candidates.filter((c) => c.conversationDisplayId === displayId);
}

async function newConversation(label: string) {
  const conversation = await createConversation(itName(label), itEmail(label));
  created.push(conversation);
  return conversation.displayId;
}

function miswriteEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    MISWRITE_CHATWOOT_BASE_URL: CHATWOOT_URL,
    MISWRITE_CHATWOOT_ACCOUNT_ID: stateValue("CHATWOOT_ACCOUNT_ID"),
    // 開発では参照専用のトークンを分けていないため、管理者のトークンで読む（読むだけ。control-plane は GET しか送らない）
    MISWRITE_CHATWOOT_API_TOKEN: stateValue("CHATWOOT_ADMIN_TOKEN"),
    MISWRITE_AGENT_USER_ID: stateValue("CHATWOOT_AGENT_USER_ID"),
    ...overrides,
  };
}

beforeAll(async () => {
  sandbox = createSandbox("miswrite");
  writeAt(sandbox.mainCheckout, `${AGENTS_DIR}/${AGENT}.md`, agentDefinition(AGENT));
  writeAt(
    sandbox.mainCheckout,
    `${SCHEDULES_DIR}/${JOB}.yaml`,
    scheduleYaml({ id: JOB, description: "誤った書き込みの突き合わせ", enabled: false, cron: "0 * * * *", kind: "builtin", builtin: "miswrite-check", timeout_sec: 120 }),
  );
  applyEnv(sandbox.env(miswriteEnv()));
  ({ cookie } = await createUserAndSession(ADMIN_EMAIL));
});

beforeEach(() => {
  sdk.query.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(async () => {
  const failures: string[] = [];
  for (const { displayId, contactId } of created.reverse()) {
    await deleteConversationAndContact(displayId, contactId).catch((error: unknown) => failures.push(String(error)));
  }
  restoreEnv();
  sandbox?.dispose();
  if (failures.length > 0) throw new Error(`Chatwoot の後片付けに失敗した:\n${failures.join("\n")}`);
});

describe("GET /api/miswrite-candidates", () => {
  describe("正常系", () => {
    it("空入力: 突き合わせの前は { candidates: [] } を返す", async () => {
      const res = await listCandidates();
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ candidates: [] });
    });

    it("エージェント専用ユーザーの送信で、提案にも実行にも対応しないものだけが候補になる（管理者の送信は対象外）", async () => {
      const displayId = await newConversation("miswrite-a");
      const agentMessage = await sendOutgoing(displayId, "it: エージェント専用ユーザーの送信", "agent");
      await sendOutgoing(displayId, "it: 管理者（人）の送信", "admin");

      const run = await runMiswriteCheck();
      expect(run).toMatchObject({ builtin: "miswrite-check", jobId: JOB, outcome: "success" });
      expect(run.targetIds).toContain(`chatwoot-conversation:${displayId}`);
      expect(run.summary).toMatch(/^突き合わせ: 走査した会話 \d+ 件、エージェントの送信 \d+ 件、候補 \d+ 件（新規 \d+ 件）$/);

      const candidates = await candidatesOf(displayId);
      expect(candidates).toEqual([
        { conversationDisplayId: displayId, messageId: agentMessage, sentAt: expect.stringMatching(/\+09:00$/), nearestRunId: null, reason: "no matching proposal or run" },
      ]);
      // 本文は保存しない
      expect((await listCandidates()).text).not.toContain("エージェント専用ユーザーの送信");
    });

    it("同じ送信を 2 回突き合わせても、候補は 1 件のまま（重複しない）", async () => {
      const displayId = created[0]!.displayId;
      expect((await runMiswriteCheck()).outcome).toBe("success");
      expect(await candidatesOf(displayId)).toHaveLength(1);
    });

    it("承認済みの提案（main の docs/proposals）がその会話を指していれば、送信を候補にしない", async () => {
      const displayId = await newConversation("miswrite-b");
      writeAt(
        sandbox.mainCheckout,
        `${PROPOSALS_DIR}/PRP-2026-0901.md`,
        proposalText({ id: "PRP-2026-0901", state: "approved", identifier: `display_id=${displayId}`, createdAt: "2026-10-01T00:00:00+09:00" }),
      );
      await sendOutgoing(displayId, "it: 承認済みの提案に沿った送信", "agent");
      expect((await runMiswriteCheck()).outcome).toBe("success");
      expect(await candidatesOf(displayId)).toEqual([]);
    });

    it("実行の対象 ID（chatwoot-conversation:<n>）と時間が重なる送信は、候補にしない", async () => {
      const displayId = await newConversation("miswrite-c");
      sdk.query.mockImplementation(
        scripted([initMessage(), resultMessage(`SUMMARY: 会話に返信した\nTARGET_IDS: chatwoot-conversation:${displayId}`)]),
      );
      const agentRun = await post({ target: { kind: "agent", agent: AGENT, prompt: "返信して" } });
      expect((await waitForRun(cookie, agentRun.json.runId)).targetIds).toEqual([`chatwoot-conversation:${displayId}`]);
      // 実行の終了から 60 秒以内の送信は、その実行のものとして扱われる
      await sendOutgoing(displayId, "it: 実行が送った返信", "agent");
      expect((await runMiswriteCheck()).outcome).toBe("success");
      expect(await candidatesOf(displayId)).toEqual([]);
    });

    // Chatwoot のメッセージ一覧は「直近の 20 件を古い順」で返る。ページの最も古い id で遡れていることを、21 件以上の会話で確かめる
    it("1 つの会話に 21 件以上の送信があっても、全件を走査して success になり、全件が候補になる", async () => {
      const displayId = await newConversation("miswrite-many");
      for (let i = 0; i < 31; i++) await sendOutgoing(displayId, `it: 連続した送信 ${i}`, "agent");
      const run = await runMiswriteCheck();
      expect(run).toMatchObject({ outcome: "success", failureClass: null });
      expect(await candidatesOf(displayId)).toHaveLength(31);
    });

    it("突き合わせの設定（MISWRITE_*）が無ければ、miswrite-check は見送り（skipped・理由に変数名）になる", async () => {
      applyEnv(miswriteEnv({ MISWRITE_CHATWOOT_BASE_URL: undefined, MISWRITE_CHATWOOT_ACCOUNT_ID: undefined, MISWRITE_CHATWOOT_API_TOKEN: undefined, MISWRITE_AGENT_USER_ID: undefined }));
      resetControlPlane();
      try {
        const res = await post({ target: { kind: "job", jobId: JOB } });
        expect(res.status).toBe(200);
        expect(res.json.accepted).toBe(false);
        const run = await waitForRun(cookie, res.json.runId);
        expect(run.skipReason).toBe(
          "設定が無いため見送った（MISWRITE_CHATWOOT_BASE_URL, MISWRITE_CHATWOOT_ACCOUNT_ID, MISWRITE_CHATWOOT_API_TOKEN, MISWRITE_AGENT_USER_ID）",
        );
      } finally {
        applyEnv(miswriteEnv());
        resetControlPlane();
      }
    });
  });

  describe("異常系", () => {
    it("空入力: セッションが無ければ 401 を返す", async () => {
      const res = await listCandidates("");
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: "unauthorized" });
    });

    // Chatwoot の 401 は「トークン不正」と「権限不足」を区別できないため、permission_denied に分類する（DD-01 の 5.3）
    it("サーバ: Chatwoot が 401（トークンが不正）なら、実行は failure（permission_denied）で記録され、候補は増えず、トークンは記録に残らない", async () => {
      const badToken = "it-invalid-chatwoot-token";
      applyEnv(miswriteEnv({ MISWRITE_CHATWOOT_API_TOKEN: badToken }));
      resetControlPlane();
      try {
        const before = (await listCandidates()).json.candidates.length;
        const run = await runMiswriteCheck();
        expect(run).toMatchObject({
          outcome: "failure",
          failureClass: "permission_denied",
          summary: "誤った書き込みの突き合わせに失敗した（permission_denied）",
        });
        expect(JSON.stringify(run)).not.toContain(badToken);
        expect((await listCandidates()).json.candidates).toHaveLength(before);
      } finally {
        applyEnv(miswriteEnv());
        resetControlPlane();
      }
    });

    it("サーバ: Chatwoot に届かない（閉じたポート）なら、再試行のあと failure（unreachable）で記録する", async () => {
      applyEnv(miswriteEnv({ MISWRITE_CHATWOOT_BASE_URL: "http://127.0.0.1:9" }));
      resetControlPlane();
      try {
        const run = await runMiswriteCheck();
        expect(run).toMatchObject({ outcome: "failure", failureClass: "unreachable" });
        expect(run.summary).not.toContain("127.0.0.1");
      } finally {
        applyEnv(miswriteEnv());
        resetControlPlane();
      }
    });

    it("サーバ: 候補の表が壊れていたら 500 を返し、詳細を出さない", async () => {
      const brokenDir = join(sandbox.root, "data-broken");
      applyEnv({ CONTROL_DATA_DIR: brokenDir });
      resetControlPlane();
      try {
        await listCandidates(); // E-15 を作る
        const db = new DatabaseSync(join(brokenDir, "e15.sqlite"));
        db.exec("DROP TABLE miswrite_candidates");
        db.close();
        const res = await listCandidates();
        expect(res.status).toBe(500);
        expect(res.json).toEqual({ error: "internal error" });
        expect(leakedFragments(res.text, ["miswrite_candidates", "no such table", brokenDir])).toEqual([]);
      } finally {
        applyEnv({ CONTROL_DATA_DIR: sandbox.dataDir });
        resetControlPlane();
      }
    });
  });
});
