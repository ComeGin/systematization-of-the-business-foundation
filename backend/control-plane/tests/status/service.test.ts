// 外との境界（カタログ・fetch・子プロセス・ずれの確認・手順書）は deps で差し替える。時刻は偽のタイマー。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPlaneConfig } from "../../src/config.js";
import type { Catalog } from "../../src/status/catalog.js";
import { CatalogError } from "../../src/status/catalog.js";
import type { SetupCheckReport, SetupScript } from "../../src/status/run-check.js";
import { CHECK_INTERVAL_MS, DISABLED_REASON, SetupStatusService, type SetupStatusDeps } from "../../src/status/service.js";
import { StatusStore } from "../../src/status/store.js";
import { tempDir } from "../helpers/runner.js";

const T0 = new Date("2026-11-03T01:00:00.000Z"); // 10:00 JST

let root: string;
let cleanup: () => void;

const statusConfig = () => ({
  awsCredentialsFile: join(root, "status-reader/aws-credentials"),
  awsProfile: "default",
  githubTokenFile: join(root, "status-reader/github-token"),
  alertTopicArn: "arn:aws:sns:ap-northeast-1:123456789012:comegin-ops-alert",
  linkBase: "http://127.0.0.1:3200",
  region: "ap-northeast-1",
  repository: "ComeGin/systematization-of-the-business-foundation",
  siteUrl: "https://www.example.test",
});

const config = (enabled = true): ControlPlaneConfig => ({
  dataDir: join(root, "data"),
  mainCheckout: join(root, "main"),
  worktree: join(root, "wt"),
  schedulerEnabled: false,
  agentHome: null,
  anthropic: null,
  siteUrl: null,
  github: null,
  aws: null,
  miswrite: null,
  n8nExport: { baseUrl: "http://127.0.0.1:5679", apiKey: "n8n-api-key-value" },
  status: enabled ? statusConfig() : null,
  statusConfigError: null,
});

const CATALOG: Catalog = {
  version: 1,
  productApiModules: ["chatwoot-prod"],
  steps: [
    {
      id: "P2",
      title: "deploy",
      items: [
        {
          id: "P2.sam",
          title: "スタック",
          who: "人・端末",
          kind: "検査",
          overviewText: "x",
          probe: { kind: "module", module: "cloud", phase: "deploy" },
          docs: [{ file: "cloud/README.md", heading: "4.2" }],
        },
      ],
    },
    {
      id: "P7",
      title: "chatwoot",
      items: [
        {
          id: "P7.ecs",
          title: "Chatwoot",
          who: "自動",
          kind: "検査",
          overviewText: "y",
          probe: { kind: "module", module: "chatwoot-prod", phase: "apps" },
          docs: [],
        },
      ],
    },
    {
      id: "P12",
      title: "build",
      items: [
        {
          id: "P12.site",
          title: "再配信",
          who: "人・端末",
          kind: "検査",
          overviewText: "z",
          probe: { kind: "drift", id: "site-redeploy" },
          docs: [{ file: "cloud/README.md", heading: "4.14" }],
        },
      ],
    },
  ],
};

const reportOf = (script: SetupScript, finishedAt: string, skip: string[], notes: string[] = []): SetupCheckReport => ({
  version: 1,
  target: "prod",
  script,
  startedAt: finishedAt,
  finishedAt,
  results:
    script === "setup/setup.mjs"
      ? [
          { moduleId: "cloud", phase: "deploy", ok: true, notes, items: [], error: null, skipped: false },
          {
            moduleId: "chatwoot-prod",
            phase: "apps",
            ok: true,
            notes: [],
            items: [],
            error: null,
            skipped: skip.includes("chatwoot-prod"),
          },
        ]
      : [],
});

let clock: Date;
let deps: { [K in keyof SetupStatusDeps]: SetupStatusDeps[K] } & {
  loadCatalog: ReturnType<typeof vi.fn>;
  fetchMain: ReturnType<typeof vi.fn>;
  runSetupCheck: ReturnType<typeof vi.fn>;
  checkSiteRedeploy: ReturnType<typeof vi.fn>;
  checkN8nWorkflows: ReturnType<typeof vi.fn>;
  readDocSection: ReturnType<typeof vi.fn>;
  sendNotifications: ReturnType<typeof vi.fn>;
};

