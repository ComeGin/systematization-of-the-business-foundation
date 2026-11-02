// 監視アプリ（next-js ＋ control-plane。改善ループの起動元）を本番の値で常駐させる。setup/lib/core.mjs の契約に従う。--target prod の段階 operate だけ。
// 手順の正本は onprem/README.md の「監視アプリ（改善ループ）を本番で動かす」（setup/00-setup-overview.md の P14）。
//
// 監視アプリは開発と本番の区別が無い 1 つのインスタンスで（TA-07 の 2 節）、エージェントが書き込む先が本番（*-prod の MCP）なので、
// このモジュールが承認済みの main のチェックアウトの frontend/next-js/.env を本番の値で書く。開発のモジュール（../index.mjs）は作業ツリーの .env を扱い、
// こちらとは別のファイル（ADR-18。作業ツリーの未承認の変更を管制のコードに効かせないため、本番はチェックアウトから動かす）。
//
// 行うこと（止まるのは 1〜6。どれも人の作業を案内して止まる）:
//   1. チェックアウトが origin/main と同じコミットか（git の状態は人が変える。setup は git を書き換えない）
//   2. control-plane（dist/）と next-js（.next/）のビルドが、チェックアウトを動かした後のものか（ビルドは人が行う）
//   3. 監視アプリの主体: IAM ユーザー comegin-prod-control-plane と管理ポリシー comegin-prod-control-plane（作成とキーの発行は人。cloud/README.md の 4.5.2）
//   4. 監視アプリ専用の資格情報ファイル（600）と、そのキーが 3 のユーザーのものであること（sts get-caller-identity。読み取りだけ）
//   5. 本番の値（prod.conf と状態）がそろっていること → チェックアウトの .env に書く（600。値は表示しない）
//   6. systemd のユニット comegin-control が、このチェックアウトで動いていて、.env を書いた後に起動していること（/etc は人が書く）
//   7. 127.0.0.1:3200 が応答し、Google ログインを始められること（開発のモジュールと同じ確かめ方）
//   8. 警告だけ: ハートビートのアラーム・有効な定期実行の数・heartbeat.yaml の誤った有効化
//
// AWS は読み取りだけ（cloudformation describe-stacks・iam get-user・list-attached-user-policies・sts get-caller-identity・
// cloudwatch describe-alarms）。AWS の認証は環境（管理者のプロファイル）に任せ、4 の確認だけは資格情報ファイルのキーで行う
// （このプロセスの AWS の環境変数を引き継がない子プロセスで。管理者のキーが優先されて誤って通るのを防ぐ）。
//
// 設定のキー（~/.config/comegin/setup/prod.conf）:
//   必須: CONTROL_MAIN_CHECKOUT（空なら SITE_BUILD_CHECKOUT）・ANTHROPIC_API_KEY・CHATWOOT_ACCOUNT_ID・CHATWOOT_AGENT_TOKEN（P7）
//   任意: CONTROL_WORKTREE（既定は作業ツリー）・CONTROL_DATA_DIR・CONTROL_AGENT_HOME・CONTROL_PUBLIC_URL・CONTROL_ADMIN_EMAILS・
//         CONTROL_GOOGLE_CLIENT_ID/SECRET（無ければ、今の監視アプリ〈作業ツリーの .env〉の値を引き継ぐ）・
//         CONTROL_AWS_CREDENTIALS_FILE（既定 ~/.config/comegin/control-plane/aws-credentials）・CHATWOOT_BASE_URL・
//         GITHUB_TOKEN・GITHUB_REPOSITORY（既定は origin の URL から）・GITHUB_BASE_BRANCH・I13_ISSUE_NUMBER・I13_REVIEWER・
//         CONTROL_N8N_EXPORT_URL・CONTROL_N8N_EXPORT_API_KEY（キーのスコープを人が判断してから）
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REGION, STACK, awsJson, outputOf, requireMainStack } from "../../../../cloud/setup/aws.mjs";
import { DEFAULT_HOSTED_DOMAIN, GROUPS, LOCAL_URL, probe, publicUrlOf, validateGroups, verifyGoogle } from "../index.mjs";

export const meta = { id: "next-js-prod", title: "監視アプリ（本番。改善ループの常駐）", targets: ["prod"], phases: ["operate"], after: [] };

