// I-11 Mautic → n8n（POST /webhook/mautic-event）と、そこから呼ばれる I-21（開発は MailHog）の結合テスト。
// 開発の n8n の本物のワークフローに、Mautic と同じ形で署名した本文を送る。鍵は provision が作った Mautic の Webhook「n8n I-11」の
// シークレット（Mautic の API で読む）。本文の形は Mautic の WebhookModel::getWebhookPayload（{種別: [{…, timestamp}]}）と
// I-11 の Code ノード「イベント分割とキー生成」に合わせた。
//
// 親の I-11 は開発では未公開が既定なので、このファイルの間だけ有効にして、最後に必ず元に戻す。
// 冪等キー（contact_id|種別|timestamp）は数値の ID しか持たないので、合成する contact_id を 7 億台の実行ごとの値にして絞る（support.ts の idSequence）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { activateForTest } from "../helpers/n8n.ts";
import { itEmail, itName } from "../helpers/run-id.ts";
import { expectNever } from "../helpers/wait.ts";
import { alerts, decodeBody, idSequence, mauticWebhookSecret, N8nWindow, postWebhook, rows, signMautic, waitForList } from "./support.ts";

const nextId = idSequence();
const n8nWindow = new N8nWindow();
let secret = "";
let restore: () => Promise<void> = async () => {};

// 2026-10-07 10:00 JST（Mautic は ISO 8601 のオフセット付きで送る）
const TIMESTAMP = "2026-10-07T10:00:00+09:00";
const TIMESTAMP_SEC = Date.parse(TIMESTAMP) / 1000;

const formSubmit = (contactId: number, overrides: { alias?: string; company?: string; timestamp?: string } = {}) => ({
  submission: {
    id: contactId,
    lead: { id: contactId, fields: { core: { company: { value: overrides.company ?? "" }, email: { value: itEmail(`form-${contactId}`) } } } },
    form: { id: 1, alias: overrides.alias ?? "consult" },
  },
  timestamp: overrides.timestamp ?? TIMESTAMP,
});

/** 署名付きで送る（signWith を変えると別の鍵の署名になる） */
const send = (body: unknown, signWith?: string) => {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return postWebhook("mautic-event", raw, { "webhook-signature": signMautic(raw, signWith ?? secret) });
};

const dedupRows = (contactId: number) => rows("dedup_mautic", [{ columnName: "contactId", condition: "eq", value: contactId }]);

/** 署名を通らなかった・読み飛ばした要求が、何も残さないこと（後続は非同期なので、しばらく見張る） */
const expectNothingRecorded = (contactId: number) =>
  expectNever(async () => (await dedupRows(contactId)).length > 0 || (await alerts(`(contact ${contactId})`)).length > 0, { durationMs: 6_000, what: `contact ${contactId} の記録か通知` });

beforeAll(async () => {
  secret = await mauticWebhookSecret();
  await n8nWindow.open();
  ({ restore } = await activateForTest("I-11 "));
});

afterAll(async () => {
  try {
    await restore();
    // 無効にする前に受けた要求の後続（Code ノード → Data Table → I-21）が終わるのを待ってから消す
    await new Promise((r) => setTimeout(r, 3_000));
  } finally {
    await n8nWindow.close();
  }
});

