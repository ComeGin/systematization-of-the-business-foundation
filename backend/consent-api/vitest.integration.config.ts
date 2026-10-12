import { defineConfig } from "vitest/config";

// 結合テストの設定（単体テストは vitest.config.ts）。ALB の形のイベントで lambda.ts の handler を呼び、
// 開発の Valkey（127.0.0.1:6380）を本物として使う。Secrets Manager だけ差し替える（initRuntime の loadPassword）。
// - Valkey を docker pause するテストがあるため、ファイルは 1 つずつ順に走らせる
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
