import { notFound } from "next/navigation";
import { ConfigErrorView } from "@/components/common/ConfigErrorView";
import { RunDetailView } from "@/components/runs/RunDetailView";
import { getControlPlaneState } from "@/lib/control-plane";
import { ULID } from "@/lib/ids";
import { requirePageSession } from "@/lib/session";

// 詳細: 実行 1 件（E-15）と、その子リソース（この実行が書いた・対象にした観測〈E-12〉と、この実行に近い誤った書き込みの候補）
export default async function RunPage(props: PageProps<"/runs/[runId]">) {
  await requirePageSession();
  const { runId } = await props.params;
  const state = getControlPlaneState();
  if (!state.plane) return <ConfigErrorView message={state.error} />;
  if (!ULID.test(runId)) notFound();

  const [run, candidates, observations] = await Promise.all([
    state.plane.getRun(runId),
    state.plane.listMiswriteCandidates(),
    state.plane.listRunObservations([runId]),
  ]);
  if (!run) notFound();
  return (
    <RunDetailView
      run={run}
      candidates={candidates.filter((candidate) => candidate.nearestRunId === run.runId)}
      observations={observations[0] ?? null}
    />
  );
}
