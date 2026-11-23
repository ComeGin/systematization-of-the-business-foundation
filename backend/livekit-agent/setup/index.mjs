// 音声 SEO BI エージェント（backend/livekit-agent。LiveKit セルフホスト × GPT-Live × OpenSEO MCP）の設定。setup/lib/core.mjs の契約に従う。
// 設計: docs/superpowers/specs/2026-11-21-voice-seo-bi-design.md（4 節 (e)・5.1・5.7）、計画: docs/superpowers/plans/2026-11-21-voice-seo-bi.md（D9・D10）。
//
// 開発（dev）:
//   1. 開発の SFU（backend/livekit-system/compose.yml。livekit-server --dev。127.0.0.1:7880）を docker compose up -d で上げ、7880 が応えるまで待つ
//   2. uv sync --locked（.venv。lock が古ければ止まる。uv lock は人かエージェントの担当が行う）
//   3. 環境変数ファイル（.env.local。src/agent.py が読む。.env.example を写して作る）に、空のキーだけ書く:
//      LIVEKIT_URL=ws://127.0.0.1:7880・LIVEKIT_API_KEY=devkey・LIVEKIT_API_SECRET=secret（開発モードの固定の値。公開されている値で、本番には使わない）、
//      VOICE_AUDIT_DIR=<作業ツリー>/docs/audits/voice（監視アプリが作業ツリーの E-12 を読む）、
//      OPENAI_API_KEY（dev.conf の VOICE_OPENAI_API_KEY、無ければ OPENAI_API_KEY。どちらも無ければ人が入れる手順を出して yes を待つ）
//   check は、環境変数ファイルのキー・.venv・7880 の応答を確かめる（読むだけ）。
//
// 本番（prod。段階 operate）: エージェントはオンプレで常駐し（onprem/systemd/comegin-livekit-agent.service）、AWS の SFU（wss://rtc.comegin.com）へ外向きにつなぐ。
//   監視アプリと同じく、承認済みの main のチェックアウト（CONTROL_MAIN_CHECKOUT。空なら SITE_BUILD_CHECKOUT）から動かす（ADR-18）。
//   1. チェックアウトに backend/livekit-agent があること
//   2. uv sync --locked --no-dev（チェックアウトの .venv）
//   3. チェックアウトの環境変数ファイルに書く（値は表示しない）: LIVEKIT_URL（prod.conf の LIVEKIT_URL。既定 wss://rtc.comegin.com）・
//      LIVEKIT_API_KEY・LIVEKIT_API_SECRET（prod.conf。AWS の SSM の SecureString〈/comegin/prod/livekit/api-key・api-secret〉と同じ値）・
//      OPENAI_API_KEY（prod.conf の VOICE_OPENAI_API_KEY。無ければ OPENAI_API_KEY で代用し、分けるよう案内する）・VOICE_AUDIT_DIR（prod.conf の VOICE_AUDIT_DIR。無ければ <CONTROL_WORKTREE>/docs/audits/voice）。
//      prod.conf の値が正（値が変わったら上書きする）。書く前に形を確かめ、LIVEKIT_URL が wss:// でない・API キーやシークレットが
//      SFU の受け付ける形〈キーは英数字と _ - の 3〜64 文字、シークレットは 32 文字以上〉でないときは止める（値は出さない。check も同じ検査）
//   4. systemd のユニット comegin-livekit-agent が有効で稼働中、ヘルス（127.0.0.1:8081）が応えること。/etc に置くのは人（onprem/README.md）
//   SFU の起動と停止は人が node cloud/livekit-sfu.mjs start|stop で行う。SFU が止まっていても、エージェントは接続を再試行し続けるだけで、異常ではない。
//   AWS には触れない（SSM の値もここでは読まない）。
import { existsSync } from "node:fs";
import { join } from "node:path";

export const meta = { id: "livekit-agent", title: "音声 SEO BI エージェント（LiveKit。開発の SFU・uv・環境変数・本番の常駐）", targets: ["dev", "prod"], phases: ["operate"], after: [] };

