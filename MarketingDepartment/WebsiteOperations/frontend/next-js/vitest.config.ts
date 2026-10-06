import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 単体テストの設定。テストは tests/ の下に lib/・app/ と同じフォルダ構成で置く（モジュールごとに 1 フォルダ）。
// control-plane（管制ライブラリ）と Better Auth はテストの中で差し替え、実 DB・Google には繋がない
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
