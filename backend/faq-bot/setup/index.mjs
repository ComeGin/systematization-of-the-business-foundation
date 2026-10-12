// faq-bot（Chatwoot の FAQ ボット。開発サーバー http://127.0.0.1:3107）の設定。setup/lib/core.mjs の契約に従う。
// chatwoot モジュールが作ったボットのトークンと secret（状態ファイル）を faq-bot の .env に写し、依存を入れる。
// 開発サーバーは常駐させない（別の端末で pnpm dev。strapi と同じ扱い）。止まっている間、Chatwoot は会話をすぐ担当者に回す
// （docs/superpowers/specs/2026-10-11-faq-bot-design.md の 8 節）。
import { existsSync } from "node:fs";
import { join } from "node:path";

export const meta = { id: "faq-bot", title: "faq-bot（Chatwoot の FAQ ボット。開発サーバー 3107）", targets: ["dev"], after: ["chatwoot"] };

const DIR = "backend/faq-bot";
const HEALTH = "http://127.0.0.1:3107/healthz";
const DEFAULT_SITE_URL = "http://localhost:4321"; // 開発の公開サイト（Astro dev）。faq.json はそこから読む
const STATE_KEYS = ["CHATWOOT_ACCOUNT_ID", "CHATWOOT_FAQ_BOT_TOKEN", "CHATWOOT_FAQ_BOT_SECRET"];

async function healthy(ctx) {
  try {
    const res = await ctx.http("faq-bot", HEALTH, { raw: true, timeoutMs: 3_000 });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function check(ctx) {
  const dir = join(ctx.W, DIR);
  const missing = STATE_KEYS.filter((key) => !ctx.state.has(key));
  const env = existsSync(join(dir, ".env"));
  const deps = existsSync(join(dir, "node_modules"));
  const up = await healthy(ctx);
  return {
    ok: missing.length === 0 && env && deps,
    notes: [
      missing.length ? `状態に無い: ${missing.join(", ")}（chatwoot を先に）` : "ボットのトークンと secret は状態にある",
      `環境変数ファイル: ${env ? "ある" : "まだ（apply で作る）"}`,
      `依存: ${deps ? "入っている" : "まだ（apply で pnpm install）"}`,
      `GET ${HEALTH}: ${up ? "200" : "応答なし（別の端末で cd backend/faq-bot && pnpm dev）"}`,
    ],
  };
}

export async function apply(ctx) {
  const dir = join(ctx.W, DIR);
  for (const key of STATE_KEYS) {
    if (!ctx.state.has(key)) throw new Error(`${key} が状態に無い。先に chatwoot を実行する（node setup/setup.mjs --target dev --only chatwoot）`);
  }
  const siteUrl = (ctx.value("PUBLIC_SITE_URL") || DEFAULT_SITE_URL).replace(/\/+$/, "");
  // トークンと secret は作り直されうるので、空でなくても状態の値で上書きする
  const changed = ctx.writeEnvFile(
    join(dir, ".env"),
    {
      CHATWOOT_BASE_URL: "http://127.0.0.1:3100",
      CHATWOOT_ACCOUNT_ID: ctx.state.get("CHATWOOT_ACCOUNT_ID"),
      CHATWOOT_BOT_TOKEN: ctx.state.get("CHATWOOT_FAQ_BOT_TOKEN"),
      CHATWOOT_BOT_SECRET: ctx.state.get("CHATWOOT_FAQ_BOT_SECRET"),
      FAQ_URL: `${siteUrl}/faq.json`,
    },
    { template: join(dir, ".env.example"), onlyIfEmpty: false },
  );
  ctx.log(changed.length ? `環境変数ファイルに書いた: ${changed.join(", ")}` : "環境変数ファイルは用意できている");

  await ctx.run("pnpm", ["install", "--frozen-lockfile"], { cwd: dir });
  ctx.log(
    (await healthy(ctx))
      ? "開発サーバーは動いている（.env を書き換えたときは pnpm dev を起動し直す）"
      : "開発サーバーは止まっている。別の端末で cd backend/faq-bot && pnpm dev（止まっている間、Chatwoot は会話をすぐ担当者に回す）",
  );
}
