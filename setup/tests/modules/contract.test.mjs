// setup.mjs の MODULES に並ぶ全モジュールが、lib/core.mjs の冒頭に書いた契約（meta・check・apply）を満たすかを確かめる。
// import するだけで check / apply は呼ばない（どのモジュールも import 時の副作用が無いことをソースで確かめてある）。
// setup.mjs は MODULES を export せず、import すると main() が動くので、ソースから配列を読み取る。
// 対象はモジュールの定義（定数）の検査なので、異常系は置かない（壊れた定義の検出は setup.mjs の loadModules が実行時に行う）。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeTempDir, removeTempDir } from "../helpers/temp-home.mjs";

const SETUP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const W = resolve(SETUP_DIR, "..");
const TARGETS = ["dev", "prod"];

function readModulesFromSource() {
  const src = readFileSync(join(SETUP_DIR, "setup.mjs"), "utf8");
  const block = src.match(/const MODULES = \[([\s\S]*?)\];/);
  if (!block) throw new Error("setup.mjs に const MODULES = [...] が見つからない");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const MODULES = readModulesFromSource();
let home;
const loaded = [];

beforeAll(async () => {
  // 万一 import 時に homedir() の下へ書くモジュールがあっても、一時ディレクトリに閉じ込めて検出する
  home = makeTempDir();
  vi.stubEnv("HOME", home);
  for (const rel of MODULES) {
    const file = join(W, rel);
    loaded.push({ rel, file, mod: existsSync(file) ? await import(pathToFileURL(file).href) : null });
  }
});

afterAll(() => {
  vi.unstubAllEnvs();
  removeTempDir(home);
});

describe("MODULES の一覧", () => {
  describe("正常系", () => {
    it("setup.mjs のソースから 1 件以上読み取れ、重複が無い", () => {
      expect(MODULES.length).toBeGreaterThan(0);
      expect(new Set(MODULES).size).toBe(MODULES.length);
    });

    it("どのパスも W からの相対で、<モジュール>/setup/index.mjs（上流取り込みは dev/setup/index.mjs、本番だけのモジュールは setup/prod/index.mjs）の形になっている", () => {
      for (const rel of MODULES) expect(rel).toMatch(/^(?!\/)[^.][\w./-]*\/setup\/(?:prod\/)?index\.mjs$/);
    });

    it("どのモジュールのファイルも実在する（--list の「未実装」が無い）", () => {
      for (const { rel, mod } of loaded) expect(mod, rel).not.toBeNull();
    });

    it("README のモジュールの表と、id と場所と順番が一致する", () => {
      // setup.mjs の表は「モジュール（実行の順）」の節だけ（後ろの「フロントエンド全体」の節の表は frontend.mjs のもの）
      const readme = readFileSync(join(SETUP_DIR, "README.md"), "utf8").split("\n## フロントエンド全体")[0];
      const rows = [...readme.matchAll(/^\| `([\w-]+)` \| `([^`]+)`/gm)].map((m) => ({ id: m[1], dir: m[2].replace(/（.*$/, "") }));
      const fromModules = loaded.map(({ rel, mod }) => ({ id: mod.meta.id, dir: rel.replace(/index\.mjs$/, "") }));
      expect(rows).toEqual(fromModules);
    });
  });
});

describe("各モジュールの契約", () => {
  describe("正常系", () => {
    it("meta に id・title・targets・after があり、型が正しい", () => {
      for (const { rel, mod } of loaded) {
        const { meta } = mod;
        expect(typeof meta?.id, rel).toBe("string");
        expect(meta.id, rel).toMatch(/^[a-z][a-z0-9-]*$/);
        expect(typeof meta.title, rel).toBe("string");
        expect(meta.title.length, rel).toBeGreaterThan(0);
        expect(Array.isArray(meta.targets), rel).toBe(true);
        expect(meta.targets.length, rel).toBeGreaterThan(0);
        for (const t of meta.targets) expect(TARGETS, `${rel} の targets`).toContain(t);
        expect(Array.isArray(meta.after), rel).toBe(true);
      }
    });

    it("check と apply が関数として export されている", () => {
      for (const { rel, mod } of loaded) {
        expect(typeof mod.check, rel).toBe("function");
        expect(typeof mod.apply, rel).toBe("function");
      }
    });

    it("id が重複しない", () => {
      const ids = loaded.map(({ mod }) => mod.meta.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("after は実在する id を指し、MODULES の順でそれより前にある", () => {
      const order = loaded.map(({ mod }) => mod.meta.id);
      for (const [i, { rel, mod }] of loaded.entries()) {
        for (const dep of mod.meta.after) {
          expect(order, `${rel} の after: ${dep}`).toContain(dep);
          expect(order.indexOf(dep), `${rel} の after: ${dep} が後ろにある`).toBeLessThan(i);
        }
      }
    });

    it("after が自分自身を指さない", () => {
      for (const { rel, mod } of loaded) expect(mod.meta.after, rel).not.toContain(mod.meta.id);
    });

    it("after の依存先は、同じ target で動くモジュールである（片方の target でしか動かない依存を持たない）", () => {
      const byId = new Map(loaded.map(({ mod }) => [mod.meta.id, mod.meta]));
      for (const { rel, mod } of loaded) {
        for (const dep of mod.meta.after) {
          for (const t of mod.meta.targets) expect(byId.get(dep).targets, `${rel}（${t}）→ ${dep}`).toContain(t);
        }
      }
    });

    it("dev で動くモジュールが少なくとも 1 つあり、prod だけのモジュールは dev の一覧から外れる", () => {
      expect(loaded.some(({ mod }) => mod.meta.targets.includes("dev"))).toBe(true);
      const onprem = loaded.find(({ mod }) => mod.meta.id === "onprem");
      expect(onprem?.mod.meta.targets).toEqual(["prod"]);
    });
  });
});

describe("import 時の副作用", () => {
  describe("正常系", () => {
    it("全モジュールを import しても、ホームディレクトリに何も書かない", () => {
      expect(readdirSync(home)).toEqual([]);
    });
  });
});
