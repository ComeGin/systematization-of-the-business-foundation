import { CandidatesTable } from "@/components/CandidatesTable";
import { ConfigErrorView } from "@/components/ConfigErrorView";
import { JobsTable } from "@/components/JobsTable";
import { ManualRunForm } from "@/components/ManualRunForm";
import { RunsTable } from "@/components/RunsTable";
import { Shell } from "@/components/Shell";
import { getControlPlaneState } from "@/lib/control-plane";
import { requirePageSession } from "@/lib/session";

// ログイン必須（requirePageSession が headers() を読むため、毎回サーバーで描画される）
export default async function HomePage() {
  const session = await requirePageSession();
  const state = getControlPlaneState();
  if (!state.plane) {
    return (
      <Shell title="監視アプリ" userName={session.user.name}>
        <ConfigErrorView message={state.error} />
      </Shell>
    );
  }

  const [runs, jobs, candidates] = await Promise.all([
    state.plane.listRuns({ limit: 50 }),
    state.plane.listJobs(),
    state.plane.listMiswriteCandidates(),
  ]);

  return (
    <Shell title="監視アプリ" userName={session.user.name}>
      <ManualRunForm jobs={jobs.map((job) => ({ id: job.definition.id, description: job.definition.description }))} />
      <RunsTable runs={runs} />
      <JobsTable jobs={jobs} />
      <CandidatesTable candidates={candidates} />
    </Shell>
  );
}
