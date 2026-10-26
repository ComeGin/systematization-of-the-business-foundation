// a11y の自動検査（pnpm a11y）の設定。計画書 docs/superpowers/plans/2026-10-18-jis-x-8341-3-accessibility.md の V1・P-8。
// dist を配信するだけで、ビルドはしない。先に SITE_URL=https://comegin.com pnpm build を済ませる（pnpm lh と同じ）。
// 単体テスト（vitest。tests/**/*.test.ts）とは別で、ここは e2e/a11y だけを見る（e2e/flows は E2E。playwright.e2e.config.ts）。
import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, PORT } from "./e2e/a11y/routes";

export default defineConfig({
  testDir: "./e2e/a11y",
  timeout: 30_000,
  retries: 0,
  // build・Lighthouse と同じく機械の負荷を抑える（Lighthouse の performance がぶれるため、同時に走らせない）
  workers: 2,
  fullyParallel: true,
  outputDir: "test-results",
  // 結果の JSON は .a11y/（Git 管理外）。builtin の a11y ジョブは .a11y/*.json だけを写す
  reporter: [["list"], ["json", { outputFile: ".a11y/results.json" }]],
  globalSetup: "./e2e/a11y/setup.ts",
  globalTeardown: "./e2e/a11y/merge.ts",

  // 4321 は dev、4322 は Lighthouse CI の preview。衝突させないため 4323 に固定する。
  // 古い preview を誤って測らないよう、既存のサーバーは使い回さない。
  // Astro 7.3 の preview は、AI エージェントの環境（Claude Code・Agent SDK など）を検出すると自分でバックグラウンドに回り、
  // Playwright からは「すぐ終了した」に見える。さらにロックファイル（.astro/preview.json）で 1 プロジェクト 1 つに制限し、
  // Lighthouse CI の 4322 と同時に起動できない。ASTRO_PREVIEW_BACKGROUND を立てると検出を飛ばして前景で動き、
  // --ignore-lock でロックを読み書きしない（astro/dist/cli/preview/index.js）。終了は Playwright が行う
  webServer: {
    command: `pnpm exec astro preview --port ${PORT} --host 127.0.0.1 --ignore-lock`,
    env: { ASTRO_PREVIEW_BACKGROUND: "1" },
    url: `${BASE_URL}/`,
    reuseExistingServer: false,
    // 機械の負荷が高いと起動に 40 秒を超えることがある（2026-10-18 に 44 秒）
    timeout: 120_000,
  },

  use: {
    baseURL: BASE_URL,
    locale: "ja-JP",
    screenshot: "only-on-failure",
    trace: "off",
  },

  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
