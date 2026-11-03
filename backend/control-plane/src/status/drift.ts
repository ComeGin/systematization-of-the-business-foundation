// 設定の状況: 設定スクリプトが確かめていない「ずれ」（spec 5.3）のうち、公開サイトの再配信と本番の n8n のワークフロー。
// どちらも origin/main を基準にする。origin/main を新しくするのは git-fetch.ts の fetchMain（呼び出し側が先に実行する）。
// 読み取りだけ: git は log・show・rev-parse・ls-tree・merge-base だけ。本番の n8n は GET だけ。
// 根拠の文字列（evidence）は日本語の短い文で、トークン・API キーを入れない（URL は認証情報なしのものだけ）。
import type { SetupStatusLevel } from "../contract.js";
import { N8N_WORKFLOWS_DIR, VERDANT_VIRGO_DIR } from "../constants/paths.js";
import { IntegrationError, fetchJson } from "../integrations/http.js";
import { N8nClient } from "../integrations/n8n.js";
import { logLine } from "../log.js";
import { GIT_READ_TIMEOUT_MS, readTokenOrNull, runGit } from "./git-fetch.js";

export type DriftResult = {
  id: "site-redeploy" | "n8n-workflows";
  level: SetupStatusLevel;
  evidence: string;
  /** 前回の結果を引き継いだとき、その結果を確かめた時刻（JST の ISO 8601）。無ければ今回の確認の時刻 */
  checkedAt?: string;
};

const SITE_FETCH_TIMEOUT_MS = 15_000;
const GITHUB_FETCH_TIMEOUT_MS = 15_000;
const SHA = /^[0-9a-f]{40}$/;

const short = (sha: string) => sha.slice(0, 7);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// ---------------------------------------------------------------------------
// 公開サイトの再配信
// ---------------------------------------------------------------------------

interface LogEntry {
  sha: string;
  subject: string;
}

/** `git log --format=%H%x09%cI%x09%s` の出力（新しい順）。 */
function parseLog(stdout: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [sha, , ...subject] = line.split("\t");
    if (sha && SHA.test(sha)) entries.push({ sha, subject: subject.join("\t") });
  }
  return entries;
}

/** コミットに紐づく PR の番号。取れなければ null（コミットだけを出す）。 */
async function pullRequestOf(
  repository: string,
  sha: string,
  token: string | null,
  signal: AbortSignal,
): Promise<number | null> {
  if (token === null) return null;
  try {
    const result = await fetchJson<{ number?: unknown; merged_at?: unknown }[]>({
      upstream: "github",
      url: `https://api.github.com/repos/${repository}/commits/${sha}/pulls`,
      init: {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "comegin-control-plane",
        },
      },
      timeoutMs: GITHUB_FETCH_TIMEOUT_MS,
      signal,
    });
    if (!Array.isArray(result.data)) return null;
    const pulls = result.data.filter((pull) => typeof pull?.number === "number");
    const pick = pulls.find((pull) => pull.merged_at) ?? pulls[0];
    return pick ? (pick.number as number) : null;
  } catch {
    return null;
  }
}

