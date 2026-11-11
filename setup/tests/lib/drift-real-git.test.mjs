// setup/lib/drift.mjs の commitDrift を、一時ディレクトリに git init した本物のリポジトリで動かすテスト。
// 偽の run（drift.test.mjs）では確かめられない、git のパススペック（*.md・tests/ の除外）・`merge-base --is-ancestor` の終了コード 1・
// `<記録>..origin/main` の範囲の解釈を、本物の git で確かめる。origin/main の代わりに refs/remotes/origin/main を update-ref で作る（ネットワークは使わない）。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../../lib/core.mjs";
import { commitDrift, commitInMain } from "../../lib/drift.mjs";

let dir;
const commits = {};

// 利用者の git の設定（署名・フックなど）に左右されないように、設定ファイルを読ませない
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};
const git = (...args) => execFileSync("git", ["-C", dir, ...args], { env: GIT_ENV, encoding: "utf8" }).trim();
const write = (path, text) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};
const commit = (subject) => {
  git("add", "-A");
  git("commit", "-q", "--no-verify", "-m", subject);
  return git("rev-parse", "HEAD");
};
const setMain = (sha) => git("update-ref", "refs/remotes/origin/main", sha);
const ctx = () => ({ run, WORKTREE: dir });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "drift-real-git-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: GIT_ENV });
  write("cloud/global/template.yaml", "Resources: {}\n");
  write("cloud/template.yaml", "Resources: {}\n");
  commits.base = commit("add: 最初");
  // コードでない変更だけ（*.md と tests/ の下）
  write("cloud/global/README.md", "# 説明\n");
  write("cloud/global/tests/stack.test.mjs", "// テスト\n");
  commits.docs = commit("mod: 説明とテストだけ");
  // 比べるパスの外の変更
  write("cloud/template.yaml", "Resources: { A: {} }\n");
  commits.other = commit("mod: 本番スタックだけ");
  // 比べるパスのコードの変更
  write("cloud/global/template.yaml", "Resources: { Waf: {} }\n");
  commits.code = commit("mod: global の WAF");
  // main の履歴に無いコミット（base から分かれた。作業ツリーは動かさず、配管のコマンドで作る）
  commits.side = git("commit-tree", `${commits.base}^{tree}`, "-p", commits.base, "-m", "side: ブランチ");
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("commitDrift（本物の git）: 正常系", () => {
  it("入力: 記録の後が *.md と tests/ の変更・比べるパスの外の変更だけなら clean", async () => {
    setMain(commits.other);
    const r = await commitDrift(ctx(), { recorded: commits.base, paths: ["cloud/global"] });
    expect(r).toEqual({ kind: "clean", commit: commits.base });
  });

  it("入力: 記録の後に比べるパスのコードの変更があれば changed で、その 1 件だけが新しい順に入る", async () => {
    setMain(commits.code);
    const r = await commitDrift(ctx(), { recorded: commits.base, paths: ["cloud/global"] });
    expect(r.kind).toBe("changed");
    expect(r.entries).toEqual([{ sha: commits.code, subject: "mod: global の WAF" }]);
  });

  it("入力: 記録が origin/main と同じなら clean（範囲が空）", async () => {
    setMain(commits.code);
    const r = await commitDrift(ctx(), { recorded: commits.code, paths: ["cloud/global"] });
    expect(r.kind).toBe("clean");
  });

  it("入力: 2 つのパスのどちらかの変更でも数え、新しい順に並ぶ", async () => {
    setMain(commits.code);
    const r = await commitDrift(ctx(), { recorded: commits.base, paths: ["cloud/global", "cloud/template.yaml"] });
    expect(r.kind).toBe("changed");
    expect(r.entries.map((e) => e.sha)).toEqual([commits.code, commits.other]);
  });

  it("空入力: 記録が unrecorded・null なら git を呼ばずに unrecorded", async () => {
    expect(await commitDrift(ctx(), { recorded: "unrecorded", paths: ["cloud/global"] })).toEqual({ kind: "unrecorded" });
    expect(await commitDrift(ctx(), { recorded: null, paths: ["cloud/global"] })).toEqual({ kind: "unrecorded" });
  });
});

describe("commitDrift（本物の git）: 異常系", () => {
  it("入力: 記録が origin/main の履歴に無い（merge-base --is-ancestor が終了コード 1）と outside-main", async () => {
    setMain(commits.code);
    const r = await commitDrift(ctx(), { recorded: commits.side, paths: ["cloud/global"] });
    expect(r).toEqual({ kind: "outside-main", commit: commits.side });
    expect(await commitInMain(dir, commits.side, run)).toBe(false);
    expect(await commitInMain(dir, commits.base, run)).toBe(true);
  });

  it("入力: 記録がリポジトリに無いコミットなら（終了コード 1 以外）、比べられないので例外", async () => {
    setMain(commits.code);
    await expect(commitDrift(ctx(), { recorded: "f".repeat(40), paths: ["cloud/global"] })).rejects.toThrow();
  });

  it("入力: origin/main が無いと例外（outside-main と取り違えない）", async () => {
    git("update-ref", "-d", "refs/remotes/origin/main");
    await expect(commitDrift(ctx(), { recorded: commits.base, paths: ["cloud/global"] })).rejects.toThrow();
    setMain(commits.code);
  });
});
