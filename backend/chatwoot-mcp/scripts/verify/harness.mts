/**
 * 動作確認の土台。
 *
 * MCP クライアント（@modelcontextprotocol/client）で dist/index.js を stdio で起動し、
 * 実際の Chatwoot に対してツールを呼ぶ。結果の判定・後片付け・集計をここで受け持つ。
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AccessLevel = "read_only" | "read_write" | "full";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SERVER_ENTRY = resolve(PROJECT_ROOT, "dist/index.js");

/** Chatwoot は起動直後のリクエストを Rack::Timeout（15 秒）で打ち切ることがあるため、500 は一度だけ待って再試行する */
const RETRY_DELAY_MS = 3_000;

export interface CallResult {
  text: string;
  structured: Record<string, unknown> | undefined;
  isError: boolean;
}

export class VerificationError extends Error {}

/** 判定に失敗したらその場で止める（step が捕まえて記録する） */
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new VerificationError(message);
}

export function expectOk(result: CallResult, context: string): CallResult {
  check(!result.isError, `${context}: ツールがエラーを返しました → ${result.text.split("\n")[0]}`);
  return result;
}

/** エラーになること自体を確認する（存在しない ID、不正な値など） */
export function expectError(result: CallResult, pattern: RegExp, context: string): CallResult {
  check(result.isError, `${context}: エラーになるはずが成功しました → ${result.text.slice(0, 120)}`);
  check(pattern.test(result.text), `${context}: エラー文が期待と違います（期待: ${pattern}）→ ${result.text.split("\n")[0]}`);
  return result;
}

/** structuredContent から "a.b.c" 形式で値を取り出す */
export function field(result: CallResult, path: string, context: string): unknown {
  check(result.structured !== undefined, `${context}: structuredContent がありません`);
  let current: unknown = result.structured;
  for (const key of path.split(".")) {
    check(current !== null && typeof current === "object", `${context}: ${path} をたどれません`);
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function expectField(result: CallResult, path: string, expected: unknown, context: string): void {
  const actual = field(result, path, context);
  check(actual === expected, `${context}: ${path} が ${JSON.stringify(expected)} ではなく ${JSON.stringify(actual)} です`);
}

interface Step {
  name: string;
  status: "passed" | "failed" | "skipped";
  detail?: string;
  ms: number;
}

export interface HarnessOptions {
  accessLevel: AccessLevel;
  /** true なら後片付けを行わない（作成されたデータを残して調査したいとき） */
  keep?: boolean;
  verbose?: boolean;
}

/** 起動した MCP サーバ 1 つに対する検証の実行役 */
export class Harness {
  readonly accessLevel: AccessLevel;
  readonly #client: Client;
  readonly #keep: boolean;
  readonly #verbose: boolean;
  readonly #steps: Step[] = [];
  /** 後片付け（後に作ったものから順に実行する） */
  readonly #cleanups: { name: string; run: () => Promise<void> }[] = [];

  private constructor(client: Client, options: HarnessOptions) {
    this.#client = client;
    this.accessLevel = options.accessLevel;
    this.#keep = options.keep ?? false;
    this.#verbose = options.verbose ?? false;
  }

  static async start(options: HarnessOptions): Promise<Harness> {
    return new Harness(await connect(options.accessLevel), options);
  }

  async listTools(): Promise<Tool[]> {
    const result = await this.#client.listTools();
    return result.tools;
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    let result = toCallResult(await this.#client.callTool({ name, arguments: args }));
    if (result.isError && /server error \(500\)/.test(result.text)) {
      // Chatwoot のコールドスタート（15 秒のリクエスト打ち切り）に当たった可能性があるので一度だけ待って再試行する
      await new Promise((done) => setTimeout(done, RETRY_DELAY_MS));
      result = toCallResult(await this.#client.callTool({ name, arguments: args }));
    }
    if (this.#verbose) console.log(`    → ${name}(${JSON.stringify(args)})\n${indent(result.text)}`);
    return result;
  }

  /** 1 つの確認項目。失敗しても次の項目へ進む */
  async step(name: string, run: () => Promise<void>): Promise<boolean> {
    const startedAt = Date.now();
    try {
      await run();
      this.#steps.push({ name, status: "passed", ms: Date.now() - startedAt });
      console.log(`  ✓ ${name}`);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#steps.push({ name, status: "failed", detail, ms: Date.now() - startedAt });
      console.log(`  ✗ ${name}\n      ${detail}`);
      return false;
    }
  }

  skip(name: string, reason: string): void {
    this.#steps.push({ name, status: "skipped", detail: reason, ms: 0 });
    console.log(`  - ${name}（スキップ: ${reason}）`);
  }

  /** 作成したデータの後片付けを登録する */
  defer(name: string, run: () => Promise<void>): void {
    this.#cleanups.push({ name, run });
  }

  get results(): { passed: number; failed: number; skipped: number; failures: Step[] } {
    return {
      passed: this.#steps.filter((step) => step.status === "passed").length,
      failed: this.#steps.filter((step) => step.status === "failed").length,
      skipped: this.#steps.filter((step) => step.status === "skipped").length,
      failures: this.#steps.filter((step) => step.status === "failed"),
    };
  }

  /** 後片付けを行い、MCP サーバを終了する。後片付けの失敗は残ったデータを伝えるだけで、判定には含めない */
  async close(): Promise<void> {
    if (this.#cleanups.length > 0) {
      if (this.#keep) {
        console.log(`\n  作成したデータを残します（--keep）: ${this.#cleanups.map((cleanup) => cleanup.name).join(", ")}`);
      } else {
        console.log("\n  後片付け");
        for (const cleanup of [...this.#cleanups].reverse()) {
          try {
            await cleanup.run();
            console.log(`  ✓ ${cleanup.name} を削除`);
          } catch (error) {
            console.log(`  ! ${cleanup.name} を削除できませんでした（手動で削除してください）: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
    await this.#client.close();
  }
}

/** ツールの公開範囲を確かめるために、アクセスレベルを変えて一覧だけ取る */
export async function listToolNames(accessLevel: AccessLevel): Promise<string[]> {
  const client = await connect(accessLevel);
  try {
    const { tools } = await client.listTools();
    return tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

async function connect(accessLevel: AccessLevel): Promise<Client> {
  const env: Record<string, string> = { CHATWOOT_ACCESS_LEVEL: accessLevel, TRANSPORT: "stdio" };
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] ??= value;

  const client = new Client({ name: "chatwoot-mcp-verify", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env,
      // サーバの起動ログ（stderr）は結果と混ざらないよう捨てる
      stderr: "ignore",
    }),
  );
  return client;
}

function toCallResult(result: CallToolResult): CallResult {
  const text = result.content
    .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
    .join("\n");
  return { text, structured: result.structuredContent as Record<string, unknown> | undefined, isError: result.isError === true };
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");
}
