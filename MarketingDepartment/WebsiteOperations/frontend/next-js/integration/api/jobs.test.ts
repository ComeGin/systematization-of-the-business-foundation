import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobStatus, ManualRunAccepted } from "control-plane";
import { initMessage, resultMessage, scripted } from "../helpers/agent-sdk";
import {
  ADMIN_EMAIL,
  AGENTS_DIR,
  SCHEDULES_DIR,
  agentDefinition,
  apiRequest,
  applyEnv,
  callRoute,
  createSandbox,
  createUserAndSession,
  leakedFragments,
  resetControlPlane,
  restoreEnv,
  scheduleYaml,
  waitForRun,
  writeAt,
  type Sandbox,
} from "../helpers/harness";

// GET /api/jobs → control-plane（本物）→ 承認済み main のチェックアウト（一時ディレクトリ）の ops/schedules。
// 直近の実行（lastRun）は E-15 から引くので、POST /api/runs で定義を手動で起動して確かめる。
const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));
vi.mock("next/headers", async () => {
  const { requestScope } = await import("../helpers/request-scope");
  return { headers: async () => requestScope.headers };
});

import { GET as jobsGET } from "@/app/api/jobs/route";
import { POST as runsPOST } from "@/app/api/runs/route";

const AGENT = "it-probe";

let sandbox: Sandbox;
let cookie: string;

const listJobs = (requestCookie: string | undefined = cookie) =>
  callRoute<{ jobs: JobStatus[]; error?: string }>(jobsGET, apiRequest("/api/jobs", { cookie: requestCookie }));
const runJob = (jobId: string) =>
  callRoute<ManualRunAccepted>(runsPOST, apiRequest("/api/runs", { method: "POST", cookie, body: { target: { kind: "job", jobId } } }));

beforeAll(async () => {
  sandbox = createSandbox("jobs");
  const main = sandbox.mainCheckout;
  writeAt(main, `${AGENTS_DIR}/${AGENT}.md`, agentDefinition(AGENT));
  writeAt(
    main,
    `${SCHEDULES_DIR}/it-a-agent.yaml`,
    scheduleYaml({ id: "it-a-agent", description: "エージェントの定義", enabled: true, cron: "0 9 * * *", kind: "agent", agent: AGENT, prompt: "見て", timeout_sec: 120, max_turns: 5 }),
  );
  writeAt(
    main,
    `${SCHEDULES_DIR}/it-b-heartbeat.yaml`,
    scheduleYaml({ id: "it-b-heartbeat", description: "builtin の定義", enabled: false, cron: "*/5 * * * *", kind: "builtin", builtin: "heartbeat" }),
  );
  // 壊れた定義（id がファイル名と違う・cron が 6 フィールド）と、yaml でないファイルは一覧に出ない
  writeAt(main, `${SCHEDULES_DIR}/it-c-mismatch.yaml`, scheduleYaml({ id: "it-other", cron: "0 9 * * *", kind: "builtin", builtin: "heartbeat" }));
  writeAt(main, `${SCHEDULES_DIR}/it-d-bad-cron.yaml`, scheduleYaml({ id: "it-d-bad-cron", cron: "0 0 9 * * *", kind: "builtin", builtin: "heartbeat" }));
  writeAt(main, `${SCHEDULES_DIR}/README.md`, "# 定義の説明\n");
  // 作業ツリーの未承認の定義は読まない（ADR-18）
  writeAt(sandbox.worktree, `${SCHEDULES_DIR}/it-worktree-only.yaml`, scheduleYaml({ id: "it-worktree-only", cron: "0 9 * * *", kind: "builtin", builtin: "heartbeat" }));
  applyEnv(sandbox.env());
  ({ cookie } = await createUserAndSession(ADMIN_EMAIL));
});

beforeEach(() => {
  sdk.query.mockReset();
  sdk.query.mockImplementation(scripted([initMessage(), resultMessage("SUMMARY: 定義から実行した")]));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
  restoreEnv();
  sandbox?.dispose();
});

