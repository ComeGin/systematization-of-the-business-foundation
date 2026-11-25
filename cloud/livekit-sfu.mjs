#!/usr/bin/env node
// LiveKit の SFU（cloud/stacks/livekit-sfu.yaml。音声 SEO BI の I-35・I-36）を手で起動・停止する。計画 docs/superpowers/plans/2026-11-21-voice-seo-bi.md の D8f。
// 実行するのは人（Claude Code の実行環境では実行しない）。SFU は Auto Scaling グループ（0〜1 台）と warm pool（Stopped）で、
// 停止してもインスタンスは消えない（EBS と Caddy の証明書が残る。ユーザーの決定 U6）。
//
// 使い方（リポジトリのどこからでもよい）:
//   node cloud/livekit-sfu.mjs status   今の状態を表示する（読むだけ。ASG の希望・インスタンスの状態・warm pool・https に届くか）
//   node cloud/livekit-sfu.mjs start    起動する: SSM の API キーとシークレットがあるかを確かめる → yes → 希望を 1 → InService まで待つ →
//                                         https://<LivekitHost>/ が 200 を返すまで待つ（初回は Caddy の証明書の取得で数分かかる）
//   node cloud/livekit-sfu.mjs stop     停止する: yes → 希望を 0 → warm pool で Warmed:Stopped になるまで待つ
//   オプション: --profile <名前>（スタックを読み、希望を変えるプロファイル。既定 comegin-prod-admin）
//               --wait <秒>（InService・Warmed:Stopped を待つ上限。既定 900）
//               --yes（start・stop の確認を省く）
//
// 前提: 親スタック comegin-prod を LivekitSfuEnabled=true でデプロイ済み（cloud/README.md）。出力 LivekitSfuAutoScalingGroupName・LivekitUrl・
//   LivekitApiKeyParameterName・LivekitApiSecretParameterName・LivekitSfuPublicIp を読む。
// 秘密値: SSM のパラメータは存在だけを確かめる（describe-parameters。値は読まない・復号しない）。画面にも出さない。
// 費用: 動いている間は EC2（既定 t4g.small）の時間課金。止めている間も EBS（gp3 8 GiB）と EIP（パブリック IPv4）がかかる。
// 終了コード: 0 済み / 1 失敗・待ちきれなかった / 3 yes が入力されなかった
import { lookup } from "node:dns/promises";
import { askOnTerminal } from "../setup/lib/core.mjs";
import { isDirectRun, realRun } from "./lib/exec.mjs";

const STACK = "comegin-prod";
const REGION = "ap-northeast-1";
const DEFAULT_PROFILE = "comegin-prod-admin";
const DEFAULT_WAIT_SECONDS = 900;
/** 証明書の取得（初回）と livekit-server の起動を待つ上限 */
const HTTPS_WAIT_SECONDS = 600;
const POLL_MS = 10_000;
const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/;
const SAFE_PARAM = /^\/[A-Za-z0-9._/-]+$/;

const HELP = `LiveKit の SFU（EC2 の Auto Scaling グループと warm pool）を手で起動・停止する

使い方:
  node cloud/livekit-sfu.mjs <status|start|stop> [--profile <名前>] [--wait <秒>] [--yes]

  status   今の状態を表示する（読むだけ）
  start    SSM の API キー・シークレットの有無を確かめてから、希望を 1 にして InService と https の応答を待つ
  stop     希望を 0 にして、warm pool で Warmed:Stopped になるのを待つ（インスタンスは消えない）

  --profile  AWS のプロファイル（既定 ${DEFAULT_PROFILE}。スタック ${STACK} を読み、ASG の希望を変えられる主体）
  --wait     InService・Warmed:Stopped を待つ上限の秒数（既定 ${DEFAULT_WAIT_SECONDS}）
  --yes      start・stop の確認を省く

止めている間、監視アプリの /voice は「SFU が停止中」と表示し、オンプレのエージェントは接続を再試行し続ける（異常ではない）。
詳しくは cloud/README.md の LiveKit の SFU の節。`;

class Declined extends Error {}

