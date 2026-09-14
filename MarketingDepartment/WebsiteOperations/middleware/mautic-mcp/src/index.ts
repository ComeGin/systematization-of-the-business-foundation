#!/usr/bin/env node
/**
 * Mautic MCP サーバ
 *
 * 認証は 2 段構成:
 *   - MCP クライアント → 本サーバ: 固定 Bearer トークン（MCP_AUTH_TOKEN。HTTP のみ）
 *   - 本サーバ → Mautic: OAuth2 client_credentials（トークンはプロセス内でキャッシュ・自動更新）
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { createMcpExpressApp, requireBearerAuth, type OAuthTokenVerifier } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer, OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { loadConfig, type Config } from "./config.js";
import { SERVER_NAME, SERVER_VERSION, STATIC_TOKEN_TTL_SEC } from "./constants.js";
import { MauticClient } from "./services/mautic-client.js";
import { registerContactTools } from "./tools/contacts.js";

const config = loadConfig();

// トークンキャッシュを共有するため、MCP のリクエストをまたいで 1 インスタンスを使う
const mautic = new MauticClient({
  baseUrl: config.MAUTIC_BASE_URL,
  clientId: config.MAUTIC_CLIENT_ID,
  clientSecret: config.MAUTIC_CLIENT_SECRET,
});

function buildServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerContactTools(server, mautic);
  return server;
}

function createStaticTokenVerifier(expected: string): OAuthTokenVerifier {
  // 長さの違いで比較時間が変わらないよう、ハッシュ同士を定数時間で比較する
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expectedDigest = digest(expected);

  return {
    async verifyAccessToken(token) {
      if (!timingSafeEqual(digest(token), expectedDigest)) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid token");
      }
      return {
        token,
        clientId: "mcp-client",
        scopes: [],
        expiresAt: Math.floor(Date.now() / 1000) + STATIC_TOKEN_TTL_SEC,
      };
    },
  };
}

async function runHttp(config: Config & { MCP_AUTH_TOKEN: string }): Promise<void> {
  const handler = createMcpHandler(buildServer);
  const app = createMcpExpressApp({ host: config.HOST, allowedHosts: config.MCP_ALLOWED_HOSTS });
  const auth = requireBearerAuth({ verifier: createStaticTokenVerifier(config.MCP_AUTH_TOKEN) });
  const node = toNodeHandler(handler);

  app.all("/mcp", auth, (req, res) => void node(req, res, req.body));

  const httpServer = app.listen(config.PORT, config.HOST, () => {
    console.error(`[${SERVER_NAME}] listening on http://${config.HOST}:${config.PORT}/mcp (Mautic: ${config.MAUTIC_BASE_URL})`);
  });

  const shutdown = async () => {
    await handler.close();
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runStdio(): Promise<void> {
  await buildServer().connect(new StdioServerTransport());
  // stdout は MCP の通信に使うため、ログは stderr に出す
  console.error(`[${SERVER_NAME}] running on stdio (Mautic: ${config.MAUTIC_BASE_URL})`);
}

if (config.TRANSPORT === "stdio") {
  await runStdio();
} else {
  // loadConfig の refine で HTTP 時の MCP_AUTH_TOKEN は保証済み
  await runHttp({ ...config, MCP_AUTH_TOKEN: config.MCP_AUTH_TOKEN! });
}
