import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 子プロセス（git）は差し替える。実リポジトリ・実 GitHub には繋がない
type Callback = (error: Error | null, stdout: string, stderr: string) => void;
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { clearOriginCache, fetchMain, runGit } from "../../src/status/git-fetch.js";

const TOKEN = "github_pat_SECRET_TOKEN_value_1234567890";
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
const HEAD = "a".repeat(40);
const REPOSITORY = "ComeGin/systematization-of-the-business-foundation";
const CHECKOUT = "/srv/main-checkout";

interface Call {
  args: string[];
  childEnv: NodeJS.ProcessEnv;
  timeout: number;
}
const calls = (): Call[] =>
  execFileMock.mock.calls.map((call) => ({
    args: call[1] as string[],
    childEnv: (call[2] as { env: NodeJS.ProcessEnv }).env,
    timeout: (call[2] as { timeout: number }).timeout,
  }));
const subcommand = (call: Call) => call.args[2];

/** サブコマンドごとの応答。code が 0 以外なら失敗として返す。 */
function respond(handlers: Record<string, { code?: number; stdout?: string; stderr?: string }>) {
  execFileMock.mockImplementation((_file: string, args: string[], _options: unknown, callback: Callback) => {
    const handler = handlers[args[2]!] ?? { stdout: "" };
    if (handler.code) callback(Object.assign(new Error("failed"), { code: handler.code }), handler.stdout ?? "", handler.stderr ?? "");
    else callback(null, handler.stdout ?? "", handler.stderr ?? "");
    return {};
  });
}

let dir: string;
let tokenFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "git-fetch-test-"));
  tokenFile = join(dir, "github-token");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  execFileMock.mockReset();
  clearOriginCache();
  // GitHub の API（origin の名前の正体を引く）も差し替える。既定は呼ばれたら失敗させる
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("想定外の fetch"); }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

