import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// git（子プロセス）と HTTP（公開サイト・GitHub・本番の n8n）は差し替える。実リポジトリ・実サービスには繋がない
type Callback = (error: Error | null, stdout: string, stderr: string) => void;
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { ARTICLE_GRACE_MS, type DriftResult, checkN8nWorkflows, checkSiteArticles, checkSiteRedeploy } from "../../src/status/drift.js";
import { toIsoJst } from "../../src/time.js";

const TOKEN = "github_pat_SECRET_TOKEN_value_1234567890";
const COMMIT = "1".repeat(40);
const NEWER = "2".repeat(40);
const NEWEST = "3".repeat(40);
const BUILT_AT = "2026-11-02T07:29:00.000Z";
const REPOSITORY = "ComeGin/systematization-of-the-business-foundation";
const SITE = "https://comegin.com";
const N8N = { baseUrl: "https://n8n.example.test", apiKey: "n8n_api_key_SECRET_value" };

let dir: string;
let tokenFile: string;
let fetchMock: ReturnType<typeof vi.fn>;

const signal = () => new AbortController().signal;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** git のサブコマンド（-C <checkout> の次）ごとの応答 */
type GitHandler = (args: string[]) => { code?: number; stdout?: string; stderr?: string };
function mockGit(handler: GitHandler) {
  execFileMock.mockImplementation((_file: string, args: string[], _options: unknown, callback: Callback) => {
    const result = handler(args.slice(2));
    if (result.code) callback(Object.assign(new Error("failed"), { code: result.code }), result.stdout ?? "", result.stderr ?? "");
    else callback(null, result.stdout ?? "", result.stderr ?? "");
    return {};
  });
}
const gitCalls = () => execFileMock.mock.calls.map((call) => (call[1] as string[]).slice(2));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drift-test-"));
  tokenFile = join(dir, "github-token");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  execFileMock.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const siteOptions = () => ({ checkout: "/srv/main", siteUrl: SITE, repository: REPOSITORY, tokenFile, signal: signal() });

/** build-info.json と GitHub の PR の応答 */
function mockHttp(options: { buildInfo?: Response; pulls?: Record<string, number> } = {}) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === `${SITE}/build-info.json`) return options.buildInfo ?? json({ commit: COMMIT, builtAt: BUILT_AT });
    const match = /commits\/([0-9a-f]{40})\/pulls$/.exec(url);
    if (match) {
      const number = options.pulls?.[match[1]!];
      return json(number === undefined ? [] : [{ number, merged_at: "2026-11-03T00:00:00Z" }]);
    }
    throw new Error(`想定外の URL: ${url}`);
  });
}

