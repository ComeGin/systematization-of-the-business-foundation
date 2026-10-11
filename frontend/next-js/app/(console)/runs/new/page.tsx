import { ConfigErrorView } from "@/components/common/ConfigErrorView";
import { RunCreateView } from "@/components/runs/RunCreateView";
import { getControlPlaneState } from "@/lib/control-plane";
import { requirePageSession } from "@/lib/session";

// 新規: 手動の起動。?jobId= があれば、その定義を選んだ状態で開く（ジョブの詳細の「手動で起動」から）
export default async function RunCreatePage(props: PageProps<"/runs/new">) {
  await requirePageSession();
  const state = getControlPlaneState();
  if (!state.plane) return <ConfigErrorView message={state.error} />;

  const [{ jobId }, jobs] = await Promise.all([props.searchParams, state.plane.listJobs()]);
  return (
    <RunCreateView
      jobs={jobs.map((job) => ({ id: job.definition.id, description: job.definition.description }))}
      initialJobId={typeof jobId === "string" ? jobId : null}
    />
  );
}
