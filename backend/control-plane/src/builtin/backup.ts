// builtin backup（2026-11-12）。オンプレのディスクにしか無いものを、S3（E-15 の写しと同じバケット）に毎晩置く。
//   A. E-15 の SQLite（実行の記録・改善の周・項目・承認・実行モデルの選択と履歴・kv）を丸ごと固めた 1 ファイル
//      → backups/e15/YYYY/MM/DD/e15-<HHmmss>-<ULID>.sqlite（日付は日本時間）。毎回新しいキーに置く（追記だけ）
//      固め方は SQLite の VACUUM INTO（書き込み中でも一貫した 1 時点の写しになる。データディレクトリの中に一時ファイルを作り、送ったら消す）
//   C. エージェントの作業場の観測（E-12。docs/audits/<source>/AUD-*.md。コミットされず作業場にしか無い）
//      → audits/<source>/<audit_id>.md。中身が変わったものは audits/<source>/<audit_id>.<sha256 の先頭 12 桁>.md に足す
//      送った版（sha256）は kv の backup:audit:<source>/<audit_id> に覚え、同じ中身は送り直さない
//   D. C の後、作業場の古い観測を作業場の外（データディレクトリの audits-archive/<source>/。エージェントから読めない）へ移す（2026-11-17）
//      エージェントの Glob は更新の古い順に 100 件で打ち切られ、溜まると新しい観測から見えなくなるため。移すのは次をすべて満たすものだけ:
//        audit_id の日付が今日（JST）から AUDIT_KEEP_DAYS 日より前 ／ 同じ source・同じ target_ref の最新ではない
//        ／ 今の中身が S3 に送った版（kv）と同じ ／ main のチェックアウトに同じパスが無い（追跡されているファイルを消さない）
//      監視アプリの画面は移した先も読む（definitions/audits.ts）
// バケットのポリシーは If-None-Match: * の無い PutObject を拒む（上書きさせない）。単発の PutObject だけを使う（runlog.ts と同じ）。
// 正本はオンプレのまま（SQLite と作業場）。ここに置くのは、ディスクを失ったときに戻すためのもの。戻し方は README の「バックアップ」。
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { BuiltinHandler, RunResult } from "../context.js";
import type { FailureClass } from "../contract.js";
import { CONTROL_TIMEOUT_SEC } from "../constants/timeouts.js";
import { AUDIT_ARCHIVE_SUBDIR, AUDITS_DIR } from "../constants/paths.js";
import { AUDIT_ID_PATTERN, auditDateOf, jstAuditDate, targetRefOf } from "../definitions/audits.js";
import { classifyAwsError, createS3Client } from "../integrations/aws.js";
import { logLine } from "../log.js";
import { toIsoJst } from "../time.js";
import { ulid } from "../ulid.js";

/** cloud/stacks/runlog-archive.yaml・iam.yaml の BackupKeyPrefix・AuditKeyPrefix と一致させる */
export const E15_BACKUP_PREFIX = "backups/e15/";
export const AUDIT_COPY_PREFIX = "audits/";
/** 固めた SQLite の上限（単発の PutObject は 5 GB まで。メモリに読むので小さく抑える） */
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;
/** 観測 1 件の上限 */
const MAX_AUDIT_BYTES = 1024 * 1024;
/** 1 回に送る観測の上限（溜まった分は次の夜に続きを送る） */
const MAX_AUDITS_PER_RUN = 500;
const SOURCE_DIR = /^[a-z][a-z0-9_-]*$/;
/**
 * D. 作業場に残す観測の日数（audit_id の日付で数える）。proposal-writer が根拠にできる 14 日（起票前チェックの検査 3）と、
 * 改善の検証の期間（既定 30 日。DA-01 の 7 節）を覆う
 */
export const AUDIT_KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const isPreconditionFailed = (error: unknown): boolean =>
  (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412 || (error as { name?: string }).name === "PreconditionFailed";

async function putOnce(client: S3Client, bucket: string, key: string, body: Uint8Array | string, contentType: string, signal: AbortSignal): Promise<"sent" | "exists"> {
  const timeout = AbortSignal.timeout(CONTROL_TIMEOUT_SEC.s3Put * 4 * 1000);
  try {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, IfNoneMatch: "*" }), {
      abortSignal: AbortSignal.any([timeout, signal]),
    });
    return "sent";
  } catch (error) {
    if (isPreconditionFailed(error)) return "exists";
    throw error;
  }
}

