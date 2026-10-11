import { vi } from "vitest";

// 検証を通る最小の環境変数。値はすべて架空
export const SECRET = "test-secret-0123456789abcdefghijklmnop";
export const DB_PASSWORD = "db-password-should-not-leak";

export function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    BETTER_AUTH_URL: "http://localhost:3103",
    BETTER_AUTH_SECRET: SECRET,
    DATABASE_HOST: "db.invalid",
    DATABASE_USERNAME: "admin_auth",
    DATABASE_PASSWORD: DB_PASSWORD,
    ...overrides,
  };
}

/** 検証を通る環境変数を process.env に与える（import 時に loadConfig() を呼ぶモジュール向け） */
export function stubValidEnv(overrides: Record<string, string> = {}): void {
  for (const [key, value] of Object.entries({ ...validEnv(), ...overrides })) {
    if (value !== undefined) vi.stubEnv(key, value);
  }
}

/** process.exit を、テストプロセスを落とさずに throw する形へ差し替える */
export function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
}

/** console.error に出た内容を 1 つの文字列にまとめて返す */
export function captureStderr() {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return {
    spy,
    text: () => spy.mock.calls.map((args) => args.map(String).join(" ")).join("\n"),
  };
}
