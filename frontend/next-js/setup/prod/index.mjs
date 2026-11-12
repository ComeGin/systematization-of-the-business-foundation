// 監視アプリ（next-js ＋ control-plane。改善ループの起動元）を本番の値で常駐させる。setup/lib/core.mjs の契約に従う。--target prod の段階 operate だけ。
// 手順の正本は onprem/README.md の「監視アプリ（改善ループ）を本番で動かす」（setup/00-setup-overview.md の P14）。
//
// 監視アプリは開発と本番の区別が無い 1 つのインスタンスで（TA-07 の 2 節）、エージェントが書き込む先が本番（*-prod の MCP）なので、
// このモジュールが承認済みの main のチェックアウトの frontend/next-js/.env を本番の値で書く。開発のモジュール（../index.mjs）は作業ツリーの .env を扱い、
// こちらとは別のファイル（ADR-18。作業ツリーの未承認の変更を管制のコードに効かせないため、本番はチェックアウトから動かす）。
//
// 行うこと（止まるのは 1〜6 と 4b。どれも人の作業を案内して止まる）:
//   1. チェックアウトが origin/main と同じコミットか（git の状態は人が変える。setup は git を書き換えない）
//   2. control-plane（dist/）と next-js（.next/）のビルドが origin/main に追いついているか（ビルドは人が node <チェックアウト>/onprem/build.mjs control で行い、
//      そのときのコミットが .next/comegin-build.json に残る）・依存が lockfile と同じか・依存を入れ直した後にビルドしたか（2026-11-12）
//   3. 監視アプリの主体: IAM ユーザー comegin-prod-control-plane と管理ポリシー comegin-prod-control-plane（作成とキーの発行は人。cloud/README.md の 4.5.2）
//   4. 監視アプリ専用の資格情報ファイル（600）と、そのキーが 3 のユーザーのものであること（sts get-caller-identity。読み取りだけ）
//   4b. 「設定の状況」(/setup-status) の読み取り専用の主体: IAM ユーザー comegin-prod-status-reader（管理ポリシー comegin-prod-status-reader だけ）と、
//       そのキーの資格情報ファイル（600）、参照専用の GitHub トークンのファイル（600。fine-grained PAT〈github_pat_〉でリポジトリの読み取りが 200・X-OAuth-Scopes なし。読み取り専用かは機械で確かめられない）。
//       どちらも作成・発行は人（cloud/README.md の 4.5.3）。ファイルの置き場は ~/.config/comegin/status-reader/
//   4c. 改善の周（14 日）の設定（2026-11-09。docs/superpowers/specs/2026-11-09-improvement-cycle-design.md の 6 節）。止まる id は次のとおり:
//       agent-worktree（エージェント専用の作業場 CONTROL_WORKTREE。開発のリポジトリ・main のチェックアウトと 3 つとも別の場所）・
//       cycle（CONTROL_CYCLE_ANCHOR が無い・月曜でない）・strapi-tokens（本番の Strapi の URL と読み取りトークン。書き込みトークンは任意）・
//       deploy-values（配信のコマンドに埋める 3 つ。バケットとディストリビューション ID は prod.conf に無ければスタックの出力から）・
//       openai（OPENAI_API_KEY。任意の機能。無ければ警告だけ。あって形が違うときだけ止まる）・
//       mautic-reader（Mautic の参照専用の認証情報。任意の機能。無ければ警告だけ。一部だけ・ほかと同じ値のときだけ止まる）。
//       周を回すのに要るのは cycle・strapi-tokens の読み取り・deploy-values・agent-worktree。**その値の欠落で止まるのは、周のジョブ
//       （CYCLE_JOB_IDS）が main のチェックアウトの ops/schedules で 1 本でも enabled: true のときだけ**（すべて無効なら警告。Ruling 29）。
//       形の誤り・グループの片方だけ・同じ値の使い回し・作業場が main や開発のリポジトリと同じ場所、は常に止まる。OpenAI・Strapi の書き込みトークン・Mautic の参照用は、
//       アイキャッチ・配布ファイルのアップロード・キャンペーンの確認を有効にする（無いと該当の builtin は skipped）
//   5. 本番の値（prod.conf と状態）がそろっていること → チェックアウトの .env に書く（600。値は表示しない。設定の状況の 6 変数も）
//   6. systemd のユニット comegin-control が、このチェックアウトで動いていて、.env を書いた後・ビルドした後に起動していること（/etc は人が書く）
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
//   改善の周（2026-11-09）: CONTROL_WORKTREE（必須。エージェント専用の作業場）・CONTROL_CYCLE_ANCHOR（必須。月曜）・
//         CONTROL_STRAPI_READ_TOKEN（必須）・CONTROL_STRAPI_URL（既定 http://127.0.0.1:1338）・CONTROL_STRAPI_WRITE_TOKEN（任意）・
//         CONTROL_DEPLOY_AWS_PROFILE（必須。人の SSO のプロファイル名）・CONTROL_DEPLOY_BUCKET・CONTROL_DEPLOY_DISTRIBUTION_ID（空ならスタックの出力 AstroBucketName・DistributionId）・
//         OPENAI_API_KEY（任意）・CONTROL_OPENAI_IMAGE_MODEL・CONTROL_OPENAI_IMAGE_SIZE・CONTROL_COVER_MAX_PER_RUN（任意）・
//         CONTROL_MAUTIC_CLIENT_ID・CONTROL_MAUTIC_CLIENT_SECRET（任意。2 つで 1 組）・CONTROL_MAUTIC_URL（既定は MAUTIC_BASE_URL、無ければ https://mkt.comegin.com）・
//         CONTROL_WORKTREE_SYNC（任意）
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REGION, STACK, awsJson, describeStack, outputOf, requireMainStack } from "../../../../cloud/setup/aws.mjs";
import { registerSecret } from "../../../../setup/lib/core.mjs";
import { commitDrift, describeChanges } from "../../../../setup/lib/drift.mjs";
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
  const mainReal = realpathSync(main);
  // prod.conf の CONTROL_WORKTREE が存在しないパスでも例外にしない（agent-worktree の案内に届くように、ここでは null として比べない）
  if (mainReal === realpathOrNull(ctx.conf.CONTROL_WORKTREE || ctx.WORKTREE) || mainReal === realpathOrNull(ctx.WORKTREE)) return "CONTROL_MAIN_CHECKOUT が作業ツリーと同じ場所（ADR-18。本番は承認済みの main のチェックアウトから動かす）";
  const head = await git(ctx, ["-C", main, "rev-parse", "HEAD"]);
  const origin = await git(ctx, ["-C", ctx.WORKTREE, "rev-parse", "origin/main"]);
  if (head !== origin) return `チェックアウトが origin/main（${origin.slice(0, 8)}）ではなく ${head.slice(0, 8)} を指している`;
  return null;
}

