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
  const job = (await state.plane.listJobs()).find((candidate) => candidate.definition.id === jobId);
  if (!job) notFound();
  const runs = await state.plane.listRuns({ jobId: job.definition.id, limit: RUN_LIMIT });
  return <JobDetailView job={job} runs={runs} runLimit={RUN_LIMIT} />;
}
