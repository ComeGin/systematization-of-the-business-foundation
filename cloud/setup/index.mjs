// AWS（cloud/ の SAM）の本番の段階。setup/lib/core.mjs の契約に従う。1 つのモジュールで、本番の段階のうち前の 3 つと、apps の最初を受け持つ:
//   env     本番用の環境変数の設定: 道具（aws・sam・docker・pnpm）・AWS の認証とアカウント・デプロイの設定ファイル（cloud/samconfig.toml）の必須の値
//   deploy  node cloud/deploy.mjs（sam build → sam deploy。デプロイしたコミットをパラメータ DeployedCommit に記録する）:
//           global（us-east-1）→ CloudFront の 2 つのパラメータ → 本番スタック → 人が入れる Secret の値
//           （ECR のリポジトリはこのデプロイで作られる。ECS のサービスは 0 台で作られ、イメージが無くても通る。cloud/README.md の 4.2）。
//           check は items も返す（デプロイのずれの検知。global・本番スタック・Lambda のコードが、記録のコミットから origin/main までに変わっていないか、
//           samconfig.toml とスタックのパラメータが食い違っていないか。ok と notes には混ぜない）
//   images  イメージのビルドと ECR へのプッシュ（node cloud/images/build-push.mjs <chatwoot|mautic>）: 本番スタックのパラメータ
//           ChatwootImageTag・MauticImageTag のタグが ECR にあるか
//           （タグを変えるときは、samconfig.toml にタグを書く → build-push.mjs で push → node cloud/deploy.mjs の順。ECR に無いタグをデプロイすると、
//           動いているサービスがタスクを起動できずスタックごと戻される。cloud/README.md の 4.7・4.12）。
//           check は items も返す（cloud.image-commit。イメージのタグ <タグ>-rev-<40 桁> に記録されたビルドのコミットから origin/main までに、
//           cloud/images/<製品> が変わっていないか。ok と notes には混ぜない）
//   apps    段階 apps の前提（setup/00-setup-overview.md の P4）。setup.mjs の MODULES で admin-auth より前に置き、段階 apps の先頭で動く。
//           止めるのは DB 作成のタスク（4.8。admin-auth・onprem・chatwoot-prod・mautic-prod のすべての前提）だけ。
//           ほかの人の作業（global の 2 回目・SNS の購読・SES・WireGuard の AMI の固定・オンプレの IAM のキー・SMTP の Secret）は、
//           無くても後の設定は進められるので警告だけにする（どれも以前はスクリプトが確かめていなかった）
//   operate 運用開始の確認（2026-11-02 に追加。setup/00-setup-overview.md の P15）。止めずに警告だけ: 配信用の主体（4.5.1）・
//           IAM ユーザーの古いキーの残り・prod.conf に残った初期設定用の値・SES のサンドボックス
// 段階 apps・operate の check は、止めない確認（警告）を notes（先頭が ! の文。今までどおり）と items（監視アプリの「設定の状況」が読む。
// key は cloud.<名前>、step は P 番号。警告が無ければ level ok、読めなければ unknown）の両方で返す。check は読むだけ
// （DB 作成のタスクの成功を状態に残す dbInitDone も、--check では書かない）。追跡しない cloud/samconfig.toml は ctx.WORKTREE から読む
// 段階の順番は setup/lib/runner.mjs の PROD_PHASES（ユーザーの決定。2026-10-27）。apps の後に google・operate が続く。
//
// 方針:
//   - AWS には読み取りだけ（sts get-caller-identity・cloudformation describe-stacks・ecr describe-images・secretsmanager describe-secret、
//     段階 apps は logs filter-log-events・sns list-subscriptions-by-topic・get-subscription-attributes・sesv2 get-account・get-email-identity・
//     iam list-access-keys）。AWS を読む部品は ./aws.mjs（段階 apps のほかのモジュールと共有する）。
//     デプロイ・プッシュ・Secret の値の書き込みは人が実行する（cloud/README.md の 2 節「デプロイは運用者が実行する」）ので、案内して止まる（ctx.manual）
//   - Secret は値を読まない（describe-secret は値を返さない。値が入っているかを版の有無で見るだけ）
//   - samconfig.toml は秘匿ファイル扱い（cloud/.gitignore）。読むのはパラメータの名前と、値が雛形のまま（REPLACE-ME）か空かだけで、値は出さない
//   - AWS の認証は環境（AWS_PROFILE・SSO）に任せる。子プロセスの aws はこのプロセスの環境変数をそのまま受け継ぐ
//
// 設定のキー（~/.config/comegin/setup/prod.conf。どれも任意）:
//   AWS_ACCOUNT_ID   デプロイ先のアカウント ID。既定は cloud/README.md の 2 節の単一のアカウント。違うアカウントの認証なら止める
//
// 確かめた出典:
//   cloud/README.md の 2 節（前提・SAM CLI 1.154 以上・アカウント）、4.1（global）、4.2（sam build が必須）、4.6（人が入れる Secret）、
//   4.7（派生イメージの表・X86_64・タグは不変で latest は使えない）、4.12（イメージの更新）
//   cloud/samconfig.toml.example（スタック名・REPLACE-ME の 3 つ）、cloud/stacks/ecr.yaml（comegin/<env>/chatwoot・mautic）、
//   cloud/template.yaml（ChatwootImageTag・MauticImageTag・GoogleClientId・AdminBootstrapEmails）
import { resolveTxt } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commitDrift, describeChanges, newestInMain } from "../../setup/lib/drift.mjs";
import { readUpstream } from "../lib/images.mjs";
import { parameterOverrides } from "../lib/samconfig.mjs";
import { AwsUnavailable, ENV_NAME, GLOBAL_REGION, GLOBAL_STACK, REGION, STACK, awsJson, dbInitDone, dbInitSteps, describeStack, isAwsUnavailable, outputOf, parameterOf, requireMainStack, secretHasValue, settleAwsUnavailable } from "./aws.mjs";

export const meta = { id: "cloud", title: "AWS（本番のスタック。環境変数・デプロイ・イメージ・apps の前提・運用開始の確認）", targets: ["prod"], phases: ["env", "deploy", "images", "apps", "operate"], after: [] };

const DEFAULT_ACCOUNT_ID = "798560359429"; // cloud/README.md の 2 節
const SAMCONFIG = "cloud/samconfig.toml";
const MIN_SAM = [1, 154];
const MIN_PNPM = 11;
// 雛形のまま止める値。CloudFront の 2 つは global の出力から書くので、段階 deploy で見る
const CLOUDFRONT_PARAMS = ["CloudFrontCertificateArn", "CloudFrontWebAclArn"];
// 段階 env で値を求めるパラメータ（RunLogAdminPrincipalArns は入れないとスタック自身の更新が拒否される。後の 2 つは admin-auth。4.19）
const REQUIRED_PARAMS = ["RunLogAdminPrincipalArns", "GoogleClientId", "AdminBootstrapEmails"];
// 人が入れる Secret（4.6）。FAQ ボットの 2 つは chatwoot-prod（段階 apps）がボットを作った後に案内するので、ここでは見ない
const HUMAN_SECRETS = [
  { name: "admin-auth/GOOGLE_CLIENT_SECRET", required: true, hint: "Google の OAuth クライアントのシークレット（cloud/README.md の 4.6）" },
  { name: "mautic/SMTP_USERNAME", required: false, hint: "Mautic 用の SES の SMTP 認証情報（4.9）" },
  { name: "mautic/SMTP_PASSWORD", required: false, hint: "同上" },
  { name: "chatwoot/SMTP_USERNAME", required: false, hint: "Chatwoot 用の SES の SMTP 認証情報（4.9。Mautic とは別に発行）" },
  { name: "chatwoot/SMTP_PASSWORD", required: false, hint: "同上" },
];
// 派生イメージ（上流のタグとダイジェストは cloud/images/<製品>/upstream.json が正本。cloud/README.md の 4.7 の表は、版を上げたらそれに合わせる）
const IMAGES = [
  { product: "chatwoot", label: "Chatwoot", param: "ChatwootImageTag", repo: `comegin/${ENV_NAME}/chatwoot`, dir: "cloud/images/chatwoot", upstreamTag: readUpstream("chatwoot").tag, upstreamDigest: readUpstream("chatwoot").digest },
  { product: "mautic", label: "Mautic", param: "MauticImageTag", repo: `comegin/${ENV_NAME}/mautic`, dir: "cloud/images/mautic", upstreamTag: readUpstream("mautic").tag, upstreamDigest: readUpstream("mautic").digest },
];
// Lambda のコード（cloud/stacks/services/*.yaml の CodeUri が指す 3 パッケージ。admin-auth-ops も backend/admin-auth）。sam build の入力だけを比べる。
// faq-bot は Astro の faq.json を実行時に読むので faq-export は含めない。*.md・テスト類は setup/lib/drift.mjs の NON_CODE_EXCLUDES が除く
const LAMBDA_PACKAGES = ["backend/faq-bot", "backend/consent-api", "backend/admin-auth"];
const LAMBDA_INPUTS = ["src", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "Makefile", "tsconfig.json"];
export const LAMBDA_PATHS = LAMBDA_PACKAGES.flatMap((pkg) => LAMBDA_INPUTS.map((f) => `${pkg}/${f}`));
const DEPLOY_COMMAND = "node cloud/deploy.mjs";
const DEPLOY_GLOBAL_COMMAND = "node cloud/deploy.mjs --config-env global";
const COMMIT = /^[0-9a-f]{40}$/;
// イメージの記録のタグ <本来のタグ>-rev-<40 桁のコミット>（cloud/images/build-push.mjs が付ける）
const REV_TAG = /-rev-([0-9a-f]{40})$/;
const COMPLETE = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "IMPORT_COMPLETE"]);

// ---------------------------------------------------------------------------
// AWS（読み取りだけ。共通の部品は ./aws.mjs）
// ---------------------------------------------------------------------------