// 2. ビルド（2026-11-12 にコミットの記録の方式へ改めた。以前は HEAD を動かした時刻とビルドの日時を比べていて、README だけの変更でも ● になった）
//   - 記録: node <チェックアウト>/onprem/build.mjs control が、ビルドしたコミットを frontend/next-js/.next/comegin-build.json に書く。
//     そこから origin/main までに CONTROL_BUILD_PATHS を変えたコミットがあればビルドし直しが要る（setup/lib/drift.mjs。Strapi・n8n のイメージと同じ）。
//     定義（ops/・.claude/agents）と設定の状況のカタログは、動いている監視アプリが読み直すので、ビルドも再起動も要らない
//   - 依存: node_modules/.pnpm/lock.yaml（pnpm が最後に入れた lockfile の写し）が pnpm-lock.yaml と同じか。違えば pnpm install していない
//   - 順: 依存を入れ直した後にビルドしたか・control-plane の dist の後に next-js をビルドしたか（next-js は control-plane を取り込む）
const BUILD_RECORD = "frontend/next-js/.next/comegin-build.json";
const CONTROL_BUILD_PATHS = ["backend/control-plane", "frontend/next-js", ":(exclude)frontend/next-js/setup"];
const COMMIT = /^[0-9a-f]{40}$/;
const BUILD_RANK = { ok: 0, warn: 1, unknown: 2, action: 3 };
const buildCommand = (main) => `node ${join(main, "onprem/build.mjs")} control`;
/** ビルドと依存の、見る場所。pkg はリポジトリのルートからの相対 */
const PACKAGES = [
  { pkg: "backend/control-plane", artifact: "dist/index.js", artifactLabel: "dist/（pnpm build）" },
  { pkg: "frontend/next-js", artifact: ".next/BUILD_ID", artifactLabel: ".next/（next build）" },
];

const sha256Of = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const mtimeOf = (file) => statSync(file).mtimeMs;

/** 依存の写しと lockfile が同じか。問題があれば文を返す */
function depsProblem(main, pkg) {
  const lock = join(main, pkg, "pnpm-lock.yaml");
  const installed = join(main, pkg, "node_modules/.pnpm/lock.yaml");
  if (!existsSync(join(main, pkg, "node_modules"))) return `${pkg} の node_modules が無い（pnpm install していない）`;
  if (!existsSync(installed)) return `${pkg} の node_modules/.pnpm/lock.yaml が無い（pnpm install が途中で止まったか、別の道具で入れた）`;
  if (existsSync(lock) && sha256Of(lock) !== sha256Of(installed)) return `${pkg} の依存が pnpm-lock.yaml と違う（lockfile が変わった後に pnpm install していない）`;
  return null;
}

/** ビルドの記録（コミット）。無い・読めないときは null */
function readBuildRecord(main) {
  try {
    const record = JSON.parse(readFileSync(join(main, BUILD_RECORD), "utf8"));
    return COMMIT.test(record?.commit ?? "") ? record : null;
  } catch {
    return null;
  }
}

/**
 * 2. ビルドの確かめ。{ level, text }[] を返す（action はビルドし直しが要る。warn・unknown は止めない）。
 * 動いている監視アプリがビルドより前に起動しているか（再起動の要否）は systemd の項目が見る（builtAtOf）
 */
async function buildFindings(ctx, main) {
  const findings = [];
  const action = (text) => findings.push({ level: "action", text });
  for (const { pkg, artifact, artifactLabel } of PACKAGES) {
    const file = join(main, pkg, artifact);
    const deps = depsProblem(main, pkg);
    if (deps) action(deps);
    if (!existsSync(file)) {
      action(`${pkg} の ${artifactLabel} が無い`);
      continue;
    }
    const installed = join(main, pkg, "node_modules/.pnpm/lock.yaml");
    if (!deps && existsSync(installed) && mtimeOf(file) < mtimeOf(installed)) action(`${pkg} の ${artifactLabel} が、依存を入れ直す前のビルド`);
  }
  const cpDist = join(main, "backend/control-plane/dist/index.js");
  const buildId = join(main, "frontend/next-js/.next/BUILD_ID");
  if (existsSync(cpDist) && existsSync(buildId) && mtimeOf(buildId) < mtimeOf(cpDist)) {
    action("frontend/next-js の .next/ が、control-plane をビルドし直す前のもの（next-js は control-plane を取り込むので、control-plane の後にビルドし直す）");
  }

  if (existsSync(buildId)) {
    const record = readBuildRecord(main);
    if (!record) {
      action(`ビルドしたコミットの記録（${BUILD_RECORD}）が無い（この仕組みより前のビルド、または包まずに pnpm build した）`);
    } else {
      try {
        const drift = await commitDrift(ctx, { recorded: record.commit, paths: CONTROL_BUILD_PATHS });
        if (drift.kind === "outside-main") findings.push({ level: "warn", text: `ビルドのコミット ${record.commit.slice(0, 7)} が origin/main の履歴に無い（git fetch するか、チェックアウトで記録付きでビルドし直す）` });
        else if (drift.kind === "changed") action(`ビルドのコミット ${record.commit.slice(0, 7)} の後に、control-plane・監視アプリのコードが origin/main で変わった（${describeChanges(drift.entries)}）`);
      } catch (e) {
        findings.push({ level: "unknown", text: `origin/main との差を git で確かめられない（${String(e?.message ?? e).split("\n")[0]}）` });
      }
    }
  }
  return findings;
}

/** findings のうち最も重い印 */
const worstLevel = (findings) => findings.reduce((worst, f) => (BUILD_RANK[f.level] > BUILD_RANK[worst] ? f.level : worst), "ok");

/** 動いている監視アプリが読み込むもの（ビルドと依存）のうち、いちばん新しい日時（ミリ秒）。無ければ null */
function builtAtOf(main) {
  const files = PACKAGES.flatMap(({ pkg, artifact }) => [join(main, pkg, artifact), join(main, pkg, "node_modules/.pnpm/lock.yaml")]).filter((file) => existsSync(file));
  return files.length ? Math.max(...files.map(mtimeOf)) : null;
}

