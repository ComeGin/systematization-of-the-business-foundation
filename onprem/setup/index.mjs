// オンプレの本番（ADR-21。WireGuard・Strapi と n8n の本番）の枠。check は読むだけ。apply は AWS のデプロイの後に実装する。
// 出典: onprem/README.md（起動の順番・ポート 1338/5679/5680・systemd）、onprem/wireguard/README.md（10.99.0.2・手順 1〜5）、
//       onprem/systemd/comegin-{strapi,n8n}.service、`ip -br addr`・`systemctl is-enabled / is-active`・`ss -ltn` の標準の使い方。
//
// items（監視アプリの「設定の状況」が読む。2026-11-11。設計は docs/superpowers/specs/2026-11-11-deploy-drift-detection-design.md の 4.4）:
//   onprem.strapi-image  Strapi のイメージが origin/main に追いついているか。ビルドしたが再起動していないか
//   onprem.n8n-image     n8n の派生イメージについて同じ
//   onprem.n8n-version   n8n の環境変数ファイルの版・ダイジェストが、動いているコンテナと origin/main の雛形に揃っているか
//   読むのは docker image inspect・docker ps・docker inspect・git（log・merge-base・show）だけ。ok と notes の判定には混ぜない
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseKeyValue } from "../../setup/lib/core.mjs";
import { commitDrift, describeChanges } from "../../setup/lib/drift.mjs";

