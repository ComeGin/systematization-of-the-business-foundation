import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManualRunAccepted, RunRecord } from "control-plane";
import { deferred, initMessage, resultMessage, scripted, throwing, type QueryArgs } from "../helpers/agent-sdk";
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
  runContext,
  scheduleYaml,
  waitForRun,
  writeAt,
  type Sandbox,
} from "../helpers/harness";

// POST /api/runs（手動の起動）→ control-plane（本物）→ Agent SDK（差し替え）→ E-15（一時ディレクトリの SQLite）→ GET /api/runs・/api/runs/[runId]。
// ログインは本物の Better Auth（auth.test.ts と同じ作り方）。差し替えは Agent SDK と next/headers だけ。
const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));
vi.mock("next/headers", async () => {
  const { requestScope } = await import("../helpers/request-scope");
  return { headers: async () => requestScope.headers };
});

import { GET as runGET } from "@/app/api/runs/[runId]/route";
import { GET as runsGET, POST as runsPOST } from "@/app/api/runs/route";

const AGENT = "it-probe";
const JOB = "it-probe-daily";
const JOB_PROMPT = "定期実行の定義のプロンプト";

let sandbox: Sandbox;
let cookie: string;

const listRuns = (query = "") => callRoute<{ runs: RunRecord[]; error?: string }>(runsGET, apiRequest(`/api/runs${query}`, { cookie }));
const getRun = (runId: string) =>
  callRoute<{ run?: RunRecord; error?: string }, [ReturnType<typeof runContext>]>(
    runGET,
    apiRequest(`/api/runs/${encodeURIComponent(runId)}`, { cookie }),
    runContext(runId),
  );
const postRun = (body: unknown) =>
  callRoute<ManualRunAccepted & { error?: string }>(runsPOST, apiRequest("/api/runs", { method: "POST", cookie, body }));
const startAgent = (prompt = "直近の結果を見て") => postRun({ target: { kind: "agent", agent: AGENT, prompt } });
const lastQuery = (): QueryArgs => sdk.query.mock.calls.at(-1)![0] as QueryArgs;

/** 一覧の件数（E-15 に何も書かれていないことの確認に使う） */
async function runCount(): Promise<number> {
  return (await listRuns("?limit=200")).json.runs.length;
}

beforeAll(async () => {
  sandbox = createSandbox("runs");
  writeAt(sandbox.mainCheckout, `${AGENTS_DIR}/${AGENT}.md`, agentDefinition(AGENT));
  writeAt(
    sandbox.mainCheckout,
    `${SCHEDULES_DIR}/${JOB}.yaml`,
    scheduleYaml({ id: JOB, description: "結合テスト", enabled: false, cron: "0 9 * * *", kind: "agent", agent: AGENT, prompt: JOB_PROMPT, timeout_sec: 60 }),
  );
  applyEnv(sandbox.env());
  ({ cookie } = await createUserAndSession(ADMIN_EMAIL));
});

beforeEach(() => {
  sdk.query.mockReset();
  sdk.query.mockImplementation(scripted([initMessage(), resultMessage("SUMMARY: 確認を終えた\nTARGET_IDS: url_path=/a, url_path=/b")]));
  // control-plane は stderr に 1 行ずつ記録を出す（相関 ID・本文は個人情報を含まない）。テストの出力を埋めないよう止める
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
  restoreEnv();
  sandbox?.dispose();
});

