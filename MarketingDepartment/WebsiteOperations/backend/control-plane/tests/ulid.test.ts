import { beforeEach, describe, expect, it, vi } from "vitest";

// 乱数は node:crypto の randomBytes。桁あふれの経路を通すためだけに差し替えられるようにする
const crypto = vi.hoisted(() => ({ forced: null as Buffer | null }));
vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return {
    ...original,
    randomBytes: (size: number) => crypto.forced ?? original.randomBytes(size),
  };
});

type UlidModule = typeof import("../src/ulid.js");
let mod: UlidModule;

beforeEach(async () => {
  // 前回の時刻と乱数をモジュールが持つため、テストごとに読み直す
  crypto.forced = null;
  vi.resetModules();
  mod = await import("../src/ulid.js");
});

describe("ulid", () => {
  it("26 文字の Crockford Base32（I・L・O・U を含まない）", () => {
    for (let i = 0; i < 200; i++) expect(mod.ulid()).toMatch(mod.ULID_PATTERN);
  });

  it("先頭 10 文字が時刻で、ulidTime で元のミリ秒に戻る", () => {
    const now = Date.UTC(2026, 9, 5, 0, 0, 0, 123);
    expect(mod.ulidTime(mod.ulid(now))).toBe(now);
  });

  it("時刻の符号化の境界（0 と 48 bit の最大値）", () => {
    expect(mod.ulid(0).slice(0, 10)).toBe("0000000000");
    expect(mod.ulid(2 ** 48 - 1).slice(0, 10)).toBe("7ZZZZZZZZZ");
  });

  it("同じミリ秒の中でも厳密に単調増加する（辞書順 = 発行順）", () => {
    const ids = Array.from({ length: 1_000 }, () => mod.ulid(1_700_000_000_000));
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
    expect(new Set(ids.map((id) => id.slice(0, 10))).size).toBe(1);
  });

  it("時刻が進めば、乱数部に関わらず後の ID が大きい", () => {
    const a = mod.ulid(1_000);
    const b = mod.ulid(1_001);
    expect(b > a).toBe(true);
  });

  it("時計が戻っても前回の時刻を使い、単調性を保つ", () => {
    const a = mod.ulid(2_000_000);
    const b = mod.ulid(1_000_000);
    expect(b > a).toBe(true);
    expect(mod.ulidTime(b)).toBe(2_000_000);
  });

  it("同じミリ秒で乱数部が桁あふれしたら、時刻を 1 ミリ秒進める", () => {
    crypto.forced = Buffer.alloc(16, 0xff); // 各桁 31（Z）
    const a = mod.ulid(5_000);
    expect(a.slice(10)).toBe("Z".repeat(16));
    const b = mod.ulid(5_000);
    expect(mod.ulidTime(b)).toBe(5_001);
    expect(b > a).toBe(true);
  });
});
