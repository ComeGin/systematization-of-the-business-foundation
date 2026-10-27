// 親スクリプト（setup.mjs・frontend.mjs）の共通部分。引数の解釈・モジュールの読み込み・実行の順番・止まったときの案内。
// 親スクリプトは、呼ぶモジュールの一覧（const MODULES = [...]）を持って runSetup を呼ぶだけにする
// （setup/tests は親スクリプトのソースから MODULES の配列を読み取るので、配列は親スクリプトの側に置く）。
//
// 設定（~/.config/comegin/setup/<target>.conf）と状態（<target>.state.json）は親スクリプトの間で共通。
// バックエンドで作った値（トークン・ID）を、フロントエンドのモジュールがそのまま読む。
//
// 本番（--target prod）は段階の順に進める（PROD_PHASES）。モジュールは meta.phases で自分の段階を宣言し、
// 段階の順 → MODULES の順に並べて実行する（2 つの段階を持つモジュールは、それぞれの段階で 1 回ずつ呼ぶ）。

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ManualStepRequired, State, W, createContext, loadConfig, mask } from "./core.mjs";

// 本番の段階（ユーザーの決定。2026-10-27）。ECR のリポジトリは sam deploy が作るので、イメージのプッシュはデプロイの後。
// google は公開サイトが Route 53 から配信された後に --phase google で明示したときだけ動く（--phase を付けないと env〜apps まで）
export const PROD_PHASES = [
  { id: "env", title: "本番用の環境変数の設定" },
  { id: "deploy", title: "sam build → sam deploy（1 回目。ECR・Lambda・データストアができる。サービスは 0 台）" },
  { id: "images", title: "イメージのビルドと ECR へのプッシュ（タグを変えたら sam deploy をもう 1 回）" },
  { id: "apps", title: "本番のアプリの設定" },
  { id: "google", title: "GA4・OpenSEO（公開サイトが Route 53 から配信された後）" },
];
const DEFAULT_PHASES = PROD_PHASES.filter((p) => p.id !== "google").map((p) => p.id);

