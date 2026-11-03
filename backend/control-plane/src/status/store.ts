// 設定の状況: 直近の確認の結果と知らせの記録を <dataDir>/setup-status.json に置く（spec の 6。E-15 の e15.sqlite とは別）。
// 書くのは秘密値を伏せた後のものだけ（service.ts が redact してから渡す）。一時ファイルに書いてから rename する（途中で落ちても壊さない）。
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/v4";
import { logLine } from "../log.js";
import type { EvaluatedStatus, ModuleResultWithTime } from "./evaluate.js";
import type { DriftResult } from "./drift.js";
import type { NotifyLedger } from "./notify.js";

export const STATUS_FILE = "setup-status.json";

export interface StoredStatus {
  version: 1;
  snapshot: EvaluatedStatus;
  /** 次の確認で、飛ばした（製品の API を呼ぶ）モジュールの結果を引き継ぐために持つ */
  moduleResults: ModuleResultWithTime[];
  /** 製品の API を呼ぶモジュールを最後に確かめた時刻（JST の ISO 8601） */
  productApiCheckedAt: string | null;
  /**
   * 直近のずれの確認の結果（伏せた後）。製品の API を呼ぶ確認（本番の n8n）を飛ばした回に引き継ぐために持つ。
   * 古い保存には無い（無ければ引き継がずに確かめる）
   */
  driftResults?: StoredDrift[];
  ledger: NotifyLedger;
}

export interface StoredDrift extends DriftResult {
  /** その結果を確かめた時刻（JST の ISO 8601） */
  checkedAt: string;
}

const Level = z.enum(["ok", "action", "warn", "manual", "unknown"]);

// 読むときの検証。形が違う（古い版・壊れた）ときは無いものとして扱い、次の確認で作り直す
const StoredSchema = z.object({
  version: z.literal(1),
  snapshot: z.object({
    checkedAt: z.string().nullable(),
    counts: z.record(Level, z.number()),
    steps: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        level: Level,
        items: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            who: z.string(),
            kind: z.string(),
            level: Level,
            evidence: z.string(),
            stopId: z.string().nullable(),
            docs: z.array(z.object({ file: z.string(), heading: z.string() })),
            checkedAt: z.string().nullable(),
          }),
        ),
      }),
    ),
  }),
  moduleResults: z.array(
    z.object({
      moduleId: z.string(),
      phase: z.string().nullable(),
      ok: z.boolean(),
      notes: z.array(z.string()),
      items: z.array(
        z.object({
          key: z.string(),
          step: z.string(),
          level: Level,
          title: z.string(),
          evidence: z.string(),
          stopId: z.string().optional(),
        }),
      ),
      error: z.string().nullable(),
      skipped: z.boolean(),
      checkedAt: z.string(),
      script: z.enum(["setup/setup.mjs", "setup/frontend.mjs"]),
    }),
  ),
  productApiCheckedAt: z.string().nullable(),
  driftResults: z
    .array(z.object({ id: z.enum(["site-redeploy", "n8n-workflows"]), level: Level, evidence: z.string(), checkedAt: z.string() }))
    .optional(),
  ledger: z.object({
    lastLevels: z.record(z.string(), Level),
    digestSentOn: z.string().nullable(),
    // ? の数えは項目 id ごと。古い保存（unknownSince・unknownNotified の 1 組）には無いので省略可（無ければ空から数え直す）
    unknownItems: z.record(z.string(), z.object({ since: z.string(), notified: z.boolean() })).optional(),
    // 古い保存の項目。読めるように受け付けるが使わない（読み込みで捨てる）
    unknownSince: z.string().nullable().optional(),
    unknownNotified: z.boolean().optional(),
    // 後から足した項目。無い保存も読めるようにする（無ければ null / false として扱う）
    catalogBrokenSince: z.string().nullable().optional(),
    catalogBrokenNotified: z.boolean().optional(),
  }),
});

export class StatusStore {
  readonly file: string;

  constructor(private readonly dataDir: string) {
    this.file = join(dataDir, STATUS_FILE);
  }

  /** 無い・読めない・形が違うときは null。 */
  load(): StoredStatus | null {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") logLine("WARN", "setup-status", `前回の結果を読めない（${code ?? "不明"}）`);
      return null;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      logLine("WARN", "setup-status", "前回の結果が JSON として読めない（次の確認で作り直す）");
      return null;
    }
    const parsed = StoredSchema.safeParse(json);
    if (!parsed.success) {
      logLine("WARN", "setup-status", "前回の結果の形が違う（次の確認で作り直す）");
      return null;
    }
    // 古い形の ? の数え（unknownSince・unknownNotified）は捨て、項目 id ごとの数えを空から始める
    const { unknownSince: _since, unknownNotified: _notified, unknownItems, ...ledger } = parsed.data.ledger;
    return { ...parsed.data, ledger: { ...ledger, unknownItems: unknownItems ?? {} } } as StoredStatus;
  }

  /** 一時ファイル → rename。権限は 600（置き場は 700 で作る）。失敗したら投げる。 */
  save(status: StoredStatus): void {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}
