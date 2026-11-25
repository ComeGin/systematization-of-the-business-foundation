"use client";

import Alert from "@cloudscape-design/components/alert";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator, { type StatusIndicatorProps } from "@cloudscape-design/components/status-indicator";
import { type AgentState, BarVisualizer, useAgent } from "@livekit/components-react";

const STATE_LABEL: Record<AgentState, { text: string; type: StatusIndicatorProps.Type }> = {
  disconnected: { text: "未接続", type: "stopped" },
  connecting: { text: "接続しています", type: "in-progress" },
  "pre-connect-buffering": { text: "エージェントを待っています（話し始めて大丈夫です）", type: "pending" },
  initializing: { text: "準備しています", type: "in-progress" },
  idle: { text: "待機中", type: "info" },
  listening: { text: "聞いています", type: "success" },
  thinking: { text: "考えています", type: "loading" },
  speaking: { text: "話しています", type: "info" },
  failed: { text: "エージェントに接続できません", type: "error" },
};

/** エージェントの状態（聞いている・考えている・話している）と、エージェントの声の波形 */
export function AgentPanel() {
  const agent = useAgent();
  const label = STATE_LABEL[agent.state];

  return (
    <SpaceBetween size="s">
      <StatusIndicator type={label.type}>{label.text}</StatusIndicator>
      {/* data-lk-theme は LiveKit の部品の色（--lk-*）をこの枠の中だけに与える */}
      <div data-lk-theme="default" style={{ height: 120, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <BarVisualizer track={agent.microphoneTrack} state={agent.state} barCount={7} style={{ height: 96, width: "60%" }} />
      </div>
      {agent.state === "failed" ? (
        <Alert type="warning" header="エージェントが部屋に入りませんでした">
          オンプレのエージェント（comegin-livekit-agent）が動いているか、SFU に接続できているかを確かめてください。
          {agent.failureReasons.length > 0 ? `（${agent.failureReasons.join("・")}）` : null}
        </Alert>
      ) : null}
    </SpaceBetween>
  );
}
