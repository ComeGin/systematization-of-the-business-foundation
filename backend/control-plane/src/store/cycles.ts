import type { DatabaseSync } from "node:sqlite";
import type {
  CycleApproval,
  CycleCloseResult,
  CycleId,
  CycleItem,
  CycleItemKind,
  CycleItemPreview,
  CycleItemState,
  CycleRow,
  CycleStage,
  Ulid,
} from "../contract.js";
import { toIsoJst } from "../time.js";
import { transaction } from "./db.js";
import { ulid } from "../ulid.js";

interface CycleDbRow {
  cycle_id: string;
  starts_at: string;
  ends_at: string;
  manual: number;
  closed_at: string | null;
  close_json: string | null;
}

interface ItemDbRow {
  item_id: string;
  cycle_id: string;
  kind: string;
  stage: string;
  source_ref: string;
  proposal_id: string | null;
  title: string;
  summary: string;
  evidence_json: string;
  preview_json: string;
  state: string;
  state_reason: string | null;
  created_at: string;
  updated_at: string;
  reflected_at: string | null;
}

interface ApprovalDbRow {
  item_id: string;
  action: string;
  actor: string;
  checked_json: string;
  reason: string | null;
  at: string;
}

const CYCLE_COLUMNS = "cycle_id, starts_at, ends_at, manual, closed_at, close_json";
const ITEM_COLUMNS = `item_id, cycle_id, kind, stage, source_ref, proposal_id, title, summary, evidence_json, preview_json,
  state, state_reason, created_at, updated_at, reflected_at`;

function toCycleRow(row: CycleDbRow): CycleRow {
  return {
    cycleId: row.cycle_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    manual: row.manual === 1,
    closedAt: row.closed_at,
    close: row.close_json === null ? null : (JSON.parse(row.close_json) as CycleCloseResult),
  };
}

function toItem(row: ItemDbRow): CycleItem {
  return {
    itemId: row.item_id,
    cycleId: row.cycle_id,
    kind: row.kind as CycleItemKind,
    stage: row.stage as CycleStage,
    sourceRef: row.source_ref,
    proposalId: row.proposal_id,
    title: row.title,
    summary: row.summary,
    evidence: JSON.parse(row.evidence_json) as CycleItem["evidence"],
    preview: JSON.parse(row.preview_json) as CycleItemPreview,
    state: row.state as CycleItemState,
    stateReason: row.state_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reflectedAt: row.reflected_at,
  };
}

function toApproval(row: ApprovalDbRow): CycleApproval {
  return {
    itemId: row.item_id,
    action: row.action as CycleApproval["action"],
    actor: row.actor,
    checked: JSON.parse(row.checked_json) as string[],
    reason: row.reason,
    at: row.at,
  };
}

/** upsertItem の入力。state を省くと preparing で作る（既存の項目では preparing → awaiting_review の進行だけ効く） */
export type UpsertCycleItemInput = Omit<CycleItem, "itemId" | "createdAt" | "updatedAt" | "state" | "stateReason" | "reflectedAt"> & {
  state?: CycleItemState;
};

const MAX_LIST_LIMIT = 100;

/** 改善ループの周・項目・人の承認の記録（E-15 と同じ SQLite）。書くのは監視アプリのサーバー側だけ。 */
export class CycleStore {
  constructor(private readonly db: DatabaseSync) {}

  /** 周を開く。同じ ID が既にあれば何もしない（冪等。手動で開いた周を定期実行が上書きしない） */
  openCycle(cycleId: CycleId, startsAt: string, endsAt: string, manual: boolean): void {
    this.db
      .prepare("INSERT OR IGNORE INTO cycles (cycle_id, starts_at, ends_at, manual) VALUES (?, ?, ?, ?)")
      .run(cycleId, startsAt, endsAt, manual ? 1 : 0);
  }

  getCycle(cycleId: CycleId): CycleRow | null {
    const row = this.db.prepare(`SELECT ${CYCLE_COLUMNS} FROM cycles WHERE cycle_id = ?`).get(cycleId) as CycleDbRow | undefined;
    return row ? toCycleRow(row) : null;
  }

  /** 新しい周から順。 */
  listCycles(limit: number): CycleRow[] {
    const bounded = Math.min(Math.max(Math.floor(limit), 1), MAX_LIST_LIMIT);
    const rows = this.db
      .prepare(`SELECT ${CYCLE_COLUMNS} FROM cycles ORDER BY cycle_id DESC LIMIT ?`)
      .all(bounded) as unknown as CycleDbRow[];
    return rows.map(toCycleRow);
  }

