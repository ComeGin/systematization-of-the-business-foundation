import { defineConfig } from "vitest/config";

// 結合テストの設定（単体テストは vitest.config.ts）。公開の入口（createControlPlane）から SQLite・builtin・integrations までを本物でつなぎ、
// 開発の n8n（127.0.0.1:5678）と Chatwoot（127.0.0.1:3100）には実際に繋ぐ。
// 開発スタックに無いもの（GitHub・AWS SDK・Anthropic Agent SDK）だけを差し替える（integration/helpers）。
// - ファイルは 1 つずつ順に走らせる（他の担当の結合テストと同じく、開発スタックへの負荷と後片付けの順序を単純にする）
// - 再試行の待ち（unreachable は 3 秒 + 9 秒、GitHub のタイムアウトは 30 秒）を含むため、既定の 5 秒より長くする
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
    hookTimeout: 120_000,
  },
});