const IAM_USER = "comegin-prod-control-plane";
const POLICY = "comegin-prod-control-plane";
const UNIT = "comegin-control";
const HEARTBEAT_ALARM = "comegin-prod-onprem-heartbeat";
const DEFAULT_CREDENTIALS = join(homedir(), ".config/comegin/control-plane/aws-credentials");
const DEFAULT_CHATWOOT = "https://chat.comegin.com";
const MANUAL = "onprem/README.md の「監視アプリ（改善ループ）を本番で動かす」";

const checkoutOf = (ctx) => ctx.conf.CONTROL_MAIN_CHECKOUT || ctx.conf.SITE_BUILD_CHECKOUT;
const appDirOf = (main) => join(main, "frontend/next-js");
const credentialsOf = (ctx) => ctx.conf.CONTROL_AWS_CREDENTIALS_FILE || DEFAULT_CREDENTIALS;

async function git(ctx, args) {
  return (await ctx.run("git", args, { timeoutMs: 30_000 })).trim();
}

/** 1. チェックアウトが origin/main と同じコミットか。origin/main は作業ツリーのリモート追跡ブランチ（取り込みは人が git fetch で行う） */
async function checkoutProblem(ctx, main) {
  if (!main) return "CONTROL_MAIN_CHECKOUT（承認済みの main のチェックアウトの絶対パス）が prod.conf に無い";
  if (!main.startsWith("/") || !existsSync(join(main, "frontend/next-js/package.json"))) return `CONTROL_MAIN_CHECKOUT（${main}）に frontend/next-js が無い（絶対パスか、正しいチェックアウトかを確かめる）`;
  if (realpathSync(main) === realpathSync(ctx.conf.CONTROL_WORKTREE || ctx.REPO)) return "CONTROL_MAIN_CHECKOUT が作業ツリーと同じ場所（ADR-18。本番は承認済みの main のチェックアウトから動かす）";
  const head = await git(ctx, ["-C", main, "rev-parse", "HEAD"]);
  const origin = await git(ctx, ["-C", ctx.REPO, "rev-parse", "origin/main"]);
  if (head !== origin) return `チェックアウトが origin/main（${origin.slice(0, 8)}）ではなく ${head.slice(0, 8)} を指している`;
  return null;
}

/** チェックアウトの HEAD を最後に動かした時刻（秒）。worktree ごとの HEAD の reflog。無ければコミットの時刻 */
async function headMovedAt(ctx, main) {
  try {
    const t = await git(ctx, ["-C", main, "log", "-g", "-1", "--format=%ct", "HEAD"]);
    if (t) return Number(t);
  } catch {
    /* reflog が無い */
  }
  return Number(await git(ctx, ["-C", main, "log", "-1", "--format=%ct", "HEAD"]));
}

/** 2. ビルドが無い・チェックアウトを動かす前のもの */
async function buildProblems(ctx, main) {
  const moved = await headMovedAt(ctx, main);
  const items = [
    { label: "backend/control-plane の dist/", file: join(main, "backend/control-plane/dist/index.js") },
    { label: "frontend/next-js の node_modules", file: join(main, "frontend/next-js/node_modules") },
    { label: "frontend/next-js の .next/（next build）", file: join(main, "frontend/next-js/.next/BUILD_ID") },
  ];
  const problems = [];
  for (const it of items) {
    if (!existsSync(it.file)) problems.push(`${it.label} が無い`);
    else if (it.label.includes("node_modules")) continue; // pnpm install は中身を差し替えても日時が変わらないことがある
    else if (statSync(it.file).mtimeMs / 1000 < moved) problems.push(`${it.label} がチェックアウトを動かす前のビルド`);
  }
  return problems;
}

function buildSteps(main, problems) {
  return [
    ...problems.map((p) => `いまの状態: ${p}`),
    `(cd ${main}/backend/control-plane && pnpm install && pnpm build)`,
    `(cd ${main}/frontend/next-js && pnpm install && pnpm build)（next-js は control-plane の dist を読むので、この順）`,
    "同じコマンドを実行し直す",
  ];
}

