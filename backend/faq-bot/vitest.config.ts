import { defineConfig } from "vitest/config";

// 単体テストの設定。テストは tests/ の下に src/ と同じフォルダ構成で置く（モジュールごとに 1 フォルダ）。
// 実 API・Chatwoot・AWS には繋がない。外部との境界（fetch・Secrets Manager・時刻）はテストの中で差し替える
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    // 全パッケージでそろえて 30 秒にする（vi.resetModules() 後の import が並列の負荷で 5 秒を超えるため）
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
