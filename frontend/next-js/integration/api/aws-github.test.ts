import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManualRunAccepted, RunRecord } from "control-plane";
import {
  ADMIN_EMAIL,
  PROPOSALS_DIR,
  SCHEDULES_DIR,
  apiRequest,
  applyEnv,
  callRoute,
  createSandbox,
  createUserAndSession,
  proposalText,
  restoreEnv,
  runContext,
  scheduleYaml,
  waitForRun,
  writeAt,
  type Sandbox,
} from "../helpers/harness";

// 監視アプリのサーバー側だけが持つ外部連携（開発スタックに無いもの）を、API の入口から通して確かめる。
//   S3（E-15 の写し）・CloudWatch（ハートビート）: @aws-sdk/* を差し替える（AWS には繋がない）
//   GitHub（I-13 の起票）: fetch を差し替える（api.github.com 宛てだけを受ける偽の応答）
// control-plane・E-15・作業ツリーの提案のファイル・ログイン（Better Auth）は本物。
const aws = vi.hoisted(() => ({ s3Send: vi.fn(), cloudWatchSend: vi.fn(), clientConfigs: [] as unknown[] }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    constructor(config: unknown) {
      aws.clientConfigs.push(config);
    }
    send(command: unknown, options: unknown) {
      return aws.s3Send(command, options);
    }
  },
  PutObjectCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
}));
vi.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: class {
    constructor(config: unknown) {
      aws.clientConfigs.push(config);
    }
    send(command: unknown, options: unknown) {
      return aws.cloudWatchSend(command, options);
    }
  },
  PutMetricDataCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
}));
vi.mock("@aws-sdk/credential-providers", () => ({ fromIni: vi.fn(() => async () => ({ accessKeyId: "x", secretAccessKey: "y" })) }));
vi.mock("next/headers", async () => {
  const { requestScope } = await import("../helpers/request-scope");
  return { headers: async () => requestScope.headers };
});

import { GET as runGET } from "@/app/api/runs/[runId]/route";
import { POST as runsPOST } from "@/app/api/runs/route";

const GITHUB_TOKEN = "ghp_it_dummy_token_0123456789";
const REPOSITORY = "it-owner/it-repo";
const BUCKET = "it-runlog-bucket";
const NAMESPACE = "ComeGin/IT";

let sandbox: Sandbox;
let cookie: string;

const runJob = (jobId: string) =>
  callRoute<ManualRunAccepted>(runsPOST, apiRequest("/api/runs", { method: "POST", cookie, body: { target: { kind: "job", jobId } } }));

async function runJobToEnd(jobId: string): Promise<RunRecord> {
  const res = await runJob(jobId);
  expect(res.status).toBe(202);
  return waitForRun(cookie, res.json.runId);
}

const getRun = async (runId: string) =>
  (await callRoute<{ run: RunRecord }, [ReturnType<typeof runContext>]>(runGET, apiRequest(`/api/runs/${runId}`, { cookie }), runContext(runId))).json.run;

const proposalFile = (id: string) => join(sandbox.worktree, PROPOSALS_DIR, `${id}.md`);

// ---- GitHub の偽の応答（I-13 の起票の手順どおり） ----
interface GitHubCall {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}
let githubCalls: GitHubCall[] = [];
/** 何番目の呼び出しでも、この状態を返す（障害を起こすとき） */
let githubFailure: number | null = null;

function fakeGitHub(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.host !== "api.github.com") return Promise.reject(new Error(`想定外の宛先: ${url.host}`));
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  const path = `${url.pathname.replace(`/repos/${REPOSITORY}`, "")}${url.search}`;
  githubCalls.push({ method, path, authorization: headers.get("authorization"), body: init.body ? JSON.parse(String(init.body)) : null });
  const json = (status: number, body: unknown = {}) => Promise.resolve(Response.json(body, { status }));
  if (githubFailure !== null) return json(githubFailure, { message: "it: 偽の失敗" });
  if (method === "GET" && path.startsWith("/contents/")) return json(404, { message: "Not Found" });
  if (method === "GET" && path.startsWith("/pulls?head=")) return json(200, []);
  if (method === "GET" && path === "/git/ref/heads/main") return json(200, { object: { sha: "it-base-sha" } });
  if (method === "POST" && path === "/git/refs") return json(201, {});
  if (method === "PUT" && path.startsWith("/contents/")) return json(201, {});
  if (method === "POST" && path === "/pulls") return json(201, { number: 21 });
  if (method === "POST" && path === "/pulls/21/requested_reviewers") return json(201, {});
  return Promise.reject(new Error(`想定外の GitHub API: ${method} ${path}`));
}

