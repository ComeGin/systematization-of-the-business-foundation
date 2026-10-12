import type { Config } from "../../src/config.js";

/** loadConfig を通した後の形の設定。本番に近い値を既定にする */
export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    HOST: "127.0.0.1",
    PORT: 0,
    CHATWOOT_BASE_URL: "https://chat.comegin.com",
    CHATWOOT_ACCOUNT_ID: 1,
    CHATWOOT_BOT_TOKEN: "bot-token-for-tests",
    CHATWOOT_BOT_SECRET: "secret-for-tests-0123456789",
    FAQ_URL: "https://comegin.com/faq.json",
    FAQ_REFRESH_SECONDS: 600,
    FAQ_MATCH_HIGH: 0.5,
    FAQ_MATCH_LOW: 0.25,
    FAQ_MATCH_MARGIN: 0.1,
    ...overrides,
  };
}