/** 3. 監視アプリの主体（IAM ユーザーと管理ポリシー） */
async function principalProblem(ctx) {
  const user = await awsJson(ctx, ["iam", "get-user", "--user-name", IAM_USER]);
  if (!user) return `IAM ユーザー ${IAM_USER} が無い`;
  const attached = (await awsJson(ctx, ["iam", "list-attached-user-policies", "--user-name", IAM_USER]))?.AttachedPolicies ?? [];
  if (!attached.some((p) => p.PolicyName === POLICY)) return `IAM ユーザー ${IAM_USER} に管理ポリシー ${POLICY} が付いていない`;
  const others = attached.filter((p) => p.PolicyName !== POLICY);
  if (others.length) return `IAM ユーザー ${IAM_USER} に ${POLICY} 以外のポリシー（${others.map((p) => p.PolicyName).join("・")}）が付いている。監視アプリの主体には ${POLICY} だけを付ける`;
  return null;
}

/** 4. 資格情報ファイルと、そのキーの主体。返すのは問題の文（無ければ null） */
async function credentialsProblem(ctx, file) {
  if (!existsSync(file)) return `資格情報ファイル ${file} が無い`;
  if ((statSync(file).mode & 0o077) !== 0) return `資格情報ファイル ${file} がほかのユーザーにも読める（chmod 600）`;
  if (!readFileSync(file, "utf8").includes(`[${IAM_USER}]`)) return `資格情報ファイル ${file} に節 [${IAM_USER}] が無い`;
  let arn;
  try {
    // このプロセスの AWS_*（管理者のプロファイル・キー）を引き継がない。監視アプリと同じ 2 つの変数だけでキーを解決させる
    const env = { PATH: process.env.PATH, HOME: homedir(), AWS_SHARED_CREDENTIALS_FILE: file, AWS_PROFILE: IAM_USER, AWS_CONFIG_FILE: join(homedir(), ".config/comegin/control-plane/no-aws-config"), AWS_REGION: REGION };
    arn = JSON.parse(await ctx.run("aws", ["sts", "get-caller-identity", "--output", "json"], { env, inheritEnv: false, timeoutMs: 30_000 })).Arn;
  } catch (e) {
    return `資格情報ファイル ${file} のキーで認証できない（${e.message.split("\n").at(-1)}）。キーを止めた・消した・写し間違えた可能性がある`;
  }
  if (!String(arn).endsWith(`:user/${IAM_USER}`)) return `資格情報ファイル ${file} のキーが ${IAM_USER} のものではない（${arn}）。監視アプリにほかの主体のキーを渡さない`;
  return null;
}

function principalSteps(problem, file) {
  return [
    `いまの状態: ${problem}`,
    `人が自分の端末で、管理者のプロファイルで行う（Claude Code の実行環境では行わない）: IAM ユーザー ${IAM_USER} を作り、管理ポリシー ${POLICY} だけを付け、アクセスキーを ${file} に直接書く（画面に出さない。umask 077）。コマンドは cloud/README.md の 4.5.2`,
    "キーを ~/.aws/credentials や作業ツリーの中に置かない（管理者のキーと混ざる・エージェントが作業ツリーを cwd にして動くため）",
    `別の場所に置いたなら、prod.conf に CONTROL_AWS_CREDENTIALS_FILE=<絶対パス> を書く`,
    "同じコマンドを実行し直す",
  ];
}

/** 作業ツリーの今の監視アプリ（開発のモジュールが書いた .env）から引き継ぐ値。Google のクライアントと開く URL と許可リスト */
function inherited(ctx) {
  const env = ctx.readEnvFile(join(ctx.conf.CONTROL_WORKTREE || ctx.REPO, "frontend/next-js/.env"));
  return { GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET, BETTER_AUTH_URL: env.BETTER_AUTH_URL, CONTROL_ADMIN_EMAILS: env.CONTROL_ADMIN_EMAILS };
}

async function repositoryFromOrigin(ctx) {
  try {
    const url = await git(ctx, ["-C", ctx.REPO, "remote", "get-url", "origin"]);
    return url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1];
  } catch {
    return undefined;
  }
}