export const meta = { id: "onprem", title: "オンプレの本番（WireGuard・Strapi・n8n。枠だけ）", targets: ["prod"], phases: ["apps"], after: [] };

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

  // 秘匿ファイルは存在だけを見る（中身は読まない）。追跡しないので、コードを main のチェックアウトから動かすとき（監視アプリ）も作業ツリーのものを見る
  for (const name of ["strapi", "n8n"]) {
    const exists = existsSync(join(ctx.WORKTREE, "onprem", name, ".env"));
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

// ---------------------------------------------------------------------------
// items: イメージの古さと n8n の版のずれ（読むだけ）
// ---------------------------------------------------------------------------

const REVISION_LABEL = "org.opencontainers.image.revision";
const N8N_VERSION_LABEL = "com.comegin.n8n-version";
const N8N_DIGEST_LABEL = "com.comegin.n8n-digest";
const N8N_KEYS = ["N8N_VERSION", "N8N_DIGEST", "N8N_RUNNERS_DIGEST"];
const COMMIT = /^[0-9a-f]{40}$/;
const RANK = { ok: 0, unknown: 1, warn: 2, action: 3 };

const short = (sha) => sha.slice(0, 7);
const shortDigest = (d) => d.slice(0, "sha256:".length + 12);
const shortId = (id) => id.replace(/^sha256:/, "").slice(0, 12);
const firstLine = (e) => String(e?.message ?? e).split("\n")[0];
// ビルドの包み（onprem/build.mjs）。未コミットの変更があると止まり、GIT_COMMIT=<HEAD> を付けて docker compose build する
const buildCommand = (dir) => `node onprem/build.mjs ${dir}`;

/** 確かめた結果（{ level, text }[]）から項目の level と evidence を決める。いちばん重いものが level、問題の文はすべて「／」でつなぐ */
function verdict(findings, okEvidence) {
  if (findings.length === 0) return { level: "ok", evidence: okEvidence };
  const level = findings.reduce((worst, f) => (RANK[f.level] > RANK[worst] ? f.level : worst), "ok");
  return { level, evidence: findings.map((f) => f.text).join("／") };
}

/** docker image inspect。イメージが無ければ null（それ以外の失敗は投げる） */
async function inspectImage(ctx, ref) {
  try {
    const out = await ctx.run("docker", ["image", "inspect", "--format", "{{.Id}}\t{{json .Config.Labels}}", ref]);
    const [id, labels] = out.trim().split("\t");
    return { id, labels: JSON.parse(labels) ?? {} };
  } catch (e) {
    if (/No such image/i.test(String(e?.message))) return null;
    throw e;
  }
}

/** compose のプロジェクトとサービスで動いているコンテナの ID（docker compose は環境変数ファイルの補間を巻き込むので使わない） */
async function runningContainers(ctx, project, service) {
  const out = await ctx.run("docker", [
    "ps",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--filter",
    `label=com.docker.compose.service=${service}`,
  ]);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

const inspectContainer = async (ctx, id, format) => (await ctx.run("docker", ["inspect", "--format", format, id])).trim();

/** n8n の環境変数ファイルから、版とダイジェストの 3 つだけを取り出す（ほかの値は捨てる。パスワードや暗号化キーはここから先に渡さない） */
function readN8nPins(ctx) {
  const path = join(ctx.WORKTREE, "onprem", "n8n", ".env");
  if (!existsSync(path)) return { exists: false, pins: {} };
  const all = ctx.readEnvFile(path);
  return { exists: true, pins: Object.fromEntries(N8N_KEYS.map((k) => [k, all[k] ?? ""])) };
}

/** 数字とピリオドだけの版を比べる。-1（a が古い）・0・1。比べられない文字列なら null */
function compareVersions(a, b) {
  const plain = /^\d+(\.\d+)*$/;
  if (!plain.test(a) || !plain.test(b)) return null;
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * イメージの項目（Strapi・n8n 共通）。ラベルのコミットから origin/main までに関係するパスの変更があるか、
 * ビルドしたイメージを動いているコンテナが使っているか（ビルドしたが再起動していないか）を見る
 */
async function imageItem(ctx, spec) {
  const findings = [];
  const build = buildCommand(spec.dir);
  const image = await inspectImage(ctx, spec.ref);
  if (!image) {
    findings.push({ level: "action", text: `イメージ ${spec.ref} が無い（まだビルドしていない）。${build}、そのあと sudo systemctl restart ${spec.unit}` });
    return verdict(findings);
  }

  const recorded = image.labels[REVISION_LABEL] ?? "";
  if (!COMMIT.test(recorded)) {
    findings.push({ level: "action", text: `イメージにビルドしたコミットの記録が無い（この仕組みより前のビルド、または GIT_COMMIT を付けずにビルドした）。${build}、そのあと sudo systemctl restart ${spec.unit}` });
  } else {
    try {
      const drift = await commitDrift(ctx, { recorded, paths: spec.paths });
      if (drift.kind === "outside-main") {
        findings.push({ level: "warn", text: `イメージのコミット ${short(recorded)} が origin/main の履歴に無い（git fetch するか、main のチェックアウトで記録付きでビルドし直す）` });
      } else if (drift.kind === "changed") {
        findings.push({ level: "action", text: `イメージのコミット ${short(recorded)} の後に、関係するファイルが origin/main で変わった（${describeChanges(drift.entries)}）。ビルドし直しが要る: ${build}、そのあと sudo systemctl restart ${spec.unit}` });
      }
    } catch (e) {
      findings.push({ level: "unknown", text: `origin/main との差を git で確かめられない（${firstLine(e)}）` });
    }
  }

  // コンテナを読めなくても、ここまでに見つけたもの（ビルドし直しが要る）は落とさない。読めなかったことだけを足す
  try {
    const containers = await runningContainers(ctx, spec.project, spec.service);
    if (containers.length === 0) {
      // 止まっていること自体は apps の判定（待ち受け・ユニット）が出す。ここは「確かめられない」だけ（cloud の項目と同じ扱い）
      findings.push({ level: "unknown", text: `コンテナ（${spec.service}）が動いていないので、ビルドしたイメージで動いているかは確かめられない` });
    }
    for (const id of containers) {
      const using = await inspectContainer(ctx, id, "{{.Image}}");
      if (using !== image.id) {
        findings.push({ level: "action", text: `動いているコンテナのイメージ（${shortId(using)}）が、ビルドしたイメージ（${shortId(image.id)}）と違う。ビルドしたが再起動していない: sudo systemctl restart ${spec.unit}` });
      }
    }
  } catch (e) {
    findings.push({ level: "unknown", text: `動いているコンテナを docker で確かめられない（${firstLine(e)}）` });
  }
  return verdict(findings, `ビルドしたコミット ${short(recorded)} から origin/main までに、関係するファイルの変更は無い。動いているコンテナは最新のイメージ`);
}

/** n8n の runners のイメージ（`ghcr.io/n8n-io/runners:<版>@sha256:…`）を版とダイジェストに分ける */
function parseRunnersImage(ref) {
  const m = /:([^:@/]+)@(sha256:[0-9a-f]+)$/.exec(ref);
  return m ? { version: m[1], digest: m[2] } : null;
}

/** 環境変数ファイルの 3 つの値が、動いているコンテナと一致しているか */
async function compareWithRunning(ctx, pins, findings) {
  const [n8nIds, runnersIds] = [await runningContainers(ctx, "comegin-prod-n8n", "n8n"), await runningContainers(ctx, "comegin-prod-n8n", "runners")];
  let runningVersion = pins.N8N_VERSION;
  if (n8nIds.length === 0) {
    findings.push({ level: "warn", text: "n8n のコンテナが動いていないので、動いているものとは比べられない" });
  } else {
    const labels = JSON.parse(await inspectContainer(ctx, n8nIds[0], "{{json .Config.Labels}}")) ?? {};
    const version = labels[N8N_VERSION_LABEL];
    const digest = labels[N8N_DIGEST_LABEL];
    if (!version || !digest) {
      findings.push({ level: "action", text: `動いている n8n のイメージに版の記録（ラベル）が無い。${buildCommand("n8n")}、そのあと sudo systemctl restart comegin-n8n` });
    } else {
      runningVersion = version;
      if (version !== pins.N8N_VERSION) {
        findings.push({ level: "action", text: `環境変数ファイルの N8N_VERSION は ${pins.N8N_VERSION} だが、動いている n8n は ${version}（上げたが作り直し・再起動していない）` });
      }
      if (digest !== pins.N8N_DIGEST) {
        findings.push({ level: "action", text: `環境変数ファイルの N8N_DIGEST（${shortDigest(pins.N8N_DIGEST)}）が、動いている n8n のイメージのもの（${shortDigest(digest)}）と違う（上げたが作り直し・再起動していない）` });
      }
    }
  }
  if (runnersIds.length === 0) {
    findings.push({ level: "warn", text: "runners のコンテナが動いていないので、動いているものとは比べられない" });
  } else {
    const ref = await inspectContainer(ctx, runnersIds[0], "{{.Config.Image}}");
    const runners = parseRunnersImage(ref);
    if (!runners) {
      findings.push({ level: "action", text: "動いている runners のイメージが、版とダイジェストの両方で固定されていない" });
    } else {
      if (runners.digest !== pins.N8N_RUNNERS_DIGEST) {
        findings.push({ level: "action", text: `環境変数ファイルの N8N_RUNNERS_DIGEST（${shortDigest(pins.N8N_RUNNERS_DIGEST)}）が、動いている runners のもの（${shortDigest(runners.digest)}）と違う（上げたが作り直し・再起動していない）` });
      }
      if (runners.version !== runningVersion) {
        findings.push({ level: "action", text: `runners の版（${runners.version}）と n8n の版（${runningVersion}）が違う（必ずそろえる）` });
      }
    }
  }
}

/** 環境変数ファイルの 3 つの値を、origin/main の雛形と比べる */
async function compareWithExample(ctx, pins, findings) {
  let example;
  try {
    const text = await ctx.run("git", ["-C", ctx.WORKTREE, "show", "origin/main:onprem/n8n/.env.example"]);
    example = parseKeyValue(text);
  } catch (e) {
    findings.push({ level: "unknown", text: `origin/main の雛形（onprem/n8n/.env.example）を読めない（${firstLine(e)}）` });
    return;
  }
  const differs = N8N_KEYS.filter((k) => (example[k] ?? "") !== pins[k]);
  if (differs.length === 0) return;
  if (differs.includes("N8N_VERSION")) {
    const order = compareVersions(pins.N8N_VERSION, example.N8N_VERSION ?? "");
    if (order === 1) {
      findings.push({ level: "warn", text: `環境変数ファイルの版（${pins.N8N_VERSION}）が origin/main の雛形（${example.N8N_VERSION}）より新しい。人が先に上げたなら、雛形（onprem/n8n/.env.example）の更新を促す` });
    } else if (order === -1) {
      findings.push({ level: "action", text: `origin/main の雛形は ${example.N8N_VERSION} に上がっているが、環境変数ファイルは ${pins.N8N_VERSION}（古い）。雛形に合わせて上げる` });
    } else {
      findings.push({ level: "action", text: `環境変数ファイルの N8N_VERSION（${pins.N8N_VERSION}）が雛形（${example.N8N_VERSION ?? "無い"}）と違い、新旧を決められない` });
    }
    return;
  }
  findings.push({ level: "action", text: `${differs.join("・")} が origin/main の雛形と違う（版は同じ ${pins.N8N_VERSION} なので、新旧を決められない）` });
}

async function n8nVersionItem(ctx, envPins) {
  const findings = [];
  if (!envPins.exists) {
    findings.push({ level: "action", text: "onprem/n8n の環境変数ファイルが無い（./dev/init-env.sh で作る）" });
    return verdict(findings);
  }
  const missing = N8N_KEYS.filter((k) => !envPins.pins[k]);
  if (missing.length > 0) {
    findings.push({ level: "action", text: `onprem/n8n の環境変数ファイルに ${missing.join("・")} が無い（雛形 onprem/n8n/.env.example を参照）` });
    return verdict(findings);
  }
  try {
    await compareWithRunning(ctx, envPins.pins, findings);
  } catch (e) {
    findings.push({ level: "unknown", text: `動いているコンテナを docker で確かめられない（${firstLine(e)}）` });
  }
  await compareWithExample(ctx, envPins.pins, findings);
  return verdict(findings, `版 ${envPins.pins.N8N_VERSION} とダイジェスト 2 つが、動いている n8n・runners と origin/main の雛形に揃っている`);
}

// backend/strapi-system/.dockerignore がビルドの入力から外すもののうち、追跡しているものと、あっても無関係なディレクトリ（設計 4.4）。
// これらだけを変えたコミットで ● にしない。Dockerfile と .dockerignore 自体はビルドに効くので残す。
// `!.env.example` は .dockerignore が入力に戻しているので除かない（.dockerignore の並びをそのまま写す）。README.md は NON_CODE_EXCLUDES が除く
const STRAPI_CONTEXT = "backend/strapi-system";
const STRAPI_DOCKERIGNORED = [
  ".claude",
  ".gitignore",
  ".strapi",
  ".tmp",
  "dist",
  "node_modules",
  "data",
].map((p) => `:(exclude)${STRAPI_CONTEXT}/${p}`);
STRAPI_DOCKERIGNORED.push(`:(exclude,glob)${STRAPI_CONTEXT}/public/uploads/*`, `:(exclude,glob)${STRAPI_CONTEXT}/*.log`, `:(exclude,glob)${STRAPI_CONTEXT}/*.sqlite`, `:(exclude,glob)${STRAPI_CONTEXT}/*.sqlite3`);

const STRAPI_IMAGE = { dir: "strapi", ref: "comegin/strapi-onprem:local", project: "comegin-prod-strapi", service: "strapi", unit: "comegin-strapi", paths: [STRAPI_CONTEXT, "onprem/strapi", ...STRAPI_DOCKERIGNORED] };
const N8N_IMAGE = { dir: "n8n", project: "comegin-prod-n8n", service: "n8n", unit: "comegin-n8n", paths: ["onprem/n8n/Dockerfile", "onprem/n8n/compose.yml"] };

/** 3 つの項目。1 つが確かめられなくても（git・docker の失敗）、その項目だけ unknown にして続ける */
async function driftItems(ctx) {
  const specs = [
    { key: "onprem.strapi-image", title: "Strapi（本番）のイメージが origin/main に追いつき、再起動も済んでいる" },
    { key: "onprem.n8n-image", title: "n8n（本番）のイメージが origin/main に追いつき、再起動も済んでいる" },
    { key: "onprem.n8n-version", title: "n8n の版・ダイジェストが、環境変数ファイル・動いているコンテナ・雛形で揃っている" },
  ];
  const dockerReady = await ctx.commandExists("docker");
  let pins;
  let pinsError;
  try {
    pins = readN8nPins(ctx);
  } catch (e) {
    pinsError = e;
  }
  const evaluate = {
    "onprem.strapi-image": () => imageItem(ctx, STRAPI_IMAGE),
    "onprem.n8n-image": async () => {
      if (pinsError) throw pinsError;
      if (!pins.pins.N8N_VERSION) {
        return { level: "action", evidence: "n8n のイメージの名前を決められない（onprem/n8n の環境変数ファイルが無い、または N8N_VERSION が空）。./dev/init-env.sh で作り、値を入れる" };
      }
      return imageItem(ctx, { ...N8N_IMAGE, ref: `comegin/n8n-onprem:${pins.pins.N8N_VERSION}` });
    },
    "onprem.n8n-version": async () => {
      if (pinsError) throw pinsError;
      return n8nVersionItem(ctx, pins);
    },
  };
  const items = [];
  for (const { key, title } of specs) {
    let result;
    if (!dockerReady) {
      result = { level: "unknown", evidence: "docker コマンドが使えないので、イメージとコンテナを確かめられない" };
    } else {
      try {
        result = await evaluate[key]();
      } catch (e) {
        result = { level: "unknown", evidence: `確かめられない（${firstLine(e)}）` };
      }
    }
    items.push({ key, step: "P6", level: result.level, title, evidence: result.evidence });
  }
  return items;
}

export async function check(ctx) {
  const r = await inspect(ctx);
  return { ok: allReady(r), notes: r.notes, items: await driftItems(ctx) };
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
      "公開鍵を AWS に渡す（両方に入れる）: 親スタックの出力 OnpremPublicKeyParameterName の SSM パラメータに aws ssm put-parameter --overwrite（すぐ効く）と、samconfig.toml の OnpremWireguardPublicKey（入れないと次の sam deploy で UNSET に戻る。同じときに WireguardFixedAmiId も書く。cloud/README.md の 4.2.1 の手順 3）",
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
        `${name}: cd ${onprem}/${name} && ./dev/init-env.sh → 環境変数ファイルに ${secrets} を入れる（cloud/README.md の 4.5・4.8。暗号化キーは本番用を別に作って控える。開発の値を流用しない）→ node ${onprem}/build.mjs ${name}（未コミットの変更があると止まる。GIT_COMMIT=<HEAD> を付けて docker compose build し、ビルドしたコミットをイメージのラベルに残す。設定の状況が古さを調べる）→ cd ${onprem}/${name} && docker compose up -d`,
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
