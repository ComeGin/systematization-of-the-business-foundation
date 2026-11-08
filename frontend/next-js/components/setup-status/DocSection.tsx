"use client";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import TextContent from "@cloudscape-design/components/text-content";
import type { SetupDocSection } from "control-plane";
import { useEffect, useState } from "react";
import { Markdown } from "@/components/common/Markdown";
import { docUrl } from "./status-format";

type LoadState = { kind: "loading" } | { kind: "ready"; section: SetupDocSection } | { kind: "missing" } | { kind: "error" };

/**
 * 正本の手順書の 1 節。開いたときに API から読み、Markdown として描く。
 * 本文は承認済みの main のチェックアウトから読んだもの（作業ツリーの未承認の手順書は出さない）。生の HTML は描かない。
 */
export function DocSection({ file, heading: headingText }: { file: string; heading: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch(docUrl(file, headingText), { signal: controller.signal });
        if (response.status === 404) return setState({ kind: "missing" });
        if (!response.ok) return setState({ kind: "error" });
        setState({ kind: "ready", section: (await response.json()) as SetupDocSection });
      } catch {
        if (!controller.signal.aborted) setState({ kind: "error" });
      }
    })();
    return () => controller.abort();
  }, [file, headingText]);

  const source = (
    <Box variant="small" color="text-body-secondary">
      {file} の「{headingText}」
    </Box>
  );

  if (state.kind === "loading") return <StatusIndicator type="loading">手順書を読んでいます</StatusIndicator>;
  if (state.kind === "missing") {
    return (
      <Alert type="warning" header="手順書の節が見つかりません">
        {source}
        <Box variant="p">承認済みの main に無いか、見出しが変わっています。</Box>
      </Alert>
    );
  }
  if (state.kind === "error") {
    return (
      <Alert type="error" header="手順書を読めませんでした">
        {source}
      </Alert>
    );
  }
  return (
    <div>
      {source}
      <TextContent>
        <Markdown>{state.section.markdown}</Markdown>
      </TextContent>
    </div>
  );
}