  /**
   * 項目を作る。(kind, source_ref) が同じ項目が既にあれば title・summary・evidence・preview だけを更新する
   * （cycle_id・stage・proposal_id は最初に書いた値のまま）。
   * state は preparing → awaiting_review の進行だけ upsert で動かせる。それ以外の状態は戻さず・飛ばさない。
   * 1 文で競合を解くので、読んでから書く間に他の更新が割り込まない。
   */
  upsertItem(input: UpsertCycleItemInput): CycleItem {
    const now = toIsoJst();
    const state = input.state ?? "preparing";
    this.db
      .prepare(
        `INSERT INTO cycle_items (item_id, cycle_id, kind, stage, source_ref, proposal_id, title, summary,
           evidence_json, preview_json, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (kind, source_ref) DO UPDATE SET
           title = excluded.title,
           summary = excluded.summary,
           evidence_json = excluded.evidence_json,
           preview_json = excluded.preview_json,
           state = CASE WHEN cycle_items.state = 'preparing' AND excluded.state = 'awaiting_review'
             THEN 'awaiting_review' ELSE cycle_items.state END,
           updated_at = excluded.updated_at`,
      )
      .run(
        ulid(),
        input.cycleId,
        input.kind,
        input.stage,
        input.sourceRef,
        input.proposalId,
        input.title,
        input.summary,
        JSON.stringify(input.evidence),
        JSON.stringify(input.preview),
        state,
        now,
        now,
      );
    const row = this.db
      .prepare(`SELECT ${ITEM_COLUMNS} FROM cycle_items WHERE kind = ? AND source_ref = ?`)
      .get(input.kind, input.sourceRef) as ItemDbRow | undefined;
    if (!row) throw new Error(`項目の保存に失敗: ${input.kind} ${input.sourceRef}`);
    return toItem(row);
  }

  /** 項目 ID の昇順（= 作成順）。 */
  listItems(cycleId: CycleId): CycleItem[] {
    const rows = this.db
      .prepare(`SELECT ${ITEM_COLUMNS} FROM cycle_items WHERE cycle_id = ? ORDER BY item_id`)
      .all(cycleId) as unknown as ItemDbRow[];
    return rows.map(toItem);
  }

  /**
   * 周を問わず、updated_at が [startsAt, endsAt) に入る項目（項目 ID の昇順）。
   * 項目の cycle_id は最初の周のまま変わらないので、周をまたいで差し戻された項目を今の周の要約に載せるために使う。
   * どちらの時刻も toIsoJst の形（+09:00）なので、文字列の比較で足りる
   */
  listItemsUpdatedBetween(startsAt: string, endsAt: string): CycleItem[] {
    const rows = this.db
      .prepare(`SELECT ${ITEM_COLUMNS} FROM cycle_items WHERE updated_at >= ? AND updated_at < ? ORDER BY item_id`)
      .all(startsAt, endsAt) as unknown as ItemDbRow[];
    return rows.map(toItem);
  }

  getItem(itemId: Ulid): CycleItem | null {
    const row = this.db.prepare(`SELECT ${ITEM_COLUMNS} FROM cycle_items WHERE item_id = ?`).get(itemId) as ItemDbRow | undefined;
    return row ? toItem(row) : null;
  }

  /** (kind, source_ref) の項目（どの周のものも含む）。無ければ null */
  findItem(kind: CycleItemKind, sourceRef: string): CycleItem | null {
    const row = this.db
      .prepare(`SELECT ${ITEM_COLUMNS} FROM cycle_items WHERE kind = ? AND source_ref = ?`)
      .get(kind, sourceRef) as ItemDbRow | undefined;
    return row ? toItem(row) : null;
  }

  /** 種類が kind の項目（どの周のものも含む。項目 ID の昇順 = 作成順）。states を渡すと、その状態のものだけ */
  listItemsByKind(kind: CycleItemKind, states?: CycleItemState[]): CycleItem[] {
    if (states !== undefined && states.length === 0) return [];
    const filter = states === undefined ? "" : ` AND state IN (${states.map(() => "?").join(", ")})`;
    const rows = this.db
      .prepare(`SELECT ${ITEM_COLUMNS} FROM cycle_items WHERE kind = ?${filter} ORDER BY item_id`)
      .all(kind, ...(states ?? [])) as unknown as ItemDbRow[];
    return rows.map(toItem);
  }

  /** 種類が kind の項目のうち、最も新しく作られたもの（状態を問わない）。無ければ null */
  latestItemOfKind(kind: CycleItemKind): CycleItem | null {
    const row = this.db
      .prepare(`SELECT ${ITEM_COLUMNS} FROM cycle_items WHERE kind = ? ORDER BY item_id DESC LIMIT 1`)
      .get(kind) as ItemDbRow | undefined;
    return row ? toItem(row) : null;
  }

