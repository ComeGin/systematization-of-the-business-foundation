import { notFound } from "next/navigation";
import { ConfigErrorView } from "@/components/common/ConfigErrorView";
import { CycleView } from "@/components/cycle/CycleView";
import { loadCyclePageData } from "@/components/cycle/load";
import { getControlPlaneState } from "@/lib/control-plane";
import { CYCLE_ID } from "@/lib/ids";
import { requirePageSession } from "@/lib/session";

// 改善ループ: 指定した周（C-YYYY-MM-DD）。形が違う ID は 404（control-plane に任意の文字列を渡さない）。まだ無い周は cycle が null で、理由を出す
export default async function CycleByIdPage(props: PageProps<"/cycle/[cycleId]">) {
  await requirePageSession();
  const { cycleId } = await props.params;
  if (!CYCLE_ID.test(cycleId)) notFound();
  const state = getControlPlaneState();
  if (!state.plane) return <ConfigErrorView message={state.error} />;
  const data = await loadCyclePageData(state.plane, cycleId);
  return <CycleView {...data} current={false} />;
}
