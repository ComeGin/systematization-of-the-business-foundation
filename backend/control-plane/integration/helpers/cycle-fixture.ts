// 改善ループ（14 日の周）の結合テストの土台。fixtures.ts の一時ディレクトリに、次を git のリポジトリとして作る。
//   承認済み main のチェックアウト（CONTROL_MAIN_CHECKOUT）
//     - ops/approval-checklists.yaml・ops/prompts/article-cover.md: リポジトリの本物を写す（確認項目と画像のプロンプトの雛形の正本）
//     - ops/schedules: 周のジョブの定義（id と builtin・agent・proposal_kinds は本物と同じ。手動で起動するので enabled: false）
//     - .claude/agents: 作用のエージェントの定義（Agent SDK はモックなので、ツールは MCP を持たない最小のもの）
//     - frontend/verdant-virgo: 偽の `pnpm lh`（astro build ＋ Lighthouse CI の代わり。下の LH_STUB）と node_modules/（中身は空）
//   エージェント専用の作業場（CONTROL_WORKTREE）
//     - frontend/verdant-virgo/src/components/Cta.astro だけをコミットした状態（cycle-apply-code が差分を作る先）
// 公開の入口（createControlPlane）に環境変数で渡すだけで、src の内部には触れない。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CycleView, ProposalKind } from "../../src/contract.js";
import { CHATWOOT_REGISTRY, type Fixture, writeAgent, writeAt, writeRegistry, writeSchedule } from "./fixtures.js";

/** リポジトリの直下（integration/helpers から 4 つ上） */
export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export const CTA_FILE = "frontend/verdant-virgo/src/components/Cta.astro";
export const CTA_BEFORE = '<a href="/contact/" class="cta">お問い合わせ</a>\n';
export const CTA_AFTER = '<a href="/contact/" class="cta" aria-label="無料相談を申し込む（お問い合わせ）">無料相談を申し込む</a>\n';

const GIT_ENV = {
  GIT_AUTHOR_NAME: "it-control-plane",
  GIT_AUTHOR_EMAIL: "it-control-plane@example.com",
  GIT_COMMITTER_NAME: "it-control-plane",
  GIT_COMMITTER_EMAIL: "it-control-plane@example.com",
};

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", dir, ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...GIT_ENV },
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim();
}

