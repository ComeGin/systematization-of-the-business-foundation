"use client";

import Box from "@cloudscape-design/components/box";
import CopyToClipboard from "@cloudscape-design/components/copy-to-clipboard";
import SpaceBetween from "@cloudscape-design/components/space-between";

/**
 * OK の後の手順。文は上から順に行い、コマンドはコピーして自分の端末で実行する
 * （この画面からは実行しない。公開・送信・配信は人が行う）。
 */
export function CommandList({ steps }: { steps: { text: string; command: string | null }[] }) {
  if (steps.length === 0) return <Box color="text-body-secondary">手順はありません</Box>;
  return (
    <ol style={{ margin: 0, paddingInlineStart: 20 }}>
      {steps.map((step, index) => (
        // 同じ文の手順が 2 つあってもキーが重ならないよう、位置を含める
        <li key={`${index}-${step.text}`} style={{ marginBlockEnd: 8 }}>
          <SpaceBetween size="xxs">
            <span style={{ whiteSpace: "pre-wrap" }}>{step.text}</span>
            {step.command ? (
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Box variant="code">
                    <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{step.command}</span>
                  </Box>
                </div>
                <CopyToClipboard
                  variant="icon"
                  textToCopy={step.command}
                  copyButtonAriaLabel={`コマンドをコピー: ${step.command}`}
                  copySuccessText="コピーしました"
                  copyErrorText="コピーできませんでした"
                />
              </div>
            ) : null}
          </SpaceBetween>
        </li>
      ))}
    </ol>
  );
}
