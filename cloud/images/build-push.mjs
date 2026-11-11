#!/usr/bin/env node
// 派生イメージ（cloud/images/<製品>）の docker build と push の包み。生の docker build・push のかわりに、人がこれを実行する。
// イメージが作られたときのコミットを、ラベルと ECR の追加のタグに記録するため（監視アプリの「ビルド・デプロイの必要性」が読む）。
//
// 使い方:
//   aws ecr get-login-password --region ap-northeast-1 | docker login --username AWS --password-stdin <アカウント>.dkr.ecr.ap-northeast-1.amazonaws.com
//   node cloud/images/build-push.mjs <chatwoot|mautic>
// ECR へのログインは人が先に行う（このスクリプトは案内するだけ）。アカウント ID は aws sts get-caller-identity から取る。
//
// 手順（この順）:
//   1. cloud/images/<製品> に未コミットの変更があれば止める
//   2. タグを、デプロイ設定ファイルの ChatwootImageTag・MauticImageTag から読む
//   3. 2 つのタグを付けて docker build する:
//        <ecr>/comegin/prod/<製品>:<タグ>                  本来のタグ（スタックのパラメータが指す）
//        <ecr>/comegin/prod/<製品>:<タグ>-rev-<40 桁>      記録のタグ（作ったコミット）
//      ラベル org.opencontainers.image.revision にも同じコミットを入れる
//   4. 2 つとも push する（本来のタグが先）。2 つ目（記録のタグ）だけが失敗したら、打ち直すコマンド `docker push <記録のタグ>` を出して止める
//      （本来のタグは既に ECR にあり上書きできないので、スクリプトの再実行では直らない）
//
// タグを変えるときの順番: デプロイ設定ファイルにタグを書く → このスクリプトで push → node cloud/deploy.mjs。デプロイが先だと、
// 動いているサービスが ECR に無いタグのタスクを起動できず、サーキットブレーカーでスタックごと戻される（cloud/README.md の 4.7・4.12）。
//
// 記録のタグの形（<本来のタグ>-rev-<コミット>）の理由: ECR のリポジトリは ImageTagMutability: IMMUTABLE（cloud/stacks/ecr.yaml）。
//   既存のタグへの push は ImageTagAlreadyExistsException で拒否されるが、新しい名前のタグを足すのは拒否されない
//   （https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-tag-mutability.html）。
//   rev-<コミット> だけだと、同じコミットで本来のタグだけを上げて作り直したときに rev-<コミット> が既にあって push が失敗する。
//   本来のタグを含めると、(タグ, コミット) ごとに名前が一意になる。docker のタグは 128 文字までなので、超えるなら止める。
//
// sam deploy 側の記録（DeployedCommit）は cloud/deploy.mjs。docker は端末を引き継いで動かす（進捗を見せるため）。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { headCommit, uncommittedPaths } from "../../setup/lib/drift.mjs";
import { ENV_NAME, REGION } from "../setup/aws.mjs";
import { isDirectRun, realRun } from "../lib/exec.mjs";
import { PRODUCTS, readUpstream } from "../lib/images.mjs";
import { overrideValue, parameterOverrides } from "../lib/samconfig.mjs";

/** スタックのパラメータ名（cloud/template.yaml）。cloud/setup/index.mjs の IMAGES の param と同じ */
const TAG_PARAMS = { chatwoot: "ChatwootImageTag", mautic: "MauticImageTag" };
const MAX_TAG = 128; // docker のタグの上限

/** 記録のタグ。`<本来のタグ>-rev-<40 桁のコミット>`。128 文字を超えるなら例外 */
export function recordTag(tag, sha) {
  const recorded = `${tag}-rev-${sha}`;
  if (recorded.length > MAX_TAG) throw new Error(`記録のタグが ${MAX_TAG} 文字を超える（${recorded.length} 文字）。本来のタグを短くする`);
  return recorded;
}

