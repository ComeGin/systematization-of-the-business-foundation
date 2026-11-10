// Agent SDK の PreToolUse フック。
// settingSources: [] にすると ~/.claude のフックも読まれなくなるため、拒否のルールをここで入れ直す（ADR-18）。
// 方針は 2 段:
//   1. ファイルツール（Read / Write / Edit / Glob / Grep ほか）を CONTROL_WORKTREE の realpath の内側に閉じ込める。
//   2. そのうえで、内側にあっても秘匿ファイルと .git を拒否する。
//   3. 書き込み系ツールは、さらに「実行される・実行条件を決める」場所（package.json・*rc.js・*.config.*・dev/*.sh・
//      Dockerfile・compose・node_modules・.claude・ops・cloud など）も拒否する（constants/write-denylist.ts）。
//   4. エージェント固有の守り（inspectAgentSpecific。改善の周の campaign-planner・design-implementer）。
//      定義の tools の許可リストに加えた 2 重目で、公開・送信の手段を入力の中身まで見て塞ぐ。
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
  /** 実行中のエージェント定義の name。エージェント固有の守り（inspectAgentSpecific）に使う。エージェント以外の呼び出しは null */
  agentName: string | null;
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

// --- エージェント固有の守り（改善の周。spec 5.8・5.11 の 3） ---

/** campaign-planner が作ってよい Mautic のリソース（作成だけ。セグメントは作らない＝既存のものを指すだけ） */
const CAMPAIGN_PLANNER_MAUTIC_RESOURCES: ReadonlySet<string> = new Set(["emails", "campaigns"]);
/**
 * campaign-planner が組んでよいキャンペーンのイベントの型。
 * Mautic に「待つ」という独立したイベントの型は無い（待ちは各イベントの triggerMode: immediate / interval / date と
 * triggerInterval 等の欄で表す。backend/mautic-system の CampaignBundle・EmailBundle で確認）。
 * 「公開後すぐに送る」は triggerMode: immediate の `email.send` だけで足りるため、許す型はこれ 1 つだけにする。
 */
export const CAMPAIGN_EVENT_TYPES_ALLOWED: ReadonlySet<string> = new Set(["email.send"]);
/** Mautic の作成・更新・削除のツール（mautic / mautic-prod など、サーバー名によらず） */
const MAUTIC_RECORD_WRITE_TOOL = /^mcp__mautic(?:-[a-z0-9-]+)?__mautic_(create|update|delete)_record$/;
/** Strapi の公開・非公開化・削除・下書きの破棄（定義に無くても念のため） */
const STRAPI_HUMAN_ONLY_TOOL = /^mcp__strapi(?:-[a-z0-9-]+)?__(publish|unpublish|delete|discard)_/;

/** campaign-planner の書き込み先（作業ツリーの直下からの相対）。配布ファイルの原稿だけ */
export const CAMPAIGN_PLANNER_WRITE_ROOT = "campaign-assets";
/** design-implementer の書き込み先 */
export const DESIGN_IMPLEMENTER_WRITE_ROOT = "frontend/verdant-virgo/src";

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

/** 書き込み系のファイルツールが、作業ツリーの直下からの `root` の下だけを指すか。理由か null。 */
function checkWriteRoot(toolName: string, toolInput: unknown, root: string, paths: GuardPaths): string | null {
  if (!WRITE_TOOLS.has(toolName)) return null;
  const input = (toolInput ?? {}) as Record<string, unknown>;
  const allowed = resolveReal(join(paths.worktree, root));
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value !== "string" || !value) continue;
    const real = resolveReal(isAbsolute(value) ? value : join(paths.worktree, value));
    if (!within(allowed, real)) return `file writes are limited to ${root}/`;
  }
  return null;
}