async function callerIdentity(ctx) {
  try {
    return await awsJson(ctx, ["sts", "get-caller-identity"]);
  } catch (e) {
    throw new AwsUnavailable(`AWS の認証が使えない（aws sts get-caller-identity が失敗した。AWS_PROFILE か aws sso login を確かめる）\n${e.message}`);
  }
}

/** ECR のイメージ 1 つの describe-images の imageDetails[0]。無ければ null */
async function describeImage(ctx, repo, tag) {
  const r = await awsJson(ctx, ["ecr", "describe-images", "--region", REGION, "--repository-name", repo, "--image-ids", `imageTag=${tag}`]);
  return r?.imageDetails?.[0] ?? null;
}

async function imageExists(ctx, repo, tag) {
  return Boolean(await describeImage(ctx, repo, tag));
}

// ---------------------------------------------------------------------------
// samconfig.toml（名前と「雛形のまま・空か」だけを見る。値は出さない）
// ---------------------------------------------------------------------------

/** parameter_overrides の "Key=Value" を名前 → 値の Map にする。ファイルが無ければ null */
function samParameters(ctx) {
  // 追跡しない実行時のファイル。コードを main のチェックアウトから動かすとき（監視アプリ）も、作業ツリーのものを読む
  const file = join(ctx.WORKTREE, SAMCONFIG);
  if (!existsSync(file)) return null;
  const params = new Map();
  for (const m of readFileSync(file, "utf8").matchAll(/"([A-Za-z0-9]+)=([^"]*)"/g)) params.set(m[1], m[2]);
  return params;
}

const unset = (params, key) => !params.get(key) || params.get(key).includes("REPLACE-ME");

// ---------------------------------------------------------------------------
// 段階 env
// ---------------------------------------------------------------------------

async function toolProblems(ctx) {
  const problems = [];
  for (const cmd of ["aws", "sam", "docker", "pnpm"]) if (!(await ctx.commandExists(cmd))) problems.push(`${cmd} が無い`);
  if (!problems.some((p) => p.startsWith("sam "))) {
    const v = (await ctx.run("sam", ["--version"])).match(/(\d+)\.(\d+)/);
    if (v && (Number(v[1]) < MIN_SAM[0] || (Number(v[1]) === MIN_SAM[0] && Number(v[2]) < MIN_SAM[1]))) problems.push(`SAM CLI が ${v[0]}（${MIN_SAM.join(".")} 以上が要る）`);
  }
  if (!problems.some((p) => p.startsWith("pnpm "))) {
    const v = (await ctx.run("pnpm", ["--version"])).match(/(\d+)\./);
    if (v && Number(v[1]) < MIN_PNPM) problems.push(`pnpm が ${v[1]} 系（sam build が Lambda をまとめるのに ${MIN_PNPM} 以上が要る）`);
  }
  return problems;
}

function envSamProblems(params) {
  if (!params) return [`${SAMCONFIG} が無い`];
  return REQUIRED_PARAMS.filter((k) => unset(params, k)).map((k) => `${SAMCONFIG} の ${k} が空か雛形のまま`);
}

function envSteps(problems) {
  return [
    `足りないもの: ${problems.join("／")}`,
    "道具: AWS CLI・SAM CLI（1.154 以上）・Docker・pnpm 11 を入れる（cloud/README.md の 2 節）。AWS の認証は AWS_PROFILE か aws sso login で行い、設定ファイルにキーを書かない",
    `デプロイの設定ファイル: cp cloud/samconfig.toml.example ${SAMCONFIG}（chmod 600。Git で追跡しない）→ エディタで parameter_overrides に書く`,
    "  - RunLogAdminPrincipalArns: デプロイに使う主体（IAM ユーザー comegin-iam など）の ARN（入れないとスタック自身の更新が拒否される）",
    "  - GoogleClientId: admin-auth の Google の OAuth クライアント ID／AdminBootstrapEmails: 管理者の許可リストの初期値（カンマ区切り。空のまま migrate すると誰もログインできない。4.19）",
    "  - CloudFrontCertificateArn・CloudFrontWebAclArn は雛形のままでよい（次の段階 deploy で global の出力から書く）",
    "  - 既定と違う値（DesiredCount・イメージのタグなど）はすべてここに書き、正本にする（既存のスタックでは、書かなかったパラメータは前の値のまま残る〈SAM CLI が UsePreviousValue を渡す。cloud/README.md の 4.2.0〉。既定値に戻すには、既定値をここに明示して書く。2 節の「重要」）",
    "同じコマンドを実行し直す",
  ];
}

/** { problems, notes, awsDown }。awsDown は AWS の認証を確かめられなかったときの 1 行（problems には入れない。check と apply で扱いが違う） */
async function checkEnv(ctx) {
  const notes = [];
  const problems = await toolProblems(ctx);
  let id = null;
  let awsDown = null;
  if (!problems.some((p) => p.startsWith("aws "))) {
    try {
      id = await callerIdentity(ctx);
    } catch (e) {
      if (!isAwsUnavailable(e)) throw e;
      awsDown = e.message.split("\n")[0];
    }
  }
  const expected = ctx.value("AWS_ACCOUNT_ID") || DEFAULT_ACCOUNT_ID;
  if (id && id.Account !== expected) problems.push(`AWS の認証のアカウントが ${id.Account}（デプロイ先は ${expected}。AWS_PROFILE を確かめる）`);
  problems.push(...envSamProblems(samParameters(ctx)));
  if (id) notes.push(`AWS の認証: ${id.Arn}`);
  return { problems, notes, awsDown };
}

// ---------------------------------------------------------------------------
// 段階 deploy
// ---------------------------------------------------------------------------

function globalSteps() {
  return [
    `${DEPLOY_GLOBAL_COMMAND}（us-east-1 の ACM 証明書と CloudFront 用 WAF。sam deploy の包みで、デプロイしたコミットを DeployedCommit に記録する。未コミットの変更があると止まる。ACM の DNS 検証に数分かかる。cloud/README.md の 4.1）`,
    "同じコマンドを実行し直す（出力を読み、次に samconfig.toml に書く値を表示する）",
  ];
}

// 初回の作成が失敗して戻されたスタック（ROLLBACK_COMPLETE）は更新できず、消して作り直すしかない。
// DeletionPolicy: Retain のリソースは戻しても消えずに残り、固定の名前なので、次の作成が「既にある」で失敗する（2026-10-27 の初回で起きた）
function rollbackSteps() {
  return [
    "CloudFormation のイベントで失敗したリソースと理由を確かめ、テンプレートを直す（入れ子のスタックは、親のイベントの「Embedded stack ... was not successfully created」の ARN のイベントを見る。Validation failure は aws cloudformation describe-events --stack-name <その ARN> --filters FailedEvents=true）",
    `スタックを消す: aws cloudformation delete-stack --region ${REGION} --stack-name ${STACK} → aws cloudformation wait stack-delete-complete --region ${REGION} --stack-name ${STACK}`,
    "同じコマンドを実行し直す（戻しても残った Retain のリソースがあれば、次に削除のコマンドを表示する）",
  ];
}

// 本番スタックが無いときに、あってはならない固定の名前の Retain のリソース（作成の失敗で残ったもの）。
// あると sam deploy が NAME_CONFLICT_VALIDATION か AlreadyExists で失敗する（2026-10-27 の 2 回目で起きた）。
// 名前は cloud/stacks/observability.yaml・secrets.yaml・runlog-archive.yaml・ecr.yaml
async function leftovers(ctx, account) {
  const found = [];
  const topics = (await awsJson(ctx, ["sns", "list-topics", "--region", REGION]))?.Topics ?? [];
  for (const name of ["comegin-lead-alert", "comegin-ops-alert"]) {
    const arn = topics.map((t) => t.TopicArn).find((a) => a.endsWith(`:${name}`));
    if (arn) found.push({ label: `SNS ${name}`, command: `aws sns delete-topic --region ${REGION} --topic-arn ${arn}` });
  }
  const secrets = (await awsJson(ctx, ["secretsmanager", "list-secrets", "--region", REGION, "--filters", `Key=name,Values=comegin/${ENV_NAME}/`]))?.SecretList ?? [];
  // 名前の前方一致なので、念のため接頭辞で絞り直す。--force-delete-without-recovery を付けないと、同じ名前が 7〜30 日使えない
  for (const s of secrets.filter((x) => x.Name.startsWith(`comegin/${ENV_NAME}/`))) {
    found.push({ label: `Secret ${s.Name}`, command: `aws secretsmanager delete-secret --region ${REGION} --secret-id ${s.Name} --force-delete-without-recovery` });
  }
  const bucket = `comegin-${ENV_NAME}-runlog-archive-${account}`;
  const buckets = (await awsJson(ctx, ["s3api", "list-buckets"]))?.Buckets ?? [];
  if (buckets.some((b) => b.Name === bucket)) found.push({ label: `S3 ${bucket}`, command: `aws s3api delete-bucket --region ${REGION} --bucket ${bucket}（空でなければ先に中身を確かめる。消せないなら止まって相談する）` });
  const repos = (await awsJson(ctx, ["ecr", "describe-repositories", "--region", REGION]))?.repositories ?? [];
  for (const img of IMAGES) {
    if (repos.some((r) => r.repositoryName === img.repo)) found.push({ label: `ECR ${img.repo}`, command: `aws ecr delete-repository --region ${REGION} --repository-name ${img.repo}（--force は付けない。イメージがあれば失敗して止まる）` });
  }
  return found;
}

function leftoverSteps(found) {
  return [
    `本番スタックが無いのに、固定の名前のリソースが ${found.length} 個残っている（前の作成の失敗で、DeletionPolicy: Retain のものが戻されずに残った）。このままでは sam deploy が名前の衝突で失敗する`,
    "中身が空か（作りかけで、データが無いか）を確かめてから消す。データがあるなら消さずに止まって相談する（CloudFormation のリソースのインポートで取り込む）:",
    ...found.map((f) => `  ${f.label}: ${f.command}`),
    "同じコマンドを実行し直す",
  ];
}

