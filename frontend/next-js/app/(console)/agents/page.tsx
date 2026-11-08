import { AgentsListView } from "@/components/agents/AgentsListView";
import { ConfigErrorView } from "@/components/common/ConfigErrorView";
import { getControlPlaneState } from "@/lib/control-plane";
import { requirePageSession } from "@/lib/session";

// 一覧: Agent（承認済み main の .claude/agents/*.md）
export default async function AgentsPage() {
  await requirePageSession();
  const state = getControlPlaneState();
  if (!state.plane) return <ConfigErrorView message={state.error} />;
  return <AgentsListView listing={await state.plane.listAgents()} />;
}
