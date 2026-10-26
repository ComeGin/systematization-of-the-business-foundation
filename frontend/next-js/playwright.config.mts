// 監視アプリの E2E（pnpm e2e）の設定。単体テスト（vitest。tests/）・結合テスト（vitest。integration/）とは別で、ここは e2e/ だけを見る。
// E2E 専用のインスタンス（3201）をサンドボックスの置き場で起動し、開発の監視アプリ（3200）とその記録には触れない（e2e/support/sandbox.mjs）。
//
// 前提: node setup/setup.mjs --target dev が済み（Chatwoot の状態の値）、backend/control-plane の pnpm build が済んでいること
// （next-js は control-plane の dist/ を読む）。ビルドはしない（next dev で見る）。
import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, PORT, serverEnv } from "./e2e/support/sandbox.mjs";

export default defineConfig({
  testDir: "./e2e",
  // next dev は初めて開くページのコンパイルに数秒〜十数秒かかる
  timeout: 60_000,
  // クライアントの遷移も、ルートごとに初回は変換を待つ（暖機の後でも、機械の負荷が高いと 15 秒を超えた。2026-10-25）
  expect: { timeout: 30_000 },
  fullyParallel: true,
  workers: 2,
  // CI では失敗したテストをやり直し、やり直しの 1 回目だけトレースを取る（常に取ると重い）
  retries: process.env.CI ? 2 : 0,
  forbidOnly: !!process.env.CI,
  outputDir: "test-results/e2e",
  reporter: [["list"], ["html", { outputFolder: "playwright-report/e2e", open: "never" }]],
  globalSetup: "./e2e/global-setup.mts",

  // サンドボックスを作り直してから起動する（control-plane は起動時に E-15 を開くので、起動の前に置き場を用意する）
  webServer: {
    command: `node e2e/support/sandbox.mjs prepare && pnpm exec next dev -p ${PORT} -H 127.0.0.1`,
    url: `${BASE_URL}/login`,
    env: serverEnv(),
    reuseExistingServer: false,
    timeout: 180_000,
  },

  use: {
    baseURL: BASE_URL,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },

  projects: [{ name: "console", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
