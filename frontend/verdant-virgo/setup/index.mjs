// 公開サイト（frontend/verdant-virgo。Astro）の設定。setup/lib/core.mjs の契約に従う。
// 環境変数ファイル → pnpm install → 計測の道具（Lighthouse CI の Chrome・a11y の Chromium）→ 受け口の確認 → dev サーバー。
//
// target ごとの違い:
//   - --target dev: .env を書く。値はバックエンドのモジュールが状態に置いたもの（STRAPI_BUILD_TOKEN・CHATWOOT_WEBSITE_TOKEN・
//     MAUTIC_FORM_ID_CONSULT）と consent-api の環境変数ファイルから写す。dev サーバーは astro dev --background で起動する
//     （端末を抱えない。止めるのは astro dev stop。frontend/verdant-virgo/AGENTS.md）
//   - --target prod: 承認済みの main のチェックアウト（SITE_BUILD_CHECKOUT。空なら CONTROL_MAIN_CHECKOUT）にだけ .env.production を書く
//     （DD-05 の 1 節。本番のトークンはここにだけ置く）。値は prod.conf から。作業ツリーには書かない:
//     astro build は production モードで .env.production を .env より優先して読むため、作業ツリーに置くと pnpm lh などの
//     開発のビルドまで本番の値で焼かれる（配信するビルドは承認済みのコードから作る。ADR-18 と同じ考え方）。
//     記事は本番の Strapi（オンプレの 127.0.0.1:1338。ADR-21）をビルド時に読み、dist/ に取り込む（公開サイトは実行時に Strapi を読まない）。
//     ビルドと配信はしない（ビルドの実行は人が指示する。配信は人間が承認する。ADR-15・cloud/README.md の 4.14）。
//     Search Console のドメインプロパティの所有権（Route 53 の TXT）を DNS で確かめる（AA-02 の表の 1。人の作業）
//
// 方針:
//   - 状態・設定から写す値（トークン・ID・同意の版）は、環境変数ファイルの今の値より優先して書き換える（正本は状態・設定）。
//     既定値（URL など）は空のキーだけに書く。.env.example の SITE_URL=https://example.com は未設定とみなす
//   - 開発の環境変数ファイルに PUBLIC_GA4_MEASUREMENT_ID があれば失敗にする（開発ではタグを出さない。ADR-25。ga4 モジュールと同じ判定）
//   - 受け口（Strapi・Chatwoot・Mautic・consent-api）が止まっていても失敗にしない（警告だけ）。各製品はバックエンドの setup が用意する
//
// 確かめた出典:
//   frontend/verdant-virgo/.env.example・README.md（環境変数の表）、astro.config.mjs（SITE_URL の停止・allowedHosts）、
//   src/modules/blog/integration.ts（BUILD_TARGET=production で STRAPI_URL が開発の Strapi〈localhost の 1338 以外・ngrok〉なら停止）、
//   cloud/stacks/edge.yaml（cms.comegin.com は ADR-21 で ALB から外した）、~/.config/ngrok/ngrok.yml（開発の Strapi は comegin-strapi-dev.ngrok.app）、
//   lighthouserc.cjs（Chrome を headless で起動）、playwright.config.ts（Desktop Chrome と Pixel 7。どちらも Chromium）、
//   https://docs.astro.build/en/guides/environment-variables/#env-files（astro build は production モード。.env.production を読む）、
//   astro dev --help（--background・stop・status。Astro 7.3）
import { resolveTxt } from "node:dns/promises";
import { chmodSync, existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

export const meta = {
  id: "verdant-virgo",
  title: "公開サイト（Astro。環境変数・導入・計測の道具・dev サーバー）",
  targets: ["dev", "prod"],
  // dev は開発のモジュール、prod は chatwoot-prod・mautic-prod（website_token とフォームの ID を状態に置く）の後
  after: ["ga4", "strapi", "chatwoot", "mautic", "consent-api", "chatwoot-prod", "mautic-prod"],
};

const DIR = "frontend/verdant-virgo";
const DEV_URL = "http://localhost:4321";
const NGROK_HOSTS = ["comegin-astro-dev.ngrok.app"]; // astro.config.mjs の vite.server.allowedHosts と同じにする
const EXAMPLE_SITE_URL = "https://example.com";
const DEV_ENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
]; // Vite が開発で読む順
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);
const MIN_NODE = [22, 12];
// 本番の Strapi（onprem/strapi。127.0.0.1 だけに開く）と、開発の Strapi を ngrok で開くホスト。integration.ts の判定と同じにする
const PROD_STRAPI_URL = "http://127.0.0.1:1338";
const DEV_STRAPI_HOSTS = new Set(["comegin-strapi-dev.ngrok.app"]);

// 開発の既定値（空のキーだけに書く）。本番の既定値は prodValues の中（docs/DetailedDesign/02-public-path-flows.md の表）
const DEV_DEFAULTS = {
  BUILD_TARGET: "development",
  STRAPI_URL: "http://localhost:1337",
  PUBLIC_POSTHOG_HOST: "https://us.i.posthog.com",
  PUBLIC_CHATWOOT_BASE: "http://localhost:3100",
  PUBLIC_MAUTIC_BASE: "http://localhost:8000",
  PUBLIC_CALCOM_BASE: "https://app.cal.com",
  PUBLIC_CONSENT_BASE: "http://localhost:3104",
};

