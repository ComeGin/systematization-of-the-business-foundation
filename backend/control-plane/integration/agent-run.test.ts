// 結合テスト: エージェントの起動（runNow → エンジン → main のエージェント定義・MCP の登録表 → Agent SDK → E-15 → S3 への写し）。
// Agent SDK（@anthropic-ai/claude-agent-sdk の query）は差し替え、claude の子プロセス・Anthropic の API・MCP サーバーは起動しない。
// 差し替えた query が受け取った options（env・フック・mcpServers）は本物の組み立ての結果なので、そのまま検査する。
// PreToolUse のフックは、差し替えた query の中から SDK と同じ形で呼び、書き込みの拒否リスト（constants/write-denylist.ts）を確かめる。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneInputError } from "../src/index.js";
import { ULID_PATTERN } from "../src/ulid.js";
import { putObjects, resetAws } from "./helpers/aws-mock.js";
import { callPreToolUse, init, lastQuery, resetSdk, result, script, sdk, toolResult, toolUse } from "./helpers/agent-sdk.js";
import {
  CHATWOOT_REGISTRY,
  DUMMY_ANTHROPIC_KEY,
  type Fixture,
  PROPOSALS_DIR,
  Planes,
  W_DIR,
  captureLogs,
  createFixture,
  e15Bytes,
  waitFinished,
  writeAgent,
  writeAt,
  writeRegistry,
  writeSchedule,
} from "./helpers/fixtures.js";
import { GITHUB_TOKEN, githubEnv } from "./helpers/fake-github.js";

vi.mock("@aws-sdk/client-s3", () => import("./helpers/aws-mock.js").then((m) => m.s3Module));
vi.mock("@aws-sdk/client-cloudwatch", () => import("./helpers/aws-mock.js").then((m) => m.cloudWatchModule));
vi.mock("@anthropic-ai/claude-agent-sdk", () => import("./helpers/agent-sdk.js").then((m) => m.sdkModule));

const AWS_ENV = { AWS_REGION: "ap-northeast-1", RUNLOG_BUCKET: "it-comegin-runlog" };
const TRIAGE_TOOLS = ["Read", "Write", "mcp__chatwoot__chatwoot_list_conversations", "mcp__chatwoot__chatwoot_add_private_note"];
/** ツールの結果にだけ現れる値。E-15・S3 の写し・ログのどこにも残ってはいけない */
const TOOL_RESULT_MARKER = "IT-TOOL-RESULT-MARKER-7f3a";
const CUSTOMER_EMAIL = "it-customer-7f3a@example.com";

let fx: Fixture;
let planes: Planes;
let logs: () => string;

beforeEach(() => {
  fx = createFixture("cp-it-agent-");
  planes = new Planes();
  logs = captureLogs();
  resetAws();
  resetSdk();
  writeAgent(fx, "conversation-triage", TRIAGE_TOOLS);
  writeAgent(fx, "seo-auditor", ["Read", "Write", "Glob"]);
  writeRegistry(fx, CHATWOOT_REGISTRY);
});

afterEach(async () => {
  await planes.stopAll();
  fx.cleanup();
});

const agentEnv = (extra: Record<string, string> = {}) => fx.env({ ANTHROPIC_API_KEY: DUMMY_ANTHROPIC_KEY, ...extra });

