import type { Config } from "../../src/config.js";

/** loadConfig を通した後の形の設定。本番に近い値（https のサイト・Domain 付き）を既定にする */
export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    HOST: "127.0.0.1",
    PORT: 0,
    VALKEY_URL: "redis://fake-valkey:6379",
    VALKEY_PASSWORD: undefined,
    VALKEY_KEY_PREFIX: "test:",
    SITE_URL: "https://comegin.com",
    COOKIE_DOMAIN: ".comegin.com",
    CONSENT_POLICY_VERSION: "2026-10-01",
    ...overrides,
  };
}