describe("I-11 Mautic Webhook の受領と重複排除（POST /webhook/mautic-event）", () => {
  describe("正常系", () => {
    it("署名が正しい無料相談フォームの送信は 200 を返し、冪等キーを記録し、I-21 が demo-requested を通知する（本文に email を載せない）", async () => {
      const contactId = nextId();
      const company = itName("company");
      const res = await send({ "mautic.form_on_submit": [formSubmit(contactId, { company })] });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ status: "accepted" });

      const [row] = await waitForList(() => dedupRows(contactId), "dedup_mautic の行");
      expect(row).toMatchObject({ dedupKey: `${contactId}|mautic.form_on_submit|${TIMESTAMP_SEC}`, contactId, eventType: "mautic.form_on_submit", timestampSec: TIMESTAMP_SEC });

      const [mail] = await waitForList(() => alerts(`(contact ${contactId})`), "I-21 の通知");
      expect(mail!.Content.Headers.Subject?.[0]).toBe(`[comegin] lead: demo-requested (contact ${contactId})`);
      const body = decodeBody(mail!);
      expect(body).toContain("種別: demo-requested");
      expect(body).toContain(`会社名: ${company}`);
      expect(body).toContain(`システム上の ID: contact ${contactId}`);
      expect(body).toContain("受付: 2026-10-07 10:00 JST");
      expect(body).not.toContain("@example.com");
    });

    it("同じイベントの再送は 200 を返すが、冪等キーの行も通知も増えない", async () => {
      const contactId = nextId();
      const body = { "mautic.form_on_submit": [formSubmit(contactId)] };
      expect((await send(body)).status).toBe(200);
      await waitForList(() => alerts(`(contact ${contactId})`), "1 通目の通知");

      expect((await send(body)).status).toBe(200);
      await expectNever(async () => (await dedupRows(contactId)).length > 1 || (await alerts(`(contact ${contactId})`)).length > 1, { durationMs: 8_000, what: "再送での二重の記録か通知" });
      expect(await dedupRows(contactId)).toHaveLength(1);
    });

    it("同じ秒に出る別の種別（コンタクトの作成とフォーム送信）は別のキーで記録し、通知はフォーム送信の 1 通だけ", async () => {
      const contactId = nextId();
      const res = await send({
        "mautic.lead_post_save_new": [{ contact: { id: contactId, fields: { core: { company: { value: "" } } } }, timestamp: TIMESTAMP }],
        "mautic.form_on_submit": [formSubmit(contactId)],
      });
      expect(res.status).toBe(200);

      const recorded = await waitForList(() => dedupRows(contactId), "2 種別の行", 2);
      expect(recorded.map((r) => r.eventType).sort()).toEqual(["mautic.form_on_submit", "mautic.lead_post_save_new"]);
      await waitForList(() => alerts(`(contact ${contactId})`), "通知");
      await expectNever(async () => (await alerts(`(contact ${contactId})`)).length > 1, { durationMs: 4_000, what: "2 通目の通知" });
    });

    it("セグメント mql への追加は mql として通知する", async () => {
      const contactId = nextId();
      const res = await send({ "mautic.lead_list_change": [{ contact: { id: contactId }, segment: { id: 1, alias: "mql", name: "MQL" }, action: "added", timestamp: TIMESTAMP }] });
      expect(res.status).toBe(200);
      const [mail] = await waitForList(() => alerts(`(contact ${contactId})`), "mql の通知");
      expect(mail!.Content.Headers.Subject?.[0]).toBe(`[comegin] lead: mql (contact ${contactId})`);
    });

    it("無料 DL（source_dl）のフォーム送信とセグメントからの除外は、記録するが通知しない（BA-04）", async () => {
      const dl = nextId();
      const removed = nextId();
      expect((await send({ "mautic.form_on_submit": [formSubmit(dl, { alias: "source_dl" })] })).status).toBe(200);
      expect((await send({ "mautic.lead_list_change": [{ contact: { id: removed }, segment: { alias: "mql" }, action: "removed", timestamp: TIMESTAMP }] })).status).toBe(200);

      await waitForList(() => dedupRows(dl), "無料 DL の行");
      await waitForList(() => dedupRows(removed), "セグメントからの除外の行");
      await expectNever(async () => (await alerts(`(contact ${dl})`)).length > 0 || (await alerts(`(contact ${removed})`)).length > 0, { durationMs: 5_000, what: "通知" });
    });

    it("空入力: イベントの無い本文（{}）は、署名が正しければ 200 を返す（記録するものが無い）", async () => {
      const res = await send({});
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ status: "accepted" });
    });
  });

  describe("異常系", () => {
    it("入力: Webhook-Signature が無ければ 401 を返し、記録も通知もしない", async () => {
      const contactId = nextId();
      const res = await postWebhook("mautic-event", JSON.stringify({ "mautic.form_on_submit": [formSubmit(contactId)] }));
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: "unauthorized" });
      await expectNothingRecorded(contactId);
    });

    it("入力: 別の鍵で作った署名は 401", async () => {
      const contactId = nextId();
      const res = await send({ "mautic.form_on_submit": [formSubmit(contactId)] }, "not-the-webhook-secret");
      expect(res.status).toBe(401);
      await expectNothingRecorded(contactId);
    });

    it("入力: 署名した後で本文を書き換えると 401（署名は生の本文に対して検証する）", async () => {
      const contactId = nextId();
      const signed = JSON.stringify({ "mautic.form_on_submit": [formSubmit(contactId, { alias: "source_dl" })] });
      const tampered = signed.replace('"alias":"source_dl"', '"alias":"consult"');
      const res = await postWebhook("mautic-event", tampered, { "webhook-signature": signMautic(signed, secret) });
      expect(res.status).toBe(401);
      await expectNothingRecorded(contactId);
    });

    it("入力: 本文の空白を変えただけでも 401（JSON として同じでも、生の本文が違えば署名は合わない）", async () => {
      const contactId = nextId();
      const compact = JSON.stringify({ "mautic.form_on_submit": [formSubmit(contactId)] });
      const res = await postWebhook("mautic-event", JSON.stringify(JSON.parse(compact), null, 2), { "webhook-signature": signMautic(compact, secret) });
      expect(res.status).toBe(401);
      await expectNothingRecorded(contactId);
    });

    it("空入力: Webhook-Signature が空文字なら 401", async () => {
      const contactId = nextId();
      const res = await postWebhook("mautic-event", JSON.stringify({ "mautic.form_on_submit": [formSubmit(contactId)] }), { "webhook-signature": "" });
      expect(res.status).toBe(401);
      await expectNothingRecorded(contactId);
    });

    it("空入力: 本文が空（0 バイト）は、署名が無ければ 401、空の本文の正しい署名なら 200 を返して何もしない", async () => {
      expect((await postWebhook("mautic-event", "")).status).toBe(401);
      expect((await postWebhook("mautic-event", "", { "webhook-signature": signMautic("", secret) })).status).toBe(200);
    });

    it("入力: 本文が JSON でなければ、署名が正しくても n8n が 422 を返し、ワークフローは動かない", async () => {
      const raw = `not json ${itName("raw")}`;
      const res = await postWebhook("mautic-event", raw, { "webhook-signature": signMautic(raw, secret) });
      expect(res.status).toBe(422);
      expect(res.text).toContain("Failed to parse request body");
    });

    it("入力: コンタクトに紐づかないイベント（会社の更新）・配列でない値は 200 を返し、記録しない", async () => {
      const companyId = nextId();
      const res = await send({ "mautic.company_post_save": [{ company: { id: companyId }, timestamp: TIMESTAMP }], timestamp: TIMESTAMP });
      expect(res.status).toBe(200);
      await expectNothingRecorded(companyId);
    });

    it("入力: コンタクトの ID が無いフォーム送信（匿名）は記録も通知もしない", async () => {
      const submissionId = nextId();
      const res = await send({ "mautic.form_on_submit": [{ submission: { id: submissionId, lead: null, form: { alias: "consult" } }, timestamp: TIMESTAMP }] });
      expect(res.status).toBe(200);
      await expectNothingRecorded(submissionId);
    });

    // 2026-10-07 に直した回帰の確認: 以前は timestamp が読めないとキーに受信時刻（秒）を入れていたので、秒をまたいだ再送が別のキーになり、
    // 重複と見なせなかった。いまはイベントの中身のハッシュでキーを作る（受付時刻の列 timestampSec は受信時刻のまま）
    it("入力: timestamp が読めないイベントは中身のハッシュでキーを作り、秒をまたいだ再送も重複として弾く", async () => {
      const contactId = nextId();
      const body = { "mautic.lead_points_change": [{ contact: { id: contactId }, points: { old_points: 0, new_points: 5 }, timestamp: "not-a-date" }] };
      expect((await send(body)).status).toBe(200);
      const [row] = await waitForList(() => dedupRows(contactId), "1 回目の行");
      expect(String(row!.dedupKey)).toMatch(new RegExp(`^${contactId}\\|mautic\\.lead_points_change\\|h[0-9a-f]+$`));
      expect(Math.abs(Number(row!.timestampSec) - Date.now() / 1000)).toBeLessThan(120);
      await new Promise((r) => setTimeout(r, 1_100));
      expect((await send(body)).status).toBe(200);
      await expectNever(async () => (await dedupRows(contactId)).length > 1, { durationMs: 6_000, what: "秒をまたいだ再送での 2 行目" });
    });

    it("入力: timestamp が読めないイベントでも、中身が違えば別のイベントとして記録する", async () => {
      const contactId = nextId();
      const points = (n: number) => ({ "mautic.lead_points_change": [{ contact: { id: contactId }, points: { old_points: 0, new_points: n }, timestamp: "not-a-date" }] });
      expect((await send(points(5))).status).toBe(200);
      expect((await send(points(10))).status).toBe(200);
      const recorded = await waitForList(() => dedupRows(contactId), "2 つの行", 2);
      expect(new Set(recorded.map((r) => r.dedupKey)).size).toBe(2);
    });
  });
});
