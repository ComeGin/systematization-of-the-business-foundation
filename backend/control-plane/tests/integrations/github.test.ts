import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubClient } from "../../src/integrations/github.js";
import { IntegrationError } from "../../src/integrations/http.js";

// GitHub の REST API は global fetch のモックで差し替える（実 GitHub には繋がない）
const config = {
  token: "ghp_test_token",
  repository: "kamegin4-aws/business-foundation",
  baseBranch: "main",
  issueNumber: 13,
  reviewer: "kamegin4-aws",
};
const REPO_API = "https://api.github.com/repos/kamegin4-aws/business-foundation";

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const call = (index = -1) => {
  const [url, init] = fetchMock.mock.calls.at(index) as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
};
const routes = () => fetchMock.mock.calls.map((c) => `${(c[1] as RequestInit).method} ${String(c[0]).replace(REPO_API, "")}`);

/** 失敗の例外を取り出す（投げなければテストを落とす）。 */
async function errorOf(promise: Promise<unknown>): Promise<IntegrationError> {
  const error = await promise.then(
    () => {
      throw new Error("例外にならなかった");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(IntegrationError);
  return error as IntegrationError;
}

const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.useRealTimers());

describe("GitHubClient の共通の呼び出し", () => {
  describe("正常系", () => {
    it("リポジトリの REST API に Bearer トークンと API の版を付けて呼ぶ（タイムアウト 30 秒）", async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      fetchMock.mockResolvedValue(json({ object: { sha: "abc" } }));
      await new GitHubClient(config).branchSha("main");
      const { url, init, headers } = call();
      expect(url).toBe(`${REPO_API}/git/ref/heads/main`);
      expect(init.method).toBe("GET");
      expect(headers).toMatchObject({
        Authorization: "Bearer ghp_test_token",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      });
      expect(headers).not.toHaveProperty("Content-Type");
      expect(timeout).toHaveBeenCalledWith(30_000);
    });
  });

  describe("異常系", () => {
    it("サーバ: 接続できなければ再試行の後に unreachable の IntegrationError", async () => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(async () => {
        throw new TypeError("fetch failed");
      });
      const pending = errorOf(new GitHubClient(config).branchSha("main"));
      await vi.advanceTimersByTimeAsync(12_000);
      expect((await pending).failureClass).toBe("unreachable");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("入力: 外から打ち切られていれば timeout で、再試行しない", async () => {
      const stop = new AbortController();
      stop.abort();
      fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
        if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
        return json({});
      });
      expect((await errorOf(new GitHubClient(config, stop.signal).branchSha("main"))).failureClass).toBe("timeout");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe("GitHubClient.fileExists", () => {
  describe("正常系", () => {
    it("200 なら true、404 なら false。パスは区切りを残して符号化する", async () => {
      const client = new GitHubClient(config);
      fetchMock.mockResolvedValueOnce(json({}));
      expect(await client.fileExists("docs/proposals/PRP 1.md", "13-feature-x")).toBe(true);
      expect(call().url).toBe(`${REPO_API}/contents/docs/proposals/PRP%201.md?ref=13-feature-x`);
      fetchMock.mockResolvedValueOnce(json({ message: "Not Found" }, 404));
      expect(await client.fileExists("docs/proposals/PRP-2026-0001.md", "main")).toBe(false);
    });

    it("空入力: 本文の無い 200 でも true", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
      expect(await new GitHubClient(config).fileExists("a.md", "main")).toBe(true);
    });
  });

  describe("異常系", () => {
    it("サーバ: 404 以外の失敗は IntegrationError（トークンをメッセージに含めない）", async () => {
      fetchMock.mockResolvedValue(json({}, 401));
      const error = await errorOf(new GitHubClient(config).fileExists("a.md", "main"));
      expect(error.failureClass).toBe("auth_failed");
      expect(error.message).not.toContain("ghp_test_token");
      expect(fetchMock).toHaveBeenCalledTimes(1); // 401 は再試行しない
    });
  });
});

describe("GitHubClient.getFileText", () => {
  const path = "MarketingDepartment/WebsiteOperations/middleware/n8n/workflows/I-11 x.json";

  describe("正常系", () => {
    it("ref のファイルを Contents API で読み、base64 の本文を UTF-8 の文字列にする", async () => {
      fetchMock.mockResolvedValueOnce(json({ encoding: "base64", content: base64('{\n  "name": "日本語"\n}\n') }));
      expect(await new GitHubClient(config).getFileText(path, "release/2026-10")).toBe('{\n  "name": "日本語"\n}\n');
      expect(call().url).toBe(
        `${REPO_API}/contents/MarketingDepartment/WebsiteOperations/middleware/n8n/workflows/I-11%20x.json?ref=release%2F2026-10`,
      );
      expect(call().init.method).toBe("GET");
    });

    it("GitHub が 60 文字ごとに入れる改行つきの base64 も読める", async () => {
      const text = "x".repeat(200);
      const wrapped = base64(text).replace(/(.{60})/g, "$1\n");
      fetchMock.mockResolvedValueOnce(json({ encoding: "base64", content: wrapped }));
      expect(await new GitHubClient(config).getFileText("a.json", "main")).toBe(text);
    });

    it("404 なら null（まだ base に無いファイル）", async () => {
      fetchMock.mockResolvedValueOnce(json({ message: "Not Found" }, 404));
      expect(await new GitHubClient(config).getFileText("a.json", "main")).toBeNull();
    });

    it("空入力: 空のファイル（content が空文字）は空文字を返す", async () => {
      fetchMock.mockResolvedValueOnce(json({ encoding: "base64", content: "" }));
      expect(await new GitHubClient(config).getFileText("empty.json", "main")).toBe("");
    });
  });

  describe("異常系", () => {
    it("サーバ: 1 MB を超えるファイル（encoding が none）は空と取り違えず invalid_response", async () => {
      fetchMock.mockResolvedValueOnce(json({ encoding: "none", content: "" }));
      const error = await errorOf(new GitHubClient(config).getFileText("big.json", "main"));
      expect(error).toMatchObject({ failureClass: "invalid_response" });
      expect(error.message).toContain("1 MB");
    });

    it.each([
      ["ディレクトリ（配列）", [{ name: "a.json" }]],
      ["content が無い", { encoding: "base64" }],
      ["content が文字列でない", { encoding: "base64", content: 1 }],
    ])("サーバ: 想定外の応答（%s）は invalid_response", async (_label, body) => {
      fetchMock.mockResolvedValueOnce(json(body));
      expect((await errorOf(new GitHubClient(config).getFileText("a", "main"))).failureClass).toBe("invalid_response");
    });

    it("空入力: 本文の無い 200 は invalid_response", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
      expect((await errorOf(new GitHubClient(config).getFileText("a", "main"))).failureClass).toBe("invalid_response");
    });

    it.each([
      [401, "auth_failed"],
      [403, "permission_denied"],
      [500, "invalid_response"],
    ] as const)("サーバ: HTTP %s は %s（トークンをメッセージに含めない）", async (status, failureClass) => {
      fetchMock.mockImplementation(async () => json({ message: "x" }, status));
      const error = await errorOf(new GitHubClient(config).getFileText("a", "main"));
      expect(error).toMatchObject({ failureClass, message: `GitHub: ファイルの取得: ${failureClass} (HTTP ${status})` });
      expect(error.message).not.toContain("ghp_test_token");
    });
  });
});

describe("GitHubClient.branchSha", () => {
  describe("正常系", () => {
    it("ブランチの先頭のコミット SHA を返し、ブランチ名は区切りを残して符号化する", async () => {
      fetchMock.mockResolvedValueOnce(json({ object: { sha: "abc123" } }));
      expect(await new GitHubClient(config).branchSha("chore/n8n-export-20261007")).toBe("abc123");
      expect(call().url).toBe(`${REPO_API}/git/ref/heads/chore/n8n-export-20261007`);
    });

    it("404 なら null", async () => {
      fetchMock.mockResolvedValue(json({}, 404));
      expect(await new GitHubClient(config).branchSha("missing")).toBeNull();
    });

    it("空入力: 応答に object.sha が無ければ null", async () => {
      fetchMock.mockResolvedValueOnce(json({}));
      expect(await new GitHubClient(config).branchSha("main")).toBeNull();
    });
  });

  describe("異常系", () => {
    it("サーバ: 404 以外の失敗は IntegrationError", async () => {
      fetchMock.mockResolvedValue(json({}, 403));
      expect((await errorOf(new GitHubClient(config).branchSha("main"))).failureClass).toBe("permission_denied");
    });
  });
});

describe("GitHubClient.createBranch", () => {
  describe("正常系", () => {
    it("refs/heads/<branch> を作る。422（既にある）は続きとして成功扱い", async () => {
      const client = new GitHubClient(config);
      fetchMock.mockResolvedValueOnce(json({}, 201));
      await client.createBranch("13-feature-proposal-PRP-2026-0001", "abc");
      expect(call().init.method).toBe("POST");
      expect(call().headers["Content-Type"]).toBe("application/json");
      expect(call().body).toEqual({ ref: "refs/heads/13-feature-proposal-PRP-2026-0001", sha: "abc" });
      fetchMock.mockResolvedValueOnce(json({ message: "Reference already exists" }, 422));
      await expect(client.createBranch("x", "abc")).resolves.toBeUndefined();
    });

    it("空入力: 本文の無い 201 でも成功", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }));
      await expect(new GitHubClient(config).createBranch("x", "abc")).resolves.toBeUndefined();
    });
  });

  describe("異常系", () => {
    it("サーバ: 422 以外の失敗は IntegrationError", async () => {
      fetchMock.mockResolvedValue(json({}, 403));
      await expect(new GitHubClient(config).createBranch("x", "abc")).rejects.toMatchObject({
        failureClass: "permission_denied",
      });
    });
  });
});

