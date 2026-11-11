#!/usr/bin/env node
// sam deploy の包み。生の sam deploy のかわりに、人がこれを実行する。デプロイしたコミットをスタックのパラメータ DeployedCommit に記録するため
// （監視アプリの「ビルド・デプロイの必要性」がこの値と origin/main を比べる。docs/superpowers/specs/2026-11-11-deploy-drift-detection-design.md）。
//
// 使い方（リポジトリのどこからでもよい。sam は cloud/ で動かす）:
//   node cloud/deploy.mjs                        本番（ap-northeast-1）: sam build → sam deploy
//   node cloud/deploy.mjs --config-env global    us-east-1（CloudFront 用の ACM と WAF）: sam deploy だけ（README の 4.1）
//
// 手順（この順）:
//   1. 関係するパスに未コミットの変更があれば止める（cloud/。default のときは Lambda の 3 パッケージ backend/faq-bot・consent-api・admin-auth も）。
//      未コミットの変更を含んだものを、HEAD のコミットの名前で記録してしまうと、記録が嘘になるため
//   2. デプロイ設定ファイルの parameter_overrides を読む。DeployedCommit のほかに 1 つも読めなければ止める（下の「扱い」。
//      DeployedCommit だけを渡すと、ほかのパラメータは前の値のまま残り、設定ファイルの変更が黙って反映されない）
//   3. HEAD の 40 桁のコミットを取る。HEAD が origin/main の履歴に無ければ、止めずに警告だけ出す（設定の状況で ! になる）
//   4. default だけ sam build（Lambda を Makefile でまとめる。README の 4.2）
//   5. sam deploy [--config-env global] --parameter-overrides <デプロイ設定ファイルの値 + DeployedCommit=<HEAD>>
//      終わっても「記録した」とは言わない（変更セットを断った場合は記録されていない。設定の状況で確かめる）
//
// --parameter-overrides の扱い（確かめた出典）:
//   AWS SAM のドキュメント「AWS SAM CLI configuration file」の Configuration precedence:
//   https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-config.html
//   「コマンドラインで渡した値は、設定ファイルの対応する値より優先される」とある。ただし、parameter_overrides が 1 つのキーとして丸ごと置き換わるのか、
//   パラメータごとに合わさるのかは、このページに明記が無く、確かめられなかった。
//   そのため、置き換わる前提で書く: 設定ファイルの parameter_overrides の全要素を読み、DeployedCommit だけ差し替えて、全部をコマンドラインで渡す。
//   合わさる場合でも、同じ名前を同じ値で渡すだけなので結果は同じ（どちらでも安全）。
//
// 画面とログ: パラメータの値は秘密を含みうるので出さない。出すのはパラメータの数と短い SHA だけ。
// sam と docker は端末を引き継いで動かす（変更セットの確認〈confirm_changeset = true〉に人が答えるため）。cwd は cloud/。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { headCommit, outsideMainWarning, uncommittedPaths } from "../setup/lib/drift.mjs";
import { isDirectRun, realRun } from "./lib/exec.mjs";
import { parameterOverrides, withDeployedCommit } from "./lib/samconfig.mjs";

/** sam build が必要な Lambda のコード（cloud/stacks/services/*.yaml の CodeUri）。デプロイ（default）に含まれるので未コミットを確かめる */
const LAMBDA_PACKAGES = ["backend/faq-bot", "backend/consent-api", "backend/admin-auth"];

/**
 * 包みの中心。env: "default"（本番）か "global"。repoDir: リポジトリのルート。
 * run: `(cmd, args, { cwd, inherit }) => Promise<string>`。readSamconfig: デプロイ設定ファイルの文字列を返す関数。log: 画面への出力
 */
export async function runDeploy({ env, repoDir, run, readSamconfig, log = console.log }) {
  if (env !== "default" && env !== "global") throw new Error(`env は default か global（${env}）`);
  const paths = env === "default" ? ["cloud", ...LAMBDA_PACKAGES] : ["cloud"];

  const dirty = await uncommittedPaths(repoDir, paths, run);
  if (dirty.length > 0) {
    throw new Error(`未コミットの変更がある。コミットしてから実行する（HEAD の名前で記録するため）:\n${dirty.join("\n")}`);
  }

  // 設定ファイルから 1 つも読めない（表が無い・キーが無い・ドット区切りのキーで書いてある）まま進むと、DeployedCommit だけを渡すことになり、
  // ほかのパラメータは UsePreviousValue（前の値のまま）になって、samconfig.toml の変更が黙って反映されない。値は出さずに止める
  const table = `[${env}.deploy.parameters]`;
  const base = parameterOverrides(readSamconfig(), env).filter((item) => !item.startsWith("DeployedCommit="));
  if (base.length === 0) {
    throw new Error(
      `cloud/samconfig.toml の ${table} から parameter_overrides を 1 つも読めない（表が無い・parameter_overrides のキーが無い・` +
        `ドット区切りのキー〈deploy.parameters.parameter_overrides = …〉で書いてある、のどれか）。` +
        `このまま sam deploy すると DeployedCommit だけが渡り、ほかのパラメータは前の値のまま残る。` +
        `${table} の表に parameter_overrides = [ "Key=Value", ... ] の形で書いてから実行し直す（cloud/README.md の 4.2）`,
    );
  }

  const sha = await headCommit(repoDir, run);
  const outside = await outsideMainWarning(repoDir, sha, run);
  if (outside) log(outside);
  const overrides = withDeployedCommit(base, sha);
  const cwd = join(repoDir, "cloud");
  log(`デプロイするコミット: ${sha.slice(0, 7)}（${env === "global" ? "global" : "本番"}。パラメータ ${overrides.length} 個。値は表示しない）`);

  if (env === "default") {
    log("sam build");
    await run("sam", ["build"], { cwd, inherit: true });
  }
  log("sam deploy（変更セットの確認に答える）");
  const configEnv = env === "global" ? ["--config-env", "global"] : [];
  await run("sam", ["deploy", ...configEnv, "--parameter-overrides", ...overrides], { cwd, inherit: true });
  // sam deploy は、変更セットを断っても（confirm_changeset に n と答えても）失敗にならずに終わりうる。そのときスタックは変わらず、記録も前のまま。
  // ここでは「記録した」とは言わない
  log(
    `sam deploy が終わった（DeployedCommit=${sha.slice(0, 7)} を渡した。変更セットを断った場合は記録されていない。` +
      `記録されたかは設定の状況〈node setup/setup.mjs --target prod --phase deploy --check〉で確かめる）`,
  );
}

function parseArgs(argv) {
  if (argv.length === 0) return "default";
  if (argv.length === 2 && argv[0] === "--config-env" && argv[1] === "global") return "global";
  throw new Error("使い方: node cloud/deploy.mjs [--config-env global]");
}

async function main() {
  const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const env = parseArgs(process.argv.slice(2));
  await runDeploy({ env, repoDir, run: realRun, readSamconfig: () => readFileSync(join(repoDir, "cloud/samconfig.toml"), "utf8") });
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
