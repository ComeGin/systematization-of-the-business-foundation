import { ConfigErrorView } from "@/components/common/ConfigErrorView";
import { JobsListView } from "@/components/jobs/JobsListView";
import { getControlPlaneState } from "@/lib/control-plane";
import { requirePageSession } from "@/lib/session";

// 一覧: 定期実行のジョブ。「直近の中身」のため、直近の実行の観測をまとめて 1 回で読む
export default async function JobsPage() {
  await requirePageSession();
  const state = getControlPlaneState();
  if (!state.plane) return <ConfigErrorView message={state.error} />;
  const jobs = await state.plane.listJobs();
  const runIds = jobs.flatMap((job) => (job.lastRun ? [job.lastRun.runId] : []));
  const observations =
    runIds.length === 0 ? {} : Object.fromEntries((await state.plane.listRunObservations(runIds)).map((o) => [o.runId, o]));
  return <JobsListView jobs={jobs} observations={observations} />;
}
