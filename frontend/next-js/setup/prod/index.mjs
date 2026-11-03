// 監視アプリ（next-js ＋ control-plane。改善ループの起動元）を本番の値で常駐させる。setup/lib/core.mjs の契約に従う。--target prod の段階 operate だけ。
// 手順の正本は onprem/README.md の「監視アプリ（改善ループ）を本番で動かす」（setup/00-setup-overview.md の P14）。
//
// 監視アプリは開発と本番の区別が無い 1 つのインスタンスで（TA-07 の 2 節）、エージェントが書き込む先が本番（*-prod の MCP）なので、
// このモジュールが承認済みの main のチェックアウトの frontend/next-js/.env を本番の値で書く。開発のモジュール（../index.mjs）は作業ツリーの .env を扱い、
// こちらとは別のファイル（ADR-18。作業ツリーの未承認の変更を管制のコードに効かせないため、本番はチェックアウトから動かす）。
//
// 行うこと（止まるのは 1〜6 と 4b。どれも人の作業を案内して止まる）:
//   1. チェックアウトが origin/main と同じコミットか（git の状態は人が変える。setup は git を書き換えない）
//   2. control-plane（dist/）と next-js（.next/）のビルドが、チェックアウトを動かした後のものか（ビルドは人が行う）
//   3. 監視アプリの主体: IAM ユーザー comegin-prod-control-plane と管理ポリシー comegin-prod-control-plane（作成とキーの発行は人。cloud/README.md の 4.5.2）
//   4. 監視アプリ専用の資格情報ファイル（600）と、そのキーが 3 のユーザーのものであること（sts get-caller-identity。読み取りだけ）
//   4b. 「設定の状況」(/setup-status) の読み取り専用の主体: IAM ユーザー comegin-prod-status-reader（管理ポリシー comegin-prod-status-reader だけ）と、
//       そのキーの資格情報ファイル（600）、参照専用の GitHub トークンのファイル（600。fine-grained PAT〈github_pat_〉でリポジトリの読み取りが 200・X-OAuth-Scopes なし。読み取り専用かは機械で確かめられない）。
//       どちらも作成・発行は人（cloud/README.md の 4.5.3）。ファイルの置き場は ~/.config/comegin/status-reader/
//   5. 本番の値（prod.conf と状態）がそろっていること → チェックアウトの .env に書く（600。値は表示しない。設定の状況の 6 変数も）
//   6. systemd のユニット comegin-control が、このチェックアウトで動いていて、.env を書いた後に起動していること（/etc は人が書く）
//   7. 127.0.0.1:3200 が応答し、Google ログインを始められること（開発のモジュールと同じ確かめ方）
//   8. 警告だけ: ハートビートのアラーム・有効な定期実行の数・heartbeat.yaml の誤った有効化
//
// AWS は読み取りだけ（cloudformation describe-stacks・iam get-user・list-attached-user-policies・sts get-caller-identity・
// cloudwatch describe-alarms）。AWS の認証は環境（管理者のプロファイル）に任せ、4 と 4b の確認だけは資格情報ファイルのキーで行う
// （このプロセスの AWS の環境変数を引き継がない子プロセスで。管理者のキーが優先されて誤って通るのを防ぐ）。
// GitHub は GET /repos/<リポジトリ> を読むだけ（トークンの値は表示しない。伏せ字の登録をしてから使う）。
//
// 設定のキー（~/.config/comegin/setup/prod.conf）:
//   必須: CONTROL_MAIN_CHECKOUT（空なら SITE_BUILD_CHECKOUT）・ANTHROPIC_API_KEY・CHATWOOT_ACCOUNT_ID・CHATWOOT_AGENT_TOKEN（P7）
//   任意: CONTROL_WORKTREE（既定は作業ツリー）・CONTROL_DATA_DIR・CONTROL_AGENT_HOME・
//         CONTROL_PUBLIC_URL（ブラウザで開く URL。既定 http://127.0.0.1:3200。作業ツリーの .env からは引き継がない。手元以外なら警告）・
//         CONTROL_ADMIN_EMAILS・CONTROL_GOOGLE_CLIENT_ID/SECRET（無ければ、今の監視アプリ〈作業ツリーの .env〉の値を引き継ぐ）・
//         CONTROL_AWS_CREDENTIALS_FILE（既定 ~/.config/comegin/control-plane/aws-credentials）・CHATWOOT_BASE_URL・
//         CONTROL_STATUS_AWS_CREDENTIALS_FILE（既定 ~/.config/comegin/status-reader/aws-credentials）・
//         CONTROL_STATUS_GITHUB_TOKEN_FILE（既定 ~/.config/comegin/status-reader/github-token）・
//         GITHUB_TOKEN・GITHUB_REPOSITORY（既定は origin の URL から）・GITHUB_BASE_BRANCH・I13_ISSUE_NUMBER・I13_REVIEWER・
//         CONTROL_N8N_EXPORT_URL・CONTROL_N8N_EXPORT_API_KEY（キーのスコープを人が判断してから）
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REGION, STACK, awsJson, outputOf, requireMainStack } from "../../../../cloud/setup/aws.mjs";
import { registerSecret } from "../../../../setup/lib/core.mjs";
import { DEFAULT_HOSTED_DOMAIN, GROUPS, LOCAL_URL, probe, publicUrlOf, validateGroups, verifyGoogle } from "../index.mjs";

