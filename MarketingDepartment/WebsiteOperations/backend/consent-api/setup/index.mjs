// consent-api（Cookie 同意の記録。開発環境の compose。http://127.0.0.1:3104）の設定。setup/lib/core.mjs の契約に従う。
//
// 確かめた出典: backend/consent-api/compose.yml（consent-api と valkey の 2 サービス。SITE_URL と CONSENT_POLICY_VERSION が必須）、
// .env.example（開発の既定値が入っていて、秘密値は無い。VALKEY_PASSWORD は開発では空でよい）、README.md（GET /healthz が 200。Valkey は見ない）。
// このリポジトリには consent-api 用の init-env スクリプトが無いため、環境変数ファイルは .env.example を写すだけにする。
import { existsSync } from "node:fs";
import { join } from "node:path";

export const meta = { id: "consent-api", title: "consent-api（Cookie 同意の記録。Valkey 付き）", targets: ["dev"], after: [] };

const DIR = "backend/consent-api";
const HEALTH = "http://127.0.0.1:3104/healthz";

async function healthy(ctx) {
  try {
    const res = await ctx.http("consent-api", HEALTH, { raw: true, timeoutMs: 5_000 });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function check(ctx) {
  const dir = join(ctx.W, DIR);
  const up = await healthy(ctx);
  return {
    ok: existsSync(join(dir, ".env")) && up,
    notes: [`環境変数ファイル: ${existsSync(join(dir, ".env")) ? "ある" : "まだ（apply で .env.example から作る）"}`, `GET ${HEALTH}: ${up ? "200" : "応答なし（apply で compose up）"}`],
  };
}

export async function apply(ctx) {
  const dir = join(ctx.W, DIR);

  // 環境変数ファイル。値は .env.example の開発の既定値のまま（SITE_URL は Astro の dev、COOKIE_DOMAIN と VALKEY_PASSWORD は空）。
  // 設定に書かれていれば、空のキーだけ上書きする
  const wanted = {};
  for (const k of ["SITE_URL", "CONSENT_POLICY_VERSION", "COOKIE_DOMAIN", "VALKEY_PASSWORD"]) if (ctx.conf[k]) wanted[k] = ctx.conf[k];
  const changed = ctx.writeEnvFile(join(dir, ".env"), wanted, { template: join(dir, ".env.example") });
  ctx.log(changed.length ? `環境変数ファイルに書いた: ${changed.join(", ")}` : "環境変数ファイルは用意できている");

  // イメージのビルドも compose が行う（ソースを変えたあとの再実行でも反映される）
  await ctx.run("docker", ["compose", "up", "-d", "--build"], { cwd: dir });

  if (!(await ctx.waitForHttp(HEALTH, { timeoutMs: 120_000 })) || !(await healthy(ctx))) {
    throw new Error(`consent-api が ${HEALTH} で 200 を返さない。cd ${DIR} && docker compose logs consent-api valkey を見る（SITE_URL・CONSENT_POLICY_VERSION が空だと compose が起動しない）`);
  }
  ctx.log("GET /healthz が 200（Valkey の接続は healthz では見ない。compose の valkey は healthcheck が通ってから起動する）");
}