describe("GitHubClient.putFile", () => {
  describe("正常系", () => {
    it("内容を base64 にして指定のブランチにコミットする", async () => {
      fetchMock.mockResolvedValue(json({}, 201));
      await new GitHubClient(config).putFile("docs/a.md", "b", "日本語の本文", "add: x");
      expect(call().init.method).toBe("PUT");
      expect(call().body).toEqual({
        message: "add: x",
        content: Buffer.from("日本語の本文", "utf8").toString("base64"),
        branch: "b",
      });
    });

    it("空入力: 空の内容は空の base64 として送る", async () => {
      fetchMock.mockResolvedValue(json({}, 201));
      await new GitHubClient(config).putFile("docs/a.md", "b", "", "add: x");
      expect(call().body.content).toBe("");
    });
  });

  describe("異常系", () => {
    it("サーバ: 409（ブランチの先頭が動いた）・422 は IntegrationError", async () => {
      fetchMock.mockResolvedValueOnce(json({}, 409));
      expect((await errorOf(new GitHubClient(config).putFile("a", "b", "c", "m"))).failureClass).toBe("invalid_response");
      fetchMock.mockResolvedValueOnce(json({}, 422));
      expect((await errorOf(new GitHubClient(config).putFile("a", "b", "c", "m"))).message).toBe(
        "GitHub: ファイルのコミット: invalid_response (HTTP 422)",
      );
    });
  });
});