export function parseArgs(argv) {
  const opts = { command: null, profile: DEFAULT_PROFILE, waitSeconds: DEFAULT_WAIT_SECONDS, yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--yes") opts.yes = true;
    else if (a === "--profile" || a === "--wait") {
      const v = argv[++i];
      if (v === undefined || v === "" || v.startsWith("--")) throw new Error(`${a} の値が無い`);
      if (a === "--profile") {
        if (!SAFE_TOKEN.test(v)) throw new Error("--profile に使えない文字がある");
        opts.profile = v;
      } else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 60) throw new Error("--wait は 60 以上の整数（秒）");
        opts.waitSeconds = n;
      }
    } else if (!opts.command && ["status", "start", "stop"].includes(a)) opts.command = a;
    else throw new Error(`知らない引数: ${a}`);
  }
  if (!opts.help && !opts.command) throw new Error("status・start・stop のどれかを指定する（--help で使い方）");
  return opts;
}

// ---------------------------------------------------------------------------
// AWS（読み取りと、ASG の希望の変更だけ）
// ---------------------------------------------------------------------------

async function awsJson(run, profile, args) {
  const text = await run("aws", [...args, "--region", REGION, "--profile", profile, "--output", "json"]);
  return text.trim() ? JSON.parse(text) : null;
}

/** 親スタックの出力から、SFU に関係するものを読む */
export async function readOutputs(run, profile) {
  const outputs = (await awsJson(run, profile, ["cloudformation", "describe-stacks", "--stack-name", STACK, "--query", "Stacks[0].Outputs"])) ?? [];
  const of = (key) => outputs.find((o) => o.OutputKey === key)?.OutputValue ?? "";
  const out = {
    asgName: of("LivekitSfuAutoScalingGroupName"),
    livekitUrl: of("LivekitUrl"),
    apiKeyParam: of("LivekitApiKeyParameterName"),
    apiSecretParam: of("LivekitApiSecretParameterName"),
    publicIp: of("LivekitSfuPublicIp"),
  };
  if (!out.asgName) {
    throw new Error(`スタック ${STACK} に出力 LivekitSfuAutoScalingGroupName が無い。LivekitSfuEnabled=true でデプロイしたか確かめる（cloud/README.md）`);
  }
  if (!SAFE_TOKEN.test(out.asgName)) throw new Error("ASG の名前に使えない文字がある");
  for (const p of [out.apiKeyParam, out.apiSecretParam]) if (p && !SAFE_PARAM.test(p)) throw new Error("SSM のパラメータの名前に使えない文字がある");
  return out;
}

/** ASG の希望と、グループの中のインスタンス（InService など）、warm pool のインスタンス（Warmed:Stopped など） */
export async function readState(run, profile, asgName) {
  const groups = (await awsJson(run, profile, ["autoscaling", "describe-auto-scaling-groups", "--auto-scaling-group-names", asgName]))?.AutoScalingGroups ?? [];
  if (groups.length !== 1) throw new Error(`ASG ${asgName} が見つからない`);
  const g = groups[0];
  const warm = await awsJson(run, profile, ["autoscaling", "describe-warm-pool", "--auto-scaling-group-name", asgName]);
  return {
    desired: g.DesiredCapacity,
    inGroup: (g.Instances ?? []).map((i) => ({ id: i.InstanceId, state: i.LifecycleState, health: i.HealthStatus, template: i.LaunchTemplate?.Version })),
    warm: (warm?.Instances ?? []).map((i) => ({ id: i.InstanceId, state: i.LifecycleState, template: i.LaunchTemplate?.Version })),
    templateVersion: g.LaunchTemplate?.Version ?? g.MixedInstancesPolicy?.LaunchTemplate?.LaunchTemplateSpecification?.Version ?? "",
  };
}

/** SSM の 2 つのパラメータがあるか（値は読まない） */
export async function missingParameters(run, profile, names) {
  const res = await awsJson(run, profile, ["ssm", "describe-parameters", "--parameter-filters", `Key=Name,Values=${names.join(",")}`]);
  const found = new Set((res?.Parameters ?? []).map((p) => p.Name));
  return names.filter((n) => !found.has(n));
}

// ---------------------------------------------------------------------------
// 届くかの確認
// ---------------------------------------------------------------------------

