// 承認済み main のチェックアウトの workflows/*.json を読む処理が本質なので、一時ディレクトリに置いて確かめる（基準 D の例外）。
// n8n の Public API と GitHub は、クライアントのクラスごと偽物に差し替える（実 n8n・実 GitHub には繋がない）。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { n8nExport } from "../../src/builtin/n8n-export.js";
import type { BuiltinInput } from "../../src/context.js";
import { N8N_WORKFLOWS_DIR } from "../../src/constants/paths.js";
import { normalizeWorkflow } from "../../src/definitions/n8n-workflow.js";
import { IntegrationError } from "../../src/integrations/http.js";
import { makeConfig, makeCtx, tempDir, writeAt } from "../helpers/runner.js";

const n8n = vi.hoisted(() => ({
  constructed: [] as unknown[][],
  listWorkflows: vi.fn(),
  getWorkflow: vi.fn(),
}));
vi.mock("../../src/integrations/n8n.js", () => ({
  N8nClient: class {
    constructor(...args: unknown[]) {
      n8n.constructed.push(args);
    }
    listWorkflows = n8n.listWorkflows;
    getWorkflow = n8n.getWorkflow;
  },
}));

const gh = vi.hoisted(() => ({
  constructed: [] as unknown[][],
  findPullRequest: vi.fn(),
  listOpenPullRequests: vi.fn(),
  getFileText: vi.fn(),
  branchSha: vi.fn(),
  commitFilesToNewBranch: vi.fn(),
  createPullRequest: vi.fn(),
  requestReviewer: vi.fn(),
}));
vi.mock("../../src/integrations/github.js", () => ({
  GitHubClient: class {
    constructor(...args: unknown[]) {
      gh.constructed.push(args);
    }
    findPullRequest = gh.findPullRequest;
    listOpenPullRequests = gh.listOpenPullRequests;
    getFileText = gh.getFileText;
    branchSha = gh.branchSha;
    commitFilesToNewBranch = gh.commitFilesToNewBranch;
    createPullRequest = gh.createPullRequest;
    requestReviewer = gh.requestReviewer;
  },
}));

const N8N_CONFIG = { baseUrl: "https://n8n.example.test", apiKey: "n8n_api_key_SECRET_value" };
const GITHUB = { token: "ghp_SECRET_token_value", repository: "o/r", baseBranch: "main", issueNumber: 13, reviewer: "kamegin4-aws" };
const BRANCH = "chore/n8n-export-20261007";
const RUN_ID = "01K6PZ3T8Q4M2N7R9S5V1W3X6Y";

let root: string;
let cleanup: () => void;
/** n8n にあるワークフロー（id → API の応答の形）。listWorkflows / getWorkflow の偽物が読む */
let remote: Map<string, Record<string, unknown>>;
let archived: Set<string>;

/** n8n の Public API の単体取得の応答に近い形。 */
function apiWorkflow(id: string, name: string, parameters: Record<string, unknown> = { path: id }): Record<string, unknown> {
  return {
    id,
    name,
    active: true,
    updatedAt: "2026-10-06T00:00:00.000Z",
    versionId: `v-${id}`,
    nodes: [{ parameters, id: `n-${id}`, name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0] }],
    connections: {},
    settings: { executionOrder: "v1" },
  };
}

function addRemote(id: string, name: string, parameters?: Record<string, unknown>, options: { archived?: boolean } = {}) {
  remote.set(id, apiWorkflow(id, name, parameters));
  if (options.archived) archived.add(id);
}

/** 正規化した後のテキスト（main に置くファイル・GitHub の base の本文に使う）。 */
const textOf = (id: string) => normalizeWorkflow(remote.get(id)).text;

const writeMain = (fileName: string, content: string) => writeAt(join(root, "main"), `${N8N_WORKFLOWS_DIR}/${fileName}`, content);

function input(overrides: Partial<BuiltinInput> = {}, config: Parameters<typeof makeConfig>[0] = {}): BuiltinInput {
  const ctx = makeCtx(
    makeConfig({ mainCheckout: join(root, "main"), worktree: join(root, "wt"), n8nExport: N8N_CONFIG, github: GITHUB, ...config }),
  );
  return { ctx, runId: RUN_ID, signal: new AbortController().signal, timeoutSec: 600, job: null, ...overrides };
}