beforeAll(async () => {
  sandbox = createSandbox("aws-github");
  const main = sandbox.mainCheckout;
  writeAt(main, `${SCHEDULES_DIR}/it-i13.yaml`, scheduleYaml({ id: "it-i13", cron: "0 8 * * *", kind: "builtin", builtin: "i13-file", timeout_sec: 120 }));
  writeAt(main, `${SCHEDULES_DIR}/it-heartbeat.yaml`, scheduleYaml({ id: "it-heartbeat", cron: "*/5 * * * *", kind: "builtin", builtin: "heartbeat" }));
  writeAt(main, `${SCHEDULES_DIR}/it-runlog.yaml`, scheduleYaml({ id: "it-runlog", cron: "*/10 * * * *", kind: "builtin", builtin: "runlog-flush" }));
  applyEnv(
    sandbox.env({
      GITHUB_TOKEN,
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_BASE_BRANCH: "main",
      I13_ISSUE_NUMBER: "13",
      I13_REVIEWER: "it-reviewer",
      AWS_REGION: "ap-northeast-1",
      RUNLOG_BUCKET: BUCKET,
      HEARTBEAT_NAMESPACE: NAMESPACE,
    }),
  );
  ({ cookie } = await createUserAndSession(ADMIN_EMAIL));
});

beforeEach(() => {
  aws.s3Send.mockReset();
  aws.s3Send.mockResolvedValue({});
  aws.cloudWatchSend.mockReset();
  aws.cloudWatchSend.mockResolvedValue({});
  githubCalls = [];
  githubFailure = null;
  vi.stubGlobal("fetch", vi.fn(fakeGitHub));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
  restoreEnv();
  sandbox?.dispose();
});

describe("I-13 の起票（POST /api/runs → i13-file → GitHub）", () => {
  describe("正常系", () => {
    it("空入力: 作業ツリーに提案が無ければ「起票対象なし」の success で、GitHub を呼ばない", async () => {
      const run = await runJobToEnd("it-i13");
      expect(run).toMatchObject({ builtin: "i13-file", outcome: "success", summary: "I-13: 起票対象なし", targetIds: [] });
      expect(githubCalls).toEqual([]);
    });

    it("draft の提案を GitHub に起票（ブランチ・コミット・PR・Reviewer）し、PR 番号を書き戻して success を記録する", async () => {
      writeAt(sandbox.worktree, `${PROPOSALS_DIR}/PRP-2026-0901.md`, proposalText({ id: "PRP-2026-0901" }));
      const run = await runJobToEnd("it-i13");
      expect(run).toMatchObject({ outcome: "success", summary: "I-13: 起票 1 件、既存 0 件、不正 0 件、失敗 0 件", targetIds: ["PRP-2026-0901"] });
      expect(githubCalls.map((call) => `${call.method} ${call.path.split("?")[0]}`)).toEqual([
        `GET /contents/${PROPOSALS_DIR}/PRP-2026-0901.md`,
        "GET /pulls",
        "GET /git/ref/heads/main",
        "POST /git/refs",
        `GET /contents/${PROPOSALS_DIR}/PRP-2026-0901.md`,
        `PUT /contents/${PROPOSALS_DIR}/PRP-2026-0901.md`,
        "POST /pulls",
        "POST /pulls/21/requested_reviewers",
      ]);
      expect(githubCalls.every((call) => call.authorization === `Bearer ${GITHUB_TOKEN}`)).toBe(true);
      expect(githubCalls.find((call) => call.path === "/git/refs")?.body).toEqual({ ref: "refs/heads/13-feature-proposal-PRP-2026-0901", sha: "it-base-sha" });
      expect(readFileSync(proposalFile("PRP-2026-0901"), "utf8")).toContain('diff_ref: "PR #21"');
      // トークンは E-15 に残らない
      expect(JSON.stringify(run)).not.toContain(GITHUB_TOKEN);
    });

    it("PR 番号を書き戻した提案は、次の実行で起票しない（冪等）", async () => {
      const run = await runJobToEnd("it-i13");
      expect(run).toMatchObject({ outcome: "success", summary: "I-13: 起票対象なし" });
      expect(githubCalls).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("サーバ: GitHub が 401 なら、再試行せずに failure（auth_failed）を記録し、提案のファイルは書き換えない", async () => {
      writeAt(sandbox.worktree, `${PROPOSALS_DIR}/PRP-2026-0902.md`, proposalText({ id: "PRP-2026-0902" }));
      githubFailure = 401;
      const run = await runJobToEnd("it-i13");
      expect(run).toMatchObject({ outcome: "failure", failureClass: "auth_failed", targetIds: ["PRP-2026-0902"] });
      expect(run.summary).toContain("PRP-2026-0902=auth_failed");
      expect(githubCalls).toHaveLength(1);
      expect(readFileSync(proposalFile("PRP-2026-0902"), "utf8")).toContain("diff_ref: null");
      expect(JSON.stringify(run)).not.toContain(GITHUB_TOKEN);
    });

    it("サーバ: GitHub が 403 なら failure（permission_denied）を記録する", async () => {
      githubFailure = 403;
      const run = await runJobToEnd("it-i13");
      expect(run).toMatchObject({ outcome: "failure", failureClass: "permission_denied" });
    });

    it("入力: frontmatter の壊れた提案は GitHub に出さず「不正」として数える（ほかの提案は起票する）", async () => {
      // 401 で残った PRP-2026-0902 は今回は起票される。壊れた提案は GitHub に出さない
      writeAt(sandbox.worktree, `${PROPOSALS_DIR}/PRP-2026-0903.md`, "---\nproposal_id: PRP-2026-0903\n---\n");
      const run = await runJobToEnd("it-i13");
      expect(run.summary).toBe("I-13: 起票 1 件、既存 0 件、不正 1 件、失敗 0 件");
      expect(run.outcome).toBe("success");
      expect(githubCalls.some((call) => call.path.includes("PRP-2026-0903"))).toBe(false);
    });
  });
});

describe("E-15 の S3 への写し（実行の終了時・runlog-flush）", () => {
  describe("正常系", () => {
    it("実行の終了時に、E-15 の 1 件を runs/YYYY/MM/DD/<run_id>.json へ If-None-Match: * で送り、copiedAt が入る", async () => {
      const run = await runJobToEnd("it-i13");
      const copied = await waitForRun(cookie, run.runId, (r) => r.copiedAt !== null);
      const put = aws.s3Send.mock.calls.map(([command]) => (command as { input: Record<string, unknown> }).input).find((input) => String(input.Key).includes(run.runId));
      expect(put).toMatchObject({
        Bucket: BUCKET,
        Key: `runs/${run.startedAt.slice(0, 4)}/${run.startedAt.slice(5, 7)}/${run.startedAt.slice(8, 10)}/${run.runId}.json`,
        ContentType: "application/json",
        IfNoneMatch: "*",
      });
      const snapshot = JSON.parse(String(put?.Body)) as RunRecord;
      expect(snapshot).toMatchObject({ runId: run.runId, outcome: run.outcome, summary: run.summary });
      expect(copied.copiedAt).toMatch(/\+09:00$/);
    });

    it("見送り（skipped）の記録も写す", async () => {
      const res = await callRoute<ManualRunAccepted>(
        runsPOST,
        apiRequest("/api/runs", { method: "POST", cookie, body: { target: { kind: "agent", agent: "it-missing", prompt: "p" } } }),
      );
      expect(res.json.accepted).toBe(false);
      const skipped = await waitForRun(cookie, res.json.runId, (r) => r.copiedAt !== null);
      expect(skipped.outcome).toBe("skipped");
    });
  });

  describe("異常系", () => {
    it("サーバ: S3 が AccessDenied なら写しは未送（copiedAt=null）のまま実行の記録は残り、復旧後の runlog-flush で送り直される", async () => {
      aws.s3Send.mockRejectedValue(Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }));
      const run = await runJobToEnd("it-i13");
      // 写しの試行が終わるのを待つ（試行は実行の確定の後）
      await vi.waitFor(() => expect(aws.s3Send).toHaveBeenCalled());
      expect((await getRun(run.runId)).copiedAt).toBeNull();

      aws.s3Send.mockReset();
      aws.s3Send.mockResolvedValue({});
      const flush = await runJobToEnd("it-runlog");
      expect(flush.outcome).toBe("success");
      expect(flush.summary).toMatch(/^S3 への写し: 送信 [1-9]\d* 件/);
      expect((await waitForRun(cookie, run.runId, (r) => r.copiedAt !== null)).copiedAt).not.toBeNull();
    });

    it("サーバ: S3 が 412（既に同じキーがある）なら、送り直さず写し済みの印だけ付ける", async () => {
      aws.s3Send.mockRejectedValue(Object.assign(new Error("At least one of the pre-conditions you specified did not hold"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } }));
      const run = await runJobToEnd("it-i13");
      expect((await waitForRun(cookie, run.runId, (r) => r.copiedAt !== null)).copiedAt).not.toBeNull();
    });
  });
});

