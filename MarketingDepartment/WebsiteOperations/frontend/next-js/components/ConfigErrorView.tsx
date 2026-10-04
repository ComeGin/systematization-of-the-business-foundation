"use client";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";

/** control-plane の設定が不正なとき（変数名と理由だけ。値は含まれない）。 */
export function ConfigErrorView({ message }: { message: string }) {
  return (
    <Alert type="error" header="control-plane を開始できません">
      <Box variant="code">
        <span style={{ whiteSpace: "pre-wrap" }}>{message}</span>
      </Box>
      <Box variant="p">環境変数（backend/control-plane/.env.example が正本）を直して、サーバーを再起動してください。</Box>
    </Alert>
  );
}
