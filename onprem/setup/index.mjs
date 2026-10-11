// オンプレの本番（ADR-21。WireGuard・Strapi と n8n の本番）の枠。check は読むだけ。apply は AWS のデプロイの後に実装する。
// 出典: onprem/README.md（起動の順番・ポート 1338/5679/5680・systemd）、onprem/wireguard/README.md（10.99.0.2・手順 1〜5）、
//       onprem/systemd/comegin-{strapi,n8n}.service、`ip -br addr`・`systemctl is-enabled / is-active`・`ss -ltn` の標準の使い方。
import { existsSync } from "node:fs";
import { join } from "node:path";

export const meta = { id: "onprem", title: "オンプレの本番（WireGuard・Strapi・n8n。枠だけ）", targets: ["prod"], after: [] };

const WG_ADDRESS = "10.99.0.2";
const UNITS = ["wg-quick@wg0.service", "comegin-strapi.service", "comegin-n8n.service"];
const LISTENERS = [
  { addr: "127.0.0.1", port: 1338, what: "Strapi（本番）" },
  { addr: "127.0.0.1", port: 5679, what: "n8n（エディター・API・MCP）" },
  { addr: WG_ADDRESS, port: 5680, what: "n8n の Webhook の受け口（webhook-proxy）" },
];

async function tryRun(ctx, cmd, args) {
  try {
    return { ok: true, out: (await ctx.run(cmd, args)).trim() };
  } catch {
    return { ok: false };
  }
}

/** 読むだけの確認。項目ごとの結果を返す */
async function inspect(ctx) {
  const r = { wg: false, units: {}, listeners: {}, envFiles: {}, notes: [] };

  if (await ctx.commandExists("ip")) {
    const wg = await tryRun(ctx, "ip", ["-br", "addr", "show", "wg0"]);
    r.wg = Boolean(wg.ok && wg.out.includes(WG_ADDRESS));
    r.notes.push(r.wg ? `wg0 が上がっている（${WG_ADDRESS}）` : `wg0 が上がっていない（または ${WG_ADDRESS} が付いていない）`);
  } else {
    r.notes.push("ip コマンドが無いので wg0 は未確認");
  }

  if (await ctx.commandExists("systemctl")) {
    for (const unit of UNITS) {
      const enabled = await tryRun(ctx, "systemctl", ["is-enabled", unit]);
      const active = await tryRun(ctx, "systemctl", ["is-active", unit]);
      r.units[unit] = { enabled: enabled.ok, active: active.ok };
      r.notes.push(`${unit}: ${enabled.ok ? "有効" : "無効またはまだ置いていない"}／${active.ok ? "稼働中" : "停止中"}`);
    }
  } else {
    r.notes.push("systemctl が無いので systemd のユニットは未確認");
  }

  if (await ctx.commandExists("ss")) {
    const out = await ctx.run("ss", ["-ltn"]);
    for (const l of LISTENERS) {
      const up = new RegExp(`${l.addr.replaceAll(".", "\\.")}:${l.port}\\b`).test(out);
      r.listeners[`${l.addr}:${l.port}`] = up;
      r.notes.push(`${l.what}（${l.addr}:${l.port}）: ${up ? "待ち受けている" : "待ち受けていない"}`);
    }
  } else {
    r.notes.push("ss コマンドが無いのでポートは未確認");
  }

  // 秘匿ファイルは存在だけを見る（中身は読まない）
  for (const name of ["strapi", "n8n"]) {
    const exists = existsSync(join(ctx.W, "onprem", name, ".env"));
    r.envFiles[name] = exists;
    r.notes.push(`onprem/${name} の環境変数ファイル: ${exists ? "ある" : "まだ無い"}`);
  }
  return r;
}

const allReady = (r) =>
  r.wg &&
  UNITS.every((u) => r.units[u]?.enabled && r.units[u]?.active) &&
  LISTENERS.every((l) => r.listeners[`${l.addr}:${l.port}`]) &&
  Object.values(r.envFiles).every(Boolean);

