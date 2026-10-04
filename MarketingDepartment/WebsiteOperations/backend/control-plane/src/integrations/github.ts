// I-13 の GitHub REST API。コミットは API で行い、ローカルの Git の状態は変えない（DD-06 の 2.3）。
// トークンは監視アプリのサーバー側だけに置き、エージェントの実行環境には渡さない（DD-01 の 8.2）。
import type { ControlPlaneConfig } from "../config.js";
import { TIMEOUT_SEC } from "../constants/timeouts.js";
import { type FetchJsonResult, fetchJson, requireSuccess } from "./http.js";

type GitHubConfig = NonNullable<ControlPlaneConfig["github"]>;

const API = "https://api.github.com";

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export class GitHubClient {
  constructor(
    private readonly config: GitHubConfig,
    private readonly signal?: AbortSignal,
  ) {}

  private call<T>(method: string, path: string, body?: unknown): Promise<FetchJsonResult<T>> {
    return fetchJson<T>({
      upstream: "github",
      url: `${API}/repos/${this.config.repository}${path}`,
      init: {
        method,
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "comegin-control-plane",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      timeoutMs: TIMEOUT_SEC.i13Github * 1000,
      signal: this.signal,
    });
  }

  /** ref にそのパスのファイルがあるか（冪等キー。proposal_id のファイルの存在そのもの）。 */
  async fileExists(path: string, ref: string): Promise<boolean> {
    const result = await this.call<unknown>("GET", `/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
    if (result.status === 404) return false;
    requireSuccess(result, "GitHub: ファイルの確認");
    return true;
  }

  /** ブランチの先頭のコミット SHA。無ければ null。 */
  async branchSha(branch: string): Promise<string | null> {
    const result = await this.call<{ object?: { sha?: string } }>("GET", `/git/ref/heads/${encodePath(branch)}`);
    if (result.status === 404) return null;
    requireSuccess(result, "GitHub: ブランチの確認");
    return result.data?.object?.sha ?? null;
  }

  async createBranch(branch: string, sha: string): Promise<void> {
    const result = await this.call("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha });
    // 422 は「既にある」。前回の途中で止まった続きとして扱う
    if (result.status === 422) return;
    requireSuccess(result, "GitHub: ブランチの作成");
  }

  async putFile(path: string, branch: string, content: string, message: string): Promise<void> {
    const result = await this.call("PUT", `/contents/${encodePath(path)}`, {
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch,
    });
    requireSuccess(result, "GitHub: ファイルのコミット");
  }

  /** そのブランチを head とする PR（状態を問わない）の番号。無ければ null。 */
  async findPullRequest(branch: string): Promise<number | null> {
    const owner = this.config.repository.split("/")[0]!;
    const result = await this.call<{ number: number }[]>(
      "GET",
      `/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=1`,
    );
    requireSuccess(result, "GitHub: PR の確認");
    return result.data?.[0]?.number ?? null;
  }

  async createPullRequest(input: { title: string; head: string; body: string }): Promise<number> {
    const result = await this.call<{ number: number }>("POST", "/pulls", {
      title: input.title,
      head: input.head,
      base: this.config.baseBranch,
      body: input.body,
    });
    requireSuccess(result, "GitHub: PR の作成");
    if (!result.data?.number) throw new Error("GitHub: PR 番号を取得できなかった");
    return result.data.number;
  }

  /** Reviewer の指定。失敗しても PR は残るため、呼び出し側は例外を握りつぶさず結果で扱う。 */
  async requestReviewer(pullNumber: number, reviewer: string): Promise<boolean> {
    const result = await this.call("POST", `/pulls/${pullNumber}/requested_reviewers`, { reviewers: [reviewer] });
    return result.failureClass === "ok" || result.failureClass === "empty_but_ok";
  }
}
