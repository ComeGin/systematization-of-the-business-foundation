import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ComponentProps } from "react";
import { isExternalHttpUrl } from "@/components/setup-status/status-format";

// 手順書・Agent の手順（承認済み main の Markdown）を描く共通の部品。生の HTML は描かない（react-markdown の既定）。
// 設定の状況の DocSection から移した（2026-11-06。Agent の画面でも使う）

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

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
      {children}
    </ReactMarkdown>
  );
}
