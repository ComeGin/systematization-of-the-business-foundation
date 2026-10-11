// I-13 ローカル → GitHub（起票）。DD-06 の 2 節。
// 起票するのはエージェントではなく、この決定論的な処理（GitHub のトークンをエージェントに渡さない。DD-01 の 8.2 の T2）。
// 対象は CONTROL_WORKTREE の未コミットの docs/proposals/*.md のうち approval.state が draft で PR が無いもの。
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BuiltinHandler, RunResult } from "../context.js";
import { PROPOSALS_DIR } from "../constants/paths.js";
import { type Proposal, parseProposal, setDiffRef } from "../definitions/proposal.js";
import { GitHubClient } from "../integrations/github.js";
import { IntegrationError } from "../integrations/http.js";
import { logLine } from "../log.js";

const PROPOSAL_FILE = /^PRP-\d{4}-\d{4}\.md$/;

export function proposalBranch(issueNumber: number, proposalId: string): string {
  return `${issueNumber}-feature-proposal-${proposalId}`;
}

function pullRequestBody(proposal: Proposal, path: string): string {
  // 個人情報を含まない項目だけを使う（E-13 は GitHub に越境する。DD-06 の 1.2 の検査 13）
  return [
    `改善提案 \`${proposal.proposal_id}\` の起票です（監視アプリの I-13 が作成）。`,
    "",
    `- 対象: ${proposal.target.entity} \`${proposal.target.identifier}\``,
    `- 変更の種類: \`${proposal.change.kind}\``,
    `- 期待する指標: \`${proposal.expectation.metric}\`（判定期日 ${proposal.expectation.judge_after}、判定者 ${proposal.expectation.judge_by}）`,
    `- リスク: \`${proposal.risk.level}\``,
    `- 相関 ID: \`${proposal.agent_run_id}\``,
    "",
    `提案の本文は \`${path}\` を確認してください。承認（レビュー）は R2 が行います。`,
  ].join("\n");
}

export const i13File: BuiltinHandler = async ({ ctx, signal }): Promise<RunResult> => {
  const config = ctx.config.github;
  if (!config) throw new Error("GitHub の設定が無い");
  const github = new GitHubClient(config, signal);

  const dir = join(ctx.config.worktree, PROPOSALS_DIR);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => PROPOSAL_FILE.test(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") names = [];
    else throw error;
  }

  const filed: string[] = [];
  const existing: string[] = [];
  const invalid: string[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (const name of names) {
    if (signal.aborted) break;
    const file = join(dir, name);
    const text = await readFile(file, "utf8");
    const parsed = parseProposal(text);
    const id = name.replace(/\.md$/, "");
    if (!parsed.ok) {
      invalid.push(id);
      logLine("WARN", "I-13", `${name} の frontmatter が不正のため起票しない: ${parsed.reason}`);
      continue;
    }
    const proposal = parsed.value;
    if (proposal.proposal_id !== id) {
      invalid.push(id);
      logLine("WARN", "I-13", `${name} の proposal_id がファイル名と一致しない`);
      continue;
    }
    if (proposal.approval.state !== "draft" || proposal.change.diff_ref !== null) continue;

    const path = `${PROPOSALS_DIR}/${name}`;
    const branch = proposalBranch(config.issueNumber, proposal.proposal_id);
    try {
      // 冪等キー: GitHub 上（base）に同名ファイルが既にあれば起票しない
      if (await github.fileExists(path, config.baseBranch)) {
        existing.push(id);
        continue;
      }
      let pullNumber = await github.findPullRequest(branch);
      if (pullNumber === null) {
        const baseSha = await github.branchSha(config.baseBranch);
        if (!baseSha) throw new IntegrationError("invalid_response", "base ブランチが見つからない");
        await github.createBranch(branch, baseSha);
        if (!(await github.fileExists(path, branch))) {
          await github.putFile(path, branch, text, `add: 改善提案 ${proposal.proposal_id}`);
        }
        pullNumber = await github.createPullRequest({
          title: `add: 改善提案 ${proposal.proposal_id}`,
          head: branch,
          body: pullRequestBody(proposal, path),
        });
        if (!(await github.requestReviewer(pullNumber, config.reviewer))) {
          logLine("WARN", "I-13", `${proposal.proposal_id}: Reviewer を指定できなかった（PR #${pullNumber} は作成済み）`);
        }
      }
      // PR 番号を書き戻す。ローカルの Git の状態は変えない（ファイルの 1 行だけ）
      const current = await readFile(file, "utf8");
      const updated = setDiffRef(current, `PR #${pullNumber}`);
      if (updated === null) throw new Error("diff_ref の行を書き換えられなかった");
      await writeFile(file, updated, "utf8");
      filed.push(id);
    } catch (error) {
      const reason = error instanceof IntegrationError ? error.failureClass : "internal_error";
      failed.push({ id, reason });
      logLine("ERROR", "I-13", `${id}: 起票に失敗: ${error instanceof Error ? error.message : "不明"}`);
      // 401 は再試行しない（fetchJson 側）。翌日の実行で再試行される
      if (error instanceof IntegrationError && error.failureClass === "auth_failed") break;
    }
  }

  const parts = [`起票 ${filed.length} 件`, `既存 ${existing.length} 件`, `不正 ${invalid.length} 件`, `失敗 ${failed.length} 件`];
  const targetIds = [...filed, ...existing, ...failed.map((f) => f.id)];
  if (failed.length > 0) {
    const firstClass = failed[0]!.reason;
    return {
      outcome: filed.length > 0 ? "partial" : "failure",
      summary: `I-13: ${parts.join("、")}（失敗: ${failed.map((f) => `${f.id}=${f.reason}`).join(", ")}）`,
      targetIds,
      failureClass: (
        ["timeout", "unreachable", "auth_failed", "permission_denied", "rate_limited", "truncated", "invalid_response"] as const
      ).find((c) => c === firstClass) ?? null,
    };
  }
  return {
    outcome: invalid.length > 0 && filed.length === 0 ? "partial" : "success",
    summary: filed.length + existing.length + invalid.length === 0 ? "I-13: 起票対象なし" : `I-13: ${parts.join("、")}`,
    targetIds,
  };
};
