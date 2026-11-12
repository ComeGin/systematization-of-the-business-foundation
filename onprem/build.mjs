#!/usr/bin/env node
// オンプレの本番のイメージ（Strapi・n8n）の docker compose build の包み。生の docker compose build のかわりに、人がこれを実行する。
// 監視アプリ（control-plane ＋ next-js。承認済みの main のチェックアウトで動く）のビルドの包みも兼ねる（control。2026-11-12）。
// ビルドしたときのコミットをイメージのラベル org.opencontainers.image.revision に残すため
// （compose.yml の build.labels が環境変数 GIT_COMMIT を読む。監視アプリの「設定の状況」の onprem.strapi-image・onprem.n8n-image が、
// このラベルから origin/main までの差を調べる。docs/superpowers/specs/2026-11-11-deploy-drift-detection-design.md の 4.4）。
//
// 使い方（リポジトリのどこからでもよい。docker compose はリポジトリのルートで動かす）:
//   node onprem/build.mjs strapi
//   node onprem/build.mjs n8n
//   node onprem/build.mjs <strapi|n8n> --no-cache   キャッシュを使わずにビルドし直す（RDS の CA 束を更新したとき。cloud/README.md の 4.7）
//   node <チェックアウト>/onprem/build.mjs control   監視アプリ。**承認済みの main のチェックアウトにあるこのファイルを実行する**
//                                                   （このファイルの場所のリポジトリをビルドする。作業ツリーのものを実行すると作業ツリーをビルドしてしまう）
//
// control の手順（この順）:
//   1. backend/control-plane・frontend/next-js に未コミットの変更があれば止める（HEAD の名前で記録するため）
//   2. HEAD の 40 桁のコミットを取る。origin/main の履歴に無ければ警告だけ出す
//   3. backend/control-plane → frontend/next-js の順に pnpm install --frozen-lockfile && pnpm build
//      （next-js は control-plane の dist を取り込むので、この順。lockfile は書き換えない）
//   4. ビルドしたコミットを frontend/next-js/.next/comegin-build.json に書く。設定の状況の next-js-prod.build が、ここから origin/main までに
//      backend/control-plane・frontend/next-js（*.md・テスト類・frontend/next-js/setup を除く）を変えたコミットがあるかを調べる。
//      next build は .next/ を作り直すので、包まずに pnpm build すると記録が消えて「記録が無い」になる（生の docker compose build と同じ）
//   5. 再起動の案内を出す（sudo systemctl restart comegin-control）。動いている監視アプリは、起動したときのビルドを使い続ける
//
// 手順（この順）:
//   1. 関係するパスに未コミットの変更があれば止める（Strapi は backend/strapi-system・onprem/strapi、n8n は onprem/n8n）。
//      未コミットの変更を含んだイメージを、HEAD のコミットの名前で記録してしまうと、記録が嘘になるため（cloud/deploy.mjs と同じ）
//   2. HEAD の 40 桁のコミットを取る。HEAD が origin/main の履歴に無ければ、止めずに警告だけ出す（設定の状況で ! になる）
//   3. GIT_COMMIT=<HEAD> を環境変数に入れて docker compose -f onprem/<名前>/compose.yml build <サービス>
//      （compose は、-f のファイルのあるディレクトリを基準に、そこの環境変数ファイルを読む。cd は要らない）
//   4. 再起動の案内を出す（sudo systemctl restart comegin-<名前>）。ビルドしただけでは動いているコンテナは入れ替わらない
//
// docker は端末を引き継いで動かす（進捗を見せるため）。環境変数ファイルの中身は読まない。
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun, realRun } from "../cloud/lib/exec.mjs";
import { headCommit, outsideMainWarning, uncommittedPaths } from "../setup/lib/drift.mjs";

/** ビルドする対象。paths: 未コミットを確かめるパス。service: compose のサービス（build: を持つもの）。unit: 常駐の systemd のユニット */
export const TARGETS = {
  strapi: { paths: ["backend/strapi-system", "onprem/strapi"], service: "strapi", unit: "comegin-strapi" },
  n8n: { paths: ["onprem/n8n"], service: "n8n", unit: "comegin-n8n" },
};

