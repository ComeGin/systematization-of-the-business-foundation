import { notFound } from "next/navigation";
import { ConfigErrorView } from "@/components/ConfigErrorView";
import { RunDetail } from "@/components/RunDetail";
import { Shell } from "@/components/Shell";
import { getControlPlaneState } from "@/lib/control-plane";
import { requirePageSession } from "@/lib/session";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export default async function RunPage(props: PageProps<"/runs/[runId]">) {
  const session = await requirePageSession();
  const { runId } = await props.params;
  const state = getControlPlaneState();
  if (!state.plane) {
    return (
      <Shell title="実行記録" userName={session.user.name}>
        <ConfigErrorView message={state.error} />
      </Shell>
    );
  }
  if (!ULID.test(runId)) notFound();
  const run = await state.plane.getRun(runId);
  if (!run) notFound();
  return (
    <Shell title="実行記録" userName={session.user.name}>
      <RunDetail run={run} />
    </Shell>
  );
}
