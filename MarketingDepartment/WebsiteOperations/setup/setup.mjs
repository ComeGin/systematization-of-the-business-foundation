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

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ManualStepRequired, State, W, createContext, loadConfig, mask } from "./lib/core.mjs";

// 呼ぶ順番（依存の順）。モジュールを足すときはここに 1 行足す。パスは W（MarketingDepartment/WebsiteOperations）からの相対
const MODULES = [
  "middleware/host-relay/setup/index.mjs",
  "backend/chatwoot-system/setup/index.mjs",
  "backend/mautic-system/dev/setup/index.mjs",
  "middleware/umami/setup/index.mjs",
  "middleware/open-seo-main/dev/setup/index.mjs",
  "backend/strapi-system/setup/index.mjs",
  "middleware/n8n/setup/index.mjs",
  "backend/consent-api/setup/index.mjs",
  "backend/admin-auth/setup/index.mjs",
  "backend/chatwoot-mcp/setup/index.mjs",
  "backend/mautic-mcp/setup/index.mjs",
  "backend/control-plane/setup/index.mjs",
  "frontend/next-js/setup/index.mjs",
  "onprem/setup/index.mjs",
];

const HELP = `バックエンド全体の設定スクリプト

使い方:
  node setup/setup.mjs --target <dev|prod> [--check] [--only <id,...>] [--from <id>] [--list] [--show <KEY>] [--config <path>]

  --target  dev（オンプレの開発環境）か prod（本番。AWS のデプロイの後。いまは枠だけ）
  --check   何も変えずに、各モジュールの用意の状態を表示する
  --only    指定したモジュールだけを実行する（--list の id。カンマ区切り）
  --from    指定したモジュールから後ろを実行する
  --list    モジュールの一覧と順番を表示する
  --show    状態ファイルの値を 1 つ表示する（作った管理者のパスワードなど。秘密値も表示する）
  --config  設定ファイル（既定 ~/.config/comegin/setup/<target>.conf）

途中で「画面での操作が必要」と表示されたら、案内に従って操作し、同じコマンドを実行し直す（終わった手順は飛ばす）。
詳しくは setup/README.md。`;

function parseArgs(argv) {
  const a = { target: null, check: false, only: null, from: null, list: false, show: null, config: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--target") a.target = argv[++i];
    else if (v === "--check") a.check = true;
    else if (v === "--only") a.only = argv[++i]?.split(",").map((s) => s.trim());
    else if (v === "--from") a.from = argv[++i];
    else if (v === "--list") a.list = true;
    else if (v === "--show") a.show = argv[++i];
    else if (v === "--config") a.config = argv[++i];
    else if (v === "-h" || v === "--help") a.help = true;
    else throw new Error(`不明な引数: ${v}（--help を参照）`);
  }
  return a;
}

async function loadModules(target) {
  const loaded = [];
  for (const rel of MODULES) {
    const file = join(W, rel);
    if (!existsSync(file)) {
      loaded.push({ rel, missing: true });
      continue;
    }
    const mod = await import(pathToFileURL(file).href);
    if (!mod.meta?.id || typeof mod.apply !== "function" || typeof mod.check !== "function") throw new Error(`${rel} がモジュールの形（meta・check・apply）になっていない`);
    loaded.push({ rel, mod, applies: mod.meta.targets.includes(target) });
  }
  return loaded;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);
  if (args.target !== "dev" && args.target !== "prod") throw new Error("--target dev か --target prod を指定する（--help を参照）");

  const state = new State(args.target);
  if (args.show) {
    if (!state.has(args.show)) throw new Error(`${args.show} は状態ファイルに無い（${state.file}）`);
    return console.log(state.get(args.show));
  }

  const { file: confFile, conf } = loadConfig(args.target, args.config);
  const modules = await loadModules(args.target);

  if (args.list) {
    for (const m of modules) {
      if (m.missing) console.log(`  -  （未実装）${m.rel}`);
      else console.log(`  ${m.applies ? "○" : "×"}  ${m.mod.meta.id.padEnd(16)} ${m.mod.meta.title}${m.applies ? "" : `（${args.target} では動かない）`}`);
    }
    return;
  }

  console.log(`対象: ${args.target}／設定: ${existsSync(confFile) ? confFile : `${confFile}（まだ無い。setup.conf.example を参照）`}／状態: ${state.file}`);

  let selected = modules.filter((m) => !m.missing && m.applies);
  if (args.only) selected = selected.filter((m) => args.only.includes(m.mod.meta.id));
  if (args.from) {
    const idx = selected.findIndex((m) => m.mod.meta.id === args.from);
    if (idx < 0) throw new Error(`--from の ${args.from} が見つからない（--list を参照）`);
    selected = selected.slice(idx);
  }
  const missing = modules.filter((m) => m.missing);
  if (missing.length) console.log(`（未実装のモジュール: ${missing.map((m) => m.rel).join(", ")}）`);

  for (const { mod } of selected) {
    const ctx = createContext({ target: args.target, conf, state, moduleId: mod.meta.id });
    console.log(`\n■ ${mod.meta.title}（${mod.meta.id}）`);
    if (args.check) {
      try {
        const r = await mod.check(ctx);
        console.log(`  ${r.ok ? "✓ 用意できている" : "… まだ"}`);
        for (const n of r.notes ?? []) console.log(mask(`    - ${n}`));
      } catch (e) {
        console.log(mask(`  ? 確かめられない（${e.message}）`));
      }
      continue;
    }
    try {
      await mod.apply(ctx);
      console.log("  ✓ 終わった");
    } catch (e) {
      if (e instanceof ManualStepRequired) {
        console.log(`\n画面での操作が必要: ${e.message}（${e.id}）`);
        e.steps.forEach((s, i) => console.log(mask(`  ${i + 1}. ${s}`)));
        console.log(`\n終わったら、同じコマンドを実行し直す（終わった手順は飛ばす）:\n  node setup/setup.mjs --target ${args.target}${args.only ? ` --only ${args.only.join(",")}` : ""}`);
        process.exit(3);
      }
      console.error(mask(`\n✗ ${mod.meta.id} で止まった: ${e.message}`));
      console.error(`  直してから、続きから実行する: node setup/setup.mjs --target ${args.target} --from ${mod.meta.id}`);
      process.exit(1);
    }
  }
  if (!args.check) console.log("\n✓ すべて終わった。作った管理者のパスワードなどは `--show <KEY>` で見る（README の「作られる値」）");
}

main().catch((e) => {
  console.error(mask(`\n✗ ${e.message}`));
  process.exit(1);
});
