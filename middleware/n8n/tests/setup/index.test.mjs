// setup/index.mjs（setup/setup.mjs の n8n モジュール）の check と apply。
// ctx は偽物（http・run・waitForHttp などを差し替える）で、provision.mjs の provision は vi.mock で受けた引数を記録するだけにする。
// Docker・実際の n8n には繋がない。CONFIG_DIR は一時ディレクトリ。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// restoreMocks: true で vi.fn の実装が消えるため、provision の偽物は vi.hoisted の配列に記録する素の関数にする
const calls = vi.hoisted(() => ({ provision: [] }));
vi.mock("../../provision/provision.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    provision: async (args) => {
      calls.provision.push(args);
      return { workflows: [] };
    },
  };
});

const { apply, check, meta } = await import("../../setup/index.mjs");

const BASE = "http://127.0.0.1:5678";
const ALL = ["I-21 SNS 通知", "I-19 突合", "I-11 Mautic", "I-12 Chatwoot", "I-18 PostHog", "週次 問い合わせの棚卸し", "n8n スケジュール実行のハートビート", "運用監視（OpenSEO・サンドボックスの証明書）"];

let configDir;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "n8n-setup-test-"));
  calls.provision.length = 0;
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

/**
 * 偽の ctx。routes は「URL → 応答（関数なら呼ぶ。Error を返すと reject）」。
 * raw の要求には { status, body } を、そうでない要求には本文をそのまま返す。
 */
function makeCtx({ routes = {}, values = {}, conf = {} } = {}) {
  const log = [];
  const http = async (_label, url, opts = {}) => {
    const r = routes[url] ?? routes[url.split("?")[0]];
    const v = typeof r === "function" ? r(opts) : r;
    if (v === undefined || v instanceof Error) throw v ?? Object.assign(new Error(`${url} に接続できない`), { status: 0 });
    return opts.raw ? { status: v.status ?? 200, ok: (v.status ?? 200) < 400, body: { cancel: async () => {} }, text: async () => "" } : v;
  };
  const state = new Map();
  return {
    log,
    ctx: {
      target: "dev",
      conf,
      W: "/nonexistent-w",
      CONFIG_DIR: configDir,
      state: { set: (k, v) => state.set(k, v), has: (k) => state.has(k), get: (k) => state.get(k) },
      http,
      run: async (cmd, args) => log.push(`run ${cmd} ${args.join(" ")}`),
      waitForHttp: async () => true,
      writeEnvFile: (path, vals) => log.push(`env ${path} ${Object.keys(vals).join(",")}`),
      randomSecret: () => "Aa1".repeat(6),
      log: (m) => log.push(m),
      warn: (m) => log.push(`! ${m}`),
      value: (k) => conf[k] || values[k] || state.get(k),
      require: (k, hint) => {
        const v = conf[k] || values[k];
        if (!v) throw new Error(`${k} が無い。${hint}`);
        return v;
      },
      manual: (id, title) => {
        throw Object.assign(new Error(title), { id: `n8n:${id}` });
      },
    },
  };
}

const healthyRoutes = (workflows = ALL.map((name) => ({ name, isArchived: false }))) => ({
  [`${BASE}/healthz`]: { status: 200 },
  [`${BASE}/rest/settings`]: { data: { userManagement: { showSetupOnFirstLoad: false } } },
  [`${BASE}/api/v1/workflows`]: (opts) => (opts.headers?.["X-N8N-API-KEY"] === "api-key-1" ? { data: workflows } : Object.assign(new Error("401"), { status: 401 })),
  [`${BASE}/mcp-server/http`]: (opts) => ({ status: opts.headers?.Authorization === "Bearer mcp-token-1" ? 200 : 401 }),
});
const KEYS = { N8N_API_KEY: "api-key-1", N8N_DEV_TOKEN: "mcp-token-1" };
const writeMcpEnv = () => {
  mkdirSync(join(configDir, "mcp"), { recursive: true });
  writeFileSync(join(configDir, "mcp/n8n-dev.env"), "N8N_DEV_TOKEN=x\n");
};

describe("meta", () => {
  describe("正常系", () => {
    it("開発環境だけで動き、Chatwoot・Mautic（provision が Webhook を作る）と host-relay の後に動く", () => {
      expect(meta).toMatchObject({ id: "n8n", targets: ["dev"] });
      expect(meta.after).toEqual(expect.arrayContaining(["host-relay", "chatwoot", "mautic"]));
    });
  });
});

