import { notFound } from "next/navigation";
import { AgentDetailView } from "@/components/agents/AgentDetailView";
import { ConfigErrorView } from "@/components/common/ConfigErrorView";
import { getControlPlaneState } from "@/lib/control-plane";
import { AGENT_NAME } from "@/lib/ids";
import { requirePageSession } from "@/lib/session";

/**
 * 直近の実行。listRuns に Agent の絞り込みは無いので、使うジョブごとに新しい 5 件を読み、手動の起動（jobId が無い）は
 * 全体の新しい 50 件から拾って合わせる。全体の 50 件だけだと、週次のジョブの記録が入らない（runlog-flush だけで夜に 32 件。
 * 2026-11-06 の最終レビュー）
 */
const RECENT_SCAN = 50;
const RECENT_LIMIT = 5;

// 詳細: Agent 1 件と、それを使うジョブ・直近の実行と中身
export default async function AgentPage(props: PageProps<"/agents/[name]">) {
  await requirePageSession();
  const { name } = await props.params;
  const state = getControlPlaneState();
  if (!state.plane) return <ConfigErrorView message={state.error} />;
  if (!AGENT_NAME.test(name)) notFound();

  const agent = await state.plane.getAgent(name);
  if (!agent) notFound();

  const plane = state.plane;
  const [jobs, latest, ...perJob] = await Promise.all([
    plane.listJobs(),
    plane.listRuns({ limit: RECENT_SCAN }),
    ...agent.jobIds.map((jobId) => plane.listRuns({ jobId, limit: RECENT_LIMIT })),
  ]);
  const byId = new Map(jobs.map((job) => [job.definition.id, job]));
  const manual = latest.filter((run) => run.agentName === agent.name && run.jobId === null);
  const merged = new Map([...perJob.flat(), ...manual].map((run) => [run.runId, run]));
  // run_id は ULID なので、文字列の降順が新しい順
  const recentRuns = [...merged.values()].sort((a, b) => (a.runId < b.runId ? 1 : -1)).slice(0, RECENT_LIMIT);
  const observations =
    recentRuns.length === 0
      ? {}
      : Object.fromEntries((await state.plane.listRunObservations(recentRuns.map((run) => run.runId))).map((o) => [o.runId, o]));

  return (
    <AgentDetailView
      agent={agent}
      jobs={agent.jobIds.flatMap((id) => byId.get(id) ?? [])}
      recentRuns={recentRuns}
      observations={observations}
    />
  );
}