export const meta = { id: "next-js-prod", title: "監視アプリ（本番。改善ループの常駐）", targets: ["prod"], phases: ["operate"], after: [] };

const IAM_USER = "comegin-prod-control-plane";
const POLICY = "comegin-prod-control-plane";
const UNIT = "comegin-control";
const HEARTBEAT_ALARM = "comegin-prod-onprem-heartbeat";
const DEFAULT_CREDENTIALS = join(homedir(), ".config/comegin/control-plane/aws-credentials");
const DEFAULT_CHATWOOT = "https://chat.comegin.com";
// 設定の状況（/setup-status）の読み取り専用の主体（cloud/README.md の 4.5.3）
const STATUS_USER = "comegin-prod-status-reader";
const STATUS_POLICY = "comegin-prod-status-reader";
const STATUS_PROFILE = "default";
const DEFAULT_STATUS_CREDENTIALS = join(homedir(), ".config/comegin/status-reader/aws-credentials");
const DEFAULT_STATUS_GITHUB_TOKEN = join(homedir(), ".config/comegin/status-reader/github-token");
const DEFAULT_REPOSITORY = "ComeGin/systematization-of-the-business-foundation";
const MANUAL = "onprem/README.md の「監視アプリ（改善ループ）を本番で動かす」";

const checkoutOf = (ctx) => ctx.conf.CONTROL_MAIN_CHECKOUT || ctx.conf.SITE_BUILD_CHECKOUT;
const appDirOf = (main) => join(main, "frontend/next-js");
const credentialsOf = (ctx) => ctx.conf.CONTROL_AWS_CREDENTIALS_FILE || DEFAULT_CREDENTIALS;
const statusCredentialsOf = (ctx) => ctx.conf.CONTROL_STATUS_AWS_CREDENTIALS_FILE || DEFAULT_STATUS_CREDENTIALS;
const statusGithubTokenOf = (ctx) => ctx.conf.CONTROL_STATUS_GITHUB_TOKEN_FILE || DEFAULT_STATUS_GITHUB_TOKEN;
const statusRepositoryOf = (ctx) => ctx.conf.GITHUB_REPOSITORY || DEFAULT_REPOSITORY;
const OPEN_MANUAL = "onprem/README.md の「開く（監視アプリ）」";

/**
 * ブラウザで開く URL（= BETTER_AUTH_URL）。prod.conf の CONTROL_PUBLIC_URL だけを見て、無ければ 127.0.0.1:3200。
 * 作業ツリー（開発）の .env からは引き継がない。2026-11-03 に、開発の ngrok の URL が本番のチェックアウトに写り、
 * 127.0.0.1:3200 で開くと Invalid origin（Origin が BETTER_AUTH_URL と違う）、ngrok はトンネルが無く 404 で、どちらからも入れなかった。
 */
const publicUrlConfOf = (ctx) => String(ctx.conf.CONTROL_PUBLIC_URL || LOCAL_URL).replace(/\/+$/, "");

/** URL の形の問題（http(s) の URL でない）。問題が無ければ undefined */
function publicUrlProblem(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return `CONTROL_PUBLIC_URL（${url}）が http(s) の URL ではない`;
    if (u.pathname !== "/" || u.search || u.hash) return `CONTROL_PUBLIC_URL（${url}）にパスやクエリが付いている（オリジンだけを書く。例: ${LOCAL_URL}）`;
  } catch {
    return `CONTROL_PUBLIC_URL（${url}）が URL として読めない（例: ${LOCAL_URL}）`;
  }
  return undefined;
}

/** 手元（ループバック）以外で開く URL なら警告文を返す。本番は ngrok などで外に出さない（ADR-23 の見直しの条件〈定期実行の有効化〉に当たる） */
function exposureWarning(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined; // 形の問題は publicUrlProblem が扱う
  }
  if (host === "127.0.0.1" || host === "localhost") return undefined;
  return `BETTER_AUTH_URL が手元以外（${url}）。本番の監視アプリは本番の資格情報を持ち、エージェントを起動できるので、ngrok などで外に出さない。${LOCAL_URL} で開き、別の端末からは ssh -L 3200:127.0.0.1:3200 で入る（${OPEN_MANUAL}）`;
}

async function git(ctx, args) {
  return (await ctx.run("git", args, { timeoutMs: 30_000 })).trim();
}