describe("check", () => {
  describe("正常系", () => {
    it("オーナー・API キー・MCP のトークン・8 本のワークフロー（定期実行の 3 本を含む）・MCP の env ファイルがそろえば ok", async () => {
      writeMcpEnv();
      const { ctx } = makeCtx({ routes: healthyRoutes(), values: KEYS });
      const r = await check(ctx);
      expect(r.ok).toBe(true);
      expect(r.notes).toContain("ワークフロー: 8/8 本が取り込み済み（全部）");
    });
  });

  describe("異常系", () => {
    it("入力: 定期実行の 3 本が無ければ ok にせず、無い名前を並べる", async () => {
      writeMcpEnv();
      const { ctx } = makeCtx({ routes: healthyRoutes(ALL.slice(0, 5).map((name) => ({ name }))), values: KEYS });
      const r = await check(ctx);
      expect(r.ok).toBe(false);
      expect(r.notes).toContain("ワークフロー: 5/8 本が取り込み済み（週次 問い合わせの棚卸し, n8n スケジュール実行のハートビート, 運用監視 が無い）");
    });

    it("入力: アーカイブしたワークフローは取り込み済みと数えない", async () => {
      writeMcpEnv();
      const { ctx } = makeCtx({ routes: healthyRoutes(ALL.map((name) => ({ name, isArchived: name.startsWith("運用監視") }))), values: KEYS });
      const r = await check(ctx);
      expect(r.ok).toBe(false);
      expect(r.notes).toContain("ワークフロー: 7/8 本が取り込み済み（運用監視 が無い）");
    });

    it("サーバ: /healthz に応答が無ければ、ほかを確かめずに ok: false を返す", async () => {
      const { ctx } = makeCtx({ routes: {}, values: KEYS });
      expect(await check(ctx)).toEqual({ ok: false, notes: ["GET /healthz: 応答なし（apply で compose up）"] });
    });

    it("サーバ: /healthz が 200 以外（起動中の 503）なら応答なしとみなす", async () => {
      const { ctx } = makeCtx({ routes: { [`${BASE}/healthz`]: { status: 503 } }, values: KEYS });
      expect((await check(ctx)).ok).toBe(false);
    });

    it("サーバ: 設定（/rest/settings）が読めなければオーナーは「まだ」、API キーが拒まれたら「使えない」とし、ワークフローは数えない", async () => {
      writeMcpEnv();
      const routes = { ...healthyRoutes(), [`${BASE}/rest/settings`]: new Error("500") };
      const { ctx } = makeCtx({ routes, values: { N8N_API_KEY: "stale-key", N8N_DEV_TOKEN: "mcp-token-1" } });
      const r = await check(ctx);
      expect(r.ok).toBe(false);
      expect(r.notes).toEqual(expect.arrayContaining(["オーナー: まだ（apply で作る）", "N8N_API_KEY: 使えない（apply で作り直す）"]));
      expect(r.notes.some((n) => n.startsWith("ワークフロー:"))).toBe(false);
      // 値そのものは notes に出さない
      expect(r.notes.join("\n")).not.toContain("stale-key");
    });

    // lib/core.mjs の契約どおり、check は { ok: boolean } を返す（以前は /rest/settings が読めないと ok が null だった）
    it("サーバ: 設定（/rest/settings）が読めないときも、ok は boolean の false を返す（契約の型）", async () => {
      writeMcpEnv();
      const routes = { ...healthyRoutes(), [`${BASE}/rest/settings`]: new Error("500") };
      const { ctx } = makeCtx({ routes, values: KEYS });
      const r = await check(ctx);
      expect(r.ok).toBe(false);
      expect(r.notes).toContain("オーナー: まだ（apply で作る）");
    });

    it("サーバ: ワークフローの一覧が想定外の形（data が無い）なら 0 本として扱う", async () => {
      writeMcpEnv();
      const routes = { ...healthyRoutes(), [`${BASE}/api/v1/workflows`]: (opts) => (opts.headers?.["X-N8N-API-KEY"] === "api-key-1" ? { items: [] } : new Error("401")) };
      const { ctx } = makeCtx({ routes, values: KEYS });
      expect((await check(ctx)).notes).toContain(`ワークフロー: 0/8 本が取り込み済み（${["I-21", "I-19", "I-11", "I-12", "I-18", "週次 問い合わせの棚卸し", "n8n スケジュール実行のハートビート", "運用監視"].join(", ")} が無い）`);
    });

    it("空入力: API キー・MCP のトークンが無ければ「まだ」とし、env ファイルが無ければ ok にしない", async () => {
      const { ctx } = makeCtx({ routes: healthyRoutes(), values: {} });
      const r = await check(ctx);
      expect(r.ok).toBe(false);
      expect(r.notes).toEqual(expect.arrayContaining(["N8N_API_KEY: まだ", "N8N_DEV_TOKEN（MCP）: まだ／n8n-dev.env: まだ"]));
    });
  });
});

