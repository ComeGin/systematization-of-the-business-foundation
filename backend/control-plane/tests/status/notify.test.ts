// 知らせるかどうかの判断（純粋な関数）と、SNS への送信（クライアントは差し替え）。時刻は引数で渡す。
import { describe, expect, it, vi } from "vitest";
import type { ControlPlaneConfig } from "../../src/config.js";
import type { SetupStatusItemView, SetupStatusLevel, SetupStatusView } from "../../src/contract.js";
import {
  type NotifyLedger,
  planCatalogBroken,
  initialNotifyLedger,
  ledgerAfterFailedSend,
  planNotifications,
  sanitizeSubject,
  sendNotifications,
} from "../../src/status/notify.js";
import { redact } from "../../src/status/redact.js";

const LINK_BASE = "http://127.0.0.1:3200";
const identity = (text: string) => text;
const options = { linkBase: LINK_BASE, mask: identity };

const item = (id: string, level: SetupStatusLevel, extra: Partial<SetupStatusItemView> = {}): SetupStatusItemView => ({
  id,
  title: `見出し ${id}`,
  who: "人・端末",
  kind: "検査",
  level,
  evidence: `根拠 ${id}`,
  stopId: null,
  docs: [],
  checkedAt: null,
  ...extra,
});

/** items は「段階 ID → 項目」。段階の level は計画に使わないので ok 固定 */
function viewOf(steps: Record<string, SetupStatusItemView[]>): SetupStatusView {
  return {
    enabled: true,
    reason: null,
    checkedAt: null,
    nextCheckAt: null,
    running: false,
    counts: { ok: 0, action: 0, warn: 0, manual: 0, unknown: 0 },
    notifyError: null,
    steps: Object.entries(steps).map(([id, items]) => ({ id, title: `段階 ${id}`, level: "ok" as const, items })),
  };
}

/** JST の時刻から Date を作る */
const jst = (text: string) => new Date(`${text}+09:00`);
const ledger = (patch: Partial<NotifyLedger> = {}): NotifyLedger => ({ ...initialNotifyLedger(), ...patch });

