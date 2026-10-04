import type { DatabaseSync } from "node:sqlite";
import type { MiswriteCandidate } from "../contract.js";

/** 誤った書き込みの候補。メッセージの本文は保存しない（ID・時刻・理由だけ）。 */
export class MiswriteStore {
  constructor(private readonly db: DatabaseSync) {}

  /** 同じ message_id は 1 件だけ（再実行で重複しない）。新規に入ったら true。 */
  add(candidate: MiswriteCandidate, foundAt: string): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO miswrite_candidates
           (message_id, conversation_display_id, sent_at, nearest_run_id, reason, found_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.messageId,
        candidate.conversationDisplayId,
        candidate.sentAt,
        candidate.nearestRunId,
        candidate.reason,
        foundAt,
      );
    return Number(result.changes) > 0;
  }

  list(limit = 200): MiswriteCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT message_id, conversation_display_id, sent_at, nearest_run_id, reason
         FROM miswrite_candidates ORDER BY found_at DESC, message_id DESC LIMIT ?`,
      )
      .all(limit) as unknown as {
      message_id: number;
      conversation_display_id: number;
      sent_at: string;
      nearest_run_id: string | null;
      reason: string;
    }[];
    return rows.map((row) => ({
      conversationDisplayId: row.conversation_display_id,
      messageId: row.message_id,
      sentAt: row.sent_at,
      nearestRunId: row.nearest_run_id,
      reason: row.reason,
    }));
  }
}