describe("GET /api/runs", () => {
  describe("正常系", () => {
    it("空入力: 記録が 0 件なら { runs: [] } を返し、E-15 は CONTROL_DATA_DIR（一時ディレクトリ）に作られる", async () => {
      const res = await listRuns();
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ runs: [] });
      expect(existsSync(join(sandbox.dataDir, "e15.sqlite"))).toBe(true);
    });

    it("手動で起動したあと、一覧に 1 件増え、新しい順に並ぶ", async () => {
      const first = await startAgent();
      await waitForRun(cookie, first.json.runId);
      const second = await startAgent();
      await waitForRun(cookie, second.json.runId);
      const res = await listRuns();
      expect(res.status).toBe(200);
      expect(res.json.runs.map((run) => run.runId).slice(0, 2)).toEqual([second.json.runId, first.json.runId]);
    });

    it("条件（outcome・jobId・limit・before）が E-15 の絞り込みに効く", async () => {
      sdk.query.mockImplementation(throwing(new Error("it: 失敗させる")));
      const failed = await startAgent();
      await waitForRun(cookie, failed.json.runId);

      const failures = await listRuns("?outcome=failure");
      expect(failures.json.runs.map((run) => run.runId)).toContain(failed.json.runId);
      expect(failures.json.runs.every((run) => run.outcome === "failure")).toBe(true);

      expect((await listRuns("?limit=1")).json.runs).toHaveLength(1);
      expect((await listRuns(`?before=${failed.json.runId}`)).json.runs.map((run) => run.runId)).not.toContain(failed.json.runId);
      expect((await listRuns("?jobId=it-no-such-job")).json.runs).toEqual([]);
    });
  });

  describe("異常系", () => {
    it.each([
      ["limit=0", "?limit=0"],
      ["limit=201", "?limit=201"],
      ["before が ULID でない", "?before=not-a-ulid"],
      ["outcome が想定外", "?outcome=running"],
    ])("入力: %s なら 400 を返す", async (_label, query) => {
      const res = await listRuns(query);
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "invalid query" });
    });

    it("空入力: limit が空なら 400 を返す", async () => {
      expect((await listRuns("?limit=")).status).toBe(400);
    });
  });
});

