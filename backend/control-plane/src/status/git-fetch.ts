// 設定の状況: チェックアウトの中で GitHub の main の最新を取る（spec 5.3。ユーザーの決定: 監視アプリが自分で fetch する）。
// 子プロセスを起動する箇所は、この runGit だけ（drift.ts の読み取りの git もここを通る）。
//
// 守ること:
//   - 動かすのは `git fetch --no-tags origin main` だけ。HEAD・作業ツリーのファイルは動かさない（origin/main の参照だけが新しくなる）。
//     チェックアウトは .git を共有する作業ツリーなので、作業ツリーから見える origin/main も新しくなる（許容。ユーザーの決定）。
//   - トークン（GitHub の読み取り専用）は GIT_CONFIG_COUNT / KEY / VALUE の環境変数で git の子プロセスにだけ渡す。
//     コマンドライン・URL・.git/config には書かない（`ps` にも出ない）。ファイルは呼ぶたびに読み、ログにも結果にも出さない。
//   - 子プロセスの env は許可リスト（PATH・HOME・LANG・GIT_TERMINAL_PROMPT=0 と、fetch のときの GIT_CONFIG_*）だけ。
//   - origin が設定のリポジトリと別の名前（改名前の名前など）なら、GitHub の API でその名前の正体（full_name）を引き、
//     設定のリポジトリと同じときだけ fetch する（GitHub は改名の後も旧名を転送するため。プロセス内で覚え、毎回は引かない）。
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { logLine } from "../log.js";

/** fetch の上限（ネットワークが遅くても、確認全体の上限〈5 分〉を食い潰さない） */
export const GIT_FETCH_TIMEOUT_MS = 60_000;
/** 読み取りだけの git（log・show・rev-parse・ls-tree）の上限 */
export const GIT_READ_TIMEOUT_MS = 30_000;

const MAX_BUFFER = 16 * 1024 * 1024;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** ヘッダーの値に入れる前の検査（改行や空白が混ざると、別のヘッダーやコマンドが紛れ込む） */
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;

export type FetchMainResult = { ok: true; head: string } | { ok: false; reason: string };

/** origin の名前の正体を GitHub の API で引くときの上限 */
const GITHUB_API_TIMEOUT_MS = 15_000;

/** 設定のリポジトリと同じだと確かめた origin（キー: 認証情報を除いた origin の URL と設定のリポジトリ、小文字）。プロセス内だけ */
const acceptedOrigins = new Set<string>();

/** テスト用: 覚えた origin を消す。 */
export function clearOriginCache(): void {
  acceptedOrigins.clear();
}

/** https://github.com/<owner>/<repo>(.git) から owner/repo を取り出す。形が違えば null。 */
function parseGithubOrigin(url: string): { owner: string; repo: string; key: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") return null;
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(parsed.pathname);
  if (!match) return null;
  const [, owner, repo] = match;
  // 覚えるときのキーには認証情報（user:pass@）を入れない
  return { owner: owner!, repo: repo!, key: `https://github.com/${owner}/${repo}`.toLowerCase() };
}

/**
 * origin の owner/repo が設定のリポジトリと違うとき、GitHub の API でその名前の full_name を引き、設定と同じか確かめる。
 * 改名・移管したリポジトリは旧名の API が新しい名前へ転送される（fetch は転送を追う）。
 * reason にトークン・origin の URL（認証情報を含みうる）は入れない。
 */
