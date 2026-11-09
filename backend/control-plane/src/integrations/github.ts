// I-13 の GitHub REST API。コミットは API で行い、ローカルの Git の状態は変えない（DD-06 の 2.3）。
// トークンは監視アプリのサーバー側だけに置き、エージェントの実行環境には渡さない（DD-01 の 8.2）。
import type { ControlPlaneConfig } from "../config.js";
import { TIMEOUT_SEC } from "../constants/timeouts.js";
import { type FetchJsonResult, IntegrationError, fetchJson, requireSuccess } from "./http.js";

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

  /**
   * ref にあるファイルの本文。無ければ null。
   * Contents API は 1 MB を超えるファイルの本文を返さない（encoding が "none"）ため、その場合は例外にする（空と取り違えない）。
   * 出典: https://docs.github.com/en/rest/repos/contents#get-repository-content
   */
  async getFileText(path: string, ref: string): Promise<string | null> {
    const result = await this.call<{ content?: string; encoding?: string }>(
      "GET",
      `/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
    );
    if (result.status === 404) return null;
    requireSuccess(result, "GitHub: ファイルの取得");
    if (result.data?.encoding !== "base64" || typeof result.data.content !== "string") {
      throw new IntegrationError("invalid_response", "GitHub: ファイルの本文を取得できなかった（1 MB を超えるか、ファイルではない）");
    }
    return Buffer.from(result.data.content, "base64").toString("utf8");
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

  /**
   * 複数のファイルを 1 コミットにして、そのコミットを指す新しいブランチを作る（Git Data API）。
   * 順序は blob 入りの tree → commit → ref の作成。ref を最後に作るので、ブランチがある = コミットが済んでいる。
   * 途中で止まっても孤立したコミットが残るだけで、半端なブランチは残らない。
   * 既にそのブランチがあれば何もせず "exists" を返す（前回の続きとして扱う）。
   * 出典: https://docs.github.com/en/rest/git/trees 、https://docs.github.com/en/rest/git/commits 、https://docs.github.com/en/rest/git/refs
   */
  async commitFilesToNewBranch(input: {
    branch: string;
    baseSha: string;
    files: { path: string; content: string }[];
    message: string;
  }): Promise<"created" | "exists"> {
    if ((await this.branchSha(input.branch)) !== null) return "exists";

    const base = await this.call<{ tree?: { sha?: string } }>("GET", `/git/commits/${input.baseSha}`);
    requireSuccess(base, "GitHub: base のコミットの取得");
    const baseTree = base.data?.tree?.sha;
    if (!baseTree) throw new IntegrationError("invalid_response", "GitHub: base の tree を取得できなかった");

    const tree = await this.call<{ sha?: string }>("POST", "/git/trees", {
      base_tree: baseTree,
      tree: input.files.map((file) => ({ path: file.path, mode: "100644", type: "blob", content: file.content })),
    });
    requireSuccess(tree, "GitHub: tree の作成");
    if (!tree.data?.sha) throw new IntegrationError("invalid_response", "GitHub: tree の SHA を取得できなかった");

    const commit = await this.call<{ sha?: string }>("POST", "/git/commits", {
      message: input.message,
      tree: tree.data.sha,
      parents: [input.baseSha],
    });
    requireSuccess(commit, "GitHub: コミットの作成");
    if (!commit.data?.sha) throw new IntegrationError("invalid_response", "GitHub: コミットの SHA を取得できなかった");

    const ref = await this.call("POST", "/git/refs", { ref: `refs/heads/${input.branch}`, sha: commit.data.sha });
    // 422 は「確認の後に別の実行が作った」。既にあるものを使う
    if (ref.status === 422) return "exists";
    requireSuccess(ref, "GitHub: ブランチの作成");
    return "created";
  }

  /** head のブランチ名が prefix で始まる、開いている PR の番号とブランチ名（先頭の 100 件から）。 */
  async listOpenPullRequests(headPrefix: string): Promise<{ number: number; branch: string }[]> {
    const result = await this.call<{ number: number; head?: { ref?: string } }[]>("GET", "/pulls?state=open&per_page=100");
    requireSuccess(result, "GitHub: 開いている PR の一覧");
    return (result.data ?? [])
      .filter((pull) => typeof pull.head?.ref === "string" && pull.head.ref.startsWith(headPrefix))
      .map((pull) => ({ number: pull.number, branch: pull.head!.ref! }));
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

  /**
   * PR の状態（改善ループの proposal・code の項目）。approved は、レビューした人ごとの最新のレビューに APPROVED があり、
   * CHANGES_REQUESTED が無いとき（先頭の 100 件のレビューから）。mergeCommitSha はマージ済みのときだけ。無い PR は null。
   * 出典: https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request 、https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request
   */
  async getPullRequest(
    pullNumber: number,
  ): Promise<{ state: "open" | "closed"; merged: boolean; approved: boolean; mergeCommitSha: string | null } | null> {
    const pull = await this.call<{ state?: string; merged?: boolean; merge_commit_sha?: string | null }>("GET", `/pulls/${pullNumber}`);
    if (pull.status === 404) return null;
    requireSuccess(pull, "GitHub: PR の取得");
    const state = pull.data?.state;
    if (state !== "open" && state !== "closed") throw new IntegrationError("invalid_response", "GitHub: PR の状態を読めなかった");
    const merged = pull.data?.merged === true;

    const reviews = await this.call<{ state?: string; user?: { login?: string } | null }[]>(
      "GET",
      `/pulls/${pullNumber}/reviews?per_page=100`,
    );
    requireSuccess(reviews, "GitHub: PR のレビューの一覧");
    // コメントだけのレビュー（COMMENTED）は承認の判定を変えない
    const latest = new Map<string, string>();
    for (const review of reviews.data ?? []) {
      const login = review.user?.login;
      if (!login || (review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED" && review.state !== "DISMISSED")) continue;
      latest.set(login, review.state);
    }
    const states = [...latest.values()];
    const approved = states.includes("APPROVED") && !states.includes("CHANGES_REQUESTED");
    return { state, merged, approved, mergeCommitSha: merged ? (pull.data?.merge_commit_sha ?? null) : null };
  }

  /**
   * ancestor のコミットが descendant に含まれるか（同じか祖先）。どちらかのコミットが無ければ false。
   * 出典: https://docs.github.com/en/rest/commits/commits#compare-two-commits （status が ahead か identical）
   */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    if (!/^[0-9a-f]{7,40}$/.test(ancestor) || !/^[0-9a-f]{7,40}$/.test(descendant)) return false;
    const result = await this.call<{ status?: string }>("GET", `/compare/${ancestor}...${descendant}?per_page=1`);
    if (result.status === 404) return false;
    requireSuccess(result, "GitHub: コミットの比較");
    return result.data?.status === "ahead" || result.data?.status === "identical";
  }

  /** Reviewer の指定。失敗しても PR は残るため、呼び出し側は例外を握りつぶさず結果で扱う。 */
  async requestReviewer(pullNumber: number, reviewer: string): Promise<boolean> {
    const result = await this.call("POST", `/pulls/${pullNumber}/requested_reviewers`, { reviewers: [reviewer] });
    return result.failureClass === "ok" || result.failureClass === "empty_but_ok";
  }
}
