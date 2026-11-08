import StatusIndicator from "@cloudscape-design/components/status-indicator";
import type { RunObservations } from "control-plane";
import { summarizeContent } from "./observation-format";

/** 実行の「中身」（書いた観測の取得の結果）。実行が成功でも、取得に失敗した観測があれば目立たせる */
export function ContentStatus({ observations }: { observations: RunObservations | undefined }) {
  const content = summarizeContent(observations);
  if (content.kind === "none") return <span>-</span>;
  if (content.kind === "ok") return <StatusIndicator type="success">問題なし（{content.total} 件）</StatusIndicator>;
  return (
    <StatusIndicator type="error">
      取得に失敗 {content.failed} / {content.total} 件
    </StatusIndicator>
  );
}
