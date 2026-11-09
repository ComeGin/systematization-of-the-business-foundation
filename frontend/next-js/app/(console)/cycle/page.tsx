import { ConfigErrorView } from "@/components/common/ConfigErrorView";
import { CycleView } from "@/components/cycle/CycleView";
import { loadCyclePageData } from "@/components/cycle/load";
import { getControlPlaneState } from "@/lib/control-plane";
import { requirePageSession } from "@/lib/session";

// 改善ループ: 今日の周。まだ開かれていない（または設定が無い）ときは cycle が null で、理由を出す
export default async function CyclePage() {
  await requirePageSession();
  const state = getControlPlaneState();
  if (!state.plane) return <ConfigErrorView message={state.error} />;
  const data = await loadCyclePageData(state.plane);
  return <CycleView {...data} current />;
}
