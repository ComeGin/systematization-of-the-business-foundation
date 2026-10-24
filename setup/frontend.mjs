#!/usr/bin/env node
// フロントエンド全体の設定スクリプト（親）。公開サイト（Astro）と監視アプリ（Next.js）を、依存の順に用意する。
//
//   node setup/frontend.mjs --target dev               # 開発環境のフロントエンドを用意する（先に node setup/setup.mjs --target dev）
//   node setup/frontend.mjs --target dev --check       # 何も変えずに、どこまで用意できているかを表示する
//   node setup/frontend.mjs --target dev --only verdant-virgo
//   node setup/frontend.mjs --target prod              # 本番のビルド用の .env.production と Search Console の所有権（ビルド・配信はしない）
//
// 設定（~/.config/comegin/setup/<target>.conf）と状態（<target>.state.json）はバックエンド全体の setup.mjs と共通。
// 公開サイトの環境変数は、バックエンドのモジュールが状態に置いた値（Strapi のビルド用トークン・Chatwoot の website_token・
// Mautic のフォーム ID）から写すので、バックエンドを先に用意する。引数と実行の順番は lib/runner.mjs（setup.mjs と共通）。
// 詳しくは setup/README.md の「フロントエンド全体」。

import { runSetup } from "./lib/runner.mjs";

// 呼ぶ順番（依存の順）。ga4・next-js はバックエンドの setup.mjs にもある（どちらから実行しても同じ結果になる）
const MODULES = [
  "middleware/ga4/setup/index.mjs",
  "frontend/verdant-virgo/setup/index.mjs",
  "frontend/next-js/setup/index.mjs",
];

runSetup({ title: "フロントエンド全体の設定スクリプト", script: "setup/frontend.mjs", modules: MODULES });
