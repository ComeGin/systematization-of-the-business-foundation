// 結合テスト: I-13（作業ツリーの docs/proposals の draft → GitHub にブランチ・コミット・PR → diff_ref の書き戻し）。
// 公開の入口（runNow で定義 i13-file を起動）から、エンジン・E-15・builtin i13-file・integrations/github.ts（fetchJson の失敗分類と再試行）までを本物でつなぐ。
// GitHub は開発スタックに無いので、テストの中で立てる偽の GitHub（helpers/fake-github.ts）に api.github.com 宛だけを向け直す。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAws } from "./helpers/aws-mock.js";
import { resetSdk, sdk } from "./helpers/agent-sdk.js";
import { FakeGitHub, GITHUB_TOKEN, githubEnv } from "./helpers/fake-github.js";
import {
  type Fixture,
  PROPOSALS_DIR,
  Planes,
  captureLogs,
  createFixture,
  e15Bytes,
  readProposal,
  waitFinished,
  writeAt,
  writeProposal,
  writeSchedule,
} from "./helpers/fixtures.js";

vi.mock("@aws-sdk/client-s3", () => import("./helpers/aws-mock.js").then((m) => m.s3Module));
vi.mock("@aws-sdk/client-cloudwatch", () => import("./helpers/aws-mock.js").then((m) => m.cloudWatchModule));
vi.mock("@anthropic-ai/claude-agent-sdk", () => import("./helpers/agent-sdk.js").then((m) => m.sdkModule));

const BRANCH = "13-feature-proposal-PRP-2026-0001";
const PATH = `${PROPOSALS_DIR}/PRP-2026-0001.md`;

let fx: Fixture;
let planes: Planes;
let github: FakeGitHub;
let logs: () => string;

beforeEach(async () => {
  github = await FakeGitHub.start();
  github.installFetch();
  fx = createFixture("cp-it-i13-");
  planes = new Planes();
  logs = captureLogs();
  resetAws();
  resetSdk();
  writeSchedule(fx, "it-i13-file", 'enabled: true\ncron: "0 7 * * *"\nkind: builtin\nbuiltin: i13-file\n');
});

afterEach(async () => {
  await planes.stopAll();
  await github.stop();
  fx.cleanup();
});

async function runI13(timeoutMs?: number) {
  const plane = planes.create(fx.env(githubEnv()));
  const { runId } = await plane.runNow({ target: { kind: "job", jobId: "it-i13-file" } });
  return { plane, run: await waitFinished(plane, runId, timeoutMs) };
}

