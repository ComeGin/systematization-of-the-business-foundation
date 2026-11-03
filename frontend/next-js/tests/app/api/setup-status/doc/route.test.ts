import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPlane } from "control-plane";
import { createFakePlane, type FakePlane } from "../../../../helpers/control-plane";

type State = { plane: ControlPlane; error: null } | { plane: null; error: string };

const mocks = vi.hoisted(() => ({
  guardApiRequest: vi.fn(async (_request: Request): Promise<Response | null> => null),
  getControlPlaneState: vi.fn((): State => ({ plane: null, error: "未設定" })),
}));

vi.mock("@/lib/session", () => ({ guardApiRequest: mocks.guardApiRequest }));
vi.mock("@/lib/control-plane", () => ({ getControlPlaneState: mocks.getControlPlaneState }));

import { GET } from "@/app/api/setup-status/doc/route";

let plane: FakePlane;
const get = (query: string) => GET(new NextRequest(`http://127.0.0.1:3200/api/setup-status/doc${query}`));
const q = (file: string, heading: string) => `?${new URLSearchParams({ file, heading }).toString()}`;

beforeEach(() => {
  vi.resetAllMocks();
  plane = createFakePlane();
  mocks.getControlPlaneState.mockReturnValue({ plane, error: null });
});

describe("GET /api/setup-status/doc", () => {
  describe("正常系", () => {
    it("節が見つかれば { file, heading, markdown } をそのまま返す", async () => {
      const section = { file: "cloud/README.md", heading: "4.14 再配信", markdown: "### 4.14 再配信\n\n本文" };
      plane.readSetupDoc.mockResolvedValue(section);
      const res = await get(q("cloud/README.md", "4.14"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(section);
      expect(plane.readSetupDoc).toHaveBeenCalledWith("cloud/README.md", "4.14");
    });

    it("入力: 日本語の見出しもエンコードされたまま受け取り、デコードして control-plane に渡す", async () => {
      plane.readSetupDoc.mockResolvedValue({ file: "setup/00-setup-overview.md", heading: "判断", markdown: "x" });
      await get(q("setup/00-setup-overview.md", "6 節 判断"));
      expect(plane.readSetupDoc).toHaveBeenCalledWith("setup/00-setup-overview.md", "6 節 判断");
    });
  });

  describe("異常系", () => {
    it("入力: 許可されないファイル・見つからない見出し（control-plane が null）は 404 を返す", async () => {
      const res = await get(q("etc/passwd", "root"));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    });

    it.each([["", ""], ["?file=a.md", ""], ["?heading=x", ""], ["?file=&heading=x", ""], ["?file=a.md&heading=", ""]])(
      "空入力: file か heading が無い・空（%s）なら 400 を返し、手順書を読まない",
      async (query) => {
        const res = await get(query);
        expect(res.status).toBe(400);
        expect(plane.readSetupDoc).not.toHaveBeenCalled();
      },
    );

    it("入力: 長すぎる file・heading は 400 を返し、手順書を読まない", async () => {
      expect((await get(q("a".repeat(301), "x"))).status).toBe(400);
      expect((await get(q("a.md", "h".repeat(201)))).status).toBe(400);
      expect(plane.readSetupDoc).not.toHaveBeenCalled();
    });

    it("入力: 未ログイン（ガードが 401）なら 401 を返し、手順書を読まない", async () => {
      mocks.guardApiRequest.mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));
      const res = await get(q("a.md", "x"));
      expect(res.status).toBe(401);
      expect(plane.readSetupDoc).not.toHaveBeenCalled();
    });

    it("サーバ: control-plane が使えなければ 503 を返す", async () => {
      mocks.getControlPlaneState.mockReturnValue({ plane: null, error: "未設定" });
      expect((await get(q("a.md", "x"))).status).toBe(503);
    });

    it("サーバ: 読み込みで例外が起きたら 500 を返し、詳細を出さない", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      plane.readSetupDoc.mockRejectedValue(new Error("EACCES /home/x"));
      const res = await get(q("a.md", "x"));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal error" });
    });
  });
});
