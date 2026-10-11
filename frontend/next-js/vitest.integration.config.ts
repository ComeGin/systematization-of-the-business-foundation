import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 結合テストの設定（単体テストは vitest.config.ts）。テストは integration/ の下に置く。
// Route Handler → lib（ログイン確認）→ control-plane（本物）→ E-15（一時ディレクトリの SQLite）を 1 本につないで動かす。
// 差し替えるのは開発スタックに無いもの（Agent SDK・AWS SDK・GitHub の fetch）と、Next.js の要求の文脈（next/headers）だけ。
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const controlPlane = here("../../backend/control-plane/");

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: here("./") },
      // control-plane は dist/ ではなく src/ を読む。dist/ は pnpm build の時点の写しで、src/ より古いことがある（build はテストからは走らせない）
      { find: /^control-plane$/, replacement: `${controlPlane}src/index.ts` },
      // control-plane の依存は next-js の node_modules に無い。テストの vi.mock と control-plane の import が同じモジュールを指すよう、置き場をそろえる
      {
        find: /^(@anthropic-ai\/claude-agent-sdk|@aws-sdk\/client-s3|@aws-sdk\/client-cloudwatch|@aws-sdk\/credential-providers)$/,
        replacement: `${controlPlane}node_modules/$1`,
      },
    ],
  },
  test: {
    include: ["integration/**/*.test.ts"],
    environment: "node",
    // E-15・ログイン用の SQLite・main のチェックアウトの写しは、ファイルごとに一時ディレクトリに作る。1 ファイルずつ順に走らせる
    fileParallelism: false,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
