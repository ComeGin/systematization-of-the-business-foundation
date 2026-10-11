// 結合テスト: 沈黙の検出（silence-check）。E-15（エージェントの run）と作業ツリーの docs/audits/<source>/ の当日分、
// main の定期実行の定義（起動の窓）を照合する。エージェントの run は Agent SDK を差し替えて作り、成果物は差し替えた SDK の中で書く。
// 開発スタックには繋がない（照合は E-15 とファイルだけで決まる）。
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAws } from "./helpers/aws-mock.js";
import { init, resetSdk, result, script } from "./helpers/agent-sdk.js";
import {
  AUDITS_DIR,
  DUMMY_ANTHROPIC_KEY,
  type Fixture,
  Planes,
  captureLogs,
  createFixture,
  jstToday,
  waitFinished,
  writeAgent,
  writeAt,
  writeSchedule,
} from "./helpers/fixtures.js";

vi.mock("@aws-sdk/client-s3", () => import("./helpers/aws-mock.js").then((m) => m.s3Module));
vi.mock("@aws-sdk/client-cloudwatch", () => import("./helpers/aws-mock.js").then((m) => m.cloudWatchModule));
vi.mock("@anthropic-ai/claude-agent-sdk", () => import("./helpers/agent-sdk.js").then((m) => m.sdkModule));

/** 0 時（日本時間）に起動するはずのジョブ。猶予 10 分を過ぎてから判定する */
const MIDNIGHT_JOB = 'enabled: true\ncron: "0 0 * * *"\nkind: builtin\nbuiltin: published-article-check\n';
const midnightJudgeable = () => jstToday().minutes >= 11;

let fx: Fixture;
let planes: Planes;

beforeEach(() => {
  fx = createFixture("cp-it-silence-");
  planes = new Planes();
  captureLogs();
  resetAws();
  resetSdk();
  // silence-check 自身は手動で起動するだけ（enabled: false。自分の未起動を数えない）
  writeSchedule(fx, "it-silence-check", 'enabled: false\ncron: "30 9 * * *"\nkind: builtin\nbuiltin: silence-check\n');
  writeAgent(fx, "seo-auditor", ["Read", "Write", "Glob"]);
});

afterEach(async () => {
  await planes.stopAll();
  fx.cleanup();
});

async function runJob(plane: ReturnType<Planes["create"]>, jobId: string) {
  const { runId } = await plane.runNow({ target: { kind: "job", jobId } });
  return waitFinished(plane, runId);
}

/** seo-auditor の run を 1 件 success で終わらせる。auditFile を渡せば、実行中に作業ツリーへ成果物を書く */
async function seoAuditorRun(plane: ReturnType<Planes["create"]>, auditFile?: string) {
  script([
    init(),
    async () => {
      if (auditFile) writeAt(fx.worktree, `${AUDITS_DIR}/gsc/${auditFile}`, "---\naudit_id: x\n---\n");
    },
    result("SUMMARY: 監査を書いた"),
  ]);
  const { runId } = await plane.runNow({ target: { kind: "agent", agent: "seo-auditor", prompt: "p" } });
  expect(await waitFinished(plane, runId)).toMatchObject({ outcome: "success" });
}

