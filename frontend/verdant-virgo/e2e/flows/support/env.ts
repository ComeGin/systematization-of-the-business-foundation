// E2E（pnpm e2e）の接続先と、開発スタックの値の読み方。
//
// 境界（2026-10-25 にユーザーが決めた）:
//   - オンプレの開発スタック（Strapi・Mautic・Chatwoot・consent-api・faq-bot）は本物に繋ぐ。
//   - オンプレの外で動くもの（Cal.com・PostHog・GA4・ngrok のトンネル）は差し替える（support/fixtures.ts）。
// 開発の .env の PUBLIC_*_BASE は ngrok の URL（オンプレの外を通る）なので、E2E の dev サーバーは 127.0.0.1 に向け直して起動する
// （playwright.e2e.config.ts の webServer.env。Vite は起動時に既にある環境変数を .env より優先する）。
//
// 秘密値は返すだけで、画面・例外の文に出さない（例外の文にはキーの名前だけを書く）。integration/tests/helpers/env.ts と同じ考え方。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

// 4321 は dev、4322 は Lighthouse CI、4323 は a11y の preview。E2E の dev サーバーは 4324（CLAUDE.md のポートの表）
export const E2E_PORT = 4324;
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/** 開発スタックの接続先（CLAUDE.md のポートの表。どれも 127.0.0.1 にだけ開いている） */
export const DEV = {
  strapi: "http://127.0.0.1:1337",
  mautic: "http://127.0.0.1:8000",
  // Mautic が送るメールの届き先（Chatwoot の MailHog は 8026 で別）
  mailhog: "http://127.0.0.1:8025",
  chatwoot: "http://127.0.0.1:3100",
  consentApi: "http://127.0.0.1:3104",
  faqBot: "http://127.0.0.1:3107",
} as const;

/** docker compose のコンテナ名（障害を起こすテストが pause / unpause する） */
export const CONTAINERS = {
  consentValkey: "consent-api-valkey-1",
  mauticMysql: "mautic-mysql",
} as const;

/**
 * 1 回の実行に 1 つ。テストデータの名前に付ける（e2e- で始める）。
 * 設定ファイルはワーカーでも読み直されるので、最初に決めた値を環境変数で引き継ぐ（ワーカーは親の環境変数を受け継ぐ）。
 */
export const RUN_ID =
  (process.env.E2E_RUN_ID ??= `e2e-${Date.now().toString(36)}`);
export const e2eName = (label: string) => `${RUN_ID}-${label}`;

/** 同じ日・同じメールの二重送信の判定に掛からないよう、テストごとに違うメールにする（example.com は届かない） */
export const e2eEmail = (label: string) =>
  `${RUN_ID}-${label}-${Math.random().toString(36).slice(2, 7)}@example.com`;

const CONFIG_DIR = path.join(homedir(), ".config/comegin/setup");
const STATE_FILE = path.join(CONFIG_DIR, "dev.state.json");
const CONF_FILE = path.join(CONFIG_DIR, "dev.conf");

function readOptional(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** KEY=VALUE の行だけを読む（# のコメントと空行は飛ばす。値を囲む引用符は外す） */
function parseEnvText(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    values[line.slice(0, eq).trim()] = value;
  }
  return values;
}

let cache: Record<string, string> | undefined;

/**
 * 設定スクリプト（setup/setup.mjs --target dev）の状態ファイル → 設定ファイルの順に探す。無ければ例外（キーの名前だけ）。
 * E2E は設定スクリプトが済んでいることが前提なので、無いのは「準備が終わっていない」という失敗にする。
 */
export function devValue(key: string): string {
  if (!cache) {
    const state = readOptional(STATE_FILE);
    const stateValues = state
      ? ((JSON.parse(state) as { values?: Record<string, unknown> }).values ??
        {})
      : {};
    cache = {
      ...parseEnvText(readOptional(CONF_FILE) ?? ""),
      ...Object.fromEntries(
        Object.entries(stateValues).map(([k, v]) => [k, String(v)]),
      ),
    };
  }
  const value = cache[key];
  if (!value)
    throw new Error(
      `${key} が ${STATE_FILE} にも ${CONF_FILE} にも無い（node setup/setup.mjs --target dev を先に済ませる）`,
    );
  return value;
}

/**
 * 開発スタックが CORS で許しているオリジン（公開サイトの SITE_URL。Mautic の cors_valid_domains と consent-api の SITE_URL）。
 * E2E のページは 127.0.0.1:4324 から送るので、転送するときに Origin をこの値に置き換える（support/fixtures.ts）。
 * 許可が本当に入っているかは cors.spec.ts が確かめる。
 */
export function allowedOrigin(): string {
  const siteUrl = loadEnv("development", ROOT, "").SITE_URL?.trim();
  if (!siteUrl)
    throw new Error(
      `SITE_URL が ${ROOT}/.env に無い（node setup/frontend.mjs --target dev を先に済ませる）`,
    );
  return new URL(siteUrl).origin;
}