const DIR = "backend/livekit-agent";
const SFU_DIR = "backend/livekit-system";
// src/agent.py が load_dotenv で読むファイル（スターターのまま。名前を変えるときは agent.py・README・systemd のユニットと一緒に）
const ENV_FILE = ".env.local";
const SFU_URL = "http://127.0.0.1:7880/";
const HEALTH_URL = "http://127.0.0.1:8081/";
const UNIT = "comegin-livekit-agent.service";
const UNIT_TEMPLATE = "onprem/systemd/comegin-livekit-agent.service";
const DEV_KEYS = { LIVEKIT_URL: "ws://127.0.0.1:7880", LIVEKIT_API_KEY: "devkey", LIVEKIT_API_SECRET: "secret" };
const PROD_LIVEKIT_URL = "wss://rtc.comegin.com"; // cloud/template.yaml の LivekitHost の既定
const REQUIRED = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "OPENAI_API_KEY"];

/**
 * 音声のエージェントの OpenAI の API キー。記事のアイキャッチ（監視アプリ。ADR-32）とは別のキーにする（2026-11-23。ADR-33 の決定）。
 * OpenAI の画面でプロジェクトを分けて発行すると、使用量を分けて見られ、片方だけを止められる。
 * VOICE_OPENAI_API_KEY が無いときは共用の OPENAI_API_KEY で代用する（前の設定のままでも動くように）。shared が true ならその場合。
 */
function voiceOpenAiKey(ctx) {
  if (ctx.conf.VOICE_OPENAI_API_KEY) return { key: ctx.conf.VOICE_OPENAI_API_KEY, shared: false };
  return { key: ctx.conf.OPENAI_API_KEY || undefined, shared: Boolean(ctx.conf.OPENAI_API_KEY) };
}

const checkoutOf = (ctx) => ctx.conf.CONTROL_MAIN_CHECKOUT || ctx.conf.SITE_BUILD_CHECKOUT;
/** 動かす場所: dev は人の作業ツリー、prod は承認済みの main のチェックアウト */
const appDir = (ctx) => (ctx.target === "prod" ? join(checkoutOf(ctx) ?? "", DIR) : join(ctx.WORKTREE, DIR));
const envPath = (ctx) => join(appDir(ctx), ENV_FILE);

