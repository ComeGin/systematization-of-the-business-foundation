#!/usr/bin/env node
// 公開サイト（Astro）の配信の包み。cloud/README.md の 4.14 の手順 1〜5 を、人が端末で 1 本で行うためのもの。
// 生の aws s3 sync・aws cloudfront create-invalidation のかわりに、人がこれを実行する（Claude Code の実行環境では実行しない。ADR-15）。
//
// 使い方（リポジトリのどこからでもよい）:
//   node cloud/deploy-site.mjs                 配る dist を選び、確かめてから配信する（途中で yes の入力を待つ）
//   node cloud/deploy-site.mjs --dist <絶対パス> 配る dist を指定する（監視アプリの配信の項目に出た dist のパスなど）
//   node cloud/deploy-site.mjs --check         確かめるだけ（手順 2。AWS には触れない。チェックアウトは git fetch だけ）
//   オプション: --config <prod.conf のパス>（既定 ~/.config/comegin/setup/prod.conf）
//               --admin-profile <名前>（バケット名・ディストリビューション ID をスタックの出力から取るときの管理者のプロファイル。既定 comegin-prod-admin）
//
// 手順（この順。4.14 と同じ）:
//   1. prod.conf を読む（PUBLIC_SITE_URL・CALCOM_LINK・GA4_MEASUREMENT_ID・SITE_BUILD_CHECKOUT〈空なら CONTROL_MAIN_CHECKOUT〉・
//      CONTROL_DATA_DIR・CONTROL_DEPLOY_*）。秘密値は読んでも使わず、画面に出さない
//   2. 配る dist を決める。候補は ① 監視アプリが夜のビルドの後に写した dist（<CONTROL_DATA_DIR>/deploy/<名前>/dist。新しい順）、
//      ①' cloud/build-site.mjs が手でビルドして写した dist（<CONTROL_DATA_DIR>/deploy-manual/<名前>/dist。新しい順。2026-11-21）と
//      ② main のチェックアウトの dist。監視アプリの配信の項目があるなら ① を選ぶ（下の「_build.json」）
//   3. 確かめる（4.14 の手順 2-0〜2-5）。チェックアウトが origin/main と違う・dist が古いときは、
//      ② を選んだ場合だけ「合わせる（checkout --detach origin/main）」「ビルドし直す（pnpm install・pnpm build）」を yes で行える
//   4. バケット名とディストリビューション ID を決める（prod.conf の CONTROL_DEPLOY_BUCKET・CONTROL_DEPLOY_DISTRIBUTION_ID。
//      無ければ管理者のプロファイルで親スタックの出力 AstroBucketName・DistributionId を読む。配信用の主体は DescribeStacks を持たない）
//   5. 要約を出して yes を待つ → 配信用のプロファイル（CONTROL_DEPLOY_AWS_PROFILE。既定 comegin-prod-deploy）で
//      aws sso login（セッションが切れているときだけ）→ 主体が ComeginProdDeploy であることを確かめる
//   6. 同期（_astro/ を長期キャッシュで先に → それ以外を --delete で）→ 無効化。この順を入れ替えない（逆にすると更新が一巡遅れる）
//   7. 公開サイトの build-info.json が配ったビルドに変わるまで待ち（無効化は数分かかる。最長 10 分）、sitemap・robots.txt・_build.json を確かめる
//   8. aws sso logout を yes で行う（同じ sso-session の管理者のプロファイルもログアウトになる）
//
// _build.json（監視アプリの配信の項目の確かめに使う印）:
//   監視アプリは「実行した」の後、公開サイトの /_build.json の commit が項目のコミットと同じかを見る（backend/control-plane/src/cycle/confirm.ts）。
//   _build.json は夜のビルド（published-article-check。BUILD_COMMIT_SHA を渡す）の dist にだけ入り、人が手でビルドした dist には入らない
//   （frontend/verdant-virgo/src/modules/build-info）。2 本目の同期は --delete なので、_build.json の無い dist を配ると公開中の _build.json が消え、
//   開いている配信の項目は確かめられなくなる。そのときは警告を出して yes を待つ。
//
// 入力待ち（yes 以外なら何もせずに終了コード 3 で終わる。端末につながっていないときも 3）:
//   配る dist の選択・チェックアウトを合わせる・ビルドし直す・_build.json が無い dist を配る・origin/main より古いビルドを配る・
//   配信の実行・aws sso login・aws sso logout
// 終了コード: 0 済み / 1 確かめで止めた・失敗 / 3 yes が入力されなかった
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { askOnTerminal, loadConfig } from "../setup/lib/core.mjs";
import { isDirectRun, realRun } from "./lib/exec.mjs";