describe("GitHubClient.commitFilesToNewBranch", () => {
  const input = {
    branch: "chore/n8n-export-20261007",
    baseSha: "base-sha",
    files: [
      { path: "W/middleware/n8n/workflows/a.json", content: '{"name":"a"}\n' },
      { path: "W/middleware/n8n/workflows/b.json", content: '{"name":"b"}\n' },
    ],
    message: "chore: n8n ワークフローの書き出し 2026-10-07",
  };

  /** ブランチの確認（404）→ base のコミット → tree → commit → ref の順の応答。 */
  function happyPath(): void {
    fetchMock
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({ sha: "base-sha", tree: { sha: "base-tree" } }))
      .mockResolvedValueOnce(json({ sha: "new-tree" }, 201))
      .mockResolvedValueOnce(json({ sha: "new-commit" }, 201))
      .mockResolvedValueOnce(json({ ref: "refs/heads/chore/n8n-export-20261007" }, 201));
  }

  describe("正常系", () => {
    it("tree → commit → ref の順に作り、ref を最後に作る（ブランチがある = コミットが済んでいる）", async () => {
      happyPath();
      expect(await new GitHubClient(config).commitFilesToNewBranch(input)).toBe("created");
      expect(routes()).toEqual([
        "GET /git/ref/heads/chore/n8n-export-20261007",
        "GET /git/commits/base-sha",
        "POST /git/trees",
        "POST /git/commits",
        "POST /git/refs",
      ]);
      expect(call(2).body).toEqual({
        base_tree: "base-tree",
        tree: input.files.map((file) => ({ path: file.path, mode: "100644", type: "blob", content: file.content })),
      });
      expect(call(3).body).toEqual({ message: input.message, tree: "new-tree", parents: ["base-sha"] });
      expect(call(4).body).toEqual({ ref: "refs/heads/chore/n8n-export-20261007", sha: "new-commit" });
    });

    it("既にブランチがあれば何も作らず exists（前回の続き）", async () => {
      fetchMock.mockResolvedValueOnce(json({ object: { sha: "existing" } }));
      expect(await new GitHubClient(config).commitFilesToNewBranch(input)).toBe("exists");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("ref の作成が 422（確認の後に別の実行が作った）なら exists", async () => {
      fetchMock
        .mockResolvedValueOnce(json({}, 404))
        .mockResolvedValueOnce(json({ tree: { sha: "base-tree" } }))
        .mockResolvedValueOnce(json({ sha: "new-tree" }, 201))
        .mockResolvedValueOnce(json({ sha: "new-commit" }, 201))
        .mockResolvedValueOnce(json({ message: "Reference already exists" }, 422));
      expect(await new GitHubClient(config).commitFilesToNewBranch(input)).toBe("exists");
    });

    it("空入力: ファイルが 0 件でも、空の tree の変更としてコミットを作る", async () => {
      happyPath();
      expect(await new GitHubClient(config).commitFilesToNewBranch({ ...input, files: [] })).toBe("created");
      expect(call(2).body).toEqual({ base_tree: "base-tree", tree: [] });
    });
  });

  describe("異常系", () => {
    it.each([
      ["ブランチの確認", 0, "GitHub: ブランチの確認"],
      ["base のコミットの取得", 1, "GitHub: base のコミットの取得"],
      ["tree の作成", 2, "GitHub: tree の作成"],
      ["コミットの作成", 3, "GitHub: コミットの作成"],
      ["ブランチの作成", 4, "GitHub: ブランチの作成"],
    ])("サーバ: %s の 5xx は IntegrationError で、その先に進まない", async (_label, failAt, what) => {
      const ok = [json({}, 404), json({ tree: { sha: "t" } }), json({ sha: "t2" }, 201), json({ sha: "c" }, 201), json({}, 201)];
      for (let i = 0; i < failAt; i++) fetchMock.mockResolvedValueOnce(ok[i]);
      fetchMock.mockResolvedValueOnce(json({ message: "boom" }, 502));
      const error = await errorOf(new GitHubClient(config).commitFilesToNewBranch(input));
      expect(error.message).toBe(`${what}: invalid_response (HTTP 502)`);
      expect(fetchMock).toHaveBeenCalledTimes(failAt + 1);
    });

    it("サーバ: 403（トークンに contents の書き込み権限が無い）は permission_denied で、ブランチを作らない", async () => {
      fetchMock
        .mockResolvedValueOnce(json({}, 404))
        .mockResolvedValueOnce(json({ tree: { sha: "base-tree" } }))
        .mockResolvedValueOnce(json({ message: "Resource not accessible by integration" }, 403));
      const error = await errorOf(new GitHubClient(config).commitFilesToNewBranch(input));
      expect(error.failureClass).toBe("permission_denied");
      expect(error.message).not.toContain("ghp_test_token");
      expect(routes()).not.toContain("POST /git/refs");
    });

    it.each([
      ["base の tree", [json({}, 404), json({ sha: "base-sha" })], "GitHub: base の tree を取得できなかった"],
      ["tree の SHA", [json({}, 404), json({ tree: { sha: "t" } }), json({}, 201)], "GitHub: tree の SHA を取得できなかった"],
      [
        "コミットの SHA",
        [json({}, 404), json({ tree: { sha: "t" } }), json({ sha: "t2" }, 201), json({}, 201)],
        "GitHub: コミットの SHA を取得できなかった",
      ],
    ])("サーバ: 応答に %s が無ければ invalid_response で、ブランチを作らない", async (_label, responses, message) => {
      for (const response of responses) fetchMock.mockResolvedValueOnce(response);
      const error = await errorOf(new GitHubClient(config).commitFilesToNewBranch(input));
      expect(error).toMatchObject({ failureClass: "invalid_response", message });
      expect(routes()).not.toContain("POST /git/refs");
    });
  });
});

describe("GitHubClient.listOpenPullRequests", () => {
  describe("正常系", () => {
    it("開いている PR を 100 件読み、head のブランチ名が prefix で始まるものだけを返す", async () => {
      fetchMock.mockResolvedValueOnce(
        json([
          { number: 31, head: { ref: "chore/n8n-export-20261006" } },
          { number: 30, head: { ref: "13-feature-proposal-PRP-2026-0001" } },
          { number: 29, head: { ref: "chore/n8n-export-20261005" } },
          { number: 28, head: {} },
          { number: 27 },
        ]),
      );
      expect(await new GitHubClient(config).listOpenPullRequests("chore/n8n-export-")).toEqual([
        { number: 31, branch: "chore/n8n-export-20261006" },
        { number: 29, branch: "chore/n8n-export-20261005" },
      ]);
      expect(call().url).toBe(`${REPO_API}/pulls?state=open&per_page=100`);
    });

    it("空入力: 開いている PR が 0 件なら空配列", async () => {
      fetchMock.mockResolvedValueOnce(json([]));
      expect(await new GitHubClient(config).listOpenPullRequests("chore/n8n-export-")).toEqual([]);
    });

    it("空入力: prefix が空文字なら head のあるすべての PR を返す", async () => {
      fetchMock.mockResolvedValueOnce(json([{ number: 1, head: { ref: "a" } }, { number: 2 }]));
      expect(await new GitHubClient(config).listOpenPullRequests("")).toEqual([{ number: 1, branch: "a" }]);
    });

    it("空入力: 本文の無い 200 は空配列として扱う", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
      expect(await new GitHubClient(config).listOpenPullRequests("chore/")).toEqual([]);
    });
  });

  describe("異常系", () => {
    it.each([
      [401, "auth_failed"],
      [404, "invalid_response"],
      [500, "invalid_response"],
    ] as const)("サーバ: HTTP %s は %s の IntegrationError", async (status, failureClass) => {
      fetchMock.mockImplementation(async () => json({}, status));
      const error = await errorOf(new GitHubClient(config).listOpenPullRequests("chore/"));
      expect(error).toMatchObject({ failureClass, message: `GitHub: 開いている PR の一覧: ${failureClass} (HTTP ${status})` });
    });

    it("サーバ: 429 で Retry-After が予算を超えるなら待たずに rate_limited", async () => {
      fetchMock.mockImplementation(async () => new Response("{}", { status: 429, headers: { "retry-after": "3600" } }));
      expect((await errorOf(new GitHubClient(config).listOpenPullRequests("chore/"))).failureClass).toBe("rate_limited");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe("GitHubClient.findPullRequest", () => {
  describe("正常系", () => {
    it("head=<owner>:<branch>・state=all で探し、無ければ null", async () => {
      const client = new GitHubClient(config);
      fetchMock.mockResolvedValueOnce(json([{ number: 42 }]));
      expect(await client.findPullRequest("13-feature-proposal-PRP-2026-0001")).toBe(42);
      expect(call().url).toBe(
        `${REPO_API}/pulls?head=kamegin4-aws%3A13-feature-proposal-PRP-2026-0001&state=all&per_page=1`,
      );
      fetchMock.mockResolvedValueOnce(json([]));
      expect(await client.findPullRequest("x")).toBeNull();
    });

    it("空入力: 本文の無い 200 は null", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
      expect(await new GitHubClient(config).findPullRequest("x")).toBeNull();
    });
  });

  describe("異常系", () => {
    it("サーバ: 5xx は IntegrationError", async () => {
      fetchMock.mockResolvedValueOnce(json({}, 503));
      expect((await errorOf(new GitHubClient(config).findPullRequest("x"))).message).toBe(
        "GitHub: PR の確認: invalid_response (HTTP 503)",
      );
    });
  });
});

describe("GitHubClient.createPullRequest", () => {
  describe("正常系", () => {
    it("base は設定のブランチ", async () => {
      const client = new GitHubClient({ ...config, baseBranch: "develop" });
      fetchMock.mockResolvedValueOnce(json({ number: 7 }, 201));
      expect(await client.createPullRequest({ title: "t", head: "h", body: "b" })).toBe(7);
      expect(call().body).toEqual({ title: "t", head: "h", base: "develop", body: "b" });
    });

    it("空入力: 本文が空文字でもそのまま送る", async () => {
      fetchMock.mockResolvedValueOnce(json({ number: 8 }, 201));
      expect(await new GitHubClient(config).createPullRequest({ title: "t", head: "h", body: "" })).toBe(8);
      expect(call().body.body).toBe("");
    });
  });

  describe("異常系", () => {
    it("サーバ: 番号が返らなければ例外", async () => {
      fetchMock.mockResolvedValueOnce(json({}, 201));
      await expect(new GitHubClient(config).createPullRequest({ title: "t", head: "h", body: "b" })).rejects.toThrow("PR 番号");
    });

    it("サーバ: 422（head に差分が無い・既に PR がある）は IntegrationError", async () => {
      fetchMock.mockResolvedValueOnce(json({ message: "Validation Failed" }, 422));
      expect((await errorOf(new GitHubClient(config).createPullRequest({ title: "t", head: "h", body: "b" }))).failureClass).toBe(
        "invalid_response",
      );
    });
  });
});

describe("GitHubClient.requestReviewer", () => {
  describe("正常系", () => {
    it("指定できれば true", async () => {
      fetchMock.mockResolvedValueOnce(json({}, 201));
      expect(await new GitHubClient(config).requestReviewer(7, "kamegin4-aws")).toBe(true);
      expect(call().url).toBe(`${REPO_API}/pulls/7/requested_reviewers`);
      expect(call().body).toEqual({ reviewers: ["kamegin4-aws"] });
    });

    it("空入力: 本文の無い 201 でも true", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }));
      expect(await new GitHubClient(config).requestReviewer(7, "kamegin4-aws")).toBe(true);
    });
  });

  describe("異常系", () => {
    it("サーバ: 失敗しても例外にせず false を返す", async () => {
      fetchMock.mockResolvedValueOnce(json({ message: "Review cannot be requested from pull request author." }, 422));
      expect(await new GitHubClient(config).requestReviewer(7, "kamegin4-aws")).toBe(false);
    });

    it("サーバ: 接続できなくても例外にせず false を返す", async () => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(async () => {
        throw new TypeError("fetch failed");
      });
      const pending = new GitHubClient(config).requestReviewer(7, "kamegin4-aws");
      await vi.advanceTimersByTimeAsync(12_000);
      expect(await pending).toBe(false);
    });
  });
});
