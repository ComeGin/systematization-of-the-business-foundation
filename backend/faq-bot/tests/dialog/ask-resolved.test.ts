import { describe, expect, it } from "vitest";
import { CHOICE, MESSAGES } from "../../src/constants.js";
import { askResolvedReply } from "../../src/dialog/ask-resolved.js";

describe("askResolvedReply", () => {
  describe("正常系", () => {
    it("本文と［解決しました］だけの選択肢（値は前の仕様と同じ __resolved）", () => {
      expect(askResolvedReply()).toEqual({
        kind: "select",
        content: MESSAGES.askResolved,
        items: [{ title: MESSAGES.choiceResolved, value: CHOICE.resolved }],
      });
    });
  });
});
