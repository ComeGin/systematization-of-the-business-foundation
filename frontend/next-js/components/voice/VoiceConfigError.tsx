"use client";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";

/** LiveKit の環境変数が足りないとき（変数名だけ。値は含まれない） */
export function VoiceConfigError({ missing }: { missing: string[] }) {
  return (
    <Alert type="error" header="音声 BI を開始できません">
      <Box variant="p">次の環境変数が設定されていません: {missing.join("・")}</Box>
      <Box variant="p">frontend/next-js/.env.example の「音声 BI」の節を見て設定し、監視アプリを再起動してください。</Box>
    </Alert>
  );
}
