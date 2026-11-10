// ops/setup/index.mjs（モジュール mcp-prod）の check が返す items（mcp-prod.dist・mcp-prod.values。どちらも P10）の単体テスト。
// git（node:child_process の execFileSync）は偽物に差し替える。ファイルは一時ディレクトリだけに置く。各 MCP への通信は、prod.conf の値が足りない状態で走らせるので起きない。
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeEnvFile } from "../../lib/core.mjs";
import { fakeCtx, itemsByKey, recordingConfirm } from "../helpers/fake-ctx.mjs";
import { makeTempDir, removeTempDir } from "../helpers/temp-home.mjs";

// commitTime: --first-parent で引いたときの時刻（main に入った時刻。マージコミットの時刻）。
// branchTime: --first-parent を付けないで引いたときの時刻（git log はパスを絞るとマージコミットを飛ばし、ブランチ側のコミットの時刻を返す）
const git = vi.hoisted(() => ({ commitTime: null, branchTime: null, calls: [] }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal()),
  execFileSync: (cmd, args) => {
    git.calls.push([cmd, ...args]);
    if (git.commitTime === null) throw new Error("git が使えない（偽）");
    if (args.includes("log")) return `${args.includes("--first-parent") ? git.commitTime : (git.branchTime ?? git.commitTime)}\n`;
    throw new Error("想定外の git の呼び出し");
  },
}));

const { check, apply } = await import("../../../ops/setup/index.mjs");

let checkout;
let config;
beforeEach(() => {
  git.commitTime = null;
  git.branchTime = null;
  git.calls = [];
  checkout = makeTempDir("comegin-mcp-checkout-");
  config = makeTempDir("comegin-mcp-config-");
});
afterEach(() => {
  removeTempDir(checkout);
  removeTempDir(config);
});

/** チェックアウトに dist/index.js を作り、更新時刻（秒）を指定する */
function buildDist(pkg, mtimeSec) {
  const dir = join(checkout, "backend", pkg, "dist");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "index.js");
  writeFileSync(file, "// build\n");
  utimesSync(file, mtimeSec, mtimeSec);
}

const mcpCtx = (conf = {}) => fakeCtx({ conf, overrides: { phase: "apps", CONFIG_DIR: config } });