describe("エージェントの起動と E-15 の記録", () => {
  describe("正常系", () => {
    it("相関 ID を先頭行で渡し、要約・対象の ID・成否・費用だけを E-15 と S3 の写しに残す（ツールの結果と個人情報は残さない）", async () => {
      script([
        init({ tools: ["Read", "Write"], mcp_servers: [{ name: "chatwoot", status: "connected" }] }),
        toolUse("mcp__chatwoot__chatwoot_add_private_note", { conversation_id: 4321, content: "社内メモ" }),
        toolResult(`{"id": 1, "content": "${TOOL_RESULT_MARKER}", "email": "${CUSTOMER_EMAIL}"}`),
        result(`SUMMARY: 未解決 3 件を切り分けた。連絡先 ${CUSTOMER_EMAIL} 090-1234-5678\nTARGET_IDS: chatwoot-conversation:77, ${CUSTOMER_EMAIL}`),
      ]);
      const plane = planes.create(agentEnv({ ...AWS_ENV, ...githubEnv() }));
      const accepted = await plane.runNow({ target: { kind: "agent", agent: "conversation-triage", prompt: "未解決の会話を切り分ける" } });
      expect(accepted.accepted).toBe(true);
      expect(accepted.runId).toMatch(ULID_PATTERN);
      const run = await waitFinished(plane, accepted.runId);

      expect(run).toMatchObject({
        agentName: "conversation-triage",
        jobId: null,
        builtin: null,
        trigger: "manual",
        outcome: "success",
        summary: "未解決 3 件を切り分けた。連絡先 [redacted:email] [redacted:phone]",
        summaryRedacted: true,
        sdkSubtype: "success",
        costUsd: 0.12,
        failureClass: null,
      });
      // TARGET_IDS 行のメールアドレスは落とし、tool_use の引数の conversation_id を足す（結果は読まない）
      expect(run.targetIds.sort()).toEqual(["chatwoot-conversation:4321", "chatwoot-conversation:77"]);

      // プロンプトの先頭 3 行（CORRELATION_ID・NOW・TODAY）は E-15 の runId・startedAt と同じ
      const { prompt } = lastQuery();
      const lines = prompt.split("\n");
      expect(lines[0]).toBe(`CORRELATION_ID: ${run.runId}`);
      expect(lines[1]).toBe(`NOW: ${run.startedAt.replace(/\.\d+(?=\+09:00$)/, "")}`);
      expect(lines[2]).toBe(`TODAY: ${run.startedAt.slice(0, 10)}`);
      expect(prompt.endsWith("未解決の会話を切り分ける")).toBe(true);

      // E-15（SQLite のファイル）・S3 の写し・ログのどこにもツールの結果と個人情報が無い
      const [put] = await vi.waitFor(() => {
        const puts = putObjects();
        expect(puts).toHaveLength(1);
        return puts;
      });
      for (const text of [e15Bytes(fx), String(put!.Body), logs()]) {
        expect(text).not.toContain(TOOL_RESULT_MARKER);
        expect(text).not.toContain(CUSTOMER_EMAIL);
        expect(text).not.toContain("090-1234-5678");
      }
    });

    it("SDK に渡す設定: env は PATH・HOME・ANTHROPIC_API_KEY だけで、GitHub などの秘密値を渡さない。MCP はそのエージェントの分だけ", async () => {
      script([init(), result("SUMMARY: 完了")]);
      const plane = planes.create(agentEnv({ ...githubEnv(), ...AWS_ENV }));
      const { runId } = await plane.runNow({ target: { kind: "agent", agent: "conversation-triage", prompt: "p" } });
      await waitFinished(plane, runId);

      const { options } = lastQuery();
      expect(Object.keys(options.env ?? {}).sort()).toEqual(["ANTHROPIC_API_KEY", "HOME", "PATH"]);
      expect(options.env?.ANTHROPIC_API_KEY).toBe(DUMMY_ANTHROPIC_KEY);
      expect(JSON.stringify(options)).not.toContain(GITHUB_TOKEN);
      expect(options).toMatchObject({
        cwd: fx.worktree,
        settingSources: [],
        strictMcpConfig: true,
        permissionMode: "dontAsk",
        persistSession: false,
        tools: ["Read", "Write"],
        allowedTools: TRIAGE_TOOLS,
      });
      expect(options.disallowedTools).toEqual(expect.arrayContaining(["Bash", "PowerShell"]));
      // 登録表の chatwoot だけ。env は PATH・HOME と登録表の env_vars（秘密でない定数）だけ
      expect(Object.keys(options.mcpServers ?? {})).toEqual(["chatwoot"]);
      const chatwoot = options.mcpServers!.chatwoot as { type: string; command: string; args: string[]; env: Record<string, string> };
      expect(chatwoot).toMatchObject({ type: "stdio", command: "node", env: { TRANSPORT: "stdio", CHATWOOT_ACCESS_LEVEL: "read_write" } });
      expect(Object.keys(chatwoot.env).sort()).toEqual(["CHATWOOT_ACCESS_LEVEL", "HOME", "PATH", "TRANSPORT"]);
      expect(chatwoot.args[0]).toMatch(/^--env-file-if-exists=\/.+\/\.config\/comegin\/mcp\/chatwoot-dev\.env$/);
    });

    it("PreToolUse のフック: 作業ツリーの docs/audits への書き込みは通し、拒否リストの場所（package.json・ops・.claude・.env・dev/*.sh）と外は拒否する", async () => {
      const decisions: Record<string, string> = {};
      const decide = (label: string, tool: string, path: string) => async (options: Parameters<typeof callPreToolUse>[0]) => {
        const output = await callPreToolUse(options, tool, { file_path: path, content: "x" });
        const specific = (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput;
        decisions[label] = specific?.permissionDecision ?? "allow";
      };
      script([
        init(),
        decide("audit", "Write", join(fx.worktree, W_DIR, "docs/audits/gsc/AUD-2026-1007-gsc-0001.md")),
        decide("packageJson", "Write", join(fx.worktree, W_DIR, "frontend/verdant-virgo/package.json")),
        decide("schedule", "Edit", join(fx.worktree, W_DIR, "ops/schedules/daily-propose.yaml")),
        decide("agentDef", "Write", join(fx.worktree, ".claude/agents/seo-auditor.md")),
        decide("envFile", "Read", join(fx.worktree, W_DIR, "backend/strapi-system/.env")),
        decide("devScript", "Write", join(fx.worktree, W_DIR, "middleware/n8n/dev/init-env.sh")),
        decide("mainCheckout", "Read", join(fx.main, ".claude/agents/seo-auditor.md")),
        decide("dataDir", "Read", join(fx.dataDir, "e15.sqlite")),
        result("SUMMARY: 監査を書いた"),
      ]);
      const plane = planes.create(agentEnv());
      const { runId } = await plane.runNow({ target: { kind: "agent", agent: "seo-auditor", prompt: "p" } });
      expect(await waitFinished(plane, runId)).toMatchObject({ outcome: "success" });
      expect(decisions).toEqual({
        audit: "allow",
        packageJson: "deny",
        schedule: "deny",
        agentDef: "deny",
        envFile: "deny",
        devScript: "deny",
        mainCheckout: "deny",
        dataDir: "deny",
      });
      expect(logs()).toContain("ツール呼び出しを拒否した: Write: package and build configuration cannot be written");
    });

    it("定期実行の定義（kind=agent）から起動すると、定義の prompt と jobId を使う", async () => {
      writeSchedule(fx, "it-observe-seo", 'enabled: false\ncron: "0 6 * * *"\nkind: agent\nagent: seo-auditor\nprompt: "定義のプロンプト"\ntimeout_sec: 60\nmax_turns: 5\n');
      script([init(), result("SUMMARY: 監査を書いた\nTARGET_IDS: AUD-2026-1007-gsc-0001")]);
      const plane = planes.create(agentEnv());
      const { runId } = await plane.runNow({ target: { kind: "job", jobId: "it-observe-seo" } });
      expect(await waitFinished(plane, runId)).toMatchObject({
        jobId: "it-observe-seo",
        agentName: "seo-auditor",
        outcome: "success",
        targetIds: ["AUD-2026-1007-gsc-0001"],
      });
      expect(lastQuery().prompt.endsWith("定義のプロンプト")).toBe(true);
      expect(lastQuery().options.maxTurns).toBe(5);
    });

    it("proposal-writer が success でも E-13 が増えていなければ skipped（理由は要約）として残す", async () => {
      writeAgent(fx, "proposal-writer", ["Read", "Glob", "Write"]);
      script([init(), result("SUMMARY: 起票前チェック 3 で止めた")]);
      const plane = planes.create(agentEnv());
      const { runId } = await plane.runNow({ target: { kind: "agent", agent: "proposal-writer", prompt: "p" } });
      expect(await waitFinished(plane, runId)).toMatchObject({ outcome: "skipped", skipReason: "起票前チェック 3 で止めた" });
    });

    it("proposal-writer が E-13 を 1 件書けば success のまま", async () => {
      writeAgent(fx, "proposal-writer", ["Read", "Glob", "Write"]);
      script([
        init(),
        async () => {
          writeAt(fx.worktree, `${PROPOSALS_DIR}/PRP-2026-0099.md`, "---\nproposal_id: PRP-2026-0099\n---\n");
        },
        result("SUMMARY: E-13 を 1 件起票した\nTARGET_IDS: PRP-2026-0099"),
      ]);
      const plane = planes.create(agentEnv());
      const { runId } = await plane.runNow({ target: { kind: "agent", agent: "proposal-writer", prompt: "p" } });
      expect(await waitFinished(plane, runId)).toMatchObject({ outcome: "success", targetIds: ["PRP-2026-0099"] });
    });
  });

  describe("異常系", () => {
    it("入力: main に無いエージェントは SDK を起動せずに skipped（理由にエージェント名）", async () => {
      const plane = planes.create(agentEnv());
      const accepted = await plane.runNow({ target: { kind: "agent", agent: "it-no-such-agent", prompt: "p" } });
      expect(accepted.accepted).toBe(false);
      expect(await plane.getRun(accepted.runId)).toMatchObject({
        outcome: "skipped",
        skipReason: "エージェント定義が見つからない: it-no-such-agent",
      });
      expect(sdk.query).not.toHaveBeenCalled();
    });

    it("入力: 作業ツリーにだけあるエージェント定義では起動しない（main から読む。ADR-18）", async () => {
      writeAt(fx.worktree, ".claude/agents/it-unapproved.md", "---\nname: it-unapproved\ntools: Read\n---\n本文\n");
      const plane = planes.create(agentEnv());
      const accepted = await plane.runNow({ target: { kind: "agent", agent: "it-unapproved", prompt: "p" } });
      expect(await plane.getRun(accepted.runId)).toMatchObject({ outcome: "skipped" });
      expect(sdk.query).not.toHaveBeenCalled();
    });

    it("入力: 定義の tools に Bash があれば起動せずに failure（invalid_response）", async () => {
      writeAgent(fx, "seo-auditor", ["Read", "Bash(git log:*)"]);
      const plane = planes.create(agentEnv());
      const { runId } = await plane.runNow({ target: { kind: "agent", agent: "seo-auditor", prompt: "p" } });
      expect(await waitFinished(plane, runId)).toMatchObject({
        outcome: "failure",
        failureClass: "invalid_response",
        summary: "エージェント定義に Bash 系のツールが含まれるため起動しなかった",
      });
      expect(sdk.query).not.toHaveBeenCalled();
    });

    it("入力: 定義の MCP が登録表に無ければ起動せずに failure（invalid_response。理由に登録名だけ）", async () => {
      writeAgent(fx, "seo-auditor", ["Read", "mcp__openseo__whoami"]);
      const plane = planes.create(agentEnv());
      const { runId } = await plane.runNow({ target: { kind: "agent", agent: "seo-auditor", prompt: "p" } });
      expect(await waitFinished(plane, runId)).toMatchObject({
        outcome: "failure",
        failureClass: "invalid_response",
        summary: "MCP の設定が不正のため起動しなかった（MCP の登録表に無い名前: openseo）",
      });
      expect(sdk.query).not.toHaveBeenCalled();
    });

    // 登録表の env_vars に秘密値のキー名（*_TOKEN・*_KEY など）があれば読み込みで拒否する。
    // 拒否は McpSetupError ではなく通常の例外なので、エンジンの「内部エラー」として failure（failureClass は null）になる
    it("入力: MCP の登録表の env_vars に秘密値のキー名があれば、SDK を起動せずに failure", async () => {
      writeRegistry(fx, CHATWOOT_REGISTRY.replace("      TRANSPORT: stdio\n", "      TRANSPORT: stdio\n      CHATWOOT_API_ACCESS_TOKEN: it-secret-in-registry\n"));
      const plane = planes.create(agentEnv());
      const { runId } = await plane.runNow({ target: { kind: "agent", agent: "conversation-triage", prompt: "p" } });
      expect(await waitFinished(plane, runId)).toMatchObject({ outcome: "failure", summary: "実行中に内部エラーが発生した" });
      expect(sdk.query).not.toHaveBeenCalled();
      expect(e15Bytes(fx)).not.toContain("it-secret-in-registry");
      expect(logs()).toContain("秘密値は登録表に書かない");
      expect(logs()).not.toContain("it-secret-in-registry");
    });

    it("入力: init の apiKeySource が ANTHROPIC_API_KEY でなければ打ち切って failure（auth_failed）", async () => {
      script([init({ apiKeySource: "user" }), result("SUMMARY: 走ってはいけない")]);
      const plane = planes.create(agentEnv());
      const { runId } = await plane.runNow({ target: { kind: "agent", agent: "seo-auditor", prompt: "p" } });
      expect(await waitFinished(plane, runId)).toMatchObject({ outcome: "failure", failureClass: "auth_failed" });
    });

    it("入力: 前回が実行中なら、同じ定義の起動を見送って skipped を記録する", async () => {
      writeSchedule(fx, "it-observe-seo", 'enabled: false\ncron: "0 6 * * *"\nkind: agent\nagent: seo-auditor\nprompt: "p"\ntimeout_sec: 30\n');
      script([init()], { hang: true });
      const plane = planes.create(agentEnv());
      await plane.start();
      const first = await plane.runNow({ target: { kind: "job", jobId: "it-observe-seo" } });
      const second = await plane.runNow({ target: { kind: "job", jobId: "it-observe-seo" } });
      expect([first.accepted, second.accepted]).toEqual([true, false]);
      expect(await plane.getRun(second.runId)).toMatchObject({ outcome: "skipped", skipReason: "前回の実行が継続中のため起動を見送った" });
      await plane.stop();
      expect(await plane.getRun(first.runId)).toMatchObject({ outcome: "failure", failureClass: "timeout", summary: "停止要求で中断した" });
    });

    // 回帰: stop() が started のときだけ動いていたため、start() の前に runNow で起動した実行は打ち切られず running のまま残った
    it("サーバ: start() の前に runNow で起動した実行も、stop() で打ち切られて failure（timeout）になる", async () => {
      script([init()], { hang: true });
      const plane = planes.create(agentEnv());
      const { runId } = await plane.runNow({ target: { kind: "agent", agent: "seo-auditor", prompt: "p" } });
      await vi.waitFor(() => expect(sdk.query).toHaveBeenCalled());
      await plane.stop();
      expect(await plane.getRun(runId)).toMatchObject({
        status: "finished",
        outcome: "failure",
        failureClass: "timeout",
        summary: "停止要求で中断した",
      });
    });

    it("空入力: ANTHROPIC_API_KEY が無ければ SDK を起動せずに skipped（理由は変数名だけ）", async () => {
      const plane = planes.create(fx.env());
      const accepted = await plane.runNow({ target: { kind: "agent", agent: "seo-auditor", prompt: "p" } });
      expect(await plane.getRun(accepted.runId)).toMatchObject({ outcome: "skipped", skipReason: "設定が無いため見送った（ANTHROPIC_API_KEY）" });
      expect(sdk.query).not.toHaveBeenCalled();
    });

    it("空入力: プロンプトが空白だけなら ControlPlaneInputError で、E-15 に記録しない", async () => {
      const plane = planes.create(agentEnv());
      await expect(plane.runNow({ target: { kind: "agent", agent: "seo-auditor", prompt: " \n " } })).rejects.toBeInstanceOf(ControlPlaneInputError);
      expect(await plane.listRuns()).toEqual([]);
    });

    it("サーバ: SDK が結果を返す前に例外なら failure（unreachable）で、例外の本文を E-15 に残さない", async () => {
      script([init()], { throwAfter: new Error(`API overloaded for ${CUSTOMER_EMAIL}`) });
      const plane = planes.create(agentEnv());
      const { runId } = await plane.runNow({ target: { kind: "agent", agent: "seo-auditor", prompt: "p" } });
      expect(await waitFinished(plane, runId)).toMatchObject({
        outcome: "failure",
        failureClass: "unreachable",
        summary: "Agent SDK が結果を返さなかった",
      });
      expect(e15Bytes(fx)).not.toContain(CUSTOMER_EMAIL);
      expect(logs()).not.toContain(CUSTOMER_EMAIL);
    });

    it("サーバ: 定義の timeout_sec を過ぎたら打ち切って failure（timeout）", async () => {
      writeSchedule(fx, "it-slow", 'enabled: false\ncron: "0 6 * * *"\nkind: agent\nagent: seo-auditor\nprompt: "p"\ntimeout_sec: 1\n');
      script([init()], { hang: true });
      const plane = planes.create(agentEnv());
      const { runId } = await plane.runNow({ target: { kind: "job", jobId: "it-slow" } });
      expect(await waitFinished(plane, runId, 10_000)).toMatchObject({
        outcome: "failure",
        failureClass: "timeout",
        summary: "タイムアウトで打ち切った",
      });
    });

    it.each([
      [429, "rate_limited"],
      [529, "unreachable"],
      [401, "auth_failed"],
    ])("サーバ: 最後の API 呼び出しが %i で失敗した結果は failure（%s）", async (status, failureClass) => {
      script([init(), result("SUMMARY: 途中まで", { is_error: true, api_error_status: status })]);
      const plane = planes.create(agentEnv());
      const { runId } = await plane.runNow({ target: { kind: "agent", agent: "seo-auditor", prompt: "p" } });
      expect(await waitFinished(plane, runId)).toMatchObject({ outcome: "failure", failureClass });
    });

    it("サーバ: init で MCP の接続が failed なら打ち切って failure（unreachable）", async () => {
      script([init({ mcp_servers: [{ name: "chatwoot", status: "failed" }] }), result("SUMMARY: 走ってはいけない")]);
      const plane = planes.create(agentEnv());
      const { runId } = await plane.runNow({ target: { kind: "agent", agent: "conversation-triage", prompt: "p" } });
      expect(await waitFinished(plane, runId)).toMatchObject({
        outcome: "failure",
        failureClass: "unreachable",
        summary: "起動時の検査で打ち切った（MCP に接続できない: chatwoot）",
      });
    });
  });
});
