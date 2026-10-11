import { randomBytes } from "node:crypto";
import type { Config } from "./config.js";
import { COOKIE_MAX_AGE_SECONDS, COOKIE_NAME, ID_PATTERN } from "./constants.js";
import type { ConsentState } from "./store.js";

/** 識別子はサーバーだけが発行する。リクエストの本文で送られた値は使わない */
export function issueId(): string {
  return randomBytes(16).toString("base64url");
}

/** Cookie ヘッダーから識別子を取り出す。形式が違えば null（存在の確認は呼び出し側が Valkey で行う） */
export function readCookieId(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== COOKIE_NAME) continue;
    const id = new URLSearchParams(part.slice(separator + 1).trim()).get("id");
    return id !== null && ID_PATTERN.test(id) ? id : null;
  }
  return null;
}

/**
 * Set-Cookie の値。中身は状態・ポリシーの版・識別子だけ（s=granted&v=2026-10-01&id=...）。
 * 使う文字はすべて Cookie にそのまま書けるため、エンコードしない。HttpOnly は付けない（JS が同期で読むため）
 */
export function buildSetCookie(config: Config, state: ConsentState, id: string): string {
  const value = `s=${state}&v=${config.CONSENT_POLICY_VERSION}&id=${id}`;
  const attributes = [`${COOKIE_NAME}=${value}`, `Max-Age=${COOKIE_MAX_AGE_SECONDS}`, "Path=/", "Secure", "SameSite=Lax"];
  if (config.COOKIE_DOMAIN) attributes.push(`Domain=${config.COOKIE_DOMAIN}`);
  return attributes.join("; ");
}
