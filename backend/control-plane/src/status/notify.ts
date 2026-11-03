// 設定の状況: メールでの知らせ（spec の 6.2）。送り先は既存の SNS トピック comegin-ops-alert（ハートビートのアラームと同じ受け口）。
// 「知らせるかどうか」を決める planNotifications は純粋な関数（時刻・記録・画面の形だけで決まる）。
// 送る sendNotifications は例外を上げない（送れなくても画面の表示と次の確認は止めない）。
//
// 知らせるのは次の 3 つだけ（✓ に戻ったときと ◇ は送らない）:
//   1. 項目が ● 更新が必要 か ! 警告 に新しくなった（前回の level と違う）→ 1 回の確認で 1 通にまとめる
//   2. ● か ! が残っているあいだ、1 日 1 回（JST の 09:00 以降の最初の確認で）まとめを 1 通
//   3. ? 確かめられなかった項目があり、それが 1 時間以上続いた → 1 通（確認そのものが壊れていると、ずれがあっても黙るため）。
//      ? は項目 id ごとに数える（恒久の ? が 1 つあっても、後から別の項目が ? になれば、それが 1 時間続いたときにまた知らせる）
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { fromIni } from "@aws-sdk/credential-providers";
import type { ControlPlaneConfig } from "../config.js";
import type { SetupStatusItemView, SetupStatusLevel, SetupStatusView } from "../contract.js";
import { classifyAwsError } from "../integrations/aws.js";
import { jstDate, toIsoJst } from "../time.js";

export interface NotifyLedger {
  /** 前回の確認での、項目 id ごとの level（「新しく ● か ! になった」の判定に使う） */
  lastLevels: Record<string, SetupStatusLevel>;
  /** まとめのメールを送った日（JST の YYYY-MM-DD） */
  digestSentOn: string | null;
  /**
   * ? 確かめられなかったが続いている項目（項目 id ごと）。since は続いている始まり（JST の ISO 8601）、notified は知らせ済みか。
   * ? でなくなった項目は消す（また ? になれば数え直す）
   */
  unknownItems: Record<string, UnknownEntry>;
  /** 手順の一覧（カタログ）を読めない状態が続いている始まり（JST の ISO 8601）。評価に進めない回の知らせ用で、? とは別に数える。古い保存には無い */
  catalogBrokenSince?: string | null;
  /** catalogBrokenSince からの状態を知らせ済みか。古い保存には無い */
  catalogBrokenNotified?: boolean;
}

export interface UnknownEntry {
  since: string;
  notified: boolean;
}

export function initialNotifyLedger(): NotifyLedger {
  return { lastLevels: {}, digestSentOn: null, unknownItems: {} };
}

export interface NotifyMessage {
  subject: string;
  body: string;
}

export interface PlanOptions {
  /** 監視アプリの画面の URL の根（末尾の / なし）。本文のリンク <linkBase>/setup-status?step=<段階 ID> に使う */
  linkBase: string;
  /** 秘密値を伏せる関数（service.ts の currentMask）。件名と本文に必ず通す */
  mask: (text: string) => string;
}

export type SendResult = { ok: true } | { ok: false; reason: string };

export const SUBJECT_PREFIX = "[ComeGin 設定の状況]";
/** まとめのメールを送る時刻（JST の時:分。これ以降の最初の確認で送る） */
export const DIGEST_TIME_JST = "09:00";
/** ? が続いたとき知らせるまでの長さ */
export const UNKNOWN_NOTIFY_AFTER_MS = 60 * 60 * 1000;
/**
 * SNS の件名は「改行・制御文字なし、100 文字未満」（Publish の Subject の制約）。
 * 99 文字までにする。UTF-16 の長さでも 99 を超えないように数える（サロゲートペアの途中で切らない）。
 */
export const SUBJECT_MAX_LENGTH = 99;
/** SNS のメッセージの上限は 256KB。日本語は 1 文字 3 バイトなので、文字数で余裕を持って切る */
export const BODY_MAX_CHARS = 50_000;
const SNS_TIMEOUT_MS = 30_000;

const LEVEL_LABEL: Record<SetupStatusLevel, string> = {
  ok: "済み",
  action: "更新が必要",
  warn: "警告",
  manual: "人が確かめる",
  unknown: "確かめられない",
};

/** 件名: 改行・制御文字（と行区切り・段落区切り）を空白 1 つにまとめ、99 文字（UTF-16 でも 99）以内に切る。切ったら末尾を … にする。 */
export function sanitizeSubject(subject: string): string {
  const flat = subject
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(flat);
  if (flat.length <= SUBJECT_MAX_LENGTH) return flat;
  let out = "";
  for (const ch of chars) {
    if (out.length + ch.length > SUBJECT_MAX_LENGTH - 1) break;
    out += ch;
  }
  return `${out}…`;
}

function truncateBody(body: string): string {
  const chars = Array.from(body);
  if (chars.length <= BODY_MAX_CHARS) return body;
  return `${chars.slice(0, BODY_MAX_CHARS).join("")}\n…（長いため以降を省いた。続きは監視アプリの画面で見る）`;
}

