import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Cloudscape の Link は描かずに、渡した props（onFollow）を取り出す。node の環境では CSS を読めないため差し替える
const mocks = vi.hoisted(() => {
  const captured: { props: { variant?: string; onFollow?: () => void; children?: unknown } | null } = { props: null };
  return {
    captured,
    Link: function Link(props: { variant?: string; onFollow?: () => void; children?: unknown }) {
      captured.props = props;
      return null;
    },
  };
});

vi.mock("@cloudscape-design/components/link", () => ({ default: mocks.Link }));

import { InfoLink, ToolsContext } from "@/components/layout/tools-context";

beforeEach(() => {
  mocks.captured.props = null;
});

describe("InfoLink", () => {
  describe("正常系", () => {
    it("info の「情報」リンクを出し、押すと ConsoleLayout が入れた openTools を呼ぶ", () => {
      const openTools = vi.fn(() => {});
      renderToStaticMarkup(createElement(ToolsContext.Provider, { value: { openTools } }, createElement(InfoLink)));
      expect(mocks.captured.props).toMatchObject({ variant: "info", children: "情報" });
      mocks.captured.props?.onFollow?.();
      expect(openTools).toHaveBeenCalledTimes(1);
    });
  });

  describe("異常系", () => {
    it("空入力: ConsoleLayout の外（値が入っていない）で押しても例外にしない", () => {
      renderToStaticMarkup(createElement(InfoLink));
      expect(() => mocks.captured.props?.onFollow?.()).not.toThrow();
      expect(mocks.captured.props?.onFollow).toBeTypeOf("function");
    });
  });
});
