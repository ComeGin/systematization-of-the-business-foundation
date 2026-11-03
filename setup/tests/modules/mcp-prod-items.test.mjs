// ops/setup/index.mjs（モジュール mcp-prod）の check が返す items（mcp-prod.dist・mcp-prod.values。どちらも P10）の単体テスト。
// git（node:child_process の execFileSync）は偽物に差し替える。ファイルは一時ディレクトリだけに置く。各 MCP への通信は、prod.conf の値が足りない状態で走らせるので起きない。
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCtx, itemsByKey } from "../helpers/fake-ctx.mjs";
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

const { check } = await import("../../../ops/setup/index.mjs");

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
