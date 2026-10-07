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
    // vi.resetModules() のあとの import の初回の変換が、並列実行の負荷で既定の 5 秒を超えることがあるため（全パッケージで同じ値）
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