describe("silence-check（沈黙の検出）", () => {
  describe("正常系", () => {
    it("success のエージェントに当日の成果物があれば、沈黙なしの success", async () => {
      const plane = planes.create(fx.env({ ANTHROPIC_API_KEY: DUMMY_ANTHROPIC_KEY }));
      await seoAuditorRun(plane, `AUD-${jstToday().auditKey}-gsc-0001.md`);
      expect(await runJob(plane, "it-silence-check")).toMatchObject({
        outcome: "success",
        summary: "沈黙の疑いは見つからなかった",
        targetIds: [],
      });
    });

    it("success のエージェントの当日の成果物が docs/audits に無ければ「成果物なし」を partial で出す（エージェント名だけ）", async () => {
      const plane = planes.create(fx.env({ ANTHROPIC_API_KEY: DUMMY_ANTHROPIC_KEY }));
      await seoAuditorRun(plane);
      expect(await runJob(plane, "it-silence-check")).toMatchObject({
        outcome: "partial",
        summary: "沈黙の疑い 1 件: 成果物なし: seo-auditor",
        targetIds: ["agent:seo-auditor"],
      });
    });

    it("スケジューラが有効で、enabled のジョブの起動の窓に run が 1 件も無ければ「未起動」を出す", async () => {
      if (!midnightJudgeable()) return; // 0 時台の最初の 10 分は猶予の内側で判定できない
      writeSchedule(fx, "it-midnight", MIDNIGHT_JOB);
      const plane = planes.create(fx.env({ CONTROL_SCHEDULER_ENABLED: "true" }));
      expect(await runJob(plane, "it-silence-check")).toMatchObject({
        outcome: "partial",
        summary: "沈黙の疑い 1 件: 未起動: it-midnight（00:00）",
        targetIds: ["job:it-midnight"],
      });
    });

    it("手動の run（skipped を含む）も、そのジョブの起動の窓に数える", async () => {
      if (!midnightJudgeable()) return;
      writeSchedule(fx, "it-midnight", MIDNIGHT_JOB);
      const plane = planes.create(fx.env({ CONTROL_SCHEDULER_ENABLED: "true" }));
      expect(await runJob(plane, "it-midnight")).toMatchObject({ trigger: "manual", outcome: "skipped" });
      expect(await runJob(plane, "it-silence-check")).toMatchObject({ outcome: "success" });
    });

    it("スケジューラが無効なら、起動の窓（未起動）は判定しない", async () => {
      writeSchedule(fx, "it-midnight", MIDNIGHT_JOB);
      const plane = planes.create(fx.env());
      expect(await runJob(plane, "it-silence-check")).toMatchObject({ outcome: "success" });
    });

    it("空入力: E-15 が空で、enabled のジョブも無ければ success", async () => {
      const plane = planes.create(fx.env({ CONTROL_SCHEDULER_ENABLED: "true" }));
      expect(await runJob(plane, "it-silence-check")).toMatchObject({ outcome: "success", summary: "沈黙の疑いは見つからなかった" });
    });
  });

  describe("異常系", () => {
    it("入力: 前日の日付の成果物は当日分に数えない（成果物なしとして出す）", async () => {
      const plane = planes.create(fx.env({ ANTHROPIC_API_KEY: DUMMY_ANTHROPIC_KEY }));
      await seoAuditorRun(plane, `AUD-${jstToday(new Date(Date.now() - 24 * 60 * 60 * 1000)).auditKey}-gsc-0001.md`);
      expect(await runJob(plane, "it-silence-check")).toMatchObject({ outcome: "partial", targetIds: ["agent:seo-auditor"] });
    });

    it("入力: failure で終わったエージェントの run は、成果物の照合に使わない", async () => {
      script([init(), result("途中で止まった", { is_error: true, api_error_status: 500 })]);
      const plane = planes.create(fx.env({ ANTHROPIC_API_KEY: DUMMY_ANTHROPIC_KEY }));
      const { runId } = await plane.runNow({ target: { kind: "agent", agent: "seo-auditor", prompt: "p" } });
      expect(await waitFinished(plane, runId)).toMatchObject({ outcome: "failure" });
      expect(await runJob(plane, "it-silence-check")).toMatchObject({ outcome: "success" });
    });

    it("サーバ: docs/audits/<source> が読めない（権限が無い）なら、内部エラーの failure にして他の記録は変えない", async () => {
      const plane = planes.create(fx.env({ ANTHROPIC_API_KEY: DUMMY_ANTHROPIC_KEY }));
      await seoAuditorRun(plane, `AUD-${jstToday().auditKey}-gsc-0001.md`);
      const dir = join(fx.worktree, AUDITS_DIR, "gsc");
      chmodSync(dir, 0o000);
      try {
        expect(await runJob(plane, "it-silence-check")).toMatchObject({ outcome: "failure", summary: "実行中に内部エラーが発生した" });
      } finally {
        chmodSync(dir, 0o755);
      }
      const [silence, agent] = await plane.listRuns();
      expect(silence).toMatchObject({ builtin: "silence-check", outcome: "failure" });
      expect(agent).toMatchObject({ agentName: "seo-auditor", outcome: "success" });
    });
  });
});
