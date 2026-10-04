// E-15 の S3 への写し（ADR-18 の追加の決定 5）。
// runs/YYYY/MM/DD/<ULID>.json を If-None-Match: * で書く（追記だけ。上書きは S3 側が拒否する）。
// バケットのポリシーは If-None-Match が無い PutObject と作成系の操作（マルチパートなど）を Deny するため、
// 必ず単発の PutObject を使う（@aws-sdk/lib-storage の Upload は使わない）。
// 未送の run は E-15 に残っており（copied_at が NULL）、起動時と定期的に古い順に送り直す。写しは正本ではない。
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { ControlPlaneConfig } from "../config.js";
import type { FailureClass } from "../contract.js";
import { CONTROL_TIMEOUT_SEC } from "../constants/timeouts.js";
import { logLine } from "../log.js";
import type { RunStore } from "../store/runs.js";
import { toIsoJst } from "../time.js";
import { classifyAwsError, createS3Client } from "./aws.js";

export interface FlushResult {
  sent: number;
  /** 既に写し済みだった（412）ためコピー済みの印だけ付けた件数 */
  alreadyCopied: number;
  remaining: number;
  failureClass: FailureClass | null;
}

const FLUSH_BATCH = 100;
/** 1 件のスナップショットの上限。要約と ID だけなので十分に小さいはずで、超えたら写さずに失敗として扱う */
const MAX_SNAPSHOT_BYTES = 1024 * 1024;

export function runLogKey(runId: string, startedAt: string): string {
  // startedAt は +09:00 つきの ISO 8601。日付は日本時間で切る
  return `runs/${startedAt.slice(0, 4)}/${startedAt.slice(5, 7)}/${startedAt.slice(8, 10)}/${runId}.json`;
}

export class RunLogCopier {
  private flushing: Promise<FlushResult> | null = null;
  private readonly client: S3Client;

  constructor(
    private readonly runs: RunStore,
    private readonly aws: NonNullable<ControlPlaneConfig["aws"]>,
  ) {
    this.client = createS3Client(aws);
  }

  /** 同時に 2 回走らせない（実行中なら同じ結果を待つ）。 */
  flush(signal?: AbortSignal): Promise<FlushResult> {
    this.flushing ??= this.doFlush(signal).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(signal?: AbortSignal): Promise<FlushResult> {
    const result: FlushResult = { sent: 0, alreadyCopied: 0, remaining: 0, failureClass: null };
    const pending = this.runs.pendingCopies(FLUSH_BATCH);
    for (const [index, run] of pending.entries()) {
      if (signal?.aborted) {
        result.remaining = pending.length - index;
        break;
      }
      if (Buffer.byteLength(run.snapshot, "utf8") > MAX_SNAPSHOT_BYTES) {
        result.failureClass = "invalid_response";
        logLine("ERROR", "runlog", "スナップショットが 1 MiB を超えるため写さない", run.runId);
        continue;
      }
      try {
        const timeout = AbortSignal.timeout(CONTROL_TIMEOUT_SEC.s3Put * 1000);
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.aws.runlogBucket,
            Key: runLogKey(run.runId, run.startedAt),
            Body: run.snapshot,
            ContentType: "application/json",
            IfNoneMatch: "*",
          }),
          { abortSignal: signal ? AbortSignal.any([timeout, signal]) : timeout },
        );
        this.runs.markCopied(run.runId, toIsoJst());
        result.sent++;
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 412 || (error as { name?: string }).name === "PreconditionFailed") {
          // 既に同じキーがある。別の機会に写し済みなので、印だけ付ける
          this.runs.markCopied(run.runId, toIsoJst());
          result.alreadyCopied++;
          continue;
        }
        result.failureClass = classifyAwsError(error);
        result.remaining = pending.length - index;
        logLine("WARN", "runlog", `S3 への写しに失敗: ${result.failureClass} remaining=${result.remaining}`, run.runId);
        break; // 続けても同じ原因で失敗する。次の機会に古い順から送り直す
      }
    }
    return result;
  }
}
