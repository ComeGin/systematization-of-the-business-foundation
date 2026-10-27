// AWS（cloud/ の SAM）の本番の段階。setup/lib/core.mjs の契約に従う。1 つのモジュールで、本番の段階のうち前の 3 つと、apps の最初を受け持つ:
//   env     本番用の環境変数の設定: 道具（aws・sam・docker・pnpm）・AWS の認証とアカウント・デプロイの設定ファイル（cloud/samconfig.toml）の必須の値
//   deploy  sam build → sam deploy（1 回目）: global（us-east-1）→ CloudFront の 2 つのパラメータ → 本番スタック → 人が入れる Secret の値
//           （ECR のリポジトリはこのデプロイで作られる。ECS のサービスは 0 台で作られ、イメージが無くても通る。cloud/README.md の 4.2）
//   images  イメージのビルドと ECR へのプッシュ: 本番スタックのパラメータ ChatwootImageTag・MauticImageTag のタグが ECR にあるか
//           （タグを変えるときは、samconfig.toml を書き換えて sam build → sam deploy をもう 1 回。cloud/README.md の 4.7・4.12）
//   apps    段階 apps の前提（docs/runbooks/00-setup-overview.md の P4）。setup.mjs の MODULES で admin-auth より前に置き、段階 apps の先頭で動く。
//           止めるのは DB 作成のタスク（4.8。admin-auth・onprem・chatwoot-prod・mautic-prod のすべての前提）だけ。
//           ほかの人の作業（global の 2 回目・SNS の購読・SES・WireGuard の AMI の固定・オンプレの IAM のキー・SMTP の Secret）は、
//           無くても後の設定は進められるので警告だけにする（どれも以前はスクリプトが確かめていなかった）
// 段階の順番は setup/lib/runner.mjs の PROD_PHASES（ユーザーの決定。2026-10-27）。この後に google が続く。
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
import { ENV_NAME, GLOBAL_REGION, GLOBAL_STACK, REGION, STACK, awsJson, dbInitDone, dbInitSteps, describeStack, outputOf, parameterOf, requireMainStack, secretHasValue } from "./aws.mjs";

export const meta = { id: "cloud", title: "AWS（本番のスタック。環境変数・デプロイ・イメージ・apps の前提）", targets: ["prod"], phases: ["env", "deploy", "images", "apps"], after: [] };

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
// 派生イメージ（cloud/README.md の 4.7 の表と同じ値にする。上流の版を上げたら両方を変える）
const IMAGES = [
  { label: "Chatwoot", param: "ChatwootImageTag", repo: `comegin/${ENV_NAME}/chatwoot`, dir: "cloud/images/chatwoot", upstreamTag: "v4.18.0", upstreamDigest: "sha256:b419dded7e9d2f54a24fd427b74ba7e6069d601b500618045c1eb6c01a1cc9a1" },
  { label: "Mautic", param: "MauticImageTag", repo: `comegin/${ENV_NAME}/mautic`, dir: "cloud/images/mautic", upstreamTag: "7.2.0-apache", upstreamDigest: "sha256:dea3bb71a5c5bf4c0c7d1764e58a32109898e7b2e6a710f14f50e2a913c03a0f" },
];
const COMPLETE = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "IMPORT_COMPLETE"]);

// ---------------------------------------------------------------------------
// AWS（読み取りだけ。共通の部品は ./aws.mjs）
// ---------------------------------------------------------------------------

async function callerIdentity(ctx) {
  try {
    return await awsJson(ctx, ["sts", "get-caller-identity"]);
  } catch (e) {
    throw new Error(`AWS の認証が使えない（aws sts get-caller-identity が失敗した。AWS_PROFILE か aws sso login を確かめる）\n${e.message}`);
  }
}

async function imageExists(ctx, repo, tag) {
  const r = await awsJson(ctx, ["ecr", "describe-images", "--region", REGION, "--repository-name", repo, "--image-ids", `imageTag=${tag}`]);
  return Boolean(r?.imageDetails?.length);
}

// ---------------------------------------------------------------------------
// samconfig.toml（名前と「雛形のまま・空か」だけを見る。値は出さない）
// ---------------------------------------------------------------------------