describe("mcp-prod の items", () => {
  describe("正常系", () => {
    it("入力: dist が、そのパッケージの変更が main に入った時刻より新しいと mcp-prod.dist は ok（P10）", async () => {
      git.commitTime = 1_700_000_000;
      buildDist("chatwoot-mcp", 1_700_000_500);
      buildDist("mautic-mcp", 1_700_000_500);
      const r = await check(mcpCtx({ CONTROL_MAIN_CHECKOUT: checkout }));
      expect(itemsByKey(r)["mcp-prod.dist"]).toMatchObject({ level: "ok", step: "P10" });
      // 全体の HEAD ではなく、パッケージのパスで最後のコミットを引く。--first-parent で、マージコミットを飛ばさない
      expect(git.calls).toContainEqual(["git", "-C", checkout, "log", "-1", "--first-parent", "--format=%ct", "HEAD", "--", "backend/chatwoot-mcp"]);
      expect(git.calls).toContainEqual(["git", "-C", checkout, "log", "-1", "--first-parent", "--format=%ct", "HEAD", "--", "backend/mautic-mcp"]);
    });

    it("入力: git でコミットの時刻を読めないときは、古いとは判定しない（存在だけ見る）", async () => {
      buildDist("chatwoot-mcp", 1_000);
      buildDist("mautic-mcp", 1_000);
      const r = await check(mcpCtx({ CONTROL_MAIN_CHECKOUT: checkout }));
      expect(itemsByKey(r)["mcp-prod.dist"].level).toBe("ok");
    });

    it("入力: 2 つの key（mcp-prod.dist・mcp-prod.values）がどちらも P10 で返る", async () => {
      const r = await check(mcpCtx({ CONTROL_MAIN_CHECKOUT: checkout }));
      expect(r.items.map((i) => [i.key, i.step])).toEqual([["mcp-prod.dist", "P10"], ["mcp-prod.values", "P10"]]);
    });
  });

  describe("異常系", () => {
    it("入力: ブランチ側のコミットの時刻 < ビルドの時刻 < main へのマージの時刻なら、古いビルドとして action（マージより前の main で作った dist）", async () => {
      git.branchTime = 1_700_000_000; // ブランチ側のコミット（例: 10-27）
      git.commitTime = 1_700_001_000; // main に入ったマージ（例: 11-02）
      buildDist("chatwoot-mcp", 1_700_000_500); // ブランチのコミットより後、マージより前のビルド
      buildDist("mautic-mcp", 1_700_001_500);
      const r = await check(mcpCtx({ CONTROL_MAIN_CHECKOUT: checkout }));
      const i = itemsByKey(r)["mcp-prod.dist"];
      expect(i).toMatchObject({ level: "action", stopId: "mcp-prod:finish" });
      expect(i.evidence).toContain("backend/chatwoot-mcp");
      expect(i.evidence).not.toContain("backend/mautic-mcp/dist");
    });

    it("入力: dist が、そのパッケージの変更が main に入った時刻より古いと action（止まる id は mcp-prod:finish）", async () => {
      git.commitTime = 1_700_000_000;
      buildDist("chatwoot-mcp", 1_700_000_500);
      buildDist("mautic-mcp", 1_699_999_000); // 古い
      const r = await check(mcpCtx({ CONTROL_MAIN_CHECKOUT: checkout }));
      const i = itemsByKey(r)["mcp-prod.dist"];
      expect(i).toMatchObject({ level: "action", stopId: "mcp-prod:finish" });
      expect(i.evidence).toContain("backend/mautic-mcp");
      expect(i.evidence).not.toContain("backend/chatwoot-mcp/dist");
      expect(r.ok).toBe(false);
    });

    it("入力: dist が無いと action", async () => {
      const r = await check(mcpCtx({ CONTROL_MAIN_CHECKOUT: checkout }));
      expect(itemsByKey(r)["mcp-prod.dist"]).toMatchObject({ level: "action", evidence: expect.stringContaining("が無い") });
    });

    it("入力: CONTROL_MAIN_CHECKOUT が prod.conf に無いと mcp-prod.dist が action", async () => {
      const r = await check(mcpCtx());
      expect(itemsByKey(r)["mcp-prod.dist"]).toMatchObject({ level: "action", evidence: expect.stringContaining("CONTROL_MAIN_CHECKOUT") });
    });

    it("入力: prod.conf に MCP の値が足りないと mcp-prod.values が action で、止まる id は mcp-prod:prod-values", async () => {
      const r = await check(mcpCtx({ CONTROL_MAIN_CHECKOUT: checkout }));
      expect(itemsByKey(r)["mcp-prod.values"]).toMatchObject({ level: "action", stopId: "mcp-prod:prod-values", evidence: expect.stringContaining("prod.conf に無いキー") });
    });
  });
});

