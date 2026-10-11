import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 単体テストの設定（Astro のビルドとは別）。対象は src/modules の TypeScript だけで、.astro は扱わない。
// テストは tests/ の下に src/ と同じフォルダ構成で置く
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