/** parameter_overrides の "Key=Value" を名前 → 値の Map にする。ファイルが無ければ null */
function samParameters(ctx) {
  const file = join(ctx.W, SAMCONFIG);
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
    "  - 既定と違う値（DesiredCount・イメージのタグなど）はすべてここに書く（書かないと、次のデプロイで既定値に戻る。2 節の「重要」）",
    "同じコマンドを実行し直す",
  ];
}

async function checkEnv(ctx) {
  const notes = [];
  const problems = await toolProblems(ctx);
  let id = null;
  if (!problems.some((p) => p.startsWith("aws "))) {
    try {
      id = await callerIdentity(ctx);
    } catch (e) {
      problems.push(e.message.split("\n")[0]);
    }
  }
  const expected = ctx.value("AWS_ACCOUNT_ID") || DEFAULT_ACCOUNT_ID;
  if (id && id.Account !== expected) problems.push(`AWS の認証のアカウントが ${id.Account}（デプロイ先は ${expected}。AWS_PROFILE を確かめる）`);
  problems.push(...envSamProblems(samParameters(ctx)));
  if (id) notes.push(`AWS の認証: ${id.Arn}`);
  return { problems, notes };
}

// ---------------------------------------------------------------------------
// 段階 deploy
// ---------------------------------------------------------------------------