const fetchMock = () => globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
/** GitHub の API の応答（full_name）を決める */
const githubReturns = (status: number, body: unknown) =>
  fetchMock().mockImplementation(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
const OLD_ORIGIN = "https://github.com/kamegin4-aws/systematization-of-the-business-foundation.git";

const signal = () => new AbortController().signal;

describe("fetchMain", () => {
  describe("正常系", () => {
    it("入力: origin が改名前の名前でも、GitHub の API の full_name が設定と同じなら fetch する（トークンは Authorization ヘッダーで送る）", async () => {
      respond({ remote: { stdout: `${OLD_ORIGIN}\n` }, "rev-parse": { stdout: `${HEAD}\n` } });
      githubReturns(200, { full_name: REPOSITORY });
      const result = await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal());
      expect(result).toEqual({ ok: true, head: HEAD });
      expect(calls().map(subcommand)).toEqual(["remote", "fetch", "rev-parse"]);
      const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.github.com/repos/kamegin4-aws/systematization-of-the-business-foundation");
      expect(init.redirect).toBe("follow");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      // fetch は origin のまま（URL を書き換えない）
      expect(calls()[1]!.args).toEqual(["-C", CHECKOUT, "fetch", "--no-tags", "origin", "main"]);
    });

    it("入力: full_name の大文字・小文字は区別しない", async () => {
      respond({ remote: { stdout: OLD_ORIGIN }, "rev-parse": { stdout: `${HEAD}\n` } });
      githubReturns(200, { full_name: REPOSITORY.toUpperCase() });
      expect((await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal())).ok).toBe(true);
    });

    it("入力: 同じと確かめた origin はプロセス内で覚え、2 回目からは GitHub の API を呼ばない", async () => {
      respond({ remote: { stdout: OLD_ORIGIN }, "rev-parse": { stdout: `${HEAD}\n` } });
      githubReturns(200, { full_name: REPOSITORY });
      expect((await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal())).ok).toBe(true);
      expect((await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal())).ok).toBe(true);
      expect(fetchMock()).toHaveBeenCalledTimes(1);
    });

    it("入力: 違うと分かった（または確かめられなかった）origin は覚えず、次の回も確かめる", async () => {
      respond({ remote: { stdout: OLD_ORIGIN } });
      githubReturns(503, {});
      expect((await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal())).ok).toBe(false);
      expect((await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal())).ok).toBe(false);
      expect(fetchMock()).toHaveBeenCalledTimes(2);
    });

    it("入力: origin が設定と同じ名前（大文字・小文字・.git の有無は問わない）なら GitHub の API は呼ばない", async () => {
      respond({ remote: { stdout: `https://github.com/${REPOSITORY.toLowerCase()}` }, "rev-parse": { stdout: `${HEAD}\n` } });
      expect((await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal())).ok).toBe(true);
      expect(fetchMock()).not.toHaveBeenCalled();
    });

    it("入力: fetch に成功したら origin/main の先頭のコミットを返す", async () => {
      respond({
        remote: { stdout: `https://github.com/${REPOSITORY}.git\n` },
        "rev-parse": { stdout: `${HEAD}\n` },
      });
      expect(await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal())).toEqual({ ok: true, head: HEAD });
      expect(calls().map(subcommand)).toEqual(["remote", "fetch", "rev-parse"]);
      expect(calls()[1]!.args).toEqual(["-C", CHECKOUT, "fetch", "--no-tags", "origin", "main"]);
      expect(calls()[1]!.timeout).toBe(60_000);
    });

    it("入力: トークンは GIT_CONFIG_* の環境変数だけで渡し、引数には入れない（fetch の環境変数だけ）", async () => {
      respond({ remote: { stdout: `https://github.com/${REPOSITORY}.git` }, "rev-parse": { stdout: HEAD } });
      await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal());
      const [remote, fetched, revParse] = calls();
      expect(fetched!.childEnv).toMatchObject({
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${BASIC}`,
        GIT_TERMINAL_PROMPT: "0",
      });
      for (const call of calls()) {
        expect(JSON.stringify(call.args)).not.toContain(TOKEN);
        expect(JSON.stringify(call.args)).not.toContain(BASIC);
      }
      // fetch 以外にはトークンを渡さない
      expect(remote!.childEnv.GIT_CONFIG_VALUE_0).toBeUndefined();
      expect(revParse!.childEnv.GIT_CONFIG_VALUE_0).toBeUndefined();
    });

    it("入力: 資格情報ヘルパーを空にし、システムの git の設定を読まない（失効時に別の資格情報へ切り替わらない）", async () => {
      respond({ remote: { stdout: `https://github.com/${REPOSITORY}` }, "rev-parse": { stdout: HEAD } });
      await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal());
      const fetched = calls()[1]!;
      expect(fetched.childEnv).toMatchObject({
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_1: "credential.helper",
        GIT_CONFIG_VALUE_1: "",
        GIT_CONFIG_NOSYSTEM: "1",
      });
      // fetch 以外には、これらも渡さない
      expect(calls()[0]!.childEnv.GIT_CONFIG_COUNT).toBeUndefined();
    });

    it("入力: 子プロセスの環境変数は許可リストだけ（呼び出し元の秘密の環境変数を引き継がない）", async () => {
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "do-not-leak");
      vi.stubEnv("CONTROL_ANTHROPIC_API_KEY", "do-not-leak");
      respond({ remote: { stdout: `https://github.com/${REPOSITORY}` }, "rev-parse": { stdout: HEAD } });
      await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal());
      for (const call of calls()) {
        const names = Object.keys(call.childEnv).filter((name) => !name.startsWith("GIT_CONFIG_"));
        expect(names.every((name) => ["PATH", "HOME", "LANG", "GIT_TERMINAL_PROMPT"].includes(name))).toBe(true);
        expect(JSON.stringify(call.childEnv)).not.toContain("do-not-leak");
      }
    });

    it("入力: トークンのファイルは呼ぶたびに読み直す", async () => {
      respond({ remote: { stdout: `https://github.com/${REPOSITORY}` }, "rev-parse": { stdout: HEAD } });
      await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal());
      writeFileSync(tokenFile, "github_pat_ROTATED_value\n");
      await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal());
      const fetches = calls().filter((call) => subcommand(call) === "fetch");
      expect(fetches[1]!.childEnv.GIT_CONFIG_VALUE_0).toBe(
        `AUTHORIZATION: basic ${Buffer.from("x-access-token:github_pat_ROTATED_value").toString("base64")}`,
      );
    });
  });

  describe("異常系", () => {
    it("サーバ: fetch が失敗したら { ok: false, reason } を返し、reason にもログにもトークンを出さない", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      respond({
        remote: { stdout: `https://github.com/${REPOSITORY}` },
        fetch: {
          code: 128,
          stderr: `fatal: unable to access: The requested URL returned error: 401 header AUTHORIZATION: basic ${BASIC} token ${TOKEN}`,
        },
      });
      const result = await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal());
      expect(result.ok).toBe(false);
      const reason = (result as { reason: string }).reason;
      expect(reason).toContain("128");
      expect(reason).not.toContain(TOKEN);
      expect(reason).not.toContain(BASIC);
      expect(JSON.stringify(logged.mock.calls)).not.toContain(TOKEN);
      expect(JSON.stringify(logged.mock.calls)).not.toContain(BASIC);
      expect(calls().map(subcommand)).not.toContain("rev-parse");
    });

    it("サーバ: fetch が時間切れ（kill）なら reason に秒数を出す", async () => {
      execFileMock.mockImplementation((_file: string, args: string[], _options: unknown, callback: Callback) => {
        if (args[2] === "remote") callback(null, `https://github.com/${REPOSITORY}`, "");
        else callback(Object.assign(new Error("killed"), { killed: true, code: null }), "", "");
        return {};
      });
      const result = await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal());
      expect(result).toEqual({ ok: false, reason: "git fetch が 60 秒で終わらなかった" });
    });

    it("入力: origin が別のリポジトリ（API の full_name が設定と違う）なら fetch しない", async () => {
      respond({ remote: { stdout: "https://github.com/someone/else.git" } });
      githubReturns(200, { full_name: "someone/else" });
      const result = await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal());
      expect(result).toEqual({ ok: false, reason: `origin が ${REPOSITORY} を指していないため、fetch しない` });
      expect(calls().map(subcommand)).toEqual(["remote"]);
      expect(fetchMock().mock.calls[0]![0]).toBe("https://api.github.com/repos/someone/else");
    });

    it("サーバ: origin の名前の正体を GitHub の API で引けなければ（404・接続できない）fetch せず、理由にトークンを出さない", async () => {
      respond({ remote: { stdout: OLD_ORIGIN } });
      githubReturns(404, { message: "Not Found" });
      const notFound = await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal());
      expect(notFound).toEqual({
        ok: false,
        reason: `origin（kamegin4-aws/systematization-of-the-business-foundation）が ${REPOSITORY} と同じか GitHub の API で確かめられない（HTTP 404）`,
      });
      fetchMock().mockRejectedValue(new TypeError("fetch failed"));
      const offline = await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal());
      expect(offline.ok).toBe(false);
      expect(JSON.stringify(offline)).toMatch(/接続できない/);
      for (const result of [notFound, offline]) {
        expect(JSON.stringify(result)).not.toContain(TOKEN);
      }
      expect(calls().map(subcommand)).toEqual(["remote", "remote"]);
    });

    it("サーバ: GitHub の API の応答が JSON でなければ fetch しない", async () => {
      respond({ remote: { stdout: OLD_ORIGIN } });
      fetchMock().mockImplementation(async () => new Response("<html>", { status: 200 }));
      const result = await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal());
      expect(result.ok).toBe(false);
      expect(calls().map(subcommand)).toEqual(["remote"]);
    });

    it("入力: origin の URL に認証情報が入っていても、理由にもログにも出さない", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      respond({ remote: { stdout: "https://user:origin-secret-pass@github.com/someone/else.git" } });
      githubReturns(200, { full_name: "someone/else" });
      const result = await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal());
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("origin-secret-pass");
      expect(JSON.stringify(logged.mock.calls)).not.toContain("origin-secret-pass");
    });

    it("入力: origin が ssh の URL なら fetch しない（https 以外ではトークンが使われない）", async () => {
      respond({ remote: { stdout: `git@github.com:${REPOSITORY}.git` } });
      const result = await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal());
      expect(result).toEqual({ ok: false, reason: "origin が https://github.com/ の URL ではないため、fetch しない" });
      expect(calls().map(subcommand)).toEqual(["remote"]);
    });

    it("入力: origin が github.com 以外の https なら fetch しない", async () => {
      respond({ remote: { stdout: `https://example.test/${REPOSITORY}.git` } });
      const result = await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal());
      expect(result.ok).toBe(false);
      expect(calls().map(subcommand)).toEqual(["remote"]);
    });

    it("サーバ: stderr の末尾 400 文字の切れ目にトークンがかかっても、断片を残さない（伏せてから切る）", async () => {
      // 切れ目が、トークンの 12 文字目あたりに来る位置にトークンを置く
      const after = "z".repeat(400 - (TOKEN.length - 12));
      respond({ fetch: { code: 128, stderr: `${"a".repeat(300)}${TOKEN}${after}` } });
      const redact = (text: string) => text.split(TOKEN).join("[redacted]");
      const withMask = await runGit(CHECKOUT, ["fetch"], { signal: signal(), timeoutMs: 1000, redact });
      expect(withMask.stderr).not.toContain(TOKEN.slice(12, 24));
      expect(withMask.stderr).not.toContain(TOKEN.slice(-12));
      expect(withMask.stderr.length).toBeLessThanOrEqual(400);
      // 伏せなければ（切った後に伏せる従来の順序では）、断片が残る場面であること
      const withoutMask = await runGit(CHECKOUT, ["fetch"], { signal: signal(), timeoutMs: 1000 });
      expect(withoutMask.stderr).toContain(TOKEN.slice(-12));
    });

    it("入力: fetch の後の rev-parse が 40 桁を返さなければ失敗にする", async () => {
      respond({ remote: { stdout: `https://github.com/${REPOSITORY}` }, "rev-parse": { stdout: "not-a-sha\n" } });
      const result = await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal());
      expect(result.ok).toBe(false);
    });

    it("空入力: トークンのファイルが空なら git を起動しない", async () => {
      writeFileSync(tokenFile, "  \n");
      const result = await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal());
      expect(result).toEqual({ ok: false, reason: "GitHub のトークンのファイルが空" });
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("入力: トークンのファイルが無ければ git を起動しない", async () => {
      const result = await fetchMain(CHECKOUT, REPOSITORY, join(dir, "missing"), signal());
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toContain("ENOENT");
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("入力: トークンに改行・空白が混ざっていたら使わない", async () => {
      writeFileSync(tokenFile, "abc def\nghi");
      const result = await fetchMain(CHECKOUT, REPOSITORY, tokenFile, signal());
      expect(result.ok).toBe(false);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("入力: リポジトリが <owner>/<repo> の形でなければ何もしない", async () => {
      const result = await fetchMain(CHECKOUT, "not a repo", tokenFile, signal());
      expect(result.ok).toBe(false);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("入力: 既に打ち切られていたら git を起動しない", async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await fetchMain(CHECKOUT, REPOSITORY, tokenFile, controller.signal);
      expect(result).toEqual({ ok: false, reason: "打ち切られた" });
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });
});
