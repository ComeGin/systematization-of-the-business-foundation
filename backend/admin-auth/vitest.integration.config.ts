import { defineConfig } from "vitest/config";

// 結合テストの設定（単体テストは vitest.config.ts）。ALB の形のイベントで lambda.ts（本体）と ops.ts（運用）を呼び、
// 開発の PostgreSQL（127.0.0.1:5434）を本物として使う。Secrets Manager と Google だけ差し替える。
// - PostgreSQL を docker pause するテストがあるため、ファイルは 1 つずつ順に走らせる
export default defineConfig({
  test: {
    include: ["integration/**/*.test.ts"],
    environment: "node",
    globalSetup: ["integration/global-setup.ts"],
    fileParallelism: false,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
