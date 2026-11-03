import { ConfigErrorView } from "@/components/common/ConfigErrorView";
import { SetupStatusView } from "@/components/setup-status/SetupStatusView";
import { resolveStepId } from "@/components/setup-status/status-format";
import { getControlPlaneState } from "@/lib/control-plane";
import { requirePageSession } from "@/lib/session";

// 設定の状況: 段階の地図（左）と、選んだ段階の項目（右）。選んだ段階は ?step=P12 のように URL に持つ
export default async function SetupStatusPage(props: PageProps<"/setup-status">) {
  await requirePageSession();
  const { step } = await props.searchParams;
  const state = getControlPlaneState();
  if (!state.plane) return <ConfigErrorView message={state.error} />;

  const view = await state.plane.getSetupStatus();
  return <SetupStatusView view={view} selectedStepId={resolveStepId(view.steps, step)} />;
}
