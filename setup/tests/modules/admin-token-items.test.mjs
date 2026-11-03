// chatwoot-prod・n8n-prod の check が、管理者のトークン（CHATWOOT_ADMIN_TOKEN）が prod.conf に無いとき（P15 で消した後）に
// ok を false にせず、そのトークンが要る確認を ◇（level: manual）の項目として返すことの単体テスト（mautic-prod の 2026-11-03 の直し方に合わせる）。
// AWS・各製品の API・n8n は偽物に差し替える。実際のネットワーク・状態ファイルには触れない。
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCtx, itemsByKey } from "../helpers/fake-ctx.mjs";

const mocks = vi.hoisted(() => ({ profiles: {}, awsResponses: {}, n8n: { healthy: true, apiKeyWorks: true, mcpWorks: true } }));
vi.mock("../../../cloud/setup/aws.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    awsJson: async (_ctx, args) => {
      const r = mocks.awsResponses[`${args[0]} ${args[1]}`];
      if (r instanceof Error) throw r;
      return r === undefined ? null : r;
    },
    requireMainStack: async () => ({ Outputs: [{ OutputKey: "OnpremN8nSnsUserName", OutputValue: "onprem-n8n-sns" }] }),
    serviceCounts: async (_ctx, _main, svc, param) => ({ svc, param, desiredParam: 1, desired: 1, running: 1, exists: true }),
  };
});
vi.mock("../../../backend/chatwoot-system/setup/index.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  profile: async (_ctx, token) => {
    const p = mocks.profiles[token];
    if (p instanceof Error) throw p;
    return p ?? null;
  },
}));
vi.mock("../../../middleware/n8n/setup/index.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  healthy: async () => mocks.n8n.healthy,
  apiKeyWorks: async () => mocks.n8n.apiKeyWorks,
  mcpWorks: async () => mocks.n8n.mcpWorks,
}));

const chatwoot = await import("../../../backend/chatwoot-system/setup/prod/index.mjs");
const n8n = await import("../../../middleware/n8n/setup/prod/index.mjs");
const { FAQ_LABELS, ASK_RESOLVED_MACRO, HANDOFF_EMAIL_FLAG } = await import("../../../backend/chatwoot-system/setup/index.mjs");

const EVIDENCE = "初期設定用の値（CHATWOOT_ADMIN_TOKEN）を消した後なので確かめない（P15）";
const ADMIN = "admin-token-aaaaaaaa";
const AGENT = "agent-token-bbbbbbbb";
const BOT_TOKEN = "bot-token-cccccccc";
const FAQ_URL = "https://abc123.lambda-url.ap-northeast-1.on.aws/webhook";

// ---------------------------------------------------------------- chatwoot-prod
function chatwootCtx({ admin = true, conf = {}, http, inbox = true } = {}) {
  const calls = [];
  const ctx = fakeCtx({
    conf: {
      CHATWOOT_AGENT_TOKEN: AGENT,
      CHATWOOT_ACCOUNT_ID: "1",
      PUBLIC_SITE_URL: "https://comegin.com",
      FAQ_BOT_WEBHOOK_URL: FAQ_URL,
      FAQ_BOT_SECRETS_STORED: createHash("sha256").update(BOT_TOKEN).digest("hex").slice(0, 8),
      ...(admin ? { CHATWOOT_ADMIN_TOKEN: ADMIN } : {}),
      ...conf,
    },
    stateValues: { ...(inbox ? { CHATWOOT_INBOX_ID: "1", CHATWOOT_WEBSITE_TOKEN: "wt-1" } : {}), CHATWOOT_FAQ_BOT_ID: "5", CHATWOOT_FAQ_BOT_TOKEN: BOT_TOKEN },
    overrides: {
      phase: "apps",
      http:
        http ??
        (async (_label, url) => {
          calls.push(url);
          if (url.endsWith("/agent_bot")) return { agent_bot: { id: 5, outgoing_url: FAQ_URL } };
          if (url.includes("/inbox_members/")) return { payload: [{ id: 10 }, { id: 11 }] };
          if (url.includes("/inboxes/")) return { allow_messages_after_resolved: false };
          if (url.endsWith("/labels")) return { payload: FAQ_LABELS.map((l) => ({ title: l.title })) };
          if (url.endsWith("/macros")) return { payload: [{ name: ASK_RESOLVED_MACRO.name }] };
          if (url.endsWith("/notification_settings")) return { selected_email_flags: [HANDOFF_EMAIL_FLAG] };
          throw new Error(`想定外の URL: ${url}`);
        }),
    },
  });
  return { ctx, calls };
}

