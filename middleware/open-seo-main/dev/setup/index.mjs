// OpenSEO の設定。環境変数ファイルの作成 → 起動 → /api/health の確認 → （--target prod だけ）本番のプロジェクト・Google Search Console と GA4 の接続（画面）
// → （--target prod の段階 operate）常駐しているかの確認（警告だけ）。
//
// target ごとの違い:
//   - OpenSEO はオンプレのローカルに 1 つだけあり（127.0.0.1:3001）、開発と本番のエージェントが同じものを使う（TA-07 の 3.7）
//   - --target dev: 起動と DataForSEO まで。Google（OAuth クライアント・Search Console・GA4）の手順は飛ばし、check でも求めない。
//     開発の時点では公開サイトが AWS に展開されておらず、Search Console のプロパティにも GA4 の本番のプロパティにもデータが無いため
//   - --target prod（段階 google。公開サイトが Route 53 から配信された後に --phase google で明示したときだけ動く）:
//     dev の内容に加えて、Google の OAuth クライアント・本番のドメイン（GSC_DOMAIN。既定 comegin.com）のプロジェクト・
//     Search Console の接続・GA4 の接続を案内する
//   - --target prod の段階 operate（2026-11-04 に追加）: 改善ループのエージェントが夜に MCP で呼ぶので、常駐しているか
//     （コンテナが running・再起動の設定が unless-stopped か always・systemd のユニット comegin-openseo が enabled かつ active で、
//     WorkingDirectory がこの作業ツリーの middleware/open-seo-main）と、プロジェクトと接続が揃っているかを
//     確かめる。止めずに警告だけ出す（コンテナが止まっていれば docker compose up -d で上げ直す。それ以外は変えない）
//
// 方針（setup/lib/core.mjs の契約）:
//   - open-seo-main は上流の取り込み。独自の追加は dev/setup/ の中だけ。上流の compose.yaml は変えずに、そのまま docker compose up -d する
//   - compose.yaml は env_file で同じディレクトリの環境変数ファイルを丸ごと渡す。ひな形は上流の環境変数のテンプレート（.env.example。全部コメントアウト）。
//     既に値があるキーは変えない（BETTER_AUTH_SECRET は保存済みの Google の OAuth トークンの暗号鍵なので、変えると接続が切れる）。
//     設定（<target>.conf）の値は、変わったら環境変数ファイルにも反映する（上流の環境変数ファイルにだけ値がある場合は、それを使う）
//   - 認証は AUTH_MODE=local_noauth（Docker の自前運用の上流の既定。127.0.0.1 だけにバインドされ、画面にも MCP にも認証が無い）。トンネルを張らない
//   - OpenSEO の費用が出るツール（DataForSEO を呼ぶもの）はここでは呼ばない。確かめるのは /api/health だけ（無認証・無料・値を返さない）
//   - Google Search Console の接続は、Google の同意画面を通るので画面の操作（ctx.manual）。接続の有無はアプリの DB の中にあり、
//     /api/health には出ない（health の gsc は「環境変数が揃っているか」だけ）
//   - GA4 の接続（ADR-25。本番のプロパティだけ）も GSC と同じ形。同じ OAuth クライアントに GA4 のリダイレクト URI を足し、
//     Google Analytics Admin API と Data API を有効にして、画面で Connect with Google を押す（同意は GSC とは別に 1 回要る）。
//     health には ga4 の項目が無い（check のキーは auth・dataforseo・gsc・ai・runtime と database だけ）。GA4 が要る環境変数は
//     GSC と同じ GOOGLE_CLIENT_ID・GOOGLE_CLIENT_SECRET・BETTER_AUTH_SECRET なので、health の gsc が Configured なら GA4 の環境変数も揃っている
//   - 接続は OpenSEO 自身の MCP（127.0.0.1:3001/mcp）の無料のツールで確かめる（2026-11-04。以前は OPENSEO_GSC_CONNECTED・
//     OPENSEO_GA4_CONNECTED=yes の申告だけだった）。呼ぶのは FREE_TOOLS の 3 本だけ（どれも DataForSEO を呼ばず、OpenSEO のクレジットを使わない。
//     Google の API を読むだけ）。エージェント（seo-auditor・analytics-reporter）は domain が comegin.com のプロジェクトを list_projects で
//     探すので、そのプロジェクトが 1 つだけあることも確かめる（2026-11-04 の夜の観測は、それが無くて GSC も GA4 も読めなかった）。
//     申告のキーは要らなくなった（書いてあっても使わない）
//
// 設定のキー（~/.config/comegin/setup/<target>.conf。雛形は setup/setup.conf.example）:
//   DATAFORSEO_API_KEY            DataForSEO の login:password を base64 にした値（ダッシュボードの API キーそのものではない）
//   OPENSEO_GOOGLE_CLIENT_ID / OPENSEO_GOOGLE_CLIENT_SECRET   Search Console 用の OAuth クライアント。無ければ GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET（admin-auth と共用）
//   OPENROUTER_API_KEY            任意。アプリ内の AI エージェント（SAM）を使うときだけ
//   OPENSEO_SKIP_GSC=yes          Search Console を使わないと決めたら書く（接続の案内をしない）
//   OPENSEO_SKIP_GA4=yes          GA4 を OpenSEO に接続しないと決めたら書く（接続の案内をしない。analytics-reporter は GA4 を読めなくなる）
//   GSC_DOMAIN                    任意。本番のドメイン（既定 comegin.com）。OpenSEO のプロジェクトの Domain と Search Console のドメインプロパティ
//   GA4_PROPERTY_ID               ga4 モジュールと共通。あれば、接続しているプロパティがこれと同じかを確かめる
//   （OPENSEO_GSC_CONNECTED・OPENSEO_GA4_CONNECTED は 2026-11-04 から使わない。接続は MCP で確かめる）
//   OPEN_SEO_IMAGE                任意。イメージの上書き（既定は下の PINNED_IMAGE。版を上げるときは定数を変えるのが正）
//
// 確かめた出典（middleware/open-seo-main のソース。動いているコンテナは health の version が 0.1.8）:
//   compose.yaml（env_file: .env。ポートは 127.0.0.1:${PORT:-3001}、AUTH_MODE は local_noauth 固定。BETTER_AUTH_SECRET・GOOGLE_CLIENT_ID・GOOGLE_CLIENT_SECRET・DATAFORSEO_API_KEY・OPENROUTER_API_KEY を渡す）
//   .env.example（環境変数のテンプレート。全部コメントアウト）、docs/SELF_HOSTING_DOCKER.md（`.env` を変えたら --force-recreate。初回起動はコンテナ内のビルドで 1〜2 分）
//   src/routes/api/health.ts・src/server/lib/setup-status.ts・src/lib/selfhost-preflight.ts
//     （GET /api/health は無認証。{ status: "ok"|"issues", version, authMode, checks: { auth, dataforseo, gsc, ai, database } }。各 check は { status: "ok"|"warn"|"error", detail? }。
//       dataforseo は未設定・不正なら warn、gsc は環境変数が揃うと detail が "Configured"、無ければ "Not configured (optional)..."（どちらも status は ok）、database は DB に問い合わせて失敗なら error）
//   docs/SELF_HOSTING_GOOGLE_SEARCH_CONSOLE.md（GOOGLE_CLIENT_ID・GOOGLE_CLIENT_SECRET・BETTER_AUTH_SECRET〈32 文字以上〉の 3 つが要る。
//     リダイレクト URI は http://localhost:3001/api/gsc/oauth/callback。接続は画面の Integrations の Connect with Google）
//   docs/DATAFORSEO_API_KEY.md（DATAFORSEO_API_KEY は base64 の login:password）
//   docs/SELF_HOSTING_GOOGLE_ANALYTICS.md（Analytics Admin API と Data API の有効化。GSC と同じクライアントでよく、GSC のリダイレクト URI は残す。
//     リダイレクト URI は http://localhost:3001/api/ga4/oauth/callback。接続はプロジェクトのダッシュボードか Project settings → Analytics の Connect with Google）
//   src/shared/ga4.ts（スコープは openid・email・profile・analytics.readonly だけ）、src/server/features/google/selfHostedOAuth.ts（callbackPath /api/ga4/oauth/callback）
//   src/lib/selfhost-preflight.ts（check のキーは auth・dataforseo・gsc・ai・runtime。ga4 は無い）、src/server/lib/setup-status.ts（これに database を足す）
//   src/server/mcp/tools/list-projects.ts（"Uses no credits"。structuredContent.projects[] に id・name・domain）、
//   src/server/mcp/tools/search-console-tools.ts（get_search_console_performance は "uses no credits"。未接続なら structuredContent.ok が false で reason）、
//   src/server/mcp/tools/google-analytics-tools.ts（get_google_analytics_measurement_health は GA4 の Admin API を読むだけ。接続済みなら structuredContent.source.propertyId）
//   /mcp は local_noauth で認証が無く、initialize を送らずに tools/call 1 回で応答する（2026-11-04 に 0.1.8 で curl して確かめた。応答は JSON）
//   画面: プロジェクトの Domain は Project settings → General、Google の接続は Project settings → Integrations（src/routes/_project/p/$projectId/settings*）
import { join } from "node:path";