/**
 * 包みの中心。product: chatwoot か mautic。repoDir: リポジトリのルート。account: ECR のアカウント ID（12 桁）。
 * run: `(cmd, args, { cwd, inherit }) => Promise<string>`。readSamconfig: デプロイ設定ファイルの文字列を返す関数。log: 画面への出力
 */
export async function runBuildPush({ product, repoDir, run, readSamconfig, account, log = console.log }) {
  if (!PRODUCTS.includes(product)) throw new Error(`製品は ${PRODUCTS.join("・")} のどちらか（${product}）`);
  if (!/^\d{12}$/.test(account ?? "")) throw new Error("AWS のアカウント ID が 12 桁の数字でない");
  const dir = `cloud/images/${product}`;

  const dirty = await uncommittedPaths(repoDir, [dir], run);
  if (dirty.length > 0) {
    throw new Error(`未コミットの変更がある。コミットしてから実行する（HEAD の名前で記録するため）:\n${dirty.join("\n")}`);
  }

  const param = TAG_PARAMS[product];
  const tag = overrideValue(parameterOverrides(readSamconfig(), "default"), param);
  if (!tag) throw new Error(`デプロイ設定ファイルの [default.deploy.parameters] に ${param} が無い`);
  const sha = await headCommit(repoDir, run);
  const revTag = recordTag(tag, sha);
  const upstream = readUpstream(product);

  const repo = `${account}.dkr.ecr.${REGION}.amazonaws.com/comegin/${ENV_NAME}/${product}`;
  const base = `${repo}:${tag}`;
  const rev = `${repo}:${revTag}`;
  log(`${product}: コミット ${sha.slice(0, 7)}、タグ ${tag}（記録のタグ -rev-${sha.slice(0, 7)}…）`);

  await run(
    "docker",
    [
      "build",
      "--platform",
      "linux/amd64",
      "--label",
      `org.opencontainers.image.revision=${sha}`,
      "--build-arg",
      `UPSTREAM_TAG=${upstream.tag}`,
      "--build-arg",
      `UPSTREAM_DIGEST=${upstream.digest}`,
      "-t",
      base,
      "-t",
      rev,
      dir,
    ],
    { cwd: repoDir, inherit: true },
  );
  await run("docker", ["push", base], { cwd: repoDir, inherit: true });
  try {
    await run("docker", ["push", rev], { cwd: repoDir, inherit: true });
  } catch (e) {
    // 本来のタグは ECR に入った後なので、スクリプトを実行し直しても、本来のタグの push が ImageTagAlreadyExistsException（IMMUTABLE）で
    // 拒否されることがあり、記録のタグには届かない。手元に残っている記録のタグを、そのまま push し直すのが直し方
    throw new Error(
      `${e.message}\n本来のタグ ${product}:${tag} は push 済みで、記録のタグだけが ECR に無い（このままだと設定の状況で「記録が無い」と出る）。` +
        `手元のイメージに記録のタグは付いているので、次のコマンドで打ち直す:\n  docker push ${rev}\n` +
        `このスクリプトの再実行では直らない（本来のタグは上書きできず、1 つ目の push で拒否されうる）`,
    );
  }
  log(`完了: ${product}:${tag} と ${product}:${tag}-rev-${sha.slice(0, 7)}… を push した`);
}

async function main() {
  const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const [product, ...rest] = process.argv.slice(2);
  if (!product || rest.length > 0) throw new Error(`使い方: node cloud/images/build-push.mjs <${PRODUCTS.join("|")}>`);
  // アカウント ID は読み取りだけの問い合わせ（認証が無ければここで止まる）。ECR へのログインは人が先に行う
  const account = (await realRun("aws", ["sts", "get-caller-identity", "--query", "Account", "--output", "text"], { cwd: repoDir })).trim();
  await runBuildPush({ product, repoDir, run: realRun, readSamconfig: () => readFileSync(resolve(repoDir, "cloud/samconfig.toml"), "utf8"), account });
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
