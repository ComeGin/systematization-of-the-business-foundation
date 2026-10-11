// 非同期に届くもの（Webhook → n8n → MailHog・Data Table）を待つ。
// 固定の sleep ではなく、条件が満たされるまで間隔を置いて見に行く。期限を過ぎたら、最後に見た値を添えて失敗する。
export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** 失敗の文に入れる「何を待っていたか」 */
  what?: string;
}

export async function waitFor<T>(probe: () => Promise<T | undefined | null | false>, options: WaitOptions = {}): Promise<T> {
  const { timeoutMs = 30_000, intervalMs = 500, what = "条件" } = options;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const reason = lastError instanceof Error ? `（最後の例外: ${lastError.message}）` : "";
      throw new Error(`${what} を ${timeoutMs}ms 待ったが満たされなかった${reason}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** 「起きないこと」を確かめる（重複排除など）。期間中に probe が真になったら失敗 */
export async function expectNever(probe: () => Promise<boolean>, options: { durationMs?: number; intervalMs?: number; what?: string } = {}): Promise<void> {
  const { durationMs = 5_000, intervalMs = 500, what = "起きてはいけないこと" } = options;
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    if (await probe()) throw new Error(`${what} が起きた`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