/** mautic_create_record の data は、オブジェクトでも JSON 文字列でも渡りうる。どちらも見る。 */
function parseCreateData(data: unknown): Record<string, unknown> | null {
  let value = data;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** isPublished は「明示的な false」だけを許す（Mautic の既定が公開の場合に、省略で公開されるのを防ぐ）。 */
function isExplicitlyUnpublished(value: unknown): boolean {
  return value === false || value === 0 || value === "false" || value === "0";
}

/** キャンペーンのイベント（子の events を持つ入力も含めて）の型がすべて許可リストの中か。 */
function checkCampaignEvents(events: unknown): string | null {
  if (events === undefined) return null;
  if (!Array.isArray(events)) return "campaign events must be an array";
  for (const event of events) {
    if (event === null || typeof event !== "object") return "campaign events must be objects";
    const record = event as Record<string, unknown>;
    if (typeof record.type !== "string" || !CAMPAIGN_EVENT_TYPES_ALLOWED.has(record.type)) {
      return `campaign event types are limited to: ${[...CAMPAIGN_EVENT_TYPES_ALLOWED].join(", ")}`;
    }
    const nested = checkCampaignEvents(record.children);
    if (nested) return nested;
  }
  return null;
}

/**
 * メールはキャンペーンから送るテンプレートのメール（emailType が template）で、送信先のセグメント（lists）を持たないものだけ（I5）。
 * emailType が list のメールは、公開するとセグメントへ一斉に送れる（キャンペーンの承認を経ない送信の経路になる）。
 * lists は省略か空の配列だけを許す
 */
function checkTemplateEmail(data: Record<string, unknown>): string | null {
  if (data.emailType !== "template") return "Mautic emails must be created with emailType template";
  if (data.lists !== undefined && !(Array.isArray(data.lists) && data.lists.length === 0)) return "Mautic emails must not have lists";
  return null;
}

/** Strapi の記事の作成が公開を含んでいないか。publishedAt（null 以外）・status が published は、入力の最上位と data の中の両方を見る。 */
function checkStrapiDraftOnly(toolInput: unknown): string | null {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  const candidates = [input, parseCreateData(input.data) ?? {}];
  for (const candidate of candidates) {
    if (candidate.publishedAt !== undefined && candidate.publishedAt !== null) return "Strapi articles must be created as drafts (publishedAt)";
    if (typeof candidate.status === "string" && candidate.status.toLowerCase() === "published") {
      return "Strapi articles must be created as drafts (status)";
    }
  }
  return null;
}

function inspectCampaignPlanner(toolName: string, toolInput: unknown, paths: GuardPaths): string | null {
  if (STRAPI_HUMAN_ONLY_TOOL.test(toolName)) return "publishing or deleting Strapi content is not allowed";
  if (/^mcp__strapi(?:-[a-z0-9-]+)?__create_article$/.test(toolName)) return checkStrapiDraftOnly(toolInput);
  if (MAUTIC_RECORD_WRITE_TOOL.test(toolName)) {
    if (!toolName.endsWith("_create_record")) return "only creating Mautic records is allowed";
    const input = (toolInput ?? {}) as Record<string, unknown>;
    const resource = input.resource;
    if (typeof resource !== "string" || !CAMPAIGN_PLANNER_MAUTIC_RESOURCES.has(resource)) {
      return "only emails and campaigns can be created in Mautic";
    }
    const data = parseCreateData(input.data);
    if (!data) return "data must be a JSON object";
    if (!isExplicitlyUnpublished(data.isPublished)) return "Mautic records must be created with isPublished false";
    if (resource === "campaigns") return checkCampaignEvents(data.events);
    return checkTemplateEmail(data);
  }
  return checkWriteRoot(toolName, toolInput, CAMPAIGN_PLANNER_WRITE_ROOT, paths);
}

/**
 * エージェント固有の追加の拒否。理由（モデルに返す英語の短文）か null。inspectToolCall が通ったあとに呼ぶ。
 * - campaign-planner: Mautic は emails・campaigns の未公開の作成だけ（emails は emailType が template で lists が無いもの、
 *   campaigns のイベントは CAMPAIGN_EVENT_TYPES_ALLOWED だけ）、
 *   更新・削除は不可。ファイルの書き込みは campaign-assets/ の下だけ。Strapi の公開・削除系は不可。
 * - design-implementer: ファイルの書き込みは frontend/verdant-virgo/src/ の下だけ。
 * - それ以外のエージェントは従来どおり（null）。
 */
export function inspectAgentSpecific(agentName: string | null, toolName: string, toolInput: unknown, paths: GuardPaths): string | null {
  if (agentName === "campaign-planner") return inspectCampaignPlanner(toolName, toolInput, paths);
  if (agentName === "design-implementer") return checkWriteRoot(toolName, toolInput, DESIGN_IMPLEMENTER_WRITE_ROOT, paths);
  return null;
}

export function createPreToolUseGuard(paths: GuardPaths, onDeny?: (toolName: string, reason: string) => void): HookCallback {
  return async (input): Promise<HookJSONOutput> => {
    const call = input as PreToolUseHookInput;
    const reason =
      inspectToolCall(call.tool_name, call.tool_input, paths) ??
      inspectAgentSpecific(paths.agentName, call.tool_name, call.tool_input, paths);
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