async function answers(ctx, url) {
  try {
    const res = await ctx.http("LiveKit", url, { raw: true, timeoutMs: 5_000 });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function unitState(ctx) {
  if (!(await ctx.commandExists("systemctl"))) return null;
  const q = async (args) => {
    try {
      await ctx.run("systemctl", args);
      return true;
    } catch {
      return false;
    }
  };
  return { enabled: await q(["is-enabled", UNIT]), active: await q(["is-active", UNIT]) };
}

/** 環境変数ファイルの必須キーのうち、空のもの（値は返さない） */
function missingKeys(ctx) {
  const env = ctx.readEnvFile(envPath(ctx));
  return REQUIRED.filter((k) => !env[k]);
}

function prodValues(ctx) {
  const worktree = ctx.conf.CONTROL_WORKTREE;
  return {
    LIVEKIT_URL: ctx.conf.LIVEKIT_URL || PROD_LIVEKIT_URL,
    LIVEKIT_API_KEY: ctx.conf.LIVEKIT_API_KEY || undefined,
    LIVEKIT_API_SECRET: ctx.conf.LIVEKIT_API_SECRET || undefined,
    OPENAI_API_KEY: voiceOpenAiKey(ctx).key,
    // 監視アプリと共用のキー（setup/setup.conf.example の「音声 SEO BI エージェント」）。空なら .env.example の既定 comegin-seo-bi のまま
    LIVEKIT_AGENT_NAME: ctx.conf.LIVEKIT_AGENT_NAME || undefined,
    VOICE_AUDIT_DIR: ctx.conf.VOICE_AUDIT_DIR || (worktree ? join(worktree, "docs/audits/voice") : undefined),
  };
}

/**
 * 本番の値の形を確かめる（値は返さない。キーの名前と理由だけ）。空のキーは missingKeys が扱うので、ここでは見ない。
 * SFU の側（cloud/stacks/livekit-sfu.yaml の comegin-livekit-boot）が受け付ける形と同じにする:
 *   API キーは英数字と _ - の 3〜64 文字、シークレットは英数字と _ + / = - の 32 文字以上。URL は wss://（本番の SFU は TLS だけ）
 */
export function prodValueProblems(values) {
  const problems = [];
  const url = values.LIVEKIT_URL;
  if (url && !/^wss:\/\/[^\s/]+\/?$/.test(url)) problems.push("LIVEKIT_URL が wss://<ホスト名> の形ではない（本番の SFU は wss だけ。既定 wss://rtc.comegin.com）");
  const key = values.LIVEKIT_API_KEY;
  if (key && !/^[A-Za-z0-9_-]{3,64}$/.test(key)) problems.push("LIVEKIT_API_KEY の形が違う（英数字と _ - の 3〜64 文字）");
  const secret = values.LIVEKIT_API_SECRET;
  if (secret && !/^[A-Za-z0-9_+/=-]{32,}$/.test(secret)) problems.push("LIVEKIT_API_SECRET の形が違う（英数字と _ + / = - の 32 文字以上）");
  return problems;
}

// ---------------------------------------------------------------------------
// check（読むだけ）
// ---------------------------------------------------------------------------

export async function check(ctx) {
  if (ctx.target === "prod") {
    const main = checkoutOf(ctx);
    if (!main || !existsSync(join(main, DIR, "pyproject.toml"))) {
      return { ok: false, notes: [`main のチェックアウトに ${DIR} が無い（prod.conf の CONTROL_MAIN_CHECKOUT〈${main ?? "未設定"}〉を確かめ、origin/main に合わせる）`] };
    }
    const hasEnv = existsSync(envPath(ctx));
    const missing = hasEnv ? missingKeys(ctx) : REQUIRED;
    // 動いているエージェントが使う値（チェックアウトの環境変数ファイル）と、次の apply で書く値（prod.conf）の両方の形を見る
    const problems = [
      ...(hasEnv ? prodValueProblems(ctx.readEnvFile(envPath(ctx))).map((m) => `環境変数ファイルの ${m}`) : []),
      ...prodValueProblems(prodValues(ctx)).map((m) => `prod.conf の ${m}`),
    ];
    const venv = existsSync(join(appDir(ctx), ".venv"));
    const unit = await unitState(ctx);
    const health = await answers(ctx, HEALTH_URL);
    return {
      ok: missing.length === 0 && problems.length === 0 && venv && Boolean(unit?.enabled && unit?.active) && health,
      notes: [
        `チェックアウトの環境変数ファイル: ${missing.length ? `空のキー ${missing.join(", ")}` : "必須のキーが入っている"}`,
        ...problems,
        `チェックアウトの .venv: ${venv ? "ある" : "まだ（apply で uv sync --locked --no-dev）"}`,
        unit ? `${UNIT}: ${unit.enabled ? "有効" : "無効またはまだ置いていない"}／${unit.active ? "稼働中" : "停止中"}` : "systemctl が無いので systemd のユニットは未確認",
        `ヘルス（${HEALTH_URL}）: ${health ? "応答あり" : "応答なし"}`,
        "SFU（AWS）の起動・停止は人が node cloud/livekit-sfu.mjs start|stop で行う（ここでは確かめない）",
      ],
    };
  }

  const sfu = await answers(ctx, SFU_URL);
  const hasEnv = existsSync(envPath(ctx));
  const missing = hasEnv ? missingKeys(ctx) : REQUIRED;
  const venv = existsSync(join(appDir(ctx), ".venv"));
  return {
    ok: sfu && hasEnv && missing.length === 0 && venv,
    notes: [
      `開発の SFU（${SFU_URL}）: ${sfu ? "応答あり" : "応答なし（apply で cd backend/livekit-system && docker compose up -d）"}`,
      `環境変数ファイル（${DIR}/${ENV_FILE}）: ${!hasEnv ? "まだ（apply で .env.example から作る）" : missing.length ? `空のキー ${missing.join(", ")}` : "必須のキーが入っている"}`,
      `.venv: ${venv ? "ある" : "まだ（apply で uv sync --locked）"}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// apply（何度実行しても同じ結果になる）
// ---------------------------------------------------------------------------

async function uvSync(ctx, args) {
  if (!(await ctx.commandExists("uv"))) {
    ctx.manual("uv", "uv が無い", ["uv を入れる（https://docs.astral.sh/uv/getting-started/installation/）", "同じコマンドを実行し直す"]);
  }
  try {
    await ctx.run("uv", ["sync", "--locked", ...args], { cwd: appDir(ctx) });
  } catch (e) {
    throw new Error(
      `uv sync --locked が失敗した（uv.lock が pyproject.toml に追いついていない、など）。${DIR} で uv lock を実行してコミットしてから実行し直す\n${e.message}`,
    );
  }
}

export async function apply(ctx) {
  if (ctx.target === "prod") return applyProd(ctx);

  const dir = appDir(ctx);

  // 1. 開発の SFU
  await ctx.run("docker", ["compose", "up", "-d"], { cwd: join(ctx.WORKTREE, SFU_DIR) });
  if (!(await ctx.waitForHttp(SFU_URL, { timeoutMs: 60_000 }))) {
    throw new Error(`開発の SFU が ${SFU_URL} で応えない。cd ${SFU_DIR} && docker compose logs livekit を見る（7880・7881・7882 を別のプロセスが使っていないか）`);
  }
  ctx.log("開発の SFU（livekit-server --dev）が 127.0.0.1:7880 で応えている");

  // 2. 依存
  await uvSync(ctx, []);
  ctx.log("uv sync --locked: 済み");

  // 3. 環境変数ファイル（空のキーだけ書く。人が入れた値は変えない）
  const values = { ...DEV_KEYS, VOICE_AUDIT_DIR: join(ctx.WORKTREE, "docs/audits/voice") };
  const voiceKey = voiceOpenAiKey(ctx).key;
  if (voiceKey) values.OPENAI_API_KEY = voiceKey;
  const changed = ctx.writeEnvFile(envPath(ctx), values, { template: join(dir, ".env.example") });
  ctx.log(changed.length ? `環境変数ファイルに書いた: ${changed.join(", ")}` : "環境変数ファイルは用意できている");

  const missing = missingKeys(ctx);
  if (missing.length) {
    await ctx.confirm("env", `${DIR}/${ENV_FILE} に空のキーがある: ${missing.join(", ")}`, [
      "OPENAI_API_KEY は ~/.config/comegin/setup/dev.conf に VOICE_OPENAI_API_KEY として書いて実行し直すか、環境変数ファイルに直接入れる（GPT-Live とビジョンに使う。音声と画面のフレームが OpenAI〈米国〉に渡る。ADR-33）",
      "空のままでもエージェントの起動前の準備は進められる（起動すると設定の検証で止まる）",
    ]);
  }
  ctx.log(`起動: cd ${DIR} && uv run src/agent.py dev（OpenSEO が 127.0.0.1:3001 で動いていること）`);
}

async function applyProd(ctx) {
  const main = checkoutOf(ctx);
  if (!main) {
    ctx.manual("checkout", "CONTROL_MAIN_CHECKOUT（承認済みの main のチェックアウトの絶対パス）が prod.conf に無い", [
      "~/.config/comegin/setup/prod.conf に CONTROL_MAIN_CHECKOUT=<チェックアウトの絶対パス> を書く（空なら SITE_BUILD_CHECKOUT を使う。監視アプリと同じ）",
      "同じコマンドを実行し直す",
    ]);
  }
  if (!existsSync(join(main, DIR, "pyproject.toml"))) {
    ctx.manual("checkout-stale", `チェックアウト（${main}）に ${DIR} が無い`, [
      `チェックアウトを origin/main に合わせる（cd ${main} && git fetch && git checkout --detach origin/main。setup は git を書き換えない）`,
      "同じコマンドを実行し直す",
    ]);
  }

  // 1. 依存（本番は dev の依存を入れない）
  await uvSync(ctx, ["--no-dev"]);
  ctx.log("チェックアウトで uv sync --locked --no-dev: 済み");

  // 2. 環境変数ファイル（prod.conf が正。値が変わったら上書きする。値は表示しない）
  const values = prodValues(ctx);
  // 形の誤りは書く前に止める（値は出さない）。トークンの発行・検証が合わず、接続の段で分かりにくく失敗するため
  const problems = prodValueProblems(values);
  if (problems.length) {
    ctx.manual("prod-format", `prod.conf の本番の値の形が違う: ${problems.join("／")}`, [
      "~/.config/comegin/setup/prod.conf の該当のキーを直す（監視アプリの setup も同じキーを読む。setup/setup.conf.example の「音声 SEO BI エージェント」）",
      "API キーとシークレットを作り直したときは、AWS の SSM（/comegin/prod/livekit/api-key・api-secret）にも同じ値を入れる（cloud/README.md）",
      "同じコマンドを実行し直す",
    ]);
  }
  if (voiceOpenAiKey(ctx).shared) {
    ctx.log("OpenAI のキーを監視アプリのアイキャッチと共用している（prod.conf に VOICE_OPENAI_API_KEY が無い）。分けると決めた（ADR-33）ので、OpenAI でプロジェクトを分けたキーを発行し、prod.conf に VOICE_OPENAI_API_KEY を書く");
  }
  const changed = ctx.writeEnvFile(envPath(ctx), values, { template: join(appDir(ctx), ".env.example"), onlyIfEmpty: false });
  ctx.log(changed.length ? `チェックアウトの環境変数ファイルに書いた: ${changed.join(", ")}` : "チェックアウトの環境変数ファイルは prod.conf と同じ");
  const missing = missingKeys(ctx);
  if (missing.length || !values.VOICE_AUDIT_DIR) {
    ctx.manual("prod-values", `本番の値が足りない: ${[...missing, ...(values.VOICE_AUDIT_DIR ? [] : ["VOICE_AUDIT_DIR"])].join(", ")}`, [
      "~/.config/comegin/setup/prod.conf に書く: LIVEKIT_API_KEY・LIVEKIT_API_SECRET（SSM の /comegin/prod/livekit/api-key・api-secret に入れた値と同じ。cloud/README.md）・VOICE_OPENAI_API_KEY（音声専用の OpenAI のキー。アイキャッチの OPENAI_API_KEY とは別に発行する）",
      "VOICE_AUDIT_DIR は既定で <CONTROL_WORKTREE>/docs/audits/voice（監視アプリが E-12 を読む作業場）。CONTROL_WORKTREE が無ければ VOICE_AUDIT_DIR を絶対パスで書く",
      "LIVEKIT_URL は既定 wss://rtc.comegin.com（スタックの出力 LivekitUrl と同じにする）",
      "同じコマンドを実行し直す",
    ]);
  }

  // 3. 常駐（/etc に置くのは人）
  const unit = await unitState(ctx);
  if (unit && !(unit.enabled && unit.active)) {
    ctx.manual("unit", `${UNIT} が${unit.enabled ? "稼働していない" : "有効になっていない（まだ置いていない）"}`, [
      `雛形 ${UNIT_TEMPLATE} を /etc/systemd/system/ に写し、User・WorkingDirectory（${join(main, DIR)}）・uv のパスを差し替える（onprem/README.md）`,
      `sudo systemctl daemon-reload && sudo systemctl enable --now ${UNIT}`,
      `環境変数ファイルや依存を変えた後は sudo systemctl restart ${UNIT}`,
      "同じコマンドを実行し直す",
    ]);
  }
  if (changed.length && unit?.active) {
    await ctx.confirm("restart", `環境変数ファイルを書き換えた（${changed.join(", ")}）。動いているエージェントは古い値のまま`, [`sudo systemctl restart ${UNIT}`]);
  }
  if (!(await ctx.waitForHttp(HEALTH_URL, { timeoutMs: 30_000 }))) {
    throw new Error(`エージェントのヘルス（${HEALTH_URL}）が応えない。journalctl -u ${UNIT} を見る（設定の検証で止まっていれば、変数名と理由が出ている）`);
  }
  ctx.log(`${UNIT} が稼働し、ヘルスが応えている（SFU が止まっていれば接続を再試行し続ける。起動は node cloud/livekit-sfu.mjs start）`);
}