describe("apply", () => {
  const applyValues = { ...KEYS, MAUTIC_CLIENT_ID: "mautic-id", MAUTIC_CLIENT_SECRET: "mautic-secret", CHATWOOT_ADMIN_TOKEN: "cw-admin", CHATWOOT_ACCOUNT_ID: "1" };

  describe("正常系", () => {
    it("API キーと MCP のトークンが通れば、ログインせずに provision を dev で呼ぶ（親は既定で公開しない）", async () => {
      const { ctx, log } = makeCtx({ routes: healthyRoutes(), values: applyValues });
      await apply(ctx);
      expect(log.slice(0, 1)).toEqual(["run bash dev/init-env.sh"]);
      expect(log).toContain("run docker compose up -d");
      expect(calls.provision).toHaveLength(1);
      const [args] = calls.provision;
      expect(args).toMatchObject({ target: "dev", publish: false });
      expect(args.conf).toMatchObject({ N8N_API_KEY: "api-key-1", CHATWOOT_API_ACCESS_TOKEN: "cw-admin", CHATWOOT_ACCOUNT_ID: "1", CHATWOOT_URL_FROM_N8N: "http://host.docker.internal:3100" });
      expect(args.conf.CHATWOOT_N8N_API_TOKEN).toBeUndefined();
    });

    it("設定（dev.conf）の CHATWOOT_URL_FROM_N8N・CHATWOOT_N8N_API_TOKEN を provision にそのまま渡し、N8N_PUBLISH_PARENTS=true なら親も公開する", async () => {
      const conf = { CHATWOOT_URL_FROM_N8N: "http://relay:3100/", CHATWOOT_N8N_API_TOKEN: "cw-n8n-token", N8N_PUBLISH_PARENTS: "true", UNRELATED_KEY: "x" };
      const { ctx } = makeCtx({ routes: healthyRoutes(), values: applyValues, conf });
      await apply(ctx);
      const [args] = calls.provision;
      expect(args.publish).toBe(true);
      expect(args.conf).toMatchObject({ CHATWOOT_URL_FROM_N8N: "http://relay:3100", CHATWOOT_N8N_API_TOKEN: "cw-n8n-token" });
      // 一覧（PASS_THROUGH）に無い設定は渡さない
      expect(args.conf).not.toHaveProperty("UNRELATED_KEY");
    });

    it("provision の出力は ctx.log・ctx.warn に流し、先頭の改行を除く", async () => {
      const { ctx, log } = makeCtx({ routes: healthyRoutes(), values: applyValues });
      await apply(ctx);
      const { io } = calls.provision[0];
      io.log("\n■ Data Table");
      io.warn("注意");
      expect(log).toEqual(expect.arrayContaining(["■ Data Table", "! 注意"]));
    });
  });

  describe("異常系", () => {
    it("サーバ: compose up の後に /healthz が応答しなければ、ログを見る場所を示して止まる（provision を呼ばない）", async () => {
      const { ctx } = makeCtx({ routes: healthyRoutes(), values: applyValues });
      ctx.waitForHttp = async () => false;
      await expect(apply(ctx)).rejects.toThrow("n8n が http://127.0.0.1:5678/healthz に応答しない。cd middleware/n8n && docker compose logs n8n を見る");
      expect(calls.provision).toEqual([]);
    });

    it("空入力: Mautic の API 資格情報が無ければ、画面の操作を案内して止まる（provision を呼ばない）", async () => {
      const { MAUTIC_CLIENT_ID, MAUTIC_CLIENT_SECRET, ...rest } = applyValues;
      const { ctx } = makeCtx({ routes: healthyRoutes(), values: rest });
      await expect(apply(ctx)).rejects.toMatchObject({ id: "n8n:mautic-api-credentials" });
      expect(calls.provision).toEqual([]);
    });

    it("空入力: Chatwoot の管理者のトークンが無ければ、先に chatwoot モジュールを実行するよう示して止まる", async () => {
      const { CHATWOOT_ADMIN_TOKEN, ...rest } = applyValues;
      const { ctx } = makeCtx({ routes: healthyRoutes(), values: rest });
      await expect(apply(ctx)).rejects.toThrow("CHATWOOT_ADMIN_TOKEN が無い。chatwoot モジュールが作る値");
      expect(calls.provision).toEqual([]);
    });
  });
});
