// プロセス内のスケジューラ。cron 式は Asia/Tokyo。
// 前回が実行中なら起動を見送って skipped を記録し、after の未達も skipped にする。どちらもエンジンの起動処理が行う。
// 止まっていた間の分は取り戻さない（取り戻しは定義側の基準日で行う。DD-07 の 3.4。欠けた期間は silence-check が検出する）。
import { Cron } from "croner";
import type { EngineContext } from "./context.js";
import type { ScheduleDefinition } from "./definitions/schedules.js";
import type { Engine } from "./engine.js";
import { logLine } from "./log.js";
import { TIMEZONE, toIsoJst } from "./time.js";

/** main のチェックアウトの更新（定義の PR のマージ）を拾うための再読み込みの間隔 */
const RELOAD_INTERVAL_MS = 60 * 60 * 1000;

export function nextRunAt(job: ScheduleDefinition): string | null {
  const next = new Cron(job.cron, { timezone: TIMEZONE, paused: true }).nextRun();
  return next ? toIsoJst(next) : null;
}

export class Scheduler {
  private readonly crons = new Map<string, { signature: string; cron: Cron }>();
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ctx: EngineContext,
    private readonly engine: Engine,
  ) {}

  async start(): Promise<void> {
    await this.reload();
    this.reloadTimer ??= setInterval(() => {
      this.reload().catch((error: unknown) =>
        logLine("ERROR", "scheduler", `定義の再読み込みに失敗: ${error instanceof Error ? error.message : "不明"}`),
      );
    }, RELOAD_INTERVAL_MS);
    this.reloadTimer.unref();
  }

  stop(): void {
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    this.reloadTimer = null;
    for (const { cron } of this.crons.values()) cron.stop();
    this.crons.clear();
  }

  /** 定義を読み直し、変わったジョブだけ登録し直す。enabled:false のジョブは登録しない（手動の起動は別）。 */
  async reload(): Promise<void> {
    const { jobs } = await this.ctx.loadSchedules();
    const desired = new Map(jobs.filter((job) => job.enabled).map((job) => [job.id, job]));

    for (const [id, entry] of this.crons) {
      const job = desired.get(id);
      if (!job || entry.signature !== JSON.stringify(job)) {
        entry.cron.stop();
        this.crons.delete(id);
      }
    }
    for (const [id, job] of desired) {
      if (this.crons.has(id)) continue;
      const cron = new Cron(
        job.cron,
        {
          timezone: TIMEZONE,
          catch: (error: unknown) =>
            logLine("ERROR", "scheduler", `${id}: 起動に失敗: ${error instanceof Error ? error.message : "不明"}`),
        },
        () => {
          void this.engine.start({ trigger: "schedule", job });
        },
      );
      this.crons.set(id, { signature: JSON.stringify(job), cron });
      logLine("INFO", "scheduler", `登録: ${id} (${job.cron})`);
    }
  }
}