export async function checkSiteRedeploy(opts: {
  checkout: string;
  siteUrl: string;
  repository: string;
  tokenFile: string;
  signal: AbortSignal;
}): Promise<DriftResult> {
  const id = "site-redeploy" as const;
  const { checkout, signal } = opts;

  // 1. 配信中のビルドの情報（AWS の権限は要らない。公開サイトから HTTPS で読む）
  const url = `${opts.siteUrl.replace(/\/+$/, "")}/build-info.json`;
  const fetched = await fetchJson<{ commit?: unknown; builtAt?: unknown }>({
    upstream: "other",
    url,
    init: { method: "GET", headers: { Accept: "application/json" }, cache: "no-store" },
    timeoutMs: SITE_FETCH_TIMEOUT_MS,
    signal,
  });
  if (fetched.status === 404) {
    return { id, level: "action", evidence: "配信中のビルドにビルドの情報が無い。この機能より前のビルド" };
  }
  if (fetched.status === null) {
    return { id, level: "unknown", evidence: `公開サイトの build-info.json に届かない（${fetched.failureClass}）` };
  }
  const info = fetched.data;
  if (fetched.failureClass !== "ok" || info === null || typeof info !== "object") {
    return {
      id,
      level: "unknown",
      evidence: `公開サイトの build-info.json を読めない（${fetched.failureClass}${fetched.status ? `、HTTP ${fetched.status}` : ""}）`,
    };
  }
  const builtAt = typeof info.builtAt === "string" ? info.builtAt : "日時不明";
  if (typeof info.commit !== "string" || !SHA.test(info.commit)) {
    return {
      id,
      level: "unknown",
      evidence: `配信中のビルド（${builtAt}）にコミットの情報が無い。ビルドのときに git を読めなかった`,
    };
  }
  const commit = info.commit;

  // 2. 配信中のコミットが origin/main の履歴にあること（無ければ、ブランチからのビルドなどで比べられない）
  const ancestor = await runGit(checkout, ["merge-base", "--is-ancestor", commit, "origin/main"], {
    signal,
    timeoutMs: GIT_READ_TIMEOUT_MS,
  });
  if (ancestor.aborted) return { id, level: "unknown", evidence: "打ち切られた" };
  if (ancestor.code !== 0) {
    const why = ancestor.code === 1 ? "origin/main の履歴に無い（main 以外からのビルド？）" : "チェックアウトに無いか、origin/main を読めない";
    return { id, level: "unknown", evidence: `配信中のビルド（${short(commit)}）が${why}` };
  }

  // 3. そのコミットより後に、公開サイトを変えたコミット
  const log = await runGit(
    checkout,
    ["log", "--format=%H%x09%cI%x09%s", `${commit}..origin/main`, "--", VERDANT_VIRGO_DIR],
    { signal, timeoutMs: GIT_READ_TIMEOUT_MS },
  );
  if (log.aborted) return { id, level: "unknown", evidence: "打ち切られた" };
  if (log.code !== 0) return { id, level: "unknown", evidence: "git log で origin/main との差を読めない" };
  const entries = parseLog(log.stdout);
  if (entries.length === 0) {
    return { id, level: "ok", evidence: `配信中のビルド ${builtAt}（${short(commit)}）以降、公開サイトの変更なし` };
  }

  // 新しい順なので、最初のコミット = 末尾、最後のコミット = 先頭
  const first = entries[entries.length - 1]!;
  const last = entries[0]!;
  const token = await readTokenOrNull(opts.tokenFile);
  const describe = async (entry: LogEntry) => {
    const pull = await pullRequestOf(opts.repository, entry.sha, token, signal);
    return `${short(entry.sha)} ${clip(entry.subject, 50)}${pull === null ? "" : `（PR #${pull}）`}`;
  };
  const firstText = await describe(first);
  const lastText = entries.length === 1 ? null : await describe(last);
  const range = lastText === null ? firstText : `最初 ${firstText} 〜 最後 ${lastText}`;
  return {
    id,
    level: "action",
    evidence: `配信中のビルド ${builtAt}（${short(commit)}）の後に、公開サイトの変更が ${entries.length} 件: ${range}`,
  };
}

// ---------------------------------------------------------------------------
// 本番の n8n のワークフロー
// ---------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isObject(value: unknown): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** キーの順を固定する（配列の順序は意味があるので変えない）。 */
function sortDeep(value: unknown): Json {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!isObject(value)) return (value ?? null) as Json;
  const sorted: { [key: string]: Json } = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortDeep(value[key]);
  return sorted;
}

interface Comparable {
  nodes: Map<string, { type: string; typeVersion: string; parameters: string }>;
  connections: string;
}

/**
 * 取り込み（middleware/n8n/provision/provision.mjs）で書き換わる値を、比べる前にそろえる。
 * 子のワークフローを呼ぶノード（executeWorkflow）の workflowId.value は、取り込みのときに本番の id に付け替わる
 * （リポジトリの JSON には書き出し元＝開発の id が入っている）。ので、名前（cachedResultName）だけで比べる。
 */
