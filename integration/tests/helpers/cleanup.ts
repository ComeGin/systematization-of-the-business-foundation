// 後片付けの登録。作ったものはその場で登録し、afterAll でまとめて逆順に消す。
// 1 つが失敗しても残りは続け、最後に失敗の一覧を投げる（消し残しに気付けるように）。
export class Cleanup {
  readonly #tasks: Array<{ label: string; run: () => Promise<unknown> }> = [];

  add(label: string, run: () => Promise<unknown>): void {
    this.#tasks.push({ label, run });
  }

  async runAll(): Promise<void> {
    const failures: string[] = [];
    while (this.#tasks.length > 0) {
      const task = this.#tasks.pop()!;
      try {
        await task.run();
      } catch (error) {
        failures.push(`${task.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) throw new Error(`後片付けに失敗した（${failures.length} 件）:\n${failures.join("\n")}`);
  }
}
