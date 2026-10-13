import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 本番の bundle（esbuild の ESM 出力 2 つ）の設定の検査。bundle そのものは sam build のときに作る（このテストでは作らない）。
// pg などは CommonJS で require を呼ぶ。ESM の出力には require が無いため、banner で createRequire から用意しないと
// 読み込みの時点で「Dynamic require of … is not supported」になる（② の最終レビューで判明）
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
const makefile = readFileSync(new URL("../Makefile", import.meta.url), "utf8");
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

/** Makefile のターゲットの行（タブの後ろ）を返す */
function recipe(target: string): string[] {
  const lines = makefile.split("\n");
  const start = lines.indexOf(`${target}:`);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("\t")) break;
    body.push(line.trim());
  }
  return body;
}

describe("bundle の設定", () => {
  describe("正常系", () => {
    it("本体（index）と運用（ops）の 2 つを ESM で出し、先頭で createRequire から require を用意する", () => {
      const bundle = pkg.scripts.bundle!;
      expect(bundle).toContain("index=src/lambda.ts");
      expect(bundle).toContain("ops=src/ops.ts");
      expect(bundle).toContain("--format=esm");
      expect(bundle).toContain("--out-extension:.js=.mjs");
      expect(bundle).toMatch(/--banner:js=.*createRequire.*const require = createRequire\(import\.meta\.url\)/);
    });

    it.each([
      ["build-AdminAuthFunction", "index"],
      ["build-AdminAuthOpsFunction", "ops"],
    ])("Makefile の %s は bundle → 読み込みの確認 → %s.mjs を写す、の順", (target, name) => {
      const lines = recipe(target);
      const bundleAt = lines.indexOf("pnpm run bundle");
      const checkAt = lines.findIndex((line) => line.includes("import(") && line.includes(`dist-lambda/${name}.mjs`));
      const copyAt = lines.findIndex((line) => line.startsWith(`cp dist-lambda/${name}.mjs dist-lambda/${name}.mjs.map`));
      expect(bundleAt).toBeGreaterThanOrEqual(0);
      expect(checkAt).toBeGreaterThan(bundleAt);
      expect(copyAt).toBeGreaterThan(checkAt);
    });
  });

  describe("異常系", () => {
    it("入力: @aws-sdk は bundle に含めない（Lambda の実行環境にある）", () => {
      expect(pkg.scripts.bundle).toContain("--external:@aws-sdk/*");
    });

    it("入力: 開発の Dockerfile に本番専用の RDS の CA の取得を残さない（本番は Lambda の /var/runtime/ca-cert.pem）", () => {
      expect(dockerfile).not.toContain("rds-global-bundle");
      expect(dockerfile).not.toContain("NODE_EXTRA_CA_CERTS");
    });
  });
});
