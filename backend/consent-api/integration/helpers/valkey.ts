import { execFileSync } from "node:child_process";

// 開発の Valkey（compose のサービス valkey）。127.0.0.1:6380 にだけ開いている（compose.yml）
export const VALKEY_CONTAINER = "consent-api-valkey-1";
export const VALKEY_URL = "redis://127.0.0.1:6380";

/** 開発の Valkey の AUTH（コンテナの環境変数。空なら認証なし）。値は画面に出さない */
export function devValkeyPassword(): string {
  try {
    return execFileSync("docker", ["exec", VALKEY_CONTAINER, "printenv", "VALKEY_PASSWORD"], { encoding: "utf8" }).trim();
  } catch {
    return ""; // printenv は未設定で終了コード 1
  }
}

export function pauseValkey(): void {
  execFileSync("docker", ["pause", VALKEY_CONTAINER]);
}

/** 止めていなければ何もしない（afterEach から必ず呼ぶ） */
export function unpauseValkey(): void {
  const state = execFileSync("docker", ["inspect", "-f", "{{.State.Paused}}", VALKEY_CONTAINER], { encoding: "utf8" }).trim();
  if (state === "true") execFileSync("docker", ["unpause", VALKEY_CONTAINER]);
}
