import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ADMIN_EMAIL,
  apiRequest,
  applyEnv,
  callRoute,
  createSandbox,
  createUserAndSession,
  restoreEnv,
  runContext,
  sessionCookie,
  type Sandbox,
} from "../helpers/harness";

// 本物の Better Auth（一時ディレクトリの auth.sqlite）→ lib/session.ts の guardApiRequest → 各 Route Handler → control-plane。
// Google のログインは通さず、Google のコールバックの後と同じ internalAdapter でユーザーとセッションを作る（databaseHooks の許可リストは本物が効く）。
// 差し替えるのは next/headers（Route Handler を関数で呼ぶため要求の文脈が無い）だけ。
vi.mock("next/headers", async () => {
  const { requestScope } = await import("../helpers/request-scope");
  return { headers: async () => requestScope.headers };
});

import { GET as authGET } from "@/app/api/auth/[...all]/route";
import { GET as jobsGET } from "@/app/api/jobs/route";
import { GET as miswriteGET } from "@/app/api/miswrite-candidates/route";
import { GET as runGET } from "@/app/api/runs/[runId]/route";
import { GET as runsGET, POST as runsPOST } from "@/app/api/runs/route";
import { getAuth } from "@/lib/auth";
import { requirePageSession } from "@/lib/session";
import { requestScope } from "../helpers/request-scope";

const UNKNOWN_RUN_ID = "01K6PZ3T8Q4M2N7R9S5V1W3X6Y";

let sandbox: Sandbox;
let admin: { userId: string; token: string; cookie: string };

// GET の 4 本（ログイン確認は lib/api.ts の withControlPlane で共通）
const GET_ENDPOINTS: [string, (cookie?: string) => Promise<{ status: number; json: Record<string, unknown> }>][] = [
  ["GET /api/runs", (cookie) => callRoute(runsGET, apiRequest("/api/runs", { cookie }))],
  [
    "GET /api/runs/[runId]",
    (cookie) =>
      callRoute<Record<string, unknown>, [ReturnType<typeof runContext>]>(
        runGET,
        apiRequest(`/api/runs/${UNKNOWN_RUN_ID}`, { cookie }),
        runContext(UNKNOWN_RUN_ID),
      ),
  ],
  ["GET /api/jobs", (cookie) => callRoute(jobsGET, apiRequest("/api/jobs", { cookie }))],
  ["GET /api/miswrite-candidates", (cookie) => callRoute(miswriteGET, apiRequest("/api/miswrite-candidates", { cookie }))],
];

async function runCount(): Promise<number> {
  const res = await callRoute<{ runs: unknown[] }>(runsGET, apiRequest("/api/runs?limit=200", { cookie: admin.cookie }));
  return res.json.runs.length;
}

/** ログイン用 DB を、アプリとは別の接続で開く（障害を起こす・行を確かめるため） */
function openAuthDb(): DatabaseSync {
  return new DatabaseSync(join(sandbox.dataDir, "auth.sqlite"));
}

beforeAll(async () => {
  sandbox = createSandbox("auth");
  applyEnv(sandbox.env());
  admin = await createUserAndSession(ADMIN_EMAIL);
});

afterAll(() => {
  restoreEnv();
  sandbox?.dispose();
});

describe("GET /api/auth/[...all]（get-session）", () => {
  const getSession = (cookie?: string) =>
    callRoute<{ user?: { email: string }; session?: { userId: string } } | null>(
      (request) => authGET(request),
      apiRequest("/api/auth/get-session", { cookie }),
    );

  describe("正常系", () => {
    it("許可リストのユーザーのセッション Cookie なら、ユーザーとセッションを返す", async () => {
      const res = await getSession(admin.cookie);
      expect(res.status).toBe(200);
      expect(res.json?.user?.email).toBe(ADMIN_EMAIL);
      expect(res.json?.session?.userId).toBe(admin.userId);
    });

    it("空入力: Cookie が無ければ null を返す", async () => {
      const res = await getSession();
      expect(res.status).toBe(200);
      expect(res.json).toBeNull();
    });
  });

  describe("異常系", () => {
    it("入力: 署名の合わない Cookie（トークンだけ本物）なら null を返す", async () => {
      const forged = `better-auth.session_token=${encodeURIComponent(`${admin.token}.AAAA`)}`;
      const res = await getSession(forged);
      expect(res.status).toBe(200);
      expect(res.json).toBeNull();
    });
  });
});

