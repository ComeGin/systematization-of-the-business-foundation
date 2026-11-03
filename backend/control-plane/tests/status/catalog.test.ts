import { utimesSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catalogDocFiles, CatalogError, loadCatalog } from "../../src/status/catalog.js";
import { makeTempDir, putFile, repositoryRoot } from "../helpers/store.js";

let temp: ReturnType<typeof makeTempDir>;

beforeEach(() => {
  temp = makeTempDir();
});
afterEach(() => {
  temp.cleanup();
});

const STEPS_PATH = "setup/status/steps.mjs";

const item = (over: Record<string, unknown> = {}) => ({
  id: "P1.tools",
  title: "道具を入れる",
  who: "人・端末",
  kind: "検査",
  overviewText: "AWS CLI",
  probe: { kind: "module", module: "cloud", phase: "env" },
  docs: [{ file: "cloud/README.md", heading: "2" }],
  stopId: "cloud:env",
  ...over,
});
const step = (over: Record<string, unknown> = {}) => ({ id: "P1", title: "段階 env", items: [item()], ...over });

/** steps.mjs を書く。version / productApiModules / steps は差し替えられる（undefined なら export しない） */
function putSteps(opts: { version?: unknown; modules?: unknown; steps?: unknown } = {}): string {
  const has = (k: string) => k in opts;
  const lines: string[] = [];
  if (!has("version") || opts.version !== undefined) lines.push(`export const CATALOG_VERSION = ${JSON.stringify(has("version") ? opts.version : 1)};`);
  if (!has("modules") || opts.modules !== undefined) lines.push(`export const PRODUCT_API_MODULES = ${JSON.stringify(has("modules") ? opts.modules : ["mautic-prod"])};`);
  if (!has("steps") || opts.steps !== undefined) lines.push(`export const STEPS = ${JSON.stringify(has("steps") ? opts.steps : [step()])};`);
  return putFile(temp.dir, STEPS_PATH, lines.join("\n") + "\n");
}

async function failure(): Promise<string> {
  try {
    await loadCatalog(temp.dir);
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogError);
    return (error as Error).message;
  }
  throw new Error("CatalogError にならなかった");
}

