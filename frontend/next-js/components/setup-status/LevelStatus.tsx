"use client";

import StatusIndicator from "@cloudscape-design/components/status-indicator";
import type { SetupStatusLevel } from "control-plane";
import { LEVEL_INDICATOR } from "./status-format";

/** 判定の印。段階にも項目にも件数にも同じ表示を使う。 */
export function LevelStatus({ level }: { level: SetupStatusLevel }) {
  const { type, label } = LEVEL_INDICATOR[level];
  return <StatusIndicator type={type}>{label}</StatusIndicator>;
}