const STACK = "comegin-prod";
const REGION = "ap-northeast-1";
const DEFAULT_ADMIN_PROFILE = "comegin-prod-admin";
const DEFAULT_DEPLOY_PROFILE = "comegin-prod-deploy";
/** 監視アプリの dist の写しの置き場（published-article-check の DEPLOY_COPIES_DIR・DEPLOY_COPY_NAME と同じ） */
const DEPLOY_COPIES_DIR = "deploy";
const DEPLOY_COPY_NAME = /^[0-9a-f]{12}-[0-9a-f]{12}$/;
/** cloud/build-site.mjs が手でビルドした dist の写しの置き場（build-site.mjs の MANUAL_COPIES_DIR・MANUAL_COPY_NAME と同じ） */
const MANUAL_COPIES_DIR = "deploy-manual";
const MANUAL_COPY_NAME = /^[0-9a-f]{12}-\d{8}T\d{6}Z$/;
const SITE_DIR = "frontend/verdant-virgo";
/** プロファイル名・バケット名・ディストリビューション ID に許す文字（backend/control-plane/src/cycle/commands.ts の SAFE_TOKEN と同じ） */
const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/;
/** 配信用の主体（4.5.1 の許可セット ComeginProdDeploy。SSO を使えない人の IAM ユーザー comegin-prod-deploy も許す） */
const DEPLOY_PRINCIPAL = /:assumed-role\/AWSReservedSSO_ComeginProdDeploy_[^/]+\/[^/]+$|:user\/comegin-prod-deploy$/;
/** 中身を確かめるファイル（画像・フォントは見ない） */
const TEXT_FILE = /\.(html|xml|js|mjs|css|json|txt|webmanifest|svg)$/i;
const SHA = /^[0-9a-f]{40}$/;
const WAIT_TOTAL_MS = 10 * 60_000;
const WAIT_INTERVAL_MS = 15_000;

/** yes 以外で終わる（終了コード 3） */
class Declined extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 3;
  }
}

