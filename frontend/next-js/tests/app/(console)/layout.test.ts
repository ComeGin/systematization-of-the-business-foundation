import { beforeEach, describe, expect, it, vi } from "vitest";
import { asElement } from "../../helpers/page";

const mocks = vi.hoisted(() => ({
  requirePageSession: vi.fn(async (): Promise<{ user: { name: string } }> => ({ user: { name: "管理者" } })),
  ConsoleLayout: function ConsoleLayout() {
    return null;
  },
}));

vi.mock("@/lib/session", () => ({ requirePageSession: mocks.requirePageSession }));
vi.mock("@/components/layout/ConsoleLayout", () => ({ ConsoleLayout: mocks.ConsoleLayout }));

import ConsoleRootLayout from "@/app/(console)/layout";

const CHILD = "子のページ";

async function render() {
  return asElement<{ userName: string; children: unknown }>(
    await ConsoleRootLayout({ params: Promise.resolve({}), children: CHILD } as LayoutProps<"/">),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("(console) のレイアウト", () => {
  describe("正常系", () => {
    it("セッションのユーザー名を外枠に渡し、子のページをそのまま中に置く", async () => {
      const element = await render();
      expect(element.type).toBe(mocks.ConsoleLayout);
      expect(element.props).toEqual({ userName: "管理者", children: CHILD });
    });

    it("空入力: ユーザー名が空文字でもそのまま渡す（外枠の描画は止めない）", async () => {
      mocks.requirePageSession.mockResolvedValue({ user: { name: "" } });
      expect((await render()).props.userName).toBe("");
    });
  });

  describe("異常系", () => {
    it("入力: 未ログインなら（requirePageSession が /login へ送り）外枠を出さない", async () => {
      mocks.requirePageSession.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
      await expect(render()).rejects.toThrow("NEXT_REDIRECT /login");
    });

    it("サーバ: ログインの仕組みが使えないときの例外は握りつぶさない", async () => {
      mocks.requirePageSession.mockRejectedValue(new Error("SQLITE_CANTOPEN"));
      await expect(render()).rejects.toThrow("SQLITE_CANTOPEN");
    });
  });
});