function buildSteps(main, problems) {
  return [
    ...problems.map((p) => `いまの状態: ${p}`),
    `人が自分の端末で: ${buildCommand(main)}（チェックアウトにあるこのファイルを実行する。control-plane → next-js の順に pnpm install --frozen-lockfile && pnpm build し、ビルドしたコミットを記録する。包まずに pnpm build すると記録が消える）`,
    `続けて: sudo systemctl restart ${UNIT}（動いている監視アプリは、起動したときのビルドを使い続ける）`,
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
    `人が自分の端末で、管理者のプロファイルで行う（Claude Code の実行環境では行わない）: IAM ユーザー ${STATUS_USER} を作り、管理ポリシー ${STATUS_POLICY} だけを付け、アクセスキーを ${file}（プロファイル名 [${STATUS_PROFILE}]）に直接書く（画面に出さない。umask 077）。管理ポリシーは先に node cloud/deploy.mjs でデプロイして作る。コマンドは cloud/README.md の 4.5.3`,
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

  // 改善の周（2026-11-09）。スタックの出力（配信のバケット・ディストリビューション ID）は、prod.conf に無いときの既定
  const cycle = cycleSettings(ctx, stack, null, enabledCycleJobs(main).length > 0);
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
  Object.assign(values, cycle.values);
  // I-13 の起票（GitHub）。1 つでも書いたら全部要る。リポジトリは origin から補う
  const github = ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "GITHUB_BASE_BRANCH", "I13_ISSUE_NUMBER", "I13_REVIEWER"];
  if (github.some((k) => ctx.conf[k])) {
    for (const k of github) if (ctx.conf[k]) values[k] = ctx.conf[k];
    values.GITHUB_REPOSITORY ??= await repositoryFromOrigin(ctx);
  }
  const groupKeys = GROUPS["I-13 の起票"];
  const set = groupKeys.filter((k) => values[k]);
  if (set.length && set.length < groupKeys.length) missing.push(`${groupKeys.filter((k) => !values[k]).join("・")}（I-13 の起票。1 つでも書いたら 4 つとも要る。fine-grained PAT は Contents と Pull requests を Read and write）`);
  return { values, missing, cycle };
}

// ---------------------------------------------------------------------------
// 改善の周（2026-11-09）の設定。止まる id: agent-worktree・cycle・strapi-tokens・deploy-values・openai・mautic-reader
// ---------------------------------------------------------------------------

const DEFAULT_STRAPI_URL = "http://127.0.0.1:1338";
const DEFAULT_MAUTIC_URL = "https://mkt.comegin.com";
const CYCLE_IDS = ["cycle", "strapi-tokens", "deploy-values", "openai", "mautic-reader"];

/** 実在する日付で、月曜か（暦の日付なのでタイムゾーンに依らず曜日が決まる） */
function isMondayDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text && d.getUTCDay() === 1;
}

function realpathOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** 周のジョブ（定期実行の定義の id）。1 本でも enabled: true なら、周の設定の欠落で止める（Ruling 29） */
export const CYCLE_JOB_IDS = [
  "cycle-open",
  "cycle-collect",
  "cycle-close",
  "cycle-apply-content",
  "cycle-apply-code",
  "cycle-campaign",
  "article-cover",
  "campaign-asset-upload",
];

/** main のチェックアウトの ops/schedules で enabled: true の周のジョブ（無ければ空） */
export function enabledCycleJobs(main) {
  return enabledSchedules(main).filter((id) => CYCLE_JOB_IDS.includes(id));
}

/**
 * 開発のリポジトリ（作業ツリー）・承認済み main のチェックアウト・エージェント専用の作業場の 3 つが、互いに別の場所か。
 * 返すのは { text, lack }（問題の文と、値の欠落か）。lack=true は「無い・git のチェックアウトでない」で、周のジョブが無効なら止めない。
 * 別の場所でない・絶対パスでないのは誤りで、常に止める。問題が無ければ null
 */
export function agentWorktreeIssue(ctx, main) {
  const wt = ctx.conf.CONTROL_WORKTREE;
  if (!wt) return { lack: true, text: "CONTROL_WORKTREE（エージェント専用の作業場の絶対パス）が prod.conf に無い。無いと、エージェントが開発のリポジトリ（作業ツリー）に書き、夜中の差分が開発中の変更と混ざる" };
  if (!wt.startsWith("/")) return { lack: false, text: `CONTROL_WORKTREE（${wt}）が絶対パスではない` };
  const real = realpathOrNull(wt);
  if (real !== null && real === realpathOrNull(main)) return { lack: false, text: "CONTROL_WORKTREE が承認済みの main のチェックアウトと同じ場所（エージェントが書いた未承認の変更が、実行条件を読む場所に入る。ADR-18）" };
  if (real !== null && real === realpathOrNull(ctx.WORKTREE)) return { lack: false, text: "CONTROL_WORKTREE が開発のリポジトリ（作業ツリー）と同じ場所。エージェント専用の 3 本目のチェックアウトにする（夜中の差分が開発中の変更と混ざる）" };
  if (!existsSync(join(wt, ".git"))) return { lack: true, text: `CONTROL_WORKTREE（${wt}）が git のチェックアウトではない（無いか、.git が無い）。git worktree add で作る` };
  return null;
}

/** agentWorktreeIssue の文だけ（無ければ null。互換用） */
export function agentWorktreeProblem(ctx, main) {
  return agentWorktreeIssue(ctx, main)?.text ?? null;
}

function agentWorktreeSteps(problem) {
  return [
    `いまの状態: ${problem}`,
    "人が自分の端末で作る（setup は git を書き換えない。setup/manual-steps.md の 6.2）: git -C <開発のリポジトリ> fetch origin && git -C <開発のリポジトリ> worktree add --detach ~/ComeGin/agent-worktree origin/main",
    "prod.conf に CONTROL_WORKTREE=<その絶対パス> を書く。開発のリポジトリ・承認済みの main のチェックアウト・この作業場の 3 つは、互いに別の場所にする",
    "同じコマンドを実行し直す",
  ];
}