function mainSteps() {
  return [
    `${DEPLOY_COMMAND}（リポジトリのルートから。sam build → sam deploy を順に行い、デプロイしたコミットを DeployedCommit に記録する。cloud/・Lambda の 3 パッケージに未コミットの変更があると止まる〈記録が嘘になるため〉。生の sam build・sam deploy は使わない）`,
    "  - sam build は必須（faq-bot・consent-api・admin-auth の Lambda を pnpm と esbuild でまとめる。飛ばすと index.handler の無い zip になり、同意の受け口とログインが 502 になる）。スクリプトが実行する",
    "  - sam deploy の変更セットを確かめてから答える。初回は RDS・ElastiCache・ACM の検証で 30 分前後。ECR のリポジトリもここで作られる。ECS のサービスは 0 台で作られ、イメージがまだ無くても通る。cloud/README.md の 4.2",
    "同じコマンドを実行し直す",
  ];
}

function stackProblem(stack, name) {
  if (!stack) return `スタック ${name} が無い`;
  if (stack.StackStatus.endsWith("_IN_PROGRESS")) return `スタック ${name} が ${stack.StackStatus}（終わるまで待つ）`;
  if (stack.StackStatus === "ROLLBACK_COMPLETE") return `スタック ${name} が ROLLBACK_COMPLETE（初回の作成が失敗して戻された。更新できないので、消して作り直す）`;
  if (!COMPLETE.has(stack.StackStatus)) return `スタック ${name} が ${stack.StackStatus}（CloudFormation のイベントで原因を確かめる。cloud/README.md の 4.2）`;
  return null;
}

async function missingSecrets(ctx) {
  const missing = [];
  for (const s of HUMAN_SECRETS) if ((await secretHasValue(ctx, s.name)) !== true) missing.push(s);
  return missing;
}

function secretSteps(missing) {
  return [
    `値が入っていない Secret: ${missing.map((s) => `comegin/${ENV_NAME}/${s.name}（${s.hint}）`).join("、")}`,
    "シェルの履歴に残らない方法で入れる（人が自分の端末で実行する）: read -rs SECRET_VALUE → aws secretsmanager put-secret-value --region ap-northeast-1 --secret-id <名前> --secret-string \"$SECRET_VALUE\" → unset SECRET_VALUE（cloud/README.md の 4.6）",
    "同じコマンドを実行し直す",
  ];
}

// ---------------------------------------------------------------------------
// 段階 deploy のずれの検知（items だけ。ok と notes には混ぜない。docs/superpowers/specs/2026-11-11-deploy-drift-detection-design.md の 4.1・4.2）
// 本番で動いているスタック・Lambda のコードが作られたときのコミット（スタックのパラメータ DeployedCommit。node cloud/deploy.mjs が記録する）から
// origin/main までに、関係するパスを変えたコミットがあれば action。origin/main を新しくするのは人の fetch か監視アプリの fetchMain。
// git が使えない・origin/main が読めないときは、その項目だけ unknown
// ---------------------------------------------------------------------------

const firstLine = (e) => String(e?.message ?? e).split("\n")[0];
const shortSha = (sha) => sha.slice(0, 7);

/**
 * スタックの Parameters（DeployedCommit・samconfig との比較）を信用できない状態か。信用できるなら null。
 * 信用するのは COMPLETE の状態（CREATE_COMPLETE・UPDATE_COMPLETE・UPDATE_ROLLBACK_COMPLETE・IMPORT_COMPLETE）だけ。
 * ROLLBACK_COMPLETE（初回の作成が失敗して戻された）や *_FAILED のスタックも、試みたときの Parameters を返すので、動いているものが無いのに ✓ になってしまう。
 * 返す判定: スタックが無い・ROLLBACK_COMPLETE（消して作り直す）→ action、更新中・*_FAILED などそのほか → unknown
 */
function untrustedStack(stack, name, region, fix) {
  if (!stack) return { level: "action", evidence: `スタック ${name} が無い。${fix}` };
  if (COMPLETE.has(stack.StackStatus)) return null;
  if (stack.StackStatus === "ROLLBACK_COMPLETE") {
    return { level: "action", evidence: `${stackProblem(stack, name)}。動いているものが無い。消す: aws cloudformation delete-stack --region ${region} --stack-name ${name} → ${fix}（cloud/README.md の 4.2）` };
  }
  return { level: "unknown", evidence: `${stackProblem(stack, name)}。この状態のパラメータ（DeployedCommit）は信用できないので比べない` };
}

/**
 * コミットの項目 1 つの判定 { level, evidence }。stack は describe-stacks の結果（無ければ null）。
 * 記録が 40 桁の小文字の16進でも unrecorded でもない（空・欠け・その他）ときは、commitDrift に渡さず「記録が無い」にする（commitDrift は値を検査しない）
 */
async function commitVerdict(ctx, stack, { name, region, paths, what, fix }) {
  const untrusted = untrustedStack(stack, name, region, fix);
  if (untrusted) return untrusted;
  const raw = parameterOf(stack, "DeployedCommit");
  const drift = await commitDrift(ctx, { recorded: COMMIT.test(raw ?? "") ? raw : null, paths });
  switch (drift.kind) {
    case "unrecorded":
      return { level: "action", evidence: `デプロイしたコミットの記録が無い（この仕組みより前のデプロイ）。記録付きでデプロイし直す: ${fix}` };
    case "outside-main":
      return { level: "warn", evidence: `記録のコミット ${shortSha(drift.commit)} が origin/main の履歴に無い（main 以外からのデプロイか、git fetch していない。fetch するか、main のチェックアウトで記録付きでデプロイし直す: ${fix}）` };
    case "changed":
      return { level: "action", evidence: `記録のコミット ${shortSha(drift.commit)} の後に、${what}が origin/main で変わった（${describeChanges(drift.entries)}）。記録付きでデプロイし直す: ${fix}（生の sam deploy では記録が前のままで、このまま出続ける）` };
    default:
      return { level: "ok", evidence: `記録のコミット ${shortSha(drift.commit)} から origin/main までに、${what}の変更は無い` };
  }
}

/** 比べる前の整え方。前後の空白を除き、外側の二重引用符 1 組を外す（書き方の違いで ● が消えなくならないように） */
const normalizeValue = (v) => {
  const t = String(v).trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
};

/** cloud.stack-params: samconfig.toml（作業ツリーの追跡しないファイル）の parameter_overrides と、デプロイ済みスタックの Parameters の食い違い。名前だけを出し、値は出さない */
function paramsVerdict(ctx, global, main) {
  const file = join(ctx.WORKTREE, SAMCONFIG);
  if (!existsSync(file)) return { level: "unknown", evidence: `${SAMCONFIG} が作業ツリーに無く、スタックのパラメータと比べられない` };
  const parts = [
    { label: "本番スタック", name: STACK, stack: main, env: "default", fix: DEPLOY_COMMAND },
    { label: "global", name: GLOBAL_STACK, stack: global, env: "global", fix: DEPLOY_GLOBAL_COMMAND },
  ];
  const text = readFileSync(file, "utf8");
  const differing = [];
  const skipped = [];
  const uncomparable = [];
  let compared = 0;
  for (const part of parts) {
    // COMPLETE でないスタックの Parameters は信用できない（失敗して戻されたスタックなど。ずれは commit の項目が action / unknown で示す）
    if (!part.stack || !COMPLETE.has(part.stack.StackStatus)) {
      skipped.push(`${part.label}（${part.stack ? part.stack.StackStatus : "スタックが無い"}）`);
      continue;
    }
    const names = [];
    let comparedHere = 0;
    for (const item of parameterOverrides(text, part.env)) {
      const eq = item.indexOf("=");
      if (eq <= 0) continue;
      const key = item.slice(0, eq);
      if (key === "DeployedCommit") continue; // デプロイのたびに変わる記録。比べない
      const deployed = part.stack.Parameters?.find((p) => p.ParameterKey === key);
      if (deployed?.ParameterValue === "****") continue; // NoEcho は値を読めない
      compared++;
      comparedHere++;
      if (!deployed || normalizeValue(deployed.ParameterValue ?? "") !== normalizeValue(item.slice(eq + 1))) names.push(key);
    }
    if (comparedHere === 0) uncomparable.push(`${part.label}（${SAMCONFIG} の [${part.env}.deploy.parameters] の parameter_overrides に比べられるパラメータが無い。表の名前の書き間違いか）`);
    if (names.length) differing.push(`${part.label}: ${names.join("・")}（反映する: ${part.fix}）`);
  }
  if (differing.length) return { level: "action", evidence: `${SAMCONFIG} とデプロイ済みのスタックでパラメータの値が違う（名前だけを表示する。書き換えたのにデプロイしていないか、スタックを手で変えた）／${differing.join("／")}` };
  if (skipped.length || uncomparable.length) return { level: "unknown", evidence: [...(skipped.length ? [`比べられなかったスタック: ${skipped.join("・")}`] : []), ...uncomparable.map((u) => `比べるパラメータが無い: ${u}`)].join("／") };
  return { level: "ok", evidence: `${SAMCONFIG} の ${compared} 個のパラメータは、デプロイ済みのスタックと同じ値（NoEcho の値と DeployedCommit は比べない）` };
}