describe("POST /api/runs", () => {
  describe("正常系", () => {
    it("エージェントの指示なら 202 と相関 ID を返し、完了後に success・要約・対象 ID・費用が E-15 に記録される", async () => {
      const res = await startAgent("直近 7 日を見て");
      expect(res.status).toBe(202);
      expect(res.json.accepted).toBe(true);
      expect(res.json.runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

      const run = await waitForRun(cookie, res.json.runId);
      expect(run).toMatchObject({
        runId: res.json.runId,
        jobId: null,
        agentName: AGENT,
        builtin: null,
        trigger: "manual",
        status: "finished",
        outcome: "success",
        summary: "確認を終えた",
        summaryRedacted: false,
        targetIds: ["url_path=/a", "url_path=/b"],
        failureClass: null,
        sdkSubtype: "success",
        costUsd: 0.0123,
        copiedAt: null, // AWS 未設定（写しは送らない）
      });
      expect(run.finishedAt).not.toBeNull();
    });

    it("Agent SDK には、相関 ID を先頭に付けたプロンプトと、安全設定（作業ツリー・許可リストの env・dontAsk・定義のツールだけ）が渡る", async () => {
      const res = await startAgent("直近 7 日を見て");
      await waitForRun(cookie, res.json.runId);
      const { prompt, options } = lastQuery();
      expect(prompt.split("\n")[0]).toBe(`CORRELATION_ID: ${res.json.runId}`);
      expect(prompt).toMatch(/\nNOW: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00\nTODAY: \d{4}-\d{2}-\d{2}\n\n直近 7 日を見て$/);
      expect(options.cwd).toBe(sandbox.worktree);
      expect(Object.keys(options.env).sort()).toEqual(["ANTHROPIC_API_KEY", "HOME", "PATH"]);
      expect(options.env.HOME).toBe(sandbox.agentHome);
      expect(options.settingSources).toEqual([]);
      expect(options.permissionMode).toBe("dontAsk");
      expect(options.allowedTools).toEqual(["Read", "Grep", "Glob"]);
      expect(options.disallowedTools).toEqual(expect.arrayContaining(["Bash", "PowerShell"]));
      expect(options.mcpServers).toEqual({});
      expect(options.persistSession).toBe(false);
    });

    it("定期実行の定義の id なら、定義のプロンプトで起動し、jobId が記録される（enabled: false でも手動なら起動する）", async () => {
      const res = await postRun({ target: { kind: "job", jobId: JOB } });
      expect(res.status).toBe(202);
      const run = await waitForRun(cookie, res.json.runId);
      expect(run).toMatchObject({ jobId: JOB, agentName: AGENT, trigger: "manual", outcome: "success" });
      expect(lastQuery().prompt.endsWith(`\n\n${JOB_PROMPT}`)).toBe(true);
      expect((await listRuns(`?jobId=${JOB}`)).json.runs.map((r) => r.runId)).toEqual([res.json.runId]);
    });

    it("余計なキー（allowedTools・model）は捨て、Agent SDK には定義のツールだけが渡る", async () => {
      const res = await postRun({ target: { kind: "agent", agent: AGENT, prompt: "p", allowedTools: ["Bash"] }, model: "it-model" });
      expect(res.status).toBe(202);
      await waitForRun(cookie, res.json.runId);
      const { options } = lastQuery();
      expect(options.allowedTools).toEqual(["Read", "Grep", "Glob"]);
      expect(options.allowedTools).not.toContain("Bash");
      expect(options).not.toHaveProperty("model");
    });

    it("要約にメールアドレス・電話番号が含まれていたら、伏せ字にして記録する（summaryRedacted=true）", async () => {
      sdk.query.mockImplementation(scripted([initMessage(), resultMessage("SUMMARY: it-person@example.com と 03-1234-5678 に連絡した")]));
      const res = await startAgent();
      const run = await waitForRun(cookie, res.json.runId);
      expect(run.summary).toBe("[redacted:email] と [redacted:phone] に連絡した");
      expect(run.summaryRedacted).toBe(true);
      expect(JSON.stringify(run)).not.toContain("it-person@example.com");
    });

    it("同じエージェントが実行中なら起動を見送り、200・accepted=false と、理由付きの skipped を記録する", async () => {
      const gate = deferred();
      sdk.query.mockImplementation(scripted([initMessage(), resultMessage("SUMMARY: 遅れて終わった")], gate.promise));
      const first = await startAgent();
      expect(first.status).toBe(202);
      await waitForRun(cookie, first.json.runId, (run) => run.status === "running");

      const second = await startAgent();
      expect(second.status).toBe(200);
      expect(second.json.accepted).toBe(false);
      const skipped = await waitForRun(cookie, second.json.runId);
      expect(skipped).toMatchObject({ outcome: "skipped", skipReason: "前回の実行が継続中のため起動を見送った", agentName: AGENT });

      gate.resolve();
      expect((await waitForRun(cookie, first.json.runId)).outcome).toBe("success");
      // リースが返り、次は起動できる
      expect((await startAgent()).status).toBe(202);
    });

    it("最終出力に SUMMARY 行が無ければ partial（invalid_response）として記録する", async () => {
      sdk.query.mockImplementation(scripted([initMessage(), resultMessage("要約の行を書き忘れた")]));
      const run = await waitForRun(cookie, (await startAgent()).json.runId);
      expect(run).toMatchObject({ outcome: "partial", failureClass: "invalid_response", summary: "エージェントは終了したが SUMMARY 行が無かった" });
    });
  });

  describe("異常系", () => {
    it("入力: 本文が JSON でなければ 400 を返し、E-15 に何も記録しない", async () => {
      const before = await runCount();
      const res = await postRun("{not json");
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "invalid body" });
      expect(await runCount()).toBe(before);
      expect(sdk.query).not.toHaveBeenCalled();
    });

    it("入力: 未知の定期実行の定義なら 400 と理由（control-plane の入力の誤り）を返し、E-15 に何も記録しない", async () => {
      const before = await runCount();
      const res = await postRun({ target: { kind: "job", jobId: "it-no-such-job" } });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "定期実行の定義が見つからない: it-no-such-job" });
      expect(await runCount()).toBe(before);
    });

    it("入力: kind が想定外（builtin を直接指定）なら 400 を返し、起動しない", async () => {
      const res = await postRun({ target: { kind: "builtin", builtin: "heartbeat" } });
      expect(res.status).toBe(400);
      expect(sdk.query).not.toHaveBeenCalled();
    });

    it("入力: エージェント名にパスを含めたら 400 を返し、main の外の定義を読まない", async () => {
      const res = await postRun({ target: { kind: "agent", agent: "../it-probe", prompt: "p" } });
      expect(res.status).toBe(400);
      expect(sdk.query).not.toHaveBeenCalled();
    });

    it("入力: main にエージェント定義が無ければ、起動せず skipped（理由付き）を記録して 200・accepted=false を返す", async () => {
      const res = await postRun({ target: { kind: "agent", agent: "it-missing", prompt: "p" } });
      expect(res.status).toBe(200);
      expect(res.json.accepted).toBe(false);
      const run = await waitForRun(cookie, res.json.runId);
      expect(run).toMatchObject({ outcome: "skipped", skipReason: "エージェント定義が見つからない: it-missing", agentName: "it-missing" });
      expect(sdk.query).not.toHaveBeenCalled();
    });

    it("空入力: プロンプトが空白だけなら 400（API の検証は通り、control-plane が拒否する）", async () => {
      const before = await runCount();
      const res = await postRun({ target: { kind: "agent", agent: AGENT, prompt: "   " } });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "プロンプトが空" });
      expect(await runCount()).toBe(before);
    });

    it("空入力: 本文が空なら 400 を返し、起動しない", async () => {
      const res = await postRun("");
      expect(res.status).toBe(400);
      expect(sdk.query).not.toHaveBeenCalled();
    });

    it("サーバ: Agent SDK が例外を投げたら、実行は failure（unreachable）として記録され、例外の文は E-15 に残らない", async () => {
      sdk.query.mockImplementation(throwing(new Error("connect ECONNREFUSED api.anthropic.com key=sk-ant-it-secret")));
      const res = await startAgent();
      expect(res.status).toBe(202);
      const run = await waitForRun(cookie, res.json.runId);
      expect(run).toMatchObject({ outcome: "failure", failureClass: "unreachable", summary: "Agent SDK が結果を返さなかった" });
      expect(leakedFragments(JSON.stringify(run), ["sk-ant-it-secret", "ECONNREFUSED"])).toEqual([]);
    });

    it("サーバ: 最後の API 呼び出しが 401 で終わったら、failure（auth_failed）として記録する", async () => {
      sdk.query.mockImplementation(
        scripted([initMessage(), resultMessage("SUMMARY: 途中まで", { is_error: true, api_error_status: 401 })]),
      );
      const run = await waitForRun(cookie, (await startAgent()).json.runId);
      expect(run).toMatchObject({ outcome: "failure", failureClass: "auth_failed", sdkSubtype: "success" });
    });

    it("サーバ: 起動時の検査で権限モードが dontAsk でなければ打ち切り、failure（invalid_response）として記録する", async () => {
      sdk.query.mockImplementation(scripted([initMessage({ permissionMode: "bypassPermissions" }), resultMessage("SUMMARY: x")]));
      const run = await waitForRun(cookie, (await startAgent()).json.runId);
      expect(run).toMatchObject({ outcome: "failure", failureClass: "invalid_response" });
      expect(run.summary).toContain("権限モードが dontAsk になっていない");
    });

    it("サーバ: 最大ターン数に達したら partial（truncated）として記録する", async () => {
      sdk.query.mockImplementation(scripted([initMessage(), resultMessage("", { subtype: "error_max_turns" })]));
      const run = await waitForRun(cookie, (await startAgent()).json.runId);
      expect(run).toMatchObject({ outcome: "partial", failureClass: "truncated", sdkSubtype: "error_max_turns" });
    });
  });
});

