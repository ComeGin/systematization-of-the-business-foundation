// ULID（26 文字、Crockford Base32）。先頭 48 bit が UNIX ミリ秒のため、辞書順 = 時系列になる（DD-01 の 3.3）。
// 同じミリ秒の中でも単調増加させる。
import { randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let lastTime = -1;
let lastRandom: number[] = [];

function freshRandom(): number[] {
  const bytes = randomBytes(16);
  return Array.from(bytes, (byte) => byte & 31);
}

function increment(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i--) {
    const value = digits[i] ?? 0;
    if (value < 31) {
      digits[i] = value + 1;
      return true;
    }
    digits[i] = 0;
  }
  return false; // 桁あふれ（80 bit なので現実には起きない）
}

function encodeTime(ms: number): string {
  let rest = ms;
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = ENCODING[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  let time = Math.max(now, lastTime);
  if (time === lastTime) {
    if (!increment(lastRandom)) {
      time += 1;
      lastRandom = freshRandom();
    }
  } else {
    lastRandom = freshRandom();
  }
  lastTime = time;
  return encodeTime(time) + lastRandom.map((digit) => ENCODING[digit]).join("");
}

/** ULID から発行時刻（UNIX ミリ秒）を取り出す。 */
export function ulidTime(id: string): number {
  let ms = 0;
  for (const char of id.slice(0, 10)) ms = ms * 32 + ENCODING.indexOf(char);
  return ms;
}