/** 段階 deploy の items（step は P2）。コミットの 3 項目は git が使えなければ項目ごとに unknown、パラメータの項目は読めなければ unknown。例外は投げない */
async function deployDriftItems(ctx, global, main) {
  const specs = [
    { key: "cloud.global-commit", title: "global（us-east-1）のデプロイが origin/main に追いついている", stack: global, name: GLOBAL_STACK, region: GLOBAL_REGION, paths: ["cloud/global"], what: "global のテンプレート（cloud/global）", fix: DEPLOY_GLOBAL_COMMAND },
    { key: "cloud.stack-commit", title: "本番スタックのデプロイが origin/main に追いついている", stack: main, name: STACK, region: REGION, paths: ["cloud/template.yaml", "cloud/stacks"], what: "本番のテンプレート（cloud/template.yaml・cloud/stacks）", fix: DEPLOY_COMMAND },
    { key: "cloud.lambda-code", title: "Lambda のコードのデプロイが origin/main に追いついている", stack: main, name: STACK, region: REGION, paths: LAMBDA_PATHS, what: "Lambda のコード（backend/faq-bot・consent-api・admin-auth）", fix: DEPLOY_COMMAND },
  ];
  const items = [];
  for (const { key, title, ...spec } of specs) {
    let verdict;
    try {
      verdict = await commitVerdict(ctx, spec.stack, spec);
    } catch (e) {
      verdict = { level: "unknown", evidence: `origin/main との差を git で確かめられない（${firstLine(e)}）` };
    }
    items.push({ key, step: "P2", title, ...verdict });
  }
  let params;
  try {
    params = paramsVerdict(ctx, global, main);
  } catch (e) {
    params = { level: "unknown", evidence: `${SAMCONFIG} とスタックのパラメータを比べられない（${firstLine(e)}）` };
  }
  items.push({ key: "cloud.stack-params", step: "P2", title: "samconfig.toml とデプロイ済みスタックのパラメータが同じ", ...params });
  return items;
}

// ---------------------------------------------------------------------------
// 段階 images
// ---------------------------------------------------------------------------

function imageSteps(account, missing) {
  const ecr = `${account}.dkr.ecr.${REGION}.amazonaws.com`;
  return [
    `ECR に無いイメージ: ${missing.map((m) => `${m.repo}:${m.tag}`).join("、")}（タグは本番スタックのパラメータ ${missing.map((m) => m.param).join("・")} の今の値）`,
    `ECR にログインする: aws ecr get-login-password --region ${REGION} | docker login --username AWS --password-stdin ${ecr}`,
    ...missing.map(
      (m) =>
        `${m.label}: node cloud/images/build-push.mjs ${m.product}（リポジトリのルートで実行。タグは samconfig.toml の ${m.param} から読み、${m.dir} に未コミットの変更があると止まる。<タグ> と、ビルドしたコミットを残す <タグ>-rev-<コミット> の 2 つを push する。上流のタグとダイジェストは ${m.dir}/upstream.json。--platform linux/amd64 もスクリプトが付ける〈Fargate は X86_64〉。生の docker build・push は使わない）`,
    ),
    "ECR のタグは上書きできない。作り直すときは連番を上げたタグを samconfig.toml の同じパラメータに書き、node cloud/images/build-push.mjs で push してから node cloud/deploy.mjs でデプロイする（push が先。ECR に無いタグをデプロイすると、動いているサービスがタスクを起動できず、スタックごと UPDATE_ROLLBACK になる。cloud/README.md の 4.7・4.12）",
    "同じコマンドを実行し直す",
  ];
}

// 段階 images のずれの検知（items だけ。ok と notes には混ぜない）。スタックのパラメータが指すタグのイメージについた記録のタグ
// <タグ>-rev-<40 桁> から、ビルドしたコミットを読む。そのコミットから origin/main までに cloud/images/<製品> が変わっていれば action。
// 記録のタグが複数あれば（同じ中身に別のコミットで足された）origin/main までのコミット数が最も少ない（最も新しい）ものを記録とする。
// git が使えない・origin/main が読めないときは、そのイメージだけ unknown

/** イメージ 1 つの判定 { level, evidence }。image は describeImage の結果（ECR に無ければ null） */
async function imageVerdict(ctx, img, tag, image) {
  const fix = `node cloud/images/build-push.mjs ${img.product}`;
  // ECR のタグは上書きできない（IMMUTABLE）ので、ビルドし直すときは連番を上げたタグにする。push が先で、デプロイが後（ECR に無いタグをデプロイすると、
  // 動いているサービスがタスクを起動できず、サーキットブレーカーでスタックごと戻される）。順番は imageSteps・cloud/README.md の 4.7・4.12 と同じ
  const rebuild = `連番を上げたタグを samconfig.toml の ${img.param} に書く → ${fix} → ${DEPLOY_COMMAND}`;
  if (!tag) return { level: "action", evidence: `スタックのパラメータ ${img.param} が空（samconfig.toml に書いて ${DEPLOY_COMMAND}。cloud/README.md の 4.7）` };
  if (!image) return { level: "action", evidence: `${img.repo}:${tag} が ECR に無い。ビルドして push する: ${fix}` };
  const revs = (image.imageTags ?? []).map((t) => REV_TAG.exec(t)?.[1]).filter(Boolean);
  const recorded = revs.length ? ((await newestInMain(ctx, revs)) ?? revs[0]) : null; // どれも origin/main に無ければ、先頭を outside-main として示す
  const drift = await commitDrift(ctx, { recorded, paths: [img.dir] });
  switch (drift.kind) {
    case "unrecorded":
      return { level: "action", evidence: `ビルドしたコミットの記録が無い（${tag}-rev-<コミット> のタグが付いていない。この仕組みより前のビルド、または生の docker build・push）。記録付きでビルドし直す: ${rebuild}` };
    case "outside-main":
      return { level: "warn", evidence: `記録のコミット ${shortSha(drift.commit)} が origin/main の履歴に無い（main 以外からのビルドか、git fetch していない。fetch するか、main のチェックアウトで記録付きでビルドし直す: ${rebuild}）` };
    case "changed":
      return { level: "action", evidence: `記録のコミット ${shortSha(drift.commit)} の後に、${img.dir} が origin/main で変わった（${describeChanges(drift.entries)}）。ビルドし直す: ${rebuild}` };
    default:
      return { level: "ok", evidence: `記録のコミット ${shortSha(drift.commit)} から origin/main までに、${img.dir} の変更は無い` };
  }
}

const LEVEL_WEIGHT = { ok: 0, unknown: 1, warn: 2, action: 3 };

/** cloud.image-commit（step は P3）。2 つのイメージの判定のうち重いほうの level。images は describeImage の結果（IMAGES と同じ順）。例外は投げない */
async function imageDriftItems(ctx, main, images) {
  const title = "派生イメージ（Chatwoot・Mautic）のビルドが origin/main に追いついている";
  // タグを読むスタックが COMPLETE でなければ、パラメータは信用できない（Task 4 の untrustedStack と同じ扱い）
  const untrusted = untrustedStack(main, STACK, REGION, DEPLOY_COMMAND);
  if (untrusted) return [{ key: "cloud.image-commit", step: "P3", title, ...untrusted }];
  const parts = [];
  for (const [i, img] of IMAGES.entries()) {
    let verdict;
    try {
      verdict = await imageVerdict(ctx, img, parameterOf(main, img.param), images[i]);
    } catch (e) {
      verdict = { level: "unknown", evidence: `origin/main との差を git で確かめられない（${firstLine(e)}）` };
    }
    parts.push({ label: img.label, ...verdict });
  }
  const level = parts.reduce((worst, p) => (LEVEL_WEIGHT[p.level] > LEVEL_WEIGHT[worst] ? p.level : worst), "ok");
  return [{ key: "cloud.image-commit", step: "P3", level, title, evidence: parts.map((p) => `${p.label}: ${p.evidence}`).join("／") }];
}

// ---------------------------------------------------------------------------
// 段階 apps（apps の前提。setup/00-setup-overview.md の P4 と 4 節）
// ---------------------------------------------------------------------------

const DB_ENGINES = ["postgres", "mysql"];

async function missingDbInit(ctx, main, opts) {
  const missing = [];
  for (const engine of DB_ENGINES) if (!(await dbInitDone(ctx, main, engine, opts))) missing.push(engine);
  return missing;
}

/**
 * 人の作業の確認（「!」）の集め方。確認ごとに項目（key・step。監視アプリの「設定の状況」が読む）を持ち、人向けの文（texts）は順番に集める。
 * apply は entries（文・手順・削除系か）を順に見て、削除系は ctx.warn（止めない）、それ以外は ctx.confirm（yes で進む。2026-11-10）にする。
 * 項目の level: 警告の文があれば warn、確かめられなかったものだけなら unknown、どちらも無ければ ok
 */
function findings() {
  const texts = [];
  const entries = [];
  const handles = [];
  const list = (h) => [].concat(h);
  const self = {
    texts,
    entries,
    item(key, step, title, okEvidence) {
      const h = { key, step, title, okEvidence, warns: [], unknowns: [] };
      handles.push(h);
      return h;
    },
    /** 警告の文を足す（人向けの文にも出る）。steps は詳しい操作の手順、deletion は変数・キーの削除（消し忘れ）の注意なら true（止めない） */
    warn(h, text, steps = [], { deletion = false } = {}) {
      h.warns.push(text);
      texts.push(text);
      entries.push({ id: h.key.replace(/^cloud\./, ""), text, steps, deletion });
    },
    /** 確かめられなかった（人向けの文に 1 回だけ出し、項目のすべてに付ける） */
    unknown(h, text) {
      for (const x of list(h)) x.unknowns.push(text);
      texts.push(text);
      entries.push({ id: `${list(h)[0].key.replace(/^cloud\./, "")}-unknown`, text, steps: unknownSteps(), deletion: false });
    },
    /** 人向けの文には出さず、項目だけを「確かめられなかった」にする（確かめる対象そのものが無かったとき） */
    quiet(h, text) {
      for (const x of list(h)) x.unknowns.push(text);
    },
    /** 1 つの確かめが読めなくても（権限・一時的な失敗）、ほかを続ける。読めなかったことは警告に残す */
    async attempt(h, label, fn) {
      try {
        await fn();
      } catch (e) {
        self.unknown(h, `${label}を確かめられない（${e.message.split("\n")[0]}）`);
      }
    },
    items() {
      return handles.map((h) => {
        const level = h.warns.length ? "warn" : h.unknowns.length ? "unknown" : "ok";
        const evidence = level === "ok" ? h.okEvidence : [...h.warns, ...h.unknowns].join("／");
        return { key: h.key, step: h.step, level, title: h.title, evidence };
      });
    },
  };
  return self;
}

