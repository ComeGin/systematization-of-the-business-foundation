// 結合テスト: 定期実行（定義の読み込み → スケジューラ → リース → 実行 → E-15 の記録）と、E-15 の S3 への写し・ハートビート。
// 公開の入口 createControlPlane から、一時ディレクトリの main のチェックアウト（ops/schedules）・作業ツリー・E-15 の SQLite までを本物でつなぐ。
// 差し替えるのは AWS SDK（S3・CloudWatch）と Agent SDK だけ（開発時は AWS に繋がない）。開発スタックには繋がない（builtin は silence-check などの外に出ないもの）。
// スケジューラの「毎分」の起動は、偽物のタイマー（Date を含む）で 1 分進めて起こす（croner は setTimeout で次の起動を待つ）。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneInputError } from "../src/index.js";
import { ULID_PATTERN } from "../src/ulid.js";
import { aws, awsError, putObjects, resetAws } from "./helpers/aws-mock.js";
import { resetSdk, sdk } from "./helpers/agent-sdk.js";
import { type Fixture, Planes, captureLogs, createFixture, waitFinished, writeAt, writeSchedule } from "./helpers/fixtures.js";

vi.mock("@aws-sdk/client-s3", () => import("./helpers/aws-mock.js").then((m) => m.s3Module));
vi.mock("@aws-sdk/client-cloudwatch", () => import("./helpers/aws-mock.js").then((m) => m.cloudWatchModule));
vi.mock("@anthropic-ai/claude-agent-sdk", () => import("./helpers/agent-sdk.js").then((m) => m.sdkModule));

const AWS_ENV = { AWS_REGION: "ap-northeast-1", RUNLOG_BUCKET: "it-comegin-runlog", HEARTBEAT_NAMESPACE: "ComeGin/IT" };
// 毎分のジョブは heartbeat（定義から起動したときだけ E-15 に記録される）。silence-check を毎分にすると、当日の過去の毎分を「未起動」として検出してしまう
const EVERY_MINUTE = 'enabled: true\ncron: "* * * * *"\nkind: builtin\nbuiltin: heartbeat\ntimeout_sec: 60\n';
const DAILY_SILENCE = 'enabled: true\ncron: "0 6 * * *"\nkind: builtin\nbuiltin: silence-check\n';
const RUNLOG_FLUSH = 'enabled: false\ncron: "*/10 * * * *"\nkind: builtin\nbuiltin: runlog-flush\n';

let fx: Fixture;
let planes: Planes;
let logs: () => string;

beforeEach(() => {
  fx = createFixture("cp-it-schedule-");
  planes = new Planes();
  logs = captureLogs();
  resetAws();
  resetSdk();
});

afterEach(async () => {
  vi.useRealTimers();
  await planes.stopAll();
  fx.cleanup();
});

/** 偽物のタイマーで 1 分と少し進め、スケジューラの毎分の起動を 1 回起こす */
async function fireOneMinute(): Promise<void> {
  await vi.advanceTimersByTimeAsync(61_000);
}

