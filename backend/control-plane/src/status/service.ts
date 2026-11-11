// 設定の状況の本体。1 時間ごと（と「今すぐ確かめる」・起動の 30 秒後）に、次の順で確かめる（spec の 5・6）:
//   1. 承認済み main のチェックアウトで origin の main を取る（fetchMain）
//   2. 2 本の設定スクリプトの --check --json（製品の API を呼ぶモジュールは 1 時間に 1 回。それ以外は前回の結果を引き継ぐ）と、
//      3 つのずれの確認（fetch が失敗したら確かめずに unknown。本番の n8n の比較と記事の配信〈本番の Strapi〉は製品の API なので
//      1 時間に 1 回で、間の回は前回の結果を引き継ぐ）
//   3. 秘密値を伏せる → カタログに当てて評価する → 保存する → 知らせる（メール。送れなくても確認は止めない）
// 改善ループの処理ではないので、0〜8 時の窓にも CONTROL_SCHEDULER_ENABLED にも縛らない。E-15 の実行記録にも入れない（1 日 144 回）。
// ログは logLine("setup-status") に、値を含めずに出す。
import { homedir } from "node:os";
import type { ControlPlaneConfig } from "../config.js";
import type { SetupDocSection, SetupGuide, SetupStatusLevel, SetupStatusView } from "../contract.js";
import { logLine } from "../log.js";
import { toIsoJst } from "../time.js";
import { type Catalog, CatalogError, catalogDocFiles, loadCatalog } from "./catalog.js";
import { readDocSection } from "./docs.js";
import { type DriftResult, checkN8nWorkflows, checkSiteArticles, checkSiteRedeploy } from "./drift.js";
import { type EvaluatedStatus, type ModuleResultWithTime, evaluate, mergeModuleResults, worstLevel, zeroCounts } from "./evaluate.js";
import { fetchMain } from "./git-fetch.js";
import {
  type CatalogBrokenState,
  initialNotifyLedger,
  ledgerAfterFailedSend,
  planCatalogBroken,
  planNotifications,
  sendNotifications,
} from "./notify.js";
import { collectSecrets, redact } from "./redact.js";
import { type SetupCheckReport, type SetupScript, SETUP_SCRIPTS, runSetupCheck } from "./run-check.js";
import { readStopGuides } from "./stop-guide.js";
import { StatusStore, type StoredDrift, type StoredStatus } from "./store.js";

export const FIRST_CHECK_DELAY_MS = 30 * 1000;
/** 定期の確認の間隔（2026-11-04 にユーザーの指示で 10 分から 1 時間にした） */
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** 製品の API を呼ぶ確認の間隔（spec 5.1。「今すぐ確かめる」のときは待たない） */
export const PRODUCT_API_INTERVAL_MS = 60 * 60 * 1000;
/**
 * 製品の API の間隔の判定に許すずれ。定期の確認の間隔が製品の API の間隔と同じ 1 時間なので、
 * タイマーの揺れで前回からの経過が 1 時間をわずかに切ると、その回を飛ばして 2 時間に 1 回になってしまう。それを防ぐ
 */
export const PRODUCT_API_DUE_SLACK_MS = 60 * 1000;

export const DISABLED_REASON = "本番の監視アプリだけで動く（CONTROL_SETUP_STATUS_ENABLED が true ではない）";

/** 外との境界。テストで差し替える。 */
export interface SetupStatusDeps {
  loadCatalog: typeof loadCatalog;
  fetchMain: typeof fetchMain;
  runSetupCheck: typeof runSetupCheck;
  checkSiteRedeploy: typeof checkSiteRedeploy;
  checkN8nWorkflows: typeof checkN8nWorkflows;
  checkSiteArticles: typeof checkSiteArticles;
  collectSecrets: typeof collectSecrets;
  readDocSection: typeof readDocSection;
  readStopGuides: typeof readStopGuides;
  sendNotifications: typeof sendNotifications;
  store: Pick<StatusStore, "load" | "save">;
  home: string;
  now: () => Date;
}

