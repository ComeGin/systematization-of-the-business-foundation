// setup の共通部品。各モジュールの setup/index.mjs は、ここの ctx（コンテキスト）だけを使って書く。
//
// モジュールの形（契約）:
//   export const meta = { id, title, targets: ["dev"] | ["dev", "prod"], phases: ["<段階>", ...], after: ["<id>", ...] };
//     phases は prod で動くモジュールだけが持つ（本番の段階。setup/lib/runner.mjs の PROD_PHASES。2 つ以上なら段階ごとに 1 回ずつ呼ばれる）
//   export async function check(ctx)  // 読むだけ。用意できているかを確かめる。{ ok: boolean, notes: string[], items?: StatusItem[] } を返す
//     items は任意（監視アプリの「設定の状況」が読む。親スクリプトの --json で { moduleId, phase, ok, notes, items, error, skipped } に載る）。
//     返さなければ [] として扱い、ok と notes だけから手順に当てはめる。StatusItem の形:
//       { key: "cloud.sns-subscription", step: "P2", level: "ok"|"action"|"warn"|"manual"|"unknown", title, evidence, stopId? }
//       key はカタログの probe が参照する名前、step は手順の番号（P1〜P15・R1 など）、title と evidence に秘密値を入れない（出す前に mask を通す）
//     確かめられなかった（AWS・製品の API に問い合わせられない）ときは、ok:false にせず例外を投げる。ok:false は監視アプリで
//     ●（更新が必要）とメールになり、例外は ?（確かめられない。1 時間続いたらメール）になる。ほかに欠けがあるときだけ ok:false にし、
//     確かめられなかったことは notes に足す（AWS は cloud/setup/aws.mjs の AwsUnavailable と settleAwsUnavailable。2026-11-04）
//   export async function apply(ctx)  // 何度実行しても同じ結果になる。終わったら何も返さない
//
// ctx.phase: 今の本番の段階の id（dev では null）。phases を 2 つ以上持つモジュールは、これで中身を切り替える
// ctx.siteRouted: 公開サイト（Astro）が本番のドメインで Route 53 から配信されているか。段階 google・operate のときだけ true
//   （google は配信の後に --phase google で明示したときだけ動く）。公開サイトに届かないと進められない手順（公開サイトの測定 ID と
//   Search Console の所有権）は、これが false なら飛ばす（dev は公開サイトが AWS に無いので常に false）
//
// ctx.WORKTREE: 追跡しないファイル（cloud の samconfig など）と突き合わせの基点になる作業ツリー。環境変数 SETUP_WORKTREE
//   （絶対パス）があればそれ、無ければ REPO。コードを承認済みの main のチェックアウトから動かすとき（監視アプリが子プロセスで --check する）は、
//   REPO がチェックアウトを指し、WORKTREE が人の作業ツリーを指す
// ctx.checkOnly: --check のとき true。このとき ctx.state.set は「check の中で状態を書こうとした: <key>」を投げる
//   （check は読むだけ。確かめた結果を残したいときは、状態ではなく check の戻り値の items に載せる。ctx.writeEnvFile も同じく
//   「check の中で環境変数ファイルを書こうとした: <パス>」を投げる）
//
// 秘密値の扱い:
//   - 秘密値は ctx.state.set(key, value, { secret: true }) で状態ファイルに置く。ctx.log などの出力からは自動で伏せる
//   - 状態ファイル: ~/.config/comegin/setup/<target>.state.json（600）。ユーザーが `--show <key>` で 1 つだけ表示できる
//   - 子プロセス（ctx.run）の出力も、登録済みの秘密値を伏せてから表示する

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// W はモジュールのパスの基点、REPO はリポジトリのルート。2026-10-11 に MarketingDepartment/WebsiteOperations の下から
// リポジトリ直下へ移したため、今は同じ場所を指す（モジュールが ctx.W・ctx.REPO の両方を使うので両方残す）
export const W = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const REPO = W;
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
  /** readOnly が true なら set は何も書かずに例外を投げる（--check のとき。check が状態ファイルを書き換えないため） */
  constructor(target, { readOnly = false } = {}) {
    this.readOnly = readOnly;
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
    if (this.readOnly) throw new Error(`check の中で状態を書こうとした: ${key}`);
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

/** 作業ツリー（ctx.WORKTREE）。SETUP_WORKTREE（絶対パス）があればそれ、無ければ REPO。相対パスは取り違えやすいので止める */
export function resolveWorktree(env = process.env) {
  const v = env.SETUP_WORKTREE;
  if (v === undefined || v === "") return REPO;
  if (!isAbsolute(v)) throw new Error("SETUP_WORKTREE は絶対パスで指定する");
  return resolve(v);
}

/** --check の ctx.writeEnvFile。check は読むだけの契約なので、呼ばれたら書かずに止める（値は出さず、パスだけ） */
function writeEnvFileInCheck(path) {
  throw new Error(`check の中で環境変数ファイルを書こうとした: ${relative(REPO, path)}`);
}

export function createContext({ target, conf, state, moduleId, phase = null, siteRouted = phase === "google" || phase === "operate", checkOnly = false }) {
  const prefix = `  [${moduleId}]`;
  return {
    target,
    phase, // 本番の段階（冒頭の説明）
    siteRouted, // 公開サイトが Route 53 から配信されているか（冒頭の説明）
    checkOnly, // --check のとき true（冒頭の説明）
    conf, // ユーザーの設定（~/.config/comegin/setup/<target>.conf）
    state, // スクリプトが作った値（State）
    W,
    REPO,
    WORKTREE: resolveWorktree(), // 追跡しないファイルと突き合わせの基点（冒頭の説明）
    CONFIG_DIR,
    log: (msg) => console.log(mask(`${prefix} ${msg}`)),
    warn: (msg) => console.error(mask(`${prefix} ! ${msg}`)),
    http,
    run,
    commandExists,
    waitForHttp,
    readEnvFile,
    writeEnvFile: checkOnly ? writeEnvFileInCheck : writeEnvFile, // --check では書かずに例外にする
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