function makeDeps() {
  return {
    loadCatalog: vi.fn(async () => CATALOG),
    fetchMain: vi.fn(async () => ({ ok: true as const, head: "a".repeat(40) })),
    runSetupCheck: vi.fn(async (opts: { script: SetupScript; skip: string[] }) =>
      reportOf(opts.script, new Date(clock.getTime() + 9 * 3_600_000).toISOString().replace("Z", "+09:00"), opts.skip),
    ),
    checkSiteRedeploy: vi.fn(async () => ({ id: "site-redeploy" as const, level: "ok" as const, evidence: "配信中のビルドが最新" })),
    checkN8nWorkflows: vi.fn(async () => ({ id: "n8n-workflows" as const, level: "ok" as const, evidence: "一致" })),
    collectSecrets: vi.fn(() => [] as string[]),
    sendNotifications: vi.fn(async () => ({ ok: true as const })),
    readDocSection: vi.fn(async () => ({ file: "cloud/README.md", heading: "4.2 本番スタック", markdown: "# 4.2" })),
    store: new StatusStore(join(root, "data")),
    home: join(root, "home"),
    now: () => clock,
  };
}

const create = (enabled = true) => new SetupStatusService(config(enabled), deps as unknown as Partial<SetupStatusDeps>);

/** 待っている Promise を進める（偽のタイマーのまま） */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  ({ dir: root, cleanup } = tempDir("cp-status-service-"));
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  clock = T0;
  deps = makeDeps() as typeof deps;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const item = (service: SetupStatusService, id: string) =>
  service
    .view()
    .steps.flatMap((s) => s.items)
    .find((i) => i.id === id)!;