/** findings の entries を apply で表示する。削除系は止めずに「!」、それ以外は yes の入力を待つ（yes 以外なら止まる） */
async function settleEntries(ctx, entries) {
  for (const e of entries) {
    if (e.deletion) ctx.warn(`${e.text}（削除の注意。止めずに進む）`);
    else await ctx.confirm(e.id, e.text, e.steps);
  }
}

// ---------------------------------------------------------------------------
// 「!」の詳しい手順（2026-11-10。どれも人が自分の端末か AWS のコンソールで行う。Claude Code の実行環境では行わない）
// ---------------------------------------------------------------------------

const OUT_FN = `OUT() { aws cloudformation describe-stacks --region ${REGION} --stack-name ${STACK} --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }`;

function unknownSteps() {
  return [
    "AWS の認証を確かめる: aws sts get-caller-identity（期限切れなら aws sso login --profile <管理者のプロファイル>。AWS_PROFILE が本番の管理者を指しているか）",
    "上の文の「（…）」にある AWS のエラーを読む。AccessDenied なら、実行している主体に読み取りの権限（cloudformation・sns・sesv2・iam・secretsmanager）があるかを確かめる",
    "直したら同じコマンドを実行し直す。確かめられないまま進めてよい（後で node setup/setup.mjs --target prod --phase apps --only cloud --check で確かめ直す）と判断したときだけ yes",
  ];
}

function globalSecondSteps() {
  return [
    `本番スタックの出力 DistributionArn を取る: ${OUT_FN} のあと OUT DistributionArn`,
    "cloud/samconfig.toml の [global.deploy.parameters] の parameter_overrides に \"DistributionArn=<上の ARN>\" を足す（エディタで。値は秘密ではない）",
    `${DEPLOY_GLOBAL_COMMAND}（us-east-1。PlanTier の既定 FREE は即時に有効で $0。cloud/README.md の 4.3）`,
    `確かめる: aws cloudformation describe-stacks --region ${GLOBAL_REGION} --stack-name ${GLOBAL_STACK} --query "Stacks[0].Parameters[?ParameterKey=='DistributionArn'].ParameterValue" --output text が空でない`,
    "購読できない（Free Tier のアカウントなど）ので従量課金（CloudFront と WAF の費用）のまま運用すると決めたときだけ、手順を飛ばして yes",
  ];
}

function snsSubscribeSteps(arn, { unsubscribeArn } = {}) {
  return [
    ...(unsubscribeArn ? [`確認に認証が付いていない購読を解除する: aws sns unsubscribe --region ${REGION} --subscription-arn ${unsubscribeArn}`] : []),
    `購読を申し込む: aws sns subscribe --region ${REGION} --topic-arn ${arn} --protocol email --notification-endpoint <通知を受けるメールアドレス>`,
    "届いた確認メールのリンクは開かない（開くと認証なしで確認され、だれでも解除できる購読になる）。「Confirm subscription」のリンクの URL をコピーし、Token= の後ろ（& の前まで）を写す",
    `認証付きで確認する: aws sns confirm-subscription --region ${REGION} --topic-arn ${arn} --token <写した Token> --authenticate-on-unsubscribe true`,
    `確かめる: aws sns list-subscriptions-by-topic --region ${REGION} --topic-arn ${arn} --query 'Subscriptions[].SubscriptionArn' --output text が arn: で始まる（PendingConfirmation ではない）。cloud/README.md の 4.4`,
  ];
}

function sesProductionSteps({ beforeSite }) {
  return [
    ...(beforeSite
      ? ["公開サイト https://comegin.com をまだ配信していないなら、今は申請しない（審査で Web サイトを見る。2026-10-28 の決定）。配信（cloud/README.md の 4.14）の後に申請すると決めて yes で進めてよい。配信済みなら次へ"]
      : []),
    "SES のコンソールを開く（リージョンは アジアパシフィック（東京）。ほかのリージョンの状態は関係ない）→ 左の Account dashboard",
    "「Your Amazon SES account is in the sandbox」の右の View Get set up page → Request production access",
    "Mail type: Transactional／Website URL: https://comegin.com／Additional contacts: SES からの連絡を受ける運用のアドレス／Preferred contact language: Japanese／Acknowledgement: 同意 → Submit request",
    `（CLI なら）aws sesv2 put-account-details --region ${REGION} --production-access-enabled --mail-type TRANSACTIONAL --website-url https://comegin.com --contact-language JA --additional-contact-email-addresses <連絡先のアドレス>`,
    "審査は最初の応答まで最大 96 時間。使い方の説明を求められたら、サポートセンターのそのケースに cloud/README.md の 4.9.2 の文案で返信する",
    `状態を見る: aws sesv2 get-account --region ${REGION} --query '{Production:ProductionAccessEnabled, Review:Details.ReviewDetails.Status, Suppression:SuppressionAttributes.SuppressedReasons}'（Production が true で解除。Suppression は ["BOUNCE","COMPLAINT"]）`,
    "審査中は顧客にメールが届かない（検証済みの宛先だけ）。申請して審査を待つあいだは yes で進めてよい",
  ];
}

function sesIdentityMissingSteps(domain) {
  return [
    `確かめる: aws sesv2 get-email-identity --region ${REGION} --email-identity ${domain}（NotFoundException なら無い）`,
    `本番スタックの状態を見る: aws cloudformation describe-stacks --region ${REGION} --stack-name ${STACK} --query 'Stacks[0].StackStatus' --output text（*_COMPLETE であること）`,
    `ses.yaml の DomainName（samconfig.toml の DomainName）が上のドメインと同じかを確かめ、違えば直して ${DEPLOY_COMMAND}（cloud/README.md の 4.2）`,
    "同じコマンドを実行し直す",
  ];
}

function sesVerifySteps(domain, mailFrom) {
  return [
    `状態を見る: aws sesv2 get-email-identity --region ${REGION} --email-identity ${domain} --query '{Sendable:VerifiedForSendingStatus, Dkim:DkimAttributes.Status, MailFrom:MailFromAttributes.MailFromDomainStatus}'`,
    "PENDING なら、DNS が行き渡るのを待つ（数分〜72 時間。Route 53 のレコードは ses.yaml が作っている）",
    `72 時間を過ぎても PENDING か、FAILED なら、Route 53 のホストゾーン ${domain} にレコードがあるかを見る: dig CNAME <トークン>._domainkey.${domain}（トークンは get-email-identity の DkimAttributes.Tokens）、dig MX ${mailFrom ?? `bounce.${domain}`}、dig TXT ${mailFrom ?? `bounce.${domain}`}`,
    "レコードが無ければ node cloud/deploy.mjs で作り直す。あるのに通らなければ SES のコンソール（東京）→ Verified identities → ドメイン → DKIM の Retry",
    "SUCCESS になるまで顧客にメールを送れない。待つあいだ進めてよいと判断したら yes（cloud/README.md の 4.9.1）",
  ];
}

function dmarcSteps(domain, { strict }) {
  return strict
    ? [
        `今の値を見る: dig +short TXT _dmarc.${domain}`,
        `Route 53 のコンソール → ホストゾーン ${domain} → レコード _dmarc（TXT）を編集し、aspf=s と adkim=s を消す（p= と rua= はそのまま。Google Workspace と共有のレコードなので、ほかの部分は変えない）`,
        `数分後に dig +short TXT _dmarc.${domain} で、aspf=s・adkim=s が無いことを確かめる（cloud/README.md の 4.9.6）`,
      ]
    : [
        `無いことを確かめる: dig +short TXT _dmarc.${domain}（何も出ない）`,
        `Route 53 のコンソール → ホストゾーン ${domain} → レコードを作成: レコード名 _dmarc／タイプ TXT／値 "v=DMARC1; p=none; rua=mailto:<集計レポートを受けるアドレス>"（まず p=none。aspf=s・adkim=s は入れない）`,
        `数分後に dig +short TXT _dmarc.${domain} で v=DMARC1 が出ることを確かめる`,
        "apex の SPF（Google Workspace のもの）には触らない（cloud/README.md の 4.9.6）",
      ];
}

function amiSteps() {
  return [
    `今の EC2 の AMI を取る: ${OUT_FN} のあと aws ec2 describe-instances --region ${REGION} --instance-ids "$(OUT WireguardInstanceId)" --query 'Reservations[0].Instances[0].ImageId' --output text`,
    "cloud/samconfig.toml の [default.deploy.parameters] の parameter_overrides に \"WireguardFixedAmiId=<上の ami-…>\" を足す（エディタで）",
    `次のデプロイで反映される（急がなくてよいが、新しい AMI が出る前に行う。${DEPLOY_COMMAND}）`,
    "反映を確かめる: node setup/setup.mjs --target prod --phase apps --only cloud --check で WireGuard の AMI の「!」が消える（cloud/README.md の 4.2.1 の手順 3）",
    "samconfig.toml に書いた（デプロイは後で行う）なら yes",
  ];
}

function onpremKeySteps(user, use) {
  const strapi = /strapi/.test(user);
  const file = strapi ? "~/strapi-media.key" : "~/n8n-sns.key";
  return [
    `人が自分の端末で、管理者で実行する: ( umask 077; aws iam create-access-key --user-name ${user} --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text > ${file} )（シークレットが返るのはこの 1 回だけ。画面に出さない）`,
    strapi
      ? `${file} の 2 つの値を onprem/strapi/.env の AWS_ACCESS_KEY_ID・AWS_SECRET_ACCESS_KEY にエディタで写す（vim なら :r ${file}。echo で書かない）→ cd onprem/strapi && docker compose up -d → 管理画面で画像を 1 枚アップロードできることを確かめる`
      : `${file} の 2 つの値を ~/.config/comegin/setup/prod.conf の AWS_ACCESS_KEY_ID・AWS_SECRET_ACCESS_KEY にエディタで写す（echo で書かない）→ node setup/setup.mjs --target prod --only n8n-prod`,
    `写したらキーのファイルを消す: shred -u ${file}`,
    `確かめる: aws iam list-access-keys --user-name ${user} --query 'AccessKeyMetadata[].Status' --output text に Active が 1 つ（cloud/README.md の 4.5）`,
    `${use}を使わない（まだ動かさない）と判断したときだけ、発行せずに yes`,
  ];
}