/** 5. .env に書く値。足りないものは missing に入れる（値は返すが表示しない） */
async function prodValues(ctx, main, file) {
  const missing = [];
  const req = (key, hint) => {
    const v = ctx.conf[key];
    if (!v) missing.push(`${key}（${hint}）`);
    return v;
  };
  const prev = inherited(ctx);
  const googleId = ctx.conf.CONTROL_GOOGLE_CLIENT_ID || prev.GOOGLE_CLIENT_ID;
  const googleSecret = ctx.conf.CONTROL_GOOGLE_CLIENT_SECRET || prev.GOOGLE_CLIENT_SECRET;
  if (!googleId || !googleSecret) missing.push("CONTROL_GOOGLE_CLIENT_ID・CONTROL_GOOGLE_CLIENT_SECRET（監視アプリの Google ログイン。setup/manual-steps.md の 7.2。今の監視アプリの .env にも無い）");
  const agentUserId = ctx.state.get("CHATWOOT_AGENT_USER_ID");
  if (!agentUserId) missing.push("状態の CHATWOOT_AGENT_USER_ID（段階 apps の chatwoot-prod が本番のエージェント専用ユーザーを確かめたときに置く。先に node setup/setup.mjs --target prod --only chatwoot-prod）");
  const stack = await requireMainStack(ctx);
  const bucket = outputOf(stack, "RunLogBucketName");
  if (!bucket) missing.push(`スタック ${STACK} の出力 RunLogBucketName（E-15 の写しのバケット）`);

  const values = {
    BETTER_AUTH_URL: String(ctx.conf.CONTROL_PUBLIC_URL || prev.BETTER_AUTH_URL || LOCAL_URL).replace(/\/+$/, ""),
    GOOGLE_CLIENT_ID: googleId,
    GOOGLE_CLIENT_SECRET: googleSecret,
    CONTROL_ADMIN_EMAILS: ctx.conf.CONTROL_ADMIN_EMAILS || prev.CONTROL_ADMIN_EMAILS || req("ADMIN_EMAIL", "ログインを許すメール。CONTROL_ADMIN_EMAILS でもよい"),
    CONTROL_MAIN_CHECKOUT: main,
    CONTROL_WORKTREE: ctx.conf.CONTROL_WORKTREE || ctx.REPO,
    CONTROL_SCHEDULER_ENABLED: "true",
    ANTHROPIC_API_KEY: req("ANTHROPIC_API_KEY", "エージェントの起動に使う API キー。費用はここに付く。setup/manual-steps.md の 7.3"),
    SITE_URL: req("PUBLIC_SITE_URL", "本番の公開サイトの URL。weekly-lighthouse の計測対象"),
    AWS_REGION: REGION,
    AWS_PROFILE: IAM_USER,
    AWS_SHARED_CREDENTIALS_FILE: file,
    RUNLOG_BUCKET: bucket,
    HEARTBEAT_NAMESPACE: "ComeGin/Onprem",
    MISWRITE_CHATWOOT_BASE_URL: String(ctx.conf.CHATWOOT_BASE_URL || DEFAULT_CHATWOOT).replace(/\/+$/, ""),
    MISWRITE_CHATWOOT_ACCOUNT_ID: req("CHATWOOT_ACCOUNT_ID", "本番の Chatwoot のアカウント ID。P7"),
    MISWRITE_CHATWOOT_API_TOKEN: req("CHATWOOT_AGENT_TOKEN", "本番の Chatwoot のエージェント専用ユーザーのトークン。P7"),
    MISWRITE_AGENT_USER_ID: agentUserId ? String(agentUserId) : undefined,
  };
  for (const k of ["CONTROL_DATA_DIR", "CONTROL_AGENT_HOME", "GOOGLE_HOSTED_DOMAIN", "CONTROL_N8N_EXPORT_URL", "CONTROL_N8N_EXPORT_API_KEY"]) if (ctx.conf[k]) values[k] = ctx.conf[k];
  // I-13 の起票（GitHub）。1 つでも書いたら全部要る。リポジトリは origin から補う
  const github = ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "GITHUB_BASE_BRANCH", "I13_ISSUE_NUMBER", "I13_REVIEWER"];
  if (github.some((k) => ctx.conf[k])) {
    for (const k of github) if (ctx.conf[k]) values[k] = ctx.conf[k];
    values.GITHUB_REPOSITORY ??= await repositoryFromOrigin(ctx);
  }
  const groupKeys = GROUPS["I-13 の起票"];
  const set = groupKeys.filter((k) => values[k]);
  if (set.length && set.length < groupKeys.length) missing.push(`${groupKeys.filter((k) => !values[k]).join("・")}（I-13 の起票。1 つでも書いたら 4 つとも要る。fine-grained PAT は Contents と Pull requests を Read and write）`);
  return { values, missing };
}

