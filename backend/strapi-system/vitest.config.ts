import { defineConfig } from "vitest/config";

// 単体テストの設定。テストは tests/ の下に src/ と同じフォルダ構成で置く（モジュールごとに 1 フォルダ）。
// 実 API・DB・Docker には繋がない。外部との境界（fetch・クライアント・時刻）はテストの中で差し替える
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    // vi.resetModules() のあとに src を読み直すテストは、並列実行の負荷で初回の変換が既定の 5 秒を超えることがある。
    // 全パッケージで同じ値にそろえる
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