describe("GET /api/runs/[runId]", () => {
  describe("正常系", () => {
    it("POST が返した相関 ID で、同じ 1 件（要約・対象 ID）を引ける", async () => {
      const posted = await startAgent();
      await waitForRun(cookie, posted.json.runId);
      const res = await getRun(posted.json.runId);
      expect(res.status).toBe(200);
      expect(res.json.run).toMatchObject({ runId: posted.json.runId, summary: "確認を終えた", targetIds: ["url_path=/a", "url_path=/b"] });
    });
  });

  describe("異常系", () => {
    it("入力: 形の正しい、存在しない run_id なら 404", async () => {
      const res = await getRun("01K6PZ3T8Q4M2N7R9S5V1W3X6Y");
      expect(res.status).toBe(404);
      expect(res.json).toEqual({ error: "not found" });
    });

    it.each([
      ["小文字", "01k6pz3t8q4m2n7r9s5v1w3x6y"],
      ["25 文字", "01K6PZ3T8Q4M2N7R9S5V1W3X6"],
      ["Crockford Base32 に無い文字（U）", "01K6PZ3T8Q4M2N7R9S5V1W3X6U"],
      ["SQL を含む", "' OR 1=1 --"],
    ])("入力: 形式の不正な run_id（%s）なら 400", async (_label, runId) => {
      const res = await getRun(runId);
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "invalid run id" });
    });

    it("空入力: run_id が空文字なら 400", async () => {
      const res = await getRun("");
      expect(res.status).toBe(400);
    });
  });
});

