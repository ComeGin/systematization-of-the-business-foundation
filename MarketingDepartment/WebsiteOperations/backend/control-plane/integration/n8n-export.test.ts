// 結合テスト: n8n-export（n8n のワークフローを公開 API で読み → 揮発フィールドを除いて整形 → main と比較 → GitHub に PR）。
// 読み先は本物の開発の n8n（127.0.0.1:5678。キーは状態ファイルの N8N_API_KEY）。n8n には書き込まない（GET だけ）。
// GitHub は開発スタックに無いので偽の GitHub（helpers/fake-github.ts）。作業ツリーには何も書かないことも確かめる。
import { readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAws } from "./helpers/aws-mock.js";
import { resetSdk } from "./helpers/agent-sdk.js";
import { CLOSED_PORT_URL, DEV, n8nExportEnv, requireValue } from "./helpers/dev-stack.js";
import { FakeGitHub, GITHUB_TOKEN, githubEnv } from "./helpers/fake-github.js";
import { type Fixture, N8N_WORKFLOWS_DIR, Planes, captureLogs, createFixture, e15Bytes, jstToday, waitFinished, writeAt, writeSchedule } from "./helpers/fixtures.js";

vi.mock("@aws-sdk/client-s3", () => import("./helpers/aws-mock.js").then((m) => m.s3Module));
vi.mock("@aws-sdk/client-cloudwatch", () => import("./helpers/aws-mock.js").then((m) => m.cloudWatchModule));
vi.mock("@anthropic-ai/claude-agent-sdk", () => import("./helpers/agent-sdk.js").then((m) => m.sdkModule));

/** 揮発フィールド（書き出しで除くもの）。1 つでも残っていれば整形の失敗 */
const VOLATILE_KEYS = ["id", "versionId", "activeVersionId", "createdAt", "updatedAt", "staticData", "shared", "triggerCount", "isArchived"];

let fx: Fixture;
let planes: Planes;
let github: FakeGitHub | undefined;

let logs: () => string;
let fetchSpy: ReturnType<typeof vi.fn>;

/** 偽の GitHub を立て直し、api.github.com 宛をそこへ向ける。n8n への要求を数えるため、向け直した fetch をさらに包む */
async function restartGitHub(): Promise<void> {
  await github?.stop();
  github = await FakeGitHub.start();
  github.installFetch();
  const routed = globalThis.fetch;
  fetchSpy = vi.fn((input: string | URL | Request, init?: RequestInit) => routed(input, init));
  vi.stubGlobal("fetch", fetchSpy);
}

beforeEach(async () => {
  await restartGitHub();
  fx = createFixture("cp-it-n8n-");
  planes = new Planes();
  logs = captureLogs();
  resetAws();
  resetSdk();
  writeSchedule(fx, "it-n8n-export", 'enabled: false\ncron: "30 3 * * *"\nkind: builtin\nbuiltin: n8n-export\n');
});

afterEach(async () => {
  await planes.stopAll();
  await github?.stop();
  github = undefined;
  fx.cleanup();
});

async function runExport(env: Record<string, string> = { ...n8nExportEnv(), ...githubEnv() }, timeoutMs?: number) {
  const plane = planes.create(fx.env(env));
  const { runId } = await plane.runNow({ target: { kind: "job", jobId: "it-n8n-export" } });
  return waitFinished(plane, runId, timeoutMs);
}

const n8nRequests = () =>
  fetchSpy.mock.calls
    .map(([input, init]) => ({ url: String(input instanceof Request ? input.url : input), method: (init as RequestInit | undefined)?.method ?? "GET" }))
    .filter((r) => r.url.startsWith(DEV.n8n));

const gh = (): FakeGitHub => github!;
const branchOfToday = () => `chore/n8n-export-${jstToday().date.replaceAll("-", "")}`;