/** 値の無い任意の Secret（SMTP）を製品ごとにまとめる（USERNAME と PASSWORD で 2 回聞かないため）。{ product, text } の配列 */
function smtpGroups(missing) {
  const groups = [];
  for (const product of ["chatwoot", "mautic"]) {
    const names = missing.filter((m) => !m.required && m.name.startsWith(`${product}/`)).map((m) => `comegin/${ENV_NAME}/${m.name}`);
    if (!names.length) continue;
    const label = product === "mautic" ? "Mautic" : "Chatwoot";
    groups.push({ product, text: `${label} 用の SES の SMTP 認証情報の Secret に値が無い: ${names.join("・")}。${label} の DesiredCount を上げる前に入れる` });
  }
  return groups;
}

function smtpSecretSteps(product) {
  return [
    "SES のコンソール（東京）→ 左の SMTP settings。SMTP endpoint が email-smtp.ap-northeast-1.amazonaws.com であることを確かめる",
    `Create SMTP credentials → User Name に comegin-${ENV_NAME}-ses-smtp-${product} → Create user → Download .csv file でリポジトリの外（~/Downloads など）に保存する（Show で画面に出さない。閉じると二度と見られない）`,
    "head -1 <CSV> で見出しだけを見て、列の順が「IAM のユーザー名, SMTP のユーザー名, SMTP のパスワード」かを確かめる",
    `画面にも引数にも出さずに入れる（cloud/README.md の 4.9.4 の put_smtp 関数を定義してから）: put_smtp ~/Downloads/<CSV>.csv ${product} → shred -u ~/Downloads/<CSV>.csv`,
    `確かめる: aws secretsmanager list-secret-version-ids --region ${REGION} --secret-id comegin/${ENV_NAME}/${product}/SMTP_PASSWORD --query 'Versions[].VersionStages' --output text に AWSCURRENT が出る（USERNAME も同じ）`,
    `${product === "mautic" ? "Mautic" : "Chatwoot"} の DesiredCount を上げる前に入れる（cloud/README.md の 4.11）。まだ ${product === "mautic" ? "Mautic" : "Chatwoot"} を起動しない（DesiredCount が 0 のまま）なら yes で進めてよい`,
  ];
}

function deployPrincipalSteps() {
  return [
    "人が自分の端末で、管理者（AdministratorAccess の SSO か comegin-iam）で行う。Claude Code の実行環境では行わない",
    "IAM Identity Center に許可セット ComeginProdDeploy を作る（セッション PT1H。description は ASCII だけ）: aws sso-admin create-permission-set --region ap-northeast-1 --instance-arn <INSTANCE> --name ComeginProdDeploy --session-duration PT1H --description 'Astro deploy only: S3 sync and CloudFront invalidation (managed policy comegin-prod-deploy)'",
    `管理ポリシーを参照させる: aws sso-admin attach-customer-managed-policy-reference-to-permission-set --region ap-northeast-1 --instance-arn <INSTANCE> --permission-set-arn <PS> --customer-managed-policy-reference Name=comegin-${ENV_NAME}-deploy,Path=/`,
    "配信を行う人に割り当てる: aws sso-admin create-account-assignment … --permission-set-arn <PS> --principal-type USER --principal-id <USER_ID>（RequestId が SUCCEEDED になるまで待つ）",
    "~/.aws/config に [profile comegin-prod-deploy]（sso_role_name = ComeginProdDeploy）を足す",
    `確かめる: aws iam list-entities-for-policy --policy-arn arn:aws:iam::<アカウント>:policy/comegin-${ENV_NAME}-deploy --query 'PolicyRoles[].RoleName' --output text に AWSReservedSSO_ComeginProdDeploy_… が出る（コマンドの全文は cloud/README.md の 4.5.1）`,
    "公開サイトの配信（4.14）の前に要る。配信をまだ行わないなら yes で進めてよい",
  ];
}

function setupOnlySteps(left) {
  return [
    `~/.config/comegin/setup/prod.conf をエディタで開き、${left.map((k) => k.key).join("・")} の行を消す`,
    ...(left.some((k) => k.key.startsWith("MAUTIC_SETUP_CLIENT"))
      ? ["Mautic の管理画面 → 右上の歯車 → API Credentials で、初期設定用の認証情報を消す"]
      : []),
  ];
}

function oldKeySteps(user) {
  return [
    `使っている側に新しいキーが入っていることを確かめてから、古いキーを止める: aws iam list-access-keys --user-name ${user} → aws iam update-access-key --user-name ${user} --access-key-id <古いキーの ID> --status Inactive`,
    `15〜30 分動くことを確かめてから消す: aws iam delete-access-key --user-name ${user} --access-key-id <古いキーの ID>（cloud/README.md の 4.5 の「古いキーを止めて消す」）`,
  ];
}

function rollbackWarnSteps() {
  return [
    `原因を見る: aws cloudformation describe-stack-events --region ${REGION} --stack-name ${STACK} --max-items 40 --query "StackEvents[?contains(ResourceStatus,'FAILED')].[Timestamp,LogicalResourceId,ResourceStatusReason]" --output table`,
    `原因（パラメータの誤り・権限・上限など）を直し、${DEPLOY_COMMAND} をやり直す`,
    "前の版のまま進めてよい（今回の変更は後で入れ直す）と判断したときだけ yes",
  ];
}

