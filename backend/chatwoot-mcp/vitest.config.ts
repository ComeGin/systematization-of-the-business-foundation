import { defineConfig } from "vitest/config";

// 単体テストの設定。テストは tests/ の下に src/ と同じフォルダ構成で置く（モジュールごとに 1 フォルダ）。
// 実 API・DB・Docker には繋がない。外部との境界（fetch・クライアント・時刻）はテストの中で差し替える
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // installFetch() を忘れたテストが実ネットワーク・開発環境の Chatwoot に届かないよう、既定の fetch を失敗させる
    setupFiles: ["tests/helpers/no-network.ts"],
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    // vi.resetModules() のあとの import("../src/index.js") は、初回の変換が並列実行の負荷で既定の 5 秒を超えることがあるため延ばす（全パッケージで同じ値）
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
