// setup の共通部品。各モジュールの setup/index.mjs は、ここの ctx（コンテキスト）だけを使って書く。
//
// モジュールの形（契約）:
//   export const meta = { id, title, targets: ["dev"] | ["dev", "prod"], after: ["<id>", ...] };
//   export async function check(ctx)  // 読むだけ。用意できているかを確かめる。{ ok: boolean, notes: string[] } を返す
//   export async function apply(ctx)  // 何度実行しても同じ結果になる。終わったら何も返さない
//
// 秘密値の扱い:
//   - 秘密値は ctx.state.set(key, value, { secret: true }) で状態ファイルに置く。ctx.log などの出力からは自動で伏せる
//   - 状態ファイル: ~/.config/comegin/setup/<target>.state.json（600）。ユーザーが `--show <key>` で 1 つだけ表示できる
//   - 子プロセス（ctx.run）の出力も、登録済みの秘密値を伏せてから表示する

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const W = resolve(dirname(fileURLToPath(import.meta.url)), "../.."); // MarketingDepartment/WebsiteOperations
export const REPO = resolve(W, "../..");
export const CONFIG_DIR = join(homedir(), ".config/comegin");
const TIMEOUT_MS = 20_000;

/** 画面の操作を人に頼んで止まるときに投げる。setup.mjs が受けて、案内を表示して終わる */
export class ManualStepRequired extends Error {
  constructor(id, title, steps) {
    super(title);
    this.id = id;
    this.steps = steps;
  }
}

// ---------------------------------------------------------------------------
// 出力（秘密値を伏せる）
// ---------------------------------------------------------------------------

const secretValues = new Set();
export function registerSecret(value) {
  if (typeof value === "string" && value.length >= 6) secretValues.add(value);
}
export function mask(text) {
  let out = String(text);
  // 長い値から伏せる（短い値が長い値の一部だと、短いほうを先に伏せたときに長いほうの残りの文字が出てしまうため）
  for (const s of [...secretValues].sort((a, b) => b.length - a.length)) out = out.split(s).join("[伏せ字]");
  return out;
}

// ---------------------------------------------------------------------------
// 設定（ユーザーが書く）と状態（スクリプトが書く）
// ---------------------------------------------------------------------------

export function parseKeyValue(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

function ensurePrivateDir(dir) {
  // 700 にするのは ~/.config/comegin の中だけ。リポジトリの中のディレクトリ（例: middleware/open-seo-main）は権限を変えない
  // （環境変数ファイル自体は 600 で書くので、ほかのユーザーには読めない）
  if (!(dir === CONFIG_DIR || dir.startsWith(`${CONFIG_DIR}/`))) {
    mkdirSync(dir, { recursive: true });
    return;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* 所有者でない場合は触らない */
  }
}

export function loadConfig(target, path) {
  const file = path ?? join(CONFIG_DIR, "setup", `${target}.conf`);
  if (!existsSync(file)) {
    // 明示した場所に無いのは打ち間違いなので止める（空の設定のまま apply に進ませない）。既定の場所に無いのは初回として空の設定で進む
    if (path !== undefined && path !== null) throw new Error(`--config の ${file} が無い（setup.conf.example を写して作る）`);
    return { file, conf: {} };
  }
  if ((statSync(file).mode & 0o077) !== 0) console.error(`  ! ${file} はほかのユーザーも読める。chmod 600 を推奨`);
  const conf = parseKeyValue(readFileSync(file, "utf8"));
  for (const [k, v] of Object.entries(conf)) if (/SECRET|PASSWORD|TOKEN|KEY/i.test(k)) registerSecret(v);
  return { file, conf };
}

export class State {
  constructor(target) {
    ensurePrivateDir(join(CONFIG_DIR, "setup"));
    this.file = join(CONFIG_DIR, "setup", `${target}.state.json`);
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { values: {}, secrets: [] };
    for (const k of this.data.secrets) registerSecret(this.data.values[k]);
  }
  get(key) {
    return this.data.values[key];
  }
  has(key) {
    return this.data.values[key] !== undefined && this.data.values[key] !== "";
  }
  set(key, value, { secret = false } = {}) {
    this.data.values[key] = value;
    if (secret) {
      registerSecret(value);
      if (!this.data.secrets.includes(key)) this.data.secrets.push(key);
    }
    this.save();
  }
  isSecret(key) {
    return this.data.secrets.includes(key);
  }
  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }
}

// ---------------------------------------------------------------------------
// 環境変数ファイル（.env 形式）の読み書き。コメントと順番を保ったまま、指定したキーだけを書き換える
// ---------------------------------------------------------------------------