async function confirmRenamedOrigin(
  origin: { owner: string; repo: string },
  repository: string,
  token: string,
  signal: AbortSignal,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const name = `${origin.owner}/${origin.repo}`;
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${origin.owner}/${origin.repo}`, {
      method: "GET",
      redirect: "follow",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "comegin-control-plane",
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(GITHUB_API_TIMEOUT_MS)]),
    });
  } catch (error) {
    if (signal.aborted) return { ok: false, reason: "打ち切られた" };
    const kind = error instanceof Error && error.name === "TimeoutError" ? "時間切れ" : "接続できない";
    return { ok: false, reason: `origin（${name}）が ${repository} と同じか GitHub の API で確かめられない（${kind}）` };
  }
  if (!response.ok) {
    return { ok: false, reason: `origin（${name}）が ${repository} と同じか GitHub の API で確かめられない（HTTP ${response.status}）` };
  }
  let fullName: unknown;
  try {
    fullName = ((await response.json()) as { full_name?: unknown } | null)?.full_name;
  } catch {
    return { ok: false, reason: `origin（${name}）が ${repository} と同じか GitHub の API で確かめられない（応答が JSON ではない）` };
  }
  if (typeof fullName !== "string" || fullName.toLowerCase() !== repository.toLowerCase()) {
    return { ok: false, reason: `origin が ${repository} を指していないため、fetch しない` };
  }
  return { ok: true };
}

export interface GitResult {
  /** 終了コード。起動できなかった・シグナルで終わったときは null */
  code: number | null;
  stdout: string;
  /** 末尾の一部（redact を渡したときは、伏せてから切る）。ログと reason に使う */
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

/** git の子プロセスの env。許可リストだけ（呼び出し元の env は引き継がない）。 */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0" };
  for (const name of ["PATH", "HOME", "LANG"] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

/** `git -C <checkout> <args...>` を起動して終わるまで待つ。投げずに結果を返す（失敗の扱いは呼び出し側）。 */
export function runGit(
  checkout: string,
  args: readonly string[],
  options: { signal: AbortSignal; timeoutMs: number; env?: NodeJS.ProcessEnv; redact?: (text: string) => string },
): Promise<GitResult> {
  return new Promise((resolve) => {
    if (options.signal.aborted) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, aborted: true });
      return;
    }
    execFile(
      "git",
      ["-C", checkout, ...args],
      {
        env: options.env ?? gitEnv(),
        timeout: options.timeoutMs,
        killSignal: "SIGTERM",
        signal: options.signal,
        maxBuffer: MAX_BUFFER,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        // 伏せてから切る（先に切ると、切れ目にかかったトークンの断片が伏せられずに残る）
        const mask = options.redact ?? ((text: string) => text);
        const out = typeof stdout === "string" ? mask(stdout) : "";
        const err = typeof stderr === "string" ? mask(stderr).slice(-400) : "";
        if (!error) {
          resolve({ code: 0, stdout: out, stderr: err, timedOut: false, aborted: false });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        const aborted = options.signal.aborted || failure.name === "AbortError";
        const timedOut = !aborted && failure.killed === true;
        resolve({
          code: typeof failure.code === "number" ? failure.code : null,
          stdout: out,
          stderr: err,
          timedOut,
          aborted,
        });
      },
    );
  });
}

/** 文字列の中のトークンと、それから作った認証ヘッダーの値を伏せる。 */
function redactor(token: string): (text: string) => string {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return (text) => text.split(token).join("[redacted]").split(basic).join("[redacted]");
}

async function readToken(tokenFile: string): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  let raw: string;
  try {
    raw = await readFile(tokenFile, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "不明";
    return { ok: false, reason: `GitHub のトークンのファイルを読めない（${code}）` };
  }
  const token = raw.trim();
  if (token === "") return { ok: false, reason: "GitHub のトークンのファイルが空" };
  if (!TOKEN_PATTERN.test(token)) return { ok: false, reason: "GitHub のトークンのファイルの中身がトークンの形ではない" };
  return { ok: true, token };
}

/** GitHub の API 用に、トークンのファイルを読む（drift.ts の PR 番号の取得）。読めなければ null（理由は返さない）。 */
export async function readTokenOrNull(tokenFile: string): Promise<string | null> {
  const result = await readToken(tokenFile);
  return result.ok ? result.token : null;
}

/**
 * チェックアウトで origin の main を取り、origin/main の先頭のコミットを返す。
 * 失敗しても投げず、理由（トークンを含まない）を返す。
 */
export async function fetchMain(
  checkout: string,
  repository: string,
  tokenFile: string,
  signal: AbortSignal,
): Promise<FetchMainResult> {
  if (!REPOSITORY_PATTERN.test(repository)) return { ok: false, reason: "リポジトリの指定が <owner>/<repo> の形ではない" };

  const read = await readToken(tokenFile);
  if (!read.ok) return { ok: false, reason: read.reason };
  const { token } = read;
  const redact = redactor(token);

  // トークンを送る先が、設定したリポジトリであること（別のリモートに向いていたら送らない）
  const remote = await runGit(checkout, ["remote", "get-url", "origin"], { signal, timeoutMs: GIT_READ_TIMEOUT_MS });
  if (remote.aborted) return { ok: false, reason: "打ち切られた" };
  if (remote.code !== 0) return { ok: false, reason: "origin のリモートを読めない" };
  // トークンは https://github.com/ 向けのヘッダーでしか使われない。ssh などの origin では fetch が認証に失敗し、
  // 資格情報ヘルパーなど別の経路に頼ることになるので、https の GitHub 以外は fetch しない
  if (!/^https:\/\/([^/@\s]+@)?github\.com\//i.test(remote.stdout.trim())) {
    return { ok: false, reason: "origin が https://github.com/ の URL ではないため、fetch しない" };
  }
  const origin = parseGithubOrigin(remote.stdout.trim());
  if (origin === null) return { ok: false, reason: "origin の URL が https://github.com/<owner>/<repo> の形ではないため、fetch しない" };
  if (`${origin.owner}/${origin.repo}`.toLowerCase() !== repository.toLowerCase()) {
    // 改名前の名前などで origin が別の名前のとき: GitHub の API で正体を確かめる（同じと分かったものは覚える）
    const cacheKey = `${origin.key}\n${repository.toLowerCase()}`;
    if (!acceptedOrigins.has(cacheKey)) {
      const confirmed = await confirmRenamedOrigin(origin, repository, token, signal);
      if (!confirmed.ok) return { ok: false, reason: confirmed.reason };
      acceptedOrigins.add(cacheKey);
      logLine("INFO", "setup-status", `origin（${origin.owner}/${origin.repo}）は ${repository} の旧名と確かめた（git remote set-url で直すとよい）`);
    }
  }

  const authorization = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const fetched = await runGit(checkout, ["fetch", "--no-tags", "origin", "main"], {
    signal,
    timeoutMs: GIT_FETCH_TIMEOUT_MS,
    redact,
    env: gitEnv({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: authorization,
      // 資格情報ヘルパーを空にして、トークンが失効したときに利用者の別の資格情報（広い権限）へ黙って切り替わらないようにする
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
      // システムの設定（/etc/gitconfig）は読まない（ヘルパーや http の設定が入っていても効かせない）
      GIT_CONFIG_NOSYSTEM: "1",
    }),
  });
  if (fetched.aborted) return { ok: false, reason: "打ち切られた" };
  if (fetched.timedOut) return { ok: false, reason: `git fetch が ${GIT_FETCH_TIMEOUT_MS / 1000} 秒で終わらなかった` };
  if (fetched.code !== 0) {
    const tail = redact(fetched.stderr).replace(/\s+/g, " ").trim().slice(-160);
    logLine("WARN", "setup-status", `git fetch が失敗: code=${fetched.code} stderr(末尾)=${tail}`);
    return { ok: false, reason: `git fetch が失敗した（終了コード ${fetched.code ?? "なし"}）${tail ? `: ${tail}` : ""}` };
  }

  const head = await runGit(checkout, ["rev-parse", "origin/main"], { signal, timeoutMs: GIT_READ_TIMEOUT_MS });
  const sha = head.stdout.trim();
  if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) return { ok: false, reason: "fetch の後に origin/main を読めない" };
  return { ok: true, head: sha };
}