interface FlatItem {
  stepId: string;
  stepTitle: string;
  item: SetupStatusItemView;
}

function flatten(view: SetupStatusView): FlatItem[] {
  return view.steps.flatMap((step) => step.items.map((item) => ({ stepId: step.id, stepTitle: step.title, item })));
}

function countsLine(items: FlatItem[]): string {
  const action = items.filter((i) => i.item.level === "action").length;
  const warn = items.filter((i) => i.item.level === "warn").length;
  return `更新が必要 ${action} 件・警告 ${warn} 件`;
}

function itemBlock({ stepId, stepTitle, item }: FlatItem): string {
  const lines = [
    `■ ${stepId} ${stepTitle}`,
    `  項目: ${item.title}`,
    `  状態: ${LEVEL_LABEL[item.level]}`,
    `  根拠: ${item.evidence}`,
  ];
  if (item.stopId) lines.push(`  止まる id: ${item.stopId}`);
  return lines.join("\n");
}

function linksOf(items: FlatItem[], linkBase: string): string {
  const stepIds = [...new Set(items.map((i) => i.stepId))];
  return stepIds.map((id) => `${linkBase}/setup-status?step=${encodeURIComponent(id)}`).join("\n");
}

function buildMessage(subject: string, intro: string, items: FlatItem[], options: PlanOptions): NotifyMessage {
  const body = [intro, "", items.map(itemBlock).join("\n\n"), "", "監視アプリで見る:", linksOf(items, options.linkBase)].join("\n");
  return { subject: sanitizeSubject(options.mask(subject)), body: truncateBody(options.mask(body)) };
}

/** level の重い順（● が先、次に !）。同じ level の中では画面の順のまま。 */
function bySeverity(items: FlatItem[]): FlatItem[] {
  const rank = (l: SetupStatusLevel) => (l === "action" ? 0 : 1);
  return [...items].sort((a, b) => rank(a.item.level) - rank(b.item.level));
}

/**
 * 画面の形（view）・前回の記録・今の時刻から、送るメールと次の記録を決める。純粋な関数。
 * 判断には view だけを使う（保存した moduleResults には引き継いだ古い結果が入るため使わない）。
 *
 * 同じ確認でまとめ（毎日）と「新しく」が両方当てはまるときは、まとめだけを送る
 * （まとめには残っている ● と ! が全部載っており、新しい項目もその中にあるため。同じ内容を 2 通送らない）。
 * ? の知らせは別の理由なので、まとめ・「新しく」と一緒に送ってよい。
 *
 * 「全体の確認そのものが失敗」は、view に unknown の項目が 1 件以上あることとして扱う
 * （AWS・fetch・子プロセスの失敗は、どれも該当する項目が unknown になる）。
 */
export function planNotifications(
  prev: NotifyLedger,
  view: SetupStatusView,
  now: Date,
  options: PlanOptions,
): { messages: NotifyMessage[]; next: NotifyLedger } {
  const items = flatten(view);
  const alerts = items.filter((i) => i.item.level === "action" || i.item.level === "warn");
  const newlyBad = alerts.filter((i) => prev.lastLevels[i.item.id] !== i.item.level);
  const unknowns = items.filter((i) => i.item.level === "unknown");

  const nowIso = toIsoJst(now);
  const today = jstDate(now);
  const timeOfDay = nowIso.slice(11, 16); // HH:MM（JST）

  const next: NotifyLedger = {
    ...prev,
    // ? の項目は前回の level を残す（確かめられなかっただけで、状態が変わったとは分からない。
    // ● → ? → ● で「新しく ●」を送り直さないため）。前回が無い項目は載せない。? 以外は今の level で上書きする
    lastLevels: Object.fromEntries(
      items.flatMap((i): [string, SetupStatusLevel][] => {
        if (i.item.level !== "unknown") return [[i.item.id, i.item.level]];
        const before = prev.lastLevels[i.item.id];
        return before === undefined ? [] : [[i.item.id, before]];
      }),
    ),
    digestSentOn: prev.digestSentOn,
    unknownItems: {},
  };
  const messages: NotifyMessage[] = [];

  // 毎日のまとめ
  const digestDue = alerts.length > 0 && timeOfDay >= DIGEST_TIME_JST && prev.digestSentOn !== today;
  if (digestDue) {
    messages.push(
      buildMessage(
        `${SUBJECT_PREFIX} 毎日のまとめ: ${countsLine(alerts)}`,
        "残っている項目の一覧です（更新が必要・警告）。",
        bySeverity(alerts),
        options,
      ),
    );
    next.digestSentOn = today;
  } else if (newlyBad.length > 0) {
    // 新しく ● か ! になった項目（まとめを送る回は、まとめに載るので送らない）
    messages.push(
      buildMessage(
        `${SUBJECT_PREFIX} ${countsLine(newlyBad)}`,
        "新しく更新が必要・警告になった項目です。",
        bySeverity(newlyBad),
        options,
      ),
    );
  }

  // ? が 1 時間以上続いた（項目 id ごとに数える。? でなくなった項目は載せない＝消える）
  const prevUnknown = prev.unknownItems ?? {};
  const due: FlatItem[] = [];
  for (const i of unknowns) {
    const before = prevUnknown[i.item.id];
    const entry: UnknownEntry =
      before && Number.isFinite(Date.parse(before.since)) ? { since: before.since, notified: before.notified } : { since: nowIso, notified: false };
    next.unknownItems[i.item.id] = entry;
    if (!entry.notified && now.getTime() - Date.parse(entry.since) >= UNKNOWN_NOTIFY_AFTER_MS) due.push(i);
  }
  if (due.length > 0) {
    const oldest = due.map((i) => next.unknownItems[i.item.id]!.since).sort()[0]!;
    messages.push(
      buildMessage(
        `${SUBJECT_PREFIX} 確かめられない状態が続いている`,
        `確かめられない項目が ${due.length} 件、1 時間以上続いています（早いものは ${oldest} から）。確認そのものが壊れていると、ずれがあっても知らせが出なくなります。`,
        due,
        options,
      ),
    );
    for (const i of due) next.unknownItems[i.item.id] = { ...next.unknownItems[i.item.id]!, notified: true };
  }

  return { messages, next };
}