describe("planNotifications", () => {
  describe("正常系", () => {
    it("入力: 前回 ok で今回 action なら 1 通（件名に件数、本文に段階 ID・見出し・状態・根拠・リンク）", () => {
      const prev = ledger({ lastLevels: { "P12.site": "ok" } });
      const view = viewOf({ P12: [item("P12.site", "action", { stopId: "next-js-prod:build" })] });
      const { messages, next } = planNotifications(prev, view, jst("2026-11-03T08:00:00"), options);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.subject).toBe("[ComeGin 設定の状況] 更新が必要 1 件・警告 0 件");
      const body = messages[0]!.body;
      expect(body).toContain("P12");
      expect(body).toContain("見出し P12.site");
      expect(body).toContain("更新が必要");
      expect(body).toContain("根拠 P12.site");
      expect(body).toContain("next-js-prod:build");
      expect(body.trimEnd().endsWith(`${LINK_BASE}/setup-status?step=P12`)).toBe(true);
      expect(next.lastLevels).toEqual({ "P12.site": "action" });
    });

    it("入力: 前回も action なら 0 通", () => {
      const prev = ledger({ lastLevels: { "P12.site": "action" } });
      const view = viewOf({ P12: [item("P12.site", "action")] });
      expect(planNotifications(prev, view, jst("2026-11-03T08:00:00"), options).messages).toEqual([]);
    });

    it("入力: 同じ確認で複数の項目が新しくなっても 1 通にまとめ、件名は ● と ! の件数、リンクは段階ごと", () => {
      const view = viewOf({
        P2: [item("P2.a", "action")],
        P12: [item("P12.a", "warn"), item("P12.b", "action")],
      });
      const { messages } = planNotifications(ledger(), view, jst("2026-11-03T08:00:00"), options);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.subject).toBe("[ComeGin 設定の状況] 更新が必要 2 件・警告 1 件");
      expect(messages[0]!.body).toContain(`${LINK_BASE}/setup-status?step=P2`);
      expect(messages[0]!.body).toContain(`${LINK_BASE}/setup-status?step=P12`);
    });

    it("入力: warn から action に変わったときも新しく ● になったとして知らせる", () => {
      const prev = ledger({ lastLevels: { a: "warn" } });
      const { messages } = planNotifications(prev, viewOf({ P1: [item("a", "action")] }), jst("2026-11-03T08:00:00"), options);
      expect(messages).toHaveLength(1);
    });

    it("入力: ok への戻りと manual は送らない", () => {
      const prev = ledger({ lastLevels: { a: "action", b: "warn" }, digestSentOn: "2026-11-03" });
      const view = viewOf({ P1: [item("a", "ok"), item("b", "ok"), item("c", "manual")] });
      const { messages, next } = planNotifications(prev, view, jst("2026-11-03T10:00:00"), options);
      expect(messages).toEqual([]);
      expect(next.lastLevels).toEqual({ a: "ok", b: "ok", c: "manual" });
    });

    it("入力: 08:59 JST はまとめを送らず、09:00 は送る（その日の記録を付ける）", () => {
      const prev = ledger({ lastLevels: { a: "action" } });
      const view = viewOf({ P1: [item("a", "action")] });
      expect(planNotifications(prev, view, jst("2026-11-03T08:59:59"), options).messages).toEqual([]);
      const at9 = planNotifications(prev, view, jst("2026-11-03T09:00:00"), options);
      expect(at9.messages).toHaveLength(1);
      expect(at9.messages[0]!.subject).toBe("[ComeGin 設定の状況] 毎日のまとめ: 更新が必要 1 件・警告 0 件");
      expect(at9.next.digestSentOn).toBe("2026-11-03");
    });

    it("入力: まとめは 1 日 1 回（同じ日の 2 回目は送らず、翌日の 09:00 には送る）", () => {
      const prev = ledger({ lastLevels: { a: "action" }, digestSentOn: "2026-11-03" });
      const view = viewOf({ P1: [item("a", "action")] });
      expect(planNotifications(prev, view, jst("2026-11-03T15:00:00"), options).messages).toEqual([]);
      expect(planNotifications(prev, view, jst("2026-11-04T09:10:00"), options).messages).toHaveLength(1);
    });

    it("入力: まとめの日付は JST で数える（UTC の前日 23:30 は JST の 08:30 でまだ送らない）", () => {
      const prev = ledger({ lastLevels: { a: "action" } });
      const view = viewOf({ P1: [item("a", "action")] });
      expect(planNotifications(prev, view, new Date("2026-11-03T23:30:00Z"), options).messages).toEqual([]); // JST 11-04 08:30
      expect(planNotifications(prev, view, new Date("2026-11-04T00:00:00Z"), options).next.digestSentOn).toBe("2026-11-04"); // JST 09:00
    });

    it("入力: ● も ! も無ければ 09:00 を過ぎてもまとめを送らない", () => {
      const view = viewOf({ P1: [item("a", "ok"), item("b", "manual"), item("c", "unknown")] });
      expect(planNotifications(ledger(), view, jst("2026-11-03T09:30:00"), options).messages).toEqual([]);
    });

    it("入力: まとめには残っている ● が先、次に ! の順で全部載る", () => {
      const prev = ledger({ lastLevels: { w: "warn", a: "action" } });
      const view = viewOf({ P1: [item("w", "warn"), item("a", "action")] });
      const { messages } = planNotifications(prev, view, jst("2026-11-03T09:00:00"), options);
      const body = messages[0]!.body;
      expect(body.indexOf("見出し a")).toBeLessThan(body.indexOf("見出し w"));
    });

    it("入力: まとめと「新しく」が同じ回に当てはまるときは、まとめの 1 通だけ（同じ内容を 2 通送らない）", () => {
      const view = viewOf({ P1: [item("new", "action"), item("old", "warn")] });
      const prev = ledger({ lastLevels: { old: "warn" } });
      const { messages, next } = planNotifications(prev, view, jst("2026-11-03T09:00:00"), options);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.subject).toContain("毎日のまとめ");
      expect(messages[0]!.body).toContain("見出し new");
      expect(messages[0]!.body).toContain("見出し old");
      expect(next.lastLevels).toEqual({ new: "action", old: "warn" });
    });

    it("入力: unknown が 59 分は 0 通・60 分で 1 通・その後は 0 通", () => {
      const view = viewOf({ P1: [item("u", "unknown", { evidence: "AWS に届かない" })] });
      const t0 = jst("2026-11-03T02:00:00");
      const first = planNotifications(ledger(), view, t0, options);
      expect(first.messages).toEqual([]);
      expect(first.next.unknownItems).toEqual({ u: { since: "2026-11-03T02:00:00.000+09:00", notified: false } });

      const at59 = planNotifications(first.next, view, new Date(t0.getTime() + 59 * 60_000), options);
      expect(at59.messages).toEqual([]);
      expect(at59.next.unknownItems.u!.notified).toBe(false);

      const at60 = planNotifications(at59.next, view, new Date(t0.getTime() + 60 * 60_000), options);
      expect(at60.messages).toHaveLength(1);
      expect(at60.messages[0]!.subject).toBe("[ComeGin 設定の状況] 確かめられない状態が続いている");
      expect(at60.messages[0]!.body).toContain("AWS に届かない");
      expect(at60.next.unknownItems.u).toEqual({ since: "2026-11-03T02:00:00.000+09:00", notified: true });

      const at70 = planNotifications(at60.next, view, new Date(t0.getTime() + 70 * 60_000), options);
      expect(at70.messages).toEqual([]);
      expect(at70.next.unknownItems).toEqual(at60.next.unknownItems);
    });

    it("入力: 項目が ? でなくなったら、その項目の数えを消し、また ? になれば数え直す", () => {
      const unknownView = viewOf({ P1: [item("u", "unknown")] });
      const okView = viewOf({ P1: [item("u", "ok")] });
      const t0 = jst("2026-11-03T02:00:00");
      const notified = ledger({ unknownItems: { u: { since: "2026-11-03T00:00:00.000+09:00", notified: true } } });
      const recovered = planNotifications(notified, okView, t0, options);
      expect(recovered.next.unknownItems).toEqual({});
      const again = planNotifications(recovered.next, unknownView, new Date(t0.getTime() + 10 * 60_000), options);
      expect(again.messages).toEqual([]);
      expect(again.next.unknownItems).toEqual({ u: { since: "2026-11-03T02:10:00.000+09:00", notified: false } });
    });

    it("入力: ずっと ? の項目 A を知らせた後、別の項目 B が ? になれば、B が 1 時間続いたときに B だけの 1 通を送る", () => {
      const t0 = jst("2026-11-03T02:00:00");
      const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
      const onlyA = viewOf({ P14: [item("A", "unknown", { evidence: "A の根拠" }), item("B", "ok")] });
      const both = viewOf({ P14: [item("A", "unknown", { evidence: "A の根拠" }), item("B", "unknown", { evidence: "B の根拠" })] });

      const start = planNotifications(ledger(), onlyA, t0, options);
      const notifyA = planNotifications(start.next, onlyA, at(60), options);
      expect(notifyA.messages).toHaveLength(1);
      expect(notifyA.messages[0]!.body).toContain("A の根拠");
      expect(notifyA.next.unknownItems.A!.notified).toBe(true);

      // A は知らせ済みのまま。B が新しく ? になる（ここから数える）
      const bStarts = planNotifications(notifyA.next, both, at(120), options);
      expect(bStarts.messages).toEqual([]);
      expect(bStarts.next.unknownItems.B).toEqual({ since: "2026-11-03T04:00:00.000+09:00", notified: false });

      const b59 = planNotifications(bStarts.next, both, at(179), options);
      expect(b59.messages).toEqual([]);

      const b60 = planNotifications(b59.next, both, at(180), options);
      expect(b60.messages).toHaveLength(1);
      expect(b60.messages[0]!.subject).toBe("[ComeGin 設定の状況] 確かめられない状態が続いている");
      expect(b60.messages[0]!.body).toContain("B の根拠");
      expect(b60.messages[0]!.body).not.toContain("A の根拠");
      expect(b60.messages[0]!.body).toContain("確かめられない項目が 1 件");
      expect(b60.next.unknownItems).toEqual({
        A: { since: "2026-11-03T02:00:00.000+09:00", notified: true },
        B: { since: "2026-11-03T04:00:00.000+09:00", notified: true },
      });

      // 以後は A も B も黙る
      expect(planNotifications(b60.next, both, at(300), options).messages).toEqual([]);
    });

    it("入力: 同じ回に 1 時間を超えた項目が複数あれば、1 通にまとめる", () => {
      const view = viewOf({ P1: [item("a", "unknown"), item("b", "unknown")] });
      const t0 = jst("2026-11-03T02:00:00");
      const start = planNotifications(ledger(), view, t0, options);
      const later = planNotifications(start.next, view, new Date(t0.getTime() + 60 * 60_000), options);
      expect(later.messages).toHaveLength(1);
      expect(later.messages[0]!.body).toContain("確かめられない項目が 2 件");
    });

    it("入力: ? の知らせは、まとめ・「新しく」と同じ回に別の 1 通として送る", () => {
      const view = viewOf({ P1: [item("a", "action"), item("u", "unknown")] });
      const prev = ledger({
        lastLevels: { a: "action" },
        digestSentOn: "2026-11-02",
        unknownItems: { u: { since: "2026-11-03T07:00:00.000+09:00", notified: false } },
      });
      const { messages } = planNotifications(prev, view, jst("2026-11-03T09:00:00"), options);
      expect(messages.map((m) => m.subject)).toEqual([
        "[ComeGin 設定の状況] 毎日のまとめ: 更新が必要 1 件・警告 0 件",
        "[ComeGin 設定の状況] 確かめられない状態が続いている",
      ]);
    });

    it("入力: 本文に prod.conf の値があれば伏せ字（件名も）", () => {
      const secret = "prod-conf-secret-value";
      const mask = (text: string) => redact(text, [secret]);
      const view = viewOf({ P7: [item("P7.a", "action", { evidence: `トークン ${secret} が古い`, title: `見出し ${secret}` })] });
      const { messages } = planNotifications(ledger(), view, jst("2026-11-03T08:00:00"), { linkBase: LINK_BASE, mask });
      expect(messages[0]!.body).not.toContain(secret);
      expect(messages[0]!.body).toContain("トークン [伏せ字] が古い");
      expect(messages[0]!.subject).not.toContain(secret);
    });

    it("入力: 件名が長いとき、改行を除いて切る", () => {
      const view = viewOf({ P1: [item("a", "action")] });
      const { messages } = planNotifications(ledger(), view, jst("2026-11-03T08:00:00"), {
        linkBase: LINK_BASE,
        mask: (text) => `${text}\n${"あ".repeat(200)}`,
      });
      expect(messages[0]!.subject).not.toMatch(/[\n\r]/);
      expect(messages[0]!.subject.length).toBeLessThanOrEqual(99);
    });

    it("入力: action → unknown → action では「新しく」を送り直さない（? の間は前回の level を残す）", () => {
      const at = jst("2026-11-03T08:00:00");
      const first = planNotifications(ledger(), viewOf({ P1: [item("a", "action")] }), at, options);
      expect(first.messages).toHaveLength(1);
      const unknown = planNotifications(first.next, viewOf({ P1: [item("a", "unknown")] }), at, options);
      expect(unknown.messages).toEqual([]);
      expect(unknown.next.lastLevels).toEqual({ a: "action" });
      const back = planNotifications(unknown.next, viewOf({ P1: [item("a", "action")] }), at, options);
      expect(back.messages).toEqual([]);
    });

    it("入力: action → ok → action では「新しく」を 1 通送る（ok は上書きする）", () => {
      const at = jst("2026-11-03T08:00:00");
      const first = planNotifications(ledger(), viewOf({ P1: [item("a", "action")] }), at, options);
      const ok = planNotifications(first.next, viewOf({ P1: [item("a", "ok")] }), at, options);
      expect(ok.next.lastLevels).toEqual({ a: "ok" });
      expect(planNotifications(ok.next, viewOf({ P1: [item("a", "action")] }), at, options).messages).toHaveLength(1);
    });

    it("入力: 前回の level が無い項目が ? のときは lastLevels に載せず、次に action になれば新しい", () => {
      const at = jst("2026-11-03T08:00:00");
      const unknown = planNotifications(ledger(), viewOf({ P1: [item("a", "unknown")] }), at, options);
      expect(unknown.next.lastLevels).toEqual({});
      expect(planNotifications(unknown.next, viewOf({ P1: [item("a", "action")] }), at, options).messages).toHaveLength(1);
    });
  });

  describe("異常系", () => {
    it("空入力: 項目が無い view では何も送らず、記録だけ空に戻す", () => {
      const prev = ledger({ lastLevels: { a: "action" }, unknownItems: { u: { since: "2026-11-03T00:00:00.000+09:00", notified: true } } });
      const { messages, next } = planNotifications(prev, viewOf({}), jst("2026-11-03T10:00:00"), options);
      expect(messages).toEqual([]);
      expect(next).toMatchObject({ lastLevels: {}, unknownItems: {} });
    });

    it("入力: 項目の since が壊れた文字列なら、今の時刻から数え直す", () => {
      const view = viewOf({ P1: [item("u", "unknown")] });
      const prev = ledger({ unknownItems: { u: { since: "壊れた値", notified: true } } });
      const { messages, next } = planNotifications(prev, view, jst("2026-11-03T03:00:00"), options);
      expect(messages).toEqual([]);
      expect(next.unknownItems).toEqual({ u: { since: "2026-11-03T03:00:00.000+09:00", notified: false } });
    });
  });
});