describe("スケジューラによる定期実行 1 回分", () => {
  describe("正常系", () => {
    it("main の定義 → 起動 → E-15 に schedule の run（相関 ID は ULID）を確定し、S3 に写して印を付ける", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
      writeSchedule(fx, "it-every-minute", EVERY_MINUTE);
      const plane = planes.create(fx.env({ CONTROL_SCHEDULER_ENABLED: "true", ...AWS_ENV }));
      await plane.start();
      expect(await plane.listRuns()).toEqual([]);

      await fireOneMinute();
      const run = await vi.waitFor(async () => {
        const [latest] = await plane.listRuns({ jobId: "it-every-minute" });
        if (latest?.status !== "finished") throw new Error("まだ確定していない");
        return latest;
      });

      expect(run.runId).toMatch(ULID_PATTERN);
      expect(run).toMatchObject({
        jobId: "it-every-minute",
        builtin: "heartbeat",
        agentName: null,
        trigger: "schedule",
        outcome: "success",
        summary: "ハートビートを送信した",
        summaryRedacted: false,
        targetIds: [],
        failureClass: null,
      });
      expect(run.startedAt).toMatch(/\+09:00$/);

      // 終了時の写し: runs/YYYY/MM/DD/<ULID>.json（日付は startedAt の日本時間）に、If-None-Match: * の単発の PutObject
      const [put] = putObjects();
      const day = run.startedAt.slice(0, 10).split("-").join("/");
      expect(put).toMatchObject({
        Bucket: "it-comegin-runlog",
        Key: `runs/${day}/${run.runId}.json`,
        IfNoneMatch: "*",
        ContentType: "application/json",
      });
      expect(JSON.parse(String(put!.Body))).toMatchObject({ runId: run.runId, status: "finished", outcome: "success", copiedAt: null });
      await vi.waitFor(async () => expect((await plane.getRun(run.runId))?.copiedAt).toMatch(/\+09:00$/));
      // 起動時の 1 回（内部のタイマー）と、定義から起動した 1 回
      expect(aws.cloudWatchSend).toHaveBeenCalledTimes(2);
      // builtin だけなので Agent SDK は起動しない
      expect(sdk.query).not.toHaveBeenCalled();
    });

    it("start でハートビートを CloudWatch に送り、ハートビートは E-15 に記録しない", async () => {
      const plane = planes.create(fx.env(AWS_ENV));
      await plane.start();
      await vi.waitFor(() => expect(aws.cloudWatchSend).toHaveBeenCalledTimes(1));
      const [command] = aws.cloudWatchSend.mock.calls[0]!;
      expect(command.command).toBe("PutMetricData");
      expect(command.input).toMatchObject({ Namespace: "ComeGin/IT", MetricData: [{ MetricName: "Heartbeat", Value: 1, Unit: "Count" }] });
      expect(await plane.listRuns()).toEqual([]);
    });

    it("listJobs は main の定義だけを返し、作業ツリーの ops/schedules は読まない（ADR-18）", async () => {
      writeSchedule(fx, "it-daily-silence", DAILY_SILENCE);
      writeAt(fx.worktree, "ops/schedules/it-unapproved.yaml", `id: it-unapproved\n${DAILY_SILENCE}`);
      const plane = planes.create(fx.env({ CONTROL_SCHEDULER_ENABLED: "true" }));
      const jobs = await plane.listJobs();
      expect(jobs.map((job) => job.definition.id)).toEqual(["it-daily-silence"]);
      expect(jobs[0]!.nextRunAt).toMatch(/T06:00:00\.000\+09:00$/);
      await expect(plane.runNow({ target: { kind: "job", jobId: "it-unapproved" } })).rejects.toBeInstanceOf(ControlPlaneInputError);
    });

    it("空入力: 定義が 0 件ならスケジューラは何も起動せず、一覧も空", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
      const plane = planes.create(fx.env({ CONTROL_SCHEDULER_ENABLED: "true" }));
      await plane.start();
      await fireOneMinute();
      expect(await plane.listJobs()).toEqual([]);
      expect(await plane.listRuns()).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: YAML の型違い（timeout_sec が文字列）の定義は登録せず、起動も記録もしない（理由はファイル名と項目名だけをログに出す）", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
      writeSchedule(fx, "it-broken", 'enabled: true\ncron: "* * * * *"\nkind: builtin\nbuiltin: silence-check\ntimeout_sec: "sixty"\n');
      const plane = planes.create(fx.env({ CONTROL_SCHEDULER_ENABLED: "true" }));
      await plane.start();
      await fireOneMinute();

      expect(await plane.listJobs()).toEqual([]);
      expect(await plane.listRuns()).toEqual([]);
      expect(logs()).toMatch(/WARN schedules it-broken\.yaml を読み込めない: timeout_sec:/);
      await expect(plane.runNow({ target: { kind: "job", jobId: "it-broken" } })).rejects.toBeInstanceOf(ControlPlaneInputError);
    });

    it("入力: kind=agent なのに prompt が無い定義は登録しない", async () => {
      writeSchedule(fx, "it-no-prompt", 'enabled: true\ncron: "0 6 * * *"\nkind: agent\nagent: seo-auditor\n');
      const plane = planes.create(fx.env());
      expect(await plane.listJobs()).toEqual([]);
      expect(logs()).toContain("prompt: kind=agent では必須です");
    });

    it("入力: after の前提が当日に success していなければ、定期実行は skipped（理由に前提の id）として記録する", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
      writeSchedule(fx, "it-after", `${EVERY_MINUTE}after: [it-never-ran]\n`);
      const plane = planes.create(fx.env({ CONTROL_SCHEDULER_ENABLED: "true", ...AWS_ENV }));
      await plane.start();
      await fireOneMinute();
      const [run] = await vi.waitFor(async () => {
        const runs = await plane.listRuns({ jobId: "it-after" });
        if (runs.length === 0) throw new Error("まだ記録が無い");
        return runs;
      });
      expect(run).toMatchObject({
        trigger: "schedule",
        status: "finished",
        outcome: "skipped",
        skipReason: "after が未達（当日に success が無い: it-never-ran）",
      });
    });

    it("入力: builtin に必要な設定（I-13 の GitHub）が無ければ、起動せずに skipped（理由は変数名だけ）", async () => {
      writeSchedule(fx, "it-i13", 'enabled: false\ncron: "0 6 * * *"\nkind: builtin\nbuiltin: i13-file\n');
      const plane = planes.create(fx.env());
      const accepted = await plane.runNow({ target: { kind: "job", jobId: "it-i13" } });
      expect(accepted.accepted).toBe(false);
      expect(await plane.getRun(accepted.runId)).toMatchObject({
        trigger: "manual",
        outcome: "skipped",
        skipReason: "設定が無いため見送った（GITHUB_TOKEN, GITHUB_REPOSITORY, I13_ISSUE_NUMBER, I13_REVIEWER）",
      });
    });

    it("空入力: lighthouse は main のチェックアウトに node_modules が無ければ子プロセスを起動せずに skipped", async () => {
      writeSchedule(fx, "it-lighthouse", 'enabled: false\ncron: "0 5 * * 1"\nkind: builtin\nbuiltin: lighthouse\n');
      const plane = planes.create(fx.env());
      const { runId } = await plane.runNow({ target: { kind: "job", jobId: "it-lighthouse" } });
      expect(await waitFinished(plane, runId)).toMatchObject({ outcome: "skipped", skipReason: "dependencies not installed" });
    });

    it("サーバ: ハートビートの送信が例外でも start は成功し、ログには例外の名前だけを出す", async () => {
      aws.cloudWatchSend.mockRejectedValue(awsError("AccessDeniedException", 403, "denied for arn:aws:iam::123456789012:user/it"));
      const plane = planes.create(fx.env(AWS_ENV));
      await expect(plane.start()).resolves.toBeUndefined();
      await vi.waitFor(() => expect(logs()).toContain("ハートビートの送信に失敗: AccessDeniedException"));
      expect(logs()).not.toContain("123456789012");
    });
  });
});