export interface CatalogBrokenState {
  since: string | null;
  notified: boolean;
}

/**
 * 手順の一覧（カタログ）を読めない回の知らせ。評価に進めないので planNotifications は呼べない（呼ぶと ? の数えと lastLevels を壊す）。
 * ここでは catalogBroken の 2 つだけを扱い、unknownItems・lastLevels には触れない。
 * 1 時間以上続いて未通知なら 1 通。notified は送れたときだけ立てる（呼び出し側が結果を見て決める: message があれば送れたら notified=true にする）。
 */
export function planCatalogBroken(
  prev: CatalogBrokenState,
  now: Date,
  reason: string,
  options: PlanOptions,
): { message: NotifyMessage | null; next: CatalogBrokenState } {
  const nowIso = toIsoJst(now);
  const since = prev.since !== null && Number.isFinite(Date.parse(prev.since)) ? prev.since : nowIso;
  const state: CatalogBrokenState = { since, notified: since === prev.since ? prev.notified : false };
  if (state.notified || now.getTime() - Date.parse(since) < UNKNOWN_NOTIFY_AFTER_MS) return { message: null, next: state };
  const body = [
    `手順の一覧を 1 時間以上読めていません（${since} から）。評価そのものができないため、ずれがあっても知らせが出ない状態です。`,
    "",
    `理由: ${reason}`,
    "",
    "監視アプリで見る:",
    `${options.linkBase}/setup-status`,
  ].join("\n");
  return {
    message: {
      subject: sanitizeSubject(options.mask(`${SUBJECT_PREFIX} 手順の一覧を読めない状態が続いている`)),
      body: truncateBody(options.mask(body)),
    },
    next: state,
  };
}

/**
 * 送れなかった回の記録。知らせに紐づくもの（lastLevels・digestSentOn・unknownItems の notified）は進めず、次の確認で送り直す。
 * ? の項目と始まり（unknownItems の since）は観測なので進める（進めないと、送れないあいだ「1 時間」の数え始めが毎回延びる）。
 */
export function ledgerAfterFailedSend(prev: NotifyLedger, next: NotifyLedger): NotifyLedger {
  const prevUnknown = prev.unknownItems ?? {};
  const unknownItems: Record<string, UnknownEntry> = {};
  for (const [id, entry] of Object.entries(next.unknownItems)) {
    const before = prevUnknown[id];
    unknownItems[id] = { since: entry.since, notified: before !== undefined && before.since === entry.since ? before.notified : false };
  }
  return { ...prev, unknownItems };
}

type PublishClient = Pick<SNSClient, "send">;

function createSnsClient(status: NonNullable<ControlPlaneConfig["status"]>): SNSClient {
  return new SNSClient({
    region: status.region,
    // 専用の資格情報ファイルの 1 つのプロファイルだけを読む（configFilepath を /dev/null にして、利用者の SSO などのプロファイルを拾わない）
    credentials: fromIni({ profile: status.awsProfile, filepath: status.awsCredentialsFile, configFilepath: "/dev/null" }),
  });
}

/**
 * メールを SNS に出す。1 通でも失敗したら、そこで止めて失敗を返す（例外は上げない）。
 * reason は失敗の種類だけ（classifyAwsError。エラー文は資格情報などを含みうるので出さない）。
 */
export async function sendNotifications(
  messages: NotifyMessage[],
  status: NonNullable<ControlPlaneConfig["status"]>,
  client?: PublishClient,
  signal?: AbortSignal,
): Promise<SendResult> {
  if (messages.length === 0) return { ok: true };
  try {
    const sns = client ?? createSnsClient(status);
    for (const message of messages) {
      const timeout = AbortSignal.timeout(SNS_TIMEOUT_MS);
      await sns.send(
        new PublishCommand({
          TopicArn: status.alertTopicArn,
          Subject: sanitizeSubject(message.subject),
          Message: truncateBody(message.body),
        }),
        { abortSignal: signal ? AbortSignal.any([timeout, signal]) : timeout },
      );
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: classifyAwsError(error) };
  }
}
