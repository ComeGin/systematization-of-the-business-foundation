// 実行系（runner・integrations・builtin・engine・scheduler・index）のテストの共有部品。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import type { ControlPlaneConfig } from "../../src/config.js";
import type { EngineContext } from "../../src/context.js";
import type { LoadedSchedules, ScheduleDefinition } from "../../src/definitions/schedules.js";
import { KvStore } from "../../src/store/kv.js";
import { LeaseStore } from "../../src/store/leases.js";
import { migrate } from "../../src/store/migrations.js";
import { MiswriteStore } from "../../src/store/miswrite.js";
import { RunStore } from "../../src/store/runs.js";

export const SAMPLE_ULID = "01K6PZ3T8Q4M2N7R9S5V1W3X6Y";

/** os.tmpdir() の下の一時ディレクトリ。テストの後で cleanup を呼ぶ。 */
export function tempDir(prefix = "cp-runner-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** root からの相対パスにファイルを置く（途中のディレクトリも作る）。 */
export function writeAt(root: string, relativePath: string, content: string): string {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  return file;
}

/** マイグレーション済みの :memory: の E-15 と、その上のストア。 */
export function memoryStores() {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  return {
    db,
    runs: new RunStore(db),
    leases: new LeaseStore(db),
    kv: new KvStore(db),
    miswrite: new MiswriteStore(db),
  };
}

export function makeConfig(overrides: Partial<ControlPlaneConfig> = {}): ControlPlaneConfig {
  return {
    dataDir: "/nonexistent/data",
    mainCheckout: "/nonexistent/main",
    worktree: "/nonexistent/worktree",
    schedulerEnabled: false,
    agentHome: null,
    anthropic: null,
    siteUrl: null,
    github: null,
    aws: null,
    miswrite: null,
    ...overrides,
  };
}

export function makeCtx(
  config: ControlPlaneConfig,
  overrides: Partial<EngineContext> = {},
): EngineContext & ReturnType<typeof memoryStores> {
  const stores = memoryStores();
  return {
    config,
    ...stores,
    loadSchedules: vi.fn(async (): Promise<LoadedSchedules> => ({ jobs: [], errors: [] })),
    copier: null,
    ...overrides,
  };
}

export function makeJob(overrides: Partial<ScheduleDefinition> = {}): ScheduleDefinition {
  return {
    id: "sample-job",
    description: "",
    enabled: true,
    cron: "0 6 * * *",
    kind: "builtin",
    agent: null,
    builtin: "silence-check",
    after: [],
    timeoutSec: 60,
    maxTurns: null,
    prompt: null,
    ...overrides,
  };
}

export interface ProposalOptions {
  id?: string;
  state?: string;
  diffRef?: string | null;
  identifier?: string;
  alsoAffects?: string[];
  createdAt?: string;
}

/** docs/proposals のテンプレートに沿った E-13 の Markdown。 */
export function proposalText(options: ProposalOptions = {}): string {
  const {
    id = "PRP-2026-0001",
    state = "draft",
    diffRef = null,
    identifier = "url_path=/",
    alsoAffects = [],
    createdAt = "2026-10-04T07:00:00+09:00",
  } = options;
  return `---
proposal_id: ${id}
created_at: ${createdAt}
created_by: agent/proposal-writer
agent_run_id: ${SAMPLE_ULID}
evidence:
  - audit_id: AUD-2026-1004-lighthouse-0001
    source: lighthouse
    ref: docs/audits/lighthouse/AUD-2026-1004-lighthouse-0001.md
    summary: "要旨"
target:
  entity: E-05
  identifier: "${identifier}"
  also_affects: ${JSON.stringify(alsoAffects)}
change:
  kind: technical_seo
  description: "変更の説明"
  diff_ref: ${diffRef === null ? "null" : JSON.stringify(diffRef)}
expectation:
  metric: LH-performance
  baseline: 0.99
  target: 1.0
  judge_after: 2026-11-03
  judge_by: R3
risk:
  level: low
  description: "悪影響"
  blast_radius: "範囲"
approval:
  state: ${state}
  approver: null
  decided_at: null
  record_ref: null
applied_at: null
verification:
  state: pending
  verified_at: null
  result: null
  audit_ref: null
rollback:
  procedure: "手順"
  reversible: true
  deadline: 2026-12-03
---

# 提案の説明
`;
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