/** https://<ホスト>/ が 200 を返すか（livekit-server は / で 200 を返す。Caddy が TLS を終端して 127.0.0.1:7880 へ渡す） */
export async function httpsReachable(livekitUrl, fetchImpl = fetch) {
  const url = livekitUrl.replace(/^wss:\/\//, "https://").replace(/\/*$/, "/");
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
    return { ok: res.status === 200, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: e.cause?.code ?? e.name ?? String(e) };
  }
}

async function dnsMatches(livekitUrl, publicIp) {
  if (!publicIp) return { ok: true, detail: "EIP の出力が無いので確かめない" };
  const host = new URL(livekitUrl.replace(/^wss:/, "https:")).hostname;
  try {
    const { address } = await lookup(host, { family: 4 });
    return { ok: address === publicIp, detail: `${host} → ${address}（EIP ${publicIp}）` };
  } catch (e) {
    return { ok: false, detail: `${host} を引けない（${e.code ?? e.message}）` };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function describe(state) {
  const lines = [`  希望の台数: ${state.desired}（起動テンプレートの版: ${state.templateVersion || "不明"}）`];
  if (state.inGroup.length === 0) lines.push("  グループの中: なし");
  for (const i of state.inGroup) lines.push(`  グループの中: ${i.id} ${i.state}（${i.health}・版 ${i.template ?? "?"}）`);
  if (state.warm.length === 0) lines.push("  warm pool: なし");
  for (const i of state.warm) lines.push(`  warm pool: ${i.id} ${i.state}（版 ${i.template ?? "?"}）`);
  const stale = [...state.inGroup, ...state.warm].filter((i) => i.template && state.templateVersion && i.template !== state.templateVersion && state.templateVersion !== "$Latest");
  if (stale.length) {
    lines.push(`  ! 起動テンプレートの古い版で作られたインスタンスがある（${stale.map((i) => i.id).join(", ")}）。UserData などの変更は反映されていない（cloud/README.md）`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/**
 * run: `(cmd, args, { cwd, inherit }) => Promise<string>`。ask: 質問して答えの文字列（端末でなければ null）を返す。log: 画面への出力
 */
export async function runSfu({ opts, run, ask = askOnTerminal, log = console.log, fetchImpl = fetch }) {
  const requireYes = async (question) => {
    if (opts.yes) return;
    const answer = await ask(`${question}。進めるなら yes と入力する: `);
    if (answer !== "yes") throw new Declined("yes が入力されなかったので、何も変えずに止めた");
  };

  let outputs;
  try {
    outputs = await readOutputs(run, opts.profile);
  } catch (e) {
    if (/LivekitSfuAutoScalingGroupName|使えない文字/.test(e.message)) throw e;
    // プロファイルのセッションが切れていることが多い（deploy-site.mjs と同じ扱い）
    await requireYes(`スタック ${STACK} を読めなかった（${e.message.split("\n")[0]}）。aws sso login --profile ${opts.profile} を行う`);
    await run("aws", ["sso", "login", "--profile", opts.profile], { inherit: true });
    outputs = await readOutputs(run, opts.profile);
  }
  log(`SFU: ${outputs.livekitUrl || "（LivekitUrl の出力なし）"}（ASG ${outputs.asgName}・EIP ${outputs.publicIp || "不明"}）`);

  const state = await readState(run, opts.profile, outputs.asgName);
  log(describe(state));

  if (opts.command === "status") {
    if (outputs.livekitUrl) {
      const dns = await dnsMatches(outputs.livekitUrl, outputs.publicIp);
      log(`  DNS: ${dns.ok ? "" : "! "}${dns.detail}`);
      const r = await httpsReachable(outputs.livekitUrl, fetchImpl);
      log(`  ${outputs.livekitUrl.replace(/^wss:/, "https:")}: ${r.ok ? "届く" : "届かない"}（${r.detail}）`);
    }
    return;
  }

  if (opts.command === "start") {
    // 値が無いまま起動すると、起動のたびの処理（comegin-livekit-boot）が失敗し、ライフサイクルフックの ABANDON でインスタンスが作り直される
    const names = [outputs.apiKeyParam, outputs.apiSecretParam].filter(Boolean);
    if (names.length !== 2) throw new Error("出力 LivekitApiKeyParameterName・LivekitApiSecretParameterName が無い（スタックを確かめる）");
    const missing = await missingParameters(run, opts.profile, names);
    if (missing.length) {
      throw new Error(`SSM のパラメータが無い: ${missing.join(", ")}。先に SecureString で入れる（cloud/README.md の LiveKit の SFU の節。値は監視アプリ・エージェントの LIVEKIT_API_KEY・LIVEKIT_API_SECRET と同じ）`);
    }
    log("SSM の API キーとシークレット: ある（値は読んでいない）");
    const dns = await dnsMatches(outputs.livekitUrl, outputs.publicIp);
    if (!dns.ok) log(`! DNS: ${dns.detail}（A レコードが EIP を指さないと、Caddy が証明書を取れない）`);

    if (state.desired !== 1) {
      await requireYes(`ASG ${outputs.asgName} の希望を 1 にする（起動する。EC2 の時間課金が始まる）`);
      await run("aws", ["autoscaling", "set-desired-capacity", "--auto-scaling-group-name", outputs.asgName, "--desired-capacity", "1", "--region", REGION, "--profile", opts.profile]);
      log("希望を 1 にした。InService になるのを待つ（warm pool からの起動と、起動のたびの処理〈EIP・設定・サービス〉）");
    } else {
      log("希望はすでに 1。InService を確かめる");
    }

    const until = Date.now() + opts.waitSeconds * 1000;
    for (;;) {
      const s = await readState(run, opts.profile, outputs.asgName);
      const inService = s.inGroup.find((i) => i.state === "InService");
      if (inService) {
        log(`InService: ${inService.id}`);
        break;
      }
      if (Date.now() > until) throw new Error(`InService にならなかった（${opts.waitSeconds} 秒）。SSM Session Manager で入り、journalctl -u comegin-livekit-boot を見る（cloud/README.md）\n${describe(s)}`);
      log(`  待っている: ${s.inGroup.map((i) => `${i.id} ${i.state}`).join(", ") || "まだグループに入っていない"}`);
      await sleep(POLL_MS);
    }

    const httpsUntil = Date.now() + HTTPS_WAIT_SECONDS * 1000;
    for (;;) {
      const r = await httpsReachable(outputs.livekitUrl, fetchImpl);
      if (r.ok) {
        log(`${outputs.livekitUrl.replace(/^wss:/, "https:")} に届く（${r.detail}）。監視アプリの /voice から接続できる`);
        return;
      }
      if (Date.now() > httpsUntil) {
        throw new Error(`InService だが https に届かない（${r.detail}）。初回は Caddy の証明書の取得を待つ。続くなら journalctl -u livekit-caddy -u livekit-server と DNS を見る（cloud/README.md）`);
      }
      log(`  https を待っている（${r.detail}）`);
      await sleep(POLL_MS);
    }
  }

  // stop
  if (state.desired !== 0) {
    await requireYes(`ASG ${outputs.asgName} の希望を 0 にする（停止する。インスタンスは warm pool に戻り、消えない）`);
    await run("aws", ["autoscaling", "set-desired-capacity", "--auto-scaling-group-name", outputs.asgName, "--desired-capacity", "0", "--region", REGION, "--profile", opts.profile]);
    log("希望を 0 にした。warm pool で Warmed:Stopped になるのを待つ");
  } else {
    log("希望はすでに 0。warm pool の状態を確かめる");
  }
  const until = Date.now() + opts.waitSeconds * 1000;
  for (;;) {
    const s = await readState(run, opts.profile, outputs.asgName);
    if (s.inGroup.length === 0 && s.warm.length > 0 && s.warm.every((i) => i.state === "Warmed:Stopped")) {
      log(`停止した: ${s.warm.map((i) => i.id).join(", ")} Warmed:Stopped（EBS と EIP の費用は続く）`);
      return;
    }
    if (s.inGroup.length === 0 && s.warm.length === 0) {
      log("! グループにも warm pool にもインスタンスが無い（warm pool が作り直し中か、終了された）。次の start で新しく作られる（証明書は取り直し）");
      return;
    }
    if (Date.now() > until) throw new Error(`Warmed:Stopped にならなかった（${opts.waitSeconds} 秒）\n${describe(s)}`);
    log(`  待っている: ${[...s.inGroup, ...s.warm].map((i) => `${i.id} ${i.state}`).join(", ")}`);
    await sleep(POLL_MS);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }
  await runSfu({ opts, run: realRun });
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(e instanceof Declined ? 3 : 1);
  });
}
