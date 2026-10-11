// Agent SDK の PreToolUse フック。
// settingSources: [] にすると ~/.claude のフックも読まれなくなるため、拒否のルールをここで入れ直す（ADR-18）。
// 方針は 2 段:
//   1. ファイルツール（Read / Write / Edit / Glob / Grep ほか）を CONTROL_WORKTREE の realpath の内側に閉じ込める。
//   2. そのうえで、内側にあっても秘匿ファイルと .git を拒否する。
//   3. 書き込み系ツールは、さらに「実行される・実行条件を決める」場所（package.json・*rc.js・*.config.*・dev/*.sh・
//      Dockerfile・compose・node_modules・.claude・ops・cloud など）も拒否する（constants/write-denylist.ts）。
// 限界（README にも書く）: Grep が作業ツリーの中を再帰的に読むとき、秘匿ファイルを避けるのは ripgrep が
// .gitignore を尊重することに頼る。直接のパス指定はここで必ず拒否する。
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { HookCallback, HookJSONOutput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  WRITE_DENY_BASENAMES,
  WRITE_DENY_PATTERNS,
  WRITE_DENY_PREFIXES,
  WRITE_DENY_SCRIPT_DIR,
  WRITE_DENY_SEGMENTS,
  WRITE_TOOLS,
} from "../constants/write-denylist.js";

export interface GuardPaths {
  worktree: string;
  dataDir: string;
  mainCheckout: string;
  /** 実ホーム（~/.aws と ~/.config/comegin を守る） */
  realHome: string;
  /** SDK の子プロセスに渡す HOME。分けていれば null でない */
  agentHome: string | null;
}

const ENV_FILE = /^\.env(\..+)?$/;
const ENV_FILE_TEMPLATE = /\.(example|sample|template)$/;
const SHELL_TOOLS = new Set(["Bash", "PowerShell", "BashOutput", "KillShell"]);

/** 存在しないパス（これから作るファイル）も判定できるよう、存在する最も近い祖先を realpath にして残りをつなぐ。 */
function resolveReal(path: string): string {
  const lexical = resolve(path);
  let existing = lexical;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  let real: string;
  try {
    real = realpathSync(existing);
  } catch {
    real = existing;
  }
  return join(real, ...rest);
}

function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

function protectedByName(path: string): string | null {
  const segments = path.split(sep).filter(Boolean);
  const name = segments.at(-1) ?? "";
  if (ENV_FILE.test(name) && !ENV_FILE_TEMPLATE.test(name)) return "environment files are not accessible";
  if (name === "samconfig.toml") return "samconfig.toml is not accessible";
  if (segments.includes("secrets")) return "secrets/ is not accessible";
  if (segments.includes(".git")) return ".git is not accessible";
  return null;
}

/** 拒否するなら理由（モデルに返す英語の短文）、許すなら null。 */
export function checkPathAccess(rawPath: string, paths: GuardPaths): string | null {
  const base = resolveReal(paths.worktree);
  const absolute = isAbsolute(rawPath) ? rawPath : join(paths.worktree, rawPath);
  const lexicalReason = protectedByName(resolve(absolute));
  if (lexicalReason) return lexicalReason;

  const real = resolveReal(absolute);
  const realReason = protectedByName(real);
  if (realReason) return realReason;

  const forbidden = [
    resolveReal(paths.dataDir),
    resolveReal(paths.mainCheckout),
    resolveReal(join(paths.realHome, ".aws")),
    resolveReal(join(paths.realHome, ".config", "comegin")),
    ...(paths.agentHome ? [resolveReal(paths.agentHome)] : []),
  ];
  if (forbidden.some((dir) => within(dir, real))) return "this location is not accessible";
  if (!within(base, real)) return "file access is limited to the working tree";
  return null;
}

/** パターン（glob）に `..` や絶対パスで作業ツリーの外を指す書き方が無いか。 */
function checkPattern(pattern: string, paths: GuardPaths): string | null {
  if (pattern.split(/[\\/]/).includes("..")) return "patterns must not contain '..'";
  if (isAbsolute(pattern)) {
    const staticPrefix = pattern.split(/[*?[{]/)[0] ?? "";
    return checkPathAccess(staticPrefix.endsWith(sep) ? staticPrefix : dirname(staticPrefix), paths);
  }
  return null;
}

/** 書き込み系ツールだけの追加の拒否。理由（モデルに返す英語の短文）か null。 */
export function checkWriteAccess(rawPath: string, paths: GuardPaths): string | null {
  const base = resolveReal(paths.worktree);
  const real = resolveReal(isAbsolute(rawPath) ? rawPath : join(paths.worktree, rawPath));
  if (!within(base, real)) return null; // 外は checkPathAccess が拒否する
  const relative = real.slice(base.length + 1);
  const segments = relative.split(sep).filter(Boolean);
  const name = segments.at(-1) ?? "";
  if (WRITE_DENY_PREFIXES.some((prefix) => relative === prefix || relative.startsWith(`${prefix}${sep}`))) {
    return "this directory is managed by humans and cannot be written by agents";
  }
  if (segments.some((segment) => WRITE_DENY_SEGMENTS.includes(segment))) return "dependencies cannot be written";
  if (WRITE_DENY_BASENAMES.has(name)) return "package and build configuration cannot be written";
  const matched = WRITE_DENY_PATTERNS.find(({ pattern }) => pattern.test(name));
  if (matched) return `${matched.reason} cannot be written`;
  if (name.endsWith(".sh") && segments.slice(0, -1).includes(WRITE_DENY_SCRIPT_DIR)) return "scripts cannot be written";
  return null;
}

const PATH_KEYS = ["file_path", "notebook_path", "path"] as const;

export function inspectToolCall(toolName: string, toolInput: unknown, paths: GuardPaths): string | null {
  if (SHELL_TOOLS.has(toolName)) return "shell tools are not available";
  if (toolName.startsWith("mcp__")) return null; // MCP は許可リストと上流側の ACCESS_LEVEL で守る
  const input = (toolInput ?? {}) as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value) {
      const reason = checkPathAccess(value, paths) ?? (WRITE_TOOLS.has(toolName) ? checkWriteAccess(value, paths) : null);
      if (reason) return reason;
    }
  }
  const pattern = toolName === "Glob" ? input.pattern : toolName === "Grep" ? input.glob : undefined;
  if (typeof pattern === "string" && pattern) return checkPattern(pattern, paths);
  return null;
}

export function createPreToolUseGuard(paths: GuardPaths, onDeny?: (toolName: string, reason: string) => void): HookCallback {
  return async (input): Promise<HookJSONOutput> => {
    const call = input as PreToolUseHookInput;
    const reason = inspectToolCall(call.tool_name, call.tool_input, paths);
    if (reason === null) return {};
    onDeny?.(call.tool_name, reason);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Denied by control-plane guard: ${reason}`,
      },
    };
  };
}