/**
 * 1. チェックアウトが origin/main と同じコミットか。origin/main は作業ツリー（ctx.WORKTREE）のリモート追跡ブランチ
 * （取り込みは人が git fetch で行う。チェックアウトと作業ツリーは .git を共有するので、どちらで fetch しても同じ）。
 * コードをチェックアウトから動かすとき（監視アプリが --check する）は REPO がチェックアウト自身なので、作業ツリーとの比較は ctx.WORKTREE で行う
 */
async function checkoutProblem(ctx, main) {
  if (!main) return "CONTROL_MAIN_CHECKOUT（承認済みの main のチェックアウトの絶対パス）が prod.conf に無い";
  if (!main.startsWith("/") || !existsSync(join(main, "frontend/next-js/package.json"))) return `CONTROL_MAIN_CHECKOUT（${main}）に frontend/next-js が無い（絶対パスか、正しいチェックアウトかを確かめる）`;
  if (realpathSync(main) === realpathSync(ctx.conf.CONTROL_WORKTREE || ctx.WORKTREE)) return "CONTROL_MAIN_CHECKOUT が作業ツリーと同じ場所（ADR-18。本番は承認済みの main のチェックアウトから動かす）";
  const head = await git(ctx, ["-C", main, "rev-parse", "HEAD"]);
  const origin = await git(ctx, ["-C", ctx.WORKTREE, "rev-parse", "origin/main"]);
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

/**
 * 4b-1. 設定の状況の主体（IAM ユーザー comegin-prod-status-reader・管理ポリシー・資格情報ファイルのキー）。返すのは問題の文（無ければ null）。
 * IAM は環境（管理者のプロファイル。監視アプリが --check するときは状況の確認の主体）で読み、キーの主体は資格情報ファイルだけで解決した子プロセスで確かめる。
 * IAM を読めなかったときは例外（呼び出し側が「確かめられなかった」にする）
 */
export async function statusPrincipalProblem(ctx, file) {
  const user = await awsJson(ctx, ["iam", "get-user", "--user-name", STATUS_USER]);
  if (!user) return `IAM ユーザー ${STATUS_USER} が無い`;
  const attached = (await awsJson(ctx, ["iam", "list-attached-user-policies", "--user-name", STATUS_USER]))?.AttachedPolicies ?? [];
  if (!attached.some((p) => p.PolicyName === STATUS_POLICY)) return `IAM ユーザー ${STATUS_USER} に管理ポリシー ${STATUS_POLICY} が付いていない`;
  const others = attached.filter((p) => p.PolicyName !== STATUS_POLICY);
  if (others.length) return `IAM ユーザー ${STATUS_USER} に ${STATUS_POLICY} 以外のポリシー（${others.map((p) => p.PolicyName).join("・")}）が付いている。設定の状況の主体には ${STATUS_POLICY} だけを付ける`;
  if (!existsSync(file)) return `資格情報ファイル ${file} が無い`;
  if ((statSync(file).mode & 0o077) !== 0) return `資格情報ファイル ${file} がほかのユーザーにも読める（chmod 600）`;
  if (!readFileSync(file, "utf8").includes(`[${STATUS_PROFILE}]`)) return `資格情報ファイル ${file} に節 [${STATUS_PROFILE}] が無い`;
  let arn;
  try {
    // このプロセスの AWS_*（管理者のプロファイル・キー）を引き継がない。監視アプリの子プロセスと同じ変数だけでキーを解決させる
    const env = { PATH: process.env.PATH, HOME: homedir(), AWS_SHARED_CREDENTIALS_FILE: file, AWS_PROFILE: STATUS_PROFILE, AWS_CONFIG_FILE: "/dev/null", AWS_REGION: REGION };
    arn = JSON.parse(await ctx.run("aws", ["sts", "get-caller-identity", "--output", "json"], { env, inheritEnv: false, timeoutMs: 30_000 })).Arn;
  } catch (e) {
    return `資格情報ファイル ${file} のキーで認証できない（${e.message.split("\n").at(-1)}）。キーを止めた・消した・写し間違えた可能性がある`;
  }
  if (!String(arn).endsWith(`:user/${STATUS_USER}`)) return `資格情報ファイル ${file} のキーが ${STATUS_USER} のものではない（${arn}）。設定の状況にほかの主体のキーを渡さない`;
  return null;
}

function statusPrincipalSteps(problem, file) {
  return [
    `いまの状態: ${problem}`,
    `人が自分の端末で、管理者のプロファイルで行う（Claude Code の実行環境では行わない）: IAM ユーザー ${STATUS_USER} を作り、管理ポリシー ${STATUS_POLICY} だけを付け、アクセスキーを ${file}（プロファイル名 [${STATUS_PROFILE}]）に直接書く（画面に出さない。umask 077）。管理ポリシーは先に sam deploy で作る。コマンドは cloud/README.md の 4.5.3`,
    "キーを ~/.aws/credentials や作業ツリーの中に置かない（管理者のキーと混ざる・エージェントが作業ツリーを cwd にして動くため）。監視アプリの主体（comegin-prod-control-plane）とは別のユーザーにする",
    "別の場所に置いたなら、prod.conf に CONTROL_STATUS_AWS_CREDENTIALS_FILE=<絶対パス> を書く",
    "同じコマンドを実行し直す",
  ];
}

/**
 * 4b-2. 設定の状況用の GitHub のトークン。返すのは問題の文（無ければ null）。トークンの値は表示しない。
 * 確かめること: ファイルが在る・600・空でない／fine-grained PAT（github_pat_ で始まる。classic の ghp_・gho_ などは不可）／
 * GET /repos/<リポジトリ> が 200／応答に X-OAuth-Scopes が付かない（classic のトークンは付く）。
 * **読み取り専用（Contents と Pull requests が Read-only）かは機械で確かめられない**。GET /repos の permissions は
 * トークンの範囲ではなく認証ユーザーの役割（所有者なら常に push=true）なので使わない。人が作るときに選ぶ（onprem の「設定の状況を有効にする」）。
 * GitHub に届かない・5xx のときは例外（呼び出し側が「確かめられなかった」にする）
 */
export async function statusGithubProblem(ctx, file) {
  if (!existsSync(file)) return `GitHub のトークンのファイル ${file} が無い`;
  if ((statSync(file).mode & 0o077) !== 0) return `GitHub のトークンのファイル ${file} がほかのユーザーにも読める（chmod 600）`;
  const token = readFileSync(file, "utf8").trim();
  if (!token) return `GitHub のトークンのファイル ${file} が空`;
  registerSecret(token);
  const repository = statusRepositoryOf(ctx);
  if (!token.startsWith("github_pat_")) return `GitHub のトークンが fine-grained のものではない（github_pat_ で始まらない。classic や OAuth のトークンは権限をリポジトリに絞れない）。${repository} だけに絞り、Contents: Read-only と Pull requests: Read-only だけを付けた fine-grained personal access token を作り直す`;
  const res = await ctx.http("GitHub", `https://api.github.com/repos/${repository}`, {
    raw: true,
    headers: { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "comegin-setup" },
    timeoutMs: 30_000,
  });
  if (res.status === 401 || res.status === 403 || res.status === 404) return `GitHub のトークンでリポジトリ ${repository} を読めない（HTTP ${res.status}）。期限切れ・対象のリポジトリが違う・Contents の Read-only が無い可能性がある`;
  if (res.status !== 200) throw new Error(`GitHub: HTTP ${res.status}`);
  const scopes = res.headers?.get?.("x-oauth-scopes");
  if (scopes) return `GitHub の応答に X-OAuth-Scopes が付いている（classic のトークンの印）。${repository} だけに絞った fine-grained personal access token（Contents: Read-only と Pull requests: Read-only だけ）を作り直す`;
  return null;
}

/**
 * 4b-3. origin の名前が設定の状況のリポジトリと違うときの警告（止めない）。無ければ null。
 * 監視アプリは origin を GitHub の API で確かめ（改名前の名前なら転送先の full_name が一致する）、同じなら fetch するので動くが、
 * 毎回の起動で API を 1 回多く呼び、別のリポジトリなら fetch しない。origin を読めない・GitHub の URL でないときは何も言わない
 */
export async function statusOriginWarning(ctx) {
  let url;
  try {
    url = await git(ctx, ["-C", ctx.WORKTREE, "remote", "get-url", "origin"]);
  } catch {
    return null;
  }
  const origin = url.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/)?.[1];
  if (!origin) return null;
  const repository = statusRepositoryOf(ctx);
  if (origin.toLowerCase() === repository.toLowerCase()) return null;
  return `origin が ${origin} を指している（設定の状況のリポジトリは ${repository}）。改名前の名前なら監視アプリは GitHub の API で同じリポジトリと確かめてから fetch する（違うリポジトリなら fetch せず、公開サイトの再配信と n8n のずれが ? になる）。人が自分の端末で git -C <作業ツリー> remote set-url origin https://github.com/${repository}.git で直しておく（onprem/README.md の「設定の状況を有効にする」）`;
}

