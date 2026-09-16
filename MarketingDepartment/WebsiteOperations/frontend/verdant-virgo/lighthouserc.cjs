// Lighthouse CI 設定。
// package.json が "type": "module" のため、require() で読み込む LHCI には
// .js ではなく .cjs で渡す必要がある。
// https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md

// dev サーバー (astro dev) が 4321 を使うため、preview は 4322 に固定する。
// 同一ポートだと Astro が衝突を避けて別ポートへ退避し、LHCI が dev サーバーを
// 誤計測してしまう。
const PORT = 4322;

module.exports = {
  ci: {
    collect: {
      // dist/ を配信するだけ。ビルドは npm script 側 (pnpm lh) で先に済ませる。
      startServerCommand: `pnpm exec astro preview --port ${PORT}`,
      startServerReadyPattern: `localhost:${PORT}`,
      url: [`http://localhost:${PORT}/`],

      // 単発計測は数値がブレるため 3 回走らせて中央値を採用する。
      numberOfRuns: 3,

      settings: {
        // ゲスト OS に X サーバーがないため headless 必須。
        // 付けないと Chrome が "Missing X server or $DISPLAY" で即死する。
        chromeFlags: '--headless=new',
      },
    },

    assert: {
      assertions: {
        // 本番ビルドの実測ベースラインは 0.98〜1.00（3 回計測）。
        // 十分な余裕があるため error に昇格済み。
        'categories:performance': ['error', { minScore: 0.9 }],
        'categories:accessibility': ['error', { minScore: 0.9 }],
        'categories:best-practices': ['error', { minScore: 0.9 }],
        // SEO 対策が本設定の目的なので満点を死守ラインとする。
        'categories:seo': ['error', { minScore: 1 }],
      },
    },

    upload: {
      // 既定の temporary-public-storage はレポートを外部へ公開するため使わない。
      target: 'filesystem',
      outputDir: './.lighthouse',
    },
  },
};
