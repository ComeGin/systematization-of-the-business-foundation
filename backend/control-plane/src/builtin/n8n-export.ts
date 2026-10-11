// 本番の n8n のワークフローを Git に書き出す（builtin n8n-export。TA-03 の 6 節、固定シート 7 節）。
// n8n の Public API で読み、揮発フィールドを除いて整形し、承認済み main の middleware/n8n/workflows/ と比べる。
// 差分があれば GitHub にブランチ・コミット・PR を作る（I-13 と同じ資格情報。API でコミットし、ローカルの Git の状態は変えない）。
// **作業ツリー（CONTROL_WORKTREE）には何も書かない。** 読むのは CONTROL_MAIN_CHECKOUT だけ。
// 反映は一方向（n8n → Git）。n8n に無いファイルも、main にあるファイルを消さない（開発だけにあるものを消さないため）。
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { BuiltinHandler, RunResult } from "../context.js";
import type { FailureClass } from "../contract.js";
import { N8N_WORKFLOWS_DIR } from "../constants/paths.js";
import { type LocalWorkflowFile, assignFileNames, normalizeWorkflow } from "../definitions/n8n-workflow.js";
import { GitHubClient } from "../integrations/github.js";
import { IntegrationError } from "../integrations/http.js";
import { N8nClient } from "../integrations/n8n.js";
import { logLine } from "../log.js";
import { jstDate } from "../time.js";

const BRANCH_PREFIX = "chore/n8n-export-";

const FAILURE_CLASSES_FOR_RESULT: readonly FailureClass[] = [
  "timeout",
  "unreachable",
  "auth_failed",
  "permission_denied",
  "rate_limited",
  "truncated",
  "invalid_response",
];

function failureClassOf(error: unknown): FailureClass | null {
  return error instanceof IntegrationError && FAILURE_CLASSES_FOR_RESULT.includes(error.failureClass) ? error.failureClass : null;
}

/** 承認済み main の workflows/*.json（ファイル名・name・本文）。壊れたファイルは対応づけに使わない。 */
async function readMainWorkflows(mainCheckout: string): Promise<Map<string, { name: string; text: string }>> {
  const dir = join(mainCheckout, N8N_WORKFLOWS_DIR);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const files = new Map<string, { name: string; text: string }>();
  for (const fileName of names) {
    const text = await readFile(join(dir, fileName), "utf8");
    try {
      const parsed = JSON.parse(text) as { name?: unknown };
      if (typeof parsed.name === "string") files.set(fileName, { name: parsed.name.normalize("NFC"), text });
    } catch {
      logLine("WARN", "n8n-export", `${fileName} を JSON として読めない（対応づけに使わない）`);
    }
  }
  return files;
}

function pullRequestBody(date: string, added: string[], changed: string[], excluded: number): string {
  const list = (names: string[]) => (names.length > 0 ? names.map((name) => `  - \`${name}\``).join("\n") : "  - なし");
  return [
    `本番の n8n のワークフローの書き出し（${date}。監視アプリの \`n8n-export\` が作成）。`,
    "",
    `- 変更: ${changed.length} 件`,
    list(changed),
    `- 追加: ${added.length} 件`,
    list(added),
    ...(excluded > 0 ? ["", `秘密値の疑いのある ${excluded} 件のワークフローは、この PR に含めていません（監視アプリの実行記録を確認してください）。`] : []),
    "",
    "- 除去したもの: `id`・`versionId`・`updatedAt` などの揮発フィールド、`pinData`・`staticData`。資格情報は ID の参照だけ残る（値は API が返さない）。",
    "- 反映の方向は n8n → Git の一方向です。この PR をマージしても n8n は変わりません。",
    "- n8n に無い・名前が変わったワークフローの旧ファイルは消していません（必要なら人が消す）。",
  ].join("\n");
}