function statusGithubSteps(problem, file) {
  return [
    `いまの状態: ${problem}`,
    `人が自分の端末で行う: GitHub で fine-grained personal access token（github_pat_ で始まるもの）を作る（Repository access は ${DEFAULT_REPOSITORY} だけ、Repository permissions は Contents と Pull requests の **両方を Read-only**、ほかは付けない。Metadata は自動で Read）。**スクリプトは Read-only を選んだかを確かめられない**ので、人が選ぶ。有効期限を決めて、切れる前に作り直す日を控える`,
    `トークンを ${file} に 1 行で直接書く（画面に出さない・echo しない・履歴に残さない。umask 077 のうえで read -rs してから printf '%s' で書く。chmod 600）。手順は onprem/README.md の「設定の状況を有効にする」`,
    "I-13 の起票用の GITHUB_TOKEN（Read and write）とは別のトークンにする。別の場所に置いたなら、prod.conf に CONTROL_STATUS_GITHUB_TOKEN_FILE=<絶対パス> を書く",
    "同じコマンドを実行し直す",
  ];
}

/**
 * 作業ツリーの今の監視アプリ（開発のモジュールが書いた .env）から引き継ぐ値。Google のクライアントと許可リストだけ。
 * 開く URL（BETTER_AUTH_URL）は環境ごとに違う値なので引き継がない（publicUrlConfOf）
 */
