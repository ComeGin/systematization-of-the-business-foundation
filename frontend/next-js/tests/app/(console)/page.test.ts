import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import HomePage from "@/app/(console)/page";

// 入力の無い転送だけのページなので正常系だけ
describe("/（入口のページ）", () => {
  describe("正常系", () => {
    it("実行記録の一覧（/runs）へ転送する", () => {
      expect(() => HomePage()).toThrow("NEXT_REDIRECT /runs");
      expect(mocks.redirect).toHaveBeenCalledWith("/runs");
    });
  });
});
