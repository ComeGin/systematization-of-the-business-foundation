// lib/drift.mjs（デプロイのずれの検知に使う git の比較）の単体テスト。
// git は呼ばない。ctx.run を、git のサブコマンドごとの応答に差し替える偽物にする（fakeCtx の overrides）。
import { describe, expect, it } from "vitest";
import { NON_CODE_EXCLUDES, commitDrift, describeChanges, headCommit, newestInMain, uncommittedPaths } from "../../lib/drift.mjs";
import { fakeCtx } from "../helpers/fake-ctx.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);

/** git の子コマンド名（-C <dir> の後ろの最初の語）を返す */
const sub = (args) => args[2];

/** run の偽物。handlers: { "merge-base": (args) => 出力 | 投げる, log: ..., "rev-list": ... }。呼ばれた (cmd, args) を calls に残す */
function gitRun(handlers) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push({ cmd, args });
    const handler = handlers[sub(args)];
    if (!handler) throw new Error(`想定外の git: ${args.join(" ")}`);
    return handler(args);
  };
  return { run, calls };
}

/** 終了コードを持つ失敗（本物の ctx.run が投げるものと同じ形） */
const exit = (code) => Object.assign(new Error(`git が失敗した（終了コード ${code}）`), { exitCode: code });

const logLine = (sha, subject) => `${sha}\t2026-11-11T09:00:00+09:00\t${subject}`;