beforeEach(() => {
  mocks.profiles = {
    [ADMIN]: { id: 10, accounts: [{ id: 1, role: "administrator" }] },
    [AGENT]: { id: 11, accounts: [{ id: 1, role: "agent" }] },
  };
  mocks.awsResponses = {
    "iam list-access-keys": { AccessKeyMetadata: [{ AccessKeyId: "AKIAEXAMPLE", Status: "Active" }] },
    "cloudwatch describe-alarms": { MetricAlarms: [{ StateValue: "OK" }] },
  };
  mocks.n8n = { healthy: true, apiKeyWorks: true, mcpWorks: true };
});

describe("chatwoot-prod の管理者トークンが無いとき", () => {
  describe("正常系", () => {
    it("入力: 管理者のトークンが無くても ok は true のまま、chatwoot-prod.admin-token-checks が manual（P7）で返る", async () => {
      const { ctx, calls } = chatwootCtx({ admin: false });
      const r = await chatwoot.check(ctx);
      expect(r.ok).toBe(true);
      expect(r.items).toEqual([expect.objectContaining({ key: "chatwoot-prod.admin-token-checks", step: "P7", level: "manual", evidence: EVIDENCE })]);
      expect(calls).toEqual([]); // 管理者のトークンが要る API は呼ばない
    });

    it("入力: 管理者のトークンが無い旨が notes に残る（失敗の文ではない）", async () => {
      const { ctx } = chatwootCtx({ admin: false });
      const r = await chatwoot.check(ctx);
      expect(r.notes.some((n) => n.includes("CHATWOOT_ADMIN_TOKEN") && n.includes("確かめない"))).toBe(true);
      expect(r.notes.some((n) => n.startsWith("prod.conf に無いキー"))).toBe(false);
    });

    it("入力: 管理者のトークンがあり、確認がすべて通ると level ok で、管理者の API を呼ぶ", async () => {
      const { ctx, calls } = chatwootCtx();
      const r = await chatwoot.check(ctx);
      expect(r.ok).toBe(true);
      expect(itemsByKey(r)["chatwoot-prod.admin-token-checks"].level).toBe("ok");
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  describe("異常系", () => {
    it("入力: 管理者のトークンが無くても、ほかの確認（エージェント専用ユーザーの権限）は続けて、失敗なら ok が false", async () => {
      mocks.profiles[AGENT] = { id: 11, accounts: [{ id: 1, role: "administrator" }] };
      const { ctx } = chatwootCtx({ admin: false });
      const r = await chatwoot.check(ctx);
      expect(r.ok).toBe(false);
      expect(r.notes.some((n) => n.includes("担当者の権限でない"))).toBe(true);
      expect(r.items[0].level).toBe("manual");
    });

    it("入力: 管理者のトークンが無くても、ほかの prod.conf の値が足りなければ ok は false（足りないキーに CHATWOOT_ADMIN_TOKEN は出ない）", async () => {
      const { ctx } = chatwootCtx({ admin: false, conf: { PUBLIC_SITE_URL: "" } });
      const r = await chatwoot.check(ctx);
      expect(r.ok).toBe(false);
      const missing = r.notes.find((n) => n.startsWith("prod.conf に無いキー"));
      expect(missing).toContain("PUBLIC_SITE_URL");
      expect(missing).not.toContain("CHATWOOT_ADMIN_TOKEN");
      expect(r.items[0].level).toBe("manual");
    });

    it("サーバ: 管理者のトークンがあってラベルが足りないと ok が false で、項目は action", async () => {
      const { ctx } = chatwootCtx({
        http: async (_label, url) => {
          if (url.endsWith("/labels")) return { payload: [] };
          if (url.endsWith("/agent_bot")) return { agent_bot: { id: 5, outgoing_url: FAQ_URL } };
          if (url.includes("/inbox_members/")) return { payload: [{ id: 10 }, { id: 11 }] };
          if (url.includes("/inboxes/")) return { allow_messages_after_resolved: false };
          if (url.endsWith("/macros")) return { payload: [{ name: ASK_RESOLVED_MACRO.name }] };
          return { selected_email_flags: [HANDOFF_EMAIL_FLAG] };
        },
      });
      const r = await chatwoot.check(ctx);
      expect(r.ok).toBe(false);
      expect(r.items[0].level).toBe("action");
      expect(r.items[0].evidence).toContain("FAQ のラベルが無い");
    });

    it("サーバ: 管理者のトークンと関係のない確認（エージェント専用ユーザーのプロフィール）が例外になっても、管理者のトークンの項目は action にしない（unknown。確かめていない分を書く）", async () => {
      mocks.profiles[AGENT] = Object.assign(new Error("HTTP 500"), { status: 500 });
      const { ctx } = chatwootCtx();
      const r = await chatwoot.check(ctx);
      expect(r.ok).toBe(false);
      expect(r.notes).toContain("HTTP 500");
      const i = r.items[0];
      expect(i.level).toBe("unknown");
      expect(i.evidence).toContain("確かめた: 管理者のトークンの有効性");
      expect(i.evidence).toContain("確かめていない:");
      expect(i.evidence).toContain("FAQ のラベル");
      expect(i.evidence).not.toContain("HTTP 500"); // 管理者のトークンの失敗ではない
    });

    it("サーバ: 本番の Chatwoot に届かない（status 0）ときは unknown（action にしない）。届かなかった旨が根拠に出る", async () => {
      mocks.profiles[AGENT] = Object.assign(new Error("本番の Chatwoot に接続できない"), { status: 0 });
      const { ctx } = chatwootCtx();
      const r = await chatwoot.check(ctx);
      expect(r.ok).toBe(false);
      expect(r.items[0].level).toBe("unknown");
      expect(r.items[0].evidence).toContain("本番の Chatwoot に届かない");
    });

    it("サーバ: 管理者のトークンの確認そのものが届かない（status 0）ときも unknown", async () => {
      mocks.profiles[ADMIN] = Object.assign(new Error("接続できない"), { status: 0 });
      const { ctx } = chatwootCtx();
      const r = await chatwoot.check(ctx);
      expect(r.items[0].level).toBe("unknown");
      expect(r.items[0].evidence).toContain("確かめていない:");
    });

    it("サーバ: 管理者のトークンが要る確認の中で、届いたうえで起きた例外（500）だけが action", async () => {
      mocks.profiles[ADMIN] = Object.assign(new Error("HTTP 500 管理者のプロフィール"), { status: 500 });
      const { ctx } = chatwootCtx();
      const r = await chatwoot.check(ctx);
      expect(r.items[0].level).toBe("action");
      expect(r.items[0].evidence).toContain("HTTP 500 管理者のプロフィール");
    });

    it("入力: 状態に CHATWOOT_INBOX_ID が無いと、受信箱・ボット・メンバーは確かめず、根拠に「確かめた」と書かない（確かめていない理由を書き、unknown）", async () => {
      const { ctx, calls } = chatwootCtx({ inbox: false });
      const r = await chatwoot.check(ctx);
      expect(r.ok).toBe(false); // 受信箱がまだ状態に無いのは今までどおり失敗
      expect(calls.some((u) => u.includes("/inboxes/") || u.includes("/inbox_members/"))).toBe(false);
      const i = r.items[0];
      expect(i.level).toBe("unknown");
      expect(i.evidence).toContain("確かめた: 管理者のトークンの有効性・FAQ のラベル・マクロ・引き継ぎのメール通知");
      expect(i.evidence).toContain("確かめていない: 受信箱の設定・FAQ ボットの接続・受信箱のメンバー（状態に CHATWOOT_INBOX_ID が無く、受信箱がまだ作られていない）");
      expect(i.evidence).not.toContain("管理者のトークンで確かめた:");
    });

    it("入力: 受信箱があれば、確かめた一覧に受信箱の項目が入る（ok の根拠は、確かめたものだけ）", async () => {
      const { ctx } = chatwootCtx();
      const i = (await chatwoot.check(ctx)).items[0];
      expect(i.level).toBe("ok");
      expect(i.evidence).toBe("管理者のトークンで確かめた: 管理者のトークンの有効性・受信箱の設定・FAQ ボットの接続・受信箱のメンバー・FAQ のラベル・マクロ・引き継ぎのメール通知");
    });

    it("サーバ: 管理者のトークンがあっても無効（401）なら action", async () => {
      mocks.profiles[ADMIN] = null;
      const { ctx } = chatwootCtx();
      const r = await chatwoot.check(ctx);
      expect(r.ok).toBe(false);
      expect(r.items[0]).toMatchObject({ level: "action", evidence: expect.stringContaining("無効") });
    });
  });
});

// ---------------------------------------------------------------- n8n-prod
const WORKFLOWS = ["I-21 a", "I-19 a", "I-11 a", "I-12 a", "I-18 a", "週次 問い合わせの棚卸し", "n8n スケジュール実行のハートビート"];
function n8nCtx({ admin = true } = {}) {
  return fakeCtx({
    conf: {
      N8N_MAUTIC_CLIENT_ID: "n8n-client-id",
      N8N_MAUTIC_CLIENT_SECRET: "n8n-client-secret-0123",
      AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "aws-secret-0123456789",
      CHATWOOT_N8N_API_TOKEN: "reader-token",
      ...(admin ? { CHATWOOT_ADMIN_TOKEN: ADMIN } : {}),
    },
    stateValues: { N8N_API_KEY: "api-key-0123456", N8N_PROD_TOKEN: "mcp-token-0123456" },
    overrides: {
      phase: "apps",
      http: async (_label, url) => {
        if (url.endsWith("/rest/settings")) return { data: { userManagement: { showSetupOnFirstLoad: false } } };
        if (url.includes("/api/v1/workflows")) return { data: WORKFLOWS.map((name) => ({ name, isArchived: false })) };
        throw new Error(`想定外の URL: ${url}`);
      },
    },
  });
}

describe("n8n-prod の管理者トークンが無いとき", () => {
  describe("正常系", () => {
    it("入力: 管理者のトークンが無くても ok は true のまま、n8n-prod.admin-token-checks が manual（P9）で返る", async () => {
      const r = await n8n.check(n8nCtx({ admin: false }));
      expect(r.ok).toBe(true);
      expect(r.items).toEqual([expect.objectContaining({ key: "n8n-prod.admin-token-checks", step: "P9", level: "manual", evidence: EVIDENCE })]);
      expect(r.notes.some((n) => n.includes("CHATWOOT_ADMIN_TOKEN が prod.conf に無い") && n.includes("確認はしない"))).toBe(true);
    });

    it("入力: 管理者のトークンがあると level ok", async () => {
      const r = await n8n.check(n8nCtx());
      expect(r.ok).toBe(true);
      expect(r.items[0]).toMatchObject({ key: "n8n-prod.admin-token-checks", level: "ok" });
    });

    it("サーバ: n8n が応答しなくても項目は返る（トークンの有無は n8n に依らない）", async () => {
      mocks.n8n.healthy = false;
      const r = await n8n.check(n8nCtx({ admin: false }));
      expect(r.ok).toBe(false);
      expect(r.items[0].level).toBe("manual");
    });
  });

  describe("異常系", () => {
    it("入力: 管理者のトークンが無くても、ほかの確認は続く（n8n 用の Mautic の認証情報が無ければ ok が false）", async () => {
      const ctx = n8nCtx({ admin: false });
      delete ctx.conf.N8N_MAUTIC_CLIENT_ID;
      const r = await n8n.check(ctx);
      expect(r.ok).toBe(false);
      expect(r.notes.some((n) => n.includes("N8N_MAUTIC_CLIENT_ID"))).toBe(true);
      expect(r.items[0].level).toBe("manual");
    });

    it("サーバ: 取り込み済みのワークフローが足りないと ok が false（トークンの有無に依らない）", async () => {
      const ctx = n8nCtx({ admin: false });
      ctx.http = async (_label, url) => (url.endsWith("/rest/settings") ? { data: { userManagement: { showSetupOnFirstLoad: false } } } : { data: [] });
      const r = await n8n.check(ctx);
      expect(r.ok).toBe(false);
      expect(r.notes.some((n) => n.includes("ワークフロー") && n.includes("が無い"))).toBe(true);
    });
  });
});
