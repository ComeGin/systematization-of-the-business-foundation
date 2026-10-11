import { ConfigErrorView } from "@/components/common/ConfigErrorView";
import { JobsListView } from "@/components/jobs/JobsListView";
import { getControlPlaneState } from "@/lib/control-plane";
import { requirePageSession } from "@/lib/session";

// 一覧: 定期実行のジョブ
export default async function JobsPage() {
  await requirePageSession();
  const state = getControlPlaneState();
  if (!state.plane) return <ConfigErrorView message={state.error} />;
  return <JobsListView jobs={await state.plane.listJobs()} />;
}
