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

  it("未ログイン（ガードが 401）なら一覧を読まずに 401 を返す", async () => {
    mocks.guardApiRequest.mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));
    const res = await get();
    expect(res.status).toBe(401);
    expect(plane.listRuns).not.toHaveBeenCalled();
  });

  it("クエリが無ければ空の条件で一覧を読み、{ runs } で返す", async () => {
    const runs = [makeRun()];
    plane.listRuns.mockResolvedValue(runs);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runs });
    expect(plane.listRuns).toHaveBeenCalledWith({});
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

  it("知らないクエリは control-plane に渡さない", async () => {
    await get("?limit=5&sql=drop");
    expect(plane.listRuns).toHaveBeenCalledWith({ limit: 5 });
  });

  it.each([
    ["limit=0", "?limit=0"],
    ["limit=201", "?limit=201"],
    ["limit が整数でない", "?limit=1.5"],
    ["limit が数値でない", "?limit=abc"],
    ["before が ULID でない", "?before=not-a-ulid"],
    ["before が小文字", `?before=${SAMPLE_RUN_ID.toLowerCase()}`],
    ["jobId が空", "?jobId="],
    ["jobId が 101 文字", `?jobId=${"a".repeat(101)}`],
    ["outcome が想定外", "?outcome=running"],
  ])("%s なら 400 を返し、一覧を読まない", async (_label, query) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid query" });
    expect(plane.listRuns).not.toHaveBeenCalled();
  });
});

describe("POST /api/runs", () => {
  const post = (body: unknown) => POST(new NextRequest(BASE, sameOriginInit(body)));

  it("別オリジン（ガードが 403）なら起動しない", async () => {
    mocks.guardApiRequest.mockResolvedValue(Response.json({ error: "cross-origin request" }, { status: 403 }));
    const res = await post({ target: { kind: "job", jobId: "daily-seo" } });
    expect(res.status).toBe(403);
    expect(plane.runNow).not.toHaveBeenCalled();
  });

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

  it.each([
    ["JSON でない", "{not json"],
    ["target が無い", {}],
    ["kind が想定外", { target: { kind: "builtin", builtin: "heartbeat" } }],
    ["エージェント名に大文字", { target: { kind: "agent", agent: "SEO-auditor", prompt: "p" } }],
    ["エージェント名に agent/ を付ける", { target: { kind: "agent", agent: "agent/seo-auditor", prompt: "p" } }],
    ["エージェント名が数字で始まる", { target: { kind: "agent", agent: "1seo", prompt: "p" } }],
    ["エージェント名がハイフンで終わる", { target: { kind: "agent", agent: "seo-", prompt: "p" } }],
    ["エージェント名にパスを含める", { target: { kind: "agent", agent: "../seo", prompt: "p" } }],
    ["プロンプトが空", { target: { kind: "agent", agent: "seo-auditor", prompt: "" } }],
    ["プロンプトが 20,001 文字", { target: { kind: "agent", agent: "seo-auditor", prompt: "a".repeat(20_001) } }],
    ["jobId が空", { target: { kind: "job", jobId: "" } }],
    ["jobId が 101 文字", { target: { kind: "job", jobId: "a".repeat(101) } }],
  ])("%s なら 400 を返し、起動しない", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid body" });
    expect(plane.runNow).not.toHaveBeenCalled();
  });

  it("control-plane が入力の誤り（ControlPlaneInputError）を返したら 400 とその理由を返す", async () => {
    const error = new Error("定期実行の定義が見つからない: nope");
    error.name = "ControlPlaneInputError";
    plane.runNow.mockRejectedValue(error);
    const res = await post({ target: { kind: "job", jobId: "nope" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "定期実行の定義が見つからない: nope" });
  });
});