  /**
   * 作用の項目に結びついた E-13 の proposal_id すべて（どの周のものも含む。作用のジョブが選び直さないための集合）。
   * proposal の項目（PR の状態を見せるだけ）は除く。除かないと、起票中に項目を作った E-13 が承認後に作用のジョブに選ばれない
   */
  listProposalIdsWithItems(): Set<string> {
    const rows = this.db
      .prepare("SELECT DISTINCT proposal_id FROM cycle_items WHERE proposal_id IS NOT NULL AND kind <> 'proposal'")
      .all() as unknown as { proposal_id: string }[];
    return new Set(rows.map((row) => row.proposal_id));
  }

  /** 状態を変える。現在の状態が from に無ければ何もせず false（承認の二重送信・古い画面からの操作を弾く） */
  transition(itemId: Ulid, from: CycleItemState[], to: CycleItemState, reason: string | null): boolean {
    if (from.length === 0) return false;
    const placeholders = from.map(() => "?").join(", ");
    const result = this.db
      .prepare(`UPDATE cycle_items SET state = ?, state_reason = ?, updated_at = ? WHERE item_id = ? AND state IN (${placeholders})`)
      .run(to, reason, toIsoJst(), itemId, ...from);
    return Number(result.changes) > 0;
  }

  /**
   * transition に「updated_at が expectedUpdatedAt のまま」の条件を足した版。
   * 人が画面で見た時点から項目の中身が差し替えられていれば（upsertItem は updated_at を進める）、何もせず false
   */
  transitionIfUnchanged(itemId: Ulid, from: CycleItemState[], to: CycleItemState, reason: string | null, expectedUpdatedAt: string): boolean {
    if (from.length === 0) return false;
    const placeholders = from.map(() => "?").join(", ");
    const result = this.db
      .prepare(
        `UPDATE cycle_items SET state = ?, state_reason = ?, updated_at = ?
         WHERE item_id = ? AND updated_at = ? AND state IN (${placeholders})`,
      )
      .run(to, reason, toIsoJst(), itemId, expectedUpdatedAt, ...from);
    return Number(result.changes) > 0;
  }

  /**
   * 状態の遷移と人の操作の記録を 1 つのトランザクションで行う（記録だけ残る・遷移だけ起きる、を作らない）。
   * expectedUpdatedAt を渡すと transitionIfUnchanged の条件になる。遷移しなかったときは記録せず false
   */
  transitionWithApproval(
    itemId: Ulid,
    from: CycleItemState[],
    to: CycleItemState,
    reason: string | null,
    approval: CycleApproval,
    expectedUpdatedAt?: string,
  ): boolean {
    return transaction(this.db, () => {
      const moved =
        expectedUpdatedAt === undefined
          ? this.transition(itemId, from, to, reason)
          : this.transitionIfUnchanged(itemId, from, to, reason, expectedUpdatedAt);
      if (!moved) return false;
      this.recordApproval(approval);
      return true;
    });
  }

  /** 実績への反映の時刻を残す。 */
  setReflected(itemId: Ulid, at: string): void {
    this.db.prepare("UPDATE cycle_items SET reflected_at = ?, updated_at = ? WHERE item_id = ?").run(at, toIsoJst(), itemId);
  }

  recordApproval(a: CycleApproval): void {
    this.db
      .prepare("INSERT INTO cycle_approvals (item_id, action, actor, checked_json, reason, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(a.itemId, a.action, a.actor, JSON.stringify(a.checked), a.reason, a.at);
  }

  /** 古い順。 */
  listApprovals(itemId: Ulid): CycleApproval[] {
    const rows = this.db
      .prepare("SELECT item_id, action, actor, checked_json, reason, at FROM cycle_approvals WHERE item_id = ? ORDER BY id")
      .all(itemId) as unknown as ApprovalDbRow[];
    return rows.map(toApproval);
  }

  /**
   * 周を締める。締めた時刻と結果を残す（締めた周をもう一度締めても、1 回目の結果を変えない）。
   * この呼び出しで実際に締めたら true、既に締めてあった（別のジョブが先に締めた）・周が無ければ false（知らせを二重に出さないため）
   */
  closeCycle(cycleId: CycleId, result: CycleCloseResult): boolean {
    const outcome = this.db
      .prepare("UPDATE cycles SET closed_at = ?, close_json = ? WHERE cycle_id = ? AND closed_at IS NULL")
      .run(toIsoJst(), JSON.stringify(result), cycleId);
    return Number(outcome.changes) > 0;
  }
}
