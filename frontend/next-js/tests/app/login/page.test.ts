import { beforeEach, describe, expect, it, vi } from "vitest";
import { asElement } from "../../helpers/page";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(async (): Promise<unknown> => null),
  isGoogleConfigured: vi.fn(() => true),
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  PublicLayout: function PublicLayout() {
    return null;
  },
  GoogleSignIn: function GoogleSignIn() {
    return null;
  },
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/auth", () => ({ isGoogleConfigured: mocks.isGoogleConfigured }));
vi.mock("@/components/layout/PublicLayout", () => ({ PublicLayout: mocks.PublicLayout }));
vi.mock("@/components/auth/GoogleSignIn", () => ({ GoogleSignIn: mocks.GoogleSignIn }));

import LoginPage from "@/app/login/page";

type SignInProps = { configured: boolean; error: string | null };
const REFUSED_PREFIX = "ログインできませんでした";

async function render(searchParams: Record<string, string | string[] | undefined> = {}) {
  const layout = asElement<{ title: string; children: unknown }>(await LoginPage({ searchParams: Promise.resolve(searchParams) }));
  return { layout, signIn: asElement<SignInProps>(layout.props.children) };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("/login（ログインのページ）", () => {
  describe("正常系", () => {
    it("未ログインならログインの画面を出し、Google の資格情報の有無を渡す", async () => {
      const { layout, signIn } = await render();
      expect(layout.type).toBe(mocks.PublicLayout);
      expect(layout.props.title).toBe("ログイン");
      expect(signIn.type).toBe(mocks.GoogleSignIn);
      expect(signIn.props).toEqual({ configured: true, error: null });
    });

    it("Google の資格情報が無ければ configured=false を渡す（画面で案内を出す）", async () => {
      mocks.isGoogleConfigured.mockReturnValue(false);
      const { signIn } = await render();
      expect(signIn.props.configured).toBe(false);
    });

    it("ログイン済みなら / へ転送する", async () => {
      mocks.getSession.mockResolvedValue({ user: { id: "u1" } });
      await expect(render()).rejects.toThrow("NEXT_REDIRECT /");
      expect(mocks.redirect).toHaveBeenCalledWith("/");
    });
  });

  describe("異常系", () => {
    it.each(["unable_to_get_user_info", "FORBIDDEN", "<script>alert(1)</script>"])(
      "入力: ?error=%s なら、理由を区別しない 1 つの文を出す（値は画面に出さない）",
      async (error) => {
        const { signIn } = await render({ error });
        expect(signIn.props.error).toContain(REFUSED_PREFIX);
        expect(signIn.props.error).toContain("CONTROL_ADMIN_EMAILS");
        expect(signIn.props.error).not.toContain(error);
      },
    );

    it("入力: ?error= を 2 回指定（配列）したら文を出さない", async () => {
      const { signIn } = await render({ error: ["a", "b"] });
      expect(signIn.props.error).toBeNull();
    });

    it("空入力: ?error= が空文字なら文を出さない", async () => {
      const { signIn } = await render({ error: "" });
      expect(signIn.props.error).toBeNull();
    });

    it("サーバ: ログインの仕組みが使えない（セッションの確認が例外）ときは握りつぶさない", async () => {
      mocks.getSession.mockRejectedValue(new Error("SQLITE_CANTOPEN"));
      await expect(render()).rejects.toThrow("SQLITE_CANTOPEN");
      expect(mocks.redirect).not.toHaveBeenCalled();
    });
  });
});