/** A. E-15 の SQLite を固めて送る。送ったキーと大きさを返す */
async function backupE15(input: Parameters<BuiltinHandler>[0], client: S3Client, bucket: string): Promise<{ key: string; bytes: number }> {
  const { ctx, signal } = input;
  const now = toIsoJst(); // 2026-11-12T07:20:00+09:00
  const [date, time] = [now.slice(0, 10), now.slice(11, 19).replaceAll(":", "")];
  const id = ulid();
  const temp = join(ctx.config.dataDir, `e15-snapshot-${id}.sqlite.tmp`);
  try {
    ctx.snapshotE15(temp);
    const size = (await stat(temp)).size;
    if (size > MAX_SNAPSHOT_BYTES) throw Object.assign(new Error(`E-15 が大きすぎる（${size} バイト）`), { failureClass: "invalid_response" as FailureClass });
    const key = `${E15_BACKUP_PREFIX}${date.replaceAll("-", "/")}/e15-${time}-${id}.sqlite`;
    await putOnce(client, bucket, key, await readFile(temp), "application/vnd.sqlite3", signal);
    return { key, bytes: size };
  } finally {
    await rm(temp, { force: true });
  }
}

/** C. 作業場の観測（E-12）のうち、まだ送っていない版を送る */
async function copyAudits(input: Parameters<BuiltinHandler>[0], client: S3Client, bucket: string) {
  const { ctx, signal } = input;
  const root = join(ctx.config.worktree, "docs/audits");
  const result = { sent: 0, unchanged: 0, skipped: 0, remaining: 0, failureClass: null as FailureClass | null };
  let sources: string[];
  try {
    sources = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && SOURCE_DIR.test(e.name)).map((e) => e.name).sort();
  } catch {
    return result; // 作業場に docs/audits が無い（観測がまだ無い）
  }
  let budget = MAX_AUDITS_PER_RUN;
  for (const source of sources) {
    const files = (await readdir(join(root, source))).filter((name) => name.endsWith(".md") && AUDIT_ID_PATTERN.test(name.slice(0, -3))).sort();
    for (const file of files) {
      if (signal.aborted) return result;
      const auditId = file.slice(0, -3);
      const kvKey = `backup:audit:${source}/${auditId}`;
      const body = await readFile(join(root, source, file));
      const sha = createHash("sha256").update(body).digest("hex");
      if (ctx.kv.get(kvKey) === sha) {
        result.unchanged++;
        continue;
      }
      if (body.byteLength > MAX_AUDIT_BYTES) {
        result.skipped++;
        logLine("WARN", "backup", `観測が 1 MiB を超えるため写さない: ${source}/${auditId}`);
        continue;
      }
      if (budget-- <= 0) {
        result.remaining++;
        continue;
      }
      try {
        const base = `${AUDIT_COPY_PREFIX}${source}/${auditId}`;
        // 最初の版は <audit_id>.md。既にある（中身が変わった・覚えた版を失った）ときは、版の印を付けた名前に足す
        if ((await putOnce(client, bucket, `${base}.md`, body, "text/markdown; charset=utf-8", signal)) === "exists") {
          await putOnce(client, bucket, `${base}.${sha.slice(0, 12)}.md`, body, "text/markdown; charset=utf-8", signal);
        }
        ctx.kv.set(kvKey, sha);
        result.sent++;
      } catch (error) {
        result.failureClass = classifyAwsError(error);
        logLine("WARN", "backup", `観測の写しに失敗: ${result.failureClass}（${source}/${auditId}）。残りは次の夜に送る`);
        return result; // 続けても同じ原因で失敗する
      }
    }
  }
  return result;
}

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** 1 つのファイルを移す。同じファイルシステムでなければ（EXDEV）写してから消す。移し先が既にあれば上書きしない */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(from, to, fsConstants.COPYFILE_EXCL);
    await unlink(from);
  }
}