// ---------------------------------------------------------------------------
// 引数と設定
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = { dist: null, check: false, config: null, adminProfile: DEFAULT_ADMIN_PROFILE, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} の値が無い`);
      return v;
    };
    if (a === "--dist") opts.dist = value();
    else if (a === "--check") opts.check = true;
    else if (a === "--config") opts.config = value();
    else if (a === "--admin-profile") opts.adminProfile = value();
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`知らない引数: ${a}（node cloud/deploy-site.mjs --help）`);
  }
  if (opts.dist !== null && !isAbsolute(opts.dist)) throw new Error("--dist は絶対パスで書く（相対パスだと作業ツリーの開発用の dist を上げてしまう。4.14）");
  if (!SAFE_TOKEN.test(opts.adminProfile)) throw new Error("--admin-profile に使えない文字がある");
  return opts;
}

/** prod.conf から、この配信で使う値だけを取り出す（秘密値は取り出さない） */
export function siteSettings(conf) {
  const lacks = [];
  const siteUrl = conf.PUBLIC_SITE_URL ?? "";
  let origin = null;
  try {
    const u = new URL(siteUrl);
    if (u.protocol === "https:") origin = u.origin;
  } catch {
    /* 下で足りないものとして扱う */
  }
  if (!origin) lacks.push("PUBLIC_SITE_URL（本番の公開サイトの https の URL）");
  const calcomLink = conf.CALCOM_LINK ?? "";
  if (!calcomLink) lacks.push("CALCOM_LINK（<ユーザー名>/<イベントの slug>）");
  const checkout = conf.SITE_BUILD_CHECKOUT || conf.CONTROL_MAIN_CHECKOUT || "";
  if (!checkout || !isAbsolute(checkout)) lacks.push("SITE_BUILD_CHECKOUT か CONTROL_MAIN_CHECKOUT（承認済みの main のチェックアウトの絶対パス）");
  if (lacks.length) throw new Error(`prod.conf に次が無い: ${lacks.join("・")}`);
  return {
    origin,
    domain: new URL(origin).hostname.replace(/^www\./, ""),
    calcomLink,
    ga4: conf.GA4_MEASUREMENT_ID ?? "",
    checkout: resolve(checkout),
    dataDir: resolve(conf.CONTROL_DATA_DIR || join(homedir(), ".local/share/comegin-control")),
    bucket: conf.CONTROL_DEPLOY_BUCKET ?? "",
    distributionId: conf.CONTROL_DEPLOY_DISTRIBUTION_ID ?? "",
    deployProfile: conf.CONTROL_DEPLOY_AWS_PROFILE ?? "",
  };
}

// ---------------------------------------------------------------------------
// dist を読む
// ---------------------------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** dist の印（build-info.json と _build.json）。無ければ null */
export function distMarks(dist) {
  return { info: readJson(join(dist, "build-info.json")), mark: readJson(join(dist, "_build.json")) };
}

/** 置き場の下の写しの dist（新しい順） */
function copiesIn(dir, pattern) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && pattern.test(e.name) && existsSync(join(dir, e.name, "dist", "index.html")))
    .map((e) => join(dir, e.name, "dist"))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/** 配る dist の候補。監視アプリの写し（新しい順）→ build-site.mjs の写し（新しい順）→ main のチェックアウトの dist */
export function distCandidates(settings) {
  const out = [];
  for (const dist of copiesIn(join(settings.dataDir, DEPLOY_COPIES_DIR), DEPLOY_COPY_NAME)) out.push({ dist, kind: "copy" });
  for (const dist of copiesIn(join(settings.dataDir, MANUAL_COPIES_DIR), MANUAL_COPY_NAME)) out.push({ dist, kind: "manual" });
  const checkoutDist = join(settings.checkout, SITE_DIR, "dist");
  if (existsSync(join(checkoutDist, "index.html"))) out.push({ dist: checkoutDist, kind: "checkout" });
  return out;
}

function describeCandidate({ dist, kind }) {
  const { info, mark } = distMarks(dist);
  const label =
    kind === "copy" ? "監視アプリの写し（夜のビルド）" : kind === "manual" ? "build-site.mjs の写し（手でビルドしたもの・_build.json あり）" : "main のチェックアウトの dist（手でビルドしたもの）";
  const commit = info?.commit ? info.commit.slice(0, 7) : "不明";
  const articles = Array.isArray(info?.articles) ? `${info.articles.length} 本` : "不明";
  return `${label}\n     ${dist}\n     コミット ${commit}・ビルド ${info?.builtAt ?? "不明"}・記事 ${articles}・_build.json ${mark ? "あり" : "なし"}`;
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

/** dist のテキストのファイルを { rel, text } で返す */
function textFiles(dist) {
  const out = [];
  for (const file of walk(dist)) if (TEXT_FILE.test(file)) out.push({ rel: relative(dist, file), text: readFileSync(file, "utf8") });
  return out;
}

const firstFew = (list, n = 10) => (list.length > n ? `${list.slice(0, n).join("・")} ほか ${list.length - n} 件` : list.join("・"));

/**
 * 4.14 の手順 2-1〜2-5（dist の中身）。{ errors, notes } を返す。git や AWS には触れない
 */
export function inspectDistContent(dist, settings) {
  const errors = [];
  const notes = [];
  const files = textFiles(dist);
  const astro = files.filter((f) => f.rel.startsWith(`_astro/`) || f.rel.startsWith("_astro\\"));

  // 2-1. 開発の接続先が 1 つも無い（ポートを付けずに localhost で探すと、ライブラリの中の判定の文字列に当たるので、ポート付きで探す）
  const dev = files.filter((f) => /ngrok/.test(f.text) || /localhost:[0-9]/.test(f.text) || /127\.0\.0\.1:[0-9]/.test(f.text)).map((f) => f.rel);
  if (dev.length) errors.push(`2-1 開発の接続先（ngrok・ポート付きの localhost／127.0.0.1）が残っている: ${firstFew(dev)}`);

  // 2-2. sitemap と canonical のホストが本番の URL だけ
  const hostsOf = (pattern, list) => {
    const set = new Set();
    for (const f of list) for (const m of f.text.matchAll(pattern)) set.add(m[1]);
    return set;
  };
  const sitemaps = files.filter((f) => /^sitemap-.*\.xml$/.test(f.rel));
  const locHosts = hostsOf(/<loc>(https?:\/\/[^/<]+)/g, sitemaps);
  const canonHosts = hostsOf(/<link rel="canonical" href="(https?:\/\/[^/"]+)/g, files.filter((f) => f.rel.endsWith(".html")));
  if (sitemaps.length === 0) errors.push("2-2 sitemap-*.xml が無い");
  for (const [name, set] of [["sitemap", locHosts], ["canonical", canonHosts]]) {
    if (set.size === 0) errors.push(`2-2 ${name} の URL が 1 つも見つからない`);
    else if (set.size !== 1 || !set.has(settings.origin)) errors.push(`2-2 ${name} のホストが ${settings.origin} だけではない: ${[...set].join("・")}`);
  }

  // 2-3. 本番の受け口（chat.・mkt.・consent.）が焼き込まれている
  const missing = ["chat", "mkt", "consent"].filter((sub) => !astro.some((f) => f.text.includes(`https://${sub}.${settings.domain}`)));
  if (missing.length) errors.push(`2-3 _astro/ に本番の受け口が無い: ${missing.map((s) => `https://${s}.${settings.domain}`).join("・")}`);

  // 2-4. Cal.com のイベント（https://app.cal.com だけでは判定できない。既定値なので CALCOM_LINK が空でも焼き込まれる）
  if (!astro.some((f) => f.text.includes(settings.calcomLink))) errors.push(`2-4 _astro/ に Cal.com のイベント（CALCOM_LINK）が無い`);

  // 2-5. GA4 の測定 ID（段階 google の後だけ。prod.conf が空なら、タグを出さないのが正しい）
  if (settings.ga4) {
    if (!astro.some((f) => f.text.includes(settings.ga4))) errors.push("2-5 _astro/ に GA4 の測定 ID（GA4_MEASUREMENT_ID）が無い（空のままビルドするとタグのコードごと消える）");
  } else {
    notes.push("2-5 prod.conf の GA4_MEASUREMENT_ID が空なので、測定 ID は確かめない（段階 google の前なら、タグを出さないのが正しい）");
  }
  return { errors, notes };
}

