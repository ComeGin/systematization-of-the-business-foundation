import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DURATION } from "@/modules/motion/lib/tokens";

// モーションのトークン（動きの規則 7）。theme.css の --motion-duration-* と tokens.ts の DURATION は同じ値にする。
const THEME_CSS = fs.readFileSync(
  fileURLToPath(new URL("../../../src/styles/theme.css", import.meta.url)),
  "utf8",
);

/** theme.css の宣言（--name: Nms;）を ms の数値で読む。コメントは除く */
function readMs(name: string): number | undefined {
  if (!name.startsWith("--")) return undefined;
  const body = THEME_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const match = new RegExp(`${name}\\s*:\\s*([\\d.]+)ms\\s*;`).exec(body);
  return match ? Number(match[1]) : undefined;
}

describe("motion/lib/tokens の時間", () => {
  describe("正常系", () => {
    it("ambient（ゆっくり漂う動きの 1 周）は 8000ms", () => {
      expect(DURATION.ambient).toBe(8000);
    });

    it("glow（光の明るさの 1 周）は 2400ms", () => {
      expect(DURATION.glow).toBe(2400);
    });

    it("glow は 1000ms 以上（点滅は 1 秒に 3 回まで。2.3.1）", () => {
      expect(DURATION.glow).toBeGreaterThanOrEqual(1000);
    });

    it("既存の micro・small・medium・large は変わらない", () => {
      expect(DURATION).toMatchObject({
        micro: 120,
        small: 200,
        medium: 320,
        large: 600,
      });
    });

    it("theme.css の --motion-duration-ambient は DURATION.ambient と同じ値", () => {
      expect(readMs("--motion-duration-ambient")).toBeTypeOf("number");
      expect(readMs("--motion-duration-ambient")).toBe(DURATION.ambient);
    });

    it("theme.css の --motion-duration-glow は DURATION.glow と同じ値", () => {
      expect(readMs("--motion-duration-glow")).toBeTypeOf("number");
      expect(readMs("--motion-duration-glow")).toBe(DURATION.glow);
    });

    it("theme.css の既存 4 つも DURATION と同じ値", () => {
      for (const name of ["micro", "small", "medium", "large"] as const) {
        expect(readMs(`--motion-duration-${name}`)).toBe(DURATION[name]);
      }
    });
  });

  describe("異常系", () => {
    it("空入力: 定義の無い名前は読めない（undefined）", () => {
      expect(readMs("")).toBeUndefined();
    });

    it("入力: 定義の無いトークンは undefined", () => {
      expect(readMs("--motion-duration-does-not-exist")).toBeUndefined();
    });
  });
});