/**
 * 本番のビルドを行うチェックアウト（承認済みの main）。作業ツリーと同じ場所・公開サイトが無い場所なら止める
 * （作業ツリーに .env.production を置くと、開発のビルドが本番の値で焼かれるため）
 */
function prodCheckoutOf(ctx) {
  const checkout =
    ctx.value("SITE_BUILD_CHECKOUT") || ctx.value("CONTROL_MAIN_CHECKOUT");
  if (!checkout) {
    throw new Error(
      "本番のビルドを行うチェックアウトが決まっていない。~/.config/comegin/setup/prod.conf に SITE_BUILD_CHECKOUT=<承認済みの main のチェックアウトの絶対パス>（空なら CONTROL_MAIN_CHECKOUT）を書く。" +
        "作り方は setup/manual-steps.md の 6 節（git worktree add --detach … origin/main）",
    );
  }
  if (!checkout.startsWith("/"))
    throw new Error("SITE_BUILD_CHECKOUT は絶対パスにする");
  if (!existsSync(join(checkout, DIR)))
    throw new Error(
      `${checkout} に ${DIR} が無い（古いコミットを指していないか。git -C ${checkout} checkout --detach origin/main を人が実行する）`,
    );
  if (realpathSync(checkout) === realpathSync(ctx.REPO)) {
    throw new Error(
      `SITE_BUILD_CHECKOUT（${checkout}）が作業ツリーと同じ場所。作業ツリーに .env.production を置くと、pnpm lh などの開発のビルドが本番の値で焼かれるので、承認済みの main の別のチェックアウトにする`,
    );
  }
  return checkout;
}

const dirOf = (ctx) =>
  join(ctx.target === "prod" ? prodCheckoutOf(ctx) : ctx.W, DIR);
const envPathOf = (ctx) =>
  join(dirOf(ctx), ctx.target === "prod" ? ".env.production" : ".env");
const trimUrl = (u) => String(u).replace(/\/+$/, "");
const isLocal = (u) => {
  try {
    return LOCAL_HOSTS.has(new URL(u).hostname);
  } catch {
    return false;
  }
};
/** 配信用のビルドが読んではいけない開発の Strapi か（integration.ts の isDevStrapi と同じ判定） */
const isDevStrapi = (u) => {
  try {
    const url = new URL(u);
    return (
      DEV_STRAPI_HOSTS.has(url.hostname) ||
      (LOCAL_HOSTS.has(url.hostname) &&
        url.port !== new URL(PROD_STRAPI_URL).port)
    );
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// 道具
// ---------------------------------------------------------------------------

async function ensureTooling(ctx) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1]))
    throw new Error(
      `Node ${process.versions.node} は古い。package.json の engines は >=${MIN_NODE.join(".")}.0`,
    );
  let v;
  try {
    v = (await ctx.run("pnpm", ["--version"])).trim();
  } catch {
    throw new Error(
      "pnpm が使えない。pnpm 11 以上を入れる（corepack enable && corepack prepare pnpm@latest --activate など）",
    );
  }
  // pnpm-workspace.yaml の minimumReleaseAge などは pnpm 11 未満では効かない（黙って無効になる）
  if (Number(v.split(".")[0]) < 11)
    throw new Error(
      `pnpm ${v} は古い。pnpm 11 以上が要る（供給網対策の設定が pnpm 11 未満では効かない）`,
    );
}

/** Lighthouse CI が起動する Chrome（chrome-launcher は CHROME_PATH か、入っている Chrome・Chromium を探す） */
async function chromeFor(ctx) {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH))
    return process.env.CHROME_PATH;
  for (const c of [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ])
    if (await ctx.commandExists(c)) return c;
  return null;
}

