import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 本番の入口の bundle（esbuild の ESM 出力）の設定の検査。bundle そのものは sam build のときに作る（このテストでは作らない）。
// ioredis（とその依存）は CommonJS で、require("events") などを呼ぶ。ESM の出力には require が無いため、
// banner で createRequire から require を用意しないと、読み込みの時点で「Dynamic require of "events" is not supported」になる
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
const makefile = readFileSync(new URL("../Makefile", import.meta.url), "utf8");

describe("bundle の設定", () => {
  describe("正常系", () => {
    it("ESM の出力の先頭で、createRequire から require を用意する", () => {
      const bundle = pkg.scripts.bundle!;
      expect(bundle).toContain("--format=esm");
      expect(bundle).toMatch(/--banner:js=.*createRequire.*const require = createRequire\(import\.meta\.url\)/);
    });

    it("Makefile は bundle のあとに、出力を読み込めることを確かめてから写す", () => {
      const lines = makefile.split("\n").map((line) => line.trim());
      const bundleAt = lines.indexOf("pnpm run bundle");
      const checkAt = lines.findIndex((line) => line.includes("import(") && line.includes("dist-lambda/index.mjs"));
      const copyAt = lines.findIndex((line) => line.startsWith("cp dist-lambda/index.mjs"));
      expect(bundleAt).toBeGreaterThanOrEqual(0);
      expect(checkAt).toBeGreaterThan(bundleAt);
      expect(copyAt).toBeGreaterThan(checkAt);
    });
  });

  describe("異常系", () => {
    it("入力: @aws-sdk は bundle に含めない（Lambda の実行環境にある）", () => {
      expect(pkg.scripts.bundle).toContain("--external:@aws-sdk/*");
    });
  });
});