function normalizeParameters(type: string, parameters: unknown): Json {
  if (type === "n8n-nodes-base.executeWorkflow" && isObject(parameters) && isObject(parameters.workflowId)) {
    return sortDeep({ ...parameters, workflowId: { cachedResultName: parameters.workflowId.cachedResultName ?? null } });
  }
  return sortDeep(parameters ?? {});
}

/**
 * 比べる項目だけを取り出す: ノード（名前・型・typeVersion・パラメータ。スケジュールのトリガーの規則はノードのパラメータ）と接続。
 * id・位置・updatedAt・資格情報の id・active などは比べない（見た目や実行のたびの変化で「ずれ」にしない）。
 */
function comparable(workflow: unknown): Comparable {
  const root = isObject(workflow) ? workflow : {};
  const nodes = new Map<string, { type: string; typeVersion: string; parameters: string }>();
  for (const raw of Array.isArray(root.nodes) ? root.nodes : []) {
    if (!isObject(raw) || typeof raw.name !== "string") continue;
    const type = typeof raw.type === "string" ? raw.type : "";
    nodes.set(raw.name, {
      type,
      typeVersion: JSON.stringify(raw.typeVersion ?? null),
      parameters: JSON.stringify(normalizeParameters(type, raw.parameters)),
    });
  }
  return { nodes, connections: JSON.stringify(sortDeep(root.connections ?? {})) };
}

/** 違いの短い説明。同じなら null。 */
function differences(repo: Comparable, prod: Comparable): string | null {
  const added = [...repo.nodes.keys()].filter((name) => !prod.nodes.has(name));
  const removed = [...prod.nodes.keys()].filter((name) => !repo.nodes.has(name));
  if (added.length > 0 || removed.length > 0) return "ノードの追加・削除";
  const changed = [...repo.nodes.entries()].filter(([name, node]) => {
    const other = prod.nodes.get(name)!;
    return node.type !== other.type || node.typeVersion !== other.typeVersion || node.parameters !== other.parameters;
  });
  if (changed.length > 0) return `ノード「${clip(changed[0]![0], 20)}」${changed.length > 1 ? `ほか ${changed.length - 1} 件` : ""}の設定`;
  if (repo.connections !== prod.connections) return "ノードの接続";
  return null;
}

const MAX_LISTED = 5;
/** 本番に取り込むワークフローの表。provision.mjs もこのファイルを読む（実行せずに読めるよう JSON） */
const N8N_PROVISION_TABLE = "middleware/n8n/provision/workflows.json";
/** 表の file として受け付ける名前（ディレクトリをたどらせない） */
const FILE_NAME = /^[^/\\\0]+\.json$/;