export const n8nExport: BuiltinHandler = async ({ ctx, signal }): Promise<RunResult> => {
  const n8nConfig = ctx.config.n8nExport;
  const githubConfig = ctx.config.github;
  if (!n8nConfig) throw new Error("n8n の設定が無い");
  if (!githubConfig) throw new Error("GitHub の設定が無い");
  const n8n = new N8nClient(n8nConfig, signal);

  // 1. 取得（一覧 → 本体）。アーカイブ済みは削除と同じ扱いで対象外
  let summaries;
  try {
    summaries = (await n8n.listWorkflows()).filter((workflow) => !workflow.isArchived);
  } catch (error) {
    const failureClass = failureClassOf(error);
    logLine("ERROR", "n8n-export", `一覧の取得に失敗: ${error instanceof Error ? error.message : "不明"}`);
    return { outcome: "failure", summary: "n8n-export: n8n のワークフローの一覧を取得できなかった", targetIds: [], failureClass };
  }
  if (summaries.length === 0) {
    return { outcome: "success", summary: "n8n-export: n8n にワークフローが無いため何もしない", targetIds: [] };
  }

  const failed: { name: string; failureClass: FailureClass | null }[] = [];
  const suspected: string[] = [];
  const exported: { id: string; name: string; text: string }[] = [];
  for (const summary of summaries) {
    if (signal.aborted) break;
    try {
      const normalized = normalizeWorkflow(await n8n.getWorkflow(summary.id));
      if (normalized.suspectedSecret) {
        suspected.push(normalized.name);
        continue;
      }
      exported.push({ id: summary.id, name: normalized.name, text: normalized.text });
    } catch (error) {
      failed.push({ name: summary.name, failureClass: failureClassOf(error) });
      logLine("ERROR", "n8n-export", `ワークフロー ${summary.id} の取得・整形に失敗: ${error instanceof Error ? error.message : "不明"}`);
      // 401・403 は他の取得でも同じ結果になる。再試行せず止める
      if (error instanceof IntegrationError && (error.failureClass === "auth_failed" || error.failureClass === "permission_denied")) break;
    }
  }
  if (signal.aborted) {
    return { outcome: "failure", summary: "n8n-export: 打ち切られた", targetIds: [], failureClass: "timeout" };
  }
  const suspectNote = suspected.length > 0 ? `。${suspected.map((name) => `${name}: 秘密値の疑い`).join("、")}（PR から外した）` : "";
  const failureNote = failed.length > 0 ? `、取得に失敗 ${failed.length} 件` : "";
  const degraded = failed.length > 0 || suspected.length > 0;
  if (failed.length > 0 && exported.length === 0) {
    return {
      outcome: "failure",
      summary: `n8n-export: ワークフローを 1 件も取得できなかった${failureNote}${suspectNote}`,
      targetIds: [],
      failureClass: failed[0]!.failureClass,
    };
  }

  // 2. 承認済み main との比較（バイト単位）
  const main = await readMainWorkflows(ctx.config.mainCheckout);
  const fileNames = assignFileNames(
    exported,
    [...main].map(([fileName, file]): LocalWorkflowFile => ({ fileName, name: file.name })),
  );
  let candidates: { path: string; fileName: string; text: string; isNew: boolean }[] = [];
  for (const workflow of exported) {
    const fileName = fileNames.get(workflow.id)!;
    const current = main.get(fileName);
    if (current?.text === workflow.text) continue;
    candidates.push({ path: `${N8N_WORKFLOWS_DIR}/${fileName}`, fileName, text: workflow.text, isNew: current === undefined });
  }
  candidates.sort((a, b) => a.fileName.localeCompare(b.fileName));
  const result = (outcomeSummary: string, targetIds: string[] = []): RunResult => ({
    outcome: degraded ? "partial" : "success",
    summary: `n8n-export: ${outcomeSummary}${failureNote}${suspectNote}`,
    targetIds,
    failureClass: failed[0]?.failureClass ?? null,
  });
  if (candidates.length === 0) return result(`差分なし（${exported.length} 件を確認）`);

  // 3. GitHub（冪等キーは日付）
  const github = new GitHubClient(githubConfig, signal);
  const date = jstDate();
  const branch = `${BRANCH_PREFIX}${date.replaceAll("-", "")}`;
  try {
    const todays = await github.findPullRequest(branch);
    if (todays !== null) return result(`起票済み（PR #${todays}）`, [`PR #${todays}`]);
    // 毎日 PR が積み上がらないよう、未マージの書き出しの PR があれば新しく作らない
    const open = await github.listOpenPullRequests(BRANCH_PREFIX);
    if (open.length > 0) return result(`未マージの書き出しの PR があるため見送った（PR #${open[0]!.number}）`, [`PR #${open[0]!.number}`]);

    // 承認済み main のチェックアウトが origin より遅れていても、マージ済みの内容で二重に PR を作らない
    const baseTexts = await Promise.all(candidates.map((file) => github.getFileText(file.path, githubConfig.baseBranch)));
    candidates = candidates.filter((file, index) => baseTexts[index] !== file.text);
    if (candidates.length === 0) return result(`差分なし（${exported.length} 件を確認。base には反映済み）`);

    const baseSha = await github.branchSha(githubConfig.baseBranch);
    if (!baseSha) throw new IntegrationError("invalid_response", "base ブランチが見つからない");
    const added = candidates.filter((file) => file.isNew).map((file) => file.fileName);
    const changed = candidates.filter((file) => !file.isNew).map((file) => file.fileName);
    await github.commitFilesToNewBranch({
      branch,
      baseSha,
      files: candidates.map((file) => ({ path: file.path, content: file.text })),
      message: `chore: n8n ワークフローの書き出し ${date}（変更 ${changed.length} 件・追加 ${added.length} 件）`,
    });
    // ブランチがあって PR が無いのは、前回の途中で止まった続き。PR だけ作る
    const pullNumber = await github.createPullRequest({
      title: `chore: n8n ワークフローの書き出し ${date}`,
      head: branch,
      body: pullRequestBody(date, added, changed, suspected.length),
    });
    if (!(await github.requestReviewer(pullNumber, githubConfig.reviewer))) {
      logLine("WARN", "n8n-export", `Reviewer を指定できなかった（PR #${pullNumber} は作成済み）`);
    }
    return result(`PR #${pullNumber} を作成（変更 ${changed.length} 件・追加 ${added.length} 件）`, [`PR #${pullNumber}`]);
  } catch (error) {
    logLine("ERROR", "n8n-export", `GitHub への起票に失敗: ${error instanceof Error ? error.message : "不明"}`);
    return {
      outcome: "failure",
      summary: `n8n-export: 差分 ${candidates.length} 件を GitHub に起票できなかった${failureNote}${suspectNote}`,
      targetIds: [],
      failureClass: failureClassOf(error),
    };
  }
};