// E-15 の障害。control-plane を作り直し、障害を起こす専用の CONTROL_DATA_DIR を使う（ほかの describe の記録を壊さない）
describe("E-15 の障害", () => {
  let brokenDir: string;

  beforeEach(() => {
    brokenDir = join(sandbox.root, `data-${Date.now()}`);
    applyEnv({ CONTROL_DATA_DIR: brokenDir });
    resetControlPlane();
  });

  afterEach(() => {
    applyEnv({ CONTROL_DATA_DIR: sandbox.dataDir });
    resetControlPlane();
  });

  describe("正常系", () => {
    it("空入力: 新しい CONTROL_DATA_DIR なら、E-15 を作って { runs: [] } を返す", async () => {
      const res = await listRuns();
      expect(res.json).toEqual({ runs: [] });
      expect(existsSync(join(brokenDir, "e15.sqlite"))).toBe(true);
    });
  });

  describe("異常系", () => {
    it("サーバ: E-15 が別の接続にロックされて書けなければ、POST は 500 を返して詳細を出さず、解除後は起動できる", async () => {
      await listRuns(); // E-15 を作る
      const locker = new DatabaseSync(join(brokenDir, "e15.sqlite"));
      locker.exec("PRAGMA busy_timeout = 0");
      locker.exec("BEGIN EXCLUSIVE");
      try {
        const res = await startAgent();
        expect(res.status).toBe(500);
        expect(res.json).toEqual({ error: "internal error" });
        expect(leakedFragments(res.text, ["locked", "SQLITE", "e15.sqlite", brokenDir])).toEqual([]);
      } finally {
        locker.exec("ROLLBACK");
        locker.close();
      }
      // 記録できなかった起動のリースは返されている（次の起動は見送られない）
      const retried = await startAgent();
      expect(retried.status).toBe(202);
      expect((await waitForRun(cookie, retried.json.runId)).outcome).toBe("success");
    });

    it("サーバ: E-15 の runs の表が壊れていたら、GET /api/runs と /api/runs/[runId] は 500 を返して詳細を出さない", async () => {
      await listRuns();
      const db = new DatabaseSync(join(brokenDir, "e15.sqlite"));
      db.exec("DROP TABLE runs");
      db.close();
      const list = await listRuns();
      expect(list.status).toBe(500);
      expect(list.json).toEqual({ error: "internal error" });
      expect(leakedFragments(list.text, ["no such table", "runs", brokenDir])).toEqual([]);
      const one = await getRun("01K6PZ3T8Q4M2N7R9S5V1W3X6Y");
      expect(one.status).toBe(500);
    });

    it("サーバ: e15.sqlite が SQLite のファイルでなければ（壊れている）、503 を返し、パスや SQLite の文を出さない", async () => {
      mkdirSync(brokenDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(brokenDir, "e15.sqlite"), "it: これは SQLite のファイルではない".repeat(200));
      const res = await listRuns();
      expect(res.status).toBe(503);
      expect(res.json).toEqual({ error: "control-plane の初期化に失敗しました（サーバーの stderr を確認してください）" });
      expect(leakedFragments(res.text, [brokenDir, "not a database", "e15.sqlite"])).toEqual([]);
      // POST も同じ理由で 503（本文の検証まで進まない）
      expect((await postRun("{not json")).status).toBe(503);
    });

    it("サーバ: control-plane の設定が不正（CONTROL_MAIN_CHECKOUT が相対パス）なら 503 で変数名と理由だけを返し、値は出さない", async () => {
      applyEnv({ CONTROL_MAIN_CHECKOUT: "it-relative/main-checkout" });
      try {
        const res = await listRuns();
        expect(res.status).toBe(503);
        expect(String(res.json.error)).toContain("CONTROL_MAIN_CHECKOUT: 絶対パスにしてください");
        expect(res.text).not.toContain("it-relative/main-checkout");
      } finally {
        applyEnv({ CONTROL_MAIN_CHECKOUT: sandbox.mainCheckout });
      }
    });
  });
});
