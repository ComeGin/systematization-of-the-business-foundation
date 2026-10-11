// エージェントの書き込み系ツール（Write / Edit / MultiEdit / NotebookEdit）が、作業ツリーの中でも書けない場所。
// 作業ツリーはエージェントが書ける場所だが、ここに書かれたものは「人や control-plane が後で実行する」か「実行の条件を決める」ため、
// 書けるとエージェント自身の権限を広げる経路になる（BA-05 の「エージェントが自分の実行条件を変える操作」）。
// 読み取りは別（hooks.ts の checkPathAccess）。エージェントが書くのは docs/audits・docs/proposals と、
// design-implementer の frontend/verdant-virgo/src の下だけで、これらが拒否されても困らない。
import { WEBSITE_OPERATIONS_DIR } from "./paths.js";

export const WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** 作業ツリーの直下からのパスの接頭辞（ディレクトリ）。定義・制御の領域 */
export const WRITE_DENY_PREFIXES: readonly string[] = [
  ".git",
  // GitHub Actions（push で CI が実行する）と husky（コミット時に実行する）
  ".github",
  ".husky",
  ".claude",
  `${WEBSITE_OPERATIONS_DIR}/ops`,
  `${WEBSITE_OPERATIONS_DIR}/cloud`,
];

/** どこにあっても拒否するパスの断片（ディレクトリ名） */
export const WRITE_DENY_SEGMENTS: readonly string[] = ["node_modules"];

/** パッケージの設定とスクリプト（ファイル名） */
export const WRITE_DENY_BASENAMES: ReadonlySet<string> = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package-lock.json",
  "yarn.lock",
  ".npmrc",
  ".yarnrc.yml",
  ".pnpmfile.cjs",
  "Dockerfile",
  // direnv がディレクトリに入ったときに実行する
  ".envrc",
]);

/** 実行される設定ファイル・スクリプト・compose（ファイル名のパターン） */
export const WRITE_DENY_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /rc\.(?:c|m)?js$/, reason: "executable config (*rc.js)" },
  { pattern: /\.config\.(?:c|m)?(?:js|ts)$/, reason: "executable config (*.config.*)" },
  { pattern: /^Dockerfile\./, reason: "Dockerfile" },
  { pattern: /^(?:docker-)?compose.*\.ya?ml$/, reason: "compose file" },
];

/** dev/ の下のシェルスクリプト（人が実行する） */
export const WRITE_DENY_SCRIPT_DIR = "dev";