describe("n8n-export（n8n のワークフローの書き出し）", () => {
  describe("正常系", () => {
    it("開発の n8n を読んで整形し、main に無いワークフローを 1 コミット・1 PR（Reviewer 付き）にする。n8n には GET しか送らない", async () => {
      const run = await runExport();
      expect(run.outcome === "success" || run.outcome === "partial").toBe(true);
      expect(run.summary).toMatch(/^n8n-export: PR #1 を作成（変更 0 件・追加 \d+ 件）/);
      expect(run.targetIds).toEqual(["PR #1"]);

      // Git Data API の順（tree → commit → ref）で 1 コミット、その後に PR と Reviewer
      expect(gh().writes()).toEqual(["POST /git/trees", "POST /git/commits", "POST /git/refs", "POST /pulls", "POST /pulls/1/requested_reviewers"]);
      const files = [...gh().filesOf(branchOfToday())].filter(([path]) => path.startsWith(`${N8N_WORKFLOWS_DIR}/`));
      expect(files.length).toBeGreaterThan(0);
      for (const [path, text] of files) {
        expect(path).toMatch(/\.json$/);
        expect(text.endsWith("}\n")).toBe(true);
        const workflow = JSON.parse(text) as Record<string, unknown>;
        expect(typeof workflow.name).toBe("string");
        for (const key of VOLATILE_KEYS) expect(workflow).not.toHaveProperty(key);
        expect(workflow.pinData).toEqual({});
      }
      expect(gh().pulls[0]).toMatchObject({ head: branchOfToday(), base: "main", reviewers: ["it-reviewer"] });
      // PR の本文はファイル名の一覧だけ（ワークフローの中身は載せない）
      for (const [path] of files) expect(gh().pulls[0]!.body).toContain(path.split("/").at(-1));

      expect(new Set(n8nRequests().map((r) => r.method))).toEqual(new Set(["GET"]));
      // 作業ツリーには何も書かない（一時ディレクトリの .keep だけ）
      expect(readdirSync(fx.worktree)).toEqual([".keep"]);
      // n8n の API キーと GitHub のトークンは、ログにも E-15 にも出ない
      for (const text of [logs(), e15Bytes(fx)]) {
        expect(text).not.toContain(requireValue("N8N_API_KEY"));
        expect(text).not.toContain(GITHUB_TOKEN);
      }
    });

    it("main に書き出しと同じ内容があれば「差分なし」で、GitHub を呼ばない", async () => {
      await runExport();
      for (const [path, text] of gh().filesOf(branchOfToday())) {
        if (path.startsWith(`${N8N_WORKFLOWS_DIR}/`)) writeAt(fx.main, path, text);
      }
      const requestsBefore = gh().requests.length;
      const run = await runExport();
      expect(run.summary).toMatch(/^n8n-export: 差分なし（\d+ 件を確認）/);
      expect(gh().requests).toHaveLength(requestsBefore);
    });

    it("冪等: 同じ日のブランチの PR があれば作らずに「起票済み」", async () => {
      gh().addPull({ number: 7, head: branchOfToday(), base: "main", title: "t", body: "b", state: "open" });
      const run = await runExport();
      expect(run.summary).toMatch(/^n8n-export: 起票済み（PR #7）/);
      expect(gh().writes()).toEqual([]);
    });

    it("別の日の未マージの書き出しの PR があれば、新しく作らずに見送る", async () => {
      gh().addPull({ number: 3, head: "chore/n8n-export-20261001", base: "main", title: "t", body: "b", state: "open" });
      const run = await runExport();
      expect(run.summary).toMatch(/^n8n-export: 未マージの書き出しの PR があるため見送った（PR #3）/);
      expect(gh().writes()).toEqual([]);
    });

    it("base（GitHub の main）に同じ内容が既にあれば、main のチェックアウトが遅れていても PR を作らない", async () => {
      await runExport();
      const exported = [...gh().filesOf(branchOfToday())].filter(([path]) => path.startsWith(`${N8N_WORKFLOWS_DIR}/`));
      await restartGitHub(); // 前回のブランチと PR の無い GitHub で、base にだけ同じ内容がある
      for (const [path, text] of exported) gh().seedBase(path, text);
      const run = await runExport();
      expect(run.summary).toMatch(/^n8n-export: 差分なし（\d+ 件を確認。base には反映済み）/);
      expect(gh().writes()).toEqual([]);
    });

    it("空入力: n8n の 2 変数が無ければ n8n を呼ばずに skipped（理由は変数名だけ）", async () => {
      const run = await runExport(githubEnv());
      expect(run).toMatchObject({ outcome: "skipped", skipReason: "設定が無いため見送った（CONTROL_N8N_EXPORT_URL, CONTROL_N8N_EXPORT_API_KEY）" });
      expect(n8nRequests()).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: API キーが違えば 401 を auth_failed として failure にし、再試行も GitHub への起票もしない", async () => {
      const wrongKey = "it-wrong-n8n-api-key-000000000000";
      const run = await runExport({ ...n8nExportEnv(), CONTROL_N8N_EXPORT_API_KEY: wrongKey, ...githubEnv() });
      expect(run).toMatchObject({
        outcome: "failure",
        failureClass: "auth_failed",
        summary: "n8n-export: n8n のワークフローの一覧を取得できなかった",
      });
      expect(n8nRequests()).toHaveLength(1);
      expect(gh().requests).toEqual([]);
      expect(logs()).not.toContain(wrongKey);
    });

    it("サーバ: n8n に届かない（閉じたポート）なら、再試行（3 秒 + 9 秒）の後に failure（unreachable）", async () => {
      const run = await runExport({ ...n8nExportEnv(), CONTROL_N8N_EXPORT_URL: CLOSED_PORT_URL, ...githubEnv() }, 30_000);
      expect(run).toMatchObject({ outcome: "failure", failureClass: "unreachable" });
      expect(fetchSpy.mock.calls.filter(([input]) => String(input).startsWith(CLOSED_PORT_URL))).toHaveLength(3);
      expect(gh().requests).toEqual([]);
    });

    it("サーバ: GitHub の tree の作成が 5xx なら failure（invalid_response）で、ブランチも PR も残さない", async () => {
      gh().fail((r) => r.method === "POST" && r.path === "/git/trees", { status: 500 });
      const run = await runExport();
      expect(run).toMatchObject({ outcome: "failure", failureClass: "invalid_response" });
      expect(run.summary).toMatch(/^n8n-export: 差分 \d+ 件を GitHub に起票できなかった/);
      expect(gh().branches.has(branchOfToday())).toBe(false);
      expect(gh().pulls).toEqual([]);
    });

    it("入力: GitHub のトークンが違えば（401）failure（auth_failed）", async () => {
      gh().fail(() => true, { status: 401, body: { message: "Bad credentials" } });
      const run = await runExport();
      expect(run).toMatchObject({ outcome: "failure", failureClass: "auth_failed" });
      expect(logs()).not.toContain(GITHUB_TOKEN);
    });
  });
});
