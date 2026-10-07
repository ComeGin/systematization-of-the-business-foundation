import { ConfigErrorView } from "@/components/common/ConfigErrorView";
import { CandidatesListView } from "@/components/miswrite-candidates/CandidatesListView";
import { getControlPlaneState } from "@/lib/control-plane";
import { requirePageSession } from "@/lib/session";

// 一覧: 誤った書き込みの候補
export default async function MiswriteCandidatesPage() {
  await requirePageSession();
  const state = getControlPlaneState();
  if (!state.plane) return <ConfigErrorView message={state.error} />;
  return <CandidatesListView candidates={await state.plane.listMiswriteCandidates()} />;
}
