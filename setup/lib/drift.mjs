// デプロイのずれの検知で使う git の比較（共通部品）。
// 「本番で動いているものが作られたときのコミット」から origin/main までの間に、関係するパスを変えたコミットがあるかを調べる。
// 比べ方は backend/control-plane/src/status/drift.ts の checkSiteRedeploy にそろえる（log の形式・短い SHA・件名の切り方）。
// 読み取りだけ: git は merge-base・log・rev-list・status・rev-parse だけ。origin/main を新しくするのは呼び出し側（人の fetch か監視アプリの fetchMain）。

/** 比べるパスから除く、コードでないもの（*.md・テスト類）。git のパススペック */
export const NON_CODE_EXCLUDES = [
  ":(exclude,glob)**/*.md",
  ":(exclude,glob)**/*.test.*",
  ":(exclude,glob)**/tests/**",
  ":(exclude,glob)**/integration/**",
  ":(exclude,glob)**/e2e/**",
];

const SHA = /^[0-9a-f]{40}$/;
const short = (sha) => sha.slice(0, 7);
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** `git log --format=%H%x09%cI%x09%s` の出力（新しい順）を { sha, subject }[] にする */
function parseLog(stdout) {
  const entries = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [sha, , ...subject] = line.split("\t");
    if (sha && SHA.test(sha)) entries.push({ sha, subject: subject.join("\t") });
  }
  return entries;
}

/**
 * commit が origin/main の履歴にあるか。`merge-base --is-ancestor` は、履歴に無いと終了コード 1 で終わる。
 * それ以外の失敗（チェックアウトにコミットが無い・origin/main を読めない）は、比べられないので例外のまま投げる
 */
async function isInMain(ctx, commit) {
  try {
    await ctx.run("git", ["-C", ctx.WORKTREE, "merge-base", "--is-ancestor", commit, "origin/main"]);
    return true;
  } catch (e) {
    if (e?.exitCode === 1) return false;
    throw e;
  }
}

/**
 * 記録のコミットから origin/main までに、paths（NON_CODE_EXCLUDES を除く）を変えたコミットがあるか。
 * recorded: 40 桁のコミット・null・"unrecorded"（記録が無い）。paths: リポジトリのルートからの相対パス。
 * 返り値: unrecorded（記録が無い）・outside-main（記録が origin/main の履歴に無い）・clean（変更なし）・changed（entries は新しい順）
 */
export async function commitDrift(ctx, { recorded, paths }) {
  if (recorded === null || recorded === undefined || recorded === "unrecorded") return { kind: "unrecorded" };
  if (!(await isInMain(ctx, recorded))) return { kind: "outside-main", commit: recorded };
  const out = await ctx.run("git", [
    "-C",
    ctx.WORKTREE,
    "log",
    "--format=%H%x09%cI%x09%s",
    `${recorded}..origin/main`,
    "--",
    ...paths,
    ...NON_CODE_EXCLUDES,
  ]);
  const entries = parseLog(out);
  if (entries.length === 0) return { kind: "clean", commit: recorded };
  return { kind: "changed", commit: recorded, entries };
}

/**
 * commits のうち、origin/main の履歴にある最も新しいもの（origin/main までのコミット数が最小のもの）。無ければ null。
 * 複数のイメージ・コンテナのコミットから「いちばん新しくビルドしたもの」を選ぶのに使う
 */
export async function newestInMain(ctx, commits) {
  let best = null;
  let bestCount = Infinity;
  for (const commit of commits) {
    if (!(await isInMain(ctx, commit))) continue;
    const out = await ctx.run("git", ["-C", ctx.WORKTREE, "rev-list", "--count", `${commit}..origin/main`]);
    const count = Number.parseInt(out.trim(), 10);
    if (Number.isNaN(count)) throw new Error(`git rev-list --count の出力を読めない（${short(commit)}）`);
    if (count < bestCount) {
      best = commit;
      bestCount = count;
    }
  }
  return best;
}

/** 根拠の文。例「3 件: 最初 abc1234 件名 〜 最後 def5678 件名」。entries は新しい順（最初のコミット = 末尾、最後のコミット = 先頭） */
export function describeChanges(entries) {
  if (entries.length === 0) return "0 件";
  const describe = (entry) => `${short(entry.sha)} ${clip(entry.subject, 50)}`;
  const first = entries[entries.length - 1];
  const last = entries[0];
  const range = entries.length === 1 ? describe(first) : `最初 ${describe(first)} 〜 最後 ${describe(last)}`;
  return `${entries.length} 件: ${range}`;
}

/**
 * paths に未コミットの変更（追跡しない新規ファイルも含む）があるか。`git status --porcelain` の行を返す（無ければ []）。
 * 包むスクリプト（setup の ctx の外で動く）が使うので、run は `(cmd, args) => Promise<string>` を受け取る
 */
export async function uncommittedPaths(repoDir, paths, run) {
  const out = await run("git", ["-C", repoDir, "status", "--porcelain", "--", ...paths]);
  return out.split("\n").filter((line) => line.trim() !== "");
}

/**
 * 包むスクリプトの開始時の確かめ。commit が origin/main の履歴にあるか（`merge-base --is-ancestor` の終了コード 1 なら false）。
 * それ以外の git の失敗（origin/main が無いなど）は例外のまま投げる（呼び出し側が「確かめられない」と警告する）。
 * run は uncommittedPaths と同じ `(cmd, args) => Promise<string>`
 */
export async function commitInMain(repoDir, commit, run) {
  return isInMain({ run, WORKTREE: repoDir }, commit);
}

/**
 * 包むスクリプト（cloud/deploy.mjs・onprem/build.mjs）の警告の文。HEAD が origin/main の履歴に無いときと、確かめられないときだけ文を返す（止めない）。
 * 履歴にあれば null。記録はそのまま HEAD の名前で残るので、設定の状況の項目は ! （outside-main）になる
 */
export async function outsideMainWarning(repoDir, sha, run) {
  try {
    if (await commitInMain(repoDir, sha, run)) return null;
    return `注意: HEAD（${short(sha)}）が origin/main の履歴に無い。main 以外のコミットからのビルド・デプロイになる（止めずに続ける）。設定の状況で ! になる（git fetch していないだけなら、fetch すると消える。マージ前のブランチなら、マージ後に履歴に入る）`;
  } catch (e) {
    return `注意: HEAD（${short(sha)}）が origin/main の履歴にあるかを確かめられない（${String(e?.message ?? e).split("\n")[0]}）。止めずに続ける`;
  }
}

/** repoDir の HEAD の 40 桁のコミット */
export async function headCommit(repoDir, run) {
  const out = (await run("git", ["-C", repoDir, "rev-parse", "HEAD"])).trim();
  if (!SHA.test(out)) throw new Error("git rev-parse HEAD の出力が 40 桁のコミットでない");
  return out;
}