/** 済んでいなければ人に確かめる作業（apply では手順を出して yes を待つ。2026-11-10）。文は「何が・どうなる・どこを見る」。{ warnings: 人向けの文, entries, items: 項目 } を返す */
async function appsWarnings(ctx, main) {
  const f = findings();
  const domain = parameterOf(main, "DomainName") || "comegin.com";

  const second = f.item("cloud.global-second", "P2", "global の 2 回目（CloudFront のフラットレートプランの購読）", `${GLOBAL_STACK} の DistributionArn がある（購読済み）`);
  await f.attempt(second, "global の 2 回目", async () => {
    const global = await describeStack(ctx, GLOBAL_STACK, GLOBAL_REGION);
    if (!parameterOf(global, "DistributionArn")) f.warn(second, `global の 2 回目が済んでいない（${GLOBAL_STACK} の DistributionArn が空。CloudFront のフラットレートプランを購読しておらず、従量課金のまま。cloud/README.md の 4.3）`, globalSecondSteps());
  });

  const sns = f.item("cloud.sns-subscription", "P2", "SNS の購読（comegin-ops-alert・comegin-lead-alert）", "どちらのトピックにも確認済みの購読があり、解除に認証が要る");
  let snsChecked = 0;
  for (const key of ["OpsAlertTopicArn", "LeadAlertTopicArn"]) {
    const arn = outputOf(main, key);
    if (!arn) continue;
    snsChecked++;
    const topic = arn.split(":").pop();
    await f.attempt(sns, `SNS ${topic} の購読`, async () => {
      const subs = (await awsJson(ctx, ["sns", "list-subscriptions-by-topic", "--region", REGION, "--topic-arn", arn]))?.Subscriptions ?? [];
      const confirmed = subs.filter((s) => s.SubscriptionArn?.startsWith("arn:"));
      if (!confirmed.length) {
        f.warn(sns, `SNS ${topic} を誰も購読していない（確認待ち ${subs.length - confirmed.length} 件）。アラームが誰にも届かない（cloud/README.md の 4.4）`, snsSubscribeSteps(arn));
        return;
      }
      for (const s of confirmed) {
        const attrs = (await awsJson(ctx, ["sns", "get-subscription-attributes", "--region", REGION, "--subscription-arn", s.SubscriptionArn]))?.Attributes ?? {};
        if (attrs.ConfirmationWasAuthenticated !== "true") f.warn(sns, `SNS ${topic} の購読（${s.Protocol}）が --authenticate-on-unsubscribe true なしで確認されている。通知メールのリンクから誰でも解除できる（解除して、4.4 のとおり購読し直す）`, snsSubscribeSteps(arn, { unsubscribeArn: s.SubscriptionArn }));
      }
    });
  }
  if (!snsChecked) f.quiet(sns, "スタックの出力に OpsAlertTopicArn・LeadAlertTopicArn が無く、購読を確かめていない");

  // 公開サイトの配信（P12）の前に申請する。同じ確認が段階 operate にもある（P15。operateWarnings）
  const sesProd = f.item("cloud.ses-production", "P12", "SES の本番アクセス（サンドボックスの解除）", "SES はサンドボックスではない（本番アクセスが有効）");
  const sesDomain = f.item("cloud.ses-domain", "P4", `SES のドメイン ID ${domain}`, `SES の ${domain} は DKIM・MAIL FROM とも SUCCESS`);
  let sesPending = [sesProd, sesDomain];
  try {
    const account = await awsJson(ctx, ["sesv2", "get-account", "--region", REGION]);
    if (account && account.ProductionAccessEnabled !== true) f.warn(sesProd, "SES はまだサンドボックス（本番アクセスを申請していないか審査中）。検証済みの宛先にしかメールを送れない。公開サイトを配信したらすぐ、Transactional で申請する（cloud/README.md の 4.9.2）", sesProductionSteps({ beforeSite: true }));
    else if (!account) f.quiet(sesProd, "SES のアカウントの情報を読めなかった");
    sesPending = [sesDomain];
    const id = await awsJson(ctx, ["sesv2", "get-email-identity", "--region", REGION, "--email-identity", domain]);
    if (!id) f.warn(sesDomain, `SES のドメイン ID ${domain} が無い（ses.yaml。段階 deploy を確かめる）`, sesIdentityMissingSteps(domain));
    else {
      if (id.DkimAttributes?.Status !== "SUCCESS") f.warn(sesDomain, `SES の DKIM が ${id.DkimAttributes?.Status ?? "不明"}（SUCCESS になるまで送れない。Route 53 のレコードは自動で作られる。cloud/README.md の 4.9.1）`, sesVerifySteps(domain, id.MailFromAttributes?.MailFromDomain));
      if (id.MailFromAttributes?.MailFromDomainStatus !== "SUCCESS") f.warn(sesDomain, `SES の MAIL FROM（${id.MailFromAttributes?.MailFromDomain ?? "不明"}）が ${id.MailFromAttributes?.MailFromDomainStatus ?? "不明"}（cloud/README.md の 4.9.1）`, sesVerifySteps(domain, id.MailFromAttributes?.MailFromDomain));
    }
  } catch (e) {
    f.unknown(sesPending, `SESを確かめられない（${e.message.split("\n")[0]}）`);
  }

  // apex の SPF は見ない。SES のメールの SPF は MAIL FROM のサブドメイン（ses.yaml）で評価され、DMARC は緩い照合で通る（cloud/README.md の 4.9.6）
  const dmarcItem = f.item("cloud.dmarc", "P4", `${domain} の DMARC`, `_dmarc.${domain} に DMARC の TXT があり、照合は緩い（aspf・adkim が s ではない）`);
  await f.attempt(dmarcItem, `${domain} の DMARC`, async () => {
    const txt = async (name) => (await resolveTxt(name).catch((e) => (e.code === "ENODATA" || e.code === "ENOTFOUND" ? [] : Promise.reject(e)))).map((r) => r.join(""));
    const dmarc = (await txt(`_dmarc.${domain}`)).find((r) => r.startsWith("v=DMARC1"));
    if (!dmarc) f.warn(dmarcItem, `_dmarc.${domain} に DMARC の TXT が無い（Gmail などで迷惑メールに入りやすい。p=none から始める。cloud/README.md の 4.9.6）`, dmarcSteps(domain, { strict: false }));
    else if (/;\s*a(spf|dkim)\s*=\s*s\b/i.test(dmarc)) f.warn(dmarcItem, `_dmarc.${domain} の DMARC が厳しい照合（aspf=s か adkim=s）。MAIL FROM がサブドメインの SES のメールが照合に落ちる。外す（cloud/README.md の 4.9.6）`, dmarcSteps(domain, { strict: true }));
  });

  const ami = f.item("cloud.wireguard-ami", "P6", "WireGuard の AMI の固定", "WireguardFixedAmiId が入っている（AMI を固定済み）");
  if (!parameterOf(main, "WireguardFixedAmiId")) f.warn(ami, "WireGuard の AMI が固定されていない（WireguardFixedAmiId が空）。新しい AMI が出た後のデプロイで EC2 が置き換わり、鍵が変わってトンネルが切れる。samconfig.toml に書く（cloud/README.md の 4.2.1 の手順 3）", amiSteps());

  const onpremKeys = f.item("cloud.onprem-keys", "P6", "オンプレ用の IAM ユーザーの有効なアクセスキー", "オンプレの Strapi（メディア）と n8n（SNS）の IAM ユーザーに有効なキーがある");
  let keyUsers = 0;
  for (const [key, use] of [["OnpremStrapiMediaUserName", "オンプレの Strapi のメディアのアップロード"], ["OnpremN8nSnsUserName", "オンプレの n8n の通知とハートビート"]]) {
    const user = outputOf(main, key);
    if (!user) continue;
    keyUsers++;
    await f.attempt(onpremKeys, `IAM ユーザー ${user} のキー`, async () => {
      const keys = (await awsJson(ctx, ["iam", "list-access-keys", "--user-name", user]))?.AccessKeyMetadata ?? [];
      if (!keys.some((k) => k.Status === "Active")) f.warn(onpremKeys, `IAM ユーザー ${user} に有効なアクセスキーが無い。${use}が失敗する（人が発行する。cloud/README.md の 4.5）`, onpremKeySteps(user, use));
    });
  }
  if (!keyUsers) f.quiet(onpremKeys, "スタックの出力に IAM ユーザー名（OnpremStrapiMediaUserName・OnpremN8nSnsUserName）が無く、キーを確かめていない");

  const smtp = f.item("cloud.smtp-secrets", "P4", "SMTP の Secret（Mautic・Chatwoot の送信用）", "Mautic・Chatwoot の SMTP の Secret（4 つ）に値が入っている");
  await f.attempt(smtp, "SMTP の Secret", async () => {
    for (const g of smtpGroups(await missingSecrets(ctx))) f.warn(smtp, `${g.text}（cloud/README.md の 4.9.3・4.9.4・4.11）`, smtpSecretSteps(g.product));
  });

  const principal = f.item("cloud.deploy-principal", "P12", "配信用の主体（管理ポリシー comegin-prod-deploy の付与先）", `管理ポリシー comegin-${ENV_NAME}-deploy が主体に付いている`);
  await f.attempt(principal, "配信用の主体", async () => {
    const w = await deployPrincipalWarning(ctx);
    if (w) f.warn(principal, w, deployPrincipalSteps());
  });
  return { warnings: f.texts, entries: f.entries, items: f.items() };
}

/** 管理ポリシー comegin-<env>-deploy（DeployPolicyArn）の付与先が無ければ警告文。公開サイトの配信（P12）の前に要る */
async function deployPrincipalWarning(ctx) {
  const { Account } = await callerIdentity(ctx);
  const r = await awsJson(ctx, ["iam", "list-entities-for-policy", "--policy-arn", `arn:aws:iam::${Account}:policy/comegin-${ENV_NAME}-deploy`]);
  const n = (r?.PolicyUsers?.length ?? 0) + (r?.PolicyRoles?.length ?? 0) + (r?.PolicyGroups?.length ?? 0);
  return n ? null : `管理ポリシー comegin-${ENV_NAME}-deploy がどの主体にも付いていない。公開サイトの配信（cloud/README.md の 4.14 の手順 3）で切り替える主体が無い。IAM Identity Center の許可セット ComeginProdDeploy を作る（cloud/README.md の 4.5.1）`;
}

// 運用開始の後に prod.conf に残すべきでない値（setup/00-setup-overview.md の P15。初期設定が済んだら消す）
const SETUP_ONLY_KEYS = [
  { key: "CHATWOOT_ADMIN_TOKEN", how: "Chatwoot の管理者のトークン。消すと chatwoot-prod・n8n-prod の再実行には書き直しが要る" },
  { key: "MAUTIC_SETUP_CLIENT_ID", how: "Mautic の初期設定用の API 認証情報。画面（歯車 → API Credentials）でも消す" },
  { key: "MAUTIC_SETUP_CLIENT_SECRET", how: "同上" },
];

/** 段階 operate の確認。運用開始の仕上げ（P15）と、配信用の主体・キーの残り（キーの残りと prod.conf の初期設定用の値は削除の注意で、止めない）。{ warnings: 人向けの文, entries, items: 項目 } を返す */
async function operateWarnings(ctx, main) {
  const f = findings();
  const principal = f.item("cloud.deploy-principal", "P15", "配信用の主体（管理ポリシー comegin-prod-deploy の付与先）", `管理ポリシー comegin-${ENV_NAME}-deploy が主体に付いている`);
  await f.attempt(principal, "配信用の主体", async () => {
    const w = await deployPrincipalWarning(ctx);
    if (w) f.warn(principal, w, deployPrincipalSteps());
  });
  // キーの入れ替えの後に古いキーが残っていないか（1 ユーザーに有効なキーは 1 つにする。cloud/README.md の 4.5 のローテーション）
  const oldKeys = f.item("cloud.old-keys", "P15", "IAM ユーザーの古いアクセスキーの残り", "どの IAM ユーザーも有効なキーは 1 つだけ");
  const users = [outputOf(main, "OnpremStrapiMediaUserName"), outputOf(main, "OnpremN8nSnsUserName"), `comegin-${ENV_NAME}-control-plane`, `comegin-${ENV_NAME}-status-reader`].filter(Boolean);
  for (const user of users) {
    await f.attempt(oldKeys, `IAM ユーザー ${user} のキー`, async () => {
      const keys = (await awsJson(ctx, ["iam", "list-access-keys", "--user-name", user]))?.AccessKeyMetadata ?? [];
      const active = keys.filter((k) => k.Status === "Active");
      if (active.length > 1) f.warn(oldKeys, `IAM ユーザー ${user} に有効なアクセスキーが ${active.length} つある（作成 ${active.map((k) => k.CreateDate.slice(0, 10)).join("・")}）。使っているほうが動くことを確かめてから、古いキーを update-access-key --status Inactive → delete-access-key（cloud/README.md の 4.5）`, oldKeySteps(user), { deletion: true });
    });
  }
  const setupOnly = f.item("cloud.setup-only-values", "P15", "prod.conf に残った初期設定用の値", "prod.conf に初期設定にだけ使う値（CHATWOOT_ADMIN_TOKEN・MAUTIC_SETUP_CLIENT_*）は残っていない");
  const left = SETUP_ONLY_KEYS.filter((k) => ctx.conf[k.key]);
  if (left.length) f.warn(setupOnly, `初期設定にだけ使う値が prod.conf に残っている: ${left.map((k) => `${k.key}（${k.how}）`).join("、")}（setup/00-setup-overview.md の P15）`, setupOnlySteps(left), { deletion: true });
  const sesProd = f.item("cloud.ses-production", "P15", "SES の本番アクセス（サンドボックスの解除）", "SES はサンドボックスではない（本番アクセスが有効）");
  await f.attempt(sesProd, "SES", async () => {
    const account = await awsJson(ctx, ["sesv2", "get-account", "--region", REGION]);
    if (account && account.ProductionAccessEnabled !== true) f.warn(sesProd, "SES はまだサンドボックス。顧客にメールが届かない（cloud/README.md の 4.9.2。公開サイトの配信の後すぐに申請する）", sesProductionSteps({ beforeSite: false }));
    else if (!account) f.quiet(sesProd, "SES のアカウントの情報を読めなかった");
  });
  return { warnings: f.texts, entries: f.entries, items: f.items() };
}

