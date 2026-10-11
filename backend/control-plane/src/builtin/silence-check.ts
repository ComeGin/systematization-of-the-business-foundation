// 沈黙の検出（DD-07 の 3.2）。監視アプリのサーバー側で、E-15（起動した）と成果物・期待した起動の食い違いを照合する。
// エージェントに E-15 を読ませない。決定論的な照合だけを行う。
//
// 検出する沈黙（当日 = 日本時間の 0 時から今まで）:
//   (a) 成果物なし: success で終わったエージェントの run があるのに、そのエージェントが書くはずの
//       docs/audits/<source>/ に当日分（AUD-<西暦>-<月日>-<source>-*）が 1 件も無い。
//   (b) 未起動: スケジューラが有効で、定義が enabled のジョブの起動時刻を過ぎている（猶予 10 分）のに、
//       その起動の窓（起動時刻の 1 分前から次の起動時刻の 1 分前まで）に、そのジョブの run が（skipped・手動を含めて）1 件も無い。
// 検出しないもの（README に記載）: 開発機・監視アプリ自身の停止（ハートビートの役目）、成果物の中身の正しさ。
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Cron } from "croner";
import { AUDIT_SOURCES_BY_AGENT } from "../constants/audit-sources.js";
import { AUDITS_DIR } from "../constants/paths.js";
import type { BuiltinHandler } from "../context.js";
import { TIMEZONE, auditDayKey, jstDayStart, toIsoJst } from "../time.js";

/** 起動時刻からこの時間を過ぎても run が無ければ「未起動」とみなす */
const GRACE_MS = 10 * 60 * 1000;
/** 起動時刻のこの時間前からの run も、その起動として数える */
const SLACK_MS = 60 * 1000;

async function hasTodaysAudit(worktree: string, source: string, dayKey: string): Promise<boolean> {
  try {
    const names = await readdir(join(worktree, AUDITS_DIR, source));
    return names.some((name) => name.startsWith(`AUD-${dayKey}-${source}-`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export const silenceCheck: BuiltinHandler = async ({ ctx, runId }) => {
  const now = new Date();
  const dayStart = jstDayStart(now);
  const dayKey = auditDayKey(now);
  const todaysRuns = ctx.runs.startedSince(toIsoJst(dayStart)).filter((run) => run.runId !== runId);

  const findings: string[] = [];
  const targets: string[] = [];

  // (a) 成果物なし
  const agentsWithSuccess = new Set(
    todaysRuns.filter((run) => run.outcome === "success" && run.agentName).map((run) => run.agentName!),
  );
  for (const agent of agentsWithSuccess) {
    const sources = AUDIT_SOURCES_BY_AGENT[agent];
    if (!sources) continue; // 成果物を docs/audits に書かないエージェント（proposal-writer など）
    const results = await Promise.all(sources.map((source) => hasTodaysAudit(ctx.config.worktree, source, dayKey)));
    if (!results.some(Boolean)) {
      findings.push(`成果物なし: ${agent}`);
      targets.push(`agent:${agent}`);
    }
  }

  // (b) 未起動
  if (ctx.config.schedulerEnabled) {
    const { jobs } = await ctx.loadSchedules();
    for (const job of jobs.filter((j) => j.enabled)) {
      const cron = new Cron(job.cron, { timezone: TIMEZONE, paused: true });
      // 当日の起動時刻のうち、猶予を過ぎたもの
      const expected: Date[] = [];
      let next = cron.nextRun(new Date(dayStart.getTime() - 1));
      while (next && next.getTime() + GRACE_MS <= now.getTime()) {
        expected.push(next);
        next = cron.nextRun(next);
      }
      // 手動の run（trigger=manual）も、そのジョブの起動として数える
      const jobRuns = todaysRuns.filter((run) => run.jobId === job.id);
      for (const fireAt of expected) {
        // その起動の窓 = [起動時刻 − 余裕, 次の起動時刻 − 余裕)。上限が無いと、後の起動の run が前の起動の欠落を隠す。
        // 余裕は 1 分（少し早い手動の run を数える）だが、間隔の半分を超えない（毎分のジョブで、数秒遅れの run が次の窓に入らないように）
        const nextAt = cron.nextRun(fireAt)?.getTime() ?? Number.POSITIVE_INFINITY;
        const slack = Math.min(SLACK_MS, (nextAt - fireAt.getTime()) / 2);
        const from = fireAt.getTime() - slack;
        const until = nextAt - slack;
        const ran = jobRuns.some((run) => {
          const startedAt = Date.parse(run.startedAt);
          return startedAt >= from && startedAt < until;
        });
        if (!ran) {
          findings.push(`未起動: ${job.id}（${toIsoJst(fireAt).slice(11, 16)}）`);
          targets.push(`job:${job.id}`);
        }
      }
    }
  }

  if (findings.length === 0) {
    return { outcome: "success", summary: "沈黙の疑いは見つからなかった", targetIds: [] };
  }
  return {
    outcome: "partial",
    summary: `沈黙の疑い ${findings.length} 件: ${findings.join(" / ")}`,
    targetIds: [...new Set(targets)],
  };
};
