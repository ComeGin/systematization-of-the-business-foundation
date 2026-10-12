import { defineConfig } from "vitest/config";

// 結合テストの設定（単体テストは vitest.config.ts）。開発の Chatwoot（127.0.0.1:3100）を本物として使い、
// テストの中で faq-bot を 127.0.0.1:3107 に起動する（host-relay が Chatwoot のコンテナから届かせる）。faq.json だけ偽の HTTP サーバー。
// - ファイルは 1 つずつ順に走らせる（3107 を取り合わないため）
// - Chatwoot の Webhook は Sidekiq のジョブなので、応答を待つ時間を長めにとる
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