function helpText(title, script) {
  return `${title}

使い方:
  node ${script} --target <dev|prod> [--phase <段階>] [--check] [--only <id,...>] [--from <id>] [--list] [--show <KEY>] [--config <path>]

  --target  dev（オンプレの開発環境）か prod（本番。画面の操作と AWS への書き込み〈デプロイ・プッシュ〉は案内して止まる）
  --phase   prod だけ。その段階だけを実行する。段階は次の順（省略すると env から apps までを順に進める）:
${PROD_PHASES.map((p, i) => `              ${i + 1}. ${p.id.padEnd(7)} ${p.title}`).join("\n")}
            google は公開サイトが Route 53 から配信された後に --phase google で行う
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
  const a = { target: null, phase: null, check: false, only: null, from: null, list: false, show: null, config: null, help: false };
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
    else if (v === "--phase") a.phase = value(v, ++i);
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
    const applies = mod.meta.targets.includes(target);
    // prod で動くモジュールは段階を宣言する（宣言が無いと、どの順で呼ぶかが決まらない）
    if (target === "prod" && applies) {
      const phases = mod.meta.phases ?? [];
      const unknown = phases.filter((p) => !PROD_PHASES.some((x) => x.id === p));
      if (!phases.length || unknown.length) throw new Error(`${rel} の meta.phases が無いか、知らない段階がある（${PROD_PHASES.map((p) => p.id).join("・")} から選ぶ）`);
    }
    loaded.push({ rel, mod, applies });
  }
  return loaded;
}

/** 実行する（モジュール, 段階）の並び。prod は段階の順 → MODULES の順。dev は MODULES の順で、段階は null */
function plan(available, target, phaseIds) {
  if (target !== "prod") return available.map((m) => ({ mod: m.mod, phase: null }));
  return phaseIds.flatMap((p) => available.filter((m) => m.mod.meta.phases.includes(p)).map((m) => ({ mod: m.mod, phase: p })));
}

const phaseTitle = (id) => {
  const i = PROD_PHASES.findIndex((p) => p.id === id);
  return `段階 ${i + 1}. ${PROD_PHASES[i].title}（--phase ${id}）`;
};

async function main({ title, script, modules: moduleList }) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(helpText(title, script));
  if (args.target !== "dev" && args.target !== "prod") throw new Error("--target dev か --target prod を指定する（--help を参照）");
  if (args.phase && args.target !== "prod") throw new Error("--phase は --target prod だけで使う（dev には段階が無い）");
  if (args.phase && !PROD_PHASES.some((p) => p.id === args.phase)) throw new Error(`--phase の ${args.phase} は無い段階（${PROD_PHASES.map((p) => p.id).join("・")}）`);
  // 案内に出す再実行のコマンドの共通部分（--phase を付けて実行したなら、付けたまま案内する）
  const base = `node ${script} --target ${args.target}${args.phase ? ` --phase ${args.phase}` : ""}`;

  const state = new State(args.target);
  if (args.show) {
    if (!state.has(args.show)) throw new Error(`${args.show} は状態ファイルに無い（${state.file}）`);
    return console.log(state.get(args.show));
  }

  const { file: confFile, conf } = loadConfig(args.target, args.config);
  const modules = await loadModules(moduleList, args.target);
  const available = modules.filter((m) => !m.missing && m.applies);

  if (args.list) {
    if (args.target === "prod") {
      for (const p of PROD_PHASES) {
        console.log(`  ${phaseTitle(p.id)}`);
        for (const { mod } of plan(available, "prod", [p.id])) console.log(`    ○  ${mod.meta.id.padEnd(16)} ${mod.meta.title}`);
      }
      const others = modules.filter((m) => m.missing || !m.applies);
      for (const m of others) console.log(m.missing ? `  -  （未実装）${m.rel}` : `  ×  ${m.mod.meta.id.padEnd(16)} ${m.mod.meta.title}（prod では動かない）`);
      return;
    }
    for (const m of modules) {
      if (m.missing) console.log(`  -  （未実装）${m.rel}`);
      else console.log(`  ${m.applies ? "○" : "×"}  ${m.mod.meta.id.padEnd(16)} ${m.mod.meta.title}${m.applies ? "" : `（${args.target} では動かない）`}`);
    }
    return;
  }

  const phaseIds = args.phase ? [args.phase] : DEFAULT_PHASES;
  const phaseNote = args.target === "prod" ? `（段階: ${phaseIds.join("→")}）` : "";
  console.log(`対象: ${args.target}${phaseNote}／設定: ${existsSync(confFile) ? confFile : `${confFile}（まだ無い。setup.conf.example を参照）`}／状態: ${state.file}`);

  let runs = plan(available, args.target, phaseIds);
  if (args.only) {
    // --from と同じく、無い id（打ち間違い・この target や段階では動かないもの）は、何も実行せずに止める
    const unknown = args.only.filter((id) => !runs.some((r) => r.mod.meta.id === id));
    if (unknown.length) {
      // ほかの段階にあるなら、その段階を案内する（例: --only ga4 は --phase google）
      const elsewhere = unknown.map((id) => available.find((m) => m.mod.meta.id === id)).filter(Boolean);
      const hint = elsewhere.length ? `。${elsewhere.map((m) => `${m.mod.meta.id} は --phase ${m.mod.meta.phases.join(" か --phase ")}`).join("、")}` : "";
      throw new Error(`--only の ${unknown.join(", ")} が見つからない（--list を参照${hint}）`);
    }
    runs = runs.filter((r) => args.only.includes(r.mod.meta.id));
  }
  if (args.from) {
    const idx = runs.findIndex((r) => r.mod.meta.id === args.from);
    if (idx < 0) throw new Error(`--from の ${args.from} が見つからない（--list を参照）`);
    runs = runs.slice(idx);
  }
  const missing = modules.filter((m) => m.missing);
  if (missing.length) console.log(`（未実装のモジュール: ${missing.map((m) => m.rel).join(", ")}）`);

  let currentPhase = null;
  for (const { mod, phase } of runs) {
    if (phase && phase !== currentPhase) {
      console.log(`\n━━ ${phaseTitle(phase)}`);
      currentPhase = phase;
    }
    const ctx = createContext({ target: args.target, conf, state, moduleId: mod.meta.id, phase });
    console.log(`\n■ ${mod.meta.title}（${mod.meta.id}${phase && mod.meta.phases.length > 1 ? `・${phase}` : ""}）`);
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
  if (args.check) return;
  console.log("\n✓ すべて終わった。作った管理者のパスワードなどは `--show <KEY>` で見る（README の「作られる値」）");
  if (args.target !== "prod") return;
  const next = args.phase ? PROD_PHASES[PROD_PHASES.findIndex((p) => p.id === args.phase) + 1] : PROD_PHASES.find((p) => p.id === "google");
  if (next?.id === "google") console.log(`  公開サイトを配信し（cloud/README.md の 4.14）、Route 53 で届くようになったら: node ${script} --target prod --phase google`);
  else if (next) console.log(`  次の段階: node ${script} --target prod --phase ${next.id}（${next.title}）`);
}

/** 親スクリプトの入口。title はヘルプの 1 行目、script は案内に出すパス（リポジトリのルートからの相対）、modules は W からの相対パスの配列 */
export function runSetup(options) {
  main(options).catch((e) => {
    console.error(mask(`\n✗ ${e.message}`));
    process.exit(1);
  });
}
