import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPlane } from "control-plane";
import { createFakePlane, makeRun, SAMPLE_RUN_ID, sameOriginInit, type FakePlane } from "../../../helpers/control-plane";

type State = { plane: ControlPlane; error: null } | { plane: null; error: string };

// lib/api.ts は本物を使い、ログイン確認と control-plane の取得だけを差し替える
const mocks = vi.hoisted(() => ({
  guardApiRequest: vi.fn(async (_request: Request): Promise<Response | null> => null),
  getControlPlaneState: vi.fn((): State => ({ plane: null, error: "未設定" })),
}));

vi.mock("@/lib/session", () => ({ guardApiRequest: mocks.guardApiRequest }));
vi.mock("@/lib/control-plane", () => ({ getControlPlaneState: mocks.getControlPlaneState }));

import { GET, POST } from "@/app/api/runs/route";

const BASE = "http://127.0.0.1:3200/api/runs";
let plane: FakePlane;

beforeEach(() => {
  vi.resetAllMocks();
  plane = createFakePlane();
  mocks.getControlPlaneState.mockReturnValue({ plane, error: null });
});

describe("GET /api/runs", () => {
  const get = (query = "") => GET(new NextRequest(`${BASE}${query}`));

  describe("正常系", () => {
    it("空入力: クエリが無ければ空の条件で一覧を読み、{ runs } で返す", async () => {
      const runs = [makeRun()];
      plane.listRuns.mockResolvedValue(runs);
      const res = await get();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ runs });
      expect(plane.listRuns).toHaveBeenCalledWith({});
    });

    it("空入力: 記録が 0 件なら { runs: [] } を返す", async () => {
      const res = await get("?outcome=failure");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ runs: [] });
    });

    it("条件を検証して型をそろえて渡す（limit は数値に変換）", async () => {
      await get(`?limit=20&before=${SAMPLE_RUN_ID}&jobId=daily-seo&outcome=failure`);
      expect(plane.listRuns).toHaveBeenCalledWith({ limit: 20, before: SAMPLE_RUN_ID, jobId: "daily-seo", outcome: "failure" });
    });

    it("limit の境界（1 と 200）は通す", async () => {
      await get("?limit=1");
      await get("?limit=200");
      expect(plane.listRuns.mock.calls.map(([query]) => query?.limit)).toEqual([1, 200]);
    });

    it("jobId は 100 文字まで通す", async () => {
      const res = await get(`?jobId=${"a".repeat(100)}`);
      expect(res.status).toBe(200);
    });

    it("知らないクエリは control-plane に渡さない", async () => {
      await get("?limit=5&sql=drop");
      expect(plane.listRuns).toHaveBeenCalledWith({ limit: 5 });
    });
  });

  describe("異常系", () => {
    it("入力: 未ログイン・許可リスト外（ガードが 401）なら一覧を読まずに 401 を返す", async () => {
      mocks.guardApiRequest.mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));
      const res = await get();
      expect(res.status).toBe(401);
      expect(plane.listRuns).not.toHaveBeenCalled();
    });

    it.each([
      ["limit=0", "?limit=0"],
      ["limit=201", "?limit=201"],
      ["limit が整数でない", "?limit=1.5"],
      ["limit が数値でない", "?limit=abc"],
      ["limit が負", "?limit=-1"],
      ["before が ULID でない", "?before=not-a-ulid"],
      ["before が小文字", `?before=${SAMPLE_RUN_ID.toLowerCase()}`],
      ["jobId が 101 文字", `?jobId=${"a".repeat(101)}`],
      ["outcome が想定外", "?outcome=running"],
    ])("入力: %s なら 400 を返し、一覧を読まない", async (_label, query) => {
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid query" });
      expect(plane.listRuns).not.toHaveBeenCalled();
    });

    it.each([
      ["jobId が空", "?jobId="],
      ["limit が空", "?limit="],
      ["before が空", "?before="],
      ["outcome が空", "?outcome="],
    ])("空入力: %s なら 400 を返し、一覧を読まない", async (_label, query) => {
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid query" });
      expect(plane.listRuns).not.toHaveBeenCalled();
    });

    it("サーバ: control-plane が使えなければ 503 を返し、クエリの検証まで進まない", async () => {
      mocks.getControlPlaneState.mockReturnValue({ plane: null, error: "CONTROL_DATA_DIR: 絶対パスでない" });
      const res = await get("?limit=abc");
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "CONTROL_DATA_DIR: 絶対パスでない" });
    });

    it("サーバ: E-15 の読み出しで例外（SQLite のロックなど）が起きたら 500 を返し、詳細を出さない", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      plane.listRuns.mockRejectedValue(new Error("SQLITE_BUSY: database is locked (/home/someone/e15.sqlite)"));
      const res = await get();
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(JSON.parse(body)).toEqual({ error: "internal error" });
      expect(body).not.toContain("e15.sqlite");
    });
  });
});

