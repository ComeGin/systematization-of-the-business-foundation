import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i13File, proposalBranch } from "../../src/builtin/i13-file.js";
import type { BuiltinInput } from "../../src/context.js";
import { IntegrationError } from "../../src/integrations/http.js";
import { makeConfig, makeCtx, proposalText, tempDir, writeAt } from "../helpers/runner.js";

const gh = vi.hoisted(() => ({
  constructed: [] as unknown[][],
  fileExists: vi.fn(),
  findPullRequest: vi.fn(),
  branchSha: vi.fn(),
  createBranch: vi.fn(),
  putFile: vi.fn(),
  createPullRequest: vi.fn(),
  requestReviewer: vi.fn(),
}));
vi.mock("../../src/integrations/github.js", () => ({
  GitHubClient: class {
    constructor(...args: unknown[]) {
      gh.constructed.push(args);
    }
    fileExists = gh.fileExists;
    findPullRequest = gh.findPullRequest;
    branchSha = gh.branchSha;
    createBranch = gh.createBranch;
    putFile = gh.putFile;
    createPullRequest = gh.createPullRequest;
    requestReviewer = gh.requestReviewer;
  },
}));

const PROPOSALS = "MarketingDepartment/WebsiteOperations/docs/proposals";
const github = { token: "ghp_x", repository: "o/r", baseBranch: "main", issueNumber: 13, reviewer: "kamegin4-aws" };

let worktree: string;
let cleanup: () => void;

function input(overrides: Partial<BuiltinInput> = {}): BuiltinInput {
  const ctx = makeCtx(makeConfig({ worktree, github }));
  return { ctx, runId: "01K6PZ3T8Q4M2N7R9S5V1W3X6Y", signal: new AbortController().signal, timeoutSec: 60, job: null, ...overrides };
}

const writeProposal = (name: string, text: string) => writeAt(worktree, `${PROPOSALS}/${name}`, text);
const readProposal = (name: string) => readFileSync(join(worktree, PROPOSALS, name), "utf8");