describe("commitDrift", () => {
  describe("正常系", () => {
    it("入力: recorded が null か unrecorded なら kind unrecorded で、git を呼ばない", async () => {
      const { run, calls } = gitRun({});
      const ctx = fakeCtx({ overrides: { run } });
      expect(await commitDrift(ctx, { recorded: null, paths: ["cloud/template.yaml"] })).toEqual({ kind: "unrecorded" });
      expect(await commitDrift(ctx, { recorded: "unrecorded", paths: ["cloud/template.yaml"] })).toEqual({ kind: "unrecorded" });
      expect(calls).toEqual([]);
    });

    it("入力: log の出力が空なら kind clean", async () => {
      const { run } = gitRun({ "merge-base": () => "", log: () => "" });
      const ctx = fakeCtx({ overrides: { run } });
      expect(await commitDrift(ctx, { recorded: A, paths: ["cloud/template.yaml"] })).toEqual({ kind: "clean", commit: A });
    });

    it("入力: log の出力が 2 行なら kind changed で entries は 2 件、新しい順", async () => {
      const { run } = gitRun({
        "merge-base": () => "",
        log: () => `${logLine(C, "新しい変更")}\n${logLine(B, "古い変更")}\n`,
      });
      const ctx = fakeCtx({ overrides: { run } });
      const drift = await commitDrift(ctx, { recorded: A, paths: ["cloud/template.yaml"] });
      expect(drift).toEqual({
        kind: "changed",
        commit: A,
        entries: [
          { sha: C, subject: "新しい変更" },
          { sha: B, subject: "古い変更" },
        ],
      });
    });

    it("入力: log の件名にタブがあっても、件名として残す", async () => {
      const { run } = gitRun({ "merge-base": () => "", log: () => `${B}\t2026-11-11T09:00:00+09:00\tadd:\tタブ入り\n` });
      const ctx = fakeCtx({ overrides: { run } });
      const drift = await commitDrift(ctx, { recorded: A, paths: ["x"] });
      expect(drift.entries).toEqual([{ sha: B, subject: "add:\tタブ入り" }]);
    });

    it("入力: log の引数に NON_CODE_EXCLUDES と <recorded>..origin/main が入り、git は -C ctx.WORKTREE で呼ばれる", async () => {
      const { run, calls } = gitRun({ "merge-base": () => "", log: () => "" });
      const ctx = fakeCtx({ overrides: { run } });
      await commitDrift(ctx, { recorded: A, paths: ["cloud/template.yaml", "cloud/stacks"] });
      expect(calls.length).toBe(2);
      for (const call of calls) {
        expect(call.cmd).toBe("git");
        expect(call.args.slice(0, 2)).toEqual(["-C", ctx.WORKTREE]);
      }
      const merge = calls.find((c) => sub(c.args) === "merge-base");
      expect(merge.args).toEqual(["-C", ctx.WORKTREE, "merge-base", "--is-ancestor", A, "origin/main"]);
      const log = calls.find((c) => sub(c.args) === "log");
      expect(log.args).toContain(`${A}..origin/main`);
      expect(log.args).toContain("--format=%H%x09%cI%x09%s");
      const sep = log.args.indexOf("--");
      expect(log.args.slice(sep + 1)).toEqual(["cloud/template.yaml", "cloud/stacks", ...NON_CODE_EXCLUDES]);
    });

    it("入力: NON_CODE_EXCLUDES は *.md とテスト類を除くパススペック", () => {
      expect(NON_CODE_EXCLUDES.length).toBeGreaterThan(0);
      for (const spec of NON_CODE_EXCLUDES) expect(spec.startsWith(":(exclude,glob)")).toBe(true);
      const joined = NON_CODE_EXCLUDES.join("\n");
      for (const word of ["*.md", "*.test.*", "tests", "integration", "e2e"]) expect(joined).toContain(word);
    });
  });

  describe("異常系", () => {
    it("入力: merge-base --is-ancestor が 1 を返すと kind outside-main", async () => {
      const { run, calls } = gitRun({
        "merge-base": () => {
          throw exit(1);
        },
      });
      const ctx = fakeCtx({ overrides: { run } });
      expect(await commitDrift(ctx, { recorded: A, paths: ["cloud/template.yaml"] })).toEqual({ kind: "outside-main", commit: A });
      expect(calls.some((c) => sub(c.args) === "log")).toBe(false);
    });

    it("サーバ: merge-base が 1 以外で失敗したら（コミットが無い・origin/main が無い）例外のまま投げる", async () => {
      const { run } = gitRun({
        "merge-base": () => {
          throw exit(128);
        },
      });
      const ctx = fakeCtx({ overrides: { run } });
      await expect(commitDrift(ctx, { recorded: A, paths: ["x"] })).rejects.toThrow("終了コード 128");
    });

    it("サーバ: log が失敗したら例外のまま投げる", async () => {
      const { run } = gitRun({
        "merge-base": () => "",
        log: () => {
          throw exit(128);
        },
      });
      const ctx = fakeCtx({ overrides: { run } });
      await expect(commitDrift(ctx, { recorded: A, paths: ["x"] })).rejects.toThrow("終了コード 128");
    });
  });
});

describe("newestInMain", () => {
  describe("正常系", () => {
    it("入力: 履歴に無いものを除き、rev-list --count が最小のものを返す", async () => {
      const counts = { [A]: "5", [B]: "2", [D]: "9" };
      const { run } = gitRun({
        "merge-base": (args) => {
          if (args.includes(C)) throw exit(1); // C は origin/main の履歴に無い
          return "";
        },
        "rev-list": (args) => {
          const commit = args[args.length - 1].split("..")[0];
          return `${counts[commit]}\n`;
        },
      });
      const ctx = fakeCtx({ overrides: { run } });
      expect(await newestInMain(ctx, [A, B, C, D])).toBe(B);
    });

    it("入力: rev-list は <commit>..origin/main を -C ctx.WORKTREE で数える", async () => {
      const { run, calls } = gitRun({ "merge-base": () => "", "rev-list": () => "0\n" });
      const ctx = fakeCtx({ overrides: { run } });
      await newestInMain(ctx, [A]);
      const rev = calls.find((c) => sub(c.args) === "rev-list");
      expect(rev.args).toEqual(["-C", ctx.WORKTREE, "rev-list", "--count", `${A}..origin/main`]);
    });
  });

  describe("異常系", () => {
    it("空入力: コミットが 0 件なら null で、git を呼ばない", async () => {
      const { run, calls } = gitRun({});
      const ctx = fakeCtx({ overrides: { run } });
      expect(await newestInMain(ctx, [])).toBeNull();
      expect(calls).toEqual([]);
    });

    it("入力: すべて履歴に無ければ null", async () => {
      const { run } = gitRun({
        "merge-base": () => {
          throw exit(1);
        },
      });
      const ctx = fakeCtx({ overrides: { run } });
      expect(await newestInMain(ctx, [A, B])).toBeNull();
    });
  });
});