function globalSteps() {
  return [
    "cd cloud && sam deploy --config-env global（us-east-1 の ACM 証明書と CloudFront 用 WAF。ACM の DNS 検証に数分かかる。cloud/README.md の 4.1）",
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
    "cd cloud && sam build（必須。faq-bot・consent-api・admin-auth の Lambda を pnpm と esbuild でまとめる。飛ばすと index.handler の無い zip になり、同意の受け口とログインが 502 になる）",
    "sam deploy（変更セットを確かめてから実行。初回は RDS・ElastiCache・ACM の検証で 30 分前後。ECR のリポジトリもここで作られる。ECS のサービスは 0 台で作られ、イメージがまだ無くても通る。cloud/README.md の 4.2）",
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
// 段階 images
// ---------------------------------------------------------------------------

function imageSteps(account, missing) {
  const ecr = `${account}.dkr.ecr.${REGION}.amazonaws.com`;
  return [
    `ECR に無いイメージ: ${missing.map((m) => `${m.repo}:${m.tag}`).join("、")}（タグは本番スタックのパラメータ ${missing.map((m) => m.param).join("・")} の今の値）`,
    `ECR にログインする: aws ecr get-login-password --region ${REGION} | docker login --username AWS --password-stdin ${ecr}`,
    ...missing.map(
      (m) =>
        `${m.label}: docker build --platform linux/amd64 --build-arg UPSTREAM_TAG=${m.upstreamTag} --build-arg UPSTREAM_DIGEST=${m.upstreamDigest} -t ${ecr}/${m.repo}:${m.tag} ${m.dir} → docker push ${ecr}/${m.repo}:${m.tag}（リポジトリのルートで実行。Fargate は X86_64 なので --platform を外さない）`,
    ),
    "ECR のタグは上書きできない。作り直すときは連番を上げたタグにし、samconfig.toml の同じパラメータに書いて cd cloud && sam build → sam deploy をもう 1 回行ってから push する（cloud/README.md の 4.7・4.12）",
    "同じコマンドを実行し直す",
  ];
}

// ---------------------------------------------------------------------------
// 段階 apps（apps の前提。docs/runbooks/00-setup-overview.md の P4 と 4 節）
// ---------------------------------------------------------------------------

const DB_ENGINES = ["postgres", "mysql"];

async function missingDbInit(ctx, main, opts) {
  const missing = [];
  for (const engine of DB_ENGINES) if (!(await dbInitDone(ctx, main, engine, opts))) missing.push(engine);
  return missing;
}

/** 1 つの確かめが読めなくても（権限・一時的な失敗）、ほかを続ける。読めなかったことは警告に残す */
async function tryWarn(warnings, label, fn) {
  try {
    await fn();
  } catch (e) {
    warnings.push(`${label}を確かめられない（${e.message.split("\n")[0]}）`);
  }
}

/** 止めはしないが、済んでいなければ知らせる人の作業。文は「何が・どうなる・どこを見る」 */
async function appsWarnings(ctx, main) {
  const warnings = [];
  const domain = parameterOf(main, "DomainName") || "comegin.com";

  await tryWarn(warnings, "global の 2 回目", async () => {
    const global = await describeStack(ctx, GLOBAL_STACK, GLOBAL_REGION);
    if (!parameterOf(global, "DistributionArn")) warnings.push(`global の 2 回目が済んでいない（${GLOBAL_STACK} の DistributionArn が空。CloudFront のフラットレートプランを購読しておらず、従量課金のまま。cloud/README.md の 4.3）`);
  });

  for (const key of ["OpsAlertTopicArn", "LeadAlertTopicArn"]) {
    const arn = outputOf(main, key);
    if (!arn) continue;
    const topic = arn.split(":").pop();
    await tryWarn(warnings, `SNS ${topic} の購読`, async () => {
      const subs = (await awsJson(ctx, ["sns", "list-subscriptions-by-topic", "--region", REGION, "--topic-arn", arn]))?.Subscriptions ?? [];
      const confirmed = subs.filter((s) => s.SubscriptionArn?.startsWith("arn:"));
      if (!confirmed.length) {
        warnings.push(`SNS ${topic} を誰も購読していない（確認待ち ${subs.length - confirmed.length} 件）。アラームが誰にも届かない（cloud/README.md の 4.4）`);
        return;
      }
      for (const s of confirmed) {
        const attrs = (await awsJson(ctx, ["sns", "get-subscription-attributes", "--region", REGION, "--subscription-arn", s.SubscriptionArn]))?.Attributes ?? {};
        if (attrs.ConfirmationWasAuthenticated !== "true") warnings.push(`SNS ${topic} の購読（${s.Protocol}）が --authenticate-on-unsubscribe true なしで確認されている。通知メールのリンクから誰でも解除できる（解除して、4.4 のとおり購読し直す）`);
      }
    });
  }

  await tryWarn(warnings, "SES", async () => {
    const account = await awsJson(ctx, ["sesv2", "get-account", "--region", REGION]);
    if (account && account.ProductionAccessEnabled !== true) warnings.push("SES はまだサンドボックス（本番アクセスを申請していないか審査中）。検証済みの宛先にしかメールを送れない。顧客向けのメールの前に済ませる（cloud/README.md の 4.9 の 1）");
    const id = await awsJson(ctx, ["sesv2", "get-email-identity", "--region", REGION, "--email-identity", domain]);
    if (!id) warnings.push(`SES のドメイン ID ${domain} が無い（ses.yaml。段階 deploy を確かめる）`);
    else {
      if (id.DkimAttributes?.Status !== "SUCCESS") warnings.push(`SES の DKIM が ${id.DkimAttributes?.Status ?? "不明"}（SUCCESS になるまで送れない。Route 53 のレコードは自動で作られる。cloud/README.md の 4.9 の 2）`);
      if (id.MailFromAttributes?.MailFromDomainStatus !== "SUCCESS") warnings.push(`SES の MAIL FROM（${id.MailFromAttributes?.MailFromDomain ?? "不明"}）が ${id.MailFromAttributes?.MailFromDomainStatus ?? "不明"}（cloud/README.md の 4.9 の 2）`);
    }
  });

  await tryWarn(warnings, `${domain} の SPF・DMARC`, async () => {
    const txt = async (name) => (await resolveTxt(name).catch((e) => (e.code === "ENODATA" || e.code === "ENOTFOUND" ? [] : Promise.reject(e)))).map((r) => r.join(""));
    const spf = (await txt(domain)).find((r) => r.startsWith("v=spf1"));
    if (!spf?.includes("include:amazonses.com")) warnings.push(`${domain} の SPF に include:amazonses.com が無い${spf ? "" : "（SPF の TXT が無い）"}。Google Workspace の SPF と 1 つの TXT にまとめて足す（cloud/README.md の 4.9 の 4）`);
    if (!(await txt(`_dmarc.${domain}`)).some((r) => r.startsWith("v=DMARC1"))) warnings.push(`_dmarc.${domain} に DMARC の TXT が無い（cloud/README.md の 4.9 の 4）`);
  });

  if (!parameterOf(main, "WireguardFixedAmiId")) warnings.push("WireGuard の AMI が固定されていない（WireguardFixedAmiId が空）。新しい AMI が出た後のデプロイで EC2 が置き換わり、鍵が変わってトンネルが切れる。samconfig.toml に書く（cloud/README.md の 4.2.1 の手順 3）");

  for (const [key, use] of [["OnpremStrapiMediaUserName", "オンプレの Strapi のメディアのアップロード"], ["OnpremN8nSnsUserName", "オンプレの n8n の通知とハートビート"]]) {
    const user = outputOf(main, key);
    if (!user) continue;
    await tryWarn(warnings, `IAM ユーザー ${user} のキー`, async () => {
      const keys = (await awsJson(ctx, ["iam", "list-access-keys", "--user-name", user]))?.AccessKeyMetadata ?? [];
      if (!keys.some((k) => k.Status === "Active")) warnings.push(`IAM ユーザー ${user} に有効なアクセスキーが無い。${use}が失敗する（人が発行する。cloud/README.md の 4.5）`);
    });
  }

  await tryWarn(warnings, "SMTP の Secret", async () => {
    for (const s of (await missingSecrets(ctx)).filter((m) => !m.required)) warnings.push(`Secret comegin/${ENV_NAME}/${s.name} に値が無い（${s.hint}）。Chatwoot・Mautic の DesiredCount を上げる前に入れる（cloud/README.md の 4.6・4.11）`);
  });
  return warnings;
}

// ---------------------------------------------------------------------------
// 契約
// ---------------------------------------------------------------------------

export async function check(ctx) {
  if (ctx.phase === "env") {
    const { problems, notes } = await checkEnv(ctx);
    return { ok: problems.length === 0, notes: problems.length ? [...problems, ...notes] : [...notes, `${SAMCONFIG} の必須の値はそろっている`] };
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
    return { ok, notes };
  }
  if (ctx.phase === "images") {
    const main = await describeStack(ctx, STACK, REGION);
    if (!main) return { ok: false, notes: [`スタック ${STACK} が無い（先に段階 deploy）`] };
    const notes = [];
    let ok = true;
    for (const img of IMAGES) {
      const tag = parameterOf(main, img.param);
      const found = await imageExists(ctx, img.repo, tag);
      notes.push(`${img.repo}:${tag} ${found ? "は ECR にある" : "が ECR に無い"}`);
      if (!found) ok = false;
    }
    return { ok, notes };
  }
  if (ctx.phase === "apps") {
    const main = await describeStack(ctx, STACK, REGION);
    if (!main) return { ok: false, notes: [`スタック ${STACK} が無い（先に段階 deploy）`] };
    const missing = await missingDbInit(ctx, main, { record: false });
    const notes = DB_ENGINES.map((e) => `DB 作成（db-init-${e}）: ${missing.includes(e) ? "今のスタックの作成の後に成功した記録が無い（cloud/README.md の 4.8）" : "済み"}`);
    for (const w of await appsWarnings(ctx, main)) notes.push(`! ${w}`);
    return { ok: missing.length === 0, notes };
  }
  throw new Error(`cloud は段階 ${ctx.phase} を持たない`);
}

export async function apply(ctx) {
  if (ctx.phase === "env") {
    const { problems, notes } = await checkEnv(ctx);
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
    if (mainProblem) ctx.manual("sam-deploy", `本番スタックを sam build → sam deploy する（${mainProblem}）`, mainSteps());
    if (main.StackStatus === "UPDATE_ROLLBACK_COMPLETE") ctx.warn(`スタック ${STACK} の直近の更新は戻された（UPDATE_ROLLBACK_COMPLETE）。前の版のまま進む。CloudFormation のイベントで原因を確かめる`);
    ctx.log(`スタック ${STACK}: ${main.StackStatus}（${main.LastUpdatedTime ?? main.CreationTime}）`);

    const missing = await missingSecrets(ctx);
    for (const s of missing.filter((m) => !m.required)) ctx.warn(`Secret comegin/${ENV_NAME}/${s.name} に値が無い。${s.hint}。Chatwoot・Mautic の DesiredCount を上げる前に入れる（cloud/README.md の 4.11）`);
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
    const warnings = await appsWarnings(ctx, main);
    for (const w of warnings) ctx.warn(w);
    ctx.log(warnings.length ? `人の作業が ${warnings.length} 件残っている（上の !。止めずに進む。docs/runbooks/00-setup-overview.md の 4 節）` : "global の 2 回目・SNS の購読・SES・AMI の固定・IAM のキー・SMTP の Secret は済んでいる");
    return;
  }

  throw new Error(`cloud は段階 ${ctx.phase} を持たない`);
}