/** D. 作業場の古い観測を、S3 に送ったことを確かめてから作業場の外へ移す */
async function archiveAudits(input: Parameters<BuiltinHandler>[0]) {
  const { ctx, signal } = input;
  const root = join(ctx.config.worktree, AUDITS_DIR);
  const mainRoot = join(ctx.config.mainCheckout, AUDITS_DIR);
  const archiveRoot = join(ctx.config.dataDir, AUDIT_ARCHIVE_SUBDIR);
  // この日付より前（文字列の大小 = 日付の前後）の観測を移す
  const cutoff = jstAuditDate(Date.now() - AUDIT_KEEP_DAYS * DAY_MS);
  const result = { moved: 0, notBackedUp: 0, conflicts: 0, failed: 0 };
  let sources: string[];
  try {
    sources = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && SOURCE_DIR.test(e.name)).map((e) => e.name).sort();
  } catch {
    return result;
  }
  for (const source of sources) {
    const auditIds = (await readdir(join(root, source)))
      .filter((name) => name.endsWith(".md") && AUDIT_ID_PATTERN.test(name.slice(0, -3)))
      .map((name) => name.slice(0, -3))
      .sort(); // 昇順 = 古い順（日付・連番）
    if (!auditIds.some((id) => auditDateOf(id) < cutoff)) continue;

    // target_ref ごとの最新（後に出てくるほど新しい）。seo-auditor の前回比と、更新の少ない source（serp・site_audit・market）の「最新」を残す
    const contents = new Map<string, Buffer>();
    const latestByTarget = new Map<string, string>();
    for (const auditId of auditIds) {
      const body = await readFile(join(root, source, `${auditId}.md`));
      contents.set(auditId, body);
      latestByTarget.set(targetRefOf(body.toString("utf8")) ?? "", auditId);
    }
    const keep = new Set(latestByTarget.values());

    for (const auditId of auditIds) {
      if (signal.aborted) return result;
      if (auditDateOf(auditId) >= cutoff || keep.has(auditId)) continue;
      const file = `${auditId}.md`;
      if (await exists(join(mainRoot, source, file))) continue; // main で追跡されている（作業場から消すと git の変更になる）
      const body = contents.get(auditId)!;
      const sha = createHash("sha256").update(body).digest("hex");
      if (ctx.kv.get(`backup:audit:${source}/${auditId}`) !== sha) {
        result.notBackedUp++; // S3 に送った版と違う（まだ送っていない・送った後に変わった）。次の夜に送ってから移す
        continue;
      }
      const from = join(root, source, file);
      const to = join(archiveRoot, source, file);
      try {
        await mkdir(join(archiveRoot, source), { recursive: true, mode: 0o700 });
        if (await exists(to)) {
          // 前に移した後で同じ ID の観測が作業場に戻った。同じ中身なら作業場の方を消し、違えば両方残す
          if (createHash("sha256").update(await readFile(to)).digest("hex") === sha) await unlink(from);
          else {
            result.conflicts++;
            logLine("WARN", "backup", `移し先に中身の違う同じ ID の観測があるため移さない: ${source}/${auditId}`);
            continue;
          }
        } else await moveFile(from, to);
        result.moved++;
      } catch (error) {
        result.failed++;
        logLine("WARN", "backup", `観測を作業場の外へ移せなかった: ${(error as NodeJS.ErrnoException).code ?? "不明"}（${source}/${auditId}）`);
      }
    }
  }
  return result;
}

export const backup: BuiltinHandler = async (input): Promise<RunResult> => {
  const aws = input.ctx.config.aws;
  if (!aws) throw new Error("AWS の設定が無い");
  const client = createS3Client(aws);

  let snapshot: { key: string; bytes: number } | null = null;
  let snapshotFailure: FailureClass | null = null;
  try {
    snapshot = await backupE15(input, client, aws.runlogBucket);
  } catch (error) {
    snapshotFailure = (error as { failureClass?: FailureClass }).failureClass ?? classifyAwsError(error);
    logLine("ERROR", "backup", `E-15 のスナップショットを送れなかった: ${snapshotFailure}`);
  }
  const audits = await copyAudits(input, client, aws.runlogBucket);
  // 送れたかどうかは観測ごとに kv で確かめるので、C が途中で失敗しても D は動かしてよい（送っていないものは移さない）
  const archived = input.signal.aborted ? null : await archiveAudits(input);

  const parts = [
    snapshot ? `E-15 のスナップショットを送った（${Math.ceil(snapshot.bytes / 1024)} KiB）` : `E-15 のスナップショットを送れなかった（${snapshotFailure}）`,
    `観測の写し: 送信 ${audits.sent} 件・変わらず ${audits.unchanged} 件${audits.remaining ? `・次の夜に回す ${audits.remaining} 件` : ""}${audits.skipped ? `・大きすぎて写さない ${audits.skipped} 件` : ""}`,
  ];
  if (archived && archived.moved + archived.notBackedUp + archived.conflicts + archived.failed > 0) {
    parts.push(
      `作業場から外した ${AUDIT_KEEP_DAYS} 日より前の観測: ${archived.moved} 件` +
        `${archived.notBackedUp ? `・S3 に未送信のため残した ${archived.notBackedUp} 件` : ""}` +
        `${archived.conflicts ? `・移し先と中身が違うため残した ${archived.conflicts} 件` : ""}` +
        `${archived.failed ? `・移せなかった ${archived.failed} 件` : ""}`,
    );
  }
  const failureClass = snapshotFailure ?? audits.failureClass;
  // スナップショットが送れないのは failure（周と承認の記録が守られていない）。観測だけの失敗は partial（次の夜に続きを送る）
  // 観測を移せなかった（D）のも partial（作業場に残るだけで失われない。次の夜にやり直す）
  const outcome = snapshotFailure ? "failure" : audits.failureClass || (archived?.failed ?? 0) > 0 ? "partial" : "success";
  return { outcome, summary: parts.join("。"), targetIds: snapshot ? [snapshot.key] : [], failureClass };
};
