#!/usr/bin/env node
// バックエンド全体の設定スクリプト（親）。各モジュールの setup/index.mjs を、依存の順に呼ぶ。
//
//   node setup/setup.mjs --target dev               # 開発環境を最初から最後まで用意する（途中で止まったら、同じコマンドで続きから）
//   node setup/setup.mjs --target dev --check       # 何も変えずに、どこまで用意できているかを表示する
//   node setup/setup.mjs --target dev --only n8n    # 指定したモジュールだけ（カンマ区切りで複数可）
//   node setup/setup.mjs --target dev --list        # モジュールの一覧と順番
//   node setup/setup.mjs --target dev --show KEY    # 状態ファイルの値を 1 つだけ表示する（作った管理者のパスワードなど）
//
// 秘密値は画面に出さない（--show で明示したときだけ）。詳しくは setup/README.md。
// 引数の解釈と実行の順番は lib/runner.mjs（フロントエンド全体の frontend.mjs と共通）。

import { runSetup } from "./lib/runner.mjs";

// 呼ぶ順番（依存の順）。モジュールを足すときはここに 1 行足す。パスは W（リポジトリのルート）からの相対
const MODULES = [
  "middleware/host-relay/setup/index.mjs",
  "backend/chatwoot-system/setup/index.mjs",
  "backend/mautic-system/dev/setup/index.mjs",
  "middleware/ga4/setup/index.mjs",
  "middleware/open-seo-main/dev/setup/index.mjs",
  "backend/strapi-system/setup/index.mjs",
  "middleware/n8n/setup/index.mjs",
  "backend/consent-api/setup/index.mjs",
  "backend/admin-auth/setup/index.mjs",
  "backend/chatwoot-mcp/setup/index.mjs",
  "backend/faq-bot/setup/index.mjs",
  "backend/mautic-mcp/setup/index.mjs",
  "backend/control-plane/setup/index.mjs",
  "frontend/next-js/setup/index.mjs",
  "onprem/setup/index.mjs",
  "backend/chatwoot-system/setup/prod/index.mjs",
  "backend/mautic-system/dev/setup/prod/index.mjs",
  "ops/setup/index.mjs",
];

runSetup({ title: "バックエンド全体の設定スクリプト", script: "setup/setup.mjs", modules: MODULES });