/** a11y の検査（Playwright）が使う Chromium が入っているか。版はこのプロジェクトの @playwright/test が決める */
async function playwrightChromiumReady(ctx) {
  try {
    const out = await ctx.run(
      "pnpm",
      ["exec", "playwright", "install", "--dry-run", "chromium"],
      { cwd: dirOf(ctx), timeoutMs: 60_000 },
    );
    // dry-run は入れ先（Install location）を表示する。そこが既にあれば入っている
    const locations = [...out.matchAll(/Install location:\s*(\S+)/g)].map(
      (m) => m[1],
    );
    return locations.length > 0 && locations.every((p) => existsSync(p));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 環境変数の値
// ---------------------------------------------------------------------------

/** consent-api の環境変数ファイル（無ければ雛形）から、同じ値にそろえる 2 つを読む */
function consentValues(ctx) {
  const dir = join(ctx.W, "backend/consent-api");
  const env = existsSync(join(dir, ".env"))
    ? ctx.readEnvFile(join(dir, ".env"))
    : ctx.readEnvFile(join(dir, ".env.example"));
  return {
    policy: env.CONSENT_POLICY_VERSION,
    cookieDomain: env.COOKIE_DOMAIN ?? "",
    siteUrl: env.SITE_URL,
  };
}

/** 開発の Strapi の環境変数ファイルの PostHog のトークンとホスト（.env.example の初期値 phc_tobemodified は無いものとみなす） */
function posthogFromStrapi(ctx) {
  const env = ctx.readEnvFile(join(ctx.W, "backend/strapi-system/.env"));
  const token = env.POSTHOG_PROJECT_TOKEN;
  return {
    token:
      token?.startsWith("phc_") && token !== "phc_tobemodified"
        ? token
        : undefined,
    host: env.POSTHOG_HOST,
  };
}

/**
 * 開発の値。fill は空のキーだけに書く既定値、force は状態・設定を正本として今の値より優先して書く値。
 * 状態に無い値（バックエンドの setup がまだ）は書かずに warnings に入れる
 */
function devValues(ctx, current) {
  const warnings = [];
  const fill = { ...DEV_DEFAULTS };
  const force = {};
  const site = trimUrl(ctx.value("PUBLIC_SITE_URL") || DEV_URL);
  if (!current.SITE_URL || current.SITE_URL === EXAMPLE_SITE_URL)
    force.SITE_URL = site;
  else if (ctx.conf.PUBLIC_SITE_URL) force.SITE_URL = site;

  const fromState = [
    [
      "STRAPI_API_TOKEN",
      "STRAPI_BUILD_TOKEN",
      "strapi（記事の取得。無いと pnpm build・pnpm lh が止まり、dev のブログも出ない）",
    ],
    [
      "PUBLIC_CHATWOOT_WEBSITE_TOKEN",
      "CHATWOOT_WEBSITE_TOKEN",
      "chatwoot（無いとチャットのウィジェットを読み込まない）",
    ],
    [
      "MAUTIC_FORM_ID_CONSULT",
      "MAUTIC_FORM_ID_CONSULT",
      "mautic（無いと無料相談のフォームの送信が失敗表示になる）",
    ],
  ];
  for (const [envKey, stateKey, why] of fromState) {
    const v = ctx.value(stateKey);
    if (v) force[envKey] = String(v);
    else if (!current[envKey])
      warnings.push(
        `${stateKey} が状態に無い。バックエンドの ${why}。node setup/setup.mjs --target dev を先に`,
      );
  }
  // 開発の Strapi を ngrok で読むなら dev.conf に SITE_STRAPI_URL=https://comegin-strapi-dev.ngrok.app（空なら localhost:1337）
  if (ctx.conf.SITE_STRAPI_URL)
    force.STRAPI_URL = trimUrl(ctx.conf.SITE_STRAPI_URL);
  if (ctx.conf.CHATWOOT_BASE_URL)
    force.PUBLIC_CHATWOOT_BASE = trimUrl(ctx.conf.CHATWOOT_BASE_URL);
  if (ctx.conf.MAUTIC_BASE_URL)
    force.PUBLIC_MAUTIC_BASE = trimUrl(ctx.conf.MAUTIC_BASE_URL);

  // 同意の版と Cookie の Domain は consent-api と同じ値にする（違うと同意を毎回取り直す・Cookie が 2 つできる。.env.example）
  const consent = consentValues(ctx);
  if (consent.policy) force.CONSENT_POLICY_VERSION = consent.policy;
  force.PUBLIC_CONSENT_COOKIE_DOMAIN = consent.cookieDomain;

  // 任意の外部サービス（どちらも公開ページに埋め込む前提の値で、秘密値ではない）。
  // PostHog は環境ごとに 1 プロジェクトで、Strapi のサーバー側のイベントと同じプロジェクトに送る（ops/mcp-registry.yaml の posthog-prod は
  // 本番のプロジェクト 1 つに固定）。設定に無ければ、開発の Strapi の環境変数ファイルのトークンを既定にする（空のキーだけ）
  const strapiPosthog = posthogFromStrapi(ctx);
  if (ctx.conf.SITE_POSTHOG_PROJECT_TOKEN)
    force.PUBLIC_POSTHOG_PROJECT_TOKEN = ctx.conf.SITE_POSTHOG_PROJECT_TOKEN;
  else if (strapiPosthog.token)
    fill.PUBLIC_POSTHOG_PROJECT_TOKEN = strapiPosthog.token;
  if (ctx.conf.SITE_POSTHOG_HOST)
    force.PUBLIC_POSTHOG_HOST = trimUrl(ctx.conf.SITE_POSTHOG_HOST);
  else if (strapiPosthog.host)
    fill.PUBLIC_POSTHOG_HOST = trimUrl(strapiPosthog.host);
  if (ctx.conf.CALCOM_LINK) force.PUBLIC_CALCOM_LINK = ctx.conf.CALCOM_LINK;
  return { fill, force, warnings };
}

/** 本番の値。すべて prod.conf（と状態）から。足りないキーは missing に入れる */
function prodValues(ctx) {
  const missing = [];
  const req = (key, hint, value = ctx.value(key)) => {
    if (!value) missing.push(hint ? `${key}（${hint}）` : key);
    return value;
  };
  // chatwoot-prod・mautic-prod が状態に置く値は、状態を先に読む（受信箱やフォームを作り直したとき、prod.conf の古い値を焼かない）
  const stateFirst = (key) => ctx.state.get(key) || ctx.conf[key];
  const consent = consentValues(ctx);
  const values = {
    SITE_URL: trimUrl(
      req(
        "PUBLIC_SITE_URL",
        "本番の公開サイトの URL。apex か www かは TA-02 の 9 節で決める",
      ) ?? "",
    ),
    BUILD_TARGET: "production",
    // 本番の Strapi はオンプレの 127.0.0.1:1338 だけ（ADR-21。cms.comegin.com は無い）。記事はビルド時に読んで dist/ に取り込む
    STRAPI_URL: trimUrl(ctx.value("SITE_STRAPI_URL") || PROD_STRAPI_URL),
    STRAPI_API_TOKEN: req(
      "SITE_STRAPI_API_TOKEN",
      "本番の Strapi の読み取り専用 API トークン。権限は article・category・author の find / findOne だけ",
    ),
    UPLOAD_S3_BUCKET: req(
      "UPLOAD_S3_BUCKET",
      "本番の Strapi のメディアのバケット。onprem/strapi と同じ値",
    ),
    UPLOAD_S3_REGION: ctx.value("UPLOAD_S3_REGION") || "ap-northeast-1",
    PUBLIC_GA4_MEASUREMENT_ID: req(
      "GA4_MEASUREMENT_ID",
      "ga4 モジュールで設定する",
    ),
    PUBLIC_POSTHOG_PROJECT_TOKEN: req(
      "SITE_POSTHOG_PROJECT_TOKEN",
      "本番の PostHog プロジェクトのトークン。phc_ で始まる",
    ),
    PUBLIC_POSTHOG_HOST: trimUrl(
      ctx.value("SITE_POSTHOG_HOST") || "https://us.i.posthog.com",
    ),
    // 接続先は chatwoot-prod・mcp-prod と同じ CHATWOOT_BASE_URL を既定にする（公開サイトだけ別にするときだけ SITE_CHATWOOT_BASE）
    PUBLIC_CHATWOOT_BASE: trimUrl(
      ctx.value("SITE_CHATWOOT_BASE") ||
        ctx.conf.CHATWOOT_BASE_URL ||
        "https://chat.comegin.com",
    ),
    PUBLIC_CHATWOOT_WEBSITE_TOKEN: req(
      "CHATWOOT_WEBSITE_TOKEN",
      "本番の Chatwoot の受信箱「Web サイト」の website_token。chatwoot-prod が状態に置く（node setup/setup.mjs --target prod --only chatwoot-prod）",
      stateFirst("CHATWOOT_WEBSITE_TOKEN"),
    ),
    PUBLIC_MAUTIC_BASE: trimUrl(
      ctx.value("SITE_MAUTIC_BASE") ||
        ctx.conf.MAUTIC_BASE_URL ||
        "https://mkt.comegin.com",
    ),
    MAUTIC_FORM_ID_CONSULT: req(
      "MAUTIC_FORM_ID_CONSULT",
      "本番の Mautic のフォーム consult の数値 ID。mautic-prod が状態に置く（node setup/setup.mjs --target prod --only mautic-prod）",
      stateFirst("MAUTIC_FORM_ID_CONSULT"),
    ),
    PUBLIC_CALCOM_BASE: trimUrl(
      ctx.value("SITE_CALCOM_BASE") || "https://app.cal.com",
    ),
    PUBLIC_CALCOM_LINK: ctx.value("CALCOM_LINK") || "",
    PUBLIC_CONSENT_BASE: trimUrl(
      ctx.value("SITE_CONSENT_BASE") || "https://consent.comegin.com",
    ),
    PUBLIC_CONSENT_COOKIE_DOMAIN:
      ctx.value("CONSENT_COOKIE_DOMAIN") || ".comegin.com",
    CONSENT_POLICY_VERSION:
      ctx.value("CONSENT_POLICY_VERSION") || consent.policy,
  };
  return { values, missing };
}

/** 書く前の値の検査。問題ごとに 1 行の文を返す */
function problemsOf(ctx, env) {
  const p = [];
  const prod = ctx.target === "prod";
  if (prod) {
    if (
      !/^https:\/\//.test(env.SITE_URL ?? "") ||
      isLocal(env.SITE_URL) ||
      env.SITE_URL === EXAMPLE_SITE_URL
    )
      p.push(`SITE_URL（${env.SITE_URL}）が本番の https の URL ではない`);
    if (isDevStrapi(env.STRAPI_URL))
      p.push(
        `STRAPI_URL（${env.STRAPI_URL}）が開発の Strapi を指している。本番の Strapi は ${PROD_STRAPI_URL}（ADR-21）。配信用のビルドは integration.ts が停止する（DD-05 の 1.2）`,
      );
    if (
      env.PUBLIC_GA4_MEASUREMENT_ID &&
      !/^G-[A-Z0-9]+$/.test(env.PUBLIC_GA4_MEASUREMENT_ID)
    )
      p.push("GA4_MEASUREMENT_ID が G- で始まる英大文字・数字になっていない");
    for (const k of [
      "PUBLIC_CHATWOOT_BASE",
      "PUBLIC_MAUTIC_BASE",
      "PUBLIC_CONSENT_BASE",
    ])
      if (isLocal(env[k]) || !/^https:\/\//.test(env[k] ?? ""))
        p.push(`${k}（${env[k]}）が本番の https の URL ではない`);
    if (!env.PUBLIC_CONSENT_COOKIE_DOMAIN)
      p.push(
        "CONSENT_COOKIE_DOMAIN が空（本番は .comegin.com。consent-api の COOKIE_DOMAIN と同じ値）",
      );
  } else {
    if (env.BUILD_TARGET === "production")
      p.push(
        "開発の .env の BUILD_TARGET が production になっている（配信用のビルドは .env.production で行う）",
      );
  }
  if (
    env.PUBLIC_POSTHOG_PROJECT_TOKEN &&
    !env.PUBLIC_POSTHOG_PROJECT_TOKEN.startsWith("phc_")
  )
    p.push(
      "PostHog のトークンが phc_ で始まらない（個人の API キー phx_ を書いていないか。公開ページに埋め込まれる）",
    );
  if (
    env.PUBLIC_CALCOM_LINK &&
    // 埋め込みの calLink は <ユーザー名>/<slug>・team/<チーム>/<slug>・?duration= などを受ける。URL や先頭の / だけを弾く
    (/^https?:\/\//.test(env.PUBLIC_CALCOM_LINK) ||
      env.PUBLIC_CALCOM_LINK.startsWith("/") ||
      !env.PUBLIC_CALCOM_LINK.includes("/"))
  )
    p.push(
      "CALCOM_LINK が <ユーザー名>/<イベントの slug> の形ではない（https:// から始まる URL ではなく、オリジンの後ろだけを書く）",
    );
  if (env.MAUTIC_FORM_ID_CONSULT && !/^\d+$/.test(env.MAUTIC_FORM_ID_CONSULT))
    p.push("MAUTIC_FORM_ID_CONSULT が数字だけになっていない");
  return p;
}

/** 開発の環境変数ファイルのうち、測定 ID を書いてあるもの（ga4 モジュールと同じ判定） */
function devTagFiles(ctx) {
  return DEV_ENV_FILES.filter((f) =>
    Boolean(ctx.readEnvFile(join(dirOf(ctx), f)).PUBLIC_GA4_MEASUREMENT_ID),
  );
}

// ---------------------------------------------------------------------------
// 受け口の確認（読むだけ。失敗にしない）
// ---------------------------------------------------------------------------

async function status(ctx, label, url, { headers, okStatus = [200] } = {}) {
  try {
    // ウィジェット・フォームは HTML を返す（core の既定の Accept: application/json だと Chatwoot は 406 を返す）
    const res = await ctx.http(label, url, {
      raw: true,
      timeoutMs: 8_000,
      headers: { Accept: "text/html,application/json", ...headers },
    });
    const body = res.headers.get("content-type")?.includes("json")
      ? await res.json().catch(() => null)
      : (await res.body?.cancel(), null);
    return {
      up: true,
      ok: okStatus.includes(res.status),
      status: res.status,
      body,
    };
  } catch (e) {
    return { up: false, ok: false, reason: e.message };
  }
}

/** 開発の受け口を確かめ、表示する行を返す。ok は全部そろったか */
async function probeEndpoints(ctx, env) {
  const notes = [];
  let ok = true;
  const line = (cond, text) => {
    notes.push(`${cond ? "✓" : "!"} ${text}`);
    if (!cond) ok = false;
  };

  if (env.STRAPI_URL && env.STRAPI_API_TOKEN) {
    const r = await status(
      ctx,
      "Strapi",
      `${trimUrl(env.STRAPI_URL)}/api/articles?pagination[pageSize]=1`,
      { headers: { Authorization: `Bearer ${env.STRAPI_API_TOKEN}` } },
    );
    const total = r.body?.meta?.pagination?.total;
    if (!r.up)
      line(
        false,
        `Strapi（${env.STRAPI_URL}）に届かない。backend/strapi-system で pnpm dev`,
      );
    else if (!r.ok)
      line(
        false,
        `Strapi が HTTP ${r.status}（トークンが使えない。node setup/setup.mjs --target dev --only strapi で作り直す）`,
      );
    else
      line(
        total > 0,
        total > 0
          ? `Strapi の公開記事 ${total} 件（ビルドできる）`
          : "Strapi の公開記事が 0 件。pnpm build・pnpm lh は記事 0 件で止まる（DD-05 の 1.2）。管理画面で 1 件以上公開する",
      );
  } else line(false, "STRAPI_URL か STRAPI_API_TOKEN が空");

  if (env.PUBLIC_CHATWOOT_WEBSITE_TOKEN) {
    const r = await status(
      ctx,
      "Chatwoot",
      `${trimUrl(env.PUBLIC_CHATWOOT_BASE)}/widget?website_token=${encodeURIComponent(env.PUBLIC_CHATWOOT_WEBSITE_TOKEN)}`,
    );
    line(
      r.ok,
      r.ok
        ? "Chatwoot のウィジェットが website_token で開ける"
        : r.up
          ? `Chatwoot のウィジェットが HTTP ${r.status}（website_token が受信箱と合っていない）`
          : `Chatwoot（${env.PUBLIC_CHATWOOT_BASE}）に届かない`,
    );
  }
  if (env.MAUTIC_FORM_ID_CONSULT) {
    const r = await status(
      ctx,
      "Mautic",
      `${trimUrl(env.PUBLIC_MAUTIC_BASE)}/form/${env.MAUTIC_FORM_ID_CONSULT}`,
    );
    line(
      r.ok,
      r.ok
        ? `Mautic のフォーム ${env.MAUTIC_FORM_ID_CONSULT}（consult）が公開されている`
        : r.up
          ? `Mautic のフォーム ${env.MAUTIC_FORM_ID_CONSULT} が HTTP ${r.status}（未公開か ID 違い）`
          : `Mautic（${env.PUBLIC_MAUTIC_BASE}）に届かない`,
    );
  }
  const consent = await status(
    ctx,
    "consent-api",
    `${trimUrl(env.PUBLIC_CONSENT_BASE)}/healthz`,
  );
  line(
    consent.ok,
    consent.ok
      ? "consent-api の /healthz が 200"
      : `consent-api（${env.PUBLIC_CONSENT_BASE}）が応答しない。node setup/setup.mjs --target dev --only consent-api`,
  );

  // consent-api の CORS は公開サイトのオリジン 1 つだけを許す。ブラウザで開くオリジンと違うと同意を記録できない
  const consentSite = consentValues(ctx).siteUrl;
  if (
    consentSite &&
    env.SITE_URL &&
    new URL(consentSite).origin !== new URL(env.SITE_URL).origin
  ) {
    notes.push(
      `! consent-api の SITE_URL（${consentSite}）と公開サイトの SITE_URL（${env.SITE_URL}）のオリジンが違う。ブラウザで開くほうに consent-api をそろえる（README の「スマホの実機で試すとき」）`,
    );
  }
  return { ok, notes };
}

// ---------------------------------------------------------------------------
// dev サーバー（astro dev --background）
// ---------------------------------------------------------------------------

async function devServerStatus(ctx) {
  try {
    const out = await ctx.run("pnpm", ["exec", "astro", "dev", "status"], {
      cwd: dirOf(ctx),
      timeoutMs: 30_000,
    });
    const m = out.match(/running at (\S+)/i);
    return m ? { running: true, url: m[1] } : { running: false };
  } catch {
    return { running: false };
  }
}

async function startDevServer(ctx) {
  await ctx.run("pnpm", ["exec", "astro", "dev", "--background"], {
    cwd: dirOf(ctx),
    timeoutMs: 120_000,
  });
  if (!(await ctx.waitForHttp(`${DEV_URL}/`, { timeoutMs: 120_000 }))) {
    throw new Error(
      `astro dev が ${DEV_URL} で応答しない。cd ${DIR} && pnpm exec astro dev logs を見る`,
    );
  }
}

// ---------------------------------------------------------------------------
// Search Console（本番だけ。ドメインプロパティの所有権は Route 53 の TXT で確かめる。AA-02 の表の 1）
// ---------------------------------------------------------------------------

async function gscVerified(domain) {
  try {
    const records = await resolveTxt(domain);
    return records.some((chunks) =>
      chunks.join("").startsWith("google-site-verification="),
    );
  } catch {
    return false;
  }
}

/** 本番の Strapi（オンプレの 127.0.0.1:1338）を、ビルドと同じトークンで読めるか。公開記事が 0 件ならビルドは止まる */
async function prodStrapiNote(ctx, env) {
  if (!env.STRAPI_URL || !env.STRAPI_API_TOKEN)
    return { ok: false, text: "STRAPI_URL か STRAPI_API_TOKEN が空" };
  const r = await status(
    ctx,
    "本番の Strapi",
    `${trimUrl(env.STRAPI_URL)}/api/articles?pagination[pageSize]=1`,
    {
      headers: { Authorization: `Bearer ${env.STRAPI_API_TOKEN}` },
    },
  );
  const total = r.body?.meta?.pagination?.total;
  if (!r.up)
    return {
      ok: false,
      text: `本番の Strapi（${env.STRAPI_URL}）に届かない（onprem/strapi が動いているか。ビルドは止まる）`,
    };
  if (!r.ok)
    return {
      ok: false,
      text: `本番の Strapi が HTTP ${r.status}（SITE_STRAPI_API_TOKEN が使えない）`,
    };
  return total > 0
    ? { ok: true, text: `本番の Strapi の公開記事 ${total} 件（ビルドできる）` }
    : {
        ok: false,
        text: "本番の Strapi の公開記事が 0 件（ビルドは記事 0 件で止まる。DD-05 の 1.2）",
      };
}

function gscSteps(domain) {
  return [
    `https://search.google.com/search-console を comegin.com の Workspace のアカウントで開き、プロパティを追加 → 「ドメイン」に ${domain} を入れて続行（URL プレフィックスではなくドメインプロパティ。apex と www の両方を覆う）`,
    "表示された TXT レコード（google-site-verification=…）を控える",
    `Route 53 のホストゾーン ${domain} に、名前は空（apex）、種類 TXT、値に控えた文字列（ダブルクォートで囲む）のレコードを足す。既に TXT がある場合は同じレコードに 1 行足す`,
    "数分待ってから Search Console の「確認」を押す",
    "同じコマンドを実行し直す（DNS の TXT を読んで確かめる）。OpenSEO からの接続は openseo モジュール（OPENSEO_GSC_CONNECTED）",
  ];
}

// ---------------------------------------------------------------------------
// 契約
// ---------------------------------------------------------------------------

export async function check(ctx) {
  const dir = dirOf(ctx);
  const envPath = envPathOf(ctx);
  const notes = [];
  let ok = true;
  const mark = (cond, good, bad) => {
    notes.push(cond ? good : bad);
    if (!cond) ok = false;
  };
  mark(
    existsSync(join(dir, "node_modules")),
    "依存は導入済み",
    "依存が未導入（pnpm install）",
  );
  if (!existsSync(envPath)) {
    notes.push(`環境変数ファイル（${envPath}）がまだ無い`);
    return { ok: false, notes };
  }
  mark(
    (statSync(envPath).mode & 0o077) === 0,
    "環境変数ファイルの権限は 600 系",
    "環境変数ファイルがほかのユーザーにも読める（chmod 600）",
  );
  const env = ctx.readEnvFile(envPath); // 表示するのはキー名と URL だけ。秘密値は出さない
  for (const p of problemsOf(ctx, env)) mark(false, "", p);
  notes.push(`SITE_URL: ${env.SITE_URL || "（空）"}`);

  if (ctx.target === "prod") {
    const { missing } = prodValues(ctx);
    mark(
      missing.length === 0,
      "本番の値は prod.conf にそろっている",
      `prod.conf に無いキー: ${missing.join("・")}`,
    );
    const strapi = await prodStrapiNote(ctx, env);
    mark(strapi.ok, strapi.text, strapi.text);
    const domain = ctx.value("GSC_DOMAIN") || "comegin.com";
    if (ctx.value("OPENSEO_SKIP_GSC") !== "yes")
      mark(
        await gscVerified(domain),
        `Search Console の所有権の TXT が ${domain} にある`,
        `Search Console の所有権の TXT が ${domain} に無い`,
      );
    return { ok, notes };
  }

  const tagFiles = devTagFiles(ctx);
  mark(
    tagFiles.length === 0,
    "開発の環境変数に GA4 の測定 ID は無い",
    `開発の環境変数に PUBLIC_GA4_MEASUREMENT_ID がある（${tagFiles.join("、")}。開発ではタグを出さない）`,
  );
  if (existsSync(join(dir, ".env.production")))
    notes.push(
      "! 作業ツリーに .env.production がある。この作業ツリーの pnpm build・pnpm lh・pnpm a11y:ci は本番の値でビルドされる（astro build は production モード）。本番の値は承認済みの main のチェックアウトにだけ置く",
    );
  for (const k of ["PUBLIC_POSTHOG_PROJECT_TOKEN", "PUBLIC_CALCOM_LINK"])
    if (!env[k])
      notes.push(
        `${k} が空（任意。${k.includes("POSTHOG") ? "PostHog を読み込まない" : "予約枠の代わりにメールの案内を出す"}）`,
      );
  mark(
    Boolean(await chromeFor(ctx)),
    "Lighthouse CI の Chrome がある",
    "Lighthouse CI の Chrome が無い（CHROME_PATH を設定するか Chrome を入れる）",
  );
  if (existsSync(join(dir, "node_modules")))
    mark(
      await playwrightChromiumReady(ctx),
      "a11y の検査の Chromium は導入済み",
      "a11y の検査の Chromium が無い（pnpm exec playwright install chromium）",
    );

  const endpoints = await probeEndpoints(ctx, env);
  notes.push(...endpoints.notes);
  if (!endpoints.ok) ok = false;
  const dev = await devServerStatus(ctx);
  mark(
    dev.running,
    `dev サーバーは起動している（${dev.url}）`,
    `dev サーバーが起動していない（cd ${DIR} && pnpm exec astro dev --background）`,
  );
  return { ok, notes };
}

export async function apply(ctx) {
  const dir = dirOf(ctx);
  const envPath = envPathOf(ctx);
  const template = join(dir, ".env.example");
  await ensureTooling(ctx);

  // 1. 環境変数ファイル
  let changed;
  if (ctx.target === "prod") {
    const { values, missing } = prodValues(ctx);
    if (missing.length) {
      ctx.manual("prod-values", "本番の公開サイトの値を prod.conf に書く", [
        `~/.config/comegin/setup/prod.conf に次を書く（chmod 600）: ${missing.join("、")}`,
        `URL の既定（SITE_STRAPI_URL=${PROD_STRAPI_URL}・SITE_CHATWOOT_BASE=https://chat.comegin.com・SITE_MAUTIC_BASE=https://mkt.comegin.com・SITE_CONSENT_BASE=https://consent.comegin.com・CONSENT_COOKIE_DOMAIN=.comegin.com）と違うときだけ、そのキーも書く`,
        "CONSENT_POLICY_VERSION は本番の consent-api（Lambda）の値と同じにする（空なら backend/consent-api の環境変数の値を使う）",
        "同じコマンドを実行し直す",
      ]);
    }
    const problems = problemsOf(ctx, values);
    if (problems.length)
      throw new Error(`本番の値に問題がある: ${problems.join("／")}`);
    changed = ctx.writeEnvFile(envPath, values, {
      template,
      onlyIfEmpty: false,
    });
    ctx.log(
      `承認済みの main のチェックアウト（${prodCheckoutOf(ctx)}）に .env.production を書いた。そこでの astro build（監視アプリの builtin の lighthouse・a11y を含む）は本番の値でビルドされ、本番の Strapi（${values.STRAPI_URL}）を読む`,
    );
  } else {
    const tagFiles = devTagFiles(ctx);
    if (tagFiles.length) {
      throw new Error(
        `開発の環境変数ファイル（${tagFiles.map((f) => join(DIR, f)).join("、")}）に PUBLIC_GA4_MEASUREMENT_ID がある。開発ではタグを出さないので、その行を消してから --from verdant-virgo で実行し直す`,
      );
    }
    const current = ctx.readEnvFile(envPath);
    const { fill, force, warnings } = devValues(ctx, current);
    changed = ctx.writeEnvFile(envPath, fill, { template });
    changed.push(...ctx.writeEnvFile(envPath, force, { onlyIfEmpty: false }));
    for (const w of warnings) ctx.warn(w);
    const problems = problemsOf(ctx, ctx.readEnvFile(envPath));
    if (problems.length)
      throw new Error(`環境変数ファイルに問題がある: ${problems.join("／")}`);
    if (existsSync(join(dir, ".env.production")))
      ctx.warn(
        "作業ツリーに .env.production がある。この作業ツリーの pnpm build・pnpm lh は本番の値でビルドされる。本番の値は承認済みの main のチェックアウトにだけ置く（node setup/frontend.mjs --target prod）ので、人が消すか移す",
      );
  }
  // writeEnvFile は書き換えたときだけ 600 にするので、手で作った既存のファイルもここで 600 にする
  chmodSync(envPath, 0o600);
  ctx.log(
    `${envPath} を用意した（600。今回書いたキー: ${[...new Set(changed)].join("・") || "なし"}）`,
  );

  const env = ctx.readEnvFile(envPath);
  try {
    const host = new URL(env.SITE_URL).hostname;
    if (host.endsWith(".ngrok.app") && !NGROK_HOSTS.includes(host))
      ctx.warn(
        `SITE_URL のホスト ${host} が astro.config.mjs の allowedHosts に無い。dev サーバーを ngrok で開くなら allowedHosts に足す`,
      );
  } catch {
    /* SITE_URL の形は problemsOf と astro.config.mjs が見る */
  }

  // 2. 依存の導入
  ctx.log("pnpm install（lockfile 固定）");
  await ctx.run("pnpm", ["install", "--frozen-lockfile"], { cwd: dir });

  if (ctx.target === "prod") {
    // 3. 本番の Strapi をビルドと同じトークンで読めるか（警告だけ。ビルドするときに動いていればよい）
    const strapi = await prodStrapiNote(ctx, env);
    (strapi.ok ? ctx.log : ctx.warn)(strapi.text);

    // 4. Search Console のドメインプロパティ（OpenSEO が GSC を読む前提。使わないなら OPENSEO_SKIP_GSC=yes）
    const domain = ctx.value("GSC_DOMAIN") || "comegin.com";
    if (ctx.value("OPENSEO_SKIP_GSC") !== "yes") {
      if (!(await gscVerified(domain)))
        ctx.manual(
          "gsc-domain",
          `Search Console に ${domain} のドメインプロパティを登録し、所有権を確かめる`,
          gscSteps(domain),
        );
      ctx.log(`Search Console の所有権の TXT が ${domain} にある`);
    }
    ctx.log(
      `ビルドと配信はしない。ビルド: cd ${dir} && pnpm build（指示があったときだけ）。配信は人間が承認して実行する（cloud/README.md の 4.14）`,
    );
    return;
  }

  // 3. 計測の道具。Lighthouse CI は入っている Chrome を、a11y の検査は Playwright の Chromium を使う
  const chrome = await chromeFor(ctx);
  if (chrome) ctx.log(`Lighthouse CI の Chrome: ${chrome}`);
  else
    ctx.warn(
      "Chrome が見つからない。pnpm lh は Chrome を起動できずに失敗する。Chrome を入れるか、CHROME_PATH に Chromium の実行ファイルを指定する",
    );
  if (await playwrightChromiumReady(ctx))
    ctx.log("a11y の検査の Chromium は導入済み");
  else {
    ctx.log(
      "a11y の検査の Chromium を入れる（pnpm exec playwright install chromium。~/.cache/ms-playwright）",
    );
    try {
      await ctx.run("pnpm", ["exec", "playwright", "install", "chromium"], {
        cwd: dir,
        timeoutMs: 15 * 60_000,
      });
    } catch (e) {
      // 足りない OS のライブラリは sudo が要るので、このスクリプトでは入れない（pnpm exec playwright install-deps chromium を人が実行する）
      ctx.warn(
        `Chromium を入れられなかった（pnpm a11y が動かない）: ${e.message.split("\n")[0]}`,
      );
    }
  }
  const mainCheckout = ctx.value("CONTROL_MAIN_CHECKOUT");
  if (mainCheckout && !existsSync(join(mainCheckout, DIR, "node_modules"))) {
    ctx.warn(
      `承認済みの main のチェックアウト（${mainCheckout}）の ${DIR} で pnpm install が済んでいない。監視アプリの builtin の lighthouse・a11y は skipped になる（定期実行を使うなら人が済ませる。TA-05）`,
    );
  }

  // 4. 受け口の確認（警告だけ）
  const endpoints = await probeEndpoints(ctx, env);
  for (const n of endpoints.notes)
    (n.startsWith("✓") ? ctx.log : ctx.warn)(n.replace(/^[✓!] /, ""));
  if (!env.PUBLIC_POSTHOG_PROJECT_TOKEN)
    ctx.warn(
      "PostHog の開発のプロジェクトのトークンが無い（PostHog を読み込まない）。使うなら dev.conf に SITE_POSTHOG_PROJECT_TOKEN=phc_… を書いて再実行する",
    );

  // 5. dev サーバー。環境変数を書き換えたら起動し直す（Vite は起動時にしか .env を読まない）
  const dev = await devServerStatus(ctx);
  if (dev.running && changed.length > 0) {
    ctx.log(`環境変数を書き換えたので dev サーバーを起動し直す（${dev.url}）`);
    try {
      await ctx.run("pnpm", ["exec", "astro", "dev", "stop"], {
        cwd: dir,
        timeoutMs: 60_000,
      });
    } catch {
      ctx.manual(
        "restart-dev",
        "公開サイトの dev サーバーを起動し直す（環境変数を書き換えたため）",
        [
          "astro dev stop で止められなかった（別の端末で前景の pnpm dev が動いているときなど）。その端末で Ctrl+C で止める",
          "同じコマンドを実行し直す（astro dev --background で起動する）",
        ],
      );
    }
    await startDevServer(ctx);
  } else if (!dev.running) {
    ctx.log(
      "dev サーバーを起動する（astro dev --background。止めるのは pnpm exec astro dev stop）",
    );
    await startDevServer(ctx);
  }
  ctx.log(
    `公開サイト: ${DEV_URL}/（ログは cd ${DIR} && pnpm exec astro dev logs）`,
  );
  ctx.log(
    "計測は人が指示したときだけ: pnpm lh（Lighthouse CI）・pnpm a11y:ci（ビルドして axe）",
  );
}