describe("describeChanges", () => {
  describe("正常系", () => {
    it("入力: 3 件なら「3 件: 最初 … 〜 最後 …」（entries は新しい順なので、最初は末尾・最後は先頭）", () => {
      const entries = [
        { sha: C, subject: "最後の件名" },
        { sha: B, subject: "真ん中" },
        { sha: A, subject: "最初の件名" },
      ];
      expect(describeChanges(entries)).toBe("3 件: 最初 aaaaaaa 最初の件名 〜 最後 ccccccc 最後の件名");
    });

    it("入力: 1 件なら範囲にせず、そのコミットだけ", () => {
      expect(describeChanges([{ sha: A, subject: "ひとつだけ" }])).toBe("1 件: aaaaaaa ひとつだけ");
    });

    it("入力: 件名は 50 字で切り、超えたら … を付ける", () => {
      const long = "あ".repeat(60);
      const text = describeChanges([{ sha: A, subject: long }]);
      expect(text).toBe(`1 件: aaaaaaa ${"あ".repeat(49)}…`);
      const exact = "い".repeat(50);
      expect(describeChanges([{ sha: A, subject: exact }])).toBe(`1 件: aaaaaaa ${exact}`);
    });
  });

  describe("異常系", () => {
    it("空入力: 0 件なら 0 件とだけ返す", () => {
      expect(describeChanges([])).toBe("0 件");
    });
  });
});

describe("uncommittedPaths", () => {
  describe("正常系", () => {
    it("入力: porcelain の行を返し、空なら []", async () => {
      const seen = [];
      const run = async (cmd, args) => {
        seen.push({ cmd, args });
        return " M cloud/template.yaml\n?? cloud/stacks/new.yaml\n";
      };
      expect(await uncommittedPaths("/repo", ["cloud/template.yaml", "cloud/stacks"], run)).toEqual([
        " M cloud/template.yaml",
        "?? cloud/stacks/new.yaml",
      ]);
      expect(seen).toEqual([
        { cmd: "git", args: ["-C", "/repo", "status", "--porcelain", "--", "cloud/template.yaml", "cloud/stacks"] },
      ]);
      expect(await uncommittedPaths("/repo", ["cloud"], async () => "")).toEqual([]);
      expect(await uncommittedPaths("/repo", ["cloud"], async () => "\n")).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("サーバ: git が失敗したら例外のまま投げる", async () => {
      await expect(
        uncommittedPaths("/repo", ["cloud"], async () => {
          throw exit(128);
        }),
      ).rejects.toThrow("終了コード 128");
    });
  });
});

describe("headCommit", () => {
  describe("正常系", () => {
    it("入力: git -C <repoDir> rev-parse HEAD の出力の前後の空白を除いて返す", async () => {
      const seen = [];
      const run = async (cmd, args) => {
        seen.push({ cmd, args });
        return `${A}\n`;
      };
      expect(await headCommit("/repo", run)).toBe(A);
      expect(seen).toEqual([{ cmd: "git", args: ["-C", "/repo", "rev-parse", "HEAD"] }]);
    });
  });

  describe("異常系", () => {
    it("サーバ: 40 桁でない出力なら例外にする", async () => {
      await expect(headCommit("/repo", async () => "fatal: not a repo\n")).rejects.toThrow("HEAD");
    });
  });
});
