import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "@/modules/a11y";

// theme.css の役割トークンの組み合わせのコントラスト（計画書の検証 5）。
// tokens.css（生成物）を読み、theme.css の :root で後勝ちに上書きしたうえで、var() をたどって hex にする。
const STYLES = new URL("../../../src/styles/", import.meta.url);
const read = (name: string) =>
  fs.readFileSync(fileURLToPath(new URL(name, STYLES)), "utf8");

/** :root の中の宣言（--name: value;）を順に読む。コメントは除く */
function declarations(css: string): [string, string][] {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [
    m[1],
    m[2].trim(),
  ]);
}

const vars = new Map<string, string>([
  ...declarations(read("tokens.css")),
  ...declarations(read("theme.css")),
]);

/** var(--x) をたどって hex にする。定義が無い・hex にならないときは例外 */
function resolve(name: string, seen: string[] = []): string {
  if (seen.includes(name))
    throw new Error(`循環: ${[...seen, name].join(" → ")}`);
  const value = vars.get(name);
  if (value === undefined) throw new Error(`未定義のトークン: ${name}`);
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  if (ref) return resolve(ref[1], [...seen, name]);
  if (!/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value)) {
    throw new Error(`${name} が hex になりません: ${value}`);
  }
  return value;
}

const role = (name: string) => resolve(`--color-role-${name}`);

// [前景, 背景, 基準]。文字は 4.5:1（1.4.3）、UI 部品の境界とフォーカスの表示は 3:1（1.4.11）
const TEXT = 4.5;
const UI = 3;
const PAIRS: [string, string, number][] = [
  // 本文・見出し・補足の文字
  ["text-body", "surface", TEXT],
  ["text-body", "surface-subtle", TEXT],
  ["text-body", "surface-accent-subtle", TEXT],
  ["text-heading", "surface", TEXT],
  ["text-heading", "surface-subtle", TEXT],
  ["text-heading", "surface-accent-subtle", TEXT],
  ["text-primary", "surface", TEXT],
  ["text-muted", "surface", TEXT],
  ["text-muted", "surface-subtle", TEXT],
  ["text-accent-subtle", "surface-accent-subtle", TEXT],
  ["text-brand", "surface", TEXT],
  // リンク（白地は text-link、薄い地は text-link-on-subtle。P-3）
  ["text-link", "surface", TEXT],
  ["text-link-hover", "surface", TEXT],
  ["text-link-on-subtle", "surface-subtle", TEXT],
  ["text-link-hover", "surface-subtle", TEXT],
  // 反転の文字（主ボタン・CTA バナー）
  ["text-inverse", "surface-brand", TEXT],
  ["text-inverse", "surface-brand-hover", TEXT],
  ["text-inverse", "surface-brand-strong", TEXT],
  // A（vivid）のヒーロー（navy.900 の地。Task 3）。見出し・本文・補足・上の 1 行、主ボタンの地との境界、白いフォーカスリング
  ["text-inverse", "surface-hero", TEXT],
  ["text-on-hero-muted", "surface-hero", TEXT],
  ["text-on-hero-accent", "surface-hero", TEXT],
  ["surface-brand", "surface-hero", UI],
  ["focus-ring-on-dark", "surface-hero", UI],
  // 入力欄の枠（P-3）
  ["border-input", "surface", UI],
  ["border-input", "surface-subtle", UI],
  // フォーカスリング（明るい地は focus-ring、暗い地は focus-ring-on-dark。P-3）
  ["focus-ring", "surface", UI],
  ["focus-ring", "surface-subtle", UI],
  ["focus-ring-on-dark", "surface-brand-strong", UI],
  // 主ボタンの地と白い地の境界
  ["surface-brand", "surface", UI],
];

describe("theme.css の役割トークンのコントラスト", () => {
  describe("正常系", () => {
    it("P-3 の 3 トークンが定義され、hex にたどれる", () => {
      expect(role("text-link-on-subtle")).toMatch(/^#/);
      expect(role("border-input")).toMatch(/^#/);
      expect(role("focus-ring-on-dark")).toMatch(/^#/);
    });

    it.each(PAIRS)("%s と %s が %s:1 以上", (fg, bg, min) => {
      expect(contrastRatio(role(fg), role(bg))).toBeGreaterThanOrEqual(min);
    });

    it("意味の色（成功・注意・危険・情報）は白地で 4.5:1 以上", () => {
      for (const name of ["success", "warning", "danger", "info"]) {
        const color = resolve(`--color-semantic-${name}`);
        expect(contrastRatio(color, role("surface"))).toBeGreaterThanOrEqual(
          TEXT,
        );
      }
    });

    it("shadcn/ui の --input と --ring は役割トークンに当たっている", () => {
      expect(resolve("--input")).toBe(role("border-input"));
      expect(resolve("--ring")).toBe(role("focus-ring"));
    });
  });

  describe("異常系", () => {
    it("入力: 置き換える前の組み合わせは基準に届かない（P-3 で役割トークンを足した理由）", () => {
      expect(
        contrastRatio(role("text-link"), role("surface-subtle")),
      ).toBeLessThan(TEXT);
      expect(contrastRatio(role("border"), role("surface"))).toBeLessThan(UI);
      expect(
        contrastRatio(role("focus-ring"), role("surface-brand-strong")),
      ).toBeLessThan(UI);
    });

    it("入力: 定義の無いトークンをたどると例外", () => {
      expect(() => resolve("--color-role-does-not-exist")).toThrow(/未定義/);
    });
  });
});