describe("SetupStatusService", () => {
  describe("正常系", () => {
    it("入力: 起動の 30 秒後に 1 回確かめ、以後 1 時間ごと（nextCheckAt は次の予定）", async () => {
      const service = create();
      service.start();
      expect(service.view().nextCheckAt).toBe("2026-11-03T10:00:30.000+09:00");
      await vi.advanceTimersByTimeAsync(29_000);
      expect(deps.fetchMain).not.toHaveBeenCalled();
      clock = new Date(T0.getTime() + 30_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(deps.fetchMain).toHaveBeenCalledTimes(1);
      expect(deps.runSetupCheck).toHaveBeenCalledTimes(2);
      expect(service.view().nextCheckAt).toBe("2026-11-03T11:00:30.000+09:00");
      expect(service.view().steps.map((s) => s.id)).toEqual(["P2", "P7", "P12"]);
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1_000);
      expect(deps.fetchMain).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(deps.fetchMain).toHaveBeenCalledTimes(2);
      service.stop();
    });

    it("入力: fetch の後に、2 本の設定スクリプトとずれの確認を行い、評価した結果を保存する", async () => {
      const service = create();
      expect(service.refresh()).toEqual({ accepted: true });
      await settle();
      const scripts = deps.runSetupCheck.mock.calls.map((c) => (c[0] as { script: string }).script);
      expect(scripts).toEqual(["setup/setup.mjs", "setup/frontend.mjs"]);
      expect(deps.fetchMain.mock.invocationCallOrder[0]!).toBeLessThan(deps.runSetupCheck.mock.invocationCallOrder[0]!);
      const view = service.view();
      expect(view).toMatchObject({ enabled: true, reason: null, running: false, notifyError: null, checkedAt: "2026-11-03T10:00:00.000+09:00" });
      expect(view.counts).toEqual({ ok: 3, action: 0, warn: 0, manual: 0, unknown: 0 });
      const saved = new StatusStore(join(root, "data")).load();
      expect(saved?.snapshot.counts.ok).toBe(3);
      expect(saved?.ledger).toEqual({
        lastLevels: { "P2.sam": "ok", "P7.ecs": "ok", "P12.site": "ok" },
        digestSentOn: null,
        unknownItems: {},
      });
      expect(saved?.productApiCheckedAt).toBe("2026-11-03T10:00:00.000+09:00");
      expect(saved?.driftResults).toEqual([
        { id: "site-redeploy", level: "ok", evidence: "配信中のビルドが最新", checkedAt: "2026-11-03T10:00:00.000+09:00" },
        { id: "n8n-workflows", level: "ok", evidence: "一致", checkedAt: "2026-11-03T10:00:00.000+09:00" },
      ]);
    });

    it("入力: 本番の n8n の比較（製品の API）は 1 時間に 1 回。間の定期の回は前回の結果をその時の checkedAt のまま引き継ぐ", async () => {
      const n8nCatalog: Catalog = {
        ...CATALOG,
        steps: [
          ...CATALOG.steps,
          {
            id: "P14",
            title: "n8n",
            items: [
              {
                id: "P14.n8n",
                title: "n8n のワークフロー",
                who: "自動",
                kind: "検査",
                overviewText: "n",
                probe: { kind: "drift", id: "n8n-workflows" },
                docs: [],
              },
            ],
          },
        ],
      };
      deps.loadCatalog.mockResolvedValue(n8nCatalog);
      const service = create();
      service.start();
      clock = new Date(T0.getTime() + 30_000);
      await vi.advanceTimersByTimeAsync(30_000); // 10:00:30。n8n も確かめる
      expect(deps.checkN8nWorkflows).toHaveBeenCalledTimes(1);
      expect(item(service, "P14.n8n")).toMatchObject({ level: "ok", evidence: "一致", checkedAt: "2026-11-03T10:00:30.000+09:00" });

      // 「今すぐ確かめる」は 1 時間以内でも呼ぶ（10:12）
      deps.checkN8nWorkflows.mockResolvedValue({ id: "n8n-workflows", level: "action", evidence: "違う" });
      clock = new Date(T0.getTime() + 12 * 60 * 1000);
      service.refresh();
      await settle();
      expect(deps.checkN8nWorkflows).toHaveBeenCalledTimes(2);
      expect(item(service, "P14.n8n")).toMatchObject({ level: "action", checkedAt: "2026-11-03T10:12:00.000+09:00" });

      // 11:00:30（定期）: 10:12 から 1 時間たっていないので呼ばずに引き継ぐ。公開サイトの再配信（製品の API ではない）は毎回確かめる
      deps.checkN8nWorkflows.mockResolvedValue({ id: "n8n-workflows", level: "ok", evidence: "一致" });
      clock = new Date(T0.getTime() + 60 * 60 * 1000 + 30_000);
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
      expect(deps.checkN8nWorkflows).toHaveBeenCalledTimes(2);
      expect(deps.checkSiteRedeploy).toHaveBeenCalledTimes(3);
      expect(item(service, "P14.n8n")).toMatchObject({ level: "action", evidence: "違う", checkedAt: "2026-11-03T10:12:00.000+09:00" });
      expect(new StatusStore(join(root, "data")).load()?.driftResults?.find((d) => d.id === "n8n-workflows")?.checkedAt).toBe(
        "2026-11-03T10:12:00.000+09:00",
      );

      // 12:00:30（定期。10:12 から 1 時間たった）: また呼ぶ
      clock = new Date(T0.getTime() + 120 * 60 * 1000 + 30_000);
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
      expect(deps.checkN8nWorkflows).toHaveBeenCalledTimes(3);
      service.stop();
    });

    it("入力: 前回のずれの結果が無い保存（古い形）なら、1 時間以内でも本番の n8n を確かめる", async () => {
      const service = create();
      service.refresh();
      await settle();
      const store = new StatusStore(join(root, "data"));
      const { driftResults: _drop, ...old } = store.load()!;
      store.save(old);
      const restarted = create();
      clock = new Date(T0.getTime() + 10 * 60 * 1000);
      restarted.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(deps.checkN8nWorkflows).toHaveBeenCalledTimes(2);
      restarted.stop();
    });

    it("入力: 1 時間以内の定期の確認では製品の API のモジュールを飛ばし、前回の結果をその時の checkedAt のまま引き継ぐ", async () => {
      const service = create();
      service.refresh(); // 1 回目（10:00。「今すぐ確かめる」）。製品の API も確かめる
      await settle();
      expect((deps.runSetupCheck.mock.calls[0]![0] as { skip: string[] }).skip).toEqual([]);
      const first = item(service, "P7.ecs").checkedAt;

      clock = new Date(T0.getTime() + 20 * 60 * 1000);
      service.start();
      await vi.advanceTimersByTimeAsync(30_000); // 2 回目（10:20 の定期。1 時間たっていない）
      const second = deps.runSetupCheck.mock.calls.slice(2).map((c) => c[0] as { script: string; skip: string[] });
      expect(second.find((c) => c.script === "setup/setup.mjs")!.skip).toEqual(["chatwoot-prod"]);
      // frontend.mjs には chatwoot-prod が無いので渡さない（無い id を --skip に渡すと止まる）
      expect(second.find((c) => c.script === "setup/frontend.mjs")!.skip).toEqual([]);
      expect(item(service, "P7.ecs")).toMatchObject({ level: "ok", checkedAt: first });
      expect(item(service, "P2.sam").checkedAt).not.toBe(first);
      service.stop();
    });

    it("入力: 1 時間たてば製品の API のモジュールも確かめ直す", async () => {
      const service = create();
      service.refresh(); // 10:00 に製品の API も確かめた
      await settle();
      clock = new Date(T0.getTime() + 60 * 60 * 1000);
      service.start(); // 30 秒後（11:00:30）の定期の確認
      await vi.advanceTimersByTimeAsync(30_000);
      const last = deps.runSetupCheck.mock.calls.at(-2)![0] as { script: string; skip: string[] };
      expect(last).toMatchObject({ script: "setup/setup.mjs", skip: [] });
      service.stop();
    });

    it.each([
      ["ちょうど 1 時間", 60 * 60 * 1000, []],
      ["1 分足りない（59 分。タイマーの揺れを許す）", 59 * 60 * 1000, []],
      ["1 分を超えて足りない（58 分 59 秒）", 58 * 60 * 1000 + 59_000, ["chatwoot-prod"]],
    ])("入力: 前回の製品の API から %s の定期の回の skip", async (_label, elapsed, skip) => {
      const service = create();
      service.refresh(); // 10:00 に製品の API も確かめた
      await settle();
      clock = new Date(T0.getTime() + elapsed);
      service.start();
      await vi.advanceTimersByTimeAsync(30_000);
      const last = deps.runSetupCheck.mock.calls.at(-2)![0] as { script: string; skip: string[] };
      expect(last).toMatchObject({ script: "setup/setup.mjs", skip });
      service.stop();
    });

    it("入力: 「今すぐ確かめる」は 1 時間以内でも製品の API のモジュールを飛ばさない", async () => {
      const service = create();
      service.refresh();
      await settle();
      clock = new Date(T0.getTime() + 5 * 60 * 1000);
      service.refresh();
      await settle();
      const calls = deps.runSetupCheck.mock.calls.map((c) => c[0] as { skip: string[] });
      expect(calls.every((c) => c.skip.length === 0)).toBe(true);
    });

    it("入力: fetch が失敗しても設定スクリプトは確かめ、ずれの項目は理由付きで unknown にする", async () => {
      deps.fetchMain.mockResolvedValue({ ok: false, reason: "GitHub のトークンのファイルを読めない（ENOENT）" });
      const service = create();
      service.refresh();
      await settle();
      expect(deps.runSetupCheck).toHaveBeenCalledTimes(2);
      expect(deps.checkSiteRedeploy).not.toHaveBeenCalled();
      expect(deps.checkN8nWorkflows).not.toHaveBeenCalled();
      expect(item(service, "P12.site")).toMatchObject({
        level: "unknown",
        evidence: expect.stringContaining("GitHub のトークンのファイルを読めない（ENOENT）"),
      });
      expect(item(service, "P2.sam").level).toBe("ok");
    });

    it("入力: 新しく action になった項目は、件名と本文に出し、トピックの設定と一緒に送信の関数へ渡す", async () => {
      clock = new Date("2026-11-02T23:00:00.000Z"); // 08:00 JST（まとめの時刻の前）
      vi.setSystemTime(clock);
      deps.checkSiteRedeploy.mockResolvedValue({ id: "site-redeploy", level: "action", evidence: "再配信が必要" });
      const service = create();
      service.refresh();
      await settle();
      const [messages, passedStatus] = deps.sendNotifications.mock.calls[0] as [{ subject: string; body: string }[], { alertTopicArn: string }];
      expect(messages).toHaveLength(1);
      expect(messages[0]!.subject).toBe("[ComeGin 設定の状況] 更新が必要 1 件・警告 0 件");
      expect(messages[0]!.body).toContain("http://127.0.0.1:3200/setup-status?step=P12");
      expect(passedStatus.alertTopicArn).toContain("comegin-ops-alert");
    });

    it("入力: 本文の秘密値は送信の関数に渡す前に伏せる", async () => {
      deps.collectSecrets.mockReturnValue(["very-secret-token-9"]);
      deps.checkSiteRedeploy.mockResolvedValue({ id: "site-redeploy", level: "action", evidence: "値 very-secret-token-9 が古い" });
      const service = create();
      service.refresh();
      await settle();
      const [messages] = deps.sendNotifications.mock.calls[0] as [{ subject: string; body: string }[]];
      expect(JSON.stringify(messages)).not.toContain("very-secret-token-9");
      expect(messages[0]!.body).toContain("値 [伏せ字] が古い");
    });

    it("入力: 知らせるものが無い確認では送信の関数を呼ばない", async () => {
      const service = create();
      service.refresh();
      await settle();
      expect(deps.sendNotifications).not.toHaveBeenCalled();
    });

    it("入力: 前回の保存があれば、起動したときから画面に出す", async () => {
      const first = create();
      first.refresh();
      await settle();
      const second = create();
      expect(second.view().steps).toHaveLength(3);
      expect(second.view().checkedAt).toBe("2026-11-03T10:00:00.000+09:00");
    });

    it("入力: 手順書はカタログの docs にある (file, heading) の組だけを読む（無効のときも読める）", async () => {
      const service = create(false);
      expect(await service.readDoc("cloud/README.md", "4.2")).toMatchObject({ markdown: "# 4.2" });
      expect(deps.readDocSection).toHaveBeenCalledWith(join(root, "main"), "cloud/README.md", "4.2", new Set(["cloud/README.md"]));
    });
  });

  describe("異常系", () => {
    it("空入力: config.status が無ければ無効（理由を出し、確かめない）", async () => {
      const service = create(false);
      service.start();
      expect(service.view()).toEqual({
        enabled: false,
        reason: DISABLED_REASON,
        checkedAt: null,
        nextCheckAt: null,
        running: false,
        counts: { ok: 0, action: 0, warn: 0, manual: 0, unknown: 0 },
        notifyError: null,
        steps: [],
      });
      expect(service.refresh()).toEqual({ accepted: false });
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(deps.fetchMain).not.toHaveBeenCalled();
    });

    it("入力: 有効にしたのに設定の状況の変数に誤りがあれば（statusConfigError）、その理由を出して確かめない", async () => {
      const reason = "設定の状況の環境変数が不正なため、この機能だけを止めている: CONTROL_STATUS_ALERT_TOPIC_ARN: CONTROL_SETUP_STATUS_ENABLED=true のため必須です";
      const service = new SetupStatusService(
        { ...config(false), statusConfigError: reason },
        deps as unknown as Partial<SetupStatusDeps>,
      );
      service.start();
      expect(service.view()).toMatchObject({ enabled: false, reason, steps: [] });
      expect(service.refresh()).toEqual({ accepted: false });
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(deps.fetchMain).not.toHaveBeenCalled();
    });

    it("入力: カタログを読めなければ reason を出して steps は空にし、次の確認は続ける", async () => {
      deps.loadCatalog.mockRejectedValueOnce(new CatalogError("カタログ（setup/status/steps.mjs）が承認済み main のチェックアウトに無い"));
      const service = create();
      service.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(service.view()).toMatchObject({
        enabled: true,
        reason: "手順の一覧を読めない（CatalogError: カタログ（setup/status/steps.mjs）が承認済み main のチェックアウトに無い）",
        steps: [],
        running: false,
      });
      expect(deps.fetchMain).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
      expect(service.view().reason).toBeNull();
      expect(service.view().steps).toHaveLength(3);
      service.stop();
    });

    it("入力: 確認中の「今すぐ確かめる」は accepted=false（重ねて起動しない）", async () => {
      let release!: () => void;
      deps.fetchMain.mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve({ ok: true, head: "a".repeat(40) }))),
      );
      const service = create();
      expect(service.refresh()).toEqual({ accepted: true });
      expect(service.view().running).toBe(true);
      expect(service.refresh()).toEqual({ accepted: false });
      await settle();
      expect(service.refresh()).toEqual({ accepted: false });
      release();
      await settle();
      expect(service.view().running).toBe(false);
      expect(deps.fetchMain).toHaveBeenCalledTimes(1);
      expect(service.refresh()).toEqual({ accepted: true });
    });

    it("入力: 前の確認が終わっていなければ、定期の確認は飛ばす", async () => {
      let release!: () => void;
      deps.fetchMain.mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve({ ok: true, head: "a".repeat(40) }))),
      );
      const service = create();
      service.start();
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
      expect(deps.fetchMain).toHaveBeenCalledTimes(1);
      release();
      await settle();
      service.stop();
    });

    it("入力: stop は確認中の子プロセスを打ち切る（signal を abort する）", async () => {
      let seen: AbortSignal | null = null;
      deps.runSetupCheck.mockImplementation(
        (opts: { signal: AbortSignal }) =>
          new Promise((resolve) => {
            seen = opts.signal;
            opts.signal.addEventListener("abort", () => resolve({ error: "打ち切られた" }));
          }),
      );
      const service = create();
      service.refresh();
      await settle();
      service.stop();
      await settle();
      expect(seen!.aborted).toBe(true);
      expect(service.view().running).toBe(false);
    });

    it("入力: 親スクリプトが失敗したら、その結果の項目は失敗の理由付きで unknown", async () => {
      deps.runSetupCheck.mockImplementation(async (opts: { script: SetupScript }) =>
        opts.script === "setup/setup.mjs" ? { error: "setup/setup.mjs の確認が 300 秒で終わらなかった" } : reportOf(opts.script, "x", []),
      );
      const service = create();
      service.refresh();
      await settle();
      expect(item(service, "P2.sam")).toMatchObject({
        level: "unknown",
        evidence: "モジュールの結果が無い（setup/setup.mjs の確認が 300 秒で終わらなかった）",
      });
      // 製品の API を呼びに行った回なので、失敗でも確かめた時刻は進める（失敗が続いても 1 時間に 1 回まで）
      expect(new StatusStore(join(root, "data")).load()?.productApiCheckedAt).toBe("2026-11-03T10:00:00.000+09:00");
    });

    it("入力: prod.conf・資格情報の秘密値は、保存したファイルに現れない", async () => {
      const { collectSecrets } = await import("../../src/status/redact.js");
      deps.collectSecrets = vi.fn(collectSecrets) as unknown as typeof deps.collectSecrets;
      const home = join(root, "home");
      mkdirSync(join(home, ".config/comegin/setup"), { recursive: true });
      writeFileSync(join(home, ".config/comegin/setup/prod.conf"), "MAUTIC_CLIENT_SECRET=conf-secret-value-1\n");
      mkdirSync(join(root, "status-reader"), { recursive: true });
      writeFileSync(join(root, "status-reader/github-token"), "github_pat_status_reader_1\n");
      deps.runSetupCheck.mockImplementation(async (opts: { script: SetupScript }) =>
        reportOf(opts.script, "2026-11-03T10:00:00.000+09:00", [], ["値は conf-secret-value-1", "トークン github_pat_status_reader_1"]),
      );
      deps.checkSiteRedeploy.mockResolvedValue({ id: "site-redeploy", level: "warn", evidence: "キー n8n-api-key-value が見えた" });
      const service = create();
      service.refresh();
      await settle();
      const text = readFileSync(join(root, "data/setup-status.json"), "utf8");
      expect(text).not.toContain("conf-secret-value-1");
      expect(text).not.toContain("github_pat_status_reader_1");
      expect(text).not.toContain("n8n-api-key-value");
      expect(text).toContain("[伏せ字]");
      expect(deps.collectSecrets).toHaveBeenCalledWith(home, [join(root, "status-reader/aws-credentials"), join(root, "status-reader/github-token")]);
    });

    it("入力: setup.mjs が失敗しても 1 時間以内は製品の API のモジュールを飛ばす", async () => {
      const service = create();
      service.refresh(); // 10:00 に製品の API も確かめて成功
      await settle();
      const firstChecked = item(service, "P7.ecs").checkedAt;

      // 11:01 の定期の回: 製品の API を呼びに行くが、setup.mjs が 5 分で終わらない
      deps.runSetupCheck.mockImplementationOnce(async () => ({ error: "setup/setup.mjs の確認が 300 秒で終わらなかった" }));
      clock = new Date(T0.getTime() + 61 * 60 * 1000);
      service.start();
      await vi.advanceTimersByTimeAsync(30_000);
      const failed = deps.runSetupCheck.mock.calls.at(-2)![0] as { script: string; skip: string[] };
      expect(failed).toMatchObject({ script: "setup/setup.mjs", skip: [] });
      expect(item(service, "P7.ecs").level).toBe("unknown");
      expect(new StatusStore(join(root, "data")).load()?.productApiCheckedAt).toBe("2026-11-03T11:01:00.000+09:00");

      // 次の定期の回（時計は 11:11 に置く）: 11:01 の失敗から 1 時間たっていないので飛ばし、10:00 の結果を引き継ぐ
      clock = new Date(T0.getTime() + 71 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
      const next = deps.runSetupCheck.mock.calls.at(-2)![0] as { script: string; skip: string[] };
      expect(next).toMatchObject({ script: "setup/setup.mjs", skip: ["chatwoot-prod"] });
      expect(item(service, "P7.ecs")).toMatchObject({ level: "ok", checkedAt: firstChecked });
      service.stop();
    });

    it("入力: 引き継いだ前回の結果も、今の秘密値で伏せ直して保存する", async () => {
      deps.runSetupCheck.mockImplementation(async (opts: { script: SetupScript; skip: string[] }) => {
        const r = reportOf(opts.script, "2026-11-03T10:00:00.000+09:00", opts.skip);
        for (const m of r.results) if (m.moduleId === "chatwoot-prod" && !m.skipped) m.notes = ["新しいトークン new-secret-token-1"];
        return r;
      });
      const service = create();
      service.refresh(); // 1 回目: まだ秘密値ではない
      await settle();
      deps.collectSecrets.mockReturnValue(["new-secret-token-1"]); // その後に秘密値になった
      clock = new Date(T0.getTime() + 10 * 60 * 1000);
      service.start();
      await vi.advanceTimersByTimeAsync(30_000); // 2 回目: chatwoot-prod は飛ばして引き継ぐ
      expect((deps.runSetupCheck.mock.calls.at(-2)![0] as { skip: string[] }).skip).toEqual(["chatwoot-prod"]);
      const text = readFileSync(join(root, "data/setup-status.json"), "utf8");
      expect(text).not.toContain("new-secret-token-1");
      expect(item(service, "P7.ecs").evidence).toBe("新しいトークン [伏せ字]");
      service.stop();
    });

    it("入力: 起動のときに読んだ前回の結果も、画面に出す前に今の秘密値で伏せ直す", async () => {
      deps.runSetupCheck.mockImplementation(async (opts: { script: SetupScript; skip: string[] }) =>
        reportOf(opts.script, "2026-11-03T10:00:00.000+09:00", opts.skip, ["値 later-secret-value"]),
      );
      const first = create();
      first.refresh();
      await settle();
      expect(item(first, "P2.sam").evidence).toBe("値 later-secret-value");
      deps.collectSecrets.mockReturnValue(["later-secret-value"]);
      const second = create();
      expect(item(second, "P2.sam").evidence).toBe("値 [伏せ字]");
    });

    it("サーバ: 知らせの送信が失敗しても確認は止まらず、画面に種類だけ出し、記録は進めない（次の確認で送り直す）", async () => {
      deps.checkSiteRedeploy.mockResolvedValue({ id: "site-redeploy", level: "action", evidence: "再配信が必要" });
      deps.sendNotifications.mockResolvedValue({ ok: false, reason: "auth_failed" });
      const service = create();
      service.refresh();
      await settle();
      expect(deps.sendNotifications).toHaveBeenCalledTimes(1);
      const view = service.view();
      expect(view.notifyError).toBe("auth_failed");
      expect(view.running).toBe(false);
      expect(item(service, "P12.site").level).toBe("action");
      expect(new StatusStore(join(root, "data")).load()?.ledger.lastLevels).toEqual({}); // 進めていない

      // 次の確認で送り直し、送れたら記録を進めて notifyError を消す
      deps.sendNotifications.mockResolvedValue({ ok: true });
      clock = new Date(T0.getTime() + 10 * 60 * 1000);
      service.refresh();
      await settle();
      expect(deps.sendNotifications).toHaveBeenCalledTimes(2);
      expect(service.view().notifyError).toBeNull();
      expect(new StatusStore(join(root, "data")).load()?.ledger.lastLevels).toMatchObject({ "P12.site": "action" });

      // 同じ状態が続くだけなら、もう送らない
      clock = new Date(T0.getTime() + 20 * 60 * 1000);
      service.refresh();
      await settle();
      expect(deps.sendNotifications).toHaveBeenCalledTimes(2);
    });

    it("サーバ: 送信の関数が例外を上げても確認は止まらない", async () => {
      deps.checkSiteRedeploy.mockResolvedValue({ id: "site-redeploy", level: "action", evidence: "再配信が必要" });
      deps.sendNotifications.mockRejectedValue(new Error("想定外"));
      const service = create();
      service.refresh();
      await settle();
      expect(service.view()).toMatchObject({ running: false, checkedAt: "2026-11-03T10:00:00.000+09:00" });
      expect(item(service, "P12.site").level).toBe("action");
    });

    describe("手順の一覧を読めない状態が続いたとき", () => {
      const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
      const runAt = async (service: SetupStatusService, n: number) => {
        clock = minutes(n);
        service.refresh();
        await settle();
      };

      it("サーバ: 保存が無くても、59 分は 0 通・60 分で 1 通・その後は 0 通。件名と理由とリンクを送る", async () => {
        deps.loadCatalog.mockRejectedValue(new CatalogError("無い"));
        const service = create();
        await runAt(service, 0);
        await runAt(service, 59);
        expect(deps.sendNotifications).not.toHaveBeenCalled();
        await runAt(service, 60);
        expect(deps.sendNotifications).toHaveBeenCalledTimes(1);
        const [messages] = deps.sendNotifications.mock.calls[0] as [{ subject: string; body: string }[]];
        expect(messages).toHaveLength(1);
        expect(messages[0]!.subject).toBe("[ComeGin 設定の状況] 手順の一覧を読めない状態が続いている");
        expect(messages[0]!.body).toContain("手順の一覧を読めない");
        expect(messages[0]!.body).toContain("http://127.0.0.1:3200/setup-status");
        await runAt(service, 70);
        expect(deps.sendNotifications).toHaveBeenCalledTimes(1);
      });

      it("サーバ: 送れなかったら通知済みにせず、次の回で送り直す（? の数えと lastLevels には触れない）", async () => {
        deps.checkSiteRedeploy.mockResolvedValue({ id: "site-redeploy", level: "unknown", evidence: "届かない" });
        const service = create();
        await runAt(service, 0); // 保存あり（? の始まり 10:00 を記録）
        const before = new StatusStore(join(root, "data")).load()!.ledger;
        expect(before.unknownItems).toEqual({ "P12.site": { since: "2026-11-03T10:00:00.000+09:00", notified: false } });
        deps.sendNotifications.mockClear();

        deps.loadCatalog.mockRejectedValue(new CatalogError("無い"));
        deps.sendNotifications.mockResolvedValue({ ok: false, reason: "auth_failed" });
        await runAt(service, 5); // 始まり 10:05
        await runAt(service, 65);
        expect(deps.sendNotifications).toHaveBeenCalledTimes(1);
        expect(service.view().notifyError).toBe("auth_failed");
        let ledger = new StatusStore(join(root, "data")).load()!.ledger;
        expect(ledger).toMatchObject({ catalogBrokenSince: "2026-11-03T10:05:00.000+09:00", catalogBrokenNotified: false });
        expect(ledger.unknownItems).toEqual(before.unknownItems);
        expect(ledger.lastLevels).toEqual(before.lastLevels);

        deps.sendNotifications.mockResolvedValue({ ok: true });
        await runAt(service, 75);
        expect(deps.sendNotifications).toHaveBeenCalledTimes(2);
        expect(service.view().notifyError).toBeNull();
        ledger = new StatusStore(join(root, "data")).load()!.ledger;
        expect(ledger.catalogBrokenNotified).toBe(true);
        await runAt(service, 85);
        expect(deps.sendNotifications).toHaveBeenCalledTimes(2);
      });

      it("サーバ: 読めるようになったら数えを戻し、また壊れたら数え直す", async () => {
        const service = create();
        await runAt(service, 0);
        deps.loadCatalog.mockRejectedValue(new CatalogError("無い"));
        await runAt(service, 10);
        await runAt(service, 70); // 通知済み
        expect(deps.sendNotifications).toHaveBeenCalledTimes(1);
        expect(new StatusStore(join(root, "data")).load()!.ledger).toMatchObject({ catalogBrokenNotified: true });

        deps.loadCatalog.mockResolvedValue(CATALOG);
        await runAt(service, 80);
        expect(new StatusStore(join(root, "data")).load()!.ledger).toMatchObject({ catalogBrokenSince: null, catalogBrokenNotified: false });

        deps.loadCatalog.mockRejectedValue(new CatalogError("無い"));
        await runAt(service, 90); // 始まり 90 分
        await runAt(service, 149);
        expect(deps.sendNotifications).toHaveBeenCalledTimes(1);
        await runAt(service, 150);
        expect(deps.sendNotifications).toHaveBeenCalledTimes(2);
      });
    });

    it("入力: カタログの docs に無い見出しは読まない", async () => {
      const service = create();
      expect(await service.readDoc("cloud/README.md", "4.99")).toBeNull();
      expect(await service.readDoc("README.md", "4.2")).toBeNull();
      expect(deps.readDocSection).not.toHaveBeenCalled();
    });

    it("入力: カタログを読めなければ手順書も null", async () => {
      deps.loadCatalog.mockRejectedValue(new CatalogError("無い"));
      expect(await create().readDoc("cloud/README.md", "4.2")).toBeNull();
    });
  });
});