// ---------------------------------------------------------------------------
// チェックアウトと dist の新しさ（4.14 の手順 2-0）
// ---------------------------------------------------------------------------

async function gitOut(run, checkout, args) {
  return (await run("git", ["-C", checkout, ...args])).trim();
}

/**
 * 4.14 の手順 2-0。{ errors, warnings, notes, checkoutBehind, distStale } を返す。
 * checkoutBehind・distStale は、② を選んだときに「合わせる」「ビルドし直す」を勧めるための印
 */
export async function inspectFreshness(candidate, settings, run) {
  const errors = [];
  const warnings = [];
  const notes = [];
  let checkoutBehind = false;
  let distStale = false;
  const { dist, kind } = candidate;
  const { info, mark } = distMarks(dist);

  await run("git", ["-C", settings.checkout, "fetch", "-q", "origin", "main"]);
  const head = await gitOut(run, settings.checkout, ["rev-parse", "HEAD"]);
  const main = await gitOut(run, settings.checkout, ["rev-parse", "origin/main"]);

  if (!info) errors.push("2-0 dist に build-info.json が無い（この機能より前のビルド）。監視アプリが再配信の要否を判定できない。ビルドし直す");
  else if (!info.commit || !SHA.test(info.commit)) errors.push("2-0 build-info.json の commit が無い（git を読めなかったビルド）。ビルドし直す");
  if (info && info.articles === null) warnings.push("build-info.json の articles が null（Strapi から記事の一覧を取れなかったビルド。記事の未配信を判定できない）");
  if (!existsSync(join(dist, "robots.txt"))) errors.push("2-0 dist に robots.txt が無い（804863e2 より前のビルド）");

  if (kind === "checkout") {
    if (head !== main) {
      checkoutBehind = true;
      errors.push(`2-0 チェックアウト（${head.slice(0, 7)}）が origin/main（${main.slice(0, 7)}）と違う。checkout --detach origin/main で合わせてビルドし直す`);
    }
    const committedAt = Number(await gitOut(run, settings.checkout, ["log", "-1", "--format=%ct", "HEAD"])) * 1000;
    const builtAt = statSync(join(dist, "index.html")).mtimeMs;
    if (builtAt <= committedAt || (info?.commit && info.commit !== head)) {
      distStale = true;
      errors.push("2-0 dist がチェックアウトのコミットより古い（ビルドがマージより先。マージ済みの修正が入らない）。ビルドし直す");
    }
  } else if (info?.commit && info.commit !== main) {
    warnings.push(
      `このビルドのコミット（${info.commit.slice(0, 7)}）は origin/main（${main.slice(0, 7)}）より古い。その後にマージした変更は入らない` +
        "（監視アプリの配信の項目どおりに配るならこのままでよい。次の 00:00 の published-article-check が新しい項目を作る）",
    );
  }

  if (mark?.commit) notes.push(`_build.json あり（commit ${mark.commit.slice(0, 7)}。監視アプリの配信の項目の「実行した」で確かめられる）`);
  else {
    warnings.push(
      "dist に _build.json が無い（手でビルドした dist）。2 本目の同期は --delete なので、公開中の _build.json が消え、" +
        "監視アプリで開いている配信の項目は「実行した」で確かめられなくなる。配信の項目があるなら、項目に出た dist（監視アプリの写し）を配る",
    );
  }
  return { errors, warnings, notes, checkoutBehind, distStale, head, main, info, mark };
}

