// @ts-check
import { defineConfig } from "astro/config";
import { loadEnv } from "vite";

import react from "@astrojs/react";
import markdoc from "@astrojs/markdoc";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";

import tailwindcss from "@tailwindcss/vite";

import { comeginStrapiGuard } from "./src/modules/blog/integration.ts";
import { comeginFontSubset } from "./src/modules/brand/integration.ts";
import { comeginThreeGlobeWebgpuStub } from "./src/modules/motion/vite-plugin.ts";

// .env は設定ファイル内では自動ロードされないため、Vite の loadEnv で明示的に読み込む。
// https://docs.astro.build/en/guides/environment-variables/#in-the-astro-config-file
const { SITE_URL } = loadEnv(
  process.env.NODE_ENV ?? "development",
  process.cwd(),
  "",
);

// SITE_URL 未設定のままビルドすると sitemap.xml と canonical に localhost が焼き込まれ、
// 警告も出ないまま公開されてしまう。ビルド時のみ停止させる。
const isBuild = process.argv.includes("build");
if (isBuild && !SITE_URL) {
  throw new Error(
    "SITE_URL が未設定です。.env に SITE_URL=https://example.com を設定するか、SITE_URL=... astro build のように渡してください。",
  );
}

// https://astro.build/config
export default defineConfig({
  site: SITE_URL || "http://localhost:4321",

  integrations: [
    react(),
    markdoc(),
    mdx(),
    sitemap({
      // noindex の画面（01-content-spec.md §1.1）を sitemap に載せない。
      // noindex なのに sitemap にあると、Search Console が矛盾として警告する。
      filter: (page) =>
        !/\/(contact\/thanks|404)\/?$/.test(new URL(page).pathname),
    }),
    // Strapi の画像の取り込み元の許可と、dist/ に Strapi・S3 の URL が残ったらビルドを止める検査
    // （DD-05 の 1 節・ADR-11）。中身は src/modules/blog/integration.ts。
    comeginStrapiGuard(),
    // ビルド時に、dist で使っている字だけの Noto Sans JP（400・500・700 を各 1 ファイル）を作り、
    // @fontsource の分割フォントと差し替える（Q3 の performance 対策。ユーザー判断で P-5 を変更）。
    // dev では何もしない。中身は src/modules/brand/integration.ts。
    comeginFontSubset(),
  ],

  vite: {
    // three-globe が使わない three/webgpu・three/tsl をビルドから外す（地球儀のチャンクを小さく保つ。中身は src/modules/motion/vite-plugin.ts）
    plugins: [tailwindcss(), comeginThreeGlobeWebgpuStub()],

    // dev サーバーで island が使う依存を、起動時にまとめて事前最適化しておく。
    // 途中で新しい依存が見つかると Vite が最適化をやり直し、古いハッシュを参照した
    // モジュールが 504（Outdated Optimize Dep）になって island が水和しなくなるため。
    // island で新しい依存を import したら、ここにも足す。build には影響しない。
    optimizeDeps: {
      include: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "cn",
        "class-variance-authority",
        "lucide-react",
        "posthog-js",
        "@base-ui/react/button",
        "@base-ui/react/checkbox",
        "@base-ui/react/dialog",
        "@base-ui/react/input",
        "@base-ui/react/merge-props",
        "@base-ui/react/radio",
        "@base-ui/react/radio-group",
        "@base-ui/react/select",
        "@base-ui/react/separator",
        "@base-ui/react/use-render",
        // React Bits のモーフィング（src/modules/motion/vendor/react-bits）
        "motion/react",
        "ogl",
        "gsap",
        // Aceternity の原本・アバター（src/modules/motion/vendor/aceternity、src/modules/avatar）。three は 1 つの版で共有する
        "three",
        "three-globe",
        "@react-three/fiber",
        "@pixiv/three-vrm",
        "three/examples/jsm/loaders/GLTFLoader.js",
      ],
    },

    server: {
      // Vite は DNS リバインディング対策として Host ヘッダーを照合するため、
      // ngrok 経由のドメインは明示的に許可しないとブロックされる。
      // ドメインは ~/.config/ngrok/ngrok.yml の astro エンドポイント（-> 4321）と対応。
      allowedHosts: ["comegin-astro-dev.ngrok.app"],
    },
  },
});