describe("checkSiteRedeploy", () => {
  describe("正常系", () => {
    it("入力: commit..origin/main に verdant-virgo の変更が 0 件なら ok", async () => {
      mockHttp();
      mockGit((args) => (args[0] === "log" ? { stdout: "" } : { stdout: "" }));
      const result = await checkSiteRedeploy(siteOptions());
      expect(result).toEqual({
        id: "site-redeploy",
        level: "ok",
        evidence: `配信中のビルド ${BUILT_AT}（1111111）以降、公開サイトの変更なし`,
      });
      const log = gitCalls().find((args) => args[0] === "log")!;
      expect(log).toEqual(["log", "--format=%H%x09%cI%x09%s", `${COMMIT}..origin/main`, "--", "frontend/verdant-virgo"]);
    });

    it("入力: 変更が 1 件以上なら action。件数・最初と最後のコミット・PR 番号を根拠に出す", async () => {
      mockHttp({ pulls: { [NEWER]: 60, [NEWEST]: 62 } });
      mockGit((args) =>
        args[0] === "log"
          ? {
              stdout: [
                `${NEWEST}\t2026-11-03T05:00:00+09:00\tfix: 新しい修正`,
                `${NEWER}\t2026-11-03T01:00:00+09:00\tmod: 設定ファイル`,
              ].join("\n"),
            }
          : {},
      );
      const result = await checkSiteRedeploy(siteOptions());
      expect(result.level).toBe("action");
      expect(result.evidence).toBe(
        `配信中のビルド ${BUILT_AT}（1111111）の後に、公開サイトの変更が 2 件: 最初 2222222 mod: 設定ファイル（PR #60） 〜 最後 3333333 fix: 新しい修正（PR #62）`,
      );
      // PR の取得には読み取り専用のトークンを付ける
      const pullCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/pulls"))!;
      expect((pullCall[1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    });

    it("入力: 1 件だけなら最初と最後を分けずに 1 つ出す", async () => {
      mockHttp({ pulls: { [NEWER]: 60 } });
      mockGit((args) => (args[0] === "log" ? { stdout: `${NEWER}\t2026-11-03T01:00:00+09:00\tmod: 設定` } : {}));
      const result = await checkSiteRedeploy(siteOptions());
      expect(result.evidence).toBe(`配信中のビルド ${BUILT_AT}（1111111）の後に、公開サイトの変更が 1 件: 2222222 mod: 設定（PR #60）`);
    });

    it("入力: PR 番号が取れなければコミットだけを出す（action のまま）", async () => {
      mockHttp();
      fetchMock.mockImplementation(async (url: string) => {
        if (String(url).endsWith("/build-info.json")) return json({ commit: COMMIT, builtAt: BUILT_AT });
        return json({ message: "boom" }, 500);
      });
      mockGit((args) => (args[0] === "log" ? { stdout: `${NEWER}\t2026-11-03T01:00:00+09:00\tmod: 設定` } : {}));
      const result = await checkSiteRedeploy(siteOptions());
      expect(result.level).toBe("action");
      expect(result.evidence).toContain("2222222 mod: 設定");
      expect(result.evidence).not.toContain("PR #");
    });

    it("入力: git は読み取りのサブコマンドだけを使う", async () => {
      mockHttp();
      mockGit(() => ({ stdout: "" }));
      await checkSiteRedeploy(siteOptions());
      const allowed = new Set(["log", "show", "rev-parse", "ls-tree", "merge-base"]);
      expect(gitCalls().every((args) => allowed.has(args[0]!))).toBe(true);
    });
  });

  describe("異常系", () => {
    it("サーバ: build-info が 404 なら action", async () => {
      mockHttp({ buildInfo: new Response("<html>not found</html>", { status: 404 }) });
      mockGit(() => ({}));
      const result = await checkSiteRedeploy(siteOptions());
      expect(result).toEqual({
        id: "site-redeploy",
        level: "action",
        evidence: "配信中のビルドにビルドの情報が無い。この機能より前のビルド",
      });
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("サーバ: 公開サイトに届かなければ unknown", async () => {
      fetchMock.mockRejectedValue(new TypeError("fetch failed"));
      vi.useFakeTimers();
      const promise = checkSiteRedeploy(siteOptions());
      await vi.runAllTimersAsync();
      const result = await promise;
      vi.useRealTimers();
      expect(result.level).toBe("unknown");
      expect(result.evidence).toContain("build-info.json に届かない");
    });

    it("サーバ: build-info の commit が null なら unknown（判定できない）", async () => {
      mockHttp({ buildInfo: json({ commit: null, builtAt: BUILT_AT }) });
      const result = await checkSiteRedeploy(siteOptions());
      expect(result.level).toBe("unknown");
      expect(result.evidence).toContain("コミットの情報が無い");
    });

    it("サーバ: build-info が JSON でなければ unknown", async () => {
      mockHttp({ buildInfo: new Response("<html>spa</html>", { status: 200 }) });
      const result = await checkSiteRedeploy(siteOptions());
      expect(result.level).toBe("unknown");
    });

    it("入力: 配信中のコミットが origin/main の履歴に無ければ unknown", async () => {
      mockHttp();
      mockGit((args) => (args[0] === "merge-base" ? { code: 1 } : {}));
      const result = await checkSiteRedeploy(siteOptions());
      expect(result.level).toBe("unknown");
      expect(result.evidence).toContain("origin/main の履歴に無い");
    });

    it("入力: git log が失敗したら unknown", async () => {
      mockHttp();
      mockGit((args) => (args[0] === "log" ? { code: 128, stderr: "fatal: bad revision" } : {}));
      const result = await checkSiteRedeploy(siteOptions());
      expect(result.level).toBe("unknown");
    });

    it("入力: トークンのファイルが読めなくても判定はでき、根拠にトークンを出さない", async () => {
      rmSync(tokenFile);
      mockHttp();
      mockGit((args) => (args[0] === "log" ? { stdout: `${NEWER}\t2026-11-03T01:00:00+09:00\tmod: 設定` } : {}));
      const result = await checkSiteRedeploy(siteOptions());
      expect(result.level).toBe("action");
      expect(result.evidence).not.toContain("PR #");
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it("入力: 根拠にもログにもトークンを出さない", async () => {
      mockHttp({ pulls: { [NEWER]: 60 } });
      mockGit((args) => (args[0] === "log" ? { stdout: `${NEWER}\t2026-11-03T01:00:00+09:00\tmod: 設定` } : {}));
      const result = await checkSiteRedeploy(siteOptions());
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(TOKEN);
    });
  });
});

// ---------------------------------------------------------------------------

interface TestNode {
  name: string;
  type: string;
  parameters: Record<string, unknown>;
  position?: [number, number];
  id?: string;
  credentials?: Record<string, unknown>;
}
const node = (over: Partial<TestNode> = {}): TestNode => ({
  id: "node-id-1",
  name: "5 分ごと",
  type: "n8n-nodes-base.scheduleTrigger",
  parameters: { rule: { interval: [{ field: "minutes", minutesInterval: 5 }] } },
  position: [0, 0],
  ...over,
});
const workflow = (name: string, nodes: TestNode[] = [node()], connections: unknown = { "5 分ごと": { main: [[{ node: "B", type: "main", index: 0 }]] } }) => ({
  name,
  nodes,
  connections,
  active: true,
});

/**
 * origin/main の workflows/*.json（ファイル名 → 本文）と、本番の n8n（id → 本文）を用意する。
 * table は provision/workflows.json の中身（省略すると、repo の全ファイルを dev・prod の両方に取り込む表）
 */
function mockN8n(
  repo: Record<string, unknown>,
  prod: Record<string, { id: string; body: unknown; isArchived?: boolean }>,
  table: unknown = Object.keys(repo).map((file) => ({ file, publish: "never", tags: [], targets: ["dev", "prod"] })),
) {
  mockGit((args) => {
    if (args[0] === "show" && args[1] === "origin/main:middleware/n8n/provision/workflows.json") {
      return typeof table === "string" ? { stdout: table } : table === null ? { code: 128 } : { stdout: JSON.stringify(table) };
    }
    if (args[0] === "show") {
      const file = args[1]!.replace("origin/main:middleware/n8n/workflows/", "");
      return repo[file] === undefined ? { code: 128 } : { stdout: JSON.stringify(repo[file]) };
    }
    return {};
  });
  fetchMock.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/v1/workflows") {
      return json({
        data: Object.values(prod).map((entry) => ({ id: entry.id, name: (entry.body as { name: string }).name, isArchived: entry.isArchived === true })),
        nextCursor: null,
      });
    }
    const id = decodeURIComponent(path.replace("/api/v1/workflows/", ""));
    const found = Object.values(prod).find((entry) => entry.id === id);
    return found ? json(found.body) : json({ message: "not found" }, 404);
  });
}

const n8nOptions = (n8n: { baseUrl: string; apiKey: string } | null = N8N) => ({ checkout: "/srv/main", n8n, signal: signal() });

describe("checkN8nWorkflows", () => {
  describe("正常系", () => {
    it("入力: ノード・接続・スケジュールが同じなら ok", async () => {
      const body = workflow("I-21 通知");
      mockN8n({ "I-21.json": body }, { a: { id: "a", body } });
      const result = await checkN8nWorkflows(n8nOptions());
      expect(result).toEqual({ id: "n8n-workflows", level: "ok", evidence: "origin/main の 1 件のワークフローが、本番の n8n と一致" });
    });

    it("サーバ: 位置・ノード id・updatedAt・資格情報の id だけが違えば ok", async () => {
      const repo = workflow("I-21 通知", [node({ position: [0, 0], credentials: { aws: { id: "1", name: "AWS" } } })]);
      const prodBody = {
        ...workflow("I-21 通知", [node({ position: [640, 320], id: "other-id", credentials: { aws: { id: "99", name: "AWS" } } })]),
        updatedAt: "2026-11-03T00:00:00.000Z",
        id: "a",
        versionId: "v2",
      };
      mockN8n({ "I-21.json": repo }, { a: { id: "a", body: prodBody } });
      expect((await checkN8nWorkflows(n8nOptions())).level).toBe("ok");
    });

    it("サーバ: パラメータのキーの順が違うだけなら ok", async () => {
      const repo = workflow("W", [node({ parameters: { a: 1, b: { c: 2, d: 3 } } })]);
      const prodBody = workflow("W", [node({ parameters: { b: { d: 3, c: 2 }, a: 1 } })]);
      mockN8n({ "W.json": repo }, { a: { id: "a", body: prodBody } });
      expect((await checkN8nWorkflows(n8nOptions())).level).toBe("ok");
    });

    it("サーバ: リポジトリに無い本番だけのワークフローは無視する", async () => {
      const body = workflow("I-21 通知");
      mockN8n(
        { "I-21.json": body },
        { a: { id: "a", body }, z: { id: "z", body: workflow("試作のワークフロー", [node({ name: "x" })]) } },
      );
      expect((await checkN8nWorkflows(n8nOptions())).level).toBe("ok");
    });

    it("入力: 本番に取り込む表が空なら ok（比べるものが無い）で、n8n を呼ばない", async () => {
      mockN8n({}, {}, []);
      const result = await checkN8nWorkflows(n8nOptions());
      expect(result.level).toBe("ok");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("入力: git は読み取りのサブコマンドだけを使い、n8n には GET だけを送る", async () => {
      const body = workflow("I-21 通知");
      mockN8n({ "I-21.json": body }, { a: { id: "a", body } });
      await checkN8nWorkflows(n8nOptions());
      expect(gitCalls().every((args) => args[0] === "show")).toBe(true);
      expect(gitCalls()[0]).toEqual(["show", "origin/main:middleware/n8n/provision/workflows.json"]);
      expect(fetchMock.mock.calls.every((call) => (call[1] as RequestInit).method === "GET")).toBe(true);
    });
  });

  describe("正常系（本番への取り込みで変わる値）", () => {
    const parent = (childId: string, childName = "I-21 通知") =>
      workflow("I-11 親", [
        node({ name: "子を呼ぶ", type: "n8n-nodes-base.executeWorkflow", parameters: { workflowId: { __rl: true, mode: "id", value: childId, cachedResultName: childName } } }),
      ]);

    it("サーバ: 子を呼ぶノードの workflowId.value（開発の id と本番の id）だけが違えば ok", async () => {
      mockN8n({ "I-11.json": parent("RQ7X76GAXdPBcszO") }, { a: { id: "a", body: parent("prodChildId9999") } });
      expect((await checkN8nWorkflows(n8nOptions())).level).toBe("ok");
    });

    it("サーバ: 子を呼ぶノードの呼び出し先の名前（cachedResultName）が違えば action", async () => {
      mockN8n({ "I-11.json": parent("RQ7X76GAXdPBcszO", "I-21 通知") }, { a: { id: "a", body: parent("RQ7X76GAXdPBcszO", "別の子") } });
      const result = await checkN8nWorkflows(n8nOptions());
      expect(result.level).toBe("action");
      expect(result.evidence).toContain("子を呼ぶ");
    });

    it("入力: 開発だけに取り込むワークフロー（ops-monitor。targets が dev）は、本番に無くても比べない", async () => {
      const body = workflow("I-21 通知");
      mockN8n(
        { "I-21.json": body, "ops-monitor.json": workflow("運用監視") },
        { a: { id: "a", body } },
        [
          { file: "I-21.json", publish: "always", tags: [], targets: ["dev", "prod"] },
          { file: "ops-monitor.json", publish: "never", tags: [], targets: ["dev"] },
        ],
      );
      const result = await checkN8nWorkflows(n8nOptions());
      expect(result).toEqual({ id: "n8n-workflows", level: "ok", evidence: "origin/main の 1 件のワークフローが、本番の n8n と一致" });
      // 開発だけのファイルは git show もしない
      expect(gitCalls().some((args) => args[1]?.endsWith("ops-monitor.json"))).toBe(false);
    });

    it("入力: 表に載っていないファイルは比べない", async () => {
      const body = workflow("I-21 通知");
      mockN8n({ "I-21.json": body, "memo.json": workflow("メモ") }, { a: { id: "a", body } }, [
        { file: "I-21.json", publish: "always", tags: [], targets: ["prod"] },
      ]);
      expect((await checkN8nWorkflows(n8nOptions())).level).toBe("ok");
    });
  });

  describe("異常系", () => {
    it("サーバ: ノードの typeVersion だけが違えば action", async () => {
      const repo = workflow("W", [{ ...node(), typeVersion: 1.2 } as TestNode]);
      const prodBody = workflow("W", [{ ...node(), typeVersion: 1.3 } as TestNode]);
      mockN8n({ "W.json": repo }, { a: { id: "a", body: prodBody } });
      const result = await checkN8nWorkflows(n8nOptions());
      expect(result.level).toBe("action");
      expect(result.evidence).toContain("W（ノード「5 分ごと」の設定）");
    });

    it("入力: 本番に取り込む表を origin/main から読めなければ unknown", async () => {
      mockN8n({ "W.json": workflow("W") }, {}, null);
      const result = await checkN8nWorkflows(n8nOptions());
      expect(result.level).toBe("unknown");
      expect(result.evidence).toContain("workflows.json");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("入力: 表が JSON でなければ unknown", async () => {
      mockN8n({ "W.json": workflow("W") }, {}, "これは JSON ではない");
      expect((await checkN8nWorkflows(n8nOptions())).level).toBe("unknown");
    });

    it("入力: 表の file にディレクトリをたどる名前があっても読まない", async () => {
      mockN8n({ "W.json": workflow("W") }, {}, [{ file: "../../../etc/x.json", targets: ["prod"] }]);
      const result = await checkN8nWorkflows(n8nOptions());
      expect(result.level).toBe("ok");
      expect(gitCalls().filter((args) => args[1]?.includes("etc")).length).toBe(0);
    });

    it("サーバ: n8n のノードのパラメータだけが違えば action", async () => {
      const repo = workflow("I-21 通知");
      const prodBody = workflow("I-21 通知", [node({ parameters: { rule: { interval: [{ field: "minutes", minutesInterval: 10 }] } } })]);
      mockN8n({ "I-21.json": repo }, { a: { id: "a", body: prodBody } });
      const result = await checkN8nWorkflows(n8nOptions());
      expect(result.level).toBe("action");
      expect(result.evidence).toBe("本番の n8n が origin/main のワークフローと違う（1 件）: I-21 通知（ノード「5 分ごと」の設定）");
    });

    it("サーバ: 接続だけが違えば action", async () => {
      const repo = workflow("W");
      const prodBody = workflow("W", [node()], {});
      mockN8n({ "W.json": repo }, { a: { id: "a", body: prodBody } });
      const result = await checkN8nWorkflows(n8nOptions());
      expect(result.level).toBe("action");
      expect(result.evidence).toContain("W（ノードの接続）");
    });

    it("サーバ: ノードが増えていれば action", async () => {
      const repo = workflow("W", [node(), node({ name: "追加", id: "n2" })]);
      mockN8n({ "W.json": repo }, { a: { id: "a", body: workflow("W") } });
      const result = await checkN8nWorkflows(n8nOptions());
      expect(result.level).toBe("action");
      expect(result.evidence).toContain("W（ノードの追加・削除）");
    });

    it("サーバ: リポジトリにあって本番に無いワークフローは action", async () => {
      mockN8n({ "W.json": workflow("W") }, {});
      const result = await checkN8nWorkflows(n8nOptions());
      expect(result.level).toBe("action");
      expect(result.evidence).toContain("W（本番に無い）");
    });

    it("サーバ: 本番側でアーカイブ済みのものは無いものとして扱う", async () => {
      const body = workflow("W");
      mockN8n({ "W.json": body }, { a: { id: "a", body, isArchived: true } });
      const result = await checkN8nWorkflows(n8nOptions());
      expect(result.level).toBe("action");
      expect(result.evidence).toContain("本番に無い");
    });

    it("入力: 違うワークフローが 5 件を超えたら先頭の 5 件と残りの件数を出す", async () => {
      const repo: Record<string, unknown> = {};
      for (let i = 1; i <= 7; i++) repo[`w${i}.json`] = workflow(`w${i}`);
      mockN8n(repo, {});
      const result = await checkN8nWorkflows(n8nOptions());
      expect(result.evidence).toContain("（7 件）");
      expect(result.evidence).toContain("ほか 2 件");
      expect(result.evidence).toContain("w5（本番に無い）");
      expect(result.evidence).not.toContain("w6");
    });

    it("空入力: n8n の設定（CONTROL_N8N_EXPORT_*）が無ければ、? ではなく ◇（判断待ち）にし、git も n8n も呼ばない", async () => {
      const result = await checkN8nWorkflows(n8nOptions(null));
      expect(result).toEqual({
        id: "n8n-workflows",
        level: "manual",
        evidence:
          "本番の n8n の API キー（CONTROL_N8N_EXPORT_*）が無いので比べない（daily-n8n-export の判断待ち。setup/00-setup-overview.md の 6 節）",
      });
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("サーバ: 本番の n8n が 401 なら unknown で、根拠に API キーを出さない", async () => {
      mockN8n({ "W.json": workflow("W") }, {});
      fetchMock.mockImplementation(async () => json({ message: "unauthorized" }, 401));
      const result = await checkN8nWorkflows(n8nOptions());
      expect(result.level).toBe("unknown");
      expect(result.evidence).toContain("auth_failed");
      expect(JSON.stringify(result)).not.toContain(N8N.apiKey);
    });

    it("入力: origin/main のファイルを git で読めなければ unknown", async () => {
      mockGit(() => ({ code: 128, stderr: "fatal: not a tree object" }));
      const result = await checkN8nWorkflows(n8nOptions());
      expect(result.level).toBe("unknown");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------

const STRAPI = { baseUrl: "https://cms.example.test", readToken: "strapi_read_token_SECRET_value" };
const NOW = new Date("2026-11-11T03:00:00.000Z"); // 12:00 JST
const HOUR = 60 * 60 * 1000;
/** NOW から h 時間前（Strapi と同じく UTC の ISO 8601） */
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR).toISOString();

interface TestArticle {
  slug: string;
  publishedAt: string;
  updatedAt: string;
}
const article = (slug: string, publishedHoursAgo: number, updatedHoursAgo = publishedHoursAgo): TestArticle => ({
  slug,
  publishedAt: ago(publishedHoursAgo),
  updatedAt: ago(updatedHoursAgo),
});

/** 配信中の build-info.json（articles）と、本番の Strapi の公開済みの記事 */
function mockArticles(options: { buildInfo?: Response; deployed?: TestArticle[] | null; strapi?: TestArticle[] | Response }) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === `${SITE}/build-info.json`) {
      return options.buildInfo ?? json({ commit: COMMIT, builtAt: BUILT_AT, articles: options.deployed === undefined ? [] : options.deployed });
    }
    if (String(url).startsWith(`${STRAPI.baseUrl}/api/articles?`)) {
      if (options.strapi instanceof Response) return options.strapi;
      const rows = (options.strapi ?? []).map((a, i) => ({ id: i + 1, documentId: `doc${i + 1}`, ...a }));
      return json({ data: rows, meta: { pagination: { page: 1, pageCount: 1, pageSize: 100, total: rows.length } } });
    }
    throw new Error(`想定外の URL: ${url}`);
  });
}

const articlesOptions = (
  over: { strapi?: { baseUrl: string; readToken: string } | null; previous?: DriftResult; now?: Date } = {},
) => ({
  siteUrl: SITE,
  strapi: over.strapi === undefined ? STRAPI : over.strapi,
  previous: over.previous,
  now: over.now ?? NOW,
  signal: signal(),
});

describe("checkSiteArticles", () => {
  describe("正常系", () => {
    it("入力: 猶予は 48 時間", () => {
      expect(ARTICLE_GRACE_MS).toBe(48 * HOUR);
    });

    it("入力: 配信中の記事と本番の Strapi の公開済みの記事が同じなら ok", async () => {
      const a = article("a", 100);
      mockArticles({ deployed: [a], strapi: [a] });
      const result = await checkSiteArticles(articlesOptions());
      expect(result.id).toBe("site-articles");
      expect(result.level).toBe("ok");
      expect(result.evidence).toContain("一致");
      expect(result.firstSeen).toBeUndefined();
    });

    it("入力: 公開から 47 時間の記事だけが未配信なら ok で、根拠に「配信待ち 1 件（猶予中」", async () => {
      const a = article("a", 100);
      mockArticles({ deployed: [a], strapi: [a, article("b", 47)] });
      const result = await checkSiteArticles(articlesOptions());
      expect(result.level).toBe("ok");
      expect(result.evidence).toContain("配信待ち 1 件（猶予中");
      // 期限は公開の 48 時間後（NOW の 1 時間後）。JST で出す
      expect(result.evidence).toContain(`最も古いものの期限 ${toIsoJst(new Date(NOW.getTime() + HOUR))}`);
    });

    it("入力: 公開から 48 時間ちょうどの記事が未配信なら action で、根拠に slug", async () => {
      const a = article("a", 100);
      mockArticles({ deployed: [a], strapi: [a, article("new-post", 48)] });
      const result = await checkSiteArticles(articlesOptions());
      expect(result.level).toBe("action");
      expect(result.evidence).toContain("new-post（公開）");
      expect(result.evidence).toContain("周の承認画面の配信の項目を承認して配信する（無ければ毎日 00:00 に作られる）");
    });

    it("入力: updatedAt が build-info と違い、49 時間たっていれば action（更新）", async () => {
      mockArticles({ deployed: [article("a", 100, 100)], strapi: [article("a", 100, 49)] });
      const result = await checkSiteArticles(articlesOptions());
      expect(result.level).toBe("action");
      expect(result.evidence).toContain("a（更新）");
    });

    it("入力: 公開と更新の新しいほうから数える（公開が古くても更新が 10 時間前なら猶予中）", async () => {
      mockArticles({ deployed: [article("a", 100, 100)], strapi: [article("a", 100, 10)] });
      const result = await checkSiteArticles(articlesOptions());
      expect(result.level).toBe("ok");
      expect(result.evidence).toContain("配信待ち 1 件（猶予中");
    });

    it("入力: 取り下げは previous.firstSeen から数え、結果の firstSeen に引き継ぐ", async () => {
      const a = article("a", 100);
      const gone = article("gone", 200);
      mockArticles({ deployed: [a, gone], strapi: [a] });

      // 前回の記録が無ければ、今見つけた時刻から数える（猶予中）
      const first = await checkSiteArticles(articlesOptions());
      expect(first.level).toBe("ok");
      expect(first.evidence).toContain("配信待ち 1 件（猶予中");
      expect(first.firstSeen).toEqual({ gone: toIsoJst(NOW) });

      // 47 時間後: 前回の時刻を引き継ぎ、まだ猶予中
      const later = new Date(NOW.getTime() + 47 * HOUR);
      const second = await checkSiteArticles(articlesOptions({ previous: first, now: later }));
      expect(second.level).toBe("ok");
      expect(second.firstSeen).toEqual({ gone: toIsoJst(NOW) });

      // 48 時間後: 過ぎたので action
      const third = await checkSiteArticles(articlesOptions({ previous: second, now: new Date(NOW.getTime() + 48 * HOUR) }));
      expect(third.level).toBe("action");
      expect(third.evidence).toContain("gone（取り下げ）");
      expect(third.firstSeen).toEqual({ gone: toIsoJst(NOW) });
    });

    it("入力: 取り下げが解消したら firstSeen から消える", async () => {
      const a = article("a", 100);
      mockArticles({ deployed: [a], strapi: [a] });
      const previous: DriftResult = { id: "site-articles", level: "ok", evidence: "x", firstSeen: { gone: toIsoJst(NOW) } };
      const result = await checkSiteArticles(articlesOptions({ previous }));
      expect(result.level).toBe("ok");
      expect(result.firstSeen).toBeUndefined();
    });

    it("入力: 未配信が 7 件なら slug は 5 件と「ほか 2 件」", async () => {
      const strapi = [1, 2, 3, 4, 5, 6, 7].map((n) => article(`post-${n}`, 100 + n));
      mockArticles({ deployed: [], strapi });
      const result = await checkSiteArticles(articlesOptions());
      expect(result.level).toBe("action");
      expect(result.evidence).toContain("7 件");
      expect(result.evidence).toContain("ほか 2 件");
      expect(result.evidence.match(/post-\d（公開）/g)?.length).toBe(5);
    });

    it("入力: 根拠にトークンを出さず、Strapi には読み取りのトークンだけを付ける", async () => {
      mockArticles({ deployed: [], strapi: [article("a", 100)] });
      const result = await checkSiteArticles(articlesOptions());
      expect(JSON.stringify(result)).not.toContain(STRAPI.readToken);
      const strapiCall = fetchMock.mock.calls.find((call) => String(call[0]).startsWith(STRAPI.baseUrl))!;
      expect((strapiCall[1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${STRAPI.readToken}` });
      expect(String(strapiCall[0])).toContain("status=published");
    });
  });

  describe("異常系", () => {
    it("入力: build-info に articles のキーが無いと action、null なら unknown", async () => {
      mockArticles({ buildInfo: json({ commit: COMMIT, builtAt: BUILT_AT }), strapi: [article("a", 100)] });
      const missing = await checkSiteArticles(articlesOptions());
      expect(missing.level).toBe("action");
      expect(missing.evidence).toContain("記録が無い");
      expect(missing.evidence).toContain("次の配信で消える");

      mockArticles({ deployed: null, strapi: [article("a", 100)] });
      const nulled = await checkSiteArticles(articlesOptions());
      expect(nulled.level).toBe("unknown");
    });

    it("サーバ: build-info が 404 なら action（記録が無い）", async () => {
      mockArticles({ buildInfo: new Response("<html>not found</html>", { status: 404 }), strapi: [] });
      const result = await checkSiteArticles(articlesOptions());
      expect(result.level).toBe("action");
      expect(result.evidence).toContain("次の配信で消える");
    });

    it("入力: strapi が null なら manual で、fetch を呼ばない", async () => {
      mockArticles({ deployed: [], strapi: [] });
      const result = await checkSiteArticles(articlesOptions({ strapi: null }));
      expect(result.level).toBe("manual");
      expect(result.evidence).toContain("CONTROL_STRAPI_");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("入力: Strapi が 503 なら unknown", async () => {
      mockArticles({ deployed: [], strapi: json({ error: "unavailable" }, 503) });
      vi.useFakeTimers();
      const promise = checkSiteArticles(articlesOptions());
      await vi.runAllTimersAsync();
      const result = await promise;
      vi.useRealTimers();
      expect(result.level).toBe("unknown");
      expect(result.evidence).toContain("本番の Strapi");
      expect(JSON.stringify(result)).not.toContain(STRAPI.readToken);
    });

    it("入力: Strapi に届かなくても、前回の取り下げの時刻（firstSeen）は捨てない", async () => {
      mockArticles({ deployed: [], strapi: json({ error: "unauthorized" }, 401) });
      const previous: DriftResult = { id: "site-articles", level: "ok", evidence: "x", firstSeen: { gone: "2026-11-10T12:00:00.000+09:00" } };
      const result = await checkSiteArticles(articlesOptions({ previous }));
      expect(result.level).toBe("unknown");
      expect(result.firstSeen).toEqual({ gone: "2026-11-10T12:00:00.000+09:00" });
    });

    it("サーバ: build-info の articles が配列でなければ unknown", async () => {
      mockArticles({ buildInfo: json({ commit: COMMIT, builtAt: BUILT_AT, articles: "x" }), strapi: [] });
      const result = await checkSiteArticles(articlesOptions());
      expect(result.level).toBe("unknown");
    });
  });
});
