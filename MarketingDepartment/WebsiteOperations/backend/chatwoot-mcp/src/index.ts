#!/usr/bin/env node
/**
 * Chatwoot MCP サーバ（Application API）
 *
 * 認証:
 *   - 本サーバ → Chatwoot: ユーザーのアクセストークン（api_access_token ヘッダー）。権限はそのユーザーのロールで決まる
 *   - MCP クライアント → 本サーバ: stdio では不要。HTTP のときだけ固定 Bearer トークン（MCP_AUTH_TOKEN）
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { loadConfig, type Config } from "./config.js";
import { SERVER_NAME, SERVER_VERSION, STATIC_TOKEN_TTL_SEC } from "./constants.js";
import { ChatwootClient } from "./services/chatwoot-client.js";
import { TimeZone } from "./services/time.js";
import { registerAccountTools } from "./tools/account.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerConversationTools } from "./tools/conversations.js";
import { registerRecordTools } from "./tools/records.js";
import { registerRelatedTools } from "./tools/related.js";
import { registerReportTools } from "./tools/reports.js";
import { registerContactWriteTools } from "./tools/write-contacts.js";
import { registerConversationWriteTools } from "./tools/write-conversations.js";
import { registerRecordWriteTools } from "./tools/write-records.js";
import type { ToolContext } from "./types.js";

const config = loadConfig();

const ctx: ToolContext = {
  client: new ChatwootClient({
    baseUrl: config.CHATWOOT_BASE_URL,
    accessToken: config.CHATWOOT_API_ACCESS_TOKEN,
    accountId: config.CHATWOOT_ACCOUNT_ID,
  }),
  tz: new TimeZone(config.CHATWOOT_TIMEZONE_OFFSET),
};

function buildServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerAccountTools(server, ctx, config.CHATWOOT_ACCESS_LEVEL);
  registerConversationTools(server, ctx);
  registerContactTools(server, ctx);
  registerRecordTools(server, ctx);
  registerRelatedTools(server, ctx);
  registerReportTools(server, ctx);
  // CHATWOOT_ACCESS_LEVEL で許可された書き込みツールだけを登録する（read_only なら何も登録しない）
  registerConversationWriteTools(server, ctx, config.CHATWOOT_ACCESS_LEVEL);
  registerContactWriteTools(server, ctx, config.CHATWOOT_ACCESS_LEVEL);
  registerRecordWriteTools(server, ctx, config.CHATWOOT_ACCESS_LEVEL);
  return server;
}

const startupInfo = `Chatwoot: ${config.CHATWOOT_BASE_URL} account ${config.CHATWOOT_ACCOUNT_ID}, access: ${config.CHATWOOT_ACCESS_LEVEL}`;

async function runStdio(): Promise<void> {
  await buildServer().connect(new StdioServerTransport());
  // stdout は MCP の通信に使うため、ログは stderr に出す
  console.error(`[${SERVER_NAME}] running on stdio (${startupInfo})`);
}

async function runHttp(config: Config & { MCP_AUTH_TOKEN: string }): Promise<void> {
  // HTTP 用の依存は stdio では読み込まない（起動を軽くする）
  const { createMcpExpressApp, requireBearerAuth } = await import("@modelcontextprotocol/express");
  const { toNodeHandler } = await import("@modelcontextprotocol/node");
  const { createMcpHandler, OAuthError, OAuthErrorCode } = await import("@modelcontextprotocol/server");

  // 長さの違いで比較時間が変わらないよう、ハッシュ同士を定数時間で比較する
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expectedDigest = digest(config.MCP_AUTH_TOKEN);
  const verifier = {
    async verifyAccessToken(token: string) {
      if (!timingSafeEqual(digest(token), expectedDigest)) throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid token");
      return { token, clientId: "mcp-client", scopes: [], expiresAt: Math.floor(Date.now() / 1000) + STATIC_TOKEN_TTL_SEC };
    },
  };

  const handler = createMcpHandler(buildServer);
  const app = createMcpExpressApp({ host: config.HOST, allowedHosts: config.MCP_ALLOWED_HOSTS });
  const node = toNodeHandler(handler);
  app.all("/mcp", requireBearerAuth({ verifier }), (req, res) => void node(req, res, req.body));

  const httpServer = app.listen(config.PORT, config.HOST, () => {
    console.error(`[${SERVER_NAME}] listening on http://${config.HOST}:${config.PORT}/mcp (${startupInfo})`);
  });
  const shutdown = async () => {
    await handler.close();
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (config.TRANSPORT === "http") {
  // loadConfig の refine で HTTP 時の MCP_AUTH_TOKEN は保証済み
  await runHttp({ ...config, MCP_AUTH_TOKEN: config.MCP_AUTH_TOKEN! });
} else {
  await runStdio();
}