function inherited(ctx) {
  const env = ctx.readEnvFile(join(ctx.conf.CONTROL_WORKTREE || ctx.WORKTREE, "frontend/next-js/.env"));
  return { GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET, CONTROL_ADMIN_EMAILS: env.CONTROL_ADMIN_EMAILS };
}

async function repositoryFromOrigin(ctx) {
  try {
    const url = await git(ctx, ["-C", ctx.WORKTREE, "remote", "get-url", "origin"]);
    return url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1];
  } catch {
    return undefined;
  }
}

/** 5. .env に書く値。足りないものは missing に入れる（値は返すが表示しない） */
export async function prodValues(ctx, main, file) {
  const missing = [];
  const req = (key, hint) => {
    const v = ctx.conf[key];
    if (!v) missing.push(`${key}（${hint}）`);
    return v;
  };
  const prev = inherited(ctx);
  const publicUrl = publicUrlConfOf(ctx);
  const urlProblem = publicUrlProblem(publicUrl);
  if (urlProblem) missing.push(`${urlProblem}。空にすれば ${LOCAL_URL}（${OPEN_MANUAL}）`);
  const googleId = ctx.conf.CONTROL_GOOGLE_CLIENT_ID || prev.GOOGLE_CLIENT_ID;
  const googleSecret = ctx.conf.CONTROL_GOOGLE_CLIENT_SECRET || prev.GOOGLE_CLIENT_SECRET;
  if (!googleId || !googleSecret) missing.push("CONTROL_GOOGLE_CLIENT_ID・CONTROL_GOOGLE_CLIENT_SECRET（監視アプリの Google ログイン。setup/manual-steps.md の 7.2。今の監視アプリの .env にも無い）");
  const agentUserId = ctx.state.get("CHATWOOT_AGENT_USER_ID");
  if (!agentUserId) missing.push("状態の CHATWOOT_AGENT_USER_ID（段階 apps の chatwoot-prod が本番のエージェント専用ユーザーを確かめたときに置く。先に node setup/setup.mjs --target prod --only chatwoot-prod）");
  const stack = await requireMainStack(ctx);
  const bucket = outputOf(stack, "RunLogBucketName");
  if (!bucket) missing.push(`スタック ${STACK} の出力 RunLogBucketName（E-15 の写しのバケット）`);
  const alertTopic = outputOf(stack, "OpsAlertTopicArn");
  if (!alertTopic) missing.push(`スタック ${STACK} の出力 OpsAlertTopicArn（設定の状況の知らせの送り先。cloud/README.md の 4.4）`);

  const values = {
    BETTER_AUTH_URL: publicUrl,
    GOOGLE_CLIENT_ID: googleId,
    GOOGLE_CLIENT_SECRET: googleSecret,
    CONTROL_ADMIN_EMAILS: ctx.conf.CONTROL_ADMIN_EMAILS || prev.CONTROL_ADMIN_EMAILS || req("ADMIN_EMAIL", "ログインを許すメール。CONTROL_ADMIN_EMAILS でもよい"),
    CONTROL_MAIN_CHECKOUT: main,
    CONTROL_WORKTREE: ctx.conf.CONTROL_WORKTREE || ctx.WORKTREE,
    CONTROL_SCHEDULER_ENABLED: "true",
    ANTHROPIC_API_KEY: req("ANTHROPIC_API_KEY", "エージェントの起動に使う API キー。費用はここに付く。setup/manual-steps.md の 7.3"),
    SITE_URL: req("PUBLIC_SITE_URL", "本番の公開サイトの URL。weekly-lighthouse の計測対象"),
    AWS_REGION: REGION,
    AWS_PROFILE: IAM_USER,
    AWS_SHARED_CREDENTIALS_FILE: file,
    RUNLOG_BUCKET: bucket,
    HEARTBEAT_NAMESPACE: "ComeGin/Onprem",
    // 設定の状況（/setup-status）。ファイルの中身は書かない（場所だけ）。リンクの根は開く URL と同じ
    CONTROL_SETUP_STATUS_ENABLED: "true",
    CONTROL_STATUS_AWS_CREDENTIALS_FILE: statusCredentialsOf(ctx),
    CONTROL_STATUS_AWS_PROFILE: STATUS_PROFILE,
    CONTROL_STATUS_GITHUB_TOKEN_FILE: statusGithubTokenOf(ctx),
    CONTROL_STATUS_ALERT_TOPIC_ARN: alertTopic,
    CONTROL_STATUS_LINK_BASE: publicUrl,
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

/**
 * 8. 警告（止めない）。warnings は人向けの文の全部（ハートビートのアラーム → 定期実行の順）。
 * alarm・schedules は監視アプリの項目用（alarm.unknown はアラームを読めなかったとき）
 */
async function operateWarnings(ctx, main) {
  const alarmWarnings = [];
  let alarmUnknown = false;
  try {
    const alarm = (await awsJson(ctx, ["cloudwatch", "describe-alarms", "--region", REGION, "--alarm-names", HEARTBEAT_ALARM]))?.MetricAlarms?.[0];
    if (!alarm) alarmWarnings.push(`アラーム ${HEARTBEAT_ALARM} が無い（スタックを確かめる）`);
    else if (alarm.StateValue !== "OK") alarmWarnings.push(`アラーム ${HEARTBEAT_ALARM} が ${alarm.StateValue}（${alarm.StateUpdatedTimestamp} から）。起動から 15 分ほどで OK に戻る。戻らなければ journalctl -u ${UNIT} の heartbeat の行と、資格情報ファイル・RUNLOG_BUCKET・AWS_REGION を確かめる（cloud/README.md の 4.13）`);
  } catch (e) {
    alarmWarnings.push(`アラーム ${HEARTBEAT_ALARM} を確かめられない（${e.message.split("\n")[0]}）`);
    alarmUnknown = true;
  }
  const warnings = [];
  const enabled = enabledSchedules(main);
  if (enabled.includes("heartbeat")) warnings.push("ops/schedules/heartbeat.yaml が enabled: true。ハートビートは定義に関係なく起動時から送られるので、二重に送り、E-15 に 1 日 288 件の記録が増える。false に戻す PR を出す");
  if (!enabled.length) warnings.push(`有効な定期実行が 0 本（ops/schedules/*.yaml はすべて enabled: false）。改善ループはまだ動かない。人が PR で段階的に enabled: true にする（${MANUAL} の手順 5）`);
  return { warnings: [...alarmWarnings, ...warnings], enabled, alarm: { warnings: alarmWarnings, unknown: alarmUnknown }, schedules: { warnings } };
}

// ---------------------------------------------------------------------------
// 契約
// ---------------------------------------------------------------------------

// 監視アプリの「設定の状況」が読む項目（key は next-js-prod.<名前>。すべて P14。stopId は apply が今そこで止まる id）
const STEP = "P14";
const ITEM_TITLES = {
  checkout: "チェックアウトが origin/main と同じコミット",
  build: "control-plane と監視アプリのビルドが、チェックアウトを動かした後のもの",
  principal: "監視アプリの主体（IAM ユーザー comegin-prod-control-plane と資格情報ファイルのキー）",
  "status-principal": "設定の状況の主体（IAM ユーザー comegin-prod-status-reader と資格情報ファイルのキー）",
  "status-github": "設定の状況用の GitHub のトークン（fine-grained PAT。読み取り専用かは人が確かめる）",
  "prod-values": "チェックアウトの環境変数ファイルが本番の値",
  systemd: "systemd のユニット comegin-control（チェックアウトで常駐）",
  respond: "監視アプリが 127.0.0.1:3200 で応答する",
  "heartbeat-alarm": "ハートビートのアラーム",
  "schedules-enabled": "有効な定期実行",
};

export async function check(ctx) {
  const notes = [];
  let ok = true;
  const bad = (msg) => {
    notes.push(msg);
    ok = false;
  };
  const items = [];
  const item = (name, level, evidence, stopId) =>
    items.push({ key: `next-js-prod.${name}`, step: STEP, level, title: ITEM_TITLES[name], evidence, ...(stopId ? { stopId: `next-js-prod:${stopId}` } : {}) });
  const main = checkoutOf(ctx);
  const cp = await checkoutProblem(ctx, main);
  if (cp) {
    // チェックアウトが決まらないと、ほかは確かめられない（人向けの表示は今までどおり 1 行だけ）
    item("checkout", "action", cp, "checkout");
    for (const name of Object.keys(ITEM_TITLES).filter((n) => n !== "checkout")) item(name, "unknown", "チェックアウトの確認が通らないので確かめていない");
    return { ok: false, notes: [cp], items };
  }
  notes.push(`チェックアウト ${main} は origin/main と同じ`);
  item("checkout", "ok", `チェックアウト ${main} は origin/main と同じコミット`);

  const builds = await buildProblems(ctx, main);
  for (const p of builds) bad(p);
  if (builds.length) item("build", "action", builds.join("／"), "build");
  else item("build", "ok", "control-plane の dist/ と next-js の .next/ は、チェックアウトを動かした後のビルド");

  let pp;
  let principalUnknown = false;
  try {
    pp = await principalProblem(ctx);
  } catch (e) {
    pp = `IAM を確かめられない（${e.message.split("\n")[0]}）`;
    principalUnknown = true;
  }
  if (pp) bad(pp);
  else notes.push(`IAM ユーザー ${IAM_USER}（${POLICY} だけ）がある`);
  const file = credentialsOf(ctx);
  const cr = await credentialsProblem(ctx, file);
  if (cr) bad(cr);
  else notes.push(`資格情報ファイルのキーは ${IAM_USER} のもの`);
  const principalProblems = [pp, cr].filter(Boolean);
  if (cr || (pp && !principalUnknown)) item("principal", "action", principalProblems.join("／"), "principal");
  else if (pp) item("principal", "unknown", principalProblems.join("／"));
  else item("principal", "ok", `IAM ユーザー ${IAM_USER} に ${POLICY} だけが付き、資格情報ファイルのキーはそのユーザーのもの`);

  // 設定の状況の主体と GitHub のトークン（4b）。確かめられなかった（IAM・GitHub に届かない）ときは unknown
  let sp;
  let statusUnknown = false;
  try {
    sp = await statusPrincipalProblem(ctx, statusCredentialsOf(ctx));
  } catch (e) {
    sp = `設定の状況の主体を確かめられない（${e.message.split("\n")[0]}）`;
    statusUnknown = true;
  }
  if (sp) bad(sp);
  else notes.push(`IAM ユーザー ${STATUS_USER}（${STATUS_POLICY} だけ）と、資格情報ファイルのキーがある`);
  if (sp && !statusUnknown) item("status-principal", "action", sp, "status-principal");
  else if (sp) item("status-principal", "unknown", sp);
  else item("status-principal", "ok", `IAM ユーザー ${STATUS_USER} に ${STATUS_POLICY} だけが付き、資格情報ファイルのキーはそのユーザーのもの`);

  let gp;
  let githubUnknown = false;
  try {
    gp = await statusGithubProblem(ctx, statusGithubTokenOf(ctx));
  } catch (e) {
    gp = `設定の状況用の GitHub のトークンを確かめられない（${e.message.split("\n")[0]}）`;
    githubUnknown = true;
  }
  if (gp) bad(gp);
  else notes.push("設定の状況用の GitHub のトークンは fine-grained PAT でリポジトリを読める（読み取り専用かは機械で確かめられない。人が作るときに Read-only を選ぶ）");
  // origin の名前が違う（改名前など）のは警告だけ（止めない）
  const originWarning = await statusOriginWarning(ctx);
  if (originWarning) notes.push(`! ${originWarning}`);
  if (gp && !githubUnknown) item("status-github", "action", originWarning ? `${gp}／${originWarning}` : gp, "status-github");
  else if (gp) item("status-github", "unknown", originWarning ? `${gp}／${originWarning}` : gp);
  else if (originWarning) item("status-github", "warn", originWarning);
  else item("status-github", "ok", `fine-grained PAT（github_pat_）でリポジトリ ${statusRepositoryOf(ctx)} を読め、classic の印（X-OAuth-Scopes）は無い。読み取り専用（Contents と Pull requests が Read-only）かは機械で確かめられない。人が作るときに選ぶ（onprem/README.md の「設定の状況を有効にする」）`);

  const envPath = join(appDirOf(main), ".env");
  const valueProblems = [];
  let exposed;
  let writtenUrl;
  const badValue = (msg) => {
    bad(msg);
    valueProblems.push(msg);
  };
  if (!existsSync(envPath)) badValue(`チェックアウトの .env（${envPath}）がまだ無い`);
  else {
    const env = ctx.readEnvFile(envPath);
    if (env.CONTROL_SCHEDULER_ENABLED !== "true") badValue("チェックアウトの .env の CONTROL_SCHEDULER_ENABLED が true ではない");
    if (env.CONTROL_SETUP_STATUS_ENABLED !== "true" || !env.CONTROL_STATUS_ALERT_TOPIC_ARN) badValue("チェックアウトの .env の設定の状況（CONTROL_SETUP_STATUS_ENABLED・CONTROL_STATUS_*）が本番の値ではない。apply で書き直して restart する");
    if (/127\.0\.0\.1:3100|localhost:3100/.test(env.MISWRITE_CHATWOOT_BASE_URL ?? "")) badValue("MISWRITE_CHATWOOT_BASE_URL が開発の Chatwoot のまま");
    if (env.AWS_PROFILE !== IAM_USER || !env.RUNLOG_BUCKET) badValue("チェックアウトの .env の AWS の設定（AWS_PROFILE・RUNLOG_BUCKET）が本番の値ではない");
    // 開く URL。.env に書かれた値が、apply が書く値（prod.conf の CONTROL_PUBLIC_URL、無ければ 127.0.0.1:3200）と同じか
    const written = publicUrlOf(env);
    writtenUrl = written;
    const expected = publicUrlConfOf(ctx);
    if (written !== expected) badValue(`チェックアウトの .env の BETTER_AUTH_URL が ${written}（期待: ${expected}。prod.conf の CONTROL_PUBLIC_URL、無ければ既定）。ブラウザで開く URL と違うと Invalid origin になる。apply で書き直して restart する（${OPEN_MANUAL}）`);
    else notes.push(`ブラウザで開く URL（BETTER_AUTH_URL）: ${written}`);
    exposed = exposureWarning(written);
    if (exposed) notes.push(`! ${exposed}`);
  }
  if (valueProblems.length) item("prod-values", "action", valueProblems.join("／"), "prod-values");
  else if (exposed) item("prod-values", "warn", exposed);
  else item("prod-values", "ok", `チェックアウトの .env は本番の値（BETTER_AUTH_URL: ${writtenUrl}）`);

  const unit = await unitState(ctx);
  let unitProblem;
  let unitStop = "systemd";
  if (!unit.installed) unitProblem = `systemd のユニット ${UNIT} が無い`;
  else if (!unit.active) unitProblem = `systemd のユニット ${UNIT} が動いていない`;
  else if (unit.dir !== appDirOf(main)) {
    unitProblem = `ユニット ${UNIT} の WorkingDirectory が ${unit.dir}（期待: ${appDirOf(main)}）`;
    unitStop = "systemd-dir";
  } else if (existsSync(envPath) && unit.startedAt && statSync(envPath).mtimeMs > unit.startedAt) {
    unitProblem = `.env を書いた後に ${UNIT} を起動し直していない`;
    unitStop = "restart";
  }
  if (unitProblem) {
    bad(unitProblem);
    item("systemd", "action", unitProblem, unitStop);
  } else {
    notes.push(`ユニット ${UNIT} は動いている`);
    item("systemd", "ok", `ユニット ${UNIT} は動いていて、WorkingDirectory はチェックアウトで、.env を書いた後に起動している`);
  }

  const state = await probe(ctx).catch((e) => `error:${e.message}`);
  if (state === "up") {
    notes.push(`監視アプリは応答している（${LOCAL_URL}）`);
    item("respond", "ok", `${LOCAL_URL}/login が応答している`);
  } else {
    const msg = state === "down" ? `監視アプリが応答しない（${LOCAL_URL}）` : state.slice(6);
    bad(msg);
    item("respond", "action", msg, "start");
  }

  const { warnings, enabled, alarm, schedules } = await operateWarnings(ctx, main);
  notes.push(`有効な定期実行: ${enabled.length ? enabled.join("・") : "なし"}`);
  for (const w of warnings) notes.push(`! ${w}`);
  if (alarm.unknown) item("heartbeat-alarm", "unknown", alarm.warnings.join("／"));
  else if (alarm.warnings.length) item("heartbeat-alarm", "warn", alarm.warnings.join("／"));
  else item("heartbeat-alarm", "ok", `アラーム ${HEARTBEAT_ALARM} は OK`);
  if (schedules.warnings.length) item("schedules-enabled", "warn", schedules.warnings.join("／"));
  else item("schedules-enabled", "ok", `有効な定期実行: ${enabled.join("・")}`);
  return { ok, notes, items };
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

  // 4b. 設定の状況の主体（読み取り専用の AWS の主体と GitHub のトークン）
  const statusFile = statusCredentialsOf(ctx);
  const statusProblem = await statusPrincipalProblem(ctx, statusFile);
  if (statusProblem) ctx.manual("status-principal", "設定の状況の主体（読み取り専用）を作り、キーを資格情報ファイルに書く", statusPrincipalSteps(statusProblem, statusFile));
  ctx.log(`設定の状況の主体 ${STATUS_USER}（${STATUS_POLICY} だけ）と、資格情報ファイルのキーを確かめた（キーは表示しない）`);
  const githubFile = statusGithubTokenOf(ctx);
  const githubProblem = await statusGithubProblem(ctx, githubFile);
  const originWarning = await statusOriginWarning(ctx);
  if (originWarning) ctx.warn(originWarning);
  if (githubProblem) ctx.manual("status-github", "設定の状況用の GitHub のトークン（参照専用）を作り、ファイルに書く", statusGithubSteps(githubProblem, githubFile));
  ctx.log("設定の状況用の GitHub のトークン（fine-grained PAT）でリポジトリを読めることを確かめた（読み取り専用かは確かめられない。人が Read-only を選ぶ。トークンは表示しない）");

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
  const exposed = exposureWarning(publicUrl);
  if (exposed) ctx.warn(exposed);

  // 8. 警告
  const { warnings, enabled } = await operateWarnings(ctx, main);
  for (const w of warnings) ctx.warn(w);
  ctx.log(`有効な定期実行: ${enabled.length ? enabled.join("・") : "なし"}。ログイン: ${publicUrl}/login`);
}
