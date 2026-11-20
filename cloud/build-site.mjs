#!/usr/bin/env node
// 公開サイト（Astro）を本番用にビルドする包み。cloud/README.md の 4.14 の「ビルドの前提」と、setup/00-setup-overview.md の P12 の
// ビルドの行を、人が端末で 1 本で行うためのもの。配信（同期と無効化）は行わない。続けて `node cloud/deploy-site.mjs --dist <このスクリプトが出す絶対パス>` で配る
// （最後に yes で、そのまま deploy-site.mjs を起動することもできる）。Claude Code の実行環境では実行しない（ADR-15）。
//
// 使い方（リポジトリのどこからでもよい）:
//   node cloud/build-site.mjs           確かめてから、承認済みの main のチェックアウトでビルドする（途中で yes の入力を待つ）
//   node cloud/build-site.mjs --check   確かめるだけ（チェックアウトは git fetch だけ。ビルドもチェックアウトの書き換えもしない）
//   オプション: --config <prod.conf のパス>（既定 ~/.config/comegin/setup/prod.conf）
//
// 手順（この順）:
//   1. prod.conf を読む（deploy-site.mjs と同じ値。SITE_BUILD_CHECKOUT〈空なら CONTROL_MAIN_CHECKOUT〉・PUBLIC_SITE_URL・CALCOM_LINK・
//      GA4_MEASUREMENT_ID・CONTROL_DATA_DIR）。秘密値は読んでも使わず、画面に出さない
//   2. 前提を確かめる
//      - チェックアウトが作業ツリー（このスクリプトのあるリポジトリ）ではない。作業ツリーでビルドすると開発の .env の値で焼かれる（2026-11-02 に起きた）
//      - チェックアウトの frontend/verdant-virgo に .env.production がある（node setup/frontend.mjs --target prod が書く。中身は読まない）
//      - 監視アプリの夜のジョブ（JST 0〜8 時。published-article-check・weekly-lighthouse・weekly-a11y）が同じチェックアウトで
//        ビルドしていない。動いていれば止める。0〜8 時の間は、動いていなくても yes を待つ（途中で始まると dist/ を作り直される）
//   3. git fetch して、HEAD が origin/main と違えば、未コミットの変更が無いことを確かめてから yes で checkout --detach origin/main
//   4. yes → pnpm install --frozen-lockfile → pnpm build。夜のビルドと同じく BUILD_COMMIT_SHA（HEAD）を渡す（dist/_build.json が入る）。
//      環境変数は許可リストだけを渡す（端末に開発の SITE_URL などが export されていても、.env.production より優先させない）
//   5. できた dist を deploy-site.mjs と同じ検査にかける（4.14 の手順 2-0〜2-5）。_build.json の commit が HEAD と同じことも確かめる
//   6. dist を <CONTROL_DATA_DIR>/deploy-manual/<コミット 12 桁>-<UTC の日時>/dist に写す（配るまでの間に夜のジョブが
//      チェックアウトの dist/ を作り直しても、配る中身が変わらないように。published-article-check の写しと同じ理由）。手の写しは新しい 3 つだけ残す
//   7. 配信のコマンドを出し、yes なら deploy-site.mjs をそのまま起動する
//
// 入力待ち（yes 以外なら何もせずに終了コード 3 で終わる。端末につながっていないときも 3）:
//   0〜8 時の実行・チェックアウトを合わせる・ビルドする・続けて配信する
// 終了コード: 0 済み / 1 確かめで止めた・失敗 / 3 yes が入力されなかった（続けて配信するかは、no でも 0）
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { askOnTerminal, loadConfig, REPO } from "../setup/lib/core.mjs";
import { distMarks, inspectDistContent, inspectFreshness, siteSettings } from "./deploy-site.mjs";
import { isDirectRun, realRun } from "./lib/exec.mjs";