export async function checkN8nWorkflows(opts: {
  checkout: string;
  n8n: { baseUrl: string; apiKey: string } | null;
  signal: AbortSignal;
}): Promise<DriftResult> {
  const id = "n8n-workflows" as const;
  const { checkout, signal } = opts;
  // キーが無いのは障害ではなく判断待ち（daily-n8n-export の扱いが決まるまで本番の n8n の API キーを置かない）。
  // ? にすると「確かめられない」の知らせが出続ける（または黙る）ので、◇ 人が確かめるにする
  if (opts.n8n === null) {
    return {
      id,
      level: "manual",
      evidence:
        "本番の n8n の API キー（CONTROL_N8N_EXPORT_*）が無いので比べない（daily-n8n-export の判断待ち。setup/00-setup-overview.md の 6 節）",
    };
  }

  // 1. 本番に取り込むワークフローの表（provision の workflows.json。targets に prod を含むものだけ）。
  //    ops-monitor のように開発だけのものは本番に取り込まれないので、比べない
  const table = await runGit(checkout, ["show", `origin/main:${N8N_PROVISION_TABLE}`], { signal, timeoutMs: GIT_READ_TIMEOUT_MS });
  if (table.aborted) return { id, level: "unknown", evidence: "打ち切られた" };
  if (table.code !== 0) {
    return { id, level: "unknown", evidence: `origin/main から本番に取り込むワークフローの表（${N8N_PROVISION_TABLE}）を読めない` };
  }
  let files: string[];
  try {
    const parsed: unknown = JSON.parse(table.stdout);
    if (!Array.isArray(parsed)) throw new Error("配列ではない");
    files = parsed
      .filter((entry): entry is { file: string; targets: string[] } => isObject(entry) && typeof entry.file === "string" && Array.isArray(entry.targets))
      .filter((entry) => entry.targets.includes("prod") && FILE_NAME.test(entry.file))
      .map((entry) => entry.file)
      .sort();
  } catch {
    return { id, level: "unknown", evidence: `本番に取り込むワークフローの表（${N8N_PROVISION_TABLE}）が JSON として読めない` };
  }

  const repoWorkflows = new Map<string, Comparable>();
  for (const file of files) {
    const shown = await runGit(checkout, ["show", `origin/main:${N8N_WORKFLOWS_DIR}/${file}`], { signal, timeoutMs: GIT_READ_TIMEOUT_MS });
    if (shown.aborted) return { id, level: "unknown", evidence: "打ち切られた" };
    if (shown.code !== 0) return { id, level: "unknown", evidence: `origin/main の ${file} を読めない` };
    try {
      const parsed = JSON.parse(shown.stdout) as { name?: unknown };
      if (typeof parsed.name === "string") repoWorkflows.set(parsed.name.normalize("NFC"), comparable(parsed));
    } catch {
      // 壊れた JSON は比べる対象にしない（n8n-export と同じ扱い）
      logLine("WARN", "setup-status", `${file} を JSON として読めない（n8n の比較に使わない）`);
    }
  }
  if (repoWorkflows.size === 0) {
    return { id, level: "ok", evidence: "本番に取り込むワークフローの JSON が origin/main に無く、比べるものが無い" };
  }

  // 2. 本番の n8n（名前で対応づける。アーカイブ済みは無いものとして扱う）
  const n8n = new N8nClient(opts.n8n, signal);
  const differing: string[] = [];
  try {
    const summaries = (await n8n.listWorkflows()).filter((workflow) => !workflow.isArchived);
    for (const [name, repo] of [...repoWorkflows].sort(([a], [b]) => a.localeCompare(b))) {
      if (signal.aborted) return { id, level: "unknown", evidence: "打ち切られた" };
      const candidates = summaries
        .filter((summary) => summary.name.normalize("NFC") === name)
        .sort((a, b) => a.id.localeCompare(b.id));
      if (candidates.length === 0) {
        differing.push(`${clip(name, 30)}（本番に無い）`);
        continue;
      }
      // 同じ名前が複数あれば、どれか 1 つが一致していればよい。一致しなければ先頭の違いを出す
      const reasons: (string | null)[] = [];
      for (const candidate of candidates) reasons.push(differences(repo, comparable(await n8n.getWorkflow(candidate.id))));
      const reason = reasons.includes(null) ? null : reasons[0]!;
      if (reason !== null) differing.push(`${clip(name, 30)}（${reason}）`);
    }
  } catch (error) {
    if (signal.aborted) return { id, level: "unknown", evidence: "打ち切られた" };
    const failureClass = error instanceof IntegrationError ? error.failureClass : "invalid_response";
    logLine("WARN", "setup-status", `本番の n8n を読めない: ${failureClass}`);
    return { id, level: "unknown", evidence: `本番の n8n を読めない（${failureClass}）` };
  }

  if (differing.length === 0) {
    return { id, level: "ok", evidence: `origin/main の ${repoWorkflows.size} 件のワークフローが、本番の n8n と一致` };
  }
  const listed = differing.slice(0, MAX_LISTED).join("、");
  const rest = differing.length > MAX_LISTED ? `、ほか ${differing.length - MAX_LISTED} 件` : "";
  return {
    id,
    level: "action",
    evidence: `本番の n8n が origin/main のワークフローと違う（${differing.length} 件）: ${listed}${rest}`,
  };
}