export async function check(ctx) {
  const r = await inspect(ctx);
  return { ok: allReady(r), notes: r.notes };
}

// TODO(AWS のデプロイの後): ここを自動化する。WireGuard の公開鍵の受け渡し（SSM）・EC2 の公開鍵と Elastic IP の取り出し・
// RDS のパスワードと IAM キーの取り出しは、AWS の資格情報とデプロイの出力が要るため、いまは人が行う。
export async function apply(ctx) {
  const r = await inspect(ctx);
  if (allReady(r)) {
    ctx.log("本番のオンプレは用意できている（wg0・systemd・待ち受けとも OK）");
    return;
  }

  const onprem = join(ctx.W, "onprem");
  const steps = ["本番の枠。自動化は AWS のデプロイの後に実装する。いまは以下を人が行う（出典: onprem/README.md・onprem/wireguard/README.md）。必ず WireGuard → Strapi → n8n の順"];
  if (!r.wg || !r.units["wg-quick@wg0.service"]?.enabled) {
    steps.push(
      `WireGuard の鍵を作る: cd ${onprem}/wireguard && ./dev/gen-keys.sh（公開鍵だけが表示される。秘密鍵は ~/.config/comegin/wireguard/ から出さない）`,
      "公開鍵を AWS に渡す: samconfig.toml の OnpremWireguardPublicKey に書いて sam deploy、または親スタックの出力 OnpremPublicKeyParameterName の SSM パラメータに aws ssm put-parameter --overwrite（cloud/README.md の 4.2.1）",
      "EC2 の公開鍵（SSM の WireguardServerPublicKeyParameterName）と Elastic IP（出力 WireguardPublicIp）を取り出す",
      "設定を作って置く: ./dev/render-conf.sh --endpoint <Elastic IP> --server-public-key <EC2 の公開鍵> && sudo install -m 600 -o root -g root ~/.config/comegin/wireguard/wg0.conf /etc/wireguard/wg0.conf",
      "sudo systemctl enable --now wg-quick@wg0",
      "疎通: sudo wg show wg0（latest handshake が 2 分以内）・ping -c 3 10.99.0.1・nc -vz <RDS のエンドポイント> 5432",
    );
  }
  for (const name of ["strapi", "n8n"]) {
    const port = name === "strapi" ? "127.0.0.1:1338" : "127.0.0.1:5679";
    if (!r.envFiles[name] || !r.listeners[port]) {
      const secrets = name === "strapi" ? "RDS のパスワード・S3 用 IAM のキー・バケット名・PostHog のトークン" : "RDS のパスワード";
      steps.push(
        `${name}: cd ${onprem}/${name} && ./dev/init-env.sh → 環境変数ファイルに ${secrets} を入れる（cloud/README.md の 4.5・4.8。暗号化キーは本番用を別に作って控える。開発の値を流用しない）→ docker compose build && docker compose up -d`,
      );
    }
  }
  if (UNITS.slice(1).some((u) => !r.units[u]?.enabled)) {
    steps.push(
      "常駐させる: onprem/systemd/comegin-strapi.service と comegin-n8n.service の CHANGE_ME / CHANGE/ME（User と WorkingDirectory）を書き換えてから sudo install -m 644 で /etc/systemd/system/ に置き、sudo systemctl daemon-reload && sudo systemctl enable --now comegin-strapi.service comegin-n8n.service",
    );
  }
  steps.push("n8n を公開したら、onprem/README.md の「疎通の確かめ方」で Webhook の受け口を確かめる（確かめるときだけ WEBHOOK_ALLOWED_SOURCES を広げ、終わったら 10.99.0.1 に戻す）");
  ctx.manual("onprem-bringup", "オンプレの本番を立ち上げる（AWS のデプロイの後。手順は人が行う）", steps);
}