// ---------------------------------------------------------------------------
// 契約
// ---------------------------------------------------------------------------

export async function check(ctx) {
  if (ctx.phase === "env") {
    const { problems, notes, awsDown } = await checkEnv(ctx);
    // AWS の認証が使えないだけなら ?（確かめられない）。人の端末では AWS_PROFILE・aws sso login、監視アプリでは確認用の主体のキーを疑う
    return settleAwsUnavailable({ ok: problems.length === 0, notes: problems.length ? [...problems, ...notes] : [...notes, `${SAMCONFIG} の必須の値はそろっている`] }, awsDown);
  }
  if (ctx.phase === "deploy") {
    const notes = [];
    const global = await describeStack(ctx, GLOBAL_STACK, GLOBAL_REGION);
    const main = await describeStack(ctx, STACK, REGION);
    const params = samParameters(ctx) ?? new Map();
    for (const p of [stackProblem(global, GLOBAL_STACK), ...CLOUDFRONT_PARAMS.filter((k) => unset(params, k)).map((k) => `${SAMCONFIG} の ${k} が雛形のまま`), stackProblem(main, STACK)]) if (p) notes.push(p);
    if (!main) {
      const found = await leftovers(ctx, (await callerIdentity(ctx)).Account);
      if (found.length) notes.push(`前の作成の失敗で残ったリソースが ${found.length} 個（${found.map((f) => f.label).join("、")}）。sam deploy の前に消す`);
    }
    let ok = notes.length === 0;
    if (main && ok) {
      notes.push(`スタック ${STACK}: ${main.StackStatus}（${main.LastUpdatedTime ?? main.CreationTime}）`);
      for (const s of await missingSecrets(ctx)) {
        notes.push(`Secret comegin/${ENV_NAME}/${s.name} に値が無い${s.required ? "" : "（DesiredCount を上げる前に）"}`);
        if (s.required) ok = false;
      }
    }
    // デプロイのずれは items だけ（ok と notes は変えない。ずれで段階 deploy の判定を巻き添えにしない）
    return { ok, notes, items: await deployDriftItems(ctx, global, main) };
  }
  if (ctx.phase === "images") {
    const main = await describeStack(ctx, STACK, REGION);
    if (!main) return { ok: false, notes: [`スタック ${STACK} が無い（先に段階 deploy）`], items: await imageDriftItems(ctx, null, []) };
    const notes = [];
    const images = [];
    let ok = true;
    for (const img of IMAGES) {
      const tag = parameterOf(main, img.param);
      const image = await describeImage(ctx, img.repo, tag);
      images.push(image);
      notes.push(`${img.repo}:${tag} ${image ? "は ECR にある" : "が ECR に無い"}`);
      if (!image) ok = false;
    }
    // イメージの古さは items だけ（ok と notes は変えない。ずれで段階 images の判定を巻き添えにしない）
    return { ok, notes, items: await imageDriftItems(ctx, main, images) };
  }
  if (ctx.phase === "apps") {
    const main = await describeStack(ctx, STACK, REGION);
    if (!main) return { ok: false, notes: [`スタック ${STACK} が無い（先に段階 deploy）`] };
    const missing = await missingDbInit(ctx, main, { record: false });
    const notes = DB_ENGINES.map((e) => `DB 作成（db-init-${e}）: ${missing.includes(e) ? "今のスタックの作成の後に成功した記録が無い（cloud/README.md の 4.8）" : "済み"}`);
    const { warnings, items } = await appsWarnings(ctx, main);
    for (const w of warnings) notes.push(`! ${w}`);
    return { ok: missing.length === 0, notes, items };
  }
  if (ctx.phase === "operate") {
    const main = await describeStack(ctx, STACK, REGION);
    if (!main) return { ok: false, notes: [`スタック ${STACK} が無い（先に段階 deploy）`] };
    const { warnings, items } = await operateWarnings(ctx, main);
    return { ok: true, notes: warnings.length ? warnings.map((w) => `! ${w}`) : ["運用開始の仕上げ（配信用の主体・キーの残り・prod.conf の初期設定用の値・SES）は済んでいる"], items };
  }
  throw new Error(`cloud は段階 ${ctx.phase} を持たない`);
}

export async function apply(ctx) {
  if (ctx.phase === "env") {
    const { problems, notes, awsDown } = await checkEnv(ctx);
    if (awsDown) problems.push(awsDown); // apply では、認証が使えないなら先に進めない（人に AWS_PROFILE・aws sso login を頼む）
    for (const n of notes) ctx.log(n);
    if (problems.length) ctx.manual("env", "本番のデプロイに要る道具・AWS の認証・デプロイの設定ファイルをそろえる", envSteps(problems));
    ctx.log(`${SAMCONFIG} の必須の値はそろっている（値は表示しない）。次は段階 deploy`);
    return;
  }

  if (ctx.phase === "deploy") {
    const global = await describeStack(ctx, GLOBAL_STACK, GLOBAL_REGION);
    const globalProblem = stackProblem(global, GLOBAL_STACK);
    if (globalProblem) ctx.manual("global", `global（us-east-1）をデプロイする（${globalProblem}）`, globalSteps());

    const params = samParameters(ctx) ?? new Map();
    const unsetCloudFront = CLOUDFRONT_PARAMS.filter((k) => unset(params, k));
    if (unsetCloudFront.length) {
      // global の出力の ARN は秘密値ではない（証明書と WAF の識別子）。写し間違いを防ぐため、そのまま表示する
      ctx.manual("cloudfront-params", "global の出力を samconfig.toml に書く", [
        `${SAMCONFIG} の parameter_overrides に次を書く: "CloudFrontCertificateArn=${outputOf(global, "CertificateArn")}"、"CloudFrontWebAclArn=${outputOf(global, "WebAclArn")}"（cloud/README.md の 4.1）`,
        "同じコマンドを実行し直す",
      ]);
    }

    const main = await describeStack(ctx, STACK, REGION);
    const mainProblem = stackProblem(main, STACK);
    if (main?.StackStatus === "ROLLBACK_COMPLETE") ctx.manual("rollback", `本番スタックを消して作り直す（${mainProblem}）`, rollbackSteps());
    if (!main) {
      const found = await leftovers(ctx, (await callerIdentity(ctx)).Account);
      if (found.length) ctx.manual("leftovers", "前の作成の失敗で残ったリソースを消す", leftoverSteps(found));
    }
    if (mainProblem) ctx.manual("sam-deploy", `本番スタックを ${DEPLOY_COMMAND}（sam build → sam deploy）でデプロイする（${mainProblem}）`, mainSteps());
    if (main.StackStatus === "UPDATE_ROLLBACK_COMPLETE") await ctx.confirm("update-rollback", `スタック ${STACK} の直近の更新は戻された（UPDATE_ROLLBACK_COMPLETE）。前の版のまま。CloudFormation のイベントで原因を確かめる`, rollbackWarnSteps());
    ctx.log(`スタック ${STACK}: ${main.StackStatus}（${main.LastUpdatedTime ?? main.CreationTime}）`);

    const missing = await missingSecrets(ctx);
    for (const g of smtpGroups(missing)) await ctx.confirm(`smtp-${g.product}`, `${g.text}（cloud/README.md の 4.11）`, smtpSecretSteps(g.product));
    const required = missing.filter((m) => m.required);
    if (required.length) ctx.manual("secrets", "人が入れる Secret の値を入れる", secretSteps(required));
    ctx.log("本番スタックと人が入れる Secret はそろっている。次は段階 images");
    return;
  }

  if (ctx.phase === "images") {
    const main = await describeStack(ctx, STACK, REGION);
    if (!main) throw new Error(`スタック ${STACK} が無い。先に node setup/setup.mjs --target prod --phase deploy`);
    const missing = [];
    for (const img of IMAGES) {
      const tag = parameterOf(main, img.param);
      if (await imageExists(ctx, img.repo, tag)) ctx.log(`${img.repo}:${tag} は ECR にある`);
      else missing.push({ ...img, tag });
    }
    if (missing.length) {
      const { Account } = await callerIdentity(ctx);
      ctx.manual("push", "派生イメージをビルドして ECR にプッシュする", imageSteps(Account, missing));
    }
    ctx.log("イメージはそろっている（タスクはまだ 0 台。起動は段階 apps の各製品の手順と cloud/README.md の 4.11）。次は段階 apps");
    return;
  }

  if (ctx.phase === "apps") {
    const main = await requireMainStack(ctx);
    const missing = await missingDbInit(ctx, main);
    if (missing.length) ctx.manual("db-init", "DB とアプリ用ユーザーを作る（ECS の RunTask。段階 apps のすべての前提）", dbInitSteps(missing));
    ctx.log(`DB 作成（${DB_ENGINES.map((e) => `db-init-${e}`).join("・")}）は今のスタックの作成の後に成功している`);
    const { warnings, entries } = await appsWarnings(ctx, main);
    await settleEntries(ctx, entries);
    ctx.log(warnings.length ? `人の作業が ${warnings.length} 件残っている（上の !。yes で確認済み。setup/00-setup-overview.md の 4 節）` : "global の 2 回目・SNS の購読・SES・AMI の固定・IAM のキー・SMTP の Secret・配信用の主体は済んでいる");
    return;
  }

  if (ctx.phase === "operate") {
    const main = await requireMainStack(ctx);
    const { warnings, entries } = await operateWarnings(ctx, main);
    await settleEntries(ctx, entries);
    ctx.log(warnings.length ? `運用開始の仕上げが ${warnings.length} 件残っている（上の !。削除の注意のほかは yes で確認済み。setup/00-setup-overview.md の P15）` : "運用開始の仕上げ（配信用の主体・キーの残り・prod.conf の初期設定用の値・SES）は済んでいる");
    return;
  }

  throw new Error(`cloud は段階 ${ctx.phase} を持たない`);
}