// n8n の MCP に「人間だけが行う操作」のツールが出るときの「!」（2026-11-10）。check は notes に「!」、apply は手順付きで確認する。
// 各 MCP（Chatwoot・Mautic は ctx.http、Strapi・n8n の MCP は fetch）は偽物。実際のネットワークには出ない
describe("mcp-prod の n8n の人間だけの操作のツール", () => {
  const VALUES = {
    CHATWOOT_AGENT_TOKEN: "agent-token-0123456789",
    CHATWOOT_ACCOUNT_ID: "1",
    MAUTIC_CLIENT_ID: "rw-client-id",
    MAUTIC_CLIENT_SECRET: "rw-client-secret",
    MAUTIC_RO_CLIENT_ID: "ro-client-id",
    MAUTIC_RO_CLIENT_SECRET: "ro-client-secret",
    STRAPI_PROD_TOKEN: "strapi-prod-token-0123",
    N8N_PROD_TOKEN: "n8n-prod-token-0123",
    POSTHOG_PROD_API_KEY: "phx_0123456789",
    POSTHOG_PROD_PROJECT_ID: "123",
  };
  let n8nTools;

  /** MCP（Streamable HTTP）の偽物。initialize・notifications/initialized・tools/list・DELETE に答える */
  function stubMcp() {
    vi.stubGlobal("fetch", async (url, init) => {
      if (init.method === "DELETE") return new Response(null, { status: 200 });
      const body = JSON.parse(init.body);
      if (!("id" in body)) return new Response(null, { status: 202 });
      const result = body.method === "initialize" ? {} : { tools: (String(url).includes(":5679") ? n8nTools : ["create_article"]).map((name) => ({ name })) };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    });
  }

  const http = async (_label, url) => {
    if (url.endsWith("/api/v1/profile")) return { accounts: [{ id: 1, role: "agent" }] };
    if (url.endsWith("/oauth/v2/token")) return { access_token: "access" };
    return {};
  };

  const ctxFor = (answer, phaseOverrides = {}) => {
    const rec = recordingConfirm(answer);
    const ctx = fakeCtx({
      conf: VALUES,
      overrides: {
        phase: "apps",
        CONFIG_DIR: config,
        http,
        writeEnvFile,
        // dist の確かめ（CONTROL_MAIN_CHECKOUT が無い）で止まる。確認の後まで進んだことの目印にする
        manual: (id) => {
          throw Object.assign(new Error(`manual: ${id}`), { manualId: id });
        },
        ...rec.overrides,
        ...phaseOverrides,
      },
    });
    return { ctx, rec };
  };

  beforeEach(() => {
    n8nTools = ["search_workflows", "publish_workflow", "execute_workflow"];
    stubMcp();
  });

  describe("正常系", () => {
    it("サーバ: check は notes に「!」で出し、聞かない", async () => {
      const r = await check(fakeCtx({ conf: VALUES, overrides: { phase: "apps", CONFIG_DIR: config, http } }));
      expect(r.notes).toContain("! n8n-prod に人間だけが行う操作のツールが出ている（publish_workflow, execute_workflow）。n8n のトークンでは絞れない。これらを tools に含むエージェント定義は control-plane が起動しない（src/runner/agent.ts の HUMAN_ONLY_PROD_TOOLS。TA-07 の 3.3）");
      expect(r.notes).toContain("n8n-prod: ツール 3 本");
    });

    it("サーバ: apply は、エージェント定義を探す手順を付けて確認し、yes なら env ファイルを書いて先へ進む", async () => {
      const { ctx, rec } = ctxFor("yes");
      const err = await apply(ctx).catch((e) => e);
      expect(rec.asked.map((a) => a.id)).toEqual(["n8n-human-only"]);
      expect(rec.asked[0].steps[0]).toContain('rg -n "mcp__n8n-prod__(publish_workflow|execute_workflow)" .claude/agents');
      expect(rec.asked[0].steps.join("\n")).toContain("HUMAN_ONLY_PROD_TOOLS");
      expect(existsSync(join(config, "mcp", "n8n-prod.env"))).toBe(true);
      expect(err.manualId).toBe("finish");
    });

    it("空入力: 人間だけの操作のツールが出なければ、確認しない", async () => {
      n8nTools = ["search_workflows"];
      const { ctx, rec } = ctxFor("no");
      const err = await apply(ctx).catch((e) => e);
      expect(rec.asked).toEqual([]);
      expect(err.manualId).toBe("finish");
    });
  });

  describe("異常系", () => {
    it("入力: yes 以外なら確認で止まり、env ファイルを書かない", async () => {
      const { ctx, rec } = ctxFor("no");
      const err = await apply(ctx).catch((e) => e);
      expect(err).toMatchObject({ id: "n8n-human-only", kind: "confirm" });
      expect(rec.asked).toHaveLength(1);
      expect(existsSync(join(config, "mcp", "n8n-prod.env"))).toBe(false);
    });
  });
});
