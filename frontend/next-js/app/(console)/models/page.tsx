import { ConfigErrorView } from "@/components/common/ConfigErrorView";
import { ModelsView } from "@/components/models/ModelsView";
import { getControlPlaneState } from "@/lib/control-plane";
import { requirePageSession } from "@/lib/session";

// 実行モデル: Anthropic（エージェント）と OpenAI（アイキャッチ画像）のモデルを選ぶ。選べる一覧は各社の API から読む
export default async function ModelsPage() {
  await requirePageSession();
  const state = getControlPlaneState();
  if (!state.plane) return <ConfigErrorView message={state.error} />;
  const view = await state.plane.getModelSettings();
  return <ModelsView initial={view} />;
}