export const meta = { id: "openseo", title: "OpenSEO（SEO のデータ。Search Console と GA4 の接続は prod の google、常駐の確認は prod の operate）", targets: ["dev", "prod"], phases: ["google", "operate"], after: [] };

const DIR = "middleware/open-seo-main";
const BASE_URL = "http://127.0.0.1:3001";
const GSC_REDIRECT_URI = "http://localhost:3001/api/gsc/oauth/callback";
const GA4_REDIRECT_URI = "http://localhost:3001/api/ga4/oauth/callback";
const MCP_URL = `${BASE_URL}/mcp`;
// setup から呼んでよい OpenSEO の MCP のツール（費用が出ない・書き込まないものだけ。ここに無い名前は callTool が断る）
const FREE_TOOLS = new Set(["list_projects", "get_search_console_performance", "get_google_analytics_measurement_health"]);
// 常駐とみなす再起動の設定（上流の compose.yaml は unless-stopped。動いている間に落ちたときの回復）
const RESIDENT_POLICIES = new Set(["unless-stopped", "always"]);
// 起動時に上げる systemd のユニット（雛形は onprem/systemd/comegin-openseo.service。置くのは人）
const UNIT = "comegin-openseo.service";
const UNIT_TEMPLATE = "onprem/systemd/comegin-openseo.service";
// イメージは版とダイジェストで固定する（上流の compose の既定は :latest。compose.yaml の image は ${OPEN_SEO_IMAGE:-...} なので、環境変数ファイルで差し替える）。
// 出典: docker buildx imagetools inspect ghcr.io/every-app/open-seo:0.1.8（:v0.1.8・2026-10-06 時点の :latest と同じダイジェスト）
const PINNED_IMAGE = "ghcr.io/every-app/open-seo:0.1.8@sha256:79f19fb7100e71133effa43898a2ba1ad4702075f3127e6ca91cd076e1101538";

