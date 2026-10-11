// consent-api の Valkey をコンテナの中の valkey-cli で読む・後片付けする（Valkey はホストに公開していないため）。
// AUTH トークン（VALKEY_PASSWORD）はコンテナの環境変数のまま REDISCLI_AUTH に渡し、コンテナの外に出さない。
import { execIn } from "../helpers/docker.ts";
import { CONTAINERS } from "../helpers/services.ts";

const CONSENT_API_CONTAINER = "consent-api-consent-api-1";

/** consent-api のコンテナの、秘密でない環境変数を 1 つだけ読む。未設定なら空文字 */
export async function consentEnv(name: "SITE_URL" | "COOKIE_DOMAIN" | "CONSENT_POLICY_VERSION" | "VALKEY_KEY_PREFIX"): Promise<string> {
  try {
    return await execIn(CONSENT_API_CONTAINER, ["printenv", name]);
  } catch {
    return ""; // printenv は未設定で終了コード 1
  }
}

export async function valkeyCli(...args: string[]): Promise<string> {
  return execIn(CONTAINERS.consentValkey, [
    "sh",
    "-c",
    'if [ -n "$VALKEY_PASSWORD" ]; then export REDISCLI_AUTH="$VALKEY_PASSWORD"; fi; exec valkey-cli "$@"',
    "valkey-cli",
    ...args,
  ]);
}

/** 識別子の Stream のキー（README の「Valkey のキー設計」） */
export async function streamKey(id: string): Promise<string> {
  const prefix = (await consentEnv("VALKEY_KEY_PREFIX")) || "consent:";
  return `${prefix}c:${id}`;
}

export async function streamLength(id: string): Promise<number> {
  return Number(await valkeyCli("XLEN", await streamKey(id)));
}

/** 同意の Stream のキーをすべて（SCAN で。KEYS は使わない） */
export async function listStreamKeys(): Promise<Set<string>> {
  const prefix = (await consentEnv("VALKEY_KEY_PREFIX")) || "consent:";
  const out = await valkeyCli("--scan", "--pattern", `${prefix}c:*`);
  return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
}

/** Stream の最初の記録の時刻（at）。無ければ undefined */
export async function firstRecordedAt(key: string): Promise<string | undefined> {
  const lines = (await valkeyCli("XRANGE", key, "-", "+", "COUNT", "1")).split("\n").map((s) => s.trim());
  const index = lines.indexOf("at");
  return index >= 0 ? lines[index + 1] : undefined;
}

export async function deleteKeys(keys: string[]): Promise<void> {
  if (keys.length > 0) await valkeyCli("DEL", ...keys);
}
