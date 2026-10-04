// control-plane のインスタンスは、プロセスで 1 つだけ持つ。
// instrumentation と Route Handler・Server Component はモジュールの読み込みが別になりうる（dev の HMR を含む）ため、
// モジュール変数ではなく globalThis に置く。
import { createControlPlane, type ControlPlane } from "control-plane";

type ControlPlaneState = { plane: ControlPlane; error: null } | { plane: null; error: string };

declare global {
  var __comeginControlPlane: ControlPlaneState | undefined;
}

function build(): ControlPlaneState {
  try {
    return { plane: createControlPlane(), error: null };
  } catch (error) {
    // ConfigError のメッセージは変数名と理由だけ（値を含まない）。それ以外は詳細を画面に出さない
    const isConfigError = error instanceof Error && error.name === "ConfigError"; // name で判定（api.ts と同じ理由）
    const message = isConfigError
      ? (error as Error).message
      : "control-plane の初期化に失敗しました（サーバーの stderr を確認してください）";
    if (!isConfigError) {
      console.error(`- ERROR control-plane 初期化に失敗: ${error instanceof Error ? error.message : "不明"}`);
    }
    return { plane: null, error: message };
  }
}

export function getControlPlaneState(): ControlPlaneState {
  globalThis.__comeginControlPlane ??= build();
  return globalThis.__comeginControlPlane;
}

/** 起動時（instrumentation）に 1 回だけ呼ぶ。start() は冪等。 */
export async function startControlPlane(): Promise<void> {
  const state = getControlPlaneState();
  if (state.plane) await state.plane.start();
}
