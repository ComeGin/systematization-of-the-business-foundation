import { defineConfig } from "vitest/config";

// 結合テストの設定。単体テスト（各パッケージの tests/）と違い、オンプレの開発スタック（127.0.0.1）に実際に繋ぐ。
// モックするのは開発スタックに無いもの（AWS・PostHog・GitHub・Google・Agent SDK）だけ。
//
// - ファイルは 1 つずつ順に走らせる。コンテナの一時停止（docker.ts）や n8n のワークフローの有効化が、
//   ほかのスイートの前提を壊さないようにするため
// - Webhook → n8n → MailHog のような非同期の経路を待つので、既定の 5 秒より長くする
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/helpers/global-setup.ts"],
    fileParallelism: false,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