describe("ユーザーとセッションの作成（databaseHooks の許可リスト）", () => {
  describe("正常系", () => {
    it("許可リストのメールなら、大文字が混ざっていてもユーザーとセッションを作れる", async () => {
      applyEnv({ CONTROL_ADMIN_EMAILS: `${ADMIN_EMAIL}, IT-Admin2@ComeGin.com` });
      const created = await createUserAndSession("it-admin2@comegin.com");
      expect(created.token).toBeTruthy();
      const res = await callRoute(runsGET, apiRequest("/api/runs", { cookie: created.cookie }));
      expect(res.status).toBe(200);
    });
  });

  describe("異常系", () => {
    it("入力: 許可リストに無いメールはユーザーを作れない（FORBIDDEN）。DB に行も残らない", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(createUserAndSession("it-outsider@comegin.com")).rejects.toMatchObject({ status: "FORBIDDEN" });
      const db = openAuthDb();
      try {
        expect(db.prepare('SELECT COUNT(*) AS n FROM "user" WHERE email = ?').get("it-outsider@comegin.com")).toEqual({ n: 0 });
      } finally {
        db.close();
      }
    });

    it("入力: Workspace のドメインの外のメールは、許可リストにあってもユーザーを作れない", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      applyEnv({ CONTROL_ADMIN_EMAILS: `${ADMIN_EMAIL},it-admin@example.com` });
      await expect(createUserAndSession("it-admin@example.com")).rejects.toMatchObject({ status: "FORBIDDEN" });
    });

    it("入力: 許可リストから外したユーザーは、新しいセッションを作れない", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      applyEnv({ CONTROL_ADMIN_EMAILS: `${ADMIN_EMAIL},it-removed@comegin.com` });
      const created = await createUserAndSession("it-removed@comegin.com");
      applyEnv({ CONTROL_ADMIN_EMAILS: ADMIN_EMAIL });
      const ctx = await getAuth().$context;
      await expect(ctx.internalAdapter.createSession(created.userId, false)).rejects.toMatchObject({ status: "FORBIDDEN" });
    });

    it("空入力: 許可リスト（CONTROL_ADMIN_EMAILS）が空なら、だれもユーザーを作れない", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      applyEnv({ CONTROL_ADMIN_EMAILS: "" });
      try {
        await expect(createUserAndSession("it-admin3@comegin.com")).rejects.toMatchObject({ status: "FORBIDDEN" });
      } finally {
        applyEnv({ CONTROL_ADMIN_EMAILS: ADMIN_EMAIL });
      }
    });
  });
});