const SITE_DIR = "frontend/verdant-virgo";
/** 手でビルドした dist の写しの置き場（<CONTROL_DATA_DIR>/deploy-manual/<名前>/dist）。監視アプリの写し（deploy/）とは分ける */
const MANUAL_COPIES_DIR = "deploy-manual";
const MANUAL_COPY_NAME = /^[0-9a-f]{12}-\d{8}T\d{6}Z$/;
const KEEP_MANUAL_COPIES = 3;
/** 監視アプリの夜のジョブの時間帯（JST の時。ops/README の 0〜8 時） */
const NIGHT_START_HOUR = 0;
const NIGHT_END_HOUR = 8;
/** ビルドに渡す環境変数の許可リスト（ほかは渡さない。値は .env.production から Astro・Vite が読む） */
const PASS_ENV = [
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TMPDIR",
  "PNPM_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS",
];
const SHA = /^[0-9a-f]{40}$/;

/** yes 以外で終わる（終了コード 3） */
class Declined extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 3;
  }
}

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = { check: false, config: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") opts.check = true;
    else if (a === "--config") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error("--config の値が無い");
      opts.config = v;
    } else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`知らない引数: ${a}（node cloud/build-site.mjs --help）`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// 前提の確かめ
// ---------------------------------------------------------------------------

/** a が b と同じか、b の下にあるか */
function isInside(a, b) {
  const rel = relative(b, a);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..");
}

/** JST の時（0〜23） */
export function jstHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hourCycle: "h23" }).format(now));
}

export function inNightWindow(now = new Date()) {
  const h = jstHour(now);
  return h >= NIGHT_START_HOUR && h < NIGHT_END_HOUR;
}

/**
 * チェックアウトの下で動いている astro・lhci のプロセス（監視アプリの夜のジョブや、別の端末のビルド）。/proc が無い環境では空。
 * 自分のプロセスと、cwd を読めないプロセス（ほかのユーザー）は見ない
 */
export function buildsRunningIn(checkout) {
  if (!existsSync("/proc")) return [];
  const found = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const cwd = readlinkSync(`/proc/${name}/cwd`);
      if (!isInside(cwd, checkout)) continue;
      const cmd = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").join(" ").trim();
      if (/\bastro\b.*\b(build|preview|check)\b|\blhci\b|playwright/.test(cmd)) found.push(`${name}: ${cmd.slice(0, 120)}`);
    } catch {
      /* 終わった・読めないプロセスは飛ばす */
    }
  }
  return found;
}

async function gitOut(run, checkout, args) {
  return (await run("git", ["-C", checkout, ...args])).trim();
}

// ---------------------------------------------------------------------------
// ビルドと写し
// ---------------------------------------------------------------------------

/** 許可リストの環境変数だけで、端末を引き継いでコマンドを動かす */
function runClean(cmd, args, { cwd, env }) {
  const childEnv = {};
  for (const k of PASS_ENV) if (process.env[k] !== undefined) childEnv[k] = process.env[k];
  Object.assign(childEnv, env);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", env: childEnv });
    child.on("error", (e) => reject(new Error(`${cmd} を起動できない（${e.code ?? e.message}）`)));
    child.on("close", (code, signal) => {
      if (code === 0) return resolvePromise();
      reject(new Error(`${cmd} ${args[0]} が失敗した（${signal ? `シグナル ${signal}` : `終了コード ${code}`}）`));
    });
  });
}

