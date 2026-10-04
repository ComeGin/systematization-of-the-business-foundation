// host-relay（開発環境の中継）の設定。モジュールの書き方の見本を兼ねる（setup/lib/core.mjs の契約）。
import { join } from "node:path";

export const meta = { id: "host-relay", title: "開発環境の中継（コンテナ → ホストの 127.0.0.1）", targets: ["dev"], after: [] };

const PORTS = [8000, 1025, 5678];

async function listening(ctx) {
  const out = await ctx.run("ss", ["-ltn"]);
  return PORTS.filter((p) => new RegExp(`172\\.17\\.0\\.1:${p}\\b`).test(out));
}

export async function check(ctx) {
  const up = await listening(ctx);
  return { ok: up.length === PORTS.length, notes: [`172.17.0.1 で待ち受けているポート: ${up.join(", ") || "なし"}（期待: ${PORTS.join(", ")}）`] };
}

export async function apply(ctx) {
  await ctx.run("docker", ["compose", "up", "-d"], { cwd: join(ctx.W, "middleware/host-relay") });
  const up = await listening(ctx);
  if (up.length !== PORTS.length) throw new Error(`中継が待ち受けていない（${up.join(", ") || "なし"}）。docker0 のアドレスが 172.17.0.1 か確かめる（middleware/host-relay/README.md）`);
  ctx.log("172.17.0.1 の 8000・1025・5678 で待ち受けている");
}