describe("sanitizeSubject", () => {
  describe("正常系", () => {
    it("入力: 改行・タブ・制御文字・行区切りは空白 1 つにまとめる", () => {
      expect(sanitizeSubject("a\r\nb\tc\u0000d e")).toBe("a b c d e");
    });

    it("入力: 99 文字までは切らない", () => {
      expect(sanitizeSubject("あ".repeat(99))).toBe("あ".repeat(99));
    });

    it("入力: 100 文字以上は 99 文字以内に切り、末尾を … にする", () => {
      const out = sanitizeSubject("あ".repeat(150));
      expect(out.length).toBeLessThanOrEqual(99);
      expect(out.endsWith("…")).toBe(true);
    });

    it("入力: サロゲートペアの途中では切らない（切った結果が不正な文字を含まない）", () => {
      const out = sanitizeSubject("😀".repeat(80)); // 1 文字が UTF-16 で 2
      expect(out.length).toBeLessThanOrEqual(99);
      expect(out.endsWith("…")).toBe(true);
      expect(out.isWellFormed()).toBe(true);
      expect(Array.from(out.slice(0, -1)).every((c) => c === "😀")).toBe(true);
    });
  });

  describe("異常系", () => {
    it("空入力: 空文字は空のまま", () => {
      expect(sanitizeSubject("")).toBe("");
    });
  });
});

