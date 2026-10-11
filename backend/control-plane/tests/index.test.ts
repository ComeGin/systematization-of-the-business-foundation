// AWS（CloudWatch・S3）のクライアントと送信は vi.mock で差し替え、実 AWS には繋がない。Agent SDK は ANTHROPIC_API_KEY を渡さず起動前に見送らせる。
// 基準 D の例外: createControlPlane は E-15 を CONTROL_DATA_DIR のファイルに開くため、os.tmpdir() の下の一時ディレクトリの実 SQLite を使う。
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, ControlPlaneInputError, createControlPlane } from "../src/index.js";
import { openE15Database } from "../src/store/db.js";
import { RunStore } from "../src/store/runs.js";
import { tempDir, writeAt } from "./helpers/runner.js";

const aws = vi.hoisted(() => ({
  putHeartbeat: vi.fn(async () => undefined),
  s3Send: vi.fn(async () => ({})),
}));
vi.mock("../src/integrations/aws.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/integrations/aws.js")>()),
  createCloudWatchClient: vi.fn(() => ({ send: vi.fn() })),
  createS3Client: vi.fn(() => ({ send: aws.s3Send })),
  putHeartbeat: aws.putHeartbeat,
}));

const SCHEDULES = "ops/schedules";
const AWS_ENV = { AWS_REGION: "ap-northeast-1", RUNLOG_BUCKET: "comegin-runlog" };
const MISWRITE_ENV = {
  MISWRITE_CHATWOOT_BASE_URL: "https://chat.example.test",
  MISWRITE_CHATWOOT_ACCOUNT_ID: "1",
  MISWRITE_CHATWOOT_API_TOKEN: "t",
  MISWRITE_AGENT_USER_ID: "9",
};

let root: string;
let cleanup: () => void;

const baseEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  CONTROL_DATA_DIR: join(root, "data"),
  CONTROL_MAIN_CHECKOUT: join(root, "main"),
  CONTROL_WORKTREE: join(root, "wt"),
  ...extra,
});

function writeSchedule(id: string, body: string) {
  writeAt(join(root, "main"), `${SCHEDULES}/${id}.yaml`, `id: ${id}\n${body}`);
}

function seedRun(runId: string, finish: boolean) {
  const runs = new RunStore(openE15Database(join(root, "data")));
  runs.insertRunning({ runId, jobId: null, agentName: "seo-auditor", builtin: null, trigger: "manual", startedAt: "2026-10-04T06:00:00.000+09:00" });
  if (finish) {
    runs.finish(runId, {
      finishedAt: "2026-10-04T06:01:00.000+09:00",
      outcome: "success",
      summary: "s",
      summaryRedacted: false,
      targetIds: [],
      skipReason: null,
      failureClass: null,
      sdkSubtype: null,
      costUsd: null,
    });
  }
}

