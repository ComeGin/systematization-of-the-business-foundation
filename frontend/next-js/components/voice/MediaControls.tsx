"use client";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { ControlBar } from "@livekit/components-react";
import { Track } from "livekit-client";
import { useState } from "react";

const SOURCE_LABEL: Partial<Record<Track.Source, string>> = {
  [Track.Source.Microphone]: "マイク",
  [Track.Source.Camera]: "カメラ",
  [Track.Source.ScreenShare]: "画面共有",
};

/**
 * マイク・カメラ・画面共有のボタン（ControlBar）。退室は画面上部の「終了」で行うので、ここには出さない。
 * マイクの取り込みの設定（エコー除去だけを有効）は Room の audioCaptureDefaults（VoiceSession.tsx）で決めている。
 */
export function MediaControls({ disabled }: { disabled: boolean }) {
  const [deviceError, setDeviceError] = useState<string | null>(null);

  if (disabled) {
    return <Box color="text-status-inactive">接続すると使えます。</Box>;
  }

  return (
    <SpaceBetween size="s">
      <div data-lk-theme="default" style={{ borderRadius: 8, padding: 8 }}>
        <ControlBar
          variation="minimal"
          saveUserChoices={false}
          controls={{ microphone: true, camera: true, screenShare: true, chat: false, leave: false, settings: false }}
          onDeviceError={({ source }) => setDeviceError(`${SOURCE_LABEL[source] ?? source}を開始できませんでした（ブラウザの許可を確かめてください）。`)}
        />
      </div>
      <Box variant="small">左から マイク・カメラ・画面共有。画面について聞くときは、画面共有を始めてから「この画面の〜は？」のように聞いてください。</Box>
      {deviceError ? (
        <Alert type="warning" dismissible onDismiss={() => setDeviceError(null)}>
          {deviceError}
        </Alert>
      ) : null}
    </SpaceBetween>
  );
}