describe("E-15 の S3 への写し", () => {
  describe("正常系", () => {
    it("runlog-flush は未送の run を古い順に写し、写した run に copiedAt を付ける", async () => {
      aws.s3Send.mockRejectedValue(awsError("ServiceUnavailable", 503));
      writeSchedule(fx, "it-daily-silence", DAILY_SILENCE);
      writeSchedule(fx, "it-runlog-flush", RUNLOG_FLUSH);
      const plane = planes.create(fx.env(AWS_ENV));
      const first = await waitFinished(plane, (await plane.runNow({ target: { kind: "job", jobId: "it-daily-silence" } })).runId);
      const second = await waitFinished(plane, (await plane.runNow({ target: { kind: "job", jobId: "it-daily-silence" } })).runId);
      expect([first.copiedAt, second.copiedAt]).toEqual([null, null]);

      resetAws();
      const flush = await waitFinished(plane, (await plane.runNow({ target: { kind: "job", jobId: "it-runlog-flush" } })).runId);
      expect(flush).toMatchObject({ builtin: "runlog-flush", outcome: "success", summary: "S3 への写し: 送信 2 件（写し済み 0 件）" });
      // 古い順に 2 件。3 件目は runlog-flush 自身の run（終了時の写し）
      expect(putObjects().map((put) => String(put.Key).split("/").at(-1))).toEqual([
        `${first.runId}.json`,
        `${second.runId}.json`,
        `${flush.runId}.json`,
      ]);
      expect((await plane.getRun(first.runId))?.copiedAt).not.toBeNull();
      expect((await plane.getRun(second.runId))?.copiedAt).not.toBeNull();
    });

    it("412（同じキーが既にある）は写し済みとして印だけ付ける", async () => {
      aws.s3Send.mockRejectedValue(awsError("PreconditionFailed", 412));
      writeSchedule(fx, "it-daily-silence", DAILY_SILENCE);
      const plane = planes.create(fx.env(AWS_ENV));
      const { runId } = await plane.runNow({ target: { kind: "job", jobId: "it-daily-silence" } });
      await waitFinished(plane, runId);
      await vi.waitFor(async () => expect((await plane.getRun(runId))?.copiedAt).not.toBeNull());
    });

    it("空入力: AWS を設定しなければ写しを試みず、E-15 には記録が残る", async () => {
      writeSchedule(fx, "it-daily-silence", DAILY_SILENCE);
      const plane = planes.create(fx.env());
      const run = await waitFinished(plane, (await plane.runNow({ target: { kind: "job", jobId: "it-daily-silence" } })).runId);
      expect(run).toMatchObject({ outcome: "success", copiedAt: null });
      expect(aws.s3Send).not.toHaveBeenCalled();
    });
  });

  describe("異常系", () => {
    it("サーバ: PutObject が例外（403）でも E-15 の正本は残り、写しの失敗だけが runlog-flush の記録に残る", async () => {
      aws.s3Send.mockRejectedValue(awsError("AccessDenied", 403, "explicit deny in bucket policy"));
      writeSchedule(fx, "it-daily-silence", DAILY_SILENCE);
      writeSchedule(fx, "it-runlog-flush", RUNLOG_FLUSH);
      const plane = planes.create(fx.env(AWS_ENV));
      const run = await waitFinished(plane, (await plane.runNow({ target: { kind: "job", jobId: "it-daily-silence" } })).runId);
      expect(run).toMatchObject({ outcome: "success", summary: "沈黙の疑いは見つからなかった", copiedAt: null });
      await vi.waitFor(() => expect(logs()).toContain("S3 への写しに失敗: permission_denied"));

      const flush = await waitFinished(plane, (await plane.runNow({ target: { kind: "job", jobId: "it-runlog-flush" } })).runId);
      expect(flush).toMatchObject({ outcome: "failure", failureClass: "permission_denied", summary: "S3 への写し: 送信 0 件、残り 1 件" });
      // 正本（E-15）の元の run は変わらない
      expect(await plane.getRun(run.runId)).toEqual(run);
      expect(logs()).not.toContain("explicit deny");
    });

    it("サーバ: 接続できない（$metadata の無い例外）は unreachable", async () => {
      aws.s3Send.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { name: "Error", code: "ECONNREFUSED" }));
      writeSchedule(fx, "it-daily-silence", DAILY_SILENCE);
      writeSchedule(fx, "it-runlog-flush", RUNLOG_FLUSH);
      const plane = planes.create(fx.env(AWS_ENV));
      await waitFinished(plane, (await plane.runNow({ target: { kind: "job", jobId: "it-daily-silence" } })).runId);
      const flush = await waitFinished(plane, (await plane.runNow({ target: { kind: "job", jobId: "it-runlog-flush" } })).runId);
      expect(flush).toMatchObject({ outcome: "failure", failureClass: "unreachable" });
    });

    it("サーバ: 前回のプロセスが running のまま残した run は、次の start で failure（timeout）に確定して写す", async () => {
      // 1 つ目のプロセスの代わりに、別のプレーンで同じ E-15 に running の行を作る（確定の前に止めたのと同じ状態）
      writeSchedule(fx, "it-daily-silence", DAILY_SILENCE);
      const crashed = planes.create(fx.env());
      const accepted = await crashed.runNow({ target: { kind: "job", jobId: "it-daily-silence" } });
      await waitFinished(crashed, accepted.runId);
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(join(fx.dataDir, "e15.sqlite"));
      db.prepare("UPDATE runs SET status = 'running', outcome = NULL, snapshot_json = NULL WHERE run_id = ?").run(accepted.runId);
      db.close();

      const restarted = planes.create(fx.env(AWS_ENV));
      await restarted.start();
      expect(await restarted.getRun(accepted.runId)).toMatchObject({
        status: "finished",
        outcome: "failure",
        failureClass: "timeout",
        summary: "プロセスの停止または再起動で中断された",
      });
      await vi.waitFor(() => expect(putObjects().map((put) => put.Key)).toContainEqual(expect.stringContaining(accepted.runId)));
    });
  });
});
