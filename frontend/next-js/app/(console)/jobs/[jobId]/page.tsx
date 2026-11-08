import { notFound } from "next/navigation";
import { ConfigErrorView } from "@/components/common/ConfigErrorView";
import { JobDetailView } from "@/components/jobs/JobDetailView";
import { getControlPlaneState } from "@/lib/control-plane";
import { requirePageSession } from "@/lib/session";

const RUN_LIMIT = 50;

// 詳細: 定期実行のジョブ 1 件と、その子リソース（このジョブの実行記録）
export default async function JobPage(props: PageProps<"/jobs/[jobId]">) {
  await requirePageSession();
  const { jobId } = await props.params;
  const state = getControlPlaneState();
  if (!state.plane) return <ConfigErrorView message={state.error} />;

  // 契約に 1 件の取得は無いので、一覧から探す（定義に無い id は 404。実行記録の検索に任意の文字列を渡さない）
  const jobs = await state.plane.listJobs();
  const job = jobs.find((candidate) => candidate.definition.id === jobId);
  if (!job) notFound();
  const { definition } = job;
  const [runs, agent] = await Promise.all([
    state.plane.listRuns({ jobId: definition.id, limit: RUN_LIMIT }),
    definition.kind === "agent" && definition.agent ? state.plane.getAgent(definition.agent) : Promise.resolve(null),
  ]);
  const observations =
    runs.length === 0 ? {} : Object.fromEntries((await state.plane.listRunObservations(runs.map((run) => run.runId))).map((o) => [o.runId, o]));
  return (
    <JobDetailView
      job={job}
      jobs={jobs.map((candidate) => candidate.definition)}
      runs={runs}
      runLimit={RUN_LIMIT}
      observations={observations}
      agent={agent}
    />
  );
}
