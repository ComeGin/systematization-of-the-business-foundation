import type { Server } from "node:http";
import { loadConfig } from "../../src/config.js";
import { createRuntime } from "../../src/runtime.js";
import { createDevServer } from "../../src/server.js";
import { BOT_PORT, CHATWOOT, type DevState } from "./state.js";

/** テストの中で faq-bot を 127.0.0.1:3107 に起動する（Chatwoot は host-relay 経由でここに送る） */
export async function startBot(state: DevState, faqUrl: string): Promise<{ stop(): Promise<void> }> {
  const config = loadConfig({
    HOST: "127.0.0.1",
    PORT: String(BOT_PORT),
    CHATWOOT_BASE_URL: CHATWOOT,
    CHATWOOT_ACCOUNT_ID: String(state.accountId),
    CHATWOOT_BOT_TOKEN: state.botToken,
    CHATWOOT_BOT_SECRET: state.botSecret,
    FAQ_URL: faqUrl,
  });
  const server: Server = createDevServer(createRuntime(config, { log: () => {} }).handle, () => {});
  await new Promise<void>((resolve) => server.listen(BOT_PORT, "127.0.0.1", resolve));
  return {
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
