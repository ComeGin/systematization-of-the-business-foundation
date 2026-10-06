import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubClient } from "../../src/integrations/github.js";
import { IntegrationError } from "../../src/integrations/http.js";

const config = {
  token: "ghp_test_token",
  repository: "kamegin4-aws/business-foundation",
  baseBranch: "main",
  issueNumber: 13,
  reviewer: "kamegin4-aws",
};

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const call = (index = -1) => {
  const [url, init] = fetchMock.mock.calls.at(index) as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
};

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("GitHubClient", () => {
  it("リポジトリの REST API に Bearer トークンと API の版を付けて呼ぶ（タイムアウト 30 秒）", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockResolvedValue(json({ object: { sha: "abc" } }));
    await new GitHubClient(config).branchSha("main");
    const { url, init, headers } = call();
    expect(url).toBe("https://api.github.com/repos/kamegin4-aws/business-foundation/git/ref/heads/main");
    expect(init.method).toBe("GET");
    expect(headers).toMatchObject({
      Authorization: "Bearer ghp_test_token",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    expect(headers).not.toHaveProperty("Content-Type");
    expect(timeout).toHaveBeenCalledWith(30_000);
  });

  it("fileExists: 200 なら true、404 なら false。パスは区切りを残して符号化する", async () => {
    const client = new GitHubClient(config);
    fetchMock.mockResolvedValueOnce(json({}));
    expect(await client.fileExists("docs/proposals/PRP 1.md", "13-feature-x")).toBe(true);
    expect(call().url).toBe(
      "https://api.github.com/repos/kamegin4-aws/business-foundation/contents/docs/proposals/PRP%201.md?ref=13-feature-x",
    );
    fetchMock.mockResolvedValueOnce(json({ message: "Not Found" }, 404));
    expect(await client.fileExists("docs/proposals/PRP-2026-0001.md", "main")).toBe(false);
  });

  it("fileExists: 404 以外の失敗は IntegrationError（トークンをメッセージに含めない）", async () => {
    fetchMock.mockResolvedValue(json({}, 401));
    const error = (await new GitHubClient(config).fileExists("a.md", "main").catch((e: unknown) => e)) as IntegrationError;
    expect(error).toBeInstanceOf(IntegrationError);
    expect(error.failureClass).toBe("auth_failed");
    expect(error.message).not.toContain("ghp_test_token");
    expect(fetchMock).toHaveBeenCalledTimes(1); // 401 は再試行しない
  });

  it("branchSha: 404 なら null", async () => {
    fetchMock.mockResolvedValue(json({}, 404));
    expect(await new GitHubClient(config).branchSha("missing")).toBeNull();
  });

  it("createBranch: refs/heads/<branch> を作る。422（既にある）は続きとして成功扱い", async () => {
    const client = new GitHubClient(config);
    fetchMock.mockResolvedValueOnce(json({}, 201));
    await client.createBranch("13-feature-proposal-PRP-2026-0001", "abc");
    expect(call().init.method).toBe("POST");
    expect(call().headers["Content-Type"]).toBe("application/json");
    expect(call().body).toEqual({ ref: "refs/heads/13-feature-proposal-PRP-2026-0001", sha: "abc" });
    fetchMock.mockResolvedValueOnce(json({ message: "Reference already exists" }, 422));
    await expect(client.createBranch("x", "abc")).resolves.toBeUndefined();
  });

  it("createBranch: 422 以外の失敗は IntegrationError", async () => {
    fetchMock.mockResolvedValue(json({}, 403));
    await expect(new GitHubClient(config).createBranch("x", "abc")).rejects.toMatchObject({
      failureClass: "permission_denied",
    });
  });

  it("putFile: 内容を base64 にして指定のブランチにコミットする", async () => {
    fetchMock.mockResolvedValue(json({}, 201));
    await new GitHubClient(config).putFile("docs/a.md", "b", "日本語の本文", "add: x");
    expect(call().init.method).toBe("PUT");
    expect(call().body).toEqual({
      message: "add: x",
      content: Buffer.from("日本語の本文", "utf8").toString("base64"),
      branch: "b",
    });
  });

  it("findPullRequest: head=<owner>:<branch>・state=all で探し、無ければ null", async () => {
    const client = new GitHubClient(config);
    fetchMock.mockResolvedValueOnce(json([{ number: 42 }]));
    expect(await client.findPullRequest("13-feature-proposal-PRP-2026-0001")).toBe(42);
    expect(call().url).toBe(
      "https://api.github.com/repos/kamegin4-aws/business-foundation/pulls?head=kamegin4-aws%3A13-feature-proposal-PRP-2026-0001&state=all&per_page=1",
    );
    fetchMock.mockResolvedValueOnce(json([]));
    expect(await client.findPullRequest("x")).toBeNull();
  });

  it("createPullRequest: base は設定のブランチ。番号が返らなければ例外", async () => {
    const client = new GitHubClient({ ...config, baseBranch: "develop" });
    fetchMock.mockResolvedValueOnce(json({ number: 7 }, 201));
    expect(await client.createPullRequest({ title: "t", head: "h", body: "b" })).toBe(7);
    expect(call().body).toEqual({ title: "t", head: "h", base: "develop", body: "b" });
    fetchMock.mockResolvedValueOnce(json({}, 201));
    await expect(client.createPullRequest({ title: "t", head: "h", body: "b" })).rejects.toThrow("PR 番号");
  });

  it("requestReviewer: 失敗しても例外にせず false を返す", async () => {
    const client = new GitHubClient(config);
    fetchMock.mockResolvedValueOnce(json({}, 201));
    expect(await client.requestReviewer(7, "kamegin4-aws")).toBe(true);
    expect(call().url).toBe("https://api.github.com/repos/kamegin4-aws/business-foundation/pulls/7/requested_reviewers");
    expect(call().body).toEqual({ reviewers: ["kamegin4-aws"] });
    fetchMock.mockResolvedValueOnce(json({ message: "Review cannot be requested from pull request author." }, 422));
    expect(await client.requestReviewer(7, "kamegin4-aws")).toBe(false);
  });
});