/** 6. systemd のユニットの状態。起動した時刻（ミリ秒）は MainPID の経過時間から */
async function unitState(ctx) {
  const show = async (prop) => {
    try {
      return (await ctx.run("systemctl", ["show", "-p", prop, "--value", UNIT], { timeoutMs: 10_000 })).trim();
    } catch {
      return "";
    }
  };
  const load = await show("LoadState");
  if (load !== "loaded") return { installed: false };
  const active = (await show("ActiveState")) === "active";
  const dir = await show("WorkingDirectory");
  let startedAt = null;
  const pid = await show("MainPID");
  if (active && pid && pid !== "0") {
    try {
      const secs = Number((await ctx.run("ps", ["-o", "etimes=", "-p", pid], { timeoutMs: 10_000 })).trim());
      if (Number.isFinite(secs)) startedAt = Date.now() - secs * 1000;
    } catch {
      /* 読めなければ時刻の比較を飛ばす */
    }
  }
  return { installed: true, active, dir, startedAt };
}

function unitSteps(main, why) {
  const dir = appDirOf(main);
  return [
    `いまの状態: ${why}`,
    `onprem/systemd/comegin-control.service の User・WorkingDirectory（${dir}）・Environment の PATH（node と pnpm の場所。command -v node pnpm）を書き換える`,
    "人が自分の端末で置く（/etc への書き込み。Claude Code では行わない）: sudo install -m 644 onprem/systemd/comegin-control.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now comegin-control.service",
    "作業ツリーで監視アプリの pnpm dev を動かしているなら、先に止める（どちらも 127.0.0.1:3200 を使う）",
    `起動のログ: journalctl -u ${UNIT} -n 50（「開始 scheduler=on heartbeat=on」が出ること。手順は ${MANUAL}）`,
    "同じコマンドを実行し直す",
  ];
}

/** 定期実行の定義（チェックアウトの ops/schedules）のうち enabled: true のもの */
function enabledSchedules(main) {
  const dir = join(main, "ops/schedules");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .filter((f) => /^enabled:\s*true\s*$/m.test(readFileSync(join(dir, f), "utf8")))
    .map((f) => f.replace(/\.yaml$/, ""));
}

/** 8. 警告（止めない） */
async function operateWarnings(ctx, main) {
  const warnings = [];
  try {
    const alarm = (await awsJson(ctx, ["cloudwatch", "describe-alarms", "--region", REGION, "--alarm-names", HEARTBEAT_ALARM]))?.MetricAlarms?.[0];
    if (!alarm) warnings.push(`アラーム ${HEARTBEAT_ALARM} が無い（スタックを確かめる）`);
    else if (alarm.StateValue !== "OK") warnings.push(`アラーム ${HEARTBEAT_ALARM} が ${alarm.StateValue}（${alarm.StateUpdatedTimestamp} から）。起動から 15 分ほどで OK に戻る。戻らなければ journalctl -u ${UNIT} の heartbeat の行と、資格情報ファイル・RUNLOG_BUCKET・AWS_REGION を確かめる（cloud/README.md の 4.13）`);
  } catch (e) {
    warnings.push(`アラーム ${HEARTBEAT_ALARM} を確かめられない（${e.message.split("\n")[0]}）`);
  }
  const enabled = enabledSchedules(main);
  if (enabled.includes("heartbeat")) warnings.push("ops/schedules/heartbeat.yaml が enabled: true。ハートビートは定義に関係なく起動時から送られるので、二重に送り、E-15 に 1 日 288 件の記録が増える。false に戻す PR を出す");
  if (!enabled.length) warnings.push(`有効な定期実行が 0 本（ops/schedules/*.yaml はすべて enabled: false）。改善ループはまだ動かない。人が PR で段階的に enabled: true にする（${MANUAL} の手順 5）`);
  return { warnings, enabled };
}

// ---------------------------------------------------------------------------
// 契約
// ---------------------------------------------------------------------------

