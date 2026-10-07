import { defineConfig } from "vitest/config";

// 単体テストの設定。テストは tests/ の下にモジュールごとのフォルダを切って置く。
// 実際のコンテナ・API・ホームディレクトリには触れない（必要なものはテストの中で一時ディレクトリに差し替える）
export default defineConfig({
  test: {
    include: ["tests/**/*.test.mjs"],
    environment: "node",
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    // 並列実行の負荷で初回の変換・import が既定の 5 秒を超えることがあるため、全パッケージでそろえて長めにする
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
