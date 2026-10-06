import { describe, expect, it } from "vitest";
import type { MiswriteCandidate } from "../../src/contract.js";
import { MiswriteStore } from "../../src/store/miswrite.js";
import { memoryE15 } from "../helpers/store.js";

function candidate(messageId: number, overrides: Partial<MiswriteCandidate> = {}): MiswriteCandidate {
  return {
    conversationDisplayId: 10,
    messageId,
    sentAt: "2026-10-05T08:00:00.000+09:00",
    nearestRunId: null,
    reason: "no matching proposal",
    ...overrides,
  };
}

describe("MiswriteStore", () => {
  it("新規なら true、同じ message_id は 2 回目以降 false で 1 件のまま（再実行で重複しない）", () => {
    const store = new MiswriteStore(memoryE15());
    expect(store.add(candidate(1), "2026-10-05T09:00:00+09:00")).toBe(true);
    expect(store.add(candidate(1, { reason: "changed" }), "2026-10-06T09:00:00+09:00")).toBe(false);
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.reason).toBe("no matching proposal");
  });

  it("入れた項目をそのまま返す（nearestRunId の null も保つ）", () => {
    const store = new MiswriteStore(memoryE15());
    const withRun = candidate(2, { conversationDisplayId: 77, nearestRunId: "01JZ0000000000000000000000" });
    store.add(withRun, "2026-10-05T09:00:00+09:00");
    store.add(candidate(3), "2026-10-05T09:00:00+09:00");
    expect(store.list()).toEqual([candidate(3), withRun]);
  });

  it("見つけた時刻の新しい順、同時刻なら message_id の大きい順に並べ、limit で切る", () => {
    const store = new MiswriteStore(memoryE15());
    store.add(candidate(5), "2026-10-04T09:00:00+09:00");
    store.add(candidate(6), "2026-10-05T09:00:00+09:00");
    store.add(candidate(7), "2026-10-05T09:00:00+09:00");
    expect(store.list().map((c) => c.messageId)).toEqual([7, 6, 5]);
    expect(store.list(2).map((c) => c.messageId)).toEqual([7, 6]);
  });

  it("本文を入れる列を持たない（ID・時刻・理由だけ）", () => {
    const db = memoryE15();
    const columns = (db.prepare("PRAGMA table_info(miswrite_candidates)").all() as { name: string }[]).map(
      (column) => column.name,
    );
    expect(columns.sort()).toEqual(
      ["conversation_display_id", "found_at", "message_id", "nearest_run_id", "reason", "sent_at"].sort(),
    );
  });
});