describe("API のログイン確認（guardApiRequest → Route Handler）", () => {
  describe("正常系", () => {
    it.each(GET_ENDPOINTS)("%s: 許可リストのユーザーのセッションなら通す", async (_label, call) => {
      const res = await call(admin.cookie);
      // runs/[runId] は存在しない ID を引くので 404（ログイン確認は通っている）
      expect([200, 404]).toContain(res.status);
      expect(res.json).not.toEqual({ error: "unauthorized" });
    });

    it("POST /api/runs: 同じオリジンからの要求なら、ログイン確認を通って本文の検証に進む", async () => {
      const res = await callRoute(runsPOST, apiRequest("/api/runs", { method: "POST", cookie: admin.cookie, body: "{not json" }));
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "invalid body" });
    });
  });

  describe("異常系", () => {
    it.each(GET_ENDPOINTS)("空入力: %s: セッションの Cookie が無ければ 401", async (_label, call) => {
      const res = await call();
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: "unauthorized" });
    });

    it.each(GET_ENDPOINTS)("入力: %s: 署名を改ざんした Cookie なら 401", async (_label, call) => {
      const res = await call(`better-auth.session_token=${encodeURIComponent(`${admin.token}.AAAA`)}`);
      expect(res.status).toBe(401);
    });

    it("入力: DB に無いトークン（正しく署名しただけ）なら 401", async () => {
      const res = await callRoute(runsGET, apiRequest("/api/runs", { cookie: await sessionCookie("it-no-such-session-token") }));
      expect(res.status).toBe(401);
    });

    it("入力: ログアウト（セッションの削除）の後の Cookie なら 401", async () => {
      const ctx = await getAuth().$context;
      const session = await ctx.internalAdapter.createSession(admin.userId, false);
      const cookie = await sessionCookie(session.token);
      expect((await callRoute(jobsGET, apiRequest("/api/jobs", { cookie }))).status).toBe(200);
      await ctx.internalAdapter.deleteSession(session.token);
      const res = await callRoute(jobsGET, apiRequest("/api/jobs", { cookie }));
      expect(res.status).toBe(401);
    });

    it("入力: 期限の切れたセッションなら 401", async () => {
      const ctx = await getAuth().$context;
      const session = await ctx.internalAdapter.createSession(admin.userId, false);
      await ctx.internalAdapter.updateSession(session.token, { expiresAt: new Date(Date.now() - 60_000) });
      const res = await callRoute(runsGET, apiRequest("/api/runs", { cookie: await sessionCookie(session.token) }));
      expect(res.status).toBe(401);
    });

    it("入力: 許可リストから外したユーザーの既存のセッションは、次の要求で失効させて 401 を返す（許可リストに戻しても同じ Cookie は通らない）", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const email = "it-removed-api@comegin.com";
      applyEnv({ CONTROL_ADMIN_EMAILS: `${ADMIN_EMAIL},${email}` });
      const removed = await createUserAndSession(email);
      try {
        expect((await callRoute(runsGET, apiRequest("/api/runs", { cookie: removed.cookie }))).status).toBe(200);
        applyEnv({ CONTROL_ADMIN_EMAILS: ADMIN_EMAIL });
        const res = await callRoute(runsGET, apiRequest("/api/runs", { cookie: removed.cookie }));
        expect(res.status).toBe(401);
        expect(res.json).toEqual({ error: "unauthorized" });
        expect(res.text).not.toContain(email);
        // セッションは DB から消えている
        const db = openAuthDb();
        try {
          expect(db.prepare('SELECT COUNT(*) AS n FROM "session" WHERE token = ?').get(removed.token)).toEqual({ n: 0 });
        } finally {
          db.close();
        }
        applyEnv({ CONTROL_ADMIN_EMAILS: `${ADMIN_EMAIL},${email}` });
        expect((await callRoute(runsGET, apiRequest("/api/runs", { cookie: removed.cookie }))).status).toBe(401);
      } finally {
        applyEnv({ CONTROL_ADMIN_EMAILS: ADMIN_EMAIL });
      }
    });

    it("入力: 許可リストから外したユーザーは、コンソールのページ（requirePageSession）でも /login へ送られる", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const email = "it-removed-page@comegin.com";
      applyEnv({ CONTROL_ADMIN_EMAILS: `${ADMIN_EMAIL},${email}` });
      const removed = await createUserAndSession(email);
      requestScope.headers = new Headers({ cookie: removed.cookie });
      await expect(requirePageSession()).resolves.toMatchObject({ user: { email } });
      applyEnv({ CONTROL_ADMIN_EMAILS: ADMIN_EMAIL });
      await expect(requirePageSession()).rejects.toMatchObject({ digest: expect.stringContaining(";/login;") });
    });


    it("入力: POST に Origin が無ければ 403 を返し、起動しない", async () => {
      const before = await runCount();
      const res = await callRoute(
        runsPOST,
        apiRequest("/api/runs", { method: "POST", cookie: admin.cookie, origin: null, body: { target: { kind: "agent", agent: "it-probe", prompt: "p" } } }),
      );
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "origin is required" });
      expect(await runCount()).toBe(before);
    });

    it("入力: 別オリジンからの POST なら 403 を返し、起動しない", async () => {
      const before = await runCount();
      const res = await callRoute(
        runsPOST,
        apiRequest("/api/runs", {
          method: "POST",
          cookie: admin.cookie,
          origin: "https://evil.example.com",
          body: { target: { kind: "agent", agent: "it-probe", prompt: "p" } },
        }),
      );
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "cross-origin request" });
      expect(await runCount()).toBe(before);
    });

    it("入力: Origin が URL として読めなければ 403", async () => {
      const res = await callRoute(
        runsPOST,
        apiRequest("/api/runs", { method: "POST", cookie: admin.cookie, origin: "not a url", body: { target: { kind: "job", jobId: "x" } } }),
      );
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "invalid origin" });
    });

    it("入力: セッションが無ければ、Origin が正しくても POST は 401（起動しない）", async () => {
      const before = await runCount();
      const res = await callRoute(runsPOST, apiRequest("/api/runs", { method: "POST", body: { target: { kind: "job", jobId: "x" } } }));
      expect(res.status).toBe(401);
      expect(await runCount()).toBe(before);
    });

    it("サーバ: ログイン用 DB のセッションの表が壊れていたら、通さずに 503（内部の文は出さない）", async () => {
      const db = openAuthDb();
      db.exec('ALTER TABLE "session" RENAME TO "session_broken"');
      try {
        const res = await callRoute(runsGET, apiRequest("/api/runs", { cookie: admin.cookie }));
        expect(res.status).toBe(503);
        expect(res.json).toEqual({ error: "authentication is unavailable" });
        expect(res.text).not.toContain("session_broken");
        expect(res.text).not.toContain("no such table");
      } finally {
        db.exec('ALTER TABLE "session_broken" RENAME TO "session"');
        db.close();
      }
      // 直したら通る
      expect((await callRoute(runsGET, apiRequest("/api/runs", { cookie: admin.cookie }))).status).toBe(200);
    });
  });
});