describe("POST /api/runs", () => {
  const post = (body: unknown) => POST(new NextRequest(BASE, sameOriginInit(body)));

  describe("正常系", () => {
    it("エージェントの指示を渡し、受け付けたら 202 を返す", async () => {
      plane.runNow.mockResolvedValue({ runId: SAMPLE_RUN_ID, accepted: true });
      const res = await post({ target: { kind: "agent", agent: "seo-auditor", prompt: "直近 7 日を見て" } });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ runId: SAMPLE_RUN_ID, accepted: true });
      expect(plane.runNow).toHaveBeenCalledWith({ target: { kind: "agent", agent: "seo-auditor", prompt: "直近 7 日を見て" } });
    });

    it("定期実行の定義の id を渡せる。見送られた（accepted=false）ときは 200 を返す", async () => {
      plane.runNow.mockResolvedValue({ runId: SAMPLE_RUN_ID, accepted: false });
      const res = await post({ target: { kind: "job", jobId: "daily-seo" } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ runId: SAMPLE_RUN_ID, accepted: false });
      expect(plane.runNow).toHaveBeenCalledWith({ target: { kind: "job", jobId: "daily-seo" } });
    });

    it("知らない項目（モデル・許可ツールの上書きなど）は control-plane に渡さない", async () => {
      await post({
        target: { kind: "agent", agent: "seo-auditor", prompt: "p", allowedTools: ["Bash"] },
        model: "x",
      });
      expect(plane.runNow).toHaveBeenCalledWith({ target: { kind: "agent", agent: "seo-auditor", prompt: "p" } });
    });

    it("プロンプトは 20,000 文字まで通す", async () => {
      const res = await post({ target: { kind: "agent", agent: "seo-auditor", prompt: "あ".repeat(20_000) } });
      expect(res.status).toBe(202);
    });
  });

  describe("異常系", () => {
    it("入力: 別オリジン（ガードが 403）なら起動しない", async () => {
      mocks.guardApiRequest.mockResolvedValue(Response.json({ error: "cross-origin request" }, { status: 403 }));
      const res = await post({ target: { kind: "job", jobId: "daily-seo" } });
      expect(res.status).toBe(403);
      expect(plane.runNow).not.toHaveBeenCalled();
    });

    it("入力: 未ログイン・許可リスト外（ガードが 401）なら起動しない", async () => {
      mocks.guardApiRequest.mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));
      const res = await post({ target: { kind: "job", jobId: "daily-seo" } });
      expect(res.status).toBe(401);
      expect(plane.runNow).not.toHaveBeenCalled();
    });

    it.each([
      ["JSON でない", "{not json"],
      ["kind が想定外", { target: { kind: "builtin", builtin: "heartbeat" } }],
      ["target が配列", { target: [{ kind: "job", jobId: "daily-seo" }] }],
      ["エージェント名に大文字", { target: { kind: "agent", agent: "SEO-auditor", prompt: "p" } }],
      ["エージェント名に agent/ を付ける", { target: { kind: "agent", agent: "agent/seo-auditor", prompt: "p" } }],
      ["エージェント名が数字で始まる", { target: { kind: "agent", agent: "1seo", prompt: "p" } }],
      ["エージェント名がハイフンで終わる", { target: { kind: "agent", agent: "seo-", prompt: "p" } }],
      ["エージェント名にパスを含める", { target: { kind: "agent", agent: "../seo", prompt: "p" } }],
      ["プロンプトが文字列でない", { target: { kind: "agent", agent: "seo-auditor", prompt: 1 } }],
      ["プロンプトが 20,001 文字", { target: { kind: "agent", agent: "seo-auditor", prompt: "a".repeat(20_001) } }],
      ["jobId が 101 文字", { target: { kind: "job", jobId: "a".repeat(101) } }],
    ])("入力: %s なら 400 を返し、起動しない", async (_label, body) => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid body" });
      expect(plane.runNow).not.toHaveBeenCalled();
    });

    it.each([
      ["ボディが空文字", ""],
      ["ボディが null", "null"],
      ["空のオブジェクト（target が無い）", {}],
      ["target が空のオブジェクト", { target: {} }],
      ["プロンプトが空", { target: { kind: "agent", agent: "seo-auditor", prompt: "" } }],
      ["エージェント名が空", { target: { kind: "agent", agent: "", prompt: "p" } }],
      ["jobId が空", { target: { kind: "job", jobId: "" } }],
    ])("空入力: %s なら 400 を返し、起動しない", async (_label, body) => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid body" });
      expect(plane.runNow).not.toHaveBeenCalled();
    });

    it("空入力: ボディの無い要求は 400 を返し、起動しない", async () => {
      const { body: _body, ...init } = sameOriginInit("");
      const res = await POST(new NextRequest(BASE, init));
      expect(res.status).toBe(400);
      expect(plane.runNow).not.toHaveBeenCalled();
    });

    it("入力: control-plane が入力の誤り（ControlPlaneInputError）を返したら 400 とその理由を返す", async () => {
      const error = new Error("定期実行の定義が見つからない: nope");
      error.name = "ControlPlaneInputError";
      plane.runNow.mockRejectedValue(error);
      const res = await post({ target: { kind: "job", jobId: "nope" } });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "定期実行の定義が見つからない: nope" });
    });

    it("サーバ: control-plane が使えなければ 503 を返し、ボディを検証しない", async () => {
      mocks.getControlPlaneState.mockReturnValue({ plane: null, error: "CONTROL_WORKTREE: 必須" });
      const res = await post("{not json");
      expect(res.status).toBe(503);
      expect(plane.runNow).not.toHaveBeenCalled();
    });

    it("サーバ: 起動の処理で例外（Agent SDK の失敗など）が起きたら 500 を返し、詳細を出さない", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      plane.runNow.mockRejectedValue(new Error("ANTHROPIC_API_KEY=sk-ant-xxx rejected"));
      const res = await post({ target: { kind: "agent", agent: "seo-auditor", prompt: "p" } });
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(JSON.parse(body)).toEqual({ error: "internal error" });
      expect(body).not.toContain("sk-ant");
    });
  });
});
