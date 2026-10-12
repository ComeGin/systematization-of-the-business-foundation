import { createChatwootClient } from "./chatwoot/client.js";
import type { Config } from "./config.js";
import { CHATWOOT_TIMEOUT_MS, FAQ_FETCH_TIMEOUT_MS } from "./constants.js";
import { FaqStore } from "./faq/store.js";
import { createHandler, type Handle } from "./handler.js";

export interface Runtime {
  readonly handle: Handle;
  readonly faq: FaqStore;
}

/** 部品を組み立てる。開発の入口（index.ts）と本番の入口（lambda.ts）で共有する */
export function createRuntime(config: Config, deps: { fetchImpl?: typeof fetch; log?: (entry: Record<string, unknown>) => void } = {}): Runtime {
  const faq = new FaqStore({
    url: config.FAQ_URL,
    refreshMs: config.FAQ_REFRESH_SECONDS * 1000,
    timeoutMs: FAQ_FETCH_TIMEOUT_MS,
    fetchImpl: deps.fetchImpl,
  });
  const client = createChatwootClient({
    baseUrl: config.CHATWOOT_BASE_URL,
    accountId: config.CHATWOOT_ACCOUNT_ID,
    token: config.CHATWOOT_BOT_TOKEN,
    timeoutMs: CHATWOOT_TIMEOUT_MS,
    fetchImpl: deps.fetchImpl,
  });
  return { faq, handle: createHandler({ config, faq, client, log: deps.log }) };
}
