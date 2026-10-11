// 基準 D の例外: テスト対象そのものが SQL のため、node:sqlite は差し替えず :memory: の実 SQLite で確かめる。
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

describe("MiswriteStore.add", () => {
  describe("正常系", () => {
    it("新規なら true で 1 件入る", () => {
      const store = new MiswriteStore(memoryE15());
      expect(store.add(candidate(1), "2026-10-05T09:00:00+09:00")).toBe(true);
      expect(store.list()).toEqual([candidate(1)]);
    });

    it("入れた項目をそのまま返す（nearestRunId の null も保つ）", () => {
      const store = new MiswriteStore(memoryE15());
      const withRun = candidate(2, { conversationDisplayId: 77, nearestRunId: "01JZ0000000000000000000000" });
      store.add(withRun, "2026-10-05T09:00:00+09:00");
      store.add(candidate(3), "2026-10-05T09:00:00+09:00");
      expect(store.list()).toEqual([candidate(3), withRun]);
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

    it("空入力: 理由が空文字でも記録する", () => {
      const store = new MiswriteStore(memoryE15());
      expect(store.add(candidate(4, { reason: "" }), "2026-10-05T09:00:00+09:00")).toBe(true);
      expect(store.list()[0]?.reason).toBe("");
    });
  });

  describe("異常系", () => {
    it("入力: 同じ message_id は 2 回目以降 false で 1 件のまま（再実行で重複しない・最初の内容を保つ）", () => {
      const store = new MiswriteStore(memoryE15());
      expect(store.add(candidate(1), "2026-10-05T09:00:00+09:00")).toBe(true);
      expect(store.add(candidate(1, { reason: "changed" }), "2026-10-06T09:00:00+09:00")).toBe(false);
      const list = store.list();
      expect(list).toHaveLength(1);
      expect(list[0]?.reason).toBe("no matching proposal");
    });

    // INSERT OR IGNORE は NOT NULL 違反も「無視」に含めるため、例外ではなく false（入らない）になる。
    // 候補の形の検査は呼び出し側（builtin/miswrite-check）の責務
    it("入力: 必須の項目（sentAt）が null の候補は例外にならず、入れずに false を返す", () => {
      const store = new MiswriteStore(memoryE15());
      const broken = candidate(5, { sentAt: null as unknown as string });
      expect(store.add(broken, "2026-10-05T09:00:00+09:00")).toBe(false);
      expect(store.list()).toEqual([]);
    });

    it("サーバ: DB が閉じていれば例外を投げる", () => {
      const db = memoryE15();
      const store = new MiswriteStore(db);
      db.close();
      expect(() => store.add(candidate(1), "2026-10-05T09:00:00+09:00")).toThrow();
    });
  });
});

describe("MiswriteStore.list", () => {
  describe("正常系", () => {
    it("見つけた時刻の新しい順、同時刻なら message_id の大きい順に並べ、limit で切る", () => {
      const store = new MiswriteStore(memoryE15());
      store.add(candidate(5), "2026-10-04T09:00:00+09:00");
      store.add(candidate(6), "2026-10-05T09:00:00+09:00");
      store.add(candidate(7), "2026-10-05T09:00:00+09:00");
      expect(store.list().map((c) => c.messageId)).toEqual([7, 6, 5]);
      expect(store.list(2).map((c) => c.messageId)).toEqual([7, 6]);
    });

    it("空入力: 候補が 0 件なら空の配列", () => {
      expect(new MiswriteStore(memoryE15()).list()).toEqual([]);
    });

    it("空入力: limit が 0 なら空の配列", () => {
      const store = new MiswriteStore(memoryE15());
      store.add(candidate(1), "2026-10-05T09:00:00+09:00");
      expect(store.list(0)).toEqual([]);
    });

    it("既定の上限は 200 件", () => {
      const store = new MiswriteStore(memoryE15());
      for (let n = 1; n <= 205; n++) store.add(candidate(n), "2026-10-05T09:00:00+09:00");
      expect(store.list()).toHaveLength(200);
    });
  });

  describe("異常系", () => {
    it("サーバ: DB が閉じていれば例外を投げる（空の一覧にしない）", () => {
      const db = memoryE15();
      const store = new MiswriteStore(db);
      db.close();
      expect(() => store.list()).toThrow();
    });
  });
});
