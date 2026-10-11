// 基準 D の例外: ガードの判定そのものが realpath・シンボリックリンクの解決（ファイル操作）のため、
// os.tmpdir() の下の一時ディレクトリに実際のディレクトリとリンクを作って確かめる。Agent SDK は型だけを使う（呼ばない）。
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type GuardPaths,
  checkPathAccess,
  checkWriteAccess,
  createPreToolUseGuard,
  inspectToolCall,
} from "../../src/runner/hooks.js";
import { tempDir, writeAt } from "../helpers/runner.js";

let root: string;
let cleanup: () => void;
let paths: GuardPaths;
let wt: string;

beforeEach(() => {
  const temp = tempDir("cp-hooks-");
  root = realpathSync(temp.dir);
  cleanup = temp.cleanup;
  wt = join(root, "wt");
  for (const dir of ["wt", "data", "main", "home/.aws", "home/.config/comegin", "agenthome"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  paths = {
    worktree: wt,
    dataDir: join(root, "data"),
    mainCheckout: join(root, "main"),
    realHome: join(root, "home"),
    agentHome: join(root, "agenthome"),
  };
});

afterEach(() => cleanup());

describe("checkPathAccess（読み書き共通）", () => {
  describe("正常系", () => {
    it("作業ツリーの中は、存在しないファイルでも許す", () => {
      writeAt(wt, "docs/audits/gsc/a.md", "x");
      expect(checkPathAccess(join(wt, "docs/audits/gsc/a.md"), paths)).toBeNull();
      expect(checkPathAccess(join(wt, "docs/audits/gsc/new/b.md"), paths)).toBeNull();
      expect(checkPathAccess("docs/audits/gsc/a.md", paths)).toBeNull();
    });

    it.each([".env.example", ".env.sample", ".env.template", ".envrc-notes.md", ".github/workflows/ci.yml"])(
      "%s は秘匿ファイルとして扱わない",
      (relative) => {
        expect(checkPathAccess(join(wt, relative), paths)).toBeNull();
      },
    );

    it("作業ツリー自体がシンボリックリンクでも、その中は許す", () => {
      const link = join(root, "wt-link");
      symlinkSync(wt, link);
      expect(checkPathAccess(join(link, "docs/a.md"), { ...paths, worktree: link })).toBeNull();
      expect(checkPathAccess(join(wt, "docs/a.md"), { ...paths, worktree: link })).toBeNull();
    });

    it("空入力: 空のパスは作業ツリー自体を指すとして許す", () => {
      expect(checkPathAccess("", paths)).toBeNull();
    });

    it("空入力: CONTROL_AGENT_HOME が無い（null）ときも他の拒否は効く", () => {
      const withoutAgentHome = { ...paths, agentHome: null };
      expect(checkPathAccess(join(root, "agenthome/.claude.json"), withoutAgentHome)).toBe("file access is limited to the working tree");
      expect(checkPathAccess(join(root, "data/e15.sqlite"), withoutAgentHome)).toBe("this location is not accessible");
    });
  });

  describe("異常系", () => {
    it("入力: 作業ツリーの外は拒否する（.. で抜けるものも）", () => {
      expect(checkPathAccess("/etc/passwd", paths)).toBe("file access is limited to the working tree");
      expect(checkPathAccess("../outside.txt", paths)).toBe("file access is limited to the working tree");
      expect(checkPathAccess(join(wt, "docs/../../outside.txt"), paths)).toBe("file access is limited to the working tree");
    });

    it.each([
      [".env", "environment files are not accessible"],
      [".env.local", "environment files are not accessible"],
      [".env.production", "environment files are not accessible"],
      ["frontend/next-js/.env", "environment files are not accessible"],
      ["cloud/samconfig.toml", "samconfig.toml is not accessible"],
      ["secrets/key.pem", "secrets/ is not accessible"],
      ["a/secrets/b/c.txt", "secrets/ is not accessible"],
      [".git/config", ".git is not accessible"],
      ["sub/.git/HEAD", ".git is not accessible"],
    ])("入力: 作業ツリーの中でも %s は拒否する", (relative, reason) => {
      expect(checkPathAccess(join(wt, relative), paths)).toBe(reason);
    });

    it("入力: CONTROL_DATA_DIR・main・~/.aws・~/.config/comegin・CONTROL_AGENT_HOME を拒否する", () => {
      const denied = "this location is not accessible";
      expect(checkPathAccess(join(root, "data/e15.sqlite"), paths)).toBe(denied);
      expect(checkPathAccess(join(root, "main/.claude/agents/x.md"), paths)).toBe(denied);
      expect(checkPathAccess(join(root, "home/.aws/credentials"), paths)).toBe(denied);
      expect(checkPathAccess(join(root, "home/.config/comegin/setup/dev.state.json"), paths)).toBe(denied);
      expect(checkPathAccess(join(root, "agenthome/.claude.json"), paths)).toBe(denied);
    });

    it("入力: 拒否する場所が作業ツリーの中にあっても拒否する", () => {
      const nested = { ...paths, dataDir: join(wt, "var/control-data") };
      expect(checkPathAccess(join(wt, "var/control-data/e15.sqlite"), nested)).toBe("this location is not accessible");
    });

    it("入力: 作業ツリーの中のシンボリックリンクは実体で判定する", () => {
      symlinkSync(join(root, "main"), join(wt, "main-link"));
      writeAt(wt, ".env", "SECRET=1");
      symlinkSync(join(wt, ".env"), join(wt, "innocent.txt"));
      symlinkSync("/etc", join(wt, "etc-link"));
      expect(checkPathAccess(join(wt, "main-link/README.md"), paths)).toBe("this location is not accessible");
      expect(checkPathAccess(join(wt, "innocent.txt"), paths)).toBe("environment files are not accessible");
      expect(checkPathAccess(join(wt, "etc-link/new-file"), paths)).toBe("file access is limited to the working tree");
    });

    it("入力: 作業ツリーと名前の前方が同じだけの兄弟ディレクトリは外として扱う", () => {
      mkdirSync(join(root, "wt-other"));
      expect(checkPathAccess(join(root, "wt-other/a.md"), paths)).toBe("file access is limited to the working tree");
    });
  });
});

describe("checkWriteAccess（書き込み系だけの追加の拒否）", () => {
  describe("正常系", () => {
    it.each([
      "MarketingDepartment/WebsiteOperations/docs/audits/gsc/AUD-2026-1004-gsc-0001.md",
      "MarketingDepartment/WebsiteOperations/docs/proposals/PRP-2026-0001.md",
      "MarketingDepartment/WebsiteOperations/frontend/verdant-virgo/src/components/Hero.astro",
      "MarketingDepartment/WebsiteOperations/ops-notes/memo.md",
      "MarketingDepartment/WebsiteOperations/cloudy/memo.md",
      "scripts/build.sh",
      "docs/dev-notes/run.sh",
      "frontend/verdant-virgo/src/config.json",
    ])("%s は書ける", (relative) => {
      expect(checkWriteAccess(join(wt, relative), paths)).toBeNull();
    });

    it(".github と名前の前方だけ同じディレクトリ（.github-notes）は拒否しない", () => {
      expect(checkWriteAccess(join(wt, ".github-notes/memo.md"), paths)).toBeNull();
    });

    it("作業ツリーの外は判定しない（checkPathAccess に任せる）", () => {
      expect(checkWriteAccess("/etc/package.json", paths)).toBeNull();
    });

    it("空入力: 空のパス（作業ツリー自体）には追加の拒否をしない", () => {
      expect(checkWriteAccess("", paths)).toBeNull();
    });
  });

  describe("異常系", () => {
    it.each([
      ["package.json", "package and build configuration cannot be written"],
      ["frontend/verdant-virgo/package.json", "package and build configuration cannot be written"],
      ["pnpm-lock.yaml", "package and build configuration cannot be written"],
      ["backend/x/pnpm-workspace.yaml", "package and build configuration cannot be written"],
      [".npmrc", "package and build configuration cannot be written"],
      [".pnpmfile.cjs", "package and build configuration cannot be written"],
      ["onprem/strapi/Dockerfile", "package and build configuration cannot be written"],
      ["onprem/strapi/Dockerfile.dev", "Dockerfile cannot be written"],
      ["frontend/verdant-virgo/node_modules/astro/index.js", "dependencies cannot be written"],
      ["frontend/verdant-virgo/lighthouserc.cjs", "executable config (*rc.js) cannot be written"],
      [".eslintrc.js", "executable config (*rc.js) cannot be written"],
      ["frontend/verdant-virgo/astro.config.mjs", "executable config (*.config.*) cannot be written"],
      ["backend/x/vitest.config.ts", "executable config (*.config.*) cannot be written"],
      ["middleware/n8n/compose.yml", "compose file cannot be written"],
      ["middleware/umami-master/docker-compose.override.yaml", "compose file cannot be written"],
      ["backend/mautic-system/dev/serve.sh", "scripts cannot be written"],
      [".claude/agents/seo-auditor.md", "this directory is managed by humans and cannot be written by agents"],
      [".claude", "this directory is managed by humans and cannot be written by agents"],
      ["MarketingDepartment/WebsiteOperations/ops/schedules/x.yaml", "this directory is managed by humans and cannot be written by agents"],
      ["MarketingDepartment/WebsiteOperations/cloud/template.yaml", "this directory is managed by humans and cannot be written by agents"],
    ])("入力: %s は書けない", (relative, reason) => {
      expect(checkWriteAccess(join(wt, relative), paths)).toBe(reason);
    });

    it("入力: 相対パスは作業ツリーから解決する", () => {
      expect(checkWriteAccess("package.json", paths)).toBe("package and build configuration cannot be written");
    });

    it("入力: シンボリックリンク経由でも実体のパスで判定する", () => {
      writeAt(wt, "frontend/package.json", "{}");
      symlinkSync(join(wt, "frontend/package.json"), join(wt, "notes.md"));
      expect(checkWriteAccess(join(wt, "notes.md"), paths)).toBe("package and build configuration cannot be written");
    });

    it.each([
      [".github/workflows/ci.yml", "this directory is managed by humans and cannot be written by agents"],
      [".github/dependabot.yml", "this directory is managed by humans and cannot be written by agents"],
      [".husky/pre-commit", "this directory is managed by humans and cannot be written by agents"],
      [".envrc", "package and build configuration cannot be written"],
      ["frontend/verdant-virgo/.envrc", "package and build configuration cannot be written"],
    ])("入力: 後で実行されるファイル %s は書けない", (path, reason) => {
      expect(checkWriteAccess(join(wt, path), paths)).toBe(reason);
    });
  });
});

describe("inspectToolCall", () => {
  describe("正常系", () => {
    it("MCP のツールはパスを見ない（許可リストと上流の ACCESS_LEVEL で守る）", () => {
      expect(inspectToolCall("mcp__strapi-prod__get_article", { path: "/etc/passwd" }, paths)).toBeNull();
    });

    it("Read は package.json を読める", () => {
      expect(inspectToolCall("Read", { file_path: join(wt, "package.json") }, paths)).toBeNull();
    });

    it("Glob の絶対パスの pattern が作業ツリーの中なら許す", () => {
      expect(inspectToolCall("Glob", { pattern: `${wt}/docs/**/*.md` }, paths)).toBeNull();
    });

    it("Grep の正規表現の pattern は検査しない", () => {
      expect(inspectToolCall("Grep", { pattern: "\\.\\./" }, paths)).toBeNull();
    });

    it("空入力: 入力が無くても（undefined・null・{}）落ちずに許す", () => {
      expect(inspectToolCall("Read", undefined, paths)).toBeNull();
      expect(inspectToolCall("Glob", null, paths)).toBeNull();
      expect(inspectToolCall("Write", {}, paths)).toBeNull();
    });

    it("空入力: file_path・pattern が空文字なら検査の対象にしない", () => {
      expect(inspectToolCall("Write", { file_path: "" }, paths)).toBeNull();
      expect(inspectToolCall("Glob", { pattern: "" }, paths)).toBeNull();
    });
  });

  describe("異常系", () => {
    it.each(["Bash", "PowerShell", "BashOutput", "KillShell"])("入力: %s は常に拒否する", (tool) => {
      expect(inspectToolCall(tool, { command: "ls" }, paths)).toBe("shell tools are not available");
    });

    it("空入力: シェル系は入力が無くても拒否する", () => {
      expect(inspectToolCall("Bash", undefined, paths)).toBe("shell tools are not available");
    });

    it("入力: Write・Edit・MultiEdit は package.json を書けない", () => {
      const file = join(wt, "package.json");
      for (const tool of ["Write", "Edit", "MultiEdit"]) {
        expect(inspectToolCall(tool, { file_path: file }, paths)).toBe("package and build configuration cannot be written");
      }
    });

    it("入力: NotebookEdit は notebook_path を見る", () => {
      expect(inspectToolCall("NotebookEdit", { notebook_path: join(wt, "node_modules/x.ipynb") }, paths)).toBe(
        "dependencies cannot be written",
      );
    });

    it("入力: Write でも作業ツリーの外・秘匿ファイルは checkPathAccess の理由で拒否する", () => {
      expect(inspectToolCall("Write", { file_path: join(wt, ".env") }, paths)).toBe("environment files are not accessible");
      expect(inspectToolCall("Write", { file_path: "/tmp/x.md" }, paths)).toBe("file access is limited to the working tree");
    });

    it("入力: Glob・Grep の path も検査する", () => {
      expect(inspectToolCall("Glob", { pattern: "*", path: join(root, "home/.aws") }, paths)).toBe(
        "this location is not accessible",
      );
      expect(inspectToolCall("Grep", { pattern: "x", path: join(wt, "secrets") }, paths)).toBe("secrets/ is not accessible");
    });

    it("入力: Glob の pattern に .. があれば拒否する", () => {
      expect(inspectToolCall("Glob", { pattern: "../**/*.md" }, paths)).toBe("patterns must not contain '..'");
      expect(inspectToolCall("Glob", { pattern: "docs/../../main/**" }, paths)).toBe("patterns must not contain '..'");
    });

    it("入力: Glob の絶対パスの pattern は、ワイルドカードの手前の部分で判定する", () => {
      expect(inspectToolCall("Glob", { pattern: `${root}/main/**/*.md` }, paths)).toBe("this location is not accessible");
      expect(inspectToolCall("Glob", { pattern: "/etc/*.conf" }, paths)).toBe("file access is limited to the working tree");
    });

    it("入力: Grep の glob に .. があれば拒否する", () => {
      expect(inspectToolCall("Grep", { pattern: "x", glob: "../*.ts" }, paths)).toBe("patterns must not contain '..'");
    });
  });
});

describe("createPreToolUseGuard", () => {
  const call = (tool_name: string, tool_input: unknown): HookInput =>
    ({
      hook_event_name: "PreToolUse",
      session_id: "s",
      transcript_path: "/dev/null",
      cwd: wt,
      tool_name,
      tool_input,
      tool_use_id: "t",
    }) as unknown as HookInput;
  const options = () => ({ signal: new AbortController().signal });

  describe("正常系", () => {
    it("許すときは空のオブジェクトを返し、onDeny を呼ばない", async () => {
      const onDeny = vi.fn();
      const guard = createPreToolUseGuard(paths, onDeny);
      const result = await guard(call("Read", { file_path: join(wt, "a.md") }), "t", options());
      expect(result).toEqual({});
      expect(onDeny).not.toHaveBeenCalled();
    });

    it("空入力: tool_input が無い呼び出しは許す", async () => {
      const guard = createPreToolUseGuard(paths);
      expect(await guard(call("Read", undefined), "t", options())).toEqual({});
    });
  });

  describe("異常系", () => {
    it("入力: 拒否するときは PreToolUse の deny を返し、onDeny に理由を渡す", async () => {
      const onDeny = vi.fn();
      const guard = createPreToolUseGuard(paths, onDeny);
      const result = await guard(call("Write", { file_path: join(wt, "package.json") }), "t", options());
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Denied by control-plane guard: package and build configuration cannot be written",
        },
      });
      expect(onDeny).toHaveBeenCalledWith("Write", "package and build configuration cannot be written");
    });

    it("入力: onDeny が無くても拒否は返す（落ちない）", async () => {
      const guard = createPreToolUseGuard(paths);
      const result = await guard(call("Bash", { command: "cat .env" }), "t", options());
      expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    });

    it("入力: 拒否の理由にパスの中身（秘匿ファイルの値）を含めない", async () => {
      writeAt(wt, ".env", "SECRET=very-secret-value");
      const onDeny = vi.fn();
      const result = await createPreToolUseGuard(paths, onDeny)(call("Read", { file_path: join(wt, ".env") }), "t", options());
      expect(JSON.stringify(result)).not.toContain("very-secret-value");
      expect(JSON.stringify(onDeny.mock.calls)).not.toContain("very-secret-value");
    });
  });
});