/** UTC の日時を 20261121T013400Z の形にする */
export function stamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** dist を手の写しの置き場に写し、写した先の絶対パスを返す。古い手の写しは新しい KEEP_MANUAL_COPIES 個だけ残す */
export function copyForDelivery(dist, dataDir, head, now = new Date()) {
  const root = join(dataDir, MANUAL_COPIES_DIR);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const copyDir = join(root, `${head.slice(0, 12)}-${stamp(now)}`);
  mkdirSync(copyDir, { mode: 0o700 });
  const target = join(copyDir, "dist");
  cpSync(dist, target, { recursive: true, dereference: false, errorOnExist: true, force: false });
  const old = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && MANUAL_COPY_NAME.test(e.name))
    .map((e) => join(root, e.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(KEEP_MANUAL_COPIES);
  for (const dir of old) rmSync(dir, { recursive: true, force: true });
  return target;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/**
 * deps: { run（cloud/lib/exec.mjs の realRun の形。git に使う）, build（(cmd, args, { cwd, env }) => Promise。pnpm に使う）,
 *         ask, log, loadConf, now, running（チェックアウト → 動いているビルドの一覧）, copy, deploy（dist → Promise。deploy-site.mjs を起動する） }
 */
export async function runSiteBuild(opts, deps) {
  const { run, build, ask, log = console.log, loadConf, now = () => new Date(), running = buildsRunningIn, copy = copyForDelivery, deploy } = deps;
  const confirmYes = async (question) => {
    const answer = await ask(`${question}（yes で進む）: `);
    if (answer === null) throw new Declined("端末につながっていないため、yes を聞けない。端末から実行する");
    return answer === "yes";
  };
  const requireYes = async (question, declined) => {
    if (!(await confirmYes(question))) throw new Declined(declined);
  };

  // 1. 設定
  const { file: confFile, conf } = loadConf(opts.config);
  const settings = siteSettings(conf);
  const siteDir = join(settings.checkout, SITE_DIR);
  log(`設定: ${confFile}（公開サイト ${settings.origin}・チェックアウト ${settings.checkout}）`);

  // 2. 前提
  log("\n前提を確かめる");
  if (isInside(settings.checkout, REPO) || isInside(REPO, settings.checkout)) {
    throw new Error(`チェックアウト（${settings.checkout}）が作業ツリー（${REPO}）と重なる。承認済みの main の別のチェックアウトを SITE_BUILD_CHECKOUT に書く（cloud/README.md の 4.14）`);
  }
  if (!existsSync(join(settings.checkout, ".git"))) throw new Error(`${settings.checkout} は git のチェックアウトではない`);
  if (!existsSync(join(siteDir, ".env.production"))) {
    throw new Error(`${siteDir} に .env.production が無い。node setup/frontend.mjs --target prod --only verdant-virgo で書いてから実行する（setup/00-setup-overview.md の P11）`);
  }
  log("  ✓ 作業ツリーではない main のチェックアウトで、.env.production がある");
  const busy = running(settings.checkout);
  if (busy.length) {
    throw new Error(`チェックアウトで別のビルド・計測が動いている（監視アプリの夜のジョブか、別の端末）。終わってから実行する:\n  ${busy.join("\n  ")}`);
  }
  log("  ✓ チェックアウトで動いているビルド・計測は無い");
  const night = inNightWindow(now());
  if (night) log(`  ! いまは JST ${NIGHT_START_HOUR}〜${NIGHT_END_HOUR} 時（監視アプリの夜のジョブが同じチェックアウトでビルドする時間帯）`);

  // 3. チェックアウトを origin/main に合わせる
  await run("git", ["-C", settings.checkout, "fetch", "-q", "origin", "main"]);
  let head = await gitOut(run, settings.checkout, ["rev-parse", "HEAD"]);
  const main = await gitOut(run, settings.checkout, ["rev-parse", "origin/main"]);
  const behind = head !== main;
  if (behind) log(`  ! チェックアウト（${head.slice(0, 7)}）が origin/main（${main.slice(0, 7)}）と違う。合わせてからビルドする`);
  else log(`  ✓ チェックアウトは origin/main（${main.slice(0, 7)}）と同じ`);

  if (opts.check) {
    log("\n--check なので、ここで終わる（ビルドもチェックアウトの書き換えもしていない）");
    return null;
  }

  if (night) await requireYes("夜のジョブの時間帯だが、このままビルドする（途中で夜のジョブが始まると dist/ を作り直されうる）", "ビルドせずに止めた。8 時以降にやり直す");
  if (behind) {
    const dirty = await gitOut(run, settings.checkout, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty) throw new Error(`チェックアウトに未コミットの変更がある。合わせられない（承認済みの main のチェックアウトは手で書き換えない）:\n${dirty}`);
    await requireYes(`チェックアウトを origin/main（${main.slice(0, 7)}）に合わせる〈git checkout --detach origin/main〉`, "合わせずに止めた。何もビルドしていない");
    await run("git", ["-C", settings.checkout, "checkout", "--detach", "origin/main"], { inherit: true });
    head = await gitOut(run, settings.checkout, ["rev-parse", "HEAD"]);
  }
  if (!SHA.test(head)) throw new Error("チェックアウトの HEAD を読めない");

  // 4. ビルド
  await requireYes(`${siteDir} で pnpm install --frozen-lockfile と pnpm build（BUILD_COMMIT_SHA=${head.slice(0, 7)}）を行う`, "ビルドせずに止めた");
  log("\n1/2 pnpm install --frozen-lockfile");
  await build("pnpm", ["install", "--frozen-lockfile"], { cwd: siteDir, env: {} });
  log("\n2/2 pnpm build（本番の値は .env.production から読む。本番の Strapi〈オンプレ〉から公開済みの記事を読む）");
  try {
    await build("pnpm", ["build"], { cwd: siteDir, env: { BUILD_COMMIT_SHA: head } });
  } catch (e) {
    throw new Error(
      `${e.message}。上の出力を見る（「公開済みの記事が 0 件です」なら R2 が本番の Strapi で記事を公開する。` +
        "「dist/ に Strapi・S3 の URL が残っています」なら prod.conf の UPLOAD_S3_BUCKET を確かめて .env.production を書き直す。cloud/README.md の 4.14）",
    );
  }

  // 5. できた dist を確かめる
  const dist = join(siteDir, "dist");
  log("\nできた dist を確かめる（4.14 の手順 2-0〜2-5）");
  const fresh = await inspectFreshness({ dist, kind: "checkout" }, settings, run);
  const content = inspectDistContent(dist, settings);
  const errors = [...fresh.errors, ...content.errors];
  const { mark } = distMarks(dist);
  if (mark?.commit !== head) errors.push(`_build.json の commit（${mark?.commit?.slice(0, 7) ?? "無い"}）が HEAD（${head.slice(0, 7)}）と違う`);
  for (const n of [...fresh.notes, ...content.notes]) log(`  ・${n}`);
  for (const w of fresh.warnings) log(`  ! ${w}`);
  for (const e of errors) log(`  ✗ ${e}`);
  if (errors.length) throw new Error("ビルドはできたが、確かめを通らないため止めた（配信しない。.env.production と prod.conf を確かめてビルドし直す）");
  log("  ✓ 2-0〜2-5 と _build.json を通った");

  // 6. 写す
  const copied = copy(dist, settings.dataDir, head, now());
  const info = fresh.info;
  log(
    [
      "\nビルドの結果",
      `  コミット:  ${head.slice(0, 7)}（ビルド ${info?.builtAt ?? "不明"}・記事 ${Array.isArray(info?.articles) ? `${info.articles.length} 本` : "不明"}）`,
      `  配る dist: ${copied}`,
      "",
      "次: 配信する（S3 への同期と CloudFront の無効化。配信用の主体で行う）",
      `  node cloud/deploy-site.mjs --dist ${copied}${opts.config ? ` --config ${resolve(opts.config)}` : ""}`,
    ].join("\n"),
  );

  // 7. 続けて配信する
  if (deploy && (await confirmYes("続けて deploy-site.mjs で配信する（このあと配信の前にもう一度 yes を聞く）"))) {
    await deploy(copied);
  }
  return copied;
}

const HELP = `使い方: node cloud/build-site.mjs [--check] [--config <prod.conf>]
  公開サイト（Astro）を、承認済みの main のチェックアウトで本番用にビルドする（cloud/README.md の 4.14 の「ビルドの前提」）。
  できた dist を確かめて写し、続けて node cloud/deploy-site.mjs --dist <写した dist> で配る（最後に yes で起動もできる）。
  --check   確かめるだけ（チェックアウトは git fetch だけ。ビルドしない）
  --config  prod.conf のパス（既定 ~/.config/comegin/setup/prod.conf）`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }
  const deploySite = fileURLToPath(new URL("./deploy-site.mjs", import.meta.url));
  await runSiteBuild(opts, {
    run: realRun,
    build: runClean,
    ask: askOnTerminal,
    loadConf: (path) => loadConfig("prod", path ?? undefined),
    deploy: (dist) =>
      realRun(process.execPath, [deploySite, "--dist", dist, ...(opts.config ? ["--config", resolve(opts.config)] : [])], { inherit: true }),
  });
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(e.exitCode === 3 ? 3 : 1);
  });
}
