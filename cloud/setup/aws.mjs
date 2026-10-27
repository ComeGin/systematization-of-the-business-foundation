// 本番の AWS を読み取るだけの共通部品。cloud/setup/index.mjs と、段階 apps のモジュール（chatwoot-prod・mautic-prod・n8n-prod）が使う。
// モジュールではない（setup.mjs の MODULES には入れない）。
//
// 方針は cloud/setup/index.mjs と同じ: AWS には読み取りだけ。書き込み（デプロイ・RunTask・Secret の値）は人が行い、モジュールは案内して止まる。
// AWS の認証は環境（AWS_PROFILE・SSO）に任せる。子プロセスの aws はこのプロセスの環境変数をそのまま受け継ぐ。
//
// 確かめた出典: cloud/template.yaml（親の出力 ClusterName・OpsAlertTopicArn・LeadAlertTopicArn・Onprem*UserName、パラメータ *DesiredCount・
// WireguardFixedAmiId・DomainName）、cloud/stacks/cluster.yaml（ロググループ /comegin/<env>/tasks）、cloud/stacks/ops-tasks.yaml
// （DB 作成のタスクが最後に出す「db-init-postgres: done」「db-init-mysql: done」）、cloud/stacks/services/*.yaml（サービス名 comegin-<env>-<svc>）

export const ENV_NAME = "prod";
export const REGION = "ap-northeast-1";
export const GLOBAL_REGION = "us-east-1";
export const STACK = `comegin-${ENV_NAME}`;
export const GLOBAL_STACK = `comegin-global-${ENV_NAME}`;
export const TASKS_LOG_GROUP = `/comegin/${ENV_NAME}/tasks`;

const NOT_FOUND = /does not exist|ImageNotFoundException|RepositoryNotFoundException|ResourceNotFoundException|NotFoundException|NoSuchEntity/;

/** aws CLI を JSON で呼ぶ。対象が無いときは null。出力に警告が混ざっても読めるよう、最初の { から読む */
export async function awsJson(ctx, args) {
  let out;
  try {
    out = await ctx.run("aws", [...args, "--output", "json"], { timeoutMs: 60_000 });
  } catch (e) {
    if (NOT_FOUND.test(e.message)) return null;
    throw e;
  }
  const i = out.indexOf("{");
  if (i < 0) throw new Error(`aws ${args.slice(0, 2).join(" ")} の応答が JSON ではない`);
  return JSON.parse(out.slice(i));
}

/** スタックを 1 つ読む。無ければ null */
export async function describeStack(ctx, name = STACK, region = REGION) {
  const r = await awsJson(ctx, ["cloudformation", "describe-stacks", "--region", region, "--stack-name", name]);
  return r?.Stacks?.[0] ?? null;
}

/** 本番スタック。無ければ、先に段階 deploy を行うよう止める（例外） */
export async function requireMainStack(ctx) {
  const main = await describeStack(ctx);
  if (!main) throw new Error(`スタック ${STACK} が無い。先に node setup/setup.mjs --target prod --phase deploy`);
  return main;
}

export const outputOf = (stack, key) => stack?.Outputs?.find((o) => o.OutputKey === key)?.OutputValue;
export const parameterOf = (stack, key) => stack?.Parameters?.find((p) => p.ParameterKey === key)?.ParameterValue;

/** Secret に値（AWSCURRENT の版）が入っているか。値そのものは読まない。Secret が無ければ null */
export async function secretHasValue(ctx, name) {
  const r = await awsJson(ctx, ["secretsmanager", "describe-secret", "--region", REGION, "--secret-id", `comegin/${ENV_NAME}/${name}`]);
  if (!r) return null;
  return Object.values(r.VersionIdsToStages ?? {}).some((stages) => stages.includes("AWSCURRENT"));
}

// ---------------------------------------------------------------------------
// DB 作成のタスク（cloud/README.md の 4.8）
// ---------------------------------------------------------------------------

/**
 * DB 作成のタスク（engine は postgres か mysql）が、今の本番スタックを作った後に成功したか。
 * ロググループの保持期間（既定 30 日）を過ぎるとログは消えるので、一度確かめたら状態にスタックの作成時刻を残す
 * （スタックを作り直すと Secret のパスワードが変わり、DB 作成をやり直す必要があるため、作成時刻が変わったら確かめ直す）。
 * record が false（check。読むだけの契約）のときは状態に書かない
 */
