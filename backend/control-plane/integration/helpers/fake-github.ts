// 偽の GitHub（REST API のうち I-13 と n8n-export が使う分だけ）。テストの中で 127.0.0.1 の空きポートに立てる。
// integrations/github.ts は https://api.github.com を直書きしているため、global fetch を差し替えて
// api.github.com 宛だけをこのサーバーに向け直す（127.0.0.1 の開発スタック宛はそのまま通し、それ以外の宛先は例外にする）。
//
// 状態はブランチ → コミット SHA → ファイルの写像だけを持つ（Git の履歴は持たない）。
// fail() で、条件に合う要求に 5xx・422・401 を返したり、応答しない（タイムアウトさせる）ようにできる。
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";

const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);
const GITHUB_API = "https://api.github.com";

export interface RecordedRequest {
  method: string;
  /** /repos/<owner>/<repo> を除いたパス（デコード済み） */
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
  authorization: string | undefined;
}

interface Pull {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  state: "open" | "closed";
  reviewers: string[];
}

type FaultResponse = { status: number; body?: unknown } | "hang";
interface Fault {
  match: (request: RecordedRequest) => boolean;
  response: FaultResponse;
  remaining: number;
}

export class FakeGitHub {
  readonly requests: RecordedRequest[] = [];
  readonly pulls: Pull[] = [];
  /** ブランチ名 → コミット SHA */
  readonly branches = new Map<string, string>();
  /** コミット SHA → そのコミットのファイル（パス → 本文） */
  readonly snapshots = new Map<string, Map<string, string>>();
  readonly #trees = new Map<string, Map<string, string>>();
  readonly #faults: Fault[] = [];
  #sequence = 0;
  #server!: Server;
  url = "";

