import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Cloudscape の部品は node の環境で CSS を読めないので、子をそのまま描く部品に差し替える
vi.mock("@cloudscape-design/components/expandable-section", () => ({
  default: function ExpandableSection(props: { headerText?: string; children?: unknown }) {
    return createElement("section", { "data-header": props.headerText }, props.children as never);
  },
}));

import { AGENT_TEXT_FOLD_LENGTH, AgentText } from "@/components/common/AgentText";

const html = (text: string | null) => renderToStaticMarkup(createElement(AgentText, { text }));

describe("AgentText", () => {
  describe("正常系", () => {
    it("短い文はそのまま出し、折りたたまない", () => {
      const out = html("取得できなかった。");
      expect(out).toContain("取得できなかった。");
      expect(out).not.toContain("<section");
    });

    it("500 文字を超える文は折りたたみ、中に全文がある", () => {
      expect(AGENT_TEXT_FOLD_LENGTH).toBe(500);
      const long = `${"あ".repeat(500)}末尾`;
      const out = html(long);
      expect(out).toContain("<section");
      expect(out).toContain("末尾");
    });

    it("空入力: null や空文字は「-」", () => {
      expect(html(null)).toContain("-");
      expect(html("")).toContain("-");
    });
  });

  describe("異常系", () => {
    it("入力: <script> と **太字** を含む文はそのままの文字で出る（HTML・Markdown として解釈しない）", () => {
      const out = html("<script>alert(1)</script> **太字**");
      expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(out).toContain("**太字**");
      expect(out).not.toContain("<strong>");
      expect(out).not.toContain("<script>");
    });
  });
});