/** 監視アプリ（control）。dirs はビルドする順。record はビルドしたコミットの記録（リポジトリのルートからの相対） */
export const CONTROL = {
  dirs: ["backend/control-plane", "frontend/next-js"],
  record: "frontend/next-js/.next/comegin-build.json",
  unit: "comegin-control",
};

/**
 * 監視アプリのビルド。repoDir: リポジトリのルート（承認済みの main のチェックアウト）。
 * run: `(cmd, args, { cwd, inherit, env }) => Promise<string>`。write: `(path, text) => void`。log: 画面への出力
 */
export async function runControlBuild({ repoDir, run, write = (path, text) => writeFileSync(path, text), log = console.log, now = () => new Date() }) {
  const dirty = await uncommittedPaths(repoDir, CONTROL.dirs, run);
  if (dirty.length > 0) {
    throw new Error(`未コミットの変更がある。承認済みの main のチェックアウトで実行しているかを確かめる（HEAD の名前で記録するため）:\n${dirty.join("\n")}`);
  }

  const sha = await headCommit(repoDir, run);
  const outside = await outsideMainWarning(repoDir, sha, run);
  if (outside) log(outside);

  log(`監視アプリ: コミット ${sha.slice(0, 7)} でビルドする（${CONTROL.dirs.join(" → ")}）`);
  for (const dir of CONTROL.dirs) {
    const cwd = join(repoDir, dir);
    await run("pnpm", ["install", "--frozen-lockfile"], { cwd, inherit: true });
    await run("pnpm", ["build"], { cwd, inherit: true });
  }
  write(join(repoDir, CONTROL.record), `${JSON.stringify({ commit: sha, builtAt: now().toISOString() }, null, 2)}\n`);
  log(`ビルドした（記録: ${CONTROL.record}）。動いている監視アプリはまだ前のビルド。再起動する: sudo systemctl restart ${CONTROL.unit}`);
}

/**
 * 包みの中心。name: strapi か n8n。repoDir: リポジトリのルート。
 * run: `(cmd, args, { cwd, inherit, env }) => Promise<string>`。log: 画面への出力
 */
export async function runOnpremBuild({ name, repoDir, run, noCache = false, log = console.log }) {
  const target = TARGETS[name];
  if (!target) throw new Error(`名前は ${Object.keys(TARGETS).join("・")} のどちらか（${name}）`);

  const dirty = await uncommittedPaths(repoDir, target.paths, run);
  if (dirty.length > 0) {
    throw new Error(`未コミットの変更がある。コミットしてから実行する（HEAD の名前で記録するため）:\n${dirty.join("\n")}`);
  }

  const sha = await headCommit(repoDir, run);
  const outside = await outsideMainWarning(repoDir, sha, run);
  if (outside) log(outside);

  const composeFile = `onprem/${name}/compose.yml`;
  const args = ["compose", "-f", composeFile, "build", ...(noCache ? ["--no-cache"] : []), target.service];
  log(`${name}: コミット ${sha.slice(0, 7)} でビルドする（docker ${args.join(" ")}）`);
  await run("docker", args, { cwd: repoDir, inherit: true, env: { GIT_COMMIT: sha } });
  log(`ビルドした。動いているコンテナはまだ前のイメージ。再起動する: sudo systemctl restart ${target.unit}（systemd で常駐させていないときは cd onprem/${name} && docker compose up -d）`);
}

async function main() {
  const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const [name, ...rest] = process.argv.slice(2);
  if (name === "control") {
    if (rest.length > 0) throw new Error("使い方: node <チェックアウト>/onprem/build.mjs control");
    await runControlBuild({ repoDir, run: realRun });
    return;
  }
  const noCache = rest.length === 1 && rest[0] === "--no-cache";
  if (!name || (rest.length > 0 && !noCache)) throw new Error(`使い方: node onprem/build.mjs <${Object.keys(TARGETS).join("|")}> [--no-cache]（監視アプリは node <チェックアウト>/onprem/build.mjs control）`);
  await runOnpremBuild({ name, repoDir, run: realRun, noCache });
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