/** すべてをコミットし、HEAD の SHA（40 桁）を返す */
export function commitAll(dir: string, message: string): string {
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "--allow-empty", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

/** 偽の Lighthouse の 4 指標（it-scores.json に書く。偽の `pnpm lh` が manifest.json に写す） */
export interface Scores {
  performance: number;
  accessibility: number;
  "best-practices": number;
  seo: number;
}
export const PASSING_SCORES: Scores = { performance: 0.95, accessibility: 1, "best-practices": 1, seo: 1 };

/**
 * 偽の `pnpm lh`。published-article-check が承認済み main のチェックアウトで、本番の値（SITE_URL・STRAPI_URL・読み取りトークン・BUILD_COMMIT_SHA）を
 * 渡して起動する。Astro のビルドと同じく Strapi の Content API から公開済みの記事を読み、dist/blog/<slug>/ と dist/_build.json を作り、
 * Lighthouse CI と同じ形の .lighthouse/manifest.json を書く。受け取った環境変数は、値の sha256 だけを .lighthouse/it-env.json に残す
 * （書き込みトークンなどが子プロセスに渡っていないことをテストが確かめるため。値そのものはファイルに書かない）。
 */
const LH_STUB = `// 結合テストの偽の pnpm lh（astro build ＋ Lighthouse CI の代わり）
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const env = process.env;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const scores = JSON.parse(readFileSync("it-scores.json", "utf8"));
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
const slugs = [];
for (let page = 1; ; page++) {
  const url = env.STRAPI_URL + "/api/articles?status=published&fields[0]=slug&pagination[page]=" + page + "&pagination[pageSize]=100";
  const res = await fetch(url, { headers: { authorization: "Bearer " + env.STRAPI_API_TOKEN } });
  if (!res.ok) { console.error("Strapi の記事を読めない: HTTP " + res.status); process.exit(1); }
  const body = await res.json();
  for (const article of body.data) if (article.slug) slugs.push(article.slug);
  if (page >= (body.meta?.pagination?.pageCount ?? 1)) break;
}
for (const slug of slugs) {
  mkdirSync("dist/blog/" + slug, { recursive: true });
  writeFileSync("dist/blog/" + slug + "/index.html", "<h1>" + slug + "</h1>");
}
writeFileSync("dist/index.html", "<h1>top</h1>");
writeFileSync("dist/_build.json", JSON.stringify({ commit: env.BUILD_COMMIT_SHA, builtAt: new Date().toISOString() }));
mkdirSync(".lighthouse", { recursive: true });
writeFileSync(".lighthouse/manifest.json", JSON.stringify([{ url: env.SITE_URL + "/", isRepresentativeRun: true, summary: scores }]));
writeFileSync(".lighthouse/it-env.json", JSON.stringify({
  names: Object.keys(env).sort(),
  valueHashes: Object.values(env).map((value) => sha(String(value))),
  strapiUrl: env.STRAPI_URL, siteUrl: env.SITE_URL, buildTarget: env.BUILD_TARGET, commit: env.BUILD_COMMIT_SHA,
  strapiTokenSha256: sha(env.STRAPI_API_TOKEN ?? ""),
}));
process.exit(scores.seo < 1 ? 1 : 0);
`;

/** 周のジョブの定義（ops/schedules。本物と同じ id にする: 画面の段階ごとのジョブの判定〈cycle/service.ts の STAGE_JOB〉が id で見るため） */
const SCHEDULES: Record<string, string> = {
  "cycle-open": 'enabled: false\ncron: "0 0 * * 1"\nkind: builtin\nbuiltin: cycle-open\ntimeout_sec: 120\n',
  "cycle-collect": 'enabled: false\ncron: "0 7 * * *"\nkind: builtin\nbuiltin: cycle-collect\ntimeout_sec: 300\n',
  "cycle-close": 'enabled: false\ncron: "5 0 * * 1"\nkind: builtin\nbuiltin: cycle-close\ntimeout_sec: 120\n',
  "daily-observe-seo": 'enabled: false\ncron: "0 4 * * *"\nkind: agent\nagent: seo-auditor\nprompt: "GSC の実績を E-12 にする"\ntimeout_sec: 120\nmax_turns: 10\n',
  "daily-observe-conversations":
    'enabled: false\ncron: "50 3 * * *"\nkind: agent\nagent: conversation-triage\nprompt: "未解決の会話を集計して E-12 にする"\ntimeout_sec: 120\nmax_turns: 10\n',
  "daily-propose": 'enabled: false\ncron: "30 4 * * *"\nkind: agent\nagent: proposal-writer\nprompt: "E-12 から改善提案を起票する"\ntimeout_sec: 120\nmax_turns: 10\n',
  "daily-i13-file": 'enabled: false\ncron: "30 5 * * *"\nkind: builtin\nbuiltin: i13-file\ntimeout_sec: 120\n',
  "cycle-apply-content":
    'enabled: false\ncron: "30 6 * * *"\nkind: agent\nagent: content-writer\nprompt: "承認済みの E-13 から記事の下書きを作る"\ntimeout_sec: 120\nmax_turns: 10\nproposal_kinds:\n  - content_rewrite\n',
  "cycle-campaign":
    'enabled: false\ncron: "0 2 * * *"\nkind: agent\nagent: campaign-planner\nprompt: "承認済みの E-13 からキャンペーン一式を未公開で作る"\ntimeout_sec: 120\nmax_turns: 10\nproposal_kinds:\n  - email_campaign\n',
  "cycle-apply-code":
    'enabled: false\ncron: "0 5 * * 2-6"\nkind: agent\nagent: design-implementer\nprompt: "承認済みの E-13 から公開サイトの差分を作る"\ntimeout_sec: 120\nmax_turns: 10\nproposal_kinds:\n  - technical_seo\n  - accessibility\n  - cta_swap\n  - internal_link\n',
  "article-cover": 'enabled: false\ncron: "0 3 * * 0,2-6"\nkind: builtin\nbuiltin: article-cover\ntimeout_sec: 300\n',
  "published-article-check": 'enabled: false\ncron: "0 0 * * *"\nkind: builtin\nbuiltin: published-article-check\ntimeout_sec: 300\n',
};

const AGENTS = ["seo-auditor", "conversation-triage", "proposal-writer", "content-writer", "campaign-planner", "design-implementer"];

/** main と作業場を git のリポジトリとして作る。戻り値は main の最初のコミット */
export function setupCycleRepos(fx: Fixture, scores: Scores = PASSING_SCORES): string {
  for (const file of ["ops/approval-checklists.yaml", "ops/prompts/article-cover.md"]) {
    mkdirSync(dirname(join(fx.main, file)), { recursive: true });
    copyFileSync(join(REPO_ROOT, file), join(fx.main, file));
  }
  for (const [id, body] of Object.entries(SCHEDULES)) writeSchedule(fx, id, body);
  for (const name of AGENTS) writeAgent(fx, name, ["Read", "Write", "Edit", "Glob"]);
  writeRegistry(fx, CHATWOOT_REGISTRY);

  const app = "frontend/verdant-virgo";
  writeAt(fx.main, `${app}/package.json`, `${JSON.stringify({ name: "it-verdant-virgo", private: true, type: "module", scripts: { lh: "node it-lh.mjs" } }, null, 2)}\n`);
  writeAt(fx.main, `${app}/it-lh.mjs`, LH_STUB);
  writeAt(fx.main, `${app}/node_modules/.keep`, "");
  writeAt(fx.main, CTA_FILE, CTA_BEFORE);
  writeAt(fx.main, ".gitignore", ["node_modules/", "dist/", ".lighthouse/", "it-scores.json", "pnpm-lock.yaml", ""].join("\n"));
  setScores(fx, scores);
  git(fx.main, "init", "--quiet", "-b", "main");
  const first = commitAll(fx.main, "it: 承認済み main の初期状態");

  writeAt(fx.worktree, CTA_FILE, CTA_BEFORE);
  writeAt(fx.worktree, ".gitignore", "node_modules/\n");
  git(fx.worktree, "init", "--quiet", "-b", "main");
  commitAll(fx.worktree, "it: 作業場の初期状態");
  return first;
}

/** 偽の `pnpm lh` が出す 4 指標を変える（SEO が 1.0 未満の配信を止める確認に使う） */
export function setScores(fx: Fixture, scores: Scores): void {
  writeAt(fx.main, "frontend/verdant-virgo/it-scores.json", JSON.stringify(scores));
}

/** 偽の `pnpm lh` が受け取った環境変数の記録 */
export function buildEnvRecord(fx: Fixture): {
  names: string[];
  valueHashes: string[];
  strapiUrl: string;
  siteUrl: string;
  buildTarget: string;
  commit: string;
  strapiTokenSha256: string;
} {
  return JSON.parse(readFileSync(join(fx.main, "frontend/verdant-virgo/.lighthouse/it-env.json"), "utf8"));
}

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** 日本時間の、今日を含む週の月曜（YYYY-MM-DD）。CONTROL_CYCLE_ANCHOR にすると、今日はその周の 0〜6 日目になる */
export function mondayOfThisWeekJst(now = new Date()): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const sinceMonday = (jst.getUTCDay() + 6) % 7;
  return new Date(jst.getTime() - sinceMonday * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 日本時間の今日の年（E-13 の proposal_id の年の部分） */
export const jstYear = (now = new Date()): string => new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 4);

export interface CycleProposalOptions {
  id: string;
  kind: ProposalKind;
  state?: "draft" | "review" | "approved" | "rejected" | "applied";
  entity?: string;
  identifier: string;
  description: string;
  evidence: { auditId: string; source: string; summary: string }[];
  diffRef?: string | null;
  metric?: string;
  /** state が approved のときの承認の記録（PR の番号） */
  approvedBy?: { prNumber: number; decidedAt: string };
}

/** docs/proposals のテンプレート（docs/proposals/README.md）に沿った E-13 */
export function cycleProposalText(options: CycleProposalOptions): string {
  const { id, kind, state = "draft", entity = "E-05", identifier, description, evidence, diffRef = null, metric = "GSC-ctr", approvedBy } = options;
  const evidenceYaml = evidence
    .map((e) => `  - audit_id: ${e.auditId}\n    source: ${e.source}\n    ref: docs/audits/${e.source}/${e.auditId}.md\n    summary: ${JSON.stringify(e.summary)}`)
    .join("\n");
  return `---
proposal_id: ${id}
created_at: ${new Date().toISOString()}
created_by: agent/proposal-writer
agent_run_id: 01K6PZ3T8Q4M2N7R9S5V1W3X6Y
evidence:
${evidenceYaml}
target:
  entity: ${entity}
  identifier: ${JSON.stringify(identifier)}
  also_affects: []
change:
  kind: ${kind}
  description: ${JSON.stringify(description)}
  diff_ref: ${diffRef === null ? "null" : JSON.stringify(diffRef)}
expectation:
  metric: ${metric}
  baseline: 0.012
  target: 0.02
  judge_after: 2026-12-31
  judge_by: R3
risk:
  level: low
  description: "公開済みの内容の書き換えで、既存の流入が一時的に揺れる"
  blast_radius: "対象のページだけ"
approval:
  state: ${state}
  approver: ${approvedBy ? "R2" : "null"}
  decided_at: ${approvedBy ? approvedBy.decidedAt : "null"}
  record_ref: ${approvedBy ? JSON.stringify(`PR #${approvedBy.prNumber}`) : "null"}
applied_at: null
verification:
  state: pending
  verified_at: null
  result: null
  audit_ref: null
rollback:
  procedure: "PR を revert して配信し直す"
  reversible: true
  deadline: 2027-01-31
---

# ${description}
`;
}

/** 観測エージェントが書く E-12（docs/audits/<source>/<audit_id>.md）。correlation_id は実行の run_id（プロンプトの先頭行） */
export function auditText(options: { auditId: string; source: string; createdBy: string; correlationId: string; body: string }): string {
  return `---
audit_id: ${options.auditId}
source: ${options.source}
created_by: ${options.createdBy}
fetch:
  correlation_id: ${options.correlationId}
  outcome: success
  measured_at: ${new Date().toISOString()}
  note: null
---

${options.body}
`;
}

/** プロンプトの先頭行（CORRELATION_ID: <run_id>）から run_id を取る */
export function correlationIdOf(prompt: string): string {
  const match = /^CORRELATION_ID: ([0-9A-HJKMNP-TV-Z]{26})$/m.exec(prompt);
  if (!match) throw new Error("プロンプトに CORRELATION_ID の行が無い");
  return match[1]!;
}

type ViewItem = CycleView["items"][number];

/** 周の画面の項目を、種類と参照（sourceRef）で探す。無ければ例外 */
export function itemOf(view: CycleView, kind: ViewItem["kind"], sourceRef?: string): ViewItem {
  const item = view.items.find((candidate) => candidate.kind === kind && (sourceRef === undefined || candidate.sourceRef === sourceRef));
  if (!item) throw new Error(`周の画面に ${kind}${sourceRef ? `（${sourceRef}）` : ""} の項目が無い`);
  return item;
}

/** その項目の確認項目をすべて入れたときの id の一覧（画面でチェックボックスをすべて入れたのと同じ） */
export const allChecks = (item: ViewItem): string[] => item.checklist.map((entry) => entry.id);