const URL_OK = (text) => {
  try {
    const u = new URL(text);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * 改善の周の設定を prod.conf から読む。values は .env に書く 1 組で、秘密値を含むので表示しない（無い任意の値は空にして、.env に古い値を残さない）。
 * stops は止まる理由（id ごと）、warns は止めない警告（その機能が無効になるだけ）。メッセージに値は入れない。
 * stack は describeStack の結果（読めなければ null）、stackError は読めなかった理由（読めなかったのと、スタックに出力が無いのを区別する）。
 */
export function cycleSettings(ctx, stack, stackError = null, required = true) {
  const c = ctx.conf;
  const stops = Object.fromEntries(CYCLE_IDS.map((id) => [id, []]));
  const warns = Object.fromEntries(CYCLE_IDS.map((id) => [id, []]));
  const values = {};
  let deployUnknown = false;
  // 値の欠落（lack）は、周のジョブが 1 本でも有効（required）なら止め、すべて無効なら警告だけ。形の誤り・片方だけ・同じ値の使い回しは常に止める（Ruling 29）
  const lack = (id, text) => (required ? stops[id] : warns[id]).push(required ? text : `${text}（周のジョブがすべて無効なので止めない。有効にする前に書く）`);

  // cycle: 周の起点
  const anchor = c.CONTROL_CYCLE_ANCHOR?.trim();
  if (!anchor) lack("cycle", "CONTROL_CYCLE_ANCHOR（周の起点。JST の月曜の日付 YYYY-MM-DD）が prod.conf に無い");
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) stops.cycle.push("CONTROL_CYCLE_ANCHOR が YYYY-MM-DD の形ではない");
  else if (!isMondayDate(anchor)) stops.cycle.push("CONTROL_CYCLE_ANCHOR が月曜の日付ではない（実在しない日付を含む）");
  values.CONTROL_CYCLE_ANCHOR = anchor ?? "";
  values.CONTROL_WORKTREE_SYNC = c.CONTROL_WORKTREE_SYNC ?? "";

  // strapi-tokens: 本番の Strapi。URL と読み取りトークンは必須、書き込みトークンは任意
  const strapiUrl = (c.CONTROL_STRAPI_URL || DEFAULT_STRAPI_URL).replace(/\/+$/, "");
  if (!URL_OK(strapiUrl)) stops["strapi-tokens"].push("CONTROL_STRAPI_URL が http(s) の URL ではない");
  else if (/^https?:\/\/(127\.0\.0\.1|localhost):1337(\/|$)/.test(strapiUrl)) stops["strapi-tokens"].push("CONTROL_STRAPI_URL が開発の Strapi（:1337）を指している。本番はオンプレの Strapi（http://127.0.0.1:1338）");
  const readToken = c.CONTROL_STRAPI_READ_TOKEN;
  const writeToken = c.CONTROL_STRAPI_WRITE_TOKEN;
  if (!readToken) lack("strapi-tokens", "CONTROL_STRAPI_READ_TOKEN（読み取り専用の API トークン）が prod.conf に無い");
  // 読み取りトークンが無いのに書き込みトークンだけ、は control-plane が起動時に例外にする（config.ts のグループ規則）。常に止める
  if (!readToken && writeToken) stops["strapi-tokens"].push("CONTROL_STRAPI_WRITE_TOKEN だけがあり、CONTROL_STRAPI_READ_TOKEN が無い（書き込みだけの設定は監視アプリが起動時に例外にする。読み取りも書く）");
  if (writeToken && (writeToken === readToken || writeToken === c.STRAPI_PROD_TOKEN)) {
    stops["strapi-tokens"].push("CONTROL_STRAPI_WRITE_TOKEN が読み取りのトークン（または MCP の STRAPI_PROD_TOKEN）と同じ値。書き込み用は専用の API トークンを別に発行する");
  }
  if (!writeToken) warns["strapi-tokens"].push("CONTROL_STRAPI_WRITE_TOKEN が無い。article-cover と campaign-asset-upload は skipped になる（記事の下書き・周の項目は動く）");
  // URL と読み取りトークンは 2 つで 1 組（config.ts）。読み取りトークンが無い間は URL も書かない（片方だけだと監視アプリが起動時に例外にする）
  values.CONTROL_STRAPI_URL = readToken ? strapiUrl : "";
  values.CONTROL_STRAPI_READ_TOKEN = readToken ?? "";
  values.CONTROL_STRAPI_WRITE_TOKEN = readToken ? (writeToken ?? "") : "";

  // deploy-values: 配信のコマンドに埋める値。バケットとディストリビューション ID は prod.conf、無ければスタックの出力
  const bucket = c.CONTROL_DEPLOY_BUCKET || outputOf(stack, "AstroBucketName");
  const dist = c.CONTROL_DEPLOY_DISTRIBUTION_ID || outputOf(stack, "DistributionId");
  const profile = c.CONTROL_DEPLOY_AWS_PROFILE;
  if (!profile) lack("deploy-values", "CONTROL_DEPLOY_AWS_PROFILE（人の SSO のプロファイル名。許可セット ComeginProdDeploy で aws sso login するときの名前）が prod.conf に無い");
  for (const [name, v, out] of [["CONTROL_DEPLOY_BUCKET", bucket, "AstroBucketName"], ["CONTROL_DEPLOY_DISTRIBUTION_ID", dist, "DistributionId"]]) {
    if (v) continue;
    if (stackError) deployUnknown = true;
    lack("deploy-values", stackError ? `${name} を確かめられない（スタック ${STACK} の出力 ${out} を読めなかった: ${stackError}）` : `${name} が prod.conf に無く、スタック ${STACK} の出力 ${out} も無い`);
  }
  // 3 つで 1 組（config.ts）。1 つでも欠けるときは 3 つとも空にする（一部だけだと監視アプリが起動時に例外にする）
  const deployComplete = Boolean(bucket && dist && profile);
  values.CONTROL_DEPLOY_BUCKET = deployComplete ? bucket : "";
  values.CONTROL_DEPLOY_DISTRIBUTION_ID = deployComplete ? dist : "";
  values.CONTROL_DEPLOY_AWS_PROFILE = deployComplete ? profile : "";

  // openai: アイキャッチ。任意の機能（キーが無ければ警告だけ）
  const key = c.OPENAI_API_KEY;
  if (!key) warns.openai.push("OPENAI_API_KEY が無い。article-cover は skipped になる（アイキャッチ画像が作られない）");
  else {
    // キーの形は OpenAI が変えうるので、止めずに警告にする（誤りなら生成が認証で失敗する）
    if (!key.startsWith("sk-")) warns.openai.push("OPENAI_API_KEY が sk- で始まらない（OpenAI の API キーの形ではない可能性がある。書き間違いなら article-cover が認証で失敗する）");
    if (!writeToken) warns.openai.push("CONTROL_STRAPI_WRITE_TOKEN が無いので、OPENAI_API_KEY があっても article-cover は skipped になる（費用は出ない）");
  }
  if (c.CONTROL_OPENAI_IMAGE_SIZE && !/^\d{3,4}x\d{3,4}$/.test(c.CONTROL_OPENAI_IMAGE_SIZE)) stops.openai.push("CONTROL_OPENAI_IMAGE_SIZE が 幅x高さ（例 1536x1024）の形ではない");
  if (c.CONTROL_COVER_MAX_PER_RUN) {
    const n = Number(c.CONTROL_COVER_MAX_PER_RUN);
    if (!Number.isInteger(n) || n < 1 || n > 10) stops.openai.push("CONTROL_COVER_MAX_PER_RUN が 1〜10 の整数ではない（上げるなら ops/schedules/article-cover.yaml の timeout_sec も上げる。ops/README.md）");
  }
  values.OPENAI_API_KEY = key ?? "";
  values.CONTROL_OPENAI_IMAGE_MODEL = c.CONTROL_OPENAI_IMAGE_MODEL ?? "";
  values.CONTROL_OPENAI_IMAGE_SIZE = c.CONTROL_OPENAI_IMAGE_SIZE ?? "";
  values.CONTROL_COVER_MAX_PER_RUN = c.CONTROL_COVER_MAX_PER_RUN ?? "";

  // mautic-reader: 参照専用ロールの認証情報（control-plane 用に別に発行）。任意の機能。URL・ID・シークレットは 3 つで 1 組
  const mid = c.CONTROL_MAUTIC_CLIENT_ID;
  const msecret = c.CONTROL_MAUTIC_CLIENT_SECRET;
  const mautic = (c.CONTROL_MAUTIC_URL || c.MAUTIC_BASE_URL || DEFAULT_MAUTIC_URL).replace(/\/+$/, "");
  if (!mid && !msecret) warns["mautic-reader"].push("CONTROL_MAUTIC_CLIENT_ID・CONTROL_MAUTIC_CLIENT_SECRET が無い。cycle-collect は campaign の項目の中身を埋めず、送信の開始も確かめない（理由を項目に出す。ほかは動く）");
  else {
    if (!mid || !msecret) stops["mautic-reader"].push(`${mid ? "CONTROL_MAUTIC_CLIENT_SECRET" : "CONTROL_MAUTIC_CLIENT_ID"} が無い（2 つで 1 組。片方だけだと監視アプリが起動時に例外にする）`);
    if (!URL_OK(mautic)) stops["mautic-reader"].push("CONTROL_MAUTIC_URL が http(s) の URL ではない");
    if (mid && [c.MAUTIC_CLIENT_ID, c.MAUTIC_RO_CLIENT_ID, c.MAUTIC_SETUP_CLIENT_ID, c.N8N_MAUTIC_CLIENT_ID].includes(mid)) {
      stops["mautic-reader"].push("CONTROL_MAUTIC_CLIENT_ID がほかの用途（エージェント・mautic-prod-ro・初期設定・n8n）の API 認証情報と同じ。control-plane 用に別に発行する（片方を失効しても、もう片方を止めないため）");
    }
  }
  values.CONTROL_MAUTIC_URL = mid && msecret ? mautic : "";
  values.CONTROL_MAUTIC_CLIENT_ID = mid ?? "";
  values.CONTROL_MAUTIC_CLIENT_SECRET = msecret ?? "";

  return { values, stops, warns, deployUnknown };
}

/** スタックの出力を読む。読めなかったら stack=null と理由（AWS に届かない・スタックが無い）を返し、例外にしない（check を止めない） */
async function readStackSafe(ctx) {
  try {
    const stack = await describeStack(ctx);
    return stack ? { stack, error: null } : { stack: null, error: `スタック ${STACK} が無い` };
  } catch (e) {
    return { stack: null, error: String(e.message).split("\n")[0] };
  }
}

const CYCLE_TITLES = {
  cycle: "改善の周の起点（CONTROL_CYCLE_ANCHOR。月曜の日付）を決める",
  "strapi-tokens": "本番の Strapi の読み取りトークン（と任意の書き込みトークン）を発行して書く",
  "deploy-values": "配信のコマンドに埋める値（バケット・ディストリビューション ID・SSO のプロファイル名）を書く",
  openai: "OpenAI の API キー（アイキャッチ画像用）を直す",
  "mautic-reader": "Mautic の参照専用の API 認証情報（control-plane 用）を直す",
};
const CYCLE_MANUAL = {
  cycle: "setup/manual-steps.md の 7.10",
  "strapi-tokens": "setup/manual-steps.md の 7.8（読み取りは article と category の find・findOne〈下書きを含む〉、書き込みはアップロードと article の更新だけで公開は付けない。発行した後、開発の Strapi で書き込みトークンが公開できないことを確かめる）",
  "deploy-values": "cloud/README.md の 4.14（バケットは親スタックの出力 AstroBucketName、ディストリビューション ID は DistributionId。プロファイル名は人が SSO で使っているもの。監視アプリはコマンドに埋めるだけで配信しない）",
  openai: "setup/manual-steps.md の 7.7",
  "mautic-reader": "setup/manual-steps.md の 7.9（参照専用ロール〈mautic-prod-ro と同じ権限〉の API 認証情報を、control-plane 用に別に発行する）",
};

function cycleSteps(id, problems) {
  return [
    ...problems.map((p) => `いまの状態: ${p}`),
    `手順: ${CYCLE_MANUAL[id]}`,
    "~/.config/comegin/setup/prod.conf に書く（chmod 600。値は画面に出さない。エディタで書く）",
    "同じコマンドを実行し直す",
  ];
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
 * 8. 人の確認（apply では手順を出して yes を待つ。2026-11-10）。warnings は人向けの文の全部（ハートビートのアラーム → 定期実行の順）、
 * entries は apply が ctx.confirm に渡す { id, text, steps }。alarm・schedules は監視アプリの項目用（alarm.unknown はアラームを読めなかったとき）
 */
async function operateWarnings(ctx, main) {
  const alarmWarnings = [];
  const entries = [];
  let alarmUnknown = false;
  const alarmState = `aws cloudwatch describe-alarms --region ${REGION} --alarm-names ${HEARTBEAT_ALARM} --query 'MetricAlarms[0].[StateValue,StateReason]' --output text`;
  try {
    const alarm = (await awsJson(ctx, ["cloudwatch", "describe-alarms", "--region", REGION, "--alarm-names", HEARTBEAT_ALARM]))?.MetricAlarms?.[0];
    if (!alarm) {
      const text = `アラーム ${HEARTBEAT_ALARM} が無い（スタックを確かめる）`;
      alarmWarnings.push(text);
      entries.push({ id: "heartbeat-alarm", text, steps: [
        `本番スタックの状態を見る: aws cloudformation describe-stacks --region ${REGION} --stack-name comegin-prod --query 'Stacks[0].StackStatus' --output text（*_COMPLETE であること）`,
        `アラームの名前を探す: aws cloudwatch describe-alarms --region ${REGION} --alarm-name-prefix comegin-prod-onprem --query 'MetricAlarms[].AlarmName' --output text`,
        "無ければ cloud/stacks/alarms.yaml のハートビートのアラームを確かめ、人が node cloud/deploy.mjs でデプロイする（cloud/README.md の 4.10・4.13）",
        "アラームが無いと、監視アプリが止まっても知らせが届かない。デプロイを後で行うと決めたときだけ yes",
      ] });
    } else if (alarm.StateValue !== "OK") {
      const text = `アラーム ${HEARTBEAT_ALARM} が ${alarm.StateValue}（${alarm.StateUpdatedTimestamp} から）。起動から 15 分ほどで OK に戻る。戻らなければ journalctl -u ${UNIT} の heartbeat の行と、資格情報ファイル・RUNLOG_BUCKET・AWS_REGION を確かめる（cloud/README.md の 4.13）`;
      alarmWarnings.push(text);
      entries.push({ id: "heartbeat-alarm", text, steps: [
        `起動から 15 分ほど待ってから状態を見る: ${alarmState}（OK になれば済み）`,
        `OK にならなければ、送り手のログを見る: journalctl -u ${UNIT} -n 200 | grep -i heartbeat（「開始 scheduler=on heartbeat=on」が出ているか。heartbeat=off なら AWS の値が読めていない）`,
        `チェックアウトの .env の AWS_SHARED_CREDENTIALS_FILE・RUNLOG_BUCKET・AWS_REGION が空でないかを、値を出さずに確かめる: grep -c '^\\(AWS_SHARED_CREDENTIALS_FILE\\|RUNLOG_BUCKET\\|AWS_REGION\\)=.' <チェックアウト>/frontend/next-js/.env（3 が出る）`,
        "資格情報ファイルのキーが有効かは、この設定スクリプトの手順 3・4（監視アプリの主体）で確かめ済み。キーを入れ替えたなら sudo systemctl restart comegin-control",
        "OK になった（または、起動の直後で OK に戻るのを待つだけと判断した）なら yes",
      ] });
    }
  } catch (e) {
    const text = `アラーム ${HEARTBEAT_ALARM} を確かめられない（${e.message.split("\n")[0]}）`;
    alarmWarnings.push(text);
    alarmUnknown = true;
    entries.push({ id: "heartbeat-alarm-unknown", text, steps: [
      "AWS の認証を確かめる: aws sts get-caller-identity（期限切れなら aws sso login。AWS_PROFILE が本番の管理者を指しているか）",
      `手で状態を見る: ${alarmState}`,
      "確かめられないまま進めてよいと判断したときだけ yes",
    ] });
  }
  const warnings = [];
  const enabled = enabledSchedules(main);
  if (enabled.includes("heartbeat")) {
    const text = "ops/schedules/heartbeat.yaml が enabled: true。ハートビートは定義に関係なく起動時から送られるので、二重に送り、E-15 に 1 日 288 件の記録が増える。false に戻す PR を出す";
    warnings.push(text);
    entries.push({ id: "heartbeat-schedule", text, steps: [
      "開発のリポジトリでブランチを切り（<Issue番号>-feature-<名前>）、ops/schedules/heartbeat.yaml の enabled を false にする",
      "コミットして PR を出し、レビューしてから main にマージする（定義は承認済みの main のチェックアウトから読まれる。ADR-18）",
      `承認済みの main のチェックアウト（${main}）を origin/main に合わせる: git -C <作業ツリー> fetch origin && git -C ${main} checkout --detach origin/main`,
      "同じコマンドを実行し直す（PR を出して、マージを待つあいだ進めると判断したときだけ yes）",
    ] });
  }
  if (!enabled.length) {
    const text = `有効な定期実行が 0 本（ops/schedules/*.yaml はすべて enabled: false）。改善ループはまだ動かない。人が PR で段階的に enabled: true にする（${MANUAL} の手順 5）`;
    warnings.push(text);
    entries.push({ id: "schedules-none", text, steps: [
      "動かす定期実行を決める（観測のジョブから 1〜2 本ずつ。時刻は JST 0〜8 時の窓。ops/README.md の表）",
      "開発のリポジトリでブランチを切り、ops/schedules/<名前>.yaml の enabled を true にして PR を出し、レビューしてから main にマージする（heartbeat.yaml は true にしない）",
      `承認済みの main のチェックアウト（${main}）を origin/main に合わせる: git -C <作業ツリー> fetch origin && git -C ${main} checkout --detach origin/main（定義は次の実行から効く。再起動は要らない）`,
      `監視アプリ（http://127.0.0.1:3200）の「ジョブ」で、有効になったことと次の実行の時刻を確かめる（${MANUAL} の手順 5）`,
      "改善ループをまだ動かさない（定期実行は 0 本のまま運用を始める）と判断したときは、PR を出さずに yes",
    ] });
  }
  return { warnings: [...alarmWarnings, ...warnings], entries, enabled, alarm: { warnings: alarmWarnings, unknown: alarmUnknown }, schedules: { warnings } };
}

// ---------------------------------------------------------------------------
// 契約
// ---------------------------------------------------------------------------

// 監視アプリの「設定の状況」が読む項目（key は next-js-prod.<名前>。すべて P14。stopId は apply が今そこで止まる id）
const STEP = "P14";
const ITEM_TITLES = {
  checkout: "チェックアウトが origin/main と同じコミット",
  build: "control-plane と監視アプリのビルドが origin/main に追いつき、依存が lockfile と同じ",
  principal: "監視アプリの主体（IAM ユーザー comegin-prod-control-plane と資格情報ファイルのキー）",
  "status-principal": "設定の状況の主体（IAM ユーザー comegin-prod-status-reader と資格情報ファイルのキー）",
  "status-github": "設定の状況用の GitHub のトークン（fine-grained PAT。読み取り専用かは人が確かめる）",
  "agent-worktree": "エージェント専用の作業場（開発のリポジトリ・main のチェックアウトとは別の場所）",
  cycle: "改善の周の起点（CONTROL_CYCLE_ANCHOR。月曜の日付）",
  "strapi-tokens": "本番の Strapi の読み取りトークン（書き込みトークンは任意。無いとアイキャッチと配布ファイルは動かない）",
  "deploy-values": "配信のコマンドに埋める値（バケット・ディストリビューション ID・SSO のプロファイル名）",
  openai: "OpenAI の API キー（任意。無いとアイキャッチ画像は作られない）",
  "mautic-reader": "Mautic の参照専用の API 認証情報（任意。無いとキャンペーンの中身と送信の確認が出ない）",
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

  const builds = await buildFindings(ctx, main);
  for (const f of builds) {
    if (f.level === "action") bad(f.text);
    else notes.push(`! ${f.text}`);
  }
  const buildLevel = worstLevel(builds);
  if (buildLevel === "ok") item("build", "ok", "control-plane と next-js のビルドの記録から origin/main までにコードの変更は無く、依存は lockfile と同じで、依存を入れた後にビルドしている");
  else item("build", buildLevel, builds.map((f) => f.text).join("／"), buildLevel === "action" ? "build" : undefined);

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

  // 改善の周（2026-11-09）。作業場・起点・Strapi の読み取り・配信の値は、周のジョブが 1 本でも有効（enabled: true）なら必須（欠落で止める）、
  // すべて無効なら警告だけ（Ruling 29）。OpenAI・書き込みトークン・Mautic の参照用は常に任意。形の誤り・片方だけ・同じ値の使い回しは常に止める
  const cycleJobs = enabledCycleJobs(main);
  const cycleRequired = cycleJobs.length > 0;
  const awi = agentWorktreeIssue(ctx, main);
  if (awi && (cycleRequired || !awi.lack)) {
    bad(awi.text);
    item("agent-worktree", "action", awi.text, "agent-worktree");
  } else if (awi) {
    notes.push(`! ${awi.text}（周のジョブがすべて無効なので止めない）`);
    item("agent-worktree", "warn", `${awi.text}（周のジョブがすべて無効なので止めない。有効にする前に作る）`);
  } else {
    notes.push(`エージェント専用の作業場 ${ctx.conf.CONTROL_WORKTREE} は、開発のリポジトリ・main のチェックアウトと別の場所`);
    item("agent-worktree", "ok", `エージェント専用の作業場 ${ctx.conf.CONTROL_WORKTREE} は、開発のリポジトリ・承認済みの main のチェックアウトとは別の場所`);
  }
  const needStack = !ctx.conf.CONTROL_DEPLOY_BUCKET || !ctx.conf.CONTROL_DEPLOY_DISTRIBUTION_ID;
  const { stack: cycleStack, error: stackError } = needStack ? await readStackSafe(ctx) : { stack: null, error: null };
  const cs = cycleSettings(ctx, cycleStack, stackError, cycleRequired);
  for (const id of CYCLE_IDS) {
    const stopsOf = cs.stops[id];
    const warnsOf = cs.warns[id];
    if (stopsOf.length && id === "deploy-values" && cs.deployUnknown) {
      item(id, "unknown", stopsOf.join("／"));
    } else if (stopsOf.length) {
      for (const m of stopsOf) bad(m);
      item(id, "action", stopsOf.join("／"), id);
    } else if (warnsOf.length) {
      for (const m of warnsOf) notes.push(`! ${m}`);
      item(id, "warn", warnsOf.join("／"));
    } else {
      item(id, "ok", `${ITEM_TITLES[id]}: 設定がそろっている`);
    }
  }

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
  } else if (unit.startedAt && (builtAtOf(main) ?? 0) > unit.startedAt) {
    unitProblem = `ビルド（または依存の入れ直し）の後に ${UNIT} を起動し直していない。動いているのは前のビルド: sudo systemctl restart ${UNIT}`;
    unitStop = "restart";
  }
  if (unitProblem) {
    bad(unitProblem);
    item("systemd", "action", unitProblem, unitStop);
  } else {
    notes.push(`ユニット ${UNIT} は動いている`);
    item("systemd", "ok", `ユニット ${UNIT} は動いていて、WorkingDirectory はチェックアウトで、.env を書いた後・ビルドした後に起動している`);
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
      "チェックアウトを動かしたら、control-plane・監視アプリのコードが変わっていればビルドし直す（次の手順で止まる。定義〈ops/・.claude/agents〉だけの変更ならビルドも再起動も要らない）",
      "同じコマンドを実行し直す",
    ]);
  }
  ctx.log(`チェックアウト ${main} は origin/main と同じ`);

  // 1b. エージェント専用の作業場（開発のリポジトリ・main のチェックアウトと 3 つとも別の場所）。欠落は周のジョブが 1 本でも有効なときだけ止める（誤りは常に止める）
  const awi = agentWorktreeIssue(ctx, main);
  if (awi && (!awi.lack || enabledCycleJobs(main).length > 0)) ctx.manual("agent-worktree", "エージェント専用の作業場（git worktree）を作り、CONTROL_WORKTREE に書く", agentWorktreeSteps(awi.text));
  if (awi)
    await ctx.confirm("agent-worktree-later", `${awi.text}（周のジョブがすべて無効。有効にする前に作る）`, [
      ...agentWorktreeSteps(awi.text).slice(0, -1),
      "同じコマンドを実行し直す。周のジョブ（ops/schedules/cycle-*.yaml）をまだ有効にしないなら、作らずに yes で進めてよい（有効にする PR の前に作る）",
    ]);
  else ctx.log(`エージェント専用の作業場 ${ctx.conf.CONTROL_WORKTREE} は、開発のリポジトリ・承認済みの main のチェックアウトと別の場所`);

  // 2. ビルド
  const builds = await buildFindings(ctx, main);
  const buildActions = builds.filter((f) => f.level === "action").map((f) => f.text);
  if (buildActions.length) ctx.manual("build", "チェックアウトで control-plane と監視アプリをビルドする（記録付き）", buildSteps(main, buildActions));
  for (const f of builds) ctx.log(`! ${f.text}`);
  ctx.log("control-plane と監視アプリのビルドは origin/main に追いついていて、依存は lockfile と同じ");

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
  if (originWarning)
    await ctx.confirm("status-origin", originWarning, [
      `今の値を見る: git -C ${ctx.WORKTREE} remote get-url origin`,
      `人が自分の端末で直す: git -C ${ctx.WORKTREE} remote set-url origin https://github.com/${statusRepositoryOf(ctx)}.git`,
      `つながることを確かめる: git -C ${ctx.WORKTREE} fetch origin（エラーが出ない）。承認済みの main のチェックアウトが別のクローンなら、そちらも同じく直す`,
      "直さずに進めると、監視アプリは毎回の起動で GitHub の API を 1 回多く呼ぶ（同じリポジトリなら動く）。そのままでよいと判断したときだけ yes（onprem/README.md の「設定の状況を有効にする」）",
    ]);
  if (githubProblem) ctx.manual("status-github", "設定の状況用の GitHub のトークン（参照専用）を作り、ファイルに書く", statusGithubSteps(githubProblem, githubFile));
  ctx.log("設定の状況用の GitHub のトークン（fine-grained PAT）でリポジトリを読めることを確かめた（読み取り専用かは確かめられない。人が Read-only を選ぶ。トークンは表示しない）");

  // 5. 本番の値 → チェックアウトの .env
  const { values, missing, cycle } = await prodValues(ctx, main, file);
  // 改善の周の設定。止まるのは、形の誤り・片方だけ・同じ値の使い回しと、周のジョブが 1 本でも有効なときの値の欠落（起点・Strapi の読み取り・配信の値）。ほかは警告
  for (const id of CYCLE_IDS) {
    if (cycle.stops[id].length) ctx.manual(id, CYCLE_TITLES[id], cycleSteps(id, cycle.stops[id]));
  }
  for (const id of CYCLE_IDS) {
    if (!cycle.warns[id].length) continue;
    await ctx.confirm(`${id}-optional`, `${CYCLE_TITLES[id]}: ${cycle.warns[id].join("／")}`, [
      ...cycleSteps(id, cycle.warns[id]).slice(0, -1),
      "同じコマンドを実行し直す。この機能をまだ使わない（skipped のままでよい）と判断したときだけ、書かずに yes",
    ]);
  }
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
  if (!env.GITHUB_TOKEN)
    await ctx.confirm("i13-github", "GITHUB_TOKEN などが無い。I-13 の起票（daily-i13-file）は skipped になる（改善の提案が PR にならない。n8n の書き出しも skipped、改修案のマージも確かめられない）", [
      "手順の全体は onprem/README.md の「I-13 の起票を有効にする（GITHUB_TOKEN）」。以下はその要約",
      `人がブラウザで、GitHub の Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token（https://github.com/settings/personal-access-tokens/new）。Resource owner は ${statusRepositoryOf(ctx).split("/")[0]}（個人アカウントではない）、Repository access は Only select repositories で ${statusRepositoryOf(ctx)} だけ、Repository permissions は Contents と Pull requests の 2 つを Read and write（Metadata は自動で Read。ほかは付けない）、Expiration を決めて作り直す日を控える。設定の状況用の参照専用のトークンとは別のトークンにする`,
      "Organization が承認を求めていれば、トークンは pending になり承認まで使えない。Organization のオーナーが Organization の Settings → Personal access tokens → Pending requests で承認する（作った人がオーナーなら自動で承認）",
      `起票をまとめる Issue を 1 つ作り、番号を控える: gh issue create --repo ${statusRepositoryOf(ctx)} --title "改善提案の起票（I-13）" --body "I-13 の PR のブランチ名に使う。閉じない。"。レビュアー（R2）は共同作業者のユーザー名で、トークンを作ったアカウントとは別の人（同じだとレビュアーの指定だけが失敗し、WARN が出る）`,
      `\${EDITOR:-nano} ~/.config/comegin/setup/prod.conf で 4 行を書く: GITHUB_TOKEN=<github_pat_…>、GITHUB_REPOSITORY=${statusRepositoryOf(ctx)}（空なら origin から補われるが明示する）、I13_ISSUE_NUMBER=<4 の Issue の番号>、I13_REVIEWER=<ユーザー名。@ は付けない>。1 つでも書いたら 4 つとも要る。echo や引数でトークンを書かない。prod.conf は 600`,
      "（推奨）トークンでリポジトリを読めること（200）・classic でないこと・持ち主がレビュアーと別なことを、画面に出さずに確かめる（コマンドは onprem/README.md の同じ節の 4。このスクリプトは書けるかまでは確かめない）",
      "同じコマンドを実行し直す（.env に写り、restart を案内される）→ sudo systemctl restart comegin-control → http://127.0.0.1:3200/jobs/daily-i13-file の「手動で起動」で skipped でなくなったことを確かめる",
      "改善の提案を PR にしない（起票を skipped のままにする）と判断したときだけ、書かずに yes",
    ]);
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
  if (unit.startedAt && (builtAtOf(main) ?? 0) > unit.startedAt) {
    ctx.manual("restart", `${UNIT} を起動し直す（ビルドした・依存を入れ直したため。動いている監視アプリは、起動したときのビルドを使い続ける）`, [
      `人が自分の端末で: sudo systemctl restart ${UNIT}`,
      `journalctl -u ${UNIT} -n 50 に「開始 scheduler=on heartbeat=on」が出ること`,
      "同じコマンドを実行し直す",
    ]);
  }
  ctx.log(`${UNIT} はチェックアウトで動いていて、.env を書いた後・ビルドした後に起動している`);

  // 7. 応答と Google ログイン
  if ((await probe(ctx)) === "down") ctx.manual("start", `監視アプリが応答しない（${LOCAL_URL}）`, unitSteps(main, `${UNIT} は active だが 3200 が応答しない（journalctl -u ${UNIT} で起動の失敗を見る。control-plane の設定不正は変数名だけが出る）`));
  const publicUrl = publicUrlOf(env);
  const domain = env.GOOGLE_HOSTED_DOMAIN || DEFAULT_HOSTED_DOMAIN;
  const google = await verifyGoogle(ctx, publicUrl, domain);
  if (!google.ok) throw new Error(`監視アプリの Google ログインを始められない: ${google.reason}`);
  ctx.log(`Google ログインを始められる（リダイレクト URI ${google.redirect}。Google のクライアントにこの URI が登録されていること）`);
  const exposed = exposureWarning(publicUrl);
  if (exposed)
    await ctx.confirm("exposed", exposed, [
      "~/.config/comegin/setup/prod.conf の CONTROL_PUBLIC_URL の行を消す（既定の http://127.0.0.1:3200 になる）か、手元の URL に書き換える",
      "ngrok などのトンネルを 3200 に張っていたら止める（本番の監視アプリは外に出さない。ADR-23 の見直しの条件）",
      `別の端末から使うときは ssh -L 3200:127.0.0.1:3200 <このマシン> で入り、${LOCAL_URL} を開く（${OPEN_MANUAL}）`,
      "Google の OAuth クライアントの承認済みのリダイレクト URI に http://127.0.0.1:3200/api/auth/callback/google があることを確かめる",
      "同じコマンドを実行し直す（.env を書き直して restart を案内される）。外に出す理由があり、それを承知で進めるときだけ yes",
    ]);

  // 8. 人の確認
  const { warnings, enabled, entries } = await operateWarnings(ctx, main);
  for (const e of entries) await ctx.confirm(e.id, e.text, e.steps);
  ctx.log(`有効な定期実行: ${enabled.length ? enabled.join("・") : "なし"}。ログイン: ${publicUrl}/login`);
}