export async function check(ctx) {
  const notes = [];
  let ok = true;
  const bad = (msg) => {
    notes.push(msg);
    ok = false;
  };
  const main = checkoutOf(ctx);
  const cp = await checkoutProblem(ctx, main);
  if (cp) return { ok: false, notes: [cp] };
  notes.push(`チェックアウト ${main} は origin/main と同じ`);
  for (const p of await buildProblems(ctx, main)) bad(p);
  const pp = await principalProblem(ctx).catch((e) => `IAM を確かめられない（${e.message.split("\n")[0]}）`);
  if (pp) bad(pp);
  else notes.push(`IAM ユーザー ${IAM_USER}（${POLICY} だけ）がある`);
  const file = credentialsOf(ctx);
  const cr = await credentialsProblem(ctx, file);
  if (cr) bad(cr);
  else notes.push(`資格情報ファイルのキーは ${IAM_USER} のもの`);

  const envPath = join(appDirOf(main), ".env");
  if (!existsSync(envPath)) bad(`チェックアウトの .env（${envPath}）がまだ無い`);
  else {
    const env = ctx.readEnvFile(envPath);
    if (env.CONTROL_SCHEDULER_ENABLED !== "true") bad("チェックアウトの .env の CONTROL_SCHEDULER_ENABLED が true ではない");
    if (/127\.0\.0\.1:3100|localhost:3100/.test(env.MISWRITE_CHATWOOT_BASE_URL ?? "")) bad("MISWRITE_CHATWOOT_BASE_URL が開発の Chatwoot のまま");
    if (env.AWS_PROFILE !== IAM_USER || !env.RUNLOG_BUCKET) bad("チェックアウトの .env の AWS の設定（AWS_PROFILE・RUNLOG_BUCKET）が本番の値ではない");
  }
  const unit = await unitState(ctx);
  if (!unit.installed) bad(`systemd のユニット ${UNIT} が無い`);
  else if (!unit.active) bad(`systemd のユニット ${UNIT} が動いていない`);
  else if (unit.dir !== appDirOf(main)) bad(`ユニット ${UNIT} の WorkingDirectory が ${unit.dir}（期待: ${appDirOf(main)}）`);
  else if (existsSync(envPath) && unit.startedAt && statSync(envPath).mtimeMs > unit.startedAt) bad(`.env を書いた後に ${UNIT} を起動し直していない`);
  else notes.push(`ユニット ${UNIT} は動いている`);
  const state = await probe(ctx).catch((e) => `error:${e.message}`);
  if (state === "up") notes.push(`監視アプリは応答している（${LOCAL_URL}）`);
  else bad(state === "down" ? `監視アプリが応答しない（${LOCAL_URL}）` : state.slice(6));

  const { warnings, enabled } = await operateWarnings(ctx, main);
  notes.push(`有効な定期実行: ${enabled.length ? enabled.join("・") : "なし"}`);
  for (const w of warnings) notes.push(`! ${w}`);
  return { ok, notes };
}