const logged = () => vi.mocked(console.error).mock.calls.map((call) => String(call[0])).join("\n");
const committedFiles = () =>
  (gh.commitFilesToNewBranch.mock.calls[0]![0] as { files: { path: string; content: string }[] }).files;
const prBody = () => (gh.createPullRequest.mock.calls[0]![0] as { body: string }).body;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-07T03:00:00+09:00"));
  ({ dir: root, cleanup } = tempDir("cp-n8n-export-"));
  remote = new Map();
  archived = new Set();
  n8n.constructed.length = 0;
  gh.constructed.length = 0;
  n8n.listWorkflows.mockImplementation(async () =>
    [...remote.values()].map((workflow) => ({
      id: workflow.id as string,
      name: workflow.name as string,
      isArchived: archived.has(workflow.id as string),
    })),
  );
  n8n.getWorkflow.mockImplementation(async (id: string) => structuredClone(remote.get(id)));
  gh.findPullRequest.mockResolvedValue(null);
  gh.listOpenPullRequests.mockResolvedValue([]);
  gh.getFileText.mockResolvedValue(null);
  gh.branchSha.mockResolvedValue("base-sha");
  gh.commitFilesToNewBranch.mockResolvedValue("created");
  gh.createPullRequest.mockResolvedValue(41);
  gh.requestReviewer.mockResolvedValue(true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("n8nExport", () => {
  describe("正常系", () => {
    it("main と違うものだけを 1 コミットにして日付のブランチに置き、PR と Reviewer を作る", async () => {
      addRemote("a", "Alpha");
      addRemote("b", "I-11 Mautic Webhook");
      addRemote("c", "Gamma");
      writeMain("alpha.json", textOf("a")); // 変わっていない
      writeMain("I-11-mautic-webhook-dedup.json", '{\n  "name": "I-11 Mautic Webhook",\n  "nodes": []\n}\n'); // 変わった

      const result = await n8nExport(input());

      expect(gh.findPullRequest).toHaveBeenCalledWith(BRANCH);
      expect(gh.listOpenPullRequests).toHaveBeenCalledWith("chore/n8n-export-");
      expect(gh.commitFilesToNewBranch).toHaveBeenCalledWith({
        branch: BRANCH,
        baseSha: "base-sha",
        // ファイル名の順（localeCompare。大文字小文字を区別しない並び）
        files: [
          { path: `${N8N_WORKFLOWS_DIR}/gamma.json`, content: textOf("c") },
          { path: `${N8N_WORKFLOWS_DIR}/I-11-mautic-webhook-dedup.json`, content: textOf("b") },
        ],
        message: "chore: n8n ワークフローの書き出し 2026-10-07（変更 1 件・追加 1 件）",
      });
      expect(gh.createPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({ title: "chore: n8n ワークフローの書き出し 2026-10-07", head: BRANCH }),
      );
      expect(prBody()).toContain("- 変更: 1 件\n  - `I-11-mautic-webhook-dedup.json`");
      expect(prBody()).toContain("- 追加: 1 件\n  - `gamma.json`");
      expect(prBody()).not.toContain("秘密値の疑い");
      expect(gh.requestReviewer).toHaveBeenCalledWith(41, "kamegin4-aws");
      expect(result).toEqual({
        outcome: "success",
        summary: "n8n-export: PR #41 を作成（変更 1 件・追加 1 件）",
        targetIds: ["PR #41"],
        failureClass: null,
      });
    });

    it("作業ツリー（CONTROL_WORKTREE）には何も書かない", async () => {
      addRemote("a", "Alpha");
      await n8nExport(input());
      expect(gh.commitFilesToNewBranch).toHaveBeenCalled();
      expect(existsSync(join(root, "wt"))).toBe(false);
    });

    it("N8nClient と GitHubClient に、それぞれの設定と打ち切りの signal を渡す", async () => {
      addRemote("a", "Alpha");
      const args = input();
      await n8nExport(args);
      expect(n8n.constructed).toEqual([[N8N_CONFIG, args.signal]]);
      expect(gh.constructed).toEqual([[GITHUB, args.signal]]);
    });

    it("アーカイブ済みのワークフローは削除と同じ扱いで、本体を取らない", async () => {
      addRemote("a", "Alpha");
      addRemote("z", "Zeta", undefined, { archived: true });
      await n8nExport(input());
      expect(n8n.getWorkflow.mock.calls.map((call) => call[0])).toEqual(["a"]);
      expect(committedFiles().map((file) => file.path)).toEqual([`${N8N_WORKFLOWS_DIR}/alpha.json`]);
    });

    it("main と同じバイト列なら差分なしで、GitHub を呼ばない", async () => {
      addRemote("a", "Alpha");
      addRemote("b", "Beta");
      writeMain("alpha.json", textOf("a"));
      writeMain("beta.json", textOf("b"));
      expect(await n8nExport(input())).toEqual({
        outcome: "success",
        summary: "n8n-export: 差分なし（2 件を確認）",
        targetIds: [],
        failureClass: null,
      });
      expect(gh.constructed).toEqual([]);
    });

    it("main のファイルは name の一致で対応づけ（NFC）、ファイル名が名前と違っても書き換え先にする", async () => {
      const nfc = "パイプライン";
      addRemote("a", nfc.normalize("NFD"));
      writeMain("custom-name.json", `${JSON.stringify({ name: nfc, nodes: [] }, null, 2)}\n`);
      await n8nExport(input());
      expect(committedFiles().map((file) => file.path)).toEqual([`${N8N_WORKFLOWS_DIR}/custom-name.json`]);
      expect(gh.commitFilesToNewBranch.mock.calls[0]![0]).toMatchObject({ message: expect.stringContaining("変更 1 件・追加 0 件") });
    });

    it("n8n に無い main のファイルは消さない（反映は n8n → Git の一方向）", async () => {
      addRemote("a", "Alpha");
      writeMain("dev-only.json", `${JSON.stringify({ name: "開発だけ" }, null, 2)}\n`);
      await n8nExport(input());
      expect(committedFiles().map((file) => file.path)).toEqual([`${N8N_WORKFLOWS_DIR}/alpha.json`]);
    });

    it("今日のブランチの PR が既にあれば、作り直さずその番号を返す", async () => {
      addRemote("a", "Alpha");
      gh.findPullRequest.mockResolvedValueOnce(40);
      expect(await n8nExport(input())).toMatchObject({ outcome: "success", summary: "n8n-export: 起票済み（PR #40）", targetIds: ["PR #40"] });
      expect(gh.listOpenPullRequests).not.toHaveBeenCalled();
      expect(gh.commitFilesToNewBranch).not.toHaveBeenCalled();
    });

    it("未マージの書き出しの PR があれば、新しい PR を作らずに見送る", async () => {
      addRemote("a", "Alpha");
      gh.listOpenPullRequests.mockResolvedValueOnce([{ number: 35, branch: "chore/n8n-export-20261005" }]);
      expect(await n8nExport(input())).toMatchObject({
        outcome: "success",
        summary: "n8n-export: 未マージの書き出しの PR があるため見送った（PR #35）",
        targetIds: ["PR #35"],
      });
      expect(gh.getFileText).not.toHaveBeenCalled();
      expect(gh.commitFilesToNewBranch).not.toHaveBeenCalled();
    });

    it("main のチェックアウトが古くても、GitHub の base に反映済みのものは PR に含めない", async () => {
      addRemote("a", "Alpha");
      addRemote("b", "Beta");
      gh.getFileText.mockImplementation(async (path: string) => (path.endsWith("alpha.json") ? textOf("a") : null));
      await n8nExport(input());
      expect(gh.getFileText).toHaveBeenCalledWith(`${N8N_WORKFLOWS_DIR}/alpha.json`, "main");
      expect(committedFiles().map((file) => file.path)).toEqual([`${N8N_WORKFLOWS_DIR}/beta.json`]);
    });

    it("すべて base に反映済みなら差分なし（base には反映済み）で、コミットしない", async () => {
      addRemote("a", "Alpha");
      gh.getFileText.mockImplementation(async () => textOf("a"));
      expect(await n8nExport(input())).toMatchObject({
        outcome: "success",
        summary: "n8n-export: 差分なし（1 件を確認。base には反映済み）",
        targetIds: [],
      });
      expect(gh.branchSha).not.toHaveBeenCalled();
      expect(gh.commitFilesToNewBranch).not.toHaveBeenCalled();
    });

    it("前回の途中でブランチだけできていれば（exists）、PR だけ作る", async () => {
      addRemote("a", "Alpha");
      gh.commitFilesToNewBranch.mockResolvedValueOnce("exists");
      expect((await n8nExport(input())).summary).toBe("n8n-export: PR #41 を作成（変更 0 件・追加 1 件）");
      expect(gh.createPullRequest).toHaveBeenCalled();
    });

    it("Reviewer を指定できなくても PR の作成は成功として扱い、WARN を出す", async () => {
      addRemote("a", "Alpha");
      gh.requestReviewer.mockResolvedValueOnce(false);
      expect((await n8nExport(input())).outcome).toBe("success");
      expect(logged()).toContain("WARN n8n-export Reviewer を指定できなかった（PR #41 は作成済み）");
    });

    it("空入力: n8n にワークフローが 0 件なら何もしない（GitHub も main も読まない）", async () => {
      expect(await n8nExport(input())).toEqual({ outcome: "success", summary: "n8n-export: n8n にワークフローが無いため何もしない", targetIds: [] });
      expect(n8n.getWorkflow).not.toHaveBeenCalled();
      expect(gh.constructed).toEqual([]);
    });

    it("空入力: すべてアーカイブ済みなら 0 件と同じ扱い", async () => {
      addRemote("z", "Zeta", undefined, { archived: true });
      expect((await n8nExport(input())).summary).toBe("n8n-export: n8n にワークフローが無いため何もしない");
    });

    it("空入力: main に workflows のディレクトリが無ければ、すべて追加として扱う", async () => {
      addRemote("a", "Alpha");
      addRemote("b", "Beta");
      expect((await n8nExport(input())).summary).toBe("n8n-export: PR #41 を作成（変更 0 件・追加 2 件）");
      expect(prBody()).toContain("- 変更: 0 件\n  - なし");
    });
  });

  describe("異常系", () => {
    it("空入力: n8n の設定が無ければ例外（エンジンが先に見送るため、ここに来るのは誤り）", async () => {
      await expect(n8nExport(input({}, { n8nExport: null }))).rejects.toThrow("n8n の設定が無い");
      expect(n8n.listWorkflows).not.toHaveBeenCalled();
    });

    it("空入力: GitHub の設定が無ければ例外", async () => {
      await expect(n8nExport(input({}, { github: null }))).rejects.toThrow("GitHub の設定が無い");
      expect(n8n.listWorkflows).not.toHaveBeenCalled();
    });

    it.each(["auth_failed", "permission_denied", "unreachable", "timeout", "rate_limited", "truncated", "invalid_response"] as const)(
      "サーバ: 一覧の取得が %s なら、その分類の failure にして何も書かない",
      async (failureClass) => {
        n8n.listWorkflows.mockRejectedValueOnce(new IntegrationError(failureClass, `n8n: ワークフローの一覧: ${failureClass}`));
        expect(await n8nExport(input())).toEqual({
          outcome: "failure",
          summary: "n8n-export: n8n のワークフローの一覧を取得できなかった",
          targetIds: [],
          failureClass,
        });
        expect(n8n.getWorkflow).not.toHaveBeenCalled();
        expect(gh.constructed).toEqual([]);
        expect(logged()).toContain(`ERROR n8n-export 一覧の取得に失敗: n8n: ワークフローの一覧: ${failureClass}`);
      },
    );

    it("サーバ: 一覧の取得の IntegrationError でない例外は、failureClass を null にした failure", async () => {
      n8n.listWorkflows.mockRejectedValueOnce(new TypeError("Cannot read properties of null"));
      expect(await n8nExport(input())).toMatchObject({ outcome: "failure", failureClass: null });
    });

    it("サーバ: 本体の取得が 1 件だけ失敗したら、残りで PR を作って partial（分類は最初の失敗）", async () => {
      addRemote("a", "Alpha");
      addRemote("b", "Beta");
      addRemote("c", "Gamma");
      n8n.getWorkflow.mockImplementation(async (id: string) => {
        if (id === "b") throw new IntegrationError("rate_limited", "n8n: ワークフローの取得: rate_limited (HTTP 429)");
        return structuredClone(remote.get(id));
      });
      const result = await n8nExport(input());
      expect(n8n.getWorkflow).toHaveBeenCalledTimes(3);
      expect(committedFiles().map((file) => file.path)).toEqual([`${N8N_WORKFLOWS_DIR}/alpha.json`, `${N8N_WORKFLOWS_DIR}/gamma.json`]);
      expect(result).toEqual({
        outcome: "partial",
        summary: "n8n-export: PR #41 を作成（変更 0 件・追加 2 件）、取得に失敗 1 件",
        targetIds: ["PR #41"],
        failureClass: "rate_limited",
      });
    });

    it("サーバ: 本体の取得が失敗して差分が無ければ、差分なしの partial", async () => {
      addRemote("a", "Alpha");
      addRemote("b", "Beta");
      writeMain("alpha.json", textOf("a"));
      n8n.getWorkflow.mockImplementation(async (id: string) => {
        if (id === "b") throw new IntegrationError("invalid_response", "n8n: ワークフローの取得: invalid_response (HTTP 500)");
        return structuredClone(remote.get(id));
      });
      expect(await n8nExport(input())).toEqual({
        outcome: "partial",
        summary: "n8n-export: 差分なし（1 件を確認）、取得に失敗 1 件",
        targetIds: [],
        failureClass: "invalid_response",
      });
    });

    it.each(["auth_failed", "permission_denied"] as const)("サーバ: 本体の取得が %s なら、残りの取得をせずに止める", async (failureClass) => {
      addRemote("a", "Alpha");
      addRemote("b", "Beta");
      addRemote("c", "Gamma");
      n8n.getWorkflow.mockRejectedValue(new IntegrationError(failureClass, `n8n: ワークフローの取得: ${failureClass}`));
      expect(await n8nExport(input())).toEqual({
        outcome: "failure",
        summary: "n8n-export: ワークフローを 1 件も取得できなかった、取得に失敗 1 件",
        targetIds: [],
        failureClass,
      });
      expect(n8n.getWorkflow).toHaveBeenCalledTimes(1);
      expect(gh.constructed).toEqual([]);
    });

    it("サーバ: それ以外の取得の失敗は次のワークフローに進み、すべて失敗なら failure", async () => {
      addRemote("a", "Alpha");
      addRemote("b", "Beta");
      n8n.getWorkflow.mockRejectedValue(new IntegrationError("unreachable", "n8n: ワークフローの取得: unreachable"));
      expect(await n8nExport(input())).toMatchObject({
        outcome: "failure",
        summary: "n8n-export: ワークフローを 1 件も取得できなかった、取得に失敗 2 件",
        failureClass: "unreachable",
      });
      expect(n8n.getWorkflow).toHaveBeenCalledTimes(2);
    });

    it("サーバ: 本体の形が想定と違う（name が無い）ものは、分類なしの取得の失敗として数える", async () => {
      addRemote("a", "Alpha");
      addRemote("b", "Beta");
      n8n.getWorkflow.mockImplementation(async (id: string) => (id === "b" ? { id: "b", nodes: [] } : structuredClone(remote.get(id))));
      const result = await n8nExport(input());
      expect(result).toMatchObject({ outcome: "partial", failureClass: null });
      expect(result.summary).toContain("取得に失敗 1 件");
      expect(logged()).toContain("ERROR n8n-export ワークフロー b の取得・整形に失敗: ワークフローの形が想定と違う（name が無い）");
    });

    it("入力: 秘密値の疑いのあるワークフローは PR から外し、値をどこにも出さずに partial にする", async () => {
      const secret = `ghp_${"S".repeat(36)}`;
      addRemote("a", "Alpha");
      addRemote("s", "Leaky", { url: "https://api.github.com", headerValue: secret });
      const result = await n8nExport(input());
      expect(committedFiles().map((file) => file.path)).toEqual([`${N8N_WORKFLOWS_DIR}/alpha.json`]);
      expect(prBody()).toContain("秘密値の疑いのある 1 件のワークフローは、この PR に含めていません");
      expect(result).toEqual({
        outcome: "partial",
        summary: "n8n-export: PR #41 を作成（変更 0 件・追加 1 件）。Leaky: 秘密値の疑い（PR から外した）",
        targetIds: ["PR #41"],
        failureClass: null,
      });
      const everything = [JSON.stringify(result), prBody(), JSON.stringify(gh.commitFilesToNewBranch.mock.calls), logged()].join("\n");
      expect(everything).not.toContain(secret);
    });

    it("入力: すべて秘密値の疑いなら何も起票せず、差分なしの partial", async () => {
      addRemote("s", "Leaky", { apiKey: "plain-secret-value" });
      expect(await n8nExport(input())).toEqual({
        outcome: "partial",
        summary: "n8n-export: 差分なし（0 件を確認）。Leaky: 秘密値の疑い（PR から外した）",
        targetIds: [],
        failureClass: null,
      });
      expect(gh.constructed).toEqual([]);
    });

    it("入力: main の壊れた JSON・name の無いファイルは対応づけに使わず、WARN を出して続ける", async () => {
      addRemote("a", "Alpha");
      writeMain("alpha.json", "{ broken");
      writeMain("noname.json", '{"nodes":[]}');
      const result = await n8nExport(input());
      // 壊れたファイルのファイル名は予約されないため、名前から作った alpha.json に「追加」として書く
      expect(committedFiles().map((file) => file.path)).toEqual([`${N8N_WORKFLOWS_DIR}/alpha.json`]);
      expect(result.summary).toBe("n8n-export: PR #41 を作成（変更 0 件・追加 1 件）");
      expect(logged()).toContain("WARN n8n-export alpha.json を JSON として読めない（対応づけに使わない）");
    });

    it("入力: 本体の取得の途中で打ち切られたら timeout の failure にして、GitHub を呼ばない", async () => {
      addRemote("a", "Alpha");
      addRemote("b", "Beta");
      const stop = new AbortController();
      n8n.getWorkflow.mockImplementation(async (id: string) => {
        stop.abort();
        return structuredClone(remote.get(id));
      });
      expect(await n8nExport(input({ signal: stop.signal }))).toEqual({
        outcome: "failure",
        summary: "n8n-export: 打ち切られた",
        targetIds: [],
        failureClass: "timeout",
      });
      expect(n8n.getWorkflow).toHaveBeenCalledTimes(1);
      expect(gh.constructed).toEqual([]);
    });

    it.each([
      ["findPullRequest", "auth_failed"],
      ["listOpenPullRequests", "rate_limited"],
      ["getFileText", "invalid_response"],
      ["commitFilesToNewBranch", "permission_denied"],
      ["createPullRequest", "unreachable"],
    ] as const)("サーバ: GitHub の %s が %s なら、その分類の failure にする", async (method, failureClass) => {
      addRemote("a", "Alpha");
      gh[method].mockRejectedValueOnce(new IntegrationError(failureClass, `GitHub: ${method}: ${failureClass}`));
      expect(await n8nExport(input())).toEqual({
        outcome: "failure",
        summary: "n8n-export: 差分 1 件を GitHub に起票できなかった",
        targetIds: [],
        failureClass,
      });
      expect(logged()).toContain(`ERROR n8n-export GitHub への起票に失敗: GitHub: ${method}: ${failureClass}`);
      expect(logged()).not.toContain(GITHUB.token);
      expect(logged()).not.toContain(N8N_CONFIG.apiKey);
    });

    it("サーバ: コミットに失敗したら PR を作らない", async () => {
      addRemote("a", "Alpha");
      gh.commitFilesToNewBranch.mockRejectedValueOnce(new IntegrationError("invalid_response", "GitHub: tree の作成: invalid_response (HTTP 502)"));
      await n8nExport(input());
      expect(gh.createPullRequest).not.toHaveBeenCalled();
    });

    it("サーバ: base ブランチが見つからなければ invalid_response の failure で、コミットしない", async () => {
      addRemote("a", "Alpha");
      gh.branchSha.mockResolvedValueOnce(null);
      expect(await n8nExport(input())).toMatchObject({ outcome: "failure", failureClass: "invalid_response" });
      expect(gh.commitFilesToNewBranch).not.toHaveBeenCalled();
    });

    it("サーバ: PR 番号が返らないなど IntegrationError でない失敗は、failureClass を null にした failure", async () => {
      addRemote("a", "Alpha");
      gh.createPullRequest.mockRejectedValueOnce(new Error("GitHub: PR 番号を取得できなかった"));
      expect(await n8nExport(input())).toMatchObject({ outcome: "failure", failureClass: null });
    });

    it("サーバ: 取得の失敗と起票の失敗が重なれば、要約に両方を書く", async () => {
      addRemote("a", "Alpha");
      addRemote("b", "Beta");
      n8n.getWorkflow.mockImplementation(async (id: string) => {
        if (id === "b") throw new IntegrationError("timeout", "n8n: ワークフローの取得: timeout");
        return structuredClone(remote.get(id));
      });
      gh.findPullRequest.mockRejectedValueOnce(new IntegrationError("unreachable", "GitHub: PR の確認: unreachable"));
      expect(await n8nExport(input())).toEqual({
        outcome: "failure",
        summary: "n8n-export: 差分 1 件を GitHub に起票できなかった、取得に失敗 1 件",
        targetIds: [],
        failureClass: "unreachable",
      });
    });
  });
});