beforeEach(() => {
  ({ dir: worktree, cleanup } = tempDir("cp-i13-"));
  gh.constructed.length = 0;
  gh.fileExists.mockResolvedValue(false);
  gh.findPullRequest.mockResolvedValue(null);
  gh.branchSha.mockResolvedValue("base-sha");
  gh.createBranch.mockResolvedValue(undefined);
  gh.putFile.mockResolvedValue(undefined);
  gh.createPullRequest.mockResolvedValue(21);
  gh.requestReviewer.mockResolvedValue(true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => cleanup());

describe("proposalBranch", () => {
  describe("正常系", () => {
    it("<I13_ISSUE_NUMBER>-feature-proposal-<proposal_id>", () => {
      expect(proposalBranch(13, "PRP-2026-0001")).toBe("13-feature-proposal-PRP-2026-0001");
    });

    it("空入力: proposal_id が空文字でも例外にせず、接頭辞だけのブランチ名を返す（呼び出し側が検証済みの ID だけを渡す）", () => {
      expect(proposalBranch(13, "")).toBe("13-feature-proposal-");
    });
  });
});

describe("i13File", () => {
  describe("正常系", () => {
    it("空入力: docs/proposals が無ければ「起票対象なし」の success", async () => {
      expect(await i13File(input())).toEqual({ outcome: "success", summary: "I-13: 起票対象なし", targetIds: [] });
      expect(gh.fileExists).not.toHaveBeenCalled();
    });

    it("空入力: docs/proposals が空のディレクトリでも「起票対象なし」の success", async () => {
      mkdirSync(join(worktree, PROPOSALS), { recursive: true });
      expect(await i13File(input())).toEqual({ outcome: "success", summary: "I-13: 起票対象なし", targetIds: [] });
      expect(gh.fileExists).not.toHaveBeenCalled();
    });

    it("draft で diff_ref が null の提案を、ブランチ作成・コミット・PR・Reviewer の順に起票し、PR 番号を書き戻す", async () => {
      const text = proposalText({ id: "PRP-2026-0001" });
      writeProposal("PRP-2026-0001.md", text);
      const path = `${PROPOSALS}/PRP-2026-0001.md`;
      const branch = "13-feature-proposal-PRP-2026-0001";

      const result = await i13File(input());

      expect(gh.fileExists).toHaveBeenNthCalledWith(1, path, "main");
      expect(gh.findPullRequest).toHaveBeenCalledWith(branch);
      expect(gh.createBranch).toHaveBeenCalledWith(branch, "base-sha");
      expect(gh.fileExists).toHaveBeenNthCalledWith(2, path, branch);
      expect(gh.putFile).toHaveBeenCalledWith(path, branch, text, "add: 改善提案 PRP-2026-0001");
      expect(gh.createPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({ title: "add: 改善提案 PRP-2026-0001", head: branch }),
      );
      expect(gh.requestReviewer).toHaveBeenCalledWith(21, "kamegin4-aws");
      expect(readProposal("PRP-2026-0001.md")).toContain('  diff_ref: "PR #21"');
      expect(readProposal("PRP-2026-0001.md")).toBe(text.replace("  diff_ref: null", '  diff_ref: "PR #21"'));
      expect(result).toEqual({
        outcome: "success",
        summary: "I-13: 起票 1 件、既存 0 件、不正 0 件、失敗 0 件",
        targetIds: ["PRP-2026-0001"],
      });
    });

    it("PR の本文は個人情報を含まない項目だけで作る", async () => {
      writeProposal("PRP-2026-0001.md", proposalText().replace('summary: "要旨"', 'summary: "taro@example.com から問い合わせ"'));
      await i13File(input());
      const body = (gh.createPullRequest.mock.calls[0]![0] as { body: string }).body;
      expect(body).toContain("PRP-2026-0001");
      expect(body).toContain(`${PROPOSALS}/PRP-2026-0001.md`);
      expect(body).not.toContain("taro@example.com");
    });

    it.each([
      ["review", null],
      ["approved", null],
      ["draft", "PR #3"],
    ])("approval.state=%s・diff_ref=%s の提案は対象にしない", async (state, diffRef) => {
      writeProposal("PRP-2026-0001.md", proposalText({ state, diffRef }));
      const result = await i13File(input());
      expect(gh.fileExists).not.toHaveBeenCalled();
      expect(result.summary).toBe("I-13: 起票対象なし");
    });

    it("冪等キー: base に同名ファイルが既にあれば起票せず、ファイルも書き換えない", async () => {
      const text = proposalText();
      writeProposal("PRP-2026-0001.md", text);
      gh.fileExists.mockResolvedValueOnce(true);
      const result = await i13File(input());
      expect(gh.findPullRequest).not.toHaveBeenCalled();
      expect(gh.createPullRequest).not.toHaveBeenCalled();
      expect(readProposal("PRP-2026-0001.md")).toBe(text);
      expect(result).toMatchObject({ outcome: "success", summary: "I-13: 起票 0 件、既存 1 件、不正 0 件、失敗 0 件" });
    });

    it("途中で止まった続き: 同じブランチの PR があれば作り直さず、その番号を書き戻す", async () => {
      writeProposal("PRP-2026-0001.md", proposalText());
      gh.findPullRequest.mockResolvedValueOnce(8);
      await i13File(input());
      expect(gh.createBranch).not.toHaveBeenCalled();
      expect(gh.putFile).not.toHaveBeenCalled();
      expect(gh.createPullRequest).not.toHaveBeenCalled();
      expect(readProposal("PRP-2026-0001.md")).toContain('diff_ref: "PR #8"');
    });

    it("ブランチに既にファイルがあればコミットしない", async () => {
      writeProposal("PRP-2026-0001.md", proposalText());
      gh.fileExists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      await i13File(input());
      expect(gh.putFile).not.toHaveBeenCalled();
      expect(gh.createPullRequest).toHaveBeenCalled();
    });

    it("Reviewer を指定できなくても起票は成功として扱う", async () => {
      writeProposal("PRP-2026-0001.md", proposalText());
      gh.requestReviewer.mockResolvedValueOnce(false);
      expect((await i13File(input())).outcome).toBe("success");
      expect(readProposal("PRP-2026-0001.md")).toContain('diff_ref: "PR #21"');
    });

    it("PRP-<西暦>-<4 桁>.md 以外のファイルは読まない", async () => {
      writeProposal("README.md", proposalText());
      writeProposal("_template.md", proposalText());
      writeProposal("PRP-2026-001.md", proposalText({ id: "PRP-2026-0001" }));
      expect((await i13File(input())).summary).toBe("I-13: 起票対象なし");
    });

    it("GitHubClient に打ち切りの signal を渡す", async () => {
      const args = input();
      await i13File(args);
      expect(gh.constructed[0]).toEqual([github, args.signal]);
    });
  });

  describe("異常系", () => {
    it("空入力: GitHub の設定が無ければ例外", async () => {
      const args = input();
      args.ctx.config.github = null;
      await expect(i13File(args)).rejects.toThrow("GitHub の設定が無い");
      expect(gh.constructed).toEqual([]);
    });

    it("入力: frontmatter が不正・proposal_id がファイル名と違う提案は起票せず、不正として数える", async () => {
      writeProposal("PRP-2026-0001.md", "---\nproposal_id: PRP-2026-0001\n---\n");
      writeProposal("PRP-2026-0002.md", proposalText({ id: "PRP-2026-0099" }));
      const result = await i13File(input());
      expect(gh.fileExists).not.toHaveBeenCalled();
      expect(result).toEqual({
        outcome: "partial",
        summary: "I-13: 起票 0 件、既存 0 件、不正 2 件、失敗 0 件",
        targetIds: [],
      });
    });

    it("空入力: 中身が空の提案ファイルは不正として数え、起票しない", async () => {
      writeProposal("PRP-2026-0001.md", "");
      const result = await i13File(input());
      expect(gh.fileExists).not.toHaveBeenCalled();
      expect(result).toMatchObject({ outcome: "partial", summary: "I-13: 起票 0 件、既存 0 件、不正 1 件、失敗 0 件" });
    });

    it("入力: 打ち切られていれば次の提案に進まない", async () => {
      writeProposal("PRP-2026-0001.md", proposalText());
      const stop = new AbortController();
      stop.abort();
      await i13File(input({ signal: stop.signal }));
      expect(gh.fileExists).not.toHaveBeenCalled();
    });

    it("サーバ: 401（auth_failed）はそこで打ち切り、残りの提案に進まない", async () => {
      writeProposal("PRP-2026-0001.md", proposalText({ id: "PRP-2026-0001" }));
      writeProposal("PRP-2026-0002.md", proposalText({ id: "PRP-2026-0002" }));
      gh.fileExists.mockRejectedValueOnce(new IntegrationError("auth_failed", "GitHub: ファイルの確認: auth_failed (HTTP 401)"));
      const result = await i13File(input());
      expect(gh.fileExists).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        outcome: "failure",
        summary: "I-13: 起票 0 件、既存 0 件、不正 0 件、失敗 1 件（失敗: PRP-2026-0001=auth_failed）",
        targetIds: ["PRP-2026-0001"],
        failureClass: "auth_failed",
      });
    });

    it("サーバ: それ以外の失敗は次の提案に進み、起票できたものがあれば partial（分類は最初の失敗）", async () => {
      writeProposal("PRP-2026-0001.md", proposalText({ id: "PRP-2026-0001" }));
      writeProposal("PRP-2026-0002.md", proposalText({ id: "PRP-2026-0002" }));
      gh.createPullRequest.mockRejectedValueOnce(new IntegrationError("rate_limited", "GitHub: PR の作成: rate_limited (HTTP 429)"));
      const result = await i13File(input());
      expect(result).toMatchObject({ outcome: "partial", failureClass: "rate_limited", targetIds: ["PRP-2026-0002", "PRP-2026-0001"] });
      expect(readProposal("PRP-2026-0001.md")).toContain("diff_ref: null");
      expect(readProposal("PRP-2026-0002.md")).toContain('diff_ref: "PR #21"');
    });

    it.each([
      ["403（permission_denied）", "permission_denied"],
      ["5xx（invalid_response）", "invalid_response"],
      ["通信失敗（unreachable）", "unreachable"],
      ["タイムアウト（timeout）", "timeout"],
    ] as const)("サーバ: PR の確認が %s なら、その分類の failure にし、ブランチを作らず次の提案に進む", async (_label, failureClass) => {
      writeProposal("PRP-2026-0001.md", proposalText({ id: "PRP-2026-0001" }));
      writeProposal("PRP-2026-0002.md", proposalText({ id: "PRP-2026-0002" }));
      gh.findPullRequest.mockRejectedValue(new IntegrationError(failureClass, `GitHub: PR の確認: ${failureClass}`));
      const result = await i13File(input());
      expect(gh.findPullRequest).toHaveBeenCalledTimes(2);
      expect(gh.createBranch).not.toHaveBeenCalled();
      expect(result).toMatchObject({ outcome: "failure", failureClass, targetIds: ["PRP-2026-0001", "PRP-2026-0002"] });
      expect(readProposal("PRP-2026-0001.md")).toContain("diff_ref: null");
    });

    it("サーバ: 失敗の要約とログに GitHub のトークンを出さない", async () => {
      writeProposal("PRP-2026-0001.md", proposalText());
      gh.createBranch.mockRejectedValueOnce(new IntegrationError("permission_denied", "GitHub: ブランチの作成: permission_denied (HTTP 403)"));
      const result = await i13File(input());
      const logged = vi.mocked(console.error).mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("permission_denied");
      expect(result.summary).not.toContain(github.token);
      expect(logged).not.toContain(github.token);
    });

    it("サーバ: base ブランチが見つからなければ invalid_response の失敗", async () => {
      writeProposal("PRP-2026-0001.md", proposalText());
      gh.branchSha.mockResolvedValueOnce(null);
      expect(await i13File(input())).toMatchObject({ outcome: "failure", failureClass: "invalid_response" });
      expect(gh.createBranch).not.toHaveBeenCalled();
    });

    it("サーバ: IntegrationError でない失敗は internal_error として数え、failureClass は null", async () => {
      writeProposal("PRP-2026-0001.md", proposalText());
      gh.putFile.mockRejectedValueOnce(new Error("unexpected"));
      const result = await i13File(input());
      expect(result).toMatchObject({ outcome: "failure", failureClass: null });
      expect(result.summary).toContain("PRP-2026-0001=internal_error");
    });
  });
});
