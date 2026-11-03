"use client";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import TextContent from "@cloudscape-design/components/text-content";
import type { SetupDocSection } from "control-plane";
import { useEffect, useState, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { docUrl, isExternalHttpUrl } from "./status-format";

type LoadState = { kind: "loading" } | { kind: "ready"; section: SetupDocSection } | { kind: "missing" } | { kind: "error" };

// 手順書の見出しは画面の見出し（h1〜h3）より下に収める
const heading = (tag: "h4" | "h5" | "h6") =>
  function Heading({ children }: ComponentProps<"h1">) {
    const Tag = tag;
    return <Tag>{children}</Tag>;
  };

const MARKDOWN_COMPONENTS: ComponentProps<typeof ReactMarkdown>["components"] = {
  h1: heading("h4"),
  h2: heading("h4"),
  h3: heading("h4"),
  h4: heading("h5"),
  h5: heading("h6"),
  h6: heading("h6"),
  // 絶対の http(s) だけリンクにする。相対パスはリポジトリ内のパスなので、文字（コードの形）として出す
  a({ href, children }) {
    if (isExternalHttpUrl(href)) {
      return (
        <a href={href} rel="noreferrer">
          {children}
        </a>
      );
    }
    return <code>{children}</code>;
  },
  // 画像は読み込まない（相対パスで、この画面からは届かない）。代替文だけ出す
  img({ alt }) {
    return <span>{alt ?? ""}</span>;
  },
  table({ children }) {
    return (
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse" }}>{children}</table>
      </div>
    );
  },
  th({ children }) {
    return <th style={{ border: "1px solid rgba(128,128,128,0.45)", padding: "4px 8px", textAlign: "left" }}>{children}</th>;
  },
  td({ children }) {
    return <td style={{ border: "1px solid rgba(128,128,128,0.45)", padding: "4px 8px", verticalAlign: "top" }}>{children}</td>;
  },
  pre({ children }) {
    return <pre style={{ overflowX: "auto" }}>{children}</pre>;
  },
};

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
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
          {state.section.markdown}
        </ReactMarkdown>
      </TextContent>
    </div>
  );
}