// ---------------------------------------------------------------------------
// AWS
// ---------------------------------------------------------------------------

/** 親スタックの出力（AstroBucketName・DistributionId）を管理者のプロファイルで読む */
async function stackOutputs(run, profile) {
  const text = await run("aws", [
    "cloudformation", "describe-stacks", "--region", REGION, "--stack-name", STACK, "--profile", profile,
    "--query", "Stacks[0].Outputs", "--output", "json",
  ]);
  const outputs = JSON.parse(text) ?? [];
  const of = (key) => outputs.find((o) => o.OutputKey === key)?.OutputValue ?? "";
  return { bucket: of("AstroBucketName"), distributionId: of("DistributionId") };
}

async function callerArn(run, profile) {
  try {
    return (await run("aws", ["sts", "get-caller-identity", "--profile", profile, "--query", "Arn", "--output", "text"])).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 配信の後の確かめ（4.14 の手順 5）
// ---------------------------------------------------------------------------

async function fetchText(url, fetchImpl) {
  try {
    const res = await fetchImpl(url, { headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(15_000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/** 公開サイトの build-info.json が、配ったビルドに変わるまで待つ。変われば true */
async function waitForBuild(settings, info, { fetchImpl, sleep, log }) {
  const deadline = Date.now() + WAIT_TOTAL_MS;
  for (;;) {
    const text = await fetchText(`${settings.origin}/build-info.json?t=${Date.now()}`, fetchImpl);
    let live = null;
    try {
      live = text ? JSON.parse(text) : null;
    } catch {
      /* 読めなければ待つ */
    }
    if (live && live.commit === info.commit && live.builtAt === info.builtAt) return true;
    if (Date.now() >= deadline) return false;
    log(`  公開サイトの build-info.json はまだ前のビルド（${live?.builtAt ?? "読めない"}）。${WAIT_INTERVAL_MS / 1000} 秒後に見直す`);
    await sleep(WAIT_INTERVAL_MS);
  }
}

async function verifyLive(settings, mark, fetchImpl) {
  const problems = [];
  const sitemap = await fetchText(`${settings.origin}/sitemap-0.xml?t=${Date.now()}`, fetchImpl);
  const hosts = new Set([...(sitemap ?? "").matchAll(/<loc>(https?:\/\/[^/<]+)/g)].map((m) => m[1]));
  if (hosts.size !== 1 || !hosts.has(settings.origin)) problems.push(`sitemap-0.xml のホストが ${settings.origin} だけではない（${[...hosts].join("・") || "読めない"}）`);
  const robots = await fetchText(`${settings.origin}/robots.txt?t=${Date.now()}`, fetchImpl);
  if (!robots || !robots.split(/\r?\n/).some((l) => l.trim() === `Sitemap: ${settings.origin}/sitemap-index.xml`)) {
    problems.push(`robots.txt に「Sitemap: ${settings.origin}/sitemap-index.xml」が無い（古い dist が配信されている）`);
  }
  if (mark?.commit) {
    const live = readJsonText(await fetchText(`${settings.origin}/_build.json?t=${Date.now()}`, fetchImpl));
    if (live?.commit !== mark.commit) problems.push(`公開サイトの _build.json のコミットが配った dist（${mark.commit.slice(0, 7)}）と違う`);
  }
  return problems;
}

function readJsonText(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/**
 * 包みの中心。deps: { run（cloud/lib/exec.mjs の realRun の形）, ask（質問 → 入力。端末でなければ null）, log, fetchImpl, sleep, loadConf }
 */
export async function runSiteDeploy(opts, deps) {
  const { run, ask, log = console.log, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), loadConf } = deps;
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
  log(`設定: ${confFile}（公開サイト ${settings.origin}・チェックアウト ${settings.checkout}）`);

  // 2. 配る dist を決める
  let candidate;
  if (opts.dist) {
    const dist = resolve(opts.dist);
    if (!existsSync(join(dist, "index.html"))) throw new Error(`${dist} に index.html が無い（ビルドの済んだ dist を指定する）`);
    candidate = {
      dist,
      kind: dist === join(settings.checkout, SITE_DIR, "dist") ? "checkout" : dist.startsWith(join(settings.dataDir, MANUAL_COPIES_DIR)) ? "manual" : "copy",
    };
  } else {
    const list = distCandidates(settings);
    if (list.length === 0) {
      throw new Error(`配る dist が無い（${join(settings.dataDir, DEPLOY_COPIES_DIR)}・${join(settings.dataDir, MANUAL_COPIES_DIR)} の写しも、${join(settings.checkout, SITE_DIR, "dist")} も無い）。node cloud/build-site.mjs でビルドしてから実行する（setup/00-setup-overview.md の P12）`);
    }
    log("\n配る dist の候補（監視アプリの配信の項目があるなら、項目に出た dist〈監視アプリの写し〉を選ぶ）:");
    list.forEach((c, i) => log(`  ${i + 1}. ${describeCandidate(c)}`));
    const answer = await ask(`番号を入力する（空なら 1）: `);
    if (answer === null) throw new Declined("端末につながっていないため選べない。--dist <絶対パス> で指定する");
    const n = answer === "" ? 1 : Number(answer);
    if (!Number.isInteger(n) || n < 1 || n > list.length) throw new Declined(`番号が違う（${answer}）。何もしていない`);
    candidate = list[n - 1];
  }
  log(`\n配る dist: ${candidate.dist}`);

  // 3. 確かめる（2-0〜2-5）。② を選んだときだけ、合わせる・ビルドし直すを yes で行える（1 回だけ。やり直した後は確かめ直す）
  let fresh;
  let content;
  for (let attempt = 0; ; attempt++) {
    log("\n確かめる（4.14 の手順 2-0〜2-5）");
    fresh = await inspectFreshness(candidate, settings, run);
    content = inspectDistContent(candidate.dist, settings);
    for (const n of [...fresh.notes, ...content.notes]) log(`  ・${n}`);
    for (const w of fresh.warnings) log(`  ! ${w}`);
    for (const e of [...fresh.errors, ...content.errors]) log(`  ✗ ${e}`);
    const errors = [...fresh.errors, ...content.errors];
    if (errors.length === 0) {
      log("  ✓ 2-0〜2-5 を通った");
      break;
    }
    const fixable = candidate.kind === "checkout" && (fresh.checkoutBehind || fresh.distStale) && attempt === 0 && !opts.check;
    if (!fixable) {
      throw new Error(
        candidate.kind === "copy"
          ? "確かめを通らないため止めた（監視アプリの写しはここでは作り直せない。チェックアウトの dist を選ぶか、次の 00:00 の published-article-check を待つ）"
          : candidate.kind === "manual"
          ? "確かめを通らないため止めた（node cloud/build-site.mjs でビルドし直す）"
          : "確かめを通らないため止めた（ビルドのチェックアウトと .env.production を確かめてビルドし直す。cloud/README.md の 4.14）",
      );
    }
    log("\nチェックアウトの dist を作り直せる。監視アプリの夜のジョブ（0〜8 時）が同じチェックアウトを使うので、その時間帯は避ける");
    if (fresh.checkoutBehind) {
      const dirty = await gitOut(run, settings.checkout, ["status", "--porcelain", "--untracked-files=no"]);
      if (dirty) throw new Error(`チェックアウトに未コミットの変更がある。合わせられない（承認済みの main のチェックアウトは手で書き換えない）:\n${dirty}`);
      await requireYes(`チェックアウトを origin/main（${fresh.main.slice(0, 7)}）に合わせる〈git checkout --detach origin/main〉`, "合わせずに止めた。何も配信していない");
      await run("git", ["-C", settings.checkout, "checkout", "--detach", "origin/main"], { inherit: true });
    }
    await requireYes(`${join(settings.checkout, SITE_DIR)} で pnpm install --frozen-lockfile と pnpm build を行う`, "ビルドせずに止めた。何も配信していない");
    const cwd = join(settings.checkout, SITE_DIR);
    await run("pnpm", ["install", "--frozen-lockfile"], { cwd, inherit: true });
    await run("pnpm", ["build"], { cwd, inherit: true });
  }

  if (opts.check) {
    log("\n--check なので、ここで終わる（AWS には触れていない）");
    return;
  }
  if (fresh.warnings.length) await requireYes("上の「!」を確かめた。このまま進める", "止めた。何も配信していない");

  // 4. バケット名とディストリビューション ID
  let { bucket, distributionId } = settings;
  if (!bucket || !distributionId) {
    log(`\nバケット名・ディストリビューション ID が prod.conf に無いので、スタック ${STACK} の出力を管理者のプロファイル ${opts.adminProfile} で読む`);
    let outputs;
    try {
      outputs = await stackOutputs(run, opts.adminProfile);
    } catch {
      await requireYes(`読めなかった。aws sso login --profile ${opts.adminProfile} を行う`, "止めた。何も配信していない");
      await run("aws", ["sso", "login", "--profile", opts.adminProfile], { inherit: true });
      outputs = await stackOutputs(run, opts.adminProfile);
    }
    bucket ||= outputs.bucket;
    distributionId ||= outputs.distributionId;
  }
  if (!SAFE_TOKEN.test(bucket) || !SAFE_TOKEN.test(distributionId)) {
    throw new Error("バケット名かディストリビューション ID が取れない・使えない文字がある（プロファイル・リージョン・スタック名を確かめる）");
  }
  let profile = settings.deployProfile;
  if (!profile) {
    const answer = await ask(`配信用のプロファイル名（prod.conf の CONTROL_DEPLOY_AWS_PROFILE が空。空なら ${DEFAULT_DEPLOY_PROFILE}）: `);
    if (answer === null) throw new Declined("端末につながっていないため聞けない");
    profile = answer || DEFAULT_DEPLOY_PROFILE;
  }
  if (!SAFE_TOKEN.test(profile)) throw new Error("配信用のプロファイル名に使えない文字がある");

  // 5. 要約 → yes → ログインと主体の確かめ
  const info = fresh.info;
  log(
    [
      "\n配信の内容",
      `  dist:        ${candidate.dist}`,
      `  コミット:    ${info.commit.slice(0, 7)}（ビルド ${info.builtAt}・記事 ${Array.isArray(info.articles) ? `${info.articles.length} 本` : "不明"}）`,
      `  _build.json: ${fresh.mark?.commit ? fresh.mark.commit.slice(0, 7) : "なし（公開中の _build.json は消える）"}`,
      `  同期先:      s3://${bucket}`,
      `  無効化:      ${distributionId}`,
      `  プロファイル: ${profile}`,
    ].join("\n"),
  );
  await requireYes("本番の公開サイトに配信する", "配信せずに止めた");

  let arn = await callerArn(run, profile);
  if (!arn) {
    await requireYes(`${profile} のセッションが無い・切れている。aws sso login --profile ${profile} を行う（ブラウザが開く）`, "ログインせずに止めた。何も配信していない");
    await run("aws", ["sso", "login", "--profile", profile], { inherit: true });
    arn = await callerArn(run, profile);
  }
  if (!arn || !DEPLOY_PRINCIPAL.test(arn)) {
    throw new Error(`${profile} の主体が配信用（許可セット ComeginProdDeploy）ではない（${arn ?? "取れない"}）。管理者の主体では配らない（cloud/README.md の 4.5.1）`);
  }
  log(`主体: ${arn}`);

  // 6. 同期 → 無効化（この順を入れ替えない。commands.ts と同じ 3 本）
  const src = `${candidate.dist.replace(/\/+$/, "")}/`;
  log("\n1/3 _astro/ を同期する（長期キャッシュ）");
  await run("aws", ["s3", "sync", src, `s3://${bucket}`, "--exclude", "*", "--include", "_astro/*", "--cache-control", "public,max-age=31536000,immutable", "--profile", profile], { inherit: true });
  log("\n2/3 それ以外を同期する（都度検証・--delete で古いページを消す）");
  await run("aws", ["s3", "sync", src, `s3://${bucket}`, "--exclude", "_astro/*", "--delete", "--cache-control", "public,max-age=0,must-revalidate", "--profile", profile], { inherit: true });
  log("\n3/3 CloudFront を無効化する");
  const invalidationId = (await run("aws", ["cloudfront", "create-invalidation", "--distribution-id", distributionId, "--paths", "/*", "--profile", profile, "--query", "Invalidation.Id", "--output", "text"])).trim();
  log(`  無効化 ${invalidationId} を作った`);

  // 7. 公開サイトで確かめる（配信用の主体は GetInvalidation を持たないので、公開サイトの build-info.json で待つ）
  log(`\n公開サイトで確かめる（無効化の完了を待つ。最長 ${WAIT_TOTAL_MS / 60_000} 分）`);
  const arrived = await waitForBuild(settings, info, { fetchImpl, sleep, log });
  const problems = arrived ? await verifyLive(settings, fresh.mark, fetchImpl) : [`${WAIT_TOTAL_MS / 60_000} 分待っても、公開サイトの build-info.json が配ったビルドに変わらない（無効化の状態を CloudFront の画面で見る）`];
  if (problems.length === 0) log("  ✓ build-info.json・sitemap・robots.txt" + (fresh.mark?.commit ? "・_build.json" : "") + " が配ったビルドと合う");
  for (const p of problems) log(`  ✗ ${p}`);

  log(
    fresh.mark?.commit
      ? "\n次: 監視アプリの改善の周の画面で、この配信の項目の「実行した」を押す（記事の URL が 200 か・_build.json のコミットが合うかを確かめる）"
      : "\n次: 監視アプリの配信の項目が開いているなら、この dist では確かめられない。設定の状況（/setup-status）で再配信の要否を見る",
  );

  // 8. ログアウト
  if (await confirmYes(`aws sso logout を行う（同じ sso-session の管理者のプロファイルもログアウトになる）`)) {
    await run("aws", ["sso", "logout", "--profile", profile], { inherit: true });
  }
  if (problems.length) throw new Error("配信はしたが、公開サイトの確かめが通らなかった（上の ✗）");
}

const HELP = `使い方: node cloud/deploy-site.mjs [--dist <絶対パス>] [--check] [--config <prod.conf>] [--admin-profile <名前>]
  公開サイト（Astro）の dist を確かめ、本番の S3 へ同期して CloudFront を無効化する（cloud/README.md の 4.14）。
  --dist           配る dist（省略時は候補から選ぶ。監視アプリの配信の項目があるなら、項目に出た dist を指定する）
  --check          確かめるだけ（AWS に触れない。チェックアウトは git fetch だけ）
  --config         prod.conf のパス（既定 ~/.config/comegin/setup/prod.conf）
  --admin-profile  バケット名・ディストリビューション ID をスタックの出力から読むプロファイル（既定 ${DEFAULT_ADMIN_PROFILE}。prod.conf に値があれば使わない）`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }
  await runSiteDeploy(opts, {
    run: realRun,
    ask: askOnTerminal,
    loadConf: (path) => loadConfig("prod", path ?? undefined),
  });
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(e.exitCode === 3 ? 3 : 1);
  });
}