describe("GET /api/jobs", () => {
  describe("正常系", () => {
    it("承認済み main の定義を、ファイル名の順に、契約の形（prompt を含めない）で返す", async () => {
      const res = await listJobs();
      expect(res.status).toBe(200);
      expect(res.json.jobs.map((job) => job.definition.id)).toEqual(["it-a-agent", "it-b-heartbeat"]);
      expect(res.json.jobs[0]).toEqual({
        definition: {
          id: "it-a-agent",
          description: "エージェントの定義",
          enabled: true,
          cron: "0 9 * * *",
          kind: "agent",
          agent: AGENT,
          builtin: null,
          after: [],
          timeoutSec: 120,
          maxTurns: 5,
        },
        // CONTROL_SCHEDULER_ENABLED=false なので次回の予定は出さない
        nextRunAt: null,
        lastRun: null,
      });
      expect(res.text).not.toContain("prompt");
    });

    it("作業ツリーにだけある定義は返さない（ADR-18。読むのは承認済み main だけ）", async () => {
      const res = await listJobs();
      expect(res.json.jobs.map((job) => job.definition.id)).not.toContain("it-worktree-only");
    });

    it("定義を手動で起動すると、その実行が lastRun に入る", async () => {
      const posted = await runJob("it-a-agent");
      expect(posted.status).toBe(202);
      await waitForRun(cookie, posted.json.runId);
      resetControlPlane(); // 定義の読み込みは 5 秒キャッシュされる。作り直して E-15 からの読み直しを確かめる
      const job = (await listJobs()).json.jobs.find((j) => j.definition.id === "it-a-agent");
      expect(job?.lastRun).toMatchObject({ runId: posted.json.runId, jobId: "it-a-agent", outcome: "success", trigger: "manual" });
    });

    it("設定の無い builtin（heartbeat。AWS 未設定）を手動で起動すると、見送り（skipped・理由に変数名）が lastRun に入る", async () => {
      const posted = await runJob("it-b-heartbeat");
      expect(posted.status).toBe(200);
      expect(posted.json.accepted).toBe(false);
      const job = (await listJobs()).json.jobs.find((j) => j.definition.id === "it-b-heartbeat");
      expect(job?.lastRun).toMatchObject({
        runId: posted.json.runId,
        outcome: "skipped",
        skipReason: "設定が無いため見送った（AWS_REGION, RUNLOG_BUCKET）",
        builtin: "heartbeat",
      });
    });

    it("空入力: main に ops/schedules が無ければ { jobs: [] } を返す", async () => {
      const emptyMain = join(sandbox.root, "empty-main");
      mkdirSync(emptyMain, { recursive: true });
      applyEnv({ CONTROL_MAIN_CHECKOUT: emptyMain });
      resetControlPlane();
      try {
        const res = await listJobs();
        expect(res.status).toBe(200);
        expect(res.json).toEqual({ jobs: [] });
      } finally {
        applyEnv({ CONTROL_MAIN_CHECKOUT: sandbox.mainCheckout });
        resetControlPlane();
      }
    });
  });

  describe("異常系", () => {
    it("空入力: セッションが無ければ 401 を返し、定義を読まない", async () => {
      const res = await listJobs("");
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: "unauthorized" });
    });

    it("サーバ: 定義のファイル 1 つが読めなくても（権限なし）、その定義だけを除いて 200 で返す", async () => {
      const file = join(sandbox.mainCheckout, SCHEDULES_DIR, "it-b-heartbeat.yaml");
      chmodSync(file, 0o000);
      resetControlPlane();
      try {
        const res = await listJobs();
        expect(res.status).toBe(200);
        expect(res.json.jobs.map((job) => job.definition.id)).toEqual(["it-a-agent"]);
      } finally {
        chmodSync(file, 0o644);
        resetControlPlane();
      }
    });

    it("サーバ: main の ops/schedules が読めない（権限なし）なら 500 を返し、パスや OS の文を出さない", async () => {
      const dir = join(sandbox.mainCheckout, SCHEDULES_DIR);
      chmodSync(dir, 0o000);
      resetControlPlane();
      try {
        const res = await listJobs();
        expect(res.status).toBe(500);
        expect(res.json).toEqual({ error: "internal error" });
        expect(leakedFragments(res.text, ["EACCES", sandbox.mainCheckout, "schedules"])).toEqual([]);
      } finally {
        chmodSync(dir, 0o755);
        resetControlPlane();
      }
    });
  });
});