const root = (ctx) => join(ctx.W, DIR);
const envPath = (ctx) => join(root(ctx), ".env");
const templatePath = (ctx) => join(root(ctx), ".env.example");
const yes = (v) => /^(yes|true|1)$/i.test(String(v ?? "").trim());
/** Google（Search Console・GA4）の手順を扱う target か。dev は AWS に展開されていないので扱わない */
const handlesGoogle = (ctx) => ctx.target === "prod";
/** 本番のドメイン（OpenSEO のプロジェクトの Domain・Search Console のドメインプロパティ） */
const prodDomain = (ctx) => normalizeDomain(ctx.value("GSC_DOMAIN") || "comegin.com");
const normalizeDomain = (d) => String(d ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
const GOOGLE_SKIPPED_IN_DEV = "Search Console と GA4 の接続は開発では飛ばす（公開サイトが AWS に無い）。公開サイトが Route 53 から配信された後に node setup/setup.mjs --target prod --phase google で行う";

// ---------------------------------------------------------------------------
// 設定の値（設定ファイル → 環境変数ファイルの今の値の順）
// ---------------------------------------------------------------------------

function googleClient(ctx) {
  return {
    id: ctx.conf.OPENSEO_GOOGLE_CLIENT_ID || ctx.conf.GOOGLE_CLIENT_ID || undefined,
    secret: ctx.conf.OPENSEO_GOOGLE_CLIENT_SECRET || ctx.conf.GOOGLE_CLIENT_SECRET || undefined,
  };
}

/** 設定の値を環境変数ファイルに書く。値が変わったら上書きする（設定が正）。書いたキーの名前を返す。
 *  Google の OAuth クライアントは prod のときだけ書く（環境変数ファイルは dev と prod で 1 つなので、dev.conf の
 *  GOOGLE_CLIENT_ID〈admin-auth 用〉で prod の接続に使っているクライアントを上書きしないため） */
function syncFromConf(ctx) {
  const google = handlesGoogle(ctx) ? googleClient(ctx) : {};
  return ctx.writeEnvFile(
    envPath(ctx),
    {
      AUTH_MODE: "local_noauth",
      OPEN_SEO_IMAGE: ctx.conf.OPEN_SEO_IMAGE || PINNED_IMAGE,
      DATAFORSEO_API_KEY: ctx.conf.DATAFORSEO_API_KEY || undefined,
      GOOGLE_CLIENT_ID: google.id,
      GOOGLE_CLIENT_SECRET: google.secret,
      OPENROUTER_API_KEY: ctx.conf.OPENROUTER_API_KEY || undefined,
    },
    { template: templatePath(ctx), onlyIfEmpty: false },
  );
}

/** 生成する秘密値。既にあれば変えない（保存済みの OAuth トークンの暗号鍵。変えると Search Console の接続が切れる） */
function ensureGenerated(ctx) {
  return ctx.writeEnvFile(envPath(ctx), { BETTER_AUTH_SECRET: ctx.randomSecret(32) }, { template: templatePath(ctx), onlyIfEmpty: true });
}

// ---------------------------------------------------------------------------
// /api/health
// ---------------------------------------------------------------------------

/** health の本体。応答が無ければ null */
async function readHealth(ctx) {
  try {
    return await ctx.http("OpenSEO health", `${BASE_URL}/api/health`);
  } catch (e) {
    if (e.status === 0) return null;
    throw e;
  }
}

/** 各 check を 1 行にする */
function describeChecks(health) {
  return Object.entries(health.checks ?? {}).map(([name, c]) => `${name}: ${c.status}${c.detail ? `（${c.detail}）` : ""}`);
}

// GA4 も同じ環境変数（Google の OAuth クライアントと BETTER_AUTH_SECRET）で動くので、health の gsc が Configured なら GA4 の環境変数も揃っている
const googleConfigured = (health) => String(health.checks?.gsc?.detail ?? "").startsWith("Configured");

// ---------------------------------------------------------------------------
// OpenSEO の MCP（無料のツールだけ）
// ---------------------------------------------------------------------------

/** MCP のツールを 1 回呼び、{ structured, text, isError } を返す。費用の出るツールは呼ばない（FREE_TOOLS） */
async function callTool(ctx, name, args = {}) {
  if (!FREE_TOOLS.has(name)) throw new Error(`setup から呼ばない OpenSEO のツール: ${name}（FREE_TOOLS に無い）`);
  const body = await ctx.http(`OpenSEO MCP ${name}`, MCP_URL, {
    method: "POST",
    headers: { Accept: "application/json, text/event-stream" },
    json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    timeoutMs: 60_000,
  });
  if (!body) throw new Error(`OpenSEO MCP ${name}: 応答を JSON として読めない（SSE で返っている場合がある。上流の版が変わっていないか確かめる）`);
  if (body.error) throw new Error(`OpenSEO MCP ${name}: ${String(body.error.message ?? "エラー").slice(0, 300)}`);
  const result = body.result ?? {};
  const text = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { structured: result.structuredContent ?? null, text, isError: result.isError === true };
}

/** 本番のドメインのプロジェクト。{ project, count, domains } */
async function findProject(ctx) {
  const domain = prodDomain(ctx);
  const { structured } = await callTool(ctx, "list_projects");
  const projects = structured?.projects ?? [];
  const matched = projects.filter((p) => normalizeDomain(p.domain) === domain);
  return { domain, project: matched.length === 1 ? matched[0] : null, count: matched.length, domains: projects.map((p) => `${p.name}（${p.domain || "Domain なし"}）`) };
}

/** Search Console の接続。{ connected, detail } */
async function probeGsc(ctx, project) {
  const r = await callTool(ctx, "get_search_console_performance", { projectId: project.id, rowLimit: 1 });
  if (r.structured?.ok === true) {
    const expected = `sc-domain:${prodDomain(ctx)}`;
    const site = r.structured.siteUrl ?? "?";
    return { connected: true, detail: site === expected ? site : `${site}。設計は ${expected}（ADR-09 のドメインプロパティ）なので選び直す`, mismatch: site !== expected };
  }
  return { connected: false, detail: (r.structured?.reason ?? r.text ?? "").slice(0, 200) || "未接続" };
}

/** GA4 の接続。{ connected, detail, mismatch } */
async function probeGa4(ctx, project) {
  const r = await callTool(ctx, "get_google_analytics_measurement_health", { projectId: project.id });
  const property = r.structured?.source?.propertyId;
  if (!r.isError && property) {
    const want = ctx.value("GA4_PROPERTY_ID");
    const mismatch = Boolean(want) && property !== `properties/${want}`;
    return { connected: true, detail: `${property}${mismatch ? `。設定の GA4_PROPERTY_ID は ${want} なので、本番のプロパティを選び直す` : ""}`, mismatch };
  }
  return { connected: false, detail: (r.structured?.reason ?? r.text ?? "").slice(0, 200) || "未接続" };
}

/** プロジェクトと Google の接続をまとめて確かめる。{ ok, notes, missing: { project, gsc, ga4 } } */
async function inspectProduction(ctx) {
  const notes = [];
  const missing = { project: false, gsc: false, ga4: false };
  const found = await findProject(ctx);
  if (!found.project) {
    missing.project = true;
    notes.push(found.count === 0
      ? `Domain が ${found.domain} のプロジェクトが無い（あるのは ${found.domains.join("・") || "無し"}）。エージェントが対象を決められず、GSC と GA4 を読めない`
      : `Domain が ${found.domain} のプロジェクトが ${found.count} 個ある（エージェントが 1 つに決められない。1 つにする）`);
    return { ok: false, notes, missing };
  }
  notes.push(`プロジェクト: ${found.project.name}（${found.domain}。${found.project.id}）`);
  let ok = true;
  for (const [key, label, skipKey, probe] of [["gsc", "Search Console", "OPENSEO_SKIP_GSC", probeGsc], ["ga4", "GA4", "OPENSEO_SKIP_GA4", probeGa4]]) {
    if (yes(ctx.value(skipKey))) {
      notes.push(`${label} は使わない（${skipKey}）`);
      continue;
    }
    const r = await probe(ctx, found.project);
    if (r.connected) notes.push(`${label}: 接続を確かめた（${r.detail}）`);
    else {
      notes.push(`${label}: 接続していない（${r.detail}）`);
      missing[key] = true;
      ok = false;
    }
    if (r.mismatch) ok = false;
  }
  return { ok, notes, missing };
}

// ---------------------------------------------------------------------------
// 常駐（systemd のユニット comegin-openseo が起動時に docker compose up -d する。2026-11-04 に、Docker の再起動の設定だけから改めた）
//   unless-stopped だけだと、人が docker compose stop したまま再起動すると上がらない。Strapi・n8n と同じくユニットに起動と停止を持たせ、
//   systemctl で 3 つまとめて見られるようにする。WireGuard には依存しない（ユニットは Requires=docker.service だけ）
// ---------------------------------------------------------------------------

/** ユニットの状態。{ installed, enabled, active, dir } */
async function unitState(ctx) {
  const show = async (prop) => {
    try {
      return (await ctx.run("systemctl", ["show", "-p", prop, "--value", UNIT], { timeoutMs: 10_000 })).trim();
    } catch {
      return "";
    }
  };
  if ((await show("LoadState")) !== "loaded") return { installed: false };
  return {
    installed: true,
    enabled: (await show("UnitFileState")) === "enabled",
    active: (await show("ActiveState")) === "active",
    dir: await show("WorkingDirectory"),
  };
}

const unitInstallHint = (ctx) =>
  `${UNIT_TEMPLATE} の User と WorkingDirectory（${root(ctx)}）を書き換え、人が自分の端末で置く: sudo install -m 644 ${UNIT_TEMPLATE} /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now ${UNIT}`;

/** { ok, notes, running } */
async function inspectResidency(ctx) {
  const notes = [];
  let id = "";
  try {
    id = (await ctx.run("docker", ["compose", "ps", "-a", "-q", "open-seo"], { cwd: root(ctx), timeoutMs: 30_000 })).trim().split("\n")[0] ?? "";
  } catch (e) {
    return { ok: false, running: false, notes: [`docker compose ps が失敗した（${String(e.message).split("\n")[0]}）`] };
  }
  if (!id) return { ok: false, running: false, notes: ["コンテナが無い（docker compose up -d で作る）"] };
  const [status, policy] = (await ctx.run("docker", ["inspect", "-f", "{{.State.Status}} {{.HostConfig.RestartPolicy.Name}}", id], { timeoutMs: 30_000 })).trim().split(/\s+/);
  const running = status === "running";
  let ok = running && RESIDENT_POLICIES.has(policy);
  notes.push(`コンテナ: ${status}、再起動の設定: ${policy || "?"}`);
  if (!running) notes.push(`動いていない（docker compose stop で止めたままなど）。作業で止めるときは sudo systemctl stop / start ${UNIT} を使う`);
  if (!RESIDENT_POLICIES.has(policy)) notes.push("再起動の設定が unless-stopped でも always でもない（上流の compose.yaml の restart を確かめる。動いている間に落ちたときに上がらない）");

  const unit = await unitState(ctx);
  if (!unit.installed) {
    ok = false;
    notes.push(`ユニット ${UNIT} が無い。マシンを再起動したときに上がる保証が無い。${unitInstallHint(ctx)}`);
    return { ok, running, notes };
  }
  notes.push(`ユニット ${UNIT}: ${unit.enabled ? "enabled" : "enabled でない"}・${unit.active ? "active" : "active でない"}・WorkingDirectory ${unit.dir || "（空）"}`);
  if (!unit.enabled) {
    ok = false;
    notes.push(`ユニットが enabled でない（マシンの起動のときに上がらない）。人が自分の端末で: sudo systemctl enable --now ${UNIT}`);
  }
  if (!unit.active) {
    ok = false;
    notes.push(`ユニットが active でない（systemctl stop したまま、か起動に失敗した）。sudo systemctl start ${UNIT}。失敗するなら journalctl -u ${UNIT} -n 50`);
  }
  if (unit.dir !== root(ctx)) {
    ok = false;
    notes.push(`ユニットの WorkingDirectory が ${unit.dir || "空"}（期待: ${root(ctx)}。環境変数ファイルを書いた場所でないと、起動に失敗するか、BETTER_AUTH_SECRET が違って Google の接続が切れる）。${unitInstallHint(ctx)}`);
  }
  return { ok, running, notes };
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

async function ensureStack(ctx, envChanged) {
  // .env を変えたときは、コンテナを作り直さないと反映されない（上流の docs/SELF_HOSTING_DOCKER.md）
  const args = envChanged ? ["compose", "up", "-d", "--force-recreate", "open-seo"] : ["compose", "up", "-d"];
  await ctx.run("docker", args, { cwd: root(ctx) });
  // 初回はコンテナの中でアプリをビルドしてから待ち受けるので長めに待つ
  if (!(await ctx.waitForHttp(`${BASE_URL}/api/health`, { timeoutMs: 300_000 }))) {
    throw new Error(`OpenSEO が ${BASE_URL} で応答しない。docker compose logs open-seo を見る（${DIR}。起動時の検査が [FAIL] で止めている場合がある）`);
  }
  ctx.log("起動している（127.0.0.1:3001。認証なし＝local_noauth なので、トンネルを張らない）");
}

// ---------------------------------------------------------------------------
// 画面の操作
// ---------------------------------------------------------------------------

function dataForSeoSteps(ctx) {
  return [
    "DataForSEO の API 認証情報を用意する（アカウントが無ければ作る。新規は 1 ドル分の無料クレジットがある。費用が出るのはこのキーで OpenSEO がデータを取るとき）",
    "https://app.dataforseo.com/api-access を開き、「Send by email」で認証情報を取り寄せ、「Base64」と書かれた長いほうの値を控える（login:password を base64 にした値。ダッシュボードの API キーではない）",
    `~/.config/comegin/setup/${ctx.target}.conf に DATAFORSEO_API_KEY=<その値> を書く（chmod 600。エディタで書く）`,
  ];
}

function googleClientSteps(ctx) {
  const useGsc = !yes(ctx.value("OPENSEO_SKIP_GSC"));
  const useGa4 = !yes(ctx.value("OPENSEO_SKIP_GA4"));
  const apis = [useGsc && "「Google Search Console API」", useGa4 && "「Google Analytics Admin API」と「Google Analytics Data API」"].filter(Boolean).join("、");
  const uris = [useGsc && GSC_REDIRECT_URI, useGa4 && GA4_REDIRECT_URI].filter(Boolean).join(" と ");
  return [
    `Google Cloud Console（https://console.cloud.google.com/）でプロジェクトを選ぶか作り、${apis}を有効にする`,
    "「APIs & Services → OAuth consent screen」で、Workspace 内だけなら Internal、そうでなければ External を選ぶ。External のまま Testing なら、接続する Google アカウントを Test users に足す（足さないと access_denied）",
    `「Credentials → Create credentials → OAuth client ID」で、種類を Web application にし、Authorized redirect URI に ${uris} を入れる（スキーム・ホスト・ポート・パスが完全に一致していること。末尾にスラッシュを付けない）`,
    "表示された Client ID と Client secret を ~/.config/comegin/setup/prod.conf に書く（chmod 600。エディタで書く）。OpenSEO 専用にするなら OPENSEO_GOOGLE_CLIENT_ID= と OPENSEO_GOOGLE_CLIENT_SECRET=、admin-auth と同じクライアントを使うなら GOOGLE_CLIENT_ID= と GOOGLE_CLIENT_SECRET=（その場合はクライアントに上のリダイレクト URI も足す）",
    "Search Console を使わないと決めたなら OPENSEO_SKIP_GSC=yes、GA4 を接続しないと決めたなら OPENSEO_SKIP_GA4=yes を書く（両方なら OAuth クライアントは要らない）",
  ];
}

function projectSteps(ctx, found) {
  const domain = prodDomain(ctx);
  return [
    "ブラウザで http://localhost:3001 を開く（127.0.0.1 ではなく localhost。リダイレクト URI と合わせる）",
    found?.count > 1
      ? `Domain が ${domain} のプロジェクトが ${found.count} 個ある。使うものを 1 つ決め、残りの Domain を消す（Project settings → General の Domain を空にして保存。プロジェクトを消すと保存済みの結果も消える）`
      : `本番のプロジェクトを 1 つ用意する。既にあるプロジェクト（初回に自動でできる Default）を使うなら、左上のプロジェクト名の歯車（Project settings）→ General の Domain に ${domain} を入れて保存する。新しく作るなら、プロジェクトの一覧の「New project」で Name（例 ComeGin）と Domain ${domain} を入れる（https:// と www. は付けない）`,
    "市場（location・language）は日本・日本語にする（list_projects の market が 2392/ja。キーワード調査の既定になる）",
    "このプロジェクトで、続けて Search Console と GA4 に接続する（接続はプロジェクトごと。別のプロジェクトで接続しても、エージェントは読めない）",
  ];
}

function gscConnectSteps() {
  return [
    "ブラウザで http://localhost:3001 を開き（127.0.0.1 ではなく localhost。リダイレクト URI と合わせる）、本番のドメインのプロジェクトを選ぶ",
    "Project settings → Integrations の Search Console の「Connect with Google」を押して、Search Console で確認済みのプロパティを持つ Google アカウントで同意する",
    "ドメインプロパティ sc-domain:comegin.com を選ぶ（「No properties available」なら setup/manual-steps.md の 7.4 のとおり、先にドメインプロパティを登録する）",
    "同じコマンドを実行し直す（接続は OpenSEO の MCP で確かめる。設定に OPENSEO_GSC_CONNECTED を書く必要は無い）",
  ];
}

function ga4ConnectSteps() {
  return [
    "本番の GA4 プロパティがまだ無ければ、先に middleware/ga4/README.md の 5 節のとおり作る（OpenSEO に接続するのは本番のプロパティだけ。開発用のプロパティは作らない）",
    "Google Cloud Console（https://console.cloud.google.com/）の Search Console と同じプロジェクトで「Google Analytics Admin API」と「Google Analytics Data API」を有効にする（済んでいれば飛ばす。Admin API が無効だと接続の画面にプロパティが出ない）",
    `同じ OAuth クライアント（Credentials の Web application）の Authorized redirect URI に ${GA4_REDIRECT_URI} を足す（${GSC_REDIRECT_URI} は残す。済んでいれば飛ばす）`,
    "ブラウザで http://localhost:3001 を開き（127.0.0.1 ではなく localhost）、本番のドメインのプロジェクトの Project settings → Integrations（またはダッシュボード）の GA4 の「Connect with Google」を押す",
    "本番のプロパティを読める Google アカウントで、読み取りだけ（analytics.readonly）の同意をする（GSC の接続とは別に 1 回要る）。External のまま Testing なら、そのアカウントを Test users に足しておく",
    "本番のプロパティを選ぶ",
    "同じコマンドを実行し直す（接続と、選んだプロパティが GA4_PROPERTY_ID と同じかを OpenSEO の MCP で確かめる。設定に OPENSEO_GA4_CONNECTED を書く必要は無い）",
  ];
}

// ---------------------------------------------------------------------------
// 契約
// ---------------------------------------------------------------------------

/** health の基本（起動・DB・認証なし・DataForSEO）。{ ok, notes } */
function healthBasics(health) {
  const notes = [`OpenSEO ${health.version ?? "?"}（status: ${health.status}、authMode: ${health.authMode}）`, ...describeChecks(health).map((l) => `  ${l}`)];
  let ok = health.status === "ok" && health.authMode === "local_noauth" && health.checks?.database?.status === "ok";
  if (health.authMode !== "local_noauth") notes.push("authMode が local_noauth ではない（トンネルを張らない前提が崩れる）");
  if (health.checks?.dataforseo?.status !== "ok") ok = false;
  return { ok, notes };
}

/** Google の環境変数（OAuth クライアントと BETTER_AUTH_SECRET）が要るのに揃っていないか */
const googleClientMissing = (ctx, health) => !(yes(ctx.value("OPENSEO_SKIP_GSC")) && yes(ctx.value("OPENSEO_SKIP_GA4"))) && !googleConfigured(health);

/** 段階 operate の確かめ（常駐・プロジェクト・接続）。{ ok, notes } */
async function inspectOperate(ctx, health) {
  const basics = healthBasics(health);
  const residency = await inspectResidency(ctx);
  const notes = [...basics.notes, ...residency.notes];
  let ok = basics.ok && residency.ok;
  if (googleClientMissing(ctx, health)) {
    notes.push("Google の OAuth クライアントが OpenSEO の環境変数に無い（段階 google を先に済ませる）");
    return { ok: false, notes };
  }
  const prod = await inspectProduction(ctx);
  notes.push(...prod.notes);
  ok &&= prod.ok;
  if (!prod.ok) notes.push("足りないものは node setup/setup.mjs --target prod --phase google --only openseo が案内する（setup/manual-steps.md の 7.4〜7.6）");
  return { ok, notes };
}

export async function check(ctx) {
  const health = await readHealth(ctx);
  if (!health) {
    const notes = [`OpenSEO が ${BASE_URL} で応答しない`];
    if (ctx.phase === "operate") notes.push(...(await inspectResidency(ctx)).notes);
    return { ok: false, notes };
  }
  if (ctx.phase === "operate") return inspectOperate(ctx, health);

  const { ok, notes } = healthBasics(health);

  if (!handlesGoogle(ctx)) {
    notes.push(GOOGLE_SKIPPED_IN_DEV);
    return { ok, notes };
  }

  if (googleClientMissing(ctx, health)) {
    notes.push("Search Console・GA4 の環境変数（Google の OAuth クライアントと BETTER_AUTH_SECRET）が揃っていない");
    return { ok: false, notes };
  }
  const prod = await inspectProduction(ctx);
  notes.push(...prod.notes);
  return { ok: ok && prod.ok, notes };
}

/** 段階 operate: 止まっていれば上げ直し、残りは警告だけ（止めない） */
async function applyOperate(ctx) {
  if (!(await ctx.commandExists("docker"))) throw new Error("docker が無い。Docker Engine（と Compose）を入れてから実行し直す");
  const residency = await inspectResidency(ctx);
  if (!residency.running) {
    ctx.warn("OpenSEO のコンテナが動いていないので docker compose up -d で上げ直す（環境変数ファイルは変えない）");
    await ensureStack(ctx, false);
  }
  const health = await readHealth(ctx);
  if (!health) {
    ctx.warn(`OpenSEO が ${BASE_URL} で応答しない。docker compose logs open-seo を見る（${DIR}）`);
    return;
  }
  const r = await inspectOperate(ctx, health);
  for (const n of r.notes) (r.ok ? ctx.log : ctx.warn)(n);
  if (r.ok) ctx.log(`常駐している（ユニット ${UNIT} が起動時に上げる）。本番のプロジェクトと Google の接続も揃っている`);
  else ctx.warn("OpenSEO に足りないものがある（止めずに続ける）。onprem/README.md の「常駐させる（OpenSEO）」と setup/manual-steps.md の 7.4〜7.6");
}

export async function apply(ctx) {
  if (ctx.phase === "operate") return applyOperate(ctx);
  if (!(await ctx.commandExists("docker"))) throw new Error("docker が無い。Docker Engine（と Compose）を入れてから実行し直す");

  const changed = [...syncFromConf(ctx), ...ensureGenerated(ctx)];
  if (changed.length) ctx.log(`環境変数ファイルに書いた: ${changed.join(", ")}（${DIR} の環境変数ファイル。権限 600）`);

  await ensureStack(ctx, changed.length > 0);
  const health = await readHealth(ctx);
  ctx.log(`health: ${describeChecks(health).join(" / ")}`);

  if (health.checks?.database?.status !== "ok") throw new Error("OpenSEO のデータベースが使えない（health の database が ok ではない）。docker compose logs open-seo を見る");
  if (health.authMode !== "local_noauth") throw new Error(`OpenSEO の authMode が local_noauth ではない（${health.authMode}）。環境変数ファイルの AUTH_MODE を確かめる`);

  if (health.checks?.dataforseo?.status !== "ok") ctx.manual("dataforseo-key", "DataForSEO の API キーを設定に書く", dataForSeoSteps(ctx));

  if (!handlesGoogle(ctx)) {
    ctx.log(GOOGLE_SKIPPED_IN_DEV);
    ctx.log(`終わった。画面: ${BASE_URL}（認証なし。ループバックだけ）`);
    return;
  }

  if (googleClientMissing(ctx, health)) {
    ctx.manual("google-oauth-client", "Search Console と GA4 用の Google の OAuth クライアントを作って設定に書く", googleClientSteps(ctx));
  }

  const found = await findProject(ctx);
  if (!found.project) ctx.manual("project", `OpenSEO に本番のドメイン（${found.domain}）のプロジェクトを 1 つだけ用意する`, projectSteps(ctx, found));

  const prod = await inspectProduction(ctx);
  for (const n of prod.notes) ctx.log(n);
  if (prod.missing.gsc) ctx.manual("gsc-connect", "OpenSEO の画面で Google Search Console に接続する", gscConnectSteps());
  if (prod.missing.ga4) ctx.manual("ga4-connect", "OpenSEO の画面で GA4（本番のプロパティ）に接続する", ga4ConnectSteps());
  if (!prod.ok) ctx.warn("接続しているプロパティが設計と違う（上の行）。OpenSEO の Project settings → Integrations で選び直す");

  ctx.log(`終わった。画面: ${BASE_URL}（認証なし。ループバックだけ）。常駐の確認は --phase operate で行う`);
}
