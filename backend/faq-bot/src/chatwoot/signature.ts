import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyInput {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: Buffer;
  nowSeconds: number;
  toleranceSeconds: number;
}

export type SignatureResult = { ok: true } | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" };

/**
 * Chatwoot のエージェントボットの Webhook の署名を確かめる（lib/webhooks/trigger.rb）。
 * X-Chatwoot-Signature: sha256=HMAC-SHA256(secret, "<X-Chatwoot-Timestamp>.<生の本文>")。本文は解析する前のバイト列で計算する
 */
export function verifySignature(input: VerifyInput): SignatureResult {
  const { secret, timestamp, signature, rawBody, nowSeconds, toleranceSeconds } = input;
  if (!timestamp || !signature) return { ok: false, reason: "missing" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "malformed" };
  const match = /^sha256=([0-9a-f]{64})$/.exec(signature);
  if (!match?.[1]) return { ok: false, reason: "malformed" };
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return { ok: false, reason: "stale" };
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(match[1], "hex")) ? { ok: true } : { ok: false, reason: "mismatch" };
}
