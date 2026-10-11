import { defineConfig } from "vitest/config";

// 結合テストの設定（pnpm test:integration）。単体テスト（vitest.config.ts・tests/）とは分ける。
// Strapi をテストのプロセスの中で起動し（createStrapi。integration/helpers/strapi-instance.ts）、PostHog だけを偽の HTTP サーバに差し替える。
// 動いている開発サーバー（1337）とは DB・ポートを共有しない。dist は strapi develop が作った既存のものを読むだけ
//
// - ファイルは 1 つずつ順に走らせる（Strapi の起動は重く、グローバル（global.strapi・process の listener）を使うため）
// - Strapi の起動と、PostHog の 5 秒の見切りを待つテストがあるので、既定より長くする
export default defineConfig({
  test: {
    include: ["integration/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