describe("ハートビート（POST /api/runs → heartbeat → CloudWatch）", () => {
  describe("正常系", () => {
    it("定義を手動で起動すると、CloudWatch に Heartbeat=1 を送り、success を記録する", async () => {
      const run = await runJobToEnd("it-heartbeat");
      expect(run).toMatchObject({ builtin: "heartbeat", outcome: "success", summary: "ハートビートを送信した" });
      const input = (aws.cloudWatchSend.mock.calls[0]?.[0] as { input: { Namespace: string; MetricData: Record<string, unknown>[] } }).input;
      expect(input.Namespace).toBe(NAMESPACE);
      expect(input.MetricData).toEqual([expect.objectContaining({ MetricName: "Heartbeat", Value: 1, Unit: "Count" })]);
    });
  });

  describe("異常系", () => {
    it.each([
      ["ThrottlingException", { name: "ThrottlingException", $metadata: { httpStatusCode: 400 } }, "rate_limited"],
      ["資格情報の期限切れ", { name: "ExpiredTokenException", $metadata: { httpStatusCode: 403 } }, "auth_failed"],
      ["通信できない", { name: "Error", code: "ECONNREFUSED" }, "unreachable"],
    ])("サーバ: CloudWatch が %s なら failure と分類（%s）を記録する", async (_label, shape, failureClass) => {
      aws.cloudWatchSend.mockRejectedValue(Object.assign(new Error("it: 偽の失敗"), shape));
      const run = await runJobToEnd("it-heartbeat");
      expect(run).toMatchObject({ outcome: "failure", failureClass, summary: "ハートビートの送信に失敗した" });
    });
  });
});
