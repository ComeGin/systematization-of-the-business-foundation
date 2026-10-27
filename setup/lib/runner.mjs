// 親スクリプト（setup.mjs・frontend.mjs）の共通部分。引数の解釈・モジュールの読み込み・実行の順番・止まったときの案内。
// 親スクリプトは、呼ぶモジュールの一覧（const MODULES = [...]）を持って runSetup を呼ぶだけにする
// （setup/tests は親スクリプトのソースから MODULES の配列を読み取るので、配列は親スクリプトの側に置く）。
//
// 設定（~/.config/comegin/setup/<target>.conf）と状態（<target>.state.json）は親スクリプトの間で共通。
// バックエンドで作った値（トークン・ID）を、フロントエンドのモジュールがそのまま読む。

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ManualStepRequired, State, W, createContext, loadConfig, mask } from "./core.mjs";

function helpText(title, script) {
  return `${title}

使い方:
  node ${script} --target <dev|prod> [--before-route53] [--check] [--only <id,...>] [--from <id>] [--list] [--show <KEY>] [--config <path>]

  --target  dev（オンプレの開発環境）か prod（本番。AWS のデプロイの後。画面の操作と AWS への書き込みは案内して止まる）
  --before-route53
            prod だけ。公開サイト（Astro）がまだ Route 53 から配信されていないときに付ける。GA4 のプロパティ・OpenSEO の
            Search Console と GA4 の接続・公開サイトの測定 ID と Search Console の所有権を飛ばす（配信の後に付けずに実行し直す）
  --check   何も変えずに、各モジュールの用意の状態を表示する
  --only    指定したモジュールだけを実行する（--list の id。カンマ区切り）
  --from    指定したモジュールから後ろを実行する
  --list    モジュールの一覧と順番を表示する
  --show    状態ファイルの値を 1 つ表示する（作った管理者のパスワードなど。秘密値も表示する）
  --config  設定ファイル（既定 ~/.config/comegin/setup/<target>.conf）

途中で「画面での操作が必要」と表示されたら、案内に従って操作し、同じコマンドを実行し直す（終わった手順は飛ばす）。
詳しくは setup/README.md。`;
}

function parseArgs(argv) {
  const a = { target: null, beforeRoute53: false, check: false, only: null, from: null, list: false, show: null, config: null, help: false };
  // 値を取るオプションの値。無い・空・次のオプション（-- で始まる）なら止める。
  // 値が無いまま進むと、--show・--only・--from が「指定なし」と同じになり、全モジュールの apply が走ってしまうため
  const value = (name, i) => {
    const v = argv[i]?.trim();
    if (!v || v.startsWith("-")) throw new Error(`${name} の後に値が要る（--help を参照）`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--target") a.target = argv[++i];
    else if (v === "--before-route53") a.beforeRoute53 = true;
    else if (v === "--check") a.check = true;
    else if (v === "--only") {
      a.only = value(v, ++i).split(",").map((s) => s.trim());
      if (a.only.includes("")) throw new Error(`--only の id に空のものがある: ${argv[i]}（--list を参照）`);
    } else if (v === "--from") a.from = value(v, ++i);
    else if (v === "--list") a.list = true;
    else if (v === "--show") a.show = value(v, ++i);
    else if (v === "--config") a.config = value(v, ++i);
    else if (v === "-h" || v === "--help") a.help = true;
    else throw new Error(`不明な引数: ${v}（--help を参照）`);
  }
  return a;
}

async function loadModules(modules, target) {
  const loaded = [];
  for (const rel of modules) {
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

async function main({ title, script, modules: moduleList }) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(helpText(title, script));
  if (args.target !== "dev" && args.target !== "prod") throw new Error("--target dev か --target prod を指定する（--help を参照）");
  // dev は公開サイトが AWS に無いので、Route 53 を待つ手順を最初から飛ばす。付けても意味が無いので打ち間違いとして止める
  if (args.beforeRoute53 && args.target !== "prod") throw new Error("--before-route53 は --target prod だけで使う（dev は GA4・Search Console の手順を常に飛ばす）");
  const siteRouted = args.target === "prod" && !args.beforeRoute53;
  // 案内に出す再実行のコマンドの共通部分（--before-route53 を付けて実行したなら、付けたまま案内する）
  const base = `node ${script} --target ${args.target}${args.beforeRoute53 ? " --before-route53" : ""}`;

  const state = new State(args.target);
  if (args.show) {
    if (!state.has(args.show)) throw new Error(`${args.show} は状態ファイルに無い（${state.file}）`);
    return console.log(state.get(args.show));
  }

  const { file: confFile, conf } = loadConfig(args.target, args.config);
  const modules = await loadModules(moduleList, args.target);

  if (args.list) {
    for (const m of modules) {
      if (m.missing) console.log(`  -  （未実装）${m.rel}`);
      else console.log(`  ${m.applies ? "○" : "×"}  ${m.mod.meta.id.padEnd(16)} ${m.mod.meta.title}${m.applies ? "" : `（${args.target} では動かない）`}`);
    }
    return;
  }

  const phase = args.beforeRoute53 ? "（--before-route53: 公開サイトに届くのを待つ GA4・Search Console の手順は飛ばす）" : "";
  console.log(`対象: ${args.target}${phase}／設定: ${existsSync(confFile) ? confFile : `${confFile}（まだ無い。setup.conf.example を参照）`}／状態: ${state.file}`);

  let selected = modules.filter((m) => !m.missing && m.applies);
  if (args.only) {
    // --from と同じく、無い id（打ち間違い・この target では動かないもの）は、何も実行せずに止める
    const unknown = args.only.filter((id) => !selected.some((m) => m.mod.meta.id === id));
    if (unknown.length) throw new Error(`--only の ${unknown.join(", ")} が見つからない（--list を参照）`);
    selected = selected.filter((m) => args.only.includes(m.mod.meta.id));
  }
  if (args.from) {
    const idx = selected.findIndex((m) => m.mod.meta.id === args.from);
    if (idx < 0) throw new Error(`--from の ${args.from} が見つからない（--list を参照）`);
    selected = selected.slice(idx);
  }
  const missing = modules.filter((m) => m.missing);
  if (missing.length) console.log(`（未実装のモジュール: ${missing.map((m) => m.rel).join(", ")}）`);

  for (const { mod } of selected) {
    const ctx = createContext({ target: args.target, conf, state, moduleId: mod.meta.id, siteRouted });
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
        console.log(`\n終わったら、同じコマンドを実行し直す（終わった手順は飛ばす）:\n  ${base}${args.only ? ` --only ${args.only.join(",")}` : ""}`);
        process.exit(3);
      }
      console.error(mask(`\n✗ ${mod.meta.id} で止まった: ${e.message}`));
      console.error(`  直してから、続きから実行する: ${base} --from ${mod.meta.id}`);
      process.exit(1);
    }
  }
  if (!args.check) {
    console.log("\n✓ すべて終わった。作った管理者のパスワードなどは `--show <KEY>` で見る（README の「作られる値」）");
    if (args.beforeRoute53) console.log(`  公開サイトが Route 53 から配信されたら、--before-route53 を付けずに実行し直す（飛ばした GA4・Search Console の手順を行う）: node ${script} --target prod`);
  }
}

/** 親スクリプトの入口。title はヘルプの 1 行目、script は案内に出すパス（リポジトリのルートからの相対）、modules は W からの相対パスの配列 */
export function runSetup(options) {
  main(options).catch((e) => {
    console.error(mask(`\n✗ ${e.message}`));
    process.exit(1);
  });
}