/** モジュールの結果の文字列（notes・error・items の title/evidence/stopId）を伏せる。 */
function maskResult(result: ModuleResultWithTime, mask: (text: string) => string): ModuleResultWithTime {
  return {
    ...result,
    notes: result.notes.map(mask),
    error: result.error === null ? null : mask(result.error),
    items: result.items.map((item) => ({
      ...item,
      title: mask(item.title),
      evidence: mask(item.evidence),
      ...(item.stopId !== undefined ? { stopId: mask(item.stopId) } : {}),
    })),
  };
}

/** 保存した結果（画面の形とモジュールの結果）を伏せ直す。 */
function maskStored(stored: StoredStatus, mask: (text: string) => string): StoredStatus {
  return {
    ...stored,
    snapshot: {
      ...stored.snapshot,
      steps: stored.snapshot.steps.map((step) => ({
        ...step,
        title: mask(step.title),
        items: step.items.map((item) => ({
          ...item,
          title: mask(item.title),
          evidence: mask(item.evidence),
          stopId: item.stopId === null ? null : mask(item.stopId),
        })),
      })),
    },
    moduleResults: stored.moduleResults.map((result) => maskResult(result, mask)),
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "不明";
}

export class SetupStatusService {
  private readonly deps: SetupStatusDeps;
  private stored: StoredStatus | null = null;
  private catalogError: string | null = null;
  private running = false;
  /** 直近の知らせの送信の失敗（失敗の種類だけ）。次に送れたら消す */
  private notifyError: string | null = null;
  /** 手順の一覧を読めない状態の数え（保存があればその ledger にも写す。保存が無いうちはメモリだけ） */
  private catalogBroken: CatalogBrokenState = { since: null, notified: false };
  private abort: AbortController | null = null;
  private timer: NodeJS.Timeout | null = null;
  private nextAt: Date | null = null;

  constructor(
    private readonly config: ControlPlaneConfig,
    deps: Partial<SetupStatusDeps> = {},
  ) {
    this.deps = {
      loadCatalog,
      fetchMain,
      runSetupCheck,
      checkSiteRedeploy,
      checkN8nWorkflows,
      checkSiteArticles,
      collectSecrets,
      readDocSection,
      readStopGuides,
      sendNotifications,
      store: deps.store ?? new StatusStore(config.dataDir),
      home: homedir(),
      now: () => new Date(),
      ...deps,
    };
    if (config.status) {
      const loaded = this.deps.store.load();
      // 前回の保存の後に秘密値が増えている（例: 新しいトークン）ことがあるので、画面に出す前に今の秘密値で伏せ直す
      this.stored = loaded ? maskStored(loaded, this.currentMask(config.status)) : null;
      this.catalogBroken = {
        since: loaded?.ledger.catalogBrokenSince ?? null,
        notified: loaded?.ledger.catalogBrokenNotified ?? false,
      };
    }
  }

  /** 今の秘密値で伏せる関数。呼ぶたびにファイルを読み直す。 */
  private currentMask(status: NonNullable<ControlPlaneConfig["status"]>): (text: string) => string {
    const secrets = [
      ...this.deps.collectSecrets(this.deps.home, [status.awsCredentialsFile, status.githubTokenFile]),
      ...(this.config.n8nExport ? [this.config.n8nExport.apiKey] : []),
    ];
    return (text: string) => redact(text, secrets);
  }

  /** 起動の 30 秒後に 1 回、以後 1 時間ごと。config.status が無ければ何もしない。冪等。 */
  start(): void {
    if (!this.config.status || this.timer) return;
    this.schedule(FIRST_CHECK_DELAY_MS);
    logLine("INFO", "setup-status", "開始（起動の 30 秒後と、以後 1 時間ごとに確かめる）");
  }

  /** 次の予定を止め、確認中なら打ち切る（子プロセスは AbortSignal で殺す）。冪等。 */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
    this.abort?.abort();
  }

  /** 今すぐ確かめる（製品の API の間隔を待たない）。確認中・無効なら accepted=false。完了を待たない。 */
  refresh(): { accepted: boolean } {
    if (!this.config.status || this.running) return { accepted: false };
    void this.runOnce(true);
    return { accepted: true };
  }

  view(): SetupStatusView {
    if (!this.config.status) {
      return {
        enabled: false,
        // 有効にしたのに変数に誤りがあるときは、その理由（変数名と理由だけ）を出す（spec 7）
        reason: this.config.statusConfigError ?? DISABLED_REASON,
        checkedAt: null,
        nextCheckAt: null,
        running: false,
        counts: zeroCounts(),
        notifyError: null,
        steps: [],
      };
    }
    const snapshot: EvaluatedStatus | null = this.stored?.snapshot ?? null;
    const common = {
      enabled: true,
      checkedAt: snapshot?.checkedAt ?? null,
      nextCheckAt: this.nextAt ? toIsoJst(this.nextAt) : null,
      running: this.running,
      notifyError: this.notifyError,
    };
    if (this.catalogError !== null) return { ...common, reason: this.catalogError, counts: zeroCounts(), steps: [] };
    return { ...common, reason: null, counts: snapshot?.counts ?? zeroCounts(), steps: snapshot?.steps ?? [] };
  }

  /**
   * 実行の順番と止まったときの案内（画面の guide）。確認の結果ではなく手順書なので保存せず、見るたびに承認済み main から読む。
   * 実行の順番の状態は、渡した view の段階の判定から決める。無効・カタログを読めないときは null。投げない。
   */
  async guide(view: SetupStatusView): Promise<SetupGuide | null> {
    if (!view.enabled) return null;
    let catalog: Catalog;
    try {
      catalog = await this.deps.loadCatalog(this.config.mainCheckout);
    } catch {
      // 理由は確認のたびに view.reason（catalogError）に出る
      return null;
    }
    const levelOf = new Map<string, SetupStatusLevel>(view.steps.map((step) => [step.id, step.level]));
    const runOrder = (catalog.runOrder ?? []).map((entry) => {
      const levels = entry.steps.map((id) => levelOf.get(id)).filter((level): level is SetupStatusLevel => level !== undefined);
      return {
        id: entry.id,
        command: entry.command,
        note: entry.note,
        steps: [...entry.steps],
        level: levels.length > 0 ? worstLevel(levels) : null,
      };
    });
    // commands を持たない段階（古いカタログ）は入れない（画面は「スクリプトでは進めない段階」と区別できなくなる）
    const stepCommands: Record<string, string[]> = {};
    for (const step of catalog.steps) if (step.commands !== undefined) stepCommands[step.id] = [...step.commands];
    let stop: Awaited<ReturnType<typeof readStopGuides>>;
    try {
      stop = await this.deps.readStopGuides(this.config.mainCheckout);
    } catch (error) {
      stop = { guides: {}, error: `早見表を読めない（${errorName(error)}）` };
    }
    return { runOrder, stepCommands, stopGuides: stop.guides, stopTableError: stop.error };
  }

  /**
   * 手順書の 1 節。カタログの docs にある (file, heading) の組だけを読む（無効のときも読める。開発でも手順書は役に立つ）。
   * カタログは承認済み main のチェックアウトから読む。読めなければ null。
   */
  async readDoc(file: string, heading: string): Promise<SetupDocSection | null> {
    let catalog: Catalog;
    try {
      catalog = await this.deps.loadCatalog(this.config.mainCheckout);
    } catch {
      return null;
    }
    const allowed = catalog.steps.some((step) =>
      step.items.some((item) => item.docs.some((doc) => doc.file === file && doc.heading === heading)),
    );
    if (!allowed) return null;
    return this.deps.readDocSection(this.config.mainCheckout, file, heading, catalogDocFiles(catalog));
  }

  private schedule(delayMs: number): void {
    this.nextAt = new Date(this.deps.now().getTime() + delayMs);
    this.timer = setTimeout(() => this.tick(), delayMs);
    this.timer.unref();
  }

  private tick(): void {
    this.schedule(CHECK_INTERVAL_MS);
    if (this.running) {
      logLine("INFO", "setup-status", "前の確認が終わっていないため、今回は飛ばした");
      return;
    }
    void this.runOnce(false);
  }

  /** 手順の一覧を読めない状態の数えを更新する。保存があれば ledger にも写して保存する。 */
  private setCatalogBroken(state: CatalogBrokenState): void {
    this.catalogBroken = state;
    if (!this.stored) return;
    const updated: StoredStatus = {
      ...this.stored,
      ledger: { ...this.stored.ledger, catalogBrokenSince: state.since, catalogBrokenNotified: state.notified },
    };
    this.stored = updated;
    try {
      this.deps.store.save(updated);
    } catch (error) {
      logLine("WARN", "setup-status", `知らせの記録を保存できない（${errorName(error)}）`);
    }
  }

  /** 手順の一覧を読めない回の知らせ。投げない。送れたときだけ notified を立てる（unknownItems・lastLevels には触れない）。 */
  private async notifyCatalogBroken(status: NonNullable<ControlPlaneConfig["status"]>, reason: string): Promise<void> {
    try {
      const mask = this.currentMask(status);
      const plan = planCatalogBroken(this.catalogBroken, this.deps.now(), mask(reason), { linkBase: status.linkBase, mask });
      let state = plan.next;
      if (plan.message) {
        const sent = await this.deps.sendNotifications([plan.message], status, undefined, this.abort?.signal);
        if (sent.ok) {
          this.notifyError = null;
          state = { ...state, notified: true };
        } else {
          this.notifyError = sent.reason;
          logLine("WARN", "setup-status", `知らせのメールを送れない（${sent.reason}）`);
        }
      }
      if (state.since !== this.catalogBroken.since || state.notified !== this.catalogBroken.notified) this.setCatalogBroken(state);
    } catch (error) {
      logLine("WARN", "setup-status", `知らせを決められない（${errorName(error)}）`);
    }
  }

  /**
   * 知らせ（メール）を決めて送る。投げない。送れたときだけ記録（ledger）を進める。
   * 送れなかったら notifyError に種類だけ入れ、記録は進めない（次の確認で送り直す。? の始まりだけは進める）。
   * 判断は画面の形（view）で行う。保存した moduleResults には引き継いだ古い結果が入るため使わない。
   */
  private async notify(
    stored: StoredStatus,
    mask: (text: string) => string,
    status: NonNullable<ControlPlaneConfig["status"]>,
  ): Promise<void> {
    try {
      const plan = planNotifications(stored.ledger, this.view(), this.deps.now(), { linkBase: status.linkBase, mask });
      let ledger = plan.next;
      if (plan.messages.length > 0) {
        const sent = await this.deps.sendNotifications(plan.messages, status, undefined, this.abort?.signal);
        if (sent.ok) {
          this.notifyError = null;
        } else {
          this.notifyError = sent.reason;
          ledger = ledgerAfterFailedSend(stored.ledger, plan.next);
          logLine("WARN", "setup-status", `知らせのメールを送れない（${sent.reason}）`);
        }
      }
      if (JSON.stringify(ledger) === JSON.stringify(stored.ledger)) return;
      const updated: StoredStatus = { ...stored, ledger };
      this.stored = updated;
      try {
        this.deps.store.save(updated);
      } catch (error) {
        logLine("WARN", "setup-status", `知らせの記録を保存できない（${errorName(error)}）`);
      }
    } catch (error) {
      logLine("WARN", "setup-status", `知らせを決められない（${errorName(error)}）`);
    }
  }

  /** 1 回確かめる。投げない（失敗はログと画面の unknown に出す）。 */
  private async runOnce(force: boolean): Promise<void> {
    const status = this.config.status;
    if (!status || this.running) return;
    // ここまでは同期で進む（refresh() が accepted を返す前に running が立つ）
    this.running = true;
    const controller = new AbortController();
    this.abort = controller;
    const { signal } = controller;
    const deps = this.deps;
    try {
      const startedAt = deps.now();

      let catalog: Catalog;
      try {
        catalog = await deps.loadCatalog(this.config.mainCheckout);
        this.catalogError = null;
        // 読めるようになった: 手順の一覧の数えを戻す
        if (this.catalogBroken.since !== null || this.catalogBroken.notified) {
          this.setCatalogBroken({ since: null, notified: false });
        }
      } catch (error) {
        const detail = error instanceof CatalogError ? `${error.name}: ${error.message}` : errorName(error);
        this.catalogError = `手順の一覧を読めない（${detail}）`;
        logLine("WARN", "setup-status", this.catalogError);
        // 評価に進めないので、? とは別に数えて 1 時間続いたら知らせる（これが無いと、壊れている間ずっと黙る）
        if (!signal.aborted) await this.notifyCatalogBroken(status, this.catalogError);
        return;
      }

      const mainCheckout = this.config.mainCheckout;
      const fetched = await deps.fetchMain(mainCheckout, status.repository, status.githubTokenFile, signal);
      const fetchError = fetched.ok ? null : fetched.reason;
      if (signal.aborted) return;

      const mask = this.currentMask(status);

      const previous = this.stored;
      const productDue =
        force ||
        previous?.productApiCheckedAt == null ||
        startedAt.getTime() - Date.parse(previous.productApiCheckedAt) >= PRODUCT_API_INTERVAL_MS - PRODUCT_API_DUE_SLACK_MS;
      // 前回の本当の結果（飛ばしたものでない）があるモジュールだけを飛ばす（無いものは確かめないと出せない）。
      // 親スクリプトに無い id を --skip に渡すと止まるので、そのスクリプトの前回の結果にある id に限る
      const skipFor = (script: SetupScript): string[] =>
        productDue || !previous
          ? []
          : catalog.productApiModules.filter((id) =>
              previous.moduleResults.some((r) => r.script === script && r.moduleId === id && !r.skipped),
            );

      // 本番の n8n の比較は製品の API（GET）を呼ぶので、製品の API のモジュールと同じく 1 時間に 1 回（spec 5.1）。
      // 間の回は前回の本当の結果（その時の checkedAt のまま）を引き継ぐ。前回の結果が無ければ確かめる
      const carriedN8n: StoredDrift | undefined = productDue
        ? undefined
        : previous?.driftResults?.find((d) => d.id === "n8n-workflows");
      // 記事の配信も本番の Strapi（製品の API）を読むので同じ扱い。確かめる回は、前回の結果（取り下げの最初の時刻 firstSeen）を渡す
      const previousArticles = previous?.driftResults?.find((d) => d.id === "site-articles");
      const carriedArticles: StoredDrift | undefined = productDue ? undefined : previousArticles;
      const strapi = this.config.strapi ? { baseUrl: this.config.strapi.baseUrl, readToken: this.config.strapi.readToken } : null;
      const [reports, drifts] = await Promise.all([
        Promise.all(
          SETUP_SCRIPTS.map((script) =>
            deps.runSetupCheck({
              mainCheckout,
              worktree: this.config.worktree,
              status,
              script,
              skip: skipFor(script),
              signal,
              redact: mask,
            }),
          ),
        ),
        fetchError === null
          ? Promise.all([
              deps.checkSiteRedeploy({
                checkout: mainCheckout,
                siteUrl: status.siteUrl,
                repository: status.repository,
                tokenFile: status.githubTokenFile,
                signal,
              }),
              carriedN8n !== undefined
                ? Promise.resolve<DriftResult>(carriedN8n)
                : deps.checkN8nWorkflows({ checkout: mainCheckout, n8n: this.config.n8nExport, signal }),
              carriedArticles !== undefined
                ? Promise.resolve<DriftResult>(carriedArticles)
                : deps.checkSiteArticles({ siteUrl: status.siteUrl, strapi, previous: previousArticles, now: startedAt, signal }),
            ])
          : Promise.resolve([] as DriftResult[]),
      ]);
      const [setupReport, frontendReport] = reports;
      if (signal.aborted) return;

      const runErrors: string[] = [];
      const toResults = (report: SetupCheckReport | { error: string } | undefined, script: SetupScript): ModuleResultWithTime[] => {
        if (!report) return [];
        if ("error" in report) {
          runErrors.push(mask(report.error));
          return [];
        }
        return report.results.map((result) => ({ ...result, checkedAt: report.finishedAt, script }));
      };
      const merged = mergeModuleResults(
        toResults(setupReport, "setup/setup.mjs"),
        toResults(frontendReport, "setup/frontend.mjs"),
      );
      // 飛ばしたモジュールは、前回の本当の結果（その時の checkedAt のまま）を引き継ぐ。
      // 引き継いだ結果も、今の秘密値でもう一度伏せる（前回の後に秘密値が増えていることがある）
      const moduleResults = merged
        .map((result) => {
          if (!result.skipped || !previous) return result;
          const carried = previous.moduleResults.find(
            (p) => p.moduleId === result.moduleId && p.phase === result.phase && !p.skipped,
          );
          return carried ?? result;
        })
        .map((result) => maskResult(result, mask));

      // setup.mjs そのものが失敗した（タイムアウト・JSON が無い）ときは、製品の API のモジュールの前回の結果を、
      // 次の回の --skip と引き継ぎのためだけに残す（画面の評価には使わない。失敗は unknown として出す）。
      // 残さないと、失敗が続くあいだ毎回製品の API を呼び直してしまう（1 時間に 1 回の決まりを破る）
      const setupFailed = setupReport === undefined || "error" in setupReport;
      const retained =
        setupFailed && previous
          ? previous.moduleResults
              .filter(
                (p) =>
                  p.script === "setup/setup.mjs" &&
                  !p.skipped &&
                  catalog.productApiModules.includes(p.moduleId) &&
                  !moduleResults.some((m) => m.moduleId === p.moduleId && m.phase === p.phase),
              )
              .map((result) => maskResult(result, mask))
          : [];

      const driftResults: DriftResult[] = drifts.map((drift) => ({ ...drift, evidence: mask(drift.evidence) }));
      const finishedAt = toIsoJst(deps.now());
      // 次の回に引き継ぐずれの結果（今回確かめたものは今回の時刻、引き継いだものはその時の時刻）
      const storedDrifts: StoredDrift[] = driftResults.map((drift) => ({ ...drift, checkedAt: drift.checkedAt ?? finishedAt }));
      const snapshot = evaluate(catalog, moduleResults, driftResults, fetchError === null ? null : mask(fetchError), {
        checkedAt: finishedAt,
        runErrors,
      });

      const next: StoredStatus = {
        version: 1,
        snapshot,
        moduleResults: [...moduleResults, ...retained],
        // 製品の API を呼びに行った回は、結果に関わらず進める（失敗が続いても 1 時間に 1 回まで）
        productApiCheckedAt: productDue ? toIsoJst(startedAt) : (previous?.productApiCheckedAt ?? null),
        // fetch が失敗した回はずれを確かめていないので、前回の結果を残す（次の回の引き継ぎに使う。画面には使わない）
        driftResults: fetchError === null ? storedDrifts : (previous?.driftResults ?? []),
        ledger: previous?.ledger ?? initialNotifyLedger(),
      };
      this.stored = next;
      try {
        deps.store.save(next);
      } catch (error) {
        logLine("WARN", "setup-status", `結果を保存できない（${errorName(error)}）`);
      }
      if (!signal.aborted) await this.notify(next, mask, status);

      const { counts } = snapshot;
      logLine(
        "INFO",
        "setup-status",
        `確かめた action=${counts.action} warn=${counts.warn} unknown=${counts.unknown} manual=${counts.manual} ok=${counts.ok}` +
          ` product-api=${productDue ? "checked" : "carried"} fetch=${fetchError === null ? "ok" : "failed"} script-errors=${runErrors.length}`,
      );
    } catch (error) {
      logLine("WARN", "setup-status", `確認が途中で失敗した（${errorName(error)}）`);
    } finally {
      this.running = false;
      if (this.abort === controller) this.abort = null;
    }
  }
}