describe("i13-file（I-13 の起票）", () => {
  describe("正常系", () => {
    it("draft の E-13 をブランチ・コミット・PR（Reviewer 付き）にし、diff_ref に PR 番号を書き戻して E-15 に残す", async () => {
      writeProposal(fx, "worktree");
      const before = readProposal(fx);
      const { run } = await runI13();

      expect(run).toMatchObject({ outcome: "success", summary: "I-13: 起票 1 件、既存 0 件、不正 0 件、失敗 0 件", targetIds: ["PRP-2026-0001"] });
      expect(github.writes()).toEqual([
        "POST /git/refs",
        `PUT /contents/${PATH}`,
        "POST /pulls",
        "POST /pulls/1/requested_reviewers",
      ]);
      // ブランチは base（main）の先頭から作り、提案のファイルをそのままコミットする
      expect(github.filesOf(BRANCH).get(PATH)).toBe(before);
      expect(github.pulls).toMatchObject([{ number: 1, head: BRANCH, base: "main", title: "add: 改善提案 PRP-2026-0001", reviewers: ["it-reviewer"] }]);
      expect(github.pulls[0]!.body).toContain(`提案の本文は \`${PATH}\` を確認してください`);
      // 書き戻すのは diff_ref の 1 行だけ
      expect(readProposal(fx)).toBe(before.replace("  diff_ref: null", '  diff_ref: "PR #1"'));
      // 認証は Bearer。トークンはログにも E-15 にも出ない
      expect(github.requests.every((r) => r.authorization === `Bearer ${GITHUB_TOKEN}`)).toBe(true);
      expect(logs()).not.toContain(GITHUB_TOKEN);
      expect(e15Bytes(fx)).not.toContain(GITHUB_TOKEN);
      expect(sdk.query).not.toHaveBeenCalled();
    });

    it("冪等: 2 回目は diff_ref があるので起票せず、GitHub に書き込まない", async () => {
      writeProposal(fx, "worktree");
      await runI13();
      const writesAfterFirst = github.writes().length;
      const { run } = await runI13();
      expect(run).toMatchObject({ outcome: "success", summary: "I-13: 起票対象なし" });
      expect(github.writes()).toHaveLength(writesAfterFirst);
      expect(github.pulls).toHaveLength(1);
    });

    it("冪等: base に同名のファイルがあれば起票せず「既存」にし、diff_ref は書き換えない", async () => {
      writeProposal(fx, "worktree");
      github.seedBase(PATH, "既にマージ済みの提案");
      const { run } = await runI13();
      expect(run).toMatchObject({ outcome: "success", summary: "I-13: 起票 0 件、既存 1 件、不正 0 件、失敗 0 件" });
      expect(github.writes()).toEqual([]);
      expect(readProposal(fx)).toContain("diff_ref: null");
    });

    it("途中で止まった続き: 同じブランチの PR があれば作らずに再利用し、その番号を書き戻す", async () => {
      writeProposal(fx, "worktree");
      github.branches.set(BRANCH, "sha-main-0");
      github.addPull({ number: 42, head: BRANCH, base: "main", title: "t", body: "b", state: "open" });
      const { run } = await runI13();
      expect(run).toMatchObject({ outcome: "success", targetIds: ["PRP-2026-0001"] });
      expect(github.writes()).toEqual([]);
      expect(readProposal(fx)).toContain('diff_ref: "PR #42"');
    });

    it("approved など draft でない提案は対象にしない", async () => {
      writeProposal(fx, "worktree", { state: "approved" });
      const { run } = await runI13();
      expect(run).toMatchObject({ outcome: "success", summary: "I-13: 起票対象なし" });
      expect(github.requests).toEqual([]);
    });

    it("空入力: docs/proposals が無ければ GitHub を呼ばずに success（起票対象なし）", async () => {
      const { run } = await runI13();
      expect(run).toMatchObject({ outcome: "success", summary: "I-13: 起票対象なし", targetIds: [] });
      expect(github.requests).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: frontmatter が不正な提案は起票せず partial（不正 1 件）にし、GitHub を呼ばない", async () => {
      writeAt(fx.worktree, `${PROPOSALS_DIR}/PRP-2026-0002.md`, "---\nproposal_id: PRP-2026-0002\n---\n本文\n");
      const { run } = await runI13();
      expect(run).toMatchObject({ outcome: "partial", summary: "I-13: 起票 0 件、既存 0 件、不正 1 件、失敗 0 件" });
      expect(github.requests).toEqual([]);
    });

    it("入力: GitHub が 401 なら再試行せず failure（auth_failed）にして、残りの提案も止める", async () => {
      writeProposal(fx, "worktree", { id: "PRP-2026-0001" });
      writeProposal(fx, "worktree", { id: "PRP-2026-0002" });
      github.fail(() => true, { status: 401, body: { message: "Bad credentials" } });
      const { run } = await runI13();
      expect(run).toMatchObject({
        outcome: "failure",
        failureClass: "auth_failed",
        summary: "I-13: 起票 0 件、既存 0 件、不正 0 件、失敗 1 件（失敗: PRP-2026-0001=auth_failed）",
      });
      expect(github.requests).toHaveLength(1);
      expect(readProposal(fx)).toContain("diff_ref: null");
      expect(logs()).not.toContain(GITHUB_TOKEN);
    });

    it("入力: PR の作成が 422 なら failure（invalid_response）で、diff_ref を書き戻さない", async () => {
      writeProposal(fx, "worktree");
      github.fail((r) => r.method === "POST" && r.path === "/pulls", { status: 422, body: { message: "Validation Failed" } });
      const { run } = await runI13();
      expect(run).toMatchObject({ outcome: "failure", failureClass: "invalid_response" });
      expect(readProposal(fx)).toContain("diff_ref: null");
    });

    it("サーバ: PR の作成が 5xx なら failure（invalid_response。5xx は再試行しない）で、次の実行は作成済みのブランチを使って続きから起票する", async () => {
      writeProposal(fx, "worktree");
      github.fail((r) => r.method === "POST" && r.path === "/pulls", { status: 502, body: { message: "Bad Gateway" } }, 1);
      const first = await runI13();
      expect(first.run).toMatchObject({ outcome: "failure", failureClass: "invalid_response", targetIds: ["PRP-2026-0001"] });
      expect(github.requests.filter((r) => r.method === "POST" && r.path === "/pulls")).toHaveLength(1);
      expect(readProposal(fx)).toContain("diff_ref: null");

      const second = await runI13();
      expect(second.run).toMatchObject({ outcome: "success", summary: "I-13: 起票 1 件、既存 0 件、不正 0 件、失敗 0 件" });
      // ブランチは 422（既にある）で続きとして扱い、ファイルは既にあるのでコミットし直さない
      expect(github.writes().slice(-3)).toEqual(["POST /git/refs", "POST /pulls", "POST /pulls/1/requested_reviewers"]);
      expect(readProposal(fx)).toContain('diff_ref: "PR #1"');
    });

    it("サーバ: GitHub に届かない（接続の失敗）なら再試行の後に failure（unreachable）", async () => {
      writeProposal(fx, "worktree");
      await github.stop(); // 偽の GitHub を止める = 宛先のポートが閉じている
      const { run } = await runI13(30_000);
      expect(run).toMatchObject({ outcome: "failure", failureClass: "unreachable" });
      expect(readProposal(fx)).toContain("diff_ref: null");
    });

    it("サーバ: GitHub が応答しなければ 30 秒で切って failure（timeout）", { timeout: 90_000 }, async () => {
      writeProposal(fx, "worktree");
      github.fail(() => true, "hang");
      const { run } = await runI13(80_000);
      expect(run).toMatchObject({ outcome: "failure", failureClass: "timeout" });
      // 30 秒で切ったあとの再試行（3 秒待ち）は総予算 30 秒に収まらないので、送るのは 1 回だけ
      expect(github.requests).toHaveLength(1);
    });
  });
});