beforeEach(() => {
  ({ dir: root, cleanup } = tempDir("cp-index-"));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const logged = () => vi.mocked(console.error).mock.calls.map((call) => String(call[0])).join("\n");

describe("createControlPlane", () => {
  describe("正常系", () => {
    it("E-15 を CONTROL_DATA_DIR に開く（作業ツリーの外の置き場）", () => {
      createControlPlane({ env: baseEnv() });
      expect(existsSync(join(root, "data", "e15.sqlite"))).toBe(true);
    });

    it("空入力: 空の E-15 では未知の run は null、run と候補の一覧は空", async () => {
      const plane = createControlPlane({ env: baseEnv() });
      expect(await plane.getRun("01K6PZ3T8Q4M2N7R9S5V1W3X6Y")).toBeNull();
      expect(await plane.listRuns()).toEqual([]);
      expect(await plane.listMiswriteCandidates()).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: 環境変数が不正なら ConfigError で、変数名だけを出して値を出さない", () => {
      let error: unknown;
      try {
        createControlPlane({ env: baseEnv({ GITHUB_TOKEN: "ghp_secret_value_123" }) });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain("GITHUB_REPOSITORY");
      expect((error as Error).message).not.toContain("ghp_secret_value_123");
      expect(logged()).not.toContain("ghp_secret_value_123");
    });

    it("空入力: 環境変数が空なら、E-15 を開く前に ConfigError（必須の変数名を出す）", () => {
      // 設定の検証は E-15 を開く前に行う（未設定なら ~/.local/share の既定の置き場を作ってしまうため、ここで止まることが大事）
      expect(() => createControlPlane({ env: {} })).toThrow(ConfigError);
      expect(logged()).toContain("CONTROL_MAIN_CHECKOUT");
      expect(logged()).toContain("CONTROL_WORKTREE");
    });

    it("サーバ: CONTROL_DATA_DIR に E-15 を作れなければ（途中がファイル）例外を投げる", () => {
      writeFileSync(join(root, "blocker"), "x");
      expect(() => createControlPlane({ env: baseEnv({ CONTROL_DATA_DIR: join(root, "blocker", "data") }) })).toThrow(
        /ENOTDIR|EEXIST/,
      );
    });
  });
});

describe("runNow", () => {
  describe("正常系", () => {
    it("20,000 文字ちょうどは受け付ける（ANTHROPIC_API_KEY が無ければ見送りの記録になる）", async () => {
      const plane = createControlPlane({ env: baseEnv() });
      const result = await plane.runNow({ target: { kind: "agent", agent: "seo-auditor", prompt: "あ".repeat(20_000) } });
      expect(result.accepted).toBe(false);
      expect(await plane.getRun(result.runId)).toMatchObject({
        outcome: "skipped",
        trigger: "manual",
        skipReason: "設定が無いため見送った（ANTHROPIC_API_KEY）",
      });
    });

    it("enabled: false の定義も手動では起動できる", async () => {
      writeSchedule("manual-only", 'enabled: false\ncron: "0 6 * * *"\nkind: builtin\nbuiltin: published-article-check\n');
      const plane = createControlPlane({ env: baseEnv() });
      const result = await plane.runNow({ target: { kind: "job", jobId: "manual-only" } });
      expect(result.accepted).toBe(true);
      await vi.waitFor(async () => expect((await plane.getRun(result.runId))?.status).toBe("finished"));
      expect(await plane.getRun(result.runId)).toMatchObject({ jobId: "manual-only", trigger: "manual", outcome: "skipped" });
    });

    it("プロンプトの前後の空白は長さの上限に数えない（落としてから数える）", async () => {
      const plane = createControlPlane({ env: baseEnv() });
      const result = await plane.runNow({ target: { kind: "agent", agent: "seo-auditor", prompt: `  ${"あ".repeat(20_000)}  ` } });
      expect(await plane.getRun(result.runId)).toMatchObject({ trigger: "manual", agentName: "seo-auditor", outcome: "skipped" });
    });
    it("手動の起動は定義を毎回読み直す（キャッシュの古い定義で起動しない）", async () => {
      const plane = createControlPlane({ env: baseEnv() });
      expect(await plane.listJobs()).toEqual([]);
      writeSchedule("added", 'enabled: true\ncron: "0 6 * * *"\nkind: builtin\nbuiltin: published-article-check\n');
      expect((await plane.runNow({ target: { kind: "job", jobId: "added" } })).accepted).toBe(true);
    });
  });

  describe("異常系", () => {
    it.each(["../seo-auditor", "Seo-Auditor", "seo_auditor"])("入力: エージェント名 %j は ControlPlaneInputError", async (agent) => {
      const plane = createControlPlane({ env: baseEnv() });
      await expect(plane.runNow({ target: { kind: "agent", agent, prompt: "p" } })).rejects.toBeInstanceOf(ControlPlaneInputError);
    });

    it("空入力: エージェント名が空文字なら ControlPlaneInputError で、E-15 に記録しない", async () => {
      const plane = createControlPlane({ env: baseEnv() });
      await expect(plane.runNow({ target: { kind: "agent", agent: "", prompt: "p" } })).rejects.toThrow(
        new ControlPlaneInputError("エージェント名が不正"),
      );
      expect(await plane.listRuns()).toEqual([]);
    });

    it("空入力: プロンプトが空白だけなら ControlPlaneInputError", async () => {
      const plane = createControlPlane({ env: baseEnv() });
      await expect(plane.runNow({ target: { kind: "agent", agent: "seo-auditor", prompt: "  \n " } })).rejects.toThrow("プロンプトが空");
      await expect(plane.runNow({ target: { kind: "agent", agent: "seo-auditor", prompt: "" } })).rejects.toBeInstanceOf(
        ControlPlaneInputError,
      );
      expect(await plane.listRuns()).toEqual([]);
    });

    it("入力: プロンプトが 20,000 文字を超えるなら ControlPlaneInputError", async () => {
      const plane = createControlPlane({ env: baseEnv() });
      await expect(plane.runNow({ target: { kind: "agent", agent: "seo-auditor", prompt: "あ".repeat(20_001) } })).rejects.toThrow(
        "プロンプトが長すぎる",
      );
      expect(await plane.listRuns()).toEqual([]);
    });

    it("入力: 定義が見つからない jobId は ControlPlaneInputError", async () => {
      const plane = createControlPlane({ env: baseEnv() });
      await expect(plane.runNow({ target: { kind: "job", jobId: "missing" } })).rejects.toBeInstanceOf(ControlPlaneInputError);
    });

    it("空入力: jobId が空文字なら ControlPlaneInputError", async () => {
      writeSchedule("daily", 'enabled: true\ncron: "0 6 * * *"\nkind: builtin\nbuiltin: silence-check\n');
      const plane = createControlPlane({ env: baseEnv() });
      await expect(plane.runNow({ target: { kind: "job", jobId: "" } })).rejects.toBeInstanceOf(ControlPlaneInputError);
      expect(await plane.listRuns()).toEqual([]);
    });

  });
});

describe("listJobs", () => {
  describe("正常系", () => {
    beforeEach(() => {
      writeSchedule("daily-seo", 'enabled: true\ncron: "0 6 * * *"\nkind: agent\nagent: seo-auditor\nprompt: "内部のプロンプト"\n');
      writeSchedule("off-job", 'enabled: false\ncron: "0 7 * * *"\nkind: builtin\nbuiltin: silence-check\n');
    });

    it("定義からプロンプトを除いて返す", async () => {
      const jobs = await createControlPlane({ env: baseEnv() }).listJobs();
      expect(jobs.map((job) => job.definition.id)).toEqual(["daily-seo", "off-job"]);
      for (const job of jobs) expect(job.definition).not.toHaveProperty("prompt");
      expect(JSON.stringify(jobs)).not.toContain("内部のプロンプト");
    });

    it("nextRunAt はスケジューラが有効で enabled のジョブだけ", async () => {
      const off = await createControlPlane({ env: baseEnv() }).listJobs();
      expect(off.map((job) => job.nextRunAt)).toEqual([null, null]);
      const on = await createControlPlane({ env: baseEnv({ CONTROL_SCHEDULER_ENABLED: "true" }) }).listJobs();
      expect(on[0]!.nextRunAt).toMatch(/T06:00:00\.000\+09:00$/);
      expect(on[1]!.nextRunAt).toBeNull();
    });

    it("lastRun にそのジョブの最新の run を入れる", async () => {
      const plane = createControlPlane({ env: baseEnv() });
      const { runId } = await plane.runNow({ target: { kind: "job", jobId: "daily-seo" } });
      const jobs = await plane.listJobs();
      expect(jobs[0]!.lastRun?.runId).toBe(runId);
      expect(jobs[1]!.lastRun).toBeNull();
    });

    it("空入力: 定義のディレクトリが無ければ空の配列", async () => {
      expect(await createControlPlane({ env: baseEnv({ CONTROL_MAIN_CHECKOUT: join(root, "empty-main") }) }).listJobs()).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: 壊れた定義ファイルは一覧から除き、正しい定義だけを返す", async () => {
      writeSchedule("good", 'enabled: true\ncron: "0 6 * * *"\nkind: builtin\nbuiltin: silence-check\n');
      writeSchedule("bad", 'enabled: true\ncron: "every day"\nkind: builtin\nbuiltin: silence-check\n');
      const jobs = await createControlPlane({ env: baseEnv() }).listJobs();
      expect(jobs.map((job) => job.definition.id)).toEqual(["good"]);
    });
  });
});

describe("start / stop", () => {
  describe("正常系", () => {
    it("前回のプロセスで running のまま残った run を failure（timeout）に確定する", async () => {
      seedRun("01K6PZ3T8Q4M2N7R9S5V1W3X6A", false);
      const plane = createControlPlane({ env: baseEnv() });
      await plane.start();
      expect(await plane.getRun("01K6PZ3T8Q4M2N7R9S5V1W3X6A")).toMatchObject({
        status: "finished",
        outcome: "failure",
        failureClass: "timeout",
        summary: "プロセスの停止または再起動で中断された",
      });
      await plane.stop();
    });

    it("持ち主が他のプロセスで生きている running は触らない", async () => {
      seedRun("01K6PZ3T8Q4M2N7R9S5V1W3X6A", false);
      const db = openE15Database(join(root, "data"));
      db.prepare("INSERT INTO leases (lease_key, run_id, pid, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(
        "job:x",
        "01K6PZ3T8Q4M2N7R9S5V1W3X6A",
        process.ppid,
        Date.now(),
        Date.now() + 3_600_000,
      );
      const plane = createControlPlane({ env: baseEnv() });
      await plane.start();
      expect((await plane.getRun("01K6PZ3T8Q4M2N7R9S5V1W3X6A"))!.status).toBe("running");
      await plane.stop();
    });

    it("AWS が設定されていれば、起動時と 5 分ごとにハートビートを送り、E-15 には記録しない", async () => {
      vi.useFakeTimers();
      const plane = createControlPlane({ env: baseEnv(AWS_ENV) });
      await plane.start();
      await plane.start(); // 冪等
      expect(aws.putHeartbeat).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(aws.putHeartbeat).toHaveBeenCalledTimes(2);
      expect(await plane.listRuns()).toEqual([]);

      await plane.stop();
      await plane.stop(); // 冪等
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(aws.putHeartbeat).toHaveBeenCalledTimes(2);
    });

    it("空入力: AWS が無ければハートビートを送らない", async () => {
      vi.useFakeTimers();
      const plane = createControlPlane({ env: baseEnv() });
      await plane.start();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(aws.putHeartbeat).not.toHaveBeenCalled();
      await plane.stop();
    });

    it("起動時に未送の写しを S3 へ送り直す", async () => {
      seedRun("01K6PZ3T8Q4M2N7R9S5V1W3X6A", true);
      const plane = createControlPlane({ env: baseEnv(AWS_ENV) });
      await plane.start();
      await vi.waitFor(async () => expect((await plane.getRun("01K6PZ3T8Q4M2N7R9S5V1W3X6A"))!.copiedAt).not.toBeNull());
      expect(aws.s3Send).toHaveBeenCalledTimes(1);
      await plane.stop();
    });

    it("CONTROL_SCHEDULER_ENABLED=true のときだけ定期実行を起動する", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-04T20:59:00Z")); // 日本時間 05:59
      writeSchedule("check", 'enabled: true\ncron: "0 6 * * *"\nkind: builtin\nbuiltin: published-article-check\n');

      const off = createControlPlane({ env: baseEnv() });
      await off.start();
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(await off.listRuns()).toEqual([]);
      await off.stop();

      vi.setSystemTime(new Date("2026-10-05T20:59:00Z"));
      const on = createControlPlane({ env: baseEnv({ CONTROL_SCHEDULER_ENABLED: "true" }) });
      await on.start();
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(await on.listRuns()).toEqual([expect.objectContaining({ jobId: "check", trigger: "schedule", outcome: "skipped" })]);
      await on.stop();
    });

    it("空入力: start せずに stop しても何もしない（落ちない）", async () => {
      const plane = createControlPlane({ env: baseEnv() });
      await expect(plane.stop()).resolves.toBeUndefined();
      expect(logged()).not.toContain("停止");
    });

    // 回帰: stop() が started のときだけ動いていたため、start() の前に runNow で起動した実行は打ち切られず running のまま残った
    it("start() の前に runNow で起動した実行も、stop() で打ち切って failure（timeout）に確定する", async () => {
      writeSchedule("check", 'enabled: false\ncron: "15 7 * * *"\nkind: builtin\nbuiltin: miswrite-check\n');
      // Chatwoot の読み取りは応答せず、打ち切りの signal で初めて終わる
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) =>
              init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }),
            ),
        ),
      );
      const plane = createControlPlane({ env: baseEnv(MISWRITE_ENV) });
      const { runId, accepted } = await plane.runNow({ target: { kind: "job", jobId: "check" } });
      expect(accepted).toBe(true);
      expect((await plane.getRun(runId))!.status).toBe("running");

      await plane.stop();
      expect(await plane.getRun(runId)).toMatchObject({ status: "finished", outcome: "failure", failureClass: "timeout" });
    });
  });

  describe("異常系", () => {
    it("サーバ: ハートビートの送信（CloudWatch）が失敗しても start は成功し、ログには例外の名前だけを出す", async () => {
      aws.putHeartbeat.mockRejectedValueOnce(Object.assign(new Error("AccessDenied for AKIASECRETVALUE"), { name: "AccessDeniedException" }));
      const plane = createControlPlane({ env: baseEnv(AWS_ENV) });
      await expect(plane.start()).resolves.toBeUndefined();
      await vi.waitFor(() => expect(logged()).toContain("ハートビートの送信に失敗: AccessDeniedException"));
      expect(logged()).not.toContain("AKIASECRETVALUE");
      await plane.stop();
    });

    it("サーバ: 起動時の S3 への再送が失敗しても start は成功し、未送のまま E-15 に残す", async () => {
      seedRun("01K6PZ3T8Q4M2N7R9S5V1W3X6A", true);
      aws.s3Send.mockRejectedValue(Object.assign(new Error("connect ETIMEDOUT"), { name: "TimeoutError" }));
      const plane = createControlPlane({ env: baseEnv(AWS_ENV) });
      await expect(plane.start()).resolves.toBeUndefined();
      await vi.waitFor(() => expect(aws.s3Send).toHaveBeenCalled());
      await plane.stop();
      expect((await plane.getRun("01K6PZ3T8Q4M2N7R9S5V1W3X6A"))!.copiedAt).toBeNull();
    });

    it("サーバ: スケジューラの初回の定義の読み込みに失敗したら start は reject する", async () => {
      // 定義のディレクトリの場所にファイルを置く（readdir が ENOTDIR）
      writeAt(join(root, "main"), SCHEDULES, "not a directory");
      const plane = createControlPlane({ env: baseEnv({ CONTROL_SCHEDULER_ENABLED: "true" }) });
      await expect(plane.start()).rejects.toThrow(/ENOTDIR/);
      await plane.stop();
    });
  });
});
