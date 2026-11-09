import type { StatusIndicatorProps } from "@cloudscape-design/components/status-indicator";
import type { CycleItemKind, CycleItemState, CycleStage } from "control-plane";

// AppLayoutToolbar の読み上げ用のラベル（ConsoleLayout と PublicLayout で共通）。
export const APP_LAYOUT_LABELS = {
  navigation: "ナビゲーション",
  navigationClose: "ナビゲーションを閉じる",
  navigationToggle: "ナビゲーションを開く",
  tools: "ヘルプ",
  toolsClose: "ヘルプを閉じる",
  toolsToggle: "ヘルプを開く",
  notifications: "通知",
};

// ---- 改善ループの画面の表示名（段階・状態・種類）。キーは control-plane の contract.ts の型 ----
export const CYCLE_STAGE_LABEL: Record<CycleStage, string> = {
  collect: "① データ取得",
  propose: "② 解析と改修案",
  draft: "③ 下書き",
  review: "④ 承認",
  publish: "⑤ 公開・送信",
  evaluate: "⑥ 評価・改修",
  deploy: "⑦ ビルド・配信",
};

export const CYCLE_STAGE_STATUS_LABEL: Record<"done" | "awaiting" | "not_started" | "stuck", string> = {
  done: "済み",
  awaiting: "承認待ち",
  not_started: "未着手",
  stuck: "止まっている",
};

export const CYCLE_STAGE_STATUS_TYPE: Record<"done" | "awaiting" | "not_started" | "stuck", StatusIndicatorProps.Type> = {
  done: "success",
  awaiting: "info",
  not_started: "stopped",
  stuck: "error",
};

export const CYCLE_ITEM_STATE_LABEL: Record<CycleItemState, string> = {
  preparing: "作成中",
  awaiting_review: "承認待ち",
  approved: "OK 済み（実行待ち）",
  executed: "実行済み（確認中）",
  confirmed: "確認済み",
  rejected: "差し戻し",
  failed_check: "確認できなかった",
};

export const CYCLE_ITEM_STATE_TYPE: Record<CycleItemState, StatusIndicatorProps.Type> = {
  preparing: "loading",
  awaiting_review: "info",
  approved: "pending",
  executed: "in-progress",
  confirmed: "success",
  rejected: "stopped",
  failed_check: "error",
};

export const CYCLE_ITEM_KIND_LABEL: Record<CycleItemKind, string> = {
  article: "記事",
  campaign: "メールのキャンペーン",
  code: "コードの差分",
  deploy: "配信",
  proposal: "改修案（PR）",
  manual: "人の作業",
};
