// ログは stderr だけに出す（stdout は他の用途と混ぜない）。
// 行頭は相関 ID。形式は "<ULID> <レベル> <連携点 ID> <本文>"（DD-01 の 9.1）。
// 秘密値と個人情報を本文に入れないこと（ログは sanitize を通らない）。
export type LogLevel = "INFO" | "WARN" | "ERROR";

export function logLine(level: LogLevel, point: string, body: string, runId?: string | null): void {
  const oneLine = body.replace(/\s+/g, " ").slice(0, 500);
  console.error(`${runId ?? "-"} ${level} ${point} ${oneLine}`);
}
