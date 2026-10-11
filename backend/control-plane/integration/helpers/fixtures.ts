// 結合テストの土台。一時ディレクトリに「承認済み main のチェックアウト」「作業ツリー」「CONTROL_DATA_DIR」を作り、
// 公開の入口（createControlPlane）に環境変数として渡す。next-js と同じ使い方で、src の内部には触れない。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import { type ControlPlane, createControlPlane } from "../../src/index.js";
import type { RunRecord } from "../../src/contract.js";
import { type ProposalOptions, proposalText, tempDir, writeAt } from "../../tests/helpers/runner.js";

export const W_DIR = "MarketingDepartment/WebsiteOperations";
export const SCHEDULES_DIR = `${W_DIR}/ops/schedules`;
export const REGISTRY_FILE = `${W_DIR}/ops/mcp-registry.yaml`;
export const PROPOSALS_DIR = `${W_DIR}/docs/proposals`;
export const AUDITS_DIR = `${W_DIR}/docs/audits`;
export const N8N_WORKFLOWS_DIR = `${W_DIR}/middleware/n8n/workflows`;

/** エージェントに渡すだけの値（Agent SDK はモックなので、どこにも送られない） */
export const DUMMY_ANTHROPIC_KEY = "sk-ant-it-dummy-key-0000000000";

export interface Fixture {
  root: string;
  main: string;
  worktree: string;
  dataDir: string;
  /** 中核の 3 変数に extra を足した環境変数（process.env は混ぜない） */
  env(extra?: Record<string, string>): NodeJS.ProcessEnv;
  cleanup(): void;
}

export function createFixture(prefix = "cp-it-"): Fixture {
  const { dir, cleanup } = tempDir(prefix);
  const main = join(dir, "main");
  const worktree = join(dir, "wt");
  const dataDir = join(dir, "data");
  writeAt(worktree, ".keep", "");
  writeAt(main, ".keep", "");
  return {
    root: dir,
    main,
    worktree,
    dataDir,
    env: (extra = {}) => ({ CONTROL_DATA_DIR: dataDir, CONTROL_MAIN_CHECKOUT: main, CONTROL_WORKTREE: worktree, ...extra }),
    cleanup,
  };
}

/** main の ops/schedules/<id>.yaml。body は id 以外の行 */
export function writeSchedule(fx: Fixture, id: string, body: string): void {
  writeAt(fx.main, `${SCHEDULES_DIR}/${id}.yaml`, `id: ${id}\n${body}`);
}

/** main の .claude/agents/<name>.md（Claude Code のサブエージェント形式） */
export function writeAgent(fx: Fixture, name: string, tools: string[], body = "エージェント定義の本文"): void {
  writeAt(fx.main, `.claude/agents/${name}.md`, `---\nname: ${name}\ndescription: 結合テストの定義\ntools: ${tools.join(", ")}\n---\n${body}\n`);
}

export function writeRegistry(fx: Fixture, yaml: string): void {
  writeAt(fx.main, REGISTRY_FILE, yaml);
}

/** chatwoot（stdio）だけを載せた登録表。args の相対パスは main から解決される */
export const CHATWOOT_REGISTRY = `version: 1
servers:
  - name: chatwoot
    env: dev
    transport: stdio
    command: node
    args:
      - "--env-file-if-exists=\${HOME}/.config/comegin/mcp/chatwoot-dev.env"
      - "${W_DIR}/backend/chatwoot-mcp/dist/index.js"
    env_vars:
      TRANSPORT: stdio
      CHATWOOT_ACCESS_LEVEL: read_write
`;

export function writeProposal(fx: Fixture, where: "main" | "worktree", options: ProposalOptions = {}): string {
  const id = options.id ?? "PRP-2026-0001";
  return writeAt(where === "main" ? fx.main : fx.worktree, `${PROPOSALS_DIR}/${id}.md`, proposalText(options));
}

export function readProposal(fx: Fixture, id = "PRP-2026-0001"): string {
  return readFileSync(join(fx.worktree, PROPOSALS_DIR, `${id}.md`), "utf8");
}

/** 作ったプレーンを afterEach で止めるための入れ物 */
export class Planes {
  readonly #planes: ControlPlane[] = [];

  create(env: NodeJS.ProcessEnv): ControlPlane {
    const plane = createControlPlane({ env });
    this.#planes.push(plane);
    return plane;
  }

  async stopAll(): Promise<void> {
    for (const plane of this.#planes.splice(0)) await plane.stop();
  }
}

/** run が確定するまで待つ（手動の起動は完了を待たずに返るため） */
export async function waitFinished(plane: ControlPlane, runId: string, timeoutMs = 20_000): Promise<RunRecord> {
  return vi.waitFor(
    async () => {
      const run = await plane.getRun(runId);
      if (run?.status !== "finished") throw new Error(`run がまだ確定していない: ${run?.status ?? "無い"}`);
      return run;
    },
    { timeout: timeoutMs, interval: 100 },
  );
}

/** console.error（control-plane のログは stderr だけ）を黙らせて、出た行を後から読めるようにする */
export function captureLogs(): () => string {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return () => spy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
}

/** E-15 の SQLite（WAL を含む）のバイト列を文字列として読む。残してはいけない値が無いことの確認に使う */
export function e15Bytes(fx: Fixture): string {
  return readdirSync(fx.dataDir)
    .filter((name) => name.startsWith("e15.sqlite"))
    .map((name) => readFileSync(join(fx.dataDir, name)).toString("latin1"))
    .join("\n");
}

/** 日本時間の今日の YYYY-MM-DD と、AUD-<西暦>-<月日> の日付部分 */
export function jstToday(now = new Date()): { date: string; auditKey: string; minutes: number } {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const date = jst.toISOString().slice(0, 10);
  return { date, auditKey: `${date.slice(0, 4)}-${date.slice(5, 7)}${date.slice(8, 10)}`, minutes: jst.getUTCHours() * 60 + jst.getUTCMinutes() };
}

export { writeAt };
