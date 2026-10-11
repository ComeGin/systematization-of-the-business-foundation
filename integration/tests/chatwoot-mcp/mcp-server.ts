// 自作 MCP サーバ（backend/chatwoot-mcp・backend/mautic-mcp）を、ビルド済みの dist/index.js から子プロセスで起動する。
// chatwoot-mcp と mautic-mcp の両方のスイート（担当 B）が使う。
//
// - stdio は MCP SDK v2 の Client と StdioClientTransport で繋ぐ（エージェントと同じ経路。I-03・I-04）
// - HTTP は空いているポートで起動し、StreamableHTTPClientTransport で Bearer（MCP_AUTH_TOKEN）を付けて繋ぐ
// - 設定の不備で終了するかを見るときは、MCP で繋がずに終了コードと stderr だけを集める
//
// 子プロセスの env は「渡したものだけ」にする（このプロセスの環境変数を混ぜない。PATH・HOME は SDK の既定と同じく引き継ぐ）。
// stderr は秘密値を含みうるので、テストの失敗の文にそのまま出さない（呼び出し側で redact する）。
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export type McpName = "chatwoot" | "mautic";
export type AccessLevel = "read_only" | "read_write" | "full";

/** backend（このファイルは integration/tests/chatwoot-mcp にある） */
const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), "../../../backend");

export const serverEntry = (name: McpName): string => join(BACKEND, `${name}-mcp`, "dist/index.js");

/** ACCESS_LEVEL の環境変数の名前はサーバごとに違う */
export const accessLevelKey = (name: McpName): string => (name === "chatwoot" ? "CHATWOOT_ACCESS_LEVEL" : "MAUTIC_ACCESS_LEVEL");

/** テストで使う MCP_AUTH_TOKEN（48 文字。32 文字以上の条件を満たす） */
export const newAuthToken = (): string => randomBytes(24).toString("hex");

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME"]) if (process.env[key]) env[key] = process.env[key]!;
  return env;
}

export interface StdioSession {
  client: Client;
  /** これまでに受け取った stderr（起動ログなど） */
  stderr(): string;
  close(): Promise<void>;
}

/** stdio で起動して MCP の初期化まで済ませる */
export async function startStdio(name: McpName, env: Record<string, string>): Promise<StdioSession> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry(name)], env: { ...env, TRANSPORT: "stdio" }, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const client = new Client({ name: `it-${name}-mcp`, version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr, close: () => client.close() };
}

export interface HttpServerProcess {
  url: string;
  token: string;
  stderr(): string;
  /** Bearer を付けた MCP クライアントで繋ぐ（token を省略すると正しいトークン） */
  connect(token?: string): Promise<Client>;
  close(): Promise<void>;
}

/** 空いているポート（0 で待ち受けて OS に選ばせ、すぐ閉じる） */
export async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

/** HTTP（Streamable HTTP）で起動し、「listening」が stderr に出るまで待つ */
export async function startHttp(name: McpName, env: Record<string, string>): Promise<HttpServerProcess> {
  const port = await freePort();
  const token = newAuthToken();
  const child = spawn(process.execPath, [serverEntry(name)], {
    env: { ...baseEnv(), ...env, TRANSPORT: "http", HOST: "127.0.0.1", PORT: String(port), MCP_AUTH_TOKEN: token },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`${name}-mcp が 15 秒以内に待ち受けを始めなかった`)), 15_000);
    const check = () => {
      if (stderr.includes("listening on")) {
        clearTimeout(timer);
        done();
      }
    };
    child.stderr!.on("data", check);
    child.once("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`${name}-mcp が待ち受けの前に終了した（終了コード ${code}）`));
    });
  });

  const url = `http://127.0.0.1:${port}/mcp`;
  const clients: Client[] = [];
  return {
    url,
    token,
    stderr: () => stderr,
    async connect(bearer = token) {
      const client = new Client({ name: `it-${name}-mcp-http`, version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
      clients.push(client);
      return client;
    },
    async close() {
      await Promise.allSettled(clients.map((c) => c.close()));
      await stop(child);
    },
  };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    child.kill("SIGTERM");
  });
}

export interface ExitResult {
  /** 終了コード。timeoutMs までに終わらなければ undefined（プロセスは止める） */
  code: number | null | undefined;
  stderr: string;
  stdout: string;
}

/**
 * MCP で繋がずに起動し、終了するまで待つ（設定の不備で exit(1) するかを見る）。
 * stdin は開いたままにする（stdio のサーバが入力の終わりで正常終了しないように）
 */
export async function runUntilExit(name: McpName, env: Record<string, string>, timeoutMs = 10_000): Promise<ExitResult> {
  const child = spawn(process.execPath, [serverEntry(name)], { env: { ...baseEnv(), ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let stdout = "";
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  const code = await new Promise<number | null | undefined>((done) => {
    const timer = setTimeout(() => done(undefined), timeoutMs);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      done(exitCode);
    });
  });
  if (code === undefined) await stop(child);
  return { code, stderr, stdout };
}

/** ツールの結果の本文（text の部分をつなげたもの） */
export function textOf(result: CallToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
}

/** structuredContent を型付きで取り出す（無ければ例外） */
export function structuredOf<T = Record<string, unknown>>(result: CallToolResult): T {
  if (!result.structuredContent) throw new Error(`structuredContent が無い: ${textOf(result).slice(0, 200)}`);
  return result.structuredContent as T;
}

/** 本文に秘密値が 1 つでも含まれるか（どれが含まれたかは返さない。テストの失敗の文に値を出さないため） */
export const containsAnySecret = (text: string, secrets: string[]): boolean => secrets.some((s) => s.length >= 4 && text.includes(s));