export async function apply(ctx) {
  // 1. チェックアウト
  const main = checkoutOf(ctx);
  const cp = await checkoutProblem(ctx, main);
  if (cp) {
    ctx.manual("checkout", "承認済みの main のチェックアウトを origin/main に合わせる", [
      `いまの状態: ${cp}`,
      "人が自分の端末で: git -C <作業ツリー> fetch origin && git -C <チェックアウト> checkout --detach origin/main（setup は git を書き換えない。setup/manual-steps.md の 6 節）",
      "prod.conf に CONTROL_MAIN_CHECKOUT=<チェックアウトの絶対パス> を書く（空なら SITE_BUILD_CHECKOUT を使う）",
      "チェックアウトを動かしたら、ビルドもし直す（次の手順で止まる）",
      "同じコマンドを実行し直す",
    ]);
  }
  ctx.log(`チェックアウト ${main} は origin/main と同じ`);

  // 2. ビルド
  const builds = await buildProblems(ctx, main);
  if (builds.length) ctx.manual("build", "チェックアウトで control-plane と監視アプリをビルドする", buildSteps(main, builds));
  ctx.log("control-plane と監視アプリのビルドは、チェックアウトを動かした後のもの");

  // 3・4. 監視アプリの主体とキー
  const file = credentialsOf(ctx);
  const problem = (await principalProblem(ctx)) ?? (await credentialsProblem(ctx, file));
  if (problem) ctx.manual("principal", "監視アプリの主体（ハートビートと E-15 の写しの送り手）を作り、キーを資格情報ファイルに書く", principalSteps(problem, file));
  ctx.log(`監視アプリの主体 ${IAM_USER}（${POLICY} だけ）と、資格情報ファイルのキーを確かめた（キーは表示しない）`);

  // 5. 本番の値 → チェックアウトの .env
  const { values, missing } = await prodValues(ctx, main, file);
  if (missing.length) {
    ctx.manual("prod-values", "監視アプリの本番の値を prod.conf に書く", [
      ...missing.map((m) => `足りない: ${m}`),
      "~/.config/comegin/setup/prod.conf に書く（chmod 600。値は画面に出さない）",
      "同じコマンドを実行し直す",
    ]);
  }
  validateGroups(values);
  const dir = appDirOf(main);
  const envPath = join(dir, ".env");
  // BETTER_AUTH_SECRET の生成と .env.example からの作成は、開発と同じ dev/init-env.sh（冪等。値は表示しない）
  await ctx.run("bash", ["dev/init-env.sh"], { cwd: dir });
  // prod.conf と状態が正本。開発の値が写されていても上書きする（BETTER_AUTH_SECRET は触らない）
  const changed = ctx.writeEnvFile(envPath, values, { template: join(dir, ".env.example"), onlyIfEmpty: false });
  ctx.log(`${envPath} を本番の値にした（600。今回書いたキー: ${changed.join("・") || "なし"}）`);
  const env = ctx.readEnvFile(envPath);
  if (!env.GITHUB_TOKEN) ctx.warn("GITHUB_TOKEN などが無い。I-13 の起票（daily-i13-file）は skipped になる（改善の提案が PR にならない）");
  if (!env.CONTROL_N8N_EXPORT_API_KEY) ctx.log("n8n の書き出し（daily-n8n-export）は未設定（キーのスコープを人が判断してから CONTROL_N8N_EXPORT_* を prod.conf に書く）");

  // 6. systemd
  const unit = await unitState(ctx);
  if (!unit.installed || !unit.active) ctx.manual("systemd", `監視アプリを systemd で常駐させる（${UNIT}）`, unitSteps(main, unit.installed ? `${UNIT} が動いていない` : `${UNIT} が無い`));
  if (unit.dir !== dir) ctx.manual("systemd-dir", `${UNIT} をチェックアウトで動かす`, unitSteps(main, `WorkingDirectory が ${unit.dir || "空"}（期待: ${dir}）`));
  if (unit.startedAt && statSync(envPath).mtimeMs > unit.startedAt) {
    ctx.manual("restart", `${UNIT} を起動し直す（.env を書き換えたため。環境変数は起動したときに読まれる）`, [
      `人が自分の端末で: sudo systemctl restart ${UNIT}`,
      `journalctl -u ${UNIT} -n 50 に「開始 scheduler=on heartbeat=on」が出ること（heartbeat=off なら AWS の値が読めていない）`,
      "同じコマンドを実行し直す",
    ]);
  }
  ctx.log(`${UNIT} はチェックアウトで動いていて、.env を書いた後に起動している`);

  // 7. 応答と Google ログイン
  if ((await probe(ctx)) === "down") ctx.manual("start", `監視アプリが応答しない（${LOCAL_URL}）`, unitSteps(main, `${UNIT} は active だが 3200 が応答しない（journalctl -u ${UNIT} で起動の失敗を見る。control-plane の設定不正は変数名だけが出る）`));
  const publicUrl = publicUrlOf(env);
  const domain = env.GOOGLE_HOSTED_DOMAIN || DEFAULT_HOSTED_DOMAIN;
  const google = await verifyGoogle(ctx, publicUrl, domain);
  if (!google.ok) throw new Error(`監視アプリの Google ログインを始められない: ${google.reason}`);
  ctx.log(`Google ログインを始められる（リダイレクト URI ${google.redirect}。Google のクライアントにこの URI が登録されていること）`);

  // 8. 警告
  const { warnings, enabled } = await operateWarnings(ctx, main);
  for (const w of warnings) ctx.warn(w);
  ctx.log(`有効な定期実行: ${enabled.length ? enabled.join("・") : "なし"}。ログイン: ${publicUrl}/login`);
}
