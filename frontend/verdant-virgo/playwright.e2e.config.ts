// E2E（pnpm e2e）の設定。a11y の自動検査（playwright.config.ts。ビルド済みの dist を送信の差し替えで見る）とは別で、
// ここは e2e/flows だけを見る。開発スタック（オンプレ）を本物として通し、オンプレの外は差し替える（e2e/flows/support/env.ts の冒頭）。
//
// 前提: node setup/setup.mjs --target dev と node setup/frontend.mjs --target dev が済み、開発スタックが動いていること
// （Strapi は別の端末の pnpm dev、faq-bot も pnpm dev）。ビルドはしない（dev サーバーで見る）。
import { defineConfig, devices } from "@playwright/test";
import { DEV, E2E_BASE_URL, E2E_PORT, RUN_ID } from "./e2e/flows/support/env";

export default defineConfig({
  testDir: "./e2e/flows",
  // dev サーバーは初めて開くページの変換に数秒かかる
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  // 開発スタック（Mautic の PHP の組み込みサーバーは 1 本ずつしか処理しない）と機械の負荷に合わせる
  workers: 2,
  // CI では失敗したテストをやり直し、やり直しの 1 回目だけトレースを取る（常に取ると重い）
  retries: process.env.CI ? 2 : 0,
  forbidOnly: !!process.env.CI,
  outputDir: "test-results/e2e",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report/e2e", open: "never" }],
  ],
  globalSetup: "./e2e/flows/global-setup.ts",

  // E2E 専用の dev サーバー（4324）。開発の dev サーバー（4321）とは別に起動し、終わったら Playwright が止める。
  // ASTRO_DEV_BACKGROUND を立てると AI エージェントの環境の検出を飛ばして前景で動き、--ignore-lock で 4321 のロックと並べられる
  // （astro/dist/cli/dev/index.js。a11y の preview と同じ考え方）。
  // 送信先を 127.0.0.1 に向け直す（開発の .env は ngrok の URL で、オンプレの外を通る）。Cal.com のリンクは偽物に合わせて固定する
  webServer: {
    command: `pnpm exec astro dev --port ${E2E_PORT} --host 127.0.0.1 --ignore-lock`,
    url: `${E2E_BASE_URL}/`,
    env: {
      ASTRO_DEV_BACKGROUND: "1",
      E2E_RUN_ID: RUN_ID,
      PUBLIC_MAUTIC_BASE: DEV.mautic,
      PUBLIC_CONSENT_BASE: DEV.consentApi,
      PUBLIC_CHATWOOT_BASE: DEV.chatwoot,
      PUBLIC_CALCOM_BASE: "https://app.cal.com",
      PUBLIC_CALCOM_LINK: "comegin-e2e/30min",
      PUBLIC_CONSENT_COOKIE_DOMAIN: "",
      // 開発ではタグを出さない（ADR-25）。.env に入っていても空で上書きする
      PUBLIC_GA4_MEASUREMENT_ID: "",
    },
    reuseExistingServer: false,
    timeout: 180_000,
  },

  use: {
    baseURL: E2E_BASE_URL,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    // data-cta-id は CTA の ID の正本（site-content/cta.ts）に型で縛られた属性で、解析の契約でもある。テストの契約としても使う
    testIdAttribute: "data-cta-id",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },

  projects: [
    {
      name: "flows",
      testIgnore: /faults\//,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      // 開発スタックのコンテナを一時停止して障害を起こす。ほかのテストを巻き込まないよう、flows がすべて終わってから流す
      name: "faults",
      testMatch: /faults\/.*\.spec\.ts$/,
      dependencies: ["flows"],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