  static async start(): Promise<FakeGitHub> {
    const fake = new FakeGitHub();
    fake.branches.set("main", "sha-main-0");
    fake.snapshots.set("sha-main-0", new Map());
    fake.#server = createServer((req, res) => void fake.#handle(req, res));
    await new Promise<void>((resolve) => fake.#server.listen(0, "127.0.0.1", resolve));
    fake.url = `http://127.0.0.1:${(fake.#server.address() as AddressInfo).port}`;
    return fake;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  /** api.github.com 宛の fetch をこのサーバーに向け直す（unstubGlobals で各テストの後に戻る） */
  installFetch(): void {
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(`${GITHUB_API}/`)) return realFetch(`${this.url}${url.slice(GITHUB_API.length)}`, init);
      if (/^http:\/\/127\.0\.0\.1[:/]/.test(url)) return realFetch(input, init);
      throw new Error(`結合テストで想定していない宛先: ${new URL(url).host}`);
    });
  }

  /** 条件に合う要求に、times 回だけ指定の応答を返す（"hang" は応答しない） */
  fail(match: (request: RecordedRequest) => boolean, response: FaultResponse, times = Number.POSITIVE_INFINITY): void {
    this.#faults.push({ match, response, remaining: times });
  }

  clearFaults(): void {
    this.#faults.length = 0;
  }

  /** base（main）にファイルを置く */
  seedBase(path: string, content: string): void {
    const sha = this.#commit(this.branches.get("main")!, new Map([[path, content]]));
    this.branches.set("main", sha);
  }

  addPull(pull: Omit<Pull, "number" | "reviewers"> & { number?: number }): number {
    const number = pull.number ?? this.pulls.length + 1;
    this.pulls.push({ reviewers: [], ...pull, number });
    return number;
  }

  /** そのブランチの先頭のファイル */
  filesOf(branch: string): Map<string, string> {
    const sha = this.branches.get(branch);
    return sha ? (this.snapshots.get(sha) ?? new Map()) : new Map();
  }

  /** 書き込み系（GET 以外）の要求の一覧（"POST /pulls" の形） */
  writes(): string[] {
    return this.requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);
  }

  #commit(parentSha: string, changes: Map<string, string>): string {
    const files = new Map(this.snapshots.get(parentSha) ?? []);
    for (const [path, content] of changes) files.set(path, content);
    const sha = `sha-${++this.#sequence}`;
    this.snapshots.set(sha, files);
    return sha;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://fake");
    const repoPath = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "");
    const request: RecordedRequest = {
      method: req.method ?? "GET",
      path: repoPath.split("/").map(decodeURIComponent).join("/"),
      query: url.searchParams,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
      authorization: req.headers.authorization,
    };
    this.requests.push(request);

    const fault = this.#faults.find((f) => f.remaining > 0 && f.match(request));
    if (fault) {
      fault.remaining--;
      if (fault.response === "hang") return; // 応答しない（クライアントのタイムアウトで切られる）
      return send(res, fault.response.status, fault.response.body ?? { message: "fake failure" });
    }
    const [status, body] = this.#route(request);
    send(res, status, body);
  }

  #route(r: RecordedRequest): [number, unknown] {
    const { method, path, body } = r;
    let m: RegExpExecArray | null;

    if (method === "GET" && (m = /^\/contents\/(.+)$/.exec(path))) {
      const ref = r.query.get("ref") ?? "main";
      const files = this.snapshots.get(this.branches.get(ref) ?? ref);
      const content = files?.get(m[1]!);
      if (content === undefined) return [404, { message: "Not Found" }];
      return [200, { type: "file", path: m[1], encoding: "base64", content: Buffer.from(content, "utf8").toString("base64") }];
    }
    if (method === "PUT" && (m = /^\/contents\/(.+)$/.exec(path))) {
      const branch = String(body?.branch);
      const parent = this.branches.get(branch);
      if (!parent) return [404, { message: "Branch not found" }];
      const content = Buffer.from(String(body?.content), "base64").toString("utf8");
      this.branches.set(branch, this.#commit(parent, new Map([[m[1]!, content]])));
      return [201, { content: { path: m[1] } }];
    }
    if (method === "GET" && (m = /^\/git\/ref\/heads\/(.+)$/.exec(path))) {
      const sha = this.branches.get(m[1]!);
      return sha ? [200, { ref: `refs/heads/${m[1]}`, object: { sha } }] : [404, { message: "Not Found" }];
    }
    if (method === "POST" && path === "/git/refs") {
      const name = String(body?.ref).replace(/^refs\/heads\//, "");
      if (this.branches.has(name)) return [422, { message: "Reference already exists" }];
      this.branches.set(name, String(body?.sha));
      return [201, { ref: body?.ref, object: { sha: body?.sha } }];
    }
    if (method === "GET" && (m = /^\/git\/commits\/(.+)$/.exec(path))) {
      return this.snapshots.has(m[1]!) ? [200, { sha: m[1], tree: { sha: `tree-of-${m[1]}` } }] : [404, { message: "Not Found" }];
    }
    if (method === "POST" && path === "/git/trees") {
      const baseCommit = String(body?.base_tree).replace(/^tree-of-/, "");
      const files = new Map(this.snapshots.get(baseCommit) ?? []);
      for (const entry of (body?.tree ?? []) as { path: string; content: string }[]) files.set(entry.path, entry.content);
      const sha = `tree-${++this.#sequence}`;
      this.#trees.set(sha, files);
      return [201, { sha }];
    }
    if (method === "POST" && path === "/git/commits") {
      const files = this.#trees.get(String(body?.tree));
      if (!files) return [422, { message: "tree not found" }];
      const sha = `sha-${++this.#sequence}`;
      this.snapshots.set(sha, files);
      return [201, { sha }];
    }
    if (method === "GET" && path === "/pulls") {
      const head = r.query.get("head")?.replace(/^[^:]+:/, "");
      const state = r.query.get("state") ?? "open";
      const found = this.pulls.filter((p) => (head === undefined || p.head === head) && (state === "all" || p.state === state));
      return [200, found.map((p) => ({ number: p.number, state: p.state, head: { ref: p.head }, base: { ref: p.base } }))];
    }
    if (method === "POST" && path === "/pulls") {
      const head = String(body?.head);
      if (!this.branches.has(head)) return [422, { message: "Validation Failed", errors: [{ field: "head", code: "invalid" }] }];
      if (this.pulls.some((p) => p.head === head && p.state === "open")) return [422, { message: "A pull request already exists" }];
      const number = this.addPull({ head, base: String(body?.base), title: String(body?.title), body: String(body?.body), state: "open" });
      return [201, { number }];
    }
    if (method === "POST" && (m = /^\/pulls\/(\d+)\/requested_reviewers$/.exec(path))) {
      const pull = this.pulls.find((p) => p.number === Number(m![1]));
      if (!pull) return [404, { message: "Not Found" }];
      pull.reviewers.push(...((body?.reviewers ?? []) as string[]));
      return [201, { number: pull.number }];
    }
    return [404, { message: `fake: 未対応の要求 ${method} ${path}` }];
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** GitHub の設定（I-13 の 4 変数）。トークンは偽物だが、ログ・E-15 に出ないことを確かめるために形は本物に寄せる */
export const GITHUB_TOKEN = "ghp_itFakeToken0123456789abcdefABCDEF01";
export const githubEnv = (): Record<string, string> => ({
  GITHUB_TOKEN,
  GITHUB_REPOSITORY: "kamegin4-aws/it-fake-repo",
  I13_ISSUE_NUMBER: "13",
  I13_REVIEWER: "it-reviewer",
});
