import { describe, expect, it } from "vitest";
import { isStillPath, shouldSkipTransition } from "@/modules/page-transition/client";

describe("isStillPath", () => {
  describe("正常系", () => {
    it("規約・ポリシーは true", () => {
      expect(isStillPath("/legal/privacy/")).toBe(true);
      expect(isStillPath("/legal/tokushoho")).toBe(true);
    });
    it("ほかのページは false", () => {
      for (const p of ["/", "/services/", "/pricing/", "/blog/x/", "/legalese/"]) expect(isStillPath(p)).toBe(false);
    });
  });
  describe("異常系", () => {
    it("空入力: 空文字は false", () => expect(isStillPath("")).toBe(false));
  });
});

describe("shouldSkipTransition", () => {
  describe("正常系", () => {
    it("C のページへ入る・出るときは true", () => {
      expect(shouldSkipTransition("/", "/legal/privacy/")).toBe(true);
      expect(shouldSkipTransition("/legal/tokushoho/", "/pricing/")).toBe(true);
    });
    it("A・B どうしは false", () => expect(shouldSkipTransition("/services/", "/services/development/")).toBe(false));
  });
  describe("異常系", () => {
    it("空入力: 移動元が空なら移動先だけで決める", () => {
      expect(shouldSkipTransition("", "/legal/privacy/")).toBe(true);
      expect(shouldSkipTransition("", "/")).toBe(false);
    });
  });
});
