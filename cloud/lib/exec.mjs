// 包むスクリプト（cloud/deploy.mjs・cloud/images/build-push.mjs・onprem/build.mjs）が使う、本物のコマンドの実行と、直接実行かどうかの判定。
// テストはここを使わず、run を偽物に差し替える。run の形は `(cmd, args, { cwd, inherit, env }) => Promise<string>`。
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { run as bufferedRun } from "../../setup/lib/core.mjs";

/**
 * 本物の run。
 *  - inherit: true（sam・docker）: 端末をそのまま引き継ぐ。sam deploy は confirm_changeset = true で変更セットを見せて人に聞くので、
 *    出力を溜めたり伏せたりする setup/lib/core.mjs の run では、質問が見えず答えられない。docker の進捗も同じ。戻り値は ""。
 *    失敗の文には、引数（パラメータの値を含みうる）を入れず、コマンド名・サブコマンド・終了コードだけを入れる
 *  - inherit なし（git）: core.mjs の run（出力を溜めて文字列で返す）
 */
export function realRun(cmd, args, { cwd, inherit = false, env = {} } = {}) {
  if (!inherit) return bufferedRun(cmd, args, { cwd, env });
  return new Promise((resolve, reject) => {
    // env: 足す環境変数（onprem/build.mjs の GIT_COMMIT）。今の環境変数に重ねる
    const child = spawn(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
    child.on("error", (e) => reject(new Error(`${cmd} を起動できない（${e.code ?? e.message}）`)));
    child.on("close", (code, signal) => {
      if (code === 0) return resolve("");
      reject(Object.assign(new Error(`${cmd} ${args[0]} が失敗した（${signal ? `シグナル ${signal}` : `終了コード ${code}`}）`), { exitCode: code }));
    });
  });
}

/** このモジュール（import.meta.url）が `node <ファイル>` で直接実行されたか。import されたときは false */
export function isDirectRun(metaUrl) {
  return process.argv[1] !== undefined && metaUrl === pathToFileURL(process.argv[1]).href;
}