export async function dbInitDone(ctx, main, engine, { record = true } = {}) {
  const key = `DB_INIT_${engine.toUpperCase()}_STACK_CREATED`;
  if (ctx.state.get(key) === main.CreationTime) return true;
  const r = await awsJson(ctx, [
    "logs", "filter-log-events", "--region", REGION, "--log-group-name", TASKS_LOG_GROUP,
    "--filter-pattern", `"db-init-${engine}: done"`, "--start-time", String(Date.parse(main.CreationTime)), "--max-items", "1",
  ]);
  const done = Boolean(r?.events?.length);
  if (done && record) ctx.state.set(key, main.CreationTime);
  return done;
}

export function dbInitSteps(engines) {
  return [
    `DB 作成のタスクが、今の本番スタックの作成の後に成功した記録が無い: ${engines.map((e) => `comegin-${ENV_NAME}-db-init-${e}`).join("・")}（ロググループ ${TASKS_LOG_GROUP} に「db-init-<engine>: done」が無い）`,
    "人が自分の端末で RunTask する（AWS への書き込み）。変数の用意・実行・成否の見方は cloud/README.md の 4.8 の手順 1〜4 のとおり（関数の定義と変数の設定は行を分ける）",
    "  PostgreSQL（chatwoot・admin_auth・strapi・n8n）: --task-definition comegin-prod-db-init-postgres。ログの最後が db-init-postgres: done",
    "  MySQL（mautic）: --task-definition comegin-prod-db-init-mysql。ログの最後が db-init-mysql: done",
    "exitCode が 1 で sha256sum の WARNING が出たら、RDS の CA 束が更新されている（cloud/README.md の 4.7 の更新の手順）",
    "同じコマンドを実行し直す",
  ];
}

// ---------------------------------------------------------------------------
// ECS のサービス（cloud/README.md の 4.11）
// ---------------------------------------------------------------------------

/**
 * サービスの台数。param は親のパラメータ（CloudFormation の DesiredCount。昼の台数）、running は今動いているタスクの数。
 * 夜間の停止（chatwoot-web・chatwoot-worker・mautic-cron）のあいだは、ECS の desiredCount が 0 になるので、上げたかは param で見る
 */
export async function serviceCounts(ctx, main, svc, param) {
  const cluster = outputOf(main, "ClusterName") || STACK;
  const r = await awsJson(ctx, ["ecs", "describe-services", "--region", REGION, "--cluster", cluster, "--services", `comegin-${ENV_NAME}-${svc}`]);
  const s = r?.services?.[0];
  return { svc, param, desiredParam: Number(parameterOf(main, param) ?? 0), desired: s?.desiredCount ?? 0, running: s?.runningCount ?? 0, exists: Boolean(s && s.status === "ACTIVE") };
}

/** 動いているべきなのに running が 0 のサービスへの警告文（夜間の停止の可能性を添える） */
export function notRunningNote(c) {
  return `comegin-${ENV_NAME}-${c.svc} は DesiredCount ${c.desiredParam} だが、動いているタスクが 0（ECS の desiredCount ${c.desired}。0 なら夜間の停止〈既定 22 時〜翌 8 時〉の最中。昼なら ECS のサービスのイベントとタスク数のアラームを見る）`;
}

/** DesiredCount を上げるときの案内（samconfig.toml に書いて sam deploy。ECS を直接変えない） */
export function raiseCountSteps(params, before = []) {
  return [
    ...before,
    `cloud/samconfig.toml の parameter_overrides に ${params.map((p) => `"${p}=1"`).join("・")} を書く（aws ecs update-service で直接変えない。次のデプロイで戻る。cloud/README.md の 2 節の「重要」）`,
    "cd cloud && sam build && sam deploy（人が自分の端末で実行する。1 つ上げるたびに cloud/README.md の 4.13 の確認と、アラームが鳴っていないことを見る）",
    "同じコマンドを実行し直す",
  ];
}