describe("loadCatalog", () => {
  describe("正常系", () => {
    it("入力: 正しいカタログを { version, productApiModules, steps } にして返す", async () => {
      putSteps();
      const catalog = await loadCatalog(temp.dir);
      expect(catalog).toEqual({ version: 1, productApiModules: ["mautic-prod"], steps: [step()] });
    });

    it("入力: probe の 5 種類（item・items・module・drift・none）をすべて受け付ける", async () => {
      putSteps({
        steps: [
          step({
            items: [
              item({ id: "P1.a", probe: { kind: "item", key: "cloud.dmarc" } }),
              item({ id: "P1.b", probe: { kind: "items", keys: ["cloud.ses-domain", "cloud.dmarc"] } }),
              item({ id: "P1.c", probe: { kind: "module", module: "cloud", phase: "deploy" } }),
              item({ id: "P1.d", probe: { kind: "drift", id: "site-redeploy" } }),
              item({ id: "P1.e", kind: "未検査", probe: { kind: "none" }, stopId: undefined }),
            ],
          }),
        ],
      });
      const probes = (await loadCatalog(temp.dir)).steps[0]!.items.map((i) => i.probe.kind);
      expect(probes).toEqual(["item", "items", "module", "drift", "none"]);
    });

    it("入力: stopId は無くてもよく、docs は空配列でもよい", async () => {
      putSteps({ steps: [step({ items: [item({ stopId: undefined, docs: [] })] })] });
      const loaded = (await loadCatalog(temp.dir)).steps[0]!.items[0]!;
      expect(loaded.stopId).toBeUndefined();
      expect(loaded.docs).toEqual([]);
    });

    it("空入力: 項目が 0 件の段階も受け付ける", async () => {
      putSteps({ steps: [step({ items: [] })], modules: [] });
      expect((await loadCatalog(temp.dir)).steps[0]!.items).toEqual([]);
    });

    it("入力: ファイルが更新されたら（更新時刻が変われば）新しい内容を読む", async () => {
      const file = putSteps({ steps: [step({ title: "最初" })] });
      utimesSync(file, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
      expect((await loadCatalog(temp.dir)).steps[0]!.title).toBe("最初");
      putSteps({ steps: [step({ title: "更新後" })] });
      utimesSync(file, new Date("2026-02-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));
      expect((await loadCatalog(temp.dir)).steps[0]!.title).toBe("更新後");
    });

    it("入力: リポジトリの実物の setup/status/steps.mjs を読める（カタログと型のずれの検出）", async () => {
      const root = repositoryRoot();
      if (root === null) return;
      const catalog = await loadCatalog(root);
      expect(catalog.version).toBe(1);
      expect(catalog.steps.map((s) => s.id)).toContain("P1");
      expect(catalog.steps.map((s) => s.id)).toContain("R1");
      expect(catalog.productApiModules).toContain("mautic-prod");
      expect(catalogDocFiles(catalog).has("cloud/README.md")).toBe(true);
    });
  });

  describe("異常系", () => {
    it("空入力: steps.mjs が無ければ CatalogError", async () => {
      expect(await failure()).toMatch(/カタログ.*無い/);
    });

    it("入力: CATALOG_VERSION が 1 でなければ、値を出さずに版が違うと伝える", async () => {
      putSteps({ version: 2 });
      const message = await failure();
      expect(message).toMatch(/CATALOG_VERSION/);
      expect(message).not.toMatch(/\b2\b/);
    });

    it("空入力: CATALOG_VERSION を export していなければ CatalogError", async () => {
      putSteps({ version: undefined });
      expect(await failure()).toMatch(/CATALOG_VERSION/);
    });

    it("入力: 構文エラーのファイルは、読み込めないと伝える（中身は出さない）", async () => {
      putFile(temp.dir, STEPS_PATH, "export const CATALOG_VERSION = ;\nconst SECRET = 'zzz-secret-zzz'\n");
      const message = await failure();
      expect(message).toMatch(/読み込めない/);
      expect(message).not.toContain("zzz-secret-zzz");
    });

    it("空入力: STEPS を export していなければ、場所を挙げて CatalogError", async () => {
      putSteps({ steps: undefined });
      expect(await failure()).toMatch(/steps/);
    });

    it("空入力: STEPS が空配列なら CatalogError", async () => {
      putSteps({ steps: [] });
      expect(await failure()).toMatch(/steps/);
    });

    it("入力: PRODUCT_API_MODULES が配列でなければ CatalogError", async () => {
      putSteps({ modules: "mautic-prod" });
      expect(await failure()).toMatch(/productApiModules/);
    });

    it.each([
      ["probe.kind が未知", { probe: { kind: "magic" } }, /probe/],
      ["items の keys が空", { probe: { kind: "items", keys: [] } }, /keys/],
      ["item の key が空", { probe: { kind: "item", key: "" } }, /key/],
      ["drift の id が未知", { probe: { kind: "drift", id: "other" } }, /id/],
      ["module に phase が無い", { probe: { kind: "module", module: "cloud" } }, /phase/],
      ["who が未知", { who: "誰か" }, /who/],
      ["kind が未知", { kind: "不明" }, /kind/],
      ["title が空", { title: "" }, /title/],
      ["docs が配列でない", { docs: "cloud/README.md" }, /docs/],
      ["docs の heading が無い", { docs: [{ file: "cloud/README.md" }] }, /heading/],
    ])("入力: 項目の形が不正（%s）なら、場所を挙げて CatalogError", async (_label, over, pattern) => {
      putSteps({ steps: [step({ items: [item(over)] })] });
      expect(await failure()).toMatch(pattern);
    });

    it("入力: 項目の id が重複していれば CatalogError", async () => {
      putSteps({ steps: [step({ items: [item(), item()] })] });
      expect(await failure()).toMatch(/重複/);
    });

    it("入力: 段階の id が重複していれば CatalogError", async () => {
      putSteps({ steps: [step(), step({ items: [item({ id: "P1.other" })] })] });
      expect(await failure()).toMatch(/重複/);
    });

    it("入力: 形が不正なときの理由に、入力の値（秘密値に見える文字列）を出さない", async () => {
      putSteps({ steps: [step({ items: [item({ who: "zzz-secret-zzz" })] })] });
      expect(await failure()).not.toContain("zzz-secret-zzz");
    });
  });
});

describe("catalogDocFiles", () => {
  describe("正常系", () => {
    it("入力: すべての項目の docs のファイルを重複なく集める", async () => {
      putSteps({
        steps: [
          step({
            items: [
              item({ id: "P1.a", docs: [{ file: "cloud/README.md", heading: "2" }, { file: "onprem/README.md", heading: "2. Strapi" }] }),
              item({ id: "P1.b", docs: [{ file: "cloud/README.md", heading: "4.1" }] }),
              item({ id: "P1.c", docs: [] }),
            ],
          }),
        ],
      });
      const files = catalogDocFiles(await loadCatalog(temp.dir));
      expect([...files].sort()).toEqual(["cloud/README.md", "onprem/README.md"]);
    });
  });
});