export function readEnvFile(path) {
  return existsSync(path) ? parseKeyValue(readFileSync(path, "utf8")) : {};
}

/**
 * 環境変数ファイルにキーを書く。onlyIfEmpty が true（既定）なら、既に値があるキーは変えない（暗号化の鍵などを守るため）。
 * ファイルが無ければ template（.env.example など）を写してから書く。権限は 600。
 */
export function writeEnvFile(path, values, { template, onlyIfEmpty = true } = {}) {
  ensurePrivateDir(dirname(path));
  let text = existsSync(path) ? readFileSync(path, "utf8") : template && existsSync(template) ? readFileSync(template, "utf8") : "";
  const lines = text.split(/\r?\n/);
  const changed = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    const idx = lines.findIndex((l) => new RegExp(`^\\s*#?\\s*${key}\\s*=`).test(l));
    const current = idx >= 0 && !/^\s*#/.test(lines[idx]) ? parseKeyValue(lines[idx])[key] : undefined;
    if (onlyIfEmpty && current) continue;
    if (current === String(value)) continue; // 同じ値なら書かない（「書き換えた」と数えない）
    const line = `${key}=${value}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
    changed.push(key);
  }
  if (changed.length || !existsSync(path)) {
    writeFileSync(path, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return changed;
}

export function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

// ---------------------------------------------------------------------------
// HTTP と子プロセス
// ---------------------------------------------------------------------------

export async function http(label, url, { method = "GET", headers = {}, json, form, timeoutMs = TIMEOUT_MS, raw = false } = {}) {
  const init = { method, headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" };
  if (json !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(json);
  } else if (form) {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(form).toString();
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    const err = new Error(`${label}: ${new URL(url).origin} に接続できない（${e.name === "TimeoutError" ? "タイムアウト" : e.cause?.code ?? e.message}）`);
    err.status = 0;
    throw err;
  }
  if (raw) return res;
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const detail = body?.message ?? body?.error?.message ?? body?.errors?.[0]?.message ?? (typeof body?.error === "string" ? body.error : "");
    const err = new Error(mask(`${label}: HTTP ${res.status}${detail ? `（${String(detail).slice(0, 300)}）` : ""}`));
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/** 子プロセスを動かす。出力は表示せずに貯め、失敗したら最後の 20 行を伏せ字にして例外に入れる */
export function run(cmd, args, { cwd = W, env = {}, input, timeoutMs = 15 * 60_000, inheritEnv = true } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, env: inheritEnv ? { ...process.env, ...env } : env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} を起動できない（${e.code ?? e.message}）`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolvePromise(out);
      const tail = mask(out.trim().split("\n").slice(-20).join("\n"));
      reject(new Error(`${cmd} ${args.join(" ")} が失敗した（終了コード ${code}）\n${tail}`));
    });
  });
}

export async function commandExists(cmd) {
  try {
    await run("sh", ["-c", `command -v ${cmd}`]);
    return true;
  } catch {
    return false;
  }
}

/** HTTP の URL が応答するまで待つ（status < 500 で応答あり） */
export async function waitForHttp(url, { timeoutMs = 180_000, intervalMs = 3_000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: "manual" });
      if (res.status < 500) return true;
    } catch {
      /* まだ起動中 */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ---------------------------------------------------------------------------
// ctx（モジュールに渡すもの）
// ---------------------------------------------------------------------------

export function createContext({ target, conf, state, moduleId }) {
  const prefix = `  [${moduleId}]`;
  return {
    target,
    conf, // ユーザーの設定（~/.config/comegin/setup/<target>.conf）
    state, // スクリプトが作った値（State）
    W,
    REPO,
    CONFIG_DIR,
    log: (msg) => console.log(mask(`${prefix} ${msg}`)),
    warn: (msg) => console.error(mask(`${prefix} ! ${msg}`)),
    http,
    run,
    commandExists,
    waitForHttp,
    readEnvFile,
    writeEnvFile,
    randomSecret,
    /** 設定か状態から値を取る。どちらにも無ければ undefined */
    value: (key) => conf[key] || state.get(key),
    /** 必須の値。無ければ、どの設定に書けばよいかを添えて止める */
    require: (key, hint) => {
      const v = conf[key] || state.get(key);
      if (!v) throw new Error(`${key} が無い。${hint ?? `~/.config/comegin/setup/${target}.conf に書く`}`);
      return v;
    },
    /** 画面の操作を人に頼んで止まる。steps は手順の文字列の配列 */
    manual: (id, title, steps) => {
      throw new ManualStepRequired(`${moduleId}:${id}`, title, steps);
    },
  };
}
