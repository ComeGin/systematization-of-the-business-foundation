// Lighthouse CI 設定。
// package.json が "type": "module" のため、require() で読み込む LHCI には
// .js ではなく .cjs で渡す必要がある。
// https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md

// dev サーバー (astro dev) が 4321 を使うため、preview は 4322 に固定する。
// 同一ポートだと Astro が衝突を避けて別ポートへ退避し、LHCI が dev サーバーを
// 誤計測してしまう。
const PORT = 4322;

const fs = require("node:fs");
const path = require("node:path");

// dist/blog/<slug>/index.html のうち、一覧（page・category）以外の記事を名前順で 1 本返す。
// pnpm lh は build の後に LHCI を起動するので、この設定を読む時点で dist はできている。
// 記事が無ければ空にして、トップと一覧だけを測る（ビルド自体が記事 0 件で失敗する設計）。
function firstArticlePath() {
  const blogDir = path.join(__dirname, "dist", "blog");
  if (!fs.existsSync(blogDir)) return [];
  const slug = fs
    .readdirSync(blogDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !["page", "category"].includes(d.name))
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(blogDir, name, "index.html")))
    .sort()[0];
  return slug ? [`/blog/${slug}/`] : [];
}

module.exports = {
  ci: {
    collect: {
      // dist/ を配信するだけ。ビルドは npm script 側 (pnpm lh) で先に済ませる。
      // Astro 7.3 の preview は AI エージェントの環境を検出すると自動でバックグラウンドに回り、
      // ロック（.astro/preview.json）で 1 プロジェクト 1 つに制限する。LHCI が止められる前景で起動し、
      // a11y の検査（4323）と同時に動けるよう、検出を飛ばしてロックも読み書きしない。
      startServerCommand: `ASTRO_PREVIEW_BACKGROUND=1 pnpm exec astro preview --port ${PORT} --ignore-lock`,
      startServerReadyPattern: `localhost:${PORT}`,
      // トップ＋ブログ一覧＋代表記事 1 本（DD-05 の 2.6 の案 B）。
      // 記事の slug は Strapi の中身で変わるため固定せず、ビルド済みの dist/blog から 1 本選ぶ。
      // 無料相談（フォームのあるページ）も測る（2026-10-18。JIS X 8341-3 の改修の計画の検証 8）。
      url: [
        `http://localhost:${PORT}/`,
        `http://localhost:${PORT}/blog/`,
        `http://localhost:${PORT}/contact/`,
        ...firstArticlePath().map((p) => `http://localhost:${PORT}${p}`),
      ],

      // 単発計測は数値がブレるため 5 回走らせて中央値を採用する。
      // 3 回では、機械の負荷（CPU のベンチマーク値が平常の 1/5 まで落ちる）で中央値ごと崩れた（2026-10-09）。
      // 判定の計測は、ほかの build・Lighthouse・ブラウザを止めた状態で回す。
      numberOfRuns: 5,

      settings: {
        // ゲスト OS に X サーバーがないため headless 必須。
        // 付けないと Chrome が "Missing X server or $DISPLAY" で即死する。
        chromeFlags: "--headless=new",
      },
    },

    assert: {
      assertions: {
        // 本番ビルドの実測ベースラインは 0.98〜1.00（3 回計測）。
        // 十分な余裕があるため error に昇格済み。
        "categories:performance": ["error", { minScore: 0.9 }],
        "categories:accessibility": ["error", { minScore: 0.9 }],
        "categories:best-practices": ["error", { minScore: 0.9 }],
        // SEO 対策が本設定の目的なので満点を死守ラインとする。
        "categories:seo": ["error", { minScore: 1 }],
      },
    },

    upload: {
      // 既定の temporary-public-storage はレポートを外部へ公開するため使わない。
      target: "filesystem",
      outputDir: "./.lighthouse",
    },
  },
};
