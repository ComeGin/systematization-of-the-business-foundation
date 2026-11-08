import ExpandableSection from "@cloudscape-design/components/expandable-section";

/** これを超える長さの文は折りたたむ（設計 6 節） */
export const AGENT_TEXT_FOLD_LENGTH = 500;

/**
 * エージェントが書いた文（観測の fetch.note・実行の要約）を、文字のまま出す。
 * HTML・Markdown として解釈しない（React が文字として逃がす）。長い文は折りたたむ。
 */
export function AgentText({ text }: { text: string | null }) {
  if (!text) return <span>-</span>;
  const body = <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{text}</span>;
  if (text.length <= AGENT_TEXT_FOLD_LENGTH) return body;
  return (
    <ExpandableSection headerText={`${text.slice(0, 80)}…（${text.length} 文字。開くと全文）`} variant="footer">
      {body}
    </ExpandableSection>
  );
}