describe("ledgerAfterFailedSend", () => {
  describe("正常系", () => {
    it("入力: 知らせに紐づく項目（notified を含む）は進めず、? の項目と始まりだけ進める", () => {
      const prev = ledger({ lastLevels: { a: "ok" }, digestSentOn: null, unknownItems: { old: { since: "S0", notified: true } } });
      const next = ledger({
        lastLevels: { a: "action" },
        digestSentOn: "2026-11-03",
        unknownItems: { old: { since: "S0", notified: true }, u: { since: "S", notified: true } },
      });
      expect(ledgerAfterFailedSend(prev, next)).toEqual({
        lastLevels: { a: "ok" },
        digestSentOn: null,
        unknownItems: { old: { since: "S0", notified: true }, u: { since: "S", notified: false } },
      });
    });

    it("入力: ? でなくなった項目は消す", () => {
      const prev = ledger({ unknownItems: { u: { since: "S", notified: true } } });
      const next = ledger({ unknownItems: {} });
      expect(ledgerAfterFailedSend(prev, next).unknownItems).toEqual({});
    });
  });
});

describe("sendNotifications", () => {
  const status = {
    awsCredentialsFile: "/nonexistent/aws-credentials",
    awsProfile: "default",
    githubTokenFile: "/nonexistent/github-token",
    alertTopicArn: "arn:aws:sns:ap-northeast-1:123456789012:comegin-ops-alert",
    linkBase: LINK_BASE,
    region: "ap-northeast-1",
    repository: "ComeGin/example",
    siteUrl: "https://www.example.test",
  } satisfies NonNullable<ControlPlaneConfig["status"]>;

  describe("正常系", () => {
    it("入力: 1 通ごとに Publish し、トピック・件名・本文を渡す", async () => {
      const send = vi.fn(async () => ({}));
      const result = await sendNotifications(
        [
          { subject: "件名1", body: "本文1" },
          { subject: "件名2", body: "本文2" },
        ],
        status,
        { send } as never,
      );
      expect(result).toEqual({ ok: true });
      expect(send).toHaveBeenCalledTimes(2);
      const input = (send.mock.calls[0] as unknown as [{ input: Record<string, string> }])[0].input;
      expect(input).toEqual({ TopicArn: status.alertTopicArn, Subject: "件名1", Message: "本文1" });
    });

    it("空入力: 送るものが無ければ何も呼ばず ok", async () => {
      const send = vi.fn();
      expect(await sendNotifications([], status, { send } as never)).toEqual({ ok: true });
      expect(send).not.toHaveBeenCalled();
    });

    it("入力: 件名の改行と長さは送る直前にも整える", async () => {
      const send = vi.fn(async () => ({}));
      await sendNotifications([{ subject: `a\nb${"あ".repeat(200)}`, body: "x" }], status, { send } as never);
      const subject = (send.mock.calls[0] as unknown as [{ input: { Subject: string } }])[0].input.Subject;
      expect(subject).not.toContain("\n");
      expect(subject.length).toBeLessThanOrEqual(99);
    });
  });

  describe("異常系", () => {
    it("サーバ: 送信が失敗しても例外は上げず、失敗の種類だけ返す（エラー文は返さない）", async () => {
      const error = Object.assign(new Error("Credential secret-value-123 is expired"), {
        name: "ExpiredTokenException",
        $metadata: { httpStatusCode: 403 },
      });
      const send = vi.fn(async () => {
        throw error;
      });
      const result = await sendNotifications([{ subject: "s", body: "b" }], status, { send } as never);
      expect(result).toEqual({ ok: false, reason: "auth_failed" });
      expect(JSON.stringify(result)).not.toContain("secret-value-123");
    });

    it("サーバ: 1 通目が失敗したら 2 通目は送らない", async () => {
      const send = vi.fn(async () => {
        throw Object.assign(new Error("x"), { name: "ThrottlingException" });
      });
      const result = await sendNotifications(
        [
          { subject: "1", body: "1" },
          { subject: "2", body: "2" },
        ],
        status,
        { send } as never,
      );
      expect(result).toEqual({ ok: false, reason: "rate_limited" });
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("入力: 資格情報のファイルが無いとき（クライアントを差し替えない）も例外は上げない", async () => {
      const result = await sendNotifications([{ subject: "s", body: "b" }], status);
      expect(result.ok).toBe(false);
    });
  });
});

describe("planCatalogBroken", () => {
  const reason = "手順の一覧を読めない（CatalogError: 無い）";
  const state = { since: null as string | null, notified: false };
  const t0 = jst("2026-11-03T02:00:00");

  describe("正常系", () => {
    it("入力: 59 分は 0 通・60 分で 1 通（件名・理由・リンク）・その後は 0 通", () => {
      const first = planCatalogBroken(state, t0, reason, options);
      expect(first.message).toBeNull();
      expect(first.next).toEqual({ since: "2026-11-03T02:00:00.000+09:00", notified: false });

      const at59 = planCatalogBroken(first.next, new Date(t0.getTime() + 59 * 60_000), reason, options);
      expect(at59.message).toBeNull();

      const at60 = planCatalogBroken(at59.next, new Date(t0.getTime() + 60 * 60_000), reason, options);
      expect(at60.message?.subject).toBe("[ComeGin 設定の状況] 手順の一覧を読めない状態が続いている");
      expect(at60.message?.body).toContain(reason);
      expect(at60.message?.body.trimEnd().endsWith(`${LINK_BASE}/setup-status`)).toBe(true);
    });

    it("入力: 通知済みなら、その後は何時間たっても 0 通", () => {
      const notified = { since: "2026-11-03T00:00:00.000+09:00", notified: true };
      expect(planCatalogBroken(notified, jst("2026-11-03T20:00:00"), reason, options).message).toBeNull();
    });

    it("入力: 理由の秘密値は伏せ字", () => {
      const secret = "catalog-secret-value";
      const mask = (text: string) => redact(text, [secret]);
      const prev = { since: "2026-11-03T00:00:00.000+09:00", notified: false };
      const { message } = planCatalogBroken(prev, jst("2026-11-03T03:00:00"), `読めない ${secret}`, { linkBase: LINK_BASE, mask });
      expect(message?.body).not.toContain(secret);
      expect(message?.body).toContain("読めない [伏せ字]");
    });
  });

  describe("異常系", () => {
    it("入力: since が壊れた文字列なら今から数え直す（通知済みも戻す）", () => {
      const { message, next } = planCatalogBroken({ since: "壊れた値", notified: true }, t0, reason, options);
      expect(message).toBeNull();
      expect(next).toEqual({ since: "2026-11-03T02:00:00.000+09:00", notified: false });
    });
  });
});
