// 設定スクリプト（setup/setup.mjs --target dev）が作った値を読む。
// 秘密値は返すだけで、画面・例外の文・スナップショットに出さない（例外の文には「キーの名前」だけを書く）。
//
//   状態ファイル   ~/.config/comegin/setup/dev.state.json（values にトークンや ID）
//   設定ファイル   ~/.config/comegin/setup/dev.conf（MAUTIC_CLIENT_ID などユーザーが書いた値）
//   MCP の env     ~/.config/comegin/mcp/<名前>-dev.env（ops/mcp-registry.yaml が参照するもの）
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".config/comegin");
export const STATE_FILE = join(CONFIG_DIR, "setup/dev.state.json");
export const CONF_FILE = join(CONFIG_DIR, "setup/dev.conf");
export const mcpEnvFile = (name: string): string => join(CONFIG_DIR, "mcp", `${name}-dev.env`);

/** KEY=VALUE の行だけを読む（# のコメントと空行は飛ばす。値を囲む引用符は外す） */
export function parseEnvText(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[line.slice(0, eq).trim()] = value;
  }
  return values;
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

let stateCache: Record<string, string> | undefined;
let confCache: Record<string, string> | undefined;

/** 状態ファイルの values。ファイルが無ければ空 */
export function stateValues(): Record<string, string> {
  if (!stateCache) {
    const text = readOptional(STATE_FILE);
    const parsed = text ? (JSON.parse(text) as { values?: Record<string, unknown> }) : {};
    stateCache = Object.fromEntries(Object.entries(parsed.values ?? {}).map(([k, v]) => [k, String(v)]));
  }
  return stateCache;
}

/** 設定ファイル（dev.conf）の値。ファイルが無ければ空 */
export function confValues(): Record<string, string> {
  if (!confCache) confCache = parseEnvText(readOptional(CONF_FILE) ?? "");
  return confCache;
}

/** MCP の env ファイルの値。ファイルが無ければ空 */
export function mcpEnv(name: string): Record<string, string> {
  return parseEnvText(readOptional(mcpEnvFile(name)) ?? "");
}

/**
 * 状態ファイル → 設定ファイルの順に探し、無ければ例外（値ではなくキーの名前だけを出す）。
 * 結合テストは設定スクリプトが済んでいることが前提なので、無いのは「準備が終わっていない」という失敗にする。
 */
export function requireValue(key: string): string {
  const value = stateValues()[key] || confValues()[key];
  if (!value) throw new Error(`${key} が ${STATE_FILE} にも ${CONF_FILE} にも無い（node setup/setup.mjs --target dev を先に済ませる）`);
  return value;
}

/** 秘密値を例外の文やログに混ぜないための伏せ字 */
export function redact(text: string, secrets: string[]): string {
  return secrets.filter((s) => s.length >= 4).reduce((acc, s) => acc.split(s).join("[redacted]"), text);
}
