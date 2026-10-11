// I-12 Chatwoot → n8n（POST /webhook/chatwoot-event）と、そこから呼ばれる I-21（通知）・I-19（email の突合）の結合テスト。
// 開発の n8n の本物のワークフローに、Chatwoot と同じ形で署名した本文を送る。鍵は provision が作った Chatwoot の Webhook「n8n I-12」の
// シークレット（Chatwoot の API で読む）。本文の形は I-12 の Code ノード「イベントの整理とキー生成」と Chatwoot の Webhook
// （会話はトップレベルの id が display_id、メッセージは conversation.id が display_id）に合わせた。
//
// I-19 は本物の Mautic に問い合わせるので、突合の相手（it- のコンタクト）を先に Mautic に作る。
// サーバ側の失敗（Mautic に届かない・401・500）は、ops_settings の mauticBaseUrl を偽のサーバ（support.ts の startFakeMautic）に
// 一時的に差し替えて起こし、必ず元の値に戻す。親の I-12 はこのファイルの間だけ有効にする。
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Cleanup } from "../helpers/cleanup.ts";
import { deleteContact, mauticApi } from "../helpers/mautic.ts";
import { activateForTest, findWorkflow } from "../helpers/n8n.ts";
import { itEmail, itName } from "../helpers/run-id.ts";
import { expectNever, waitFor } from "../helpers/wait.ts";
import {
  alerts,
  chatwootWebhookSecret,
  closedPortUrl,
  decodeBody,
  executions,
  idSequence,
  N8nWindow,
  nowSec,
  overrideSetting,
  postWebhook,
  rows,
  signChatwoot,
  startFakeMautic,
  waitForList,
  type Execution,
} from "./support.ts";

const nextId = idSequence();
const n8nWindow = new N8nWindow();
const cleanup = new Cleanup();
let secret = "";
let restore: () => Promise<void> = async () => {};
let i19Id = "";

// 突合の相手（Mautic のコンタクト）
const MATCH_EMAIL = itEmail("match");
let mauticContactId = 0;

const sender = (id: number, email: string | null, company = "") => ({ id, name: itName(`sender-${id}`), email, type: "contact", additional_attributes: { company_name: company } });

const conversationCreated = (displayId: number, contact: ReturnType<typeof sender> | null) => ({
  event: "conversation_created",
  id: displayId,
  inbox_id: 1,
  status: "open",
  meta: contact ? { sender: contact } : {},
  messages: [],
});

const messageCreated = (displayId: number, messageId: number | null, contact: ReturnType<typeof sender>, overrides: Record<string, unknown> = {}) => ({
  event: "message_created",
  id: messageId,
  content: itName("message"),
  message_type: "incoming",
  content_type: "text",
  private: false,
  sender: contact,
  conversation: { id: displayId, inbox_id: 1, meta: { sender: contact } },
  ...overrides,
});

/** 署名付きで送る。timestamp・鍵を変えると、古い時刻や別の鍵の署名になる */
const send = (body: unknown, options: { timestamp?: string; signWith?: string } = {}) => {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const timestamp = options.timestamp ?? String(nowSec());
  return postWebhook("chatwoot-event", raw, { "x-chatwoot-timestamp": timestamp, "x-chatwoot-signature": signChatwoot(timestamp, raw, options.signWith ?? secret) });
};

// dedup_chatwoot には、冪等キー（<display_id>|<message_id>）と突合の印（…|match。I-19 が成功したときだけ）と
// 会話の開始の通知の印（<display_id>|lead。2026-10-12 に追加。顧客の最初のメッセージで通知したとき）の 3 種類の行が入る
const allDedupRows = (displayId: number) => rows("dedup_chatwoot", [{ columnName: "displayId", condition: "eq", value: displayId }]);
const isMark = (r: Record<string, unknown>) => String(r.dedupKey).endsWith("|match") || String(r.dedupKey).endsWith("|lead");
const dedupRows = async (displayId: number) => (await allDedupRows(displayId)).filter((r) => !isMark(r));
const leadRows = async (displayId: number) => (await allDedupRows(displayId)).filter((r) => String(r.dedupKey).endsWith("|lead"));
const matchRows = async (displayId: number) => (await allDedupRows(displayId)).filter((r) => String(r.dedupKey).endsWith("|match"));
const linkRows = (chatwootContactId: number) => rows("contact_link", [{ columnName: "chatwootContactId", condition: "eq", value: chatwootContactId }]);
const conversationAlerts = (displayId: number) => alerts(`(conversation ${displayId})`);

const expectNothingRecorded = (displayId: number, chatwootContactId: number) =>
  expectNever(async () => (await allDedupRows(displayId)).length > 0 || (await conversationAlerts(displayId)).length > 0 || (await linkRows(chatwootContactId)).length > 0, {
    durationMs: 6_000,
    what: `会話 ${displayId} の記録か通知か突合`,
  });

/** I-19 の実行のうち、chatwootContactId の突合のもの（入力のノードの出力で見分ける） */
const i19ExecutionsFor = async (chatwootContactId: number, status: "error" | "success"): Promise<Execution[]> =>
  (await executions(i19Id, { status, includeData: true })).filter(
    (e) => e.data?.resultData?.runData?.["サブワークフローの入力"]?.[0]?.data?.main?.[0]?.[0]?.json.chatwootContactId === chatwootContactId,
  );

beforeAll(async () => {
  secret = await chatwootWebhookSecret();
  i19Id = (await findWorkflow("I-19 ")).id;
  const created = await mauticApi<{ contact: { id: number } }>("/contacts/new", { method: "POST", body: { email: MATCH_EMAIL, firstname: itName("match"), lastname: "it" } });
  if (created.status !== 201 && created.status !== 200) throw new Error(`Mautic に突合の相手を作れない（HTTP ${created.status}）`);
  mauticContactId = Number(created.json?.contact.id);
  cleanup.add(`Mautic のコンタクト ${mauticContactId}`, () => deleteContact(mauticContactId));
  await n8nWindow.open();
  ({ restore } = await activateForTest("I-12 "));
});

afterAll(async () => {
  try {
    await restore();
    await new Promise((r) => setTimeout(r, 3_000));
  } finally {
    try {
      await n8nWindow.close();
    } finally {
      await cleanup.runAll();
    }
  }
});

describe("I-12 Chatwoot Webhook の受領と重複排除（POST /webhook/chatwoot-event）", () => {
  describe("正常系", () => {
    // 2026-10-12 に変えた: 会話の作成は通知しない（faq-bot がウィジェットを開いただけで会話を作るため。
    // docs/superpowers/specs/2026-10-12-faq-bot-welcome-design.md の 5.1）。通知は顧客の最初のメッセージで行う
    it("署名と時刻が正しい会話の作成は 200 を返し、冪等キーを記録するが、通知はしない", async () => {
      const displayId = nextId();
      const res = await send(conversationCreated(displayId, sender(nextId(), null)));
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ status: "accepted" });

      const [row] = await waitForList(() => dedupRows(displayId), "dedup_chatwoot の行");
      expect(row).toMatchObject({ dedupKey: `${displayId}|conversation_created`, displayId, messageId: "conversation_created" });
      await expectNever(async () => (await conversationAlerts(displayId)).length > 0 || (await leadRows(displayId)).length > 0, { durationMs: 6_000, what: "会話の作成での通知" });
    });

    it("顧客の最初のメッセージで、I-21 が conversation-opened を通知し、通知の印（<display_id>|lead）を記録する（本文に email を載せない）", async () => {
      const displayId = nextId();
      const contactId = nextId();
      const company = itName("company");
      expect((await send(conversationCreated(displayId, sender(contactId, MATCH_EMAIL, company)))).status).toBe(200);
      const res = await send(messageCreated(displayId, nextId(), sender(contactId, MATCH_EMAIL, company)));
      expect(res.status).toBe(200);

      const [lead] = await waitForList(() => leadRows(displayId), "通知の印");
      expect(lead).toMatchObject({ dedupKey: `${displayId}|lead`, displayId, messageId: "lead" });

      const [mail] = await waitForList(() => conversationAlerts(displayId), "I-21 の通知");
      expect(mail!.Content.Headers.Subject?.[0]).toBe(`[comegin] lead: conversation-opened (conversation ${displayId})`);
      const body = decodeBody(mail!);
      expect(body).toContain(`会社名: ${company}`);
      expect(body).toContain(`システム上の ID: conversation ${displayId}`);
      expect(body).toContain("確認: Chatwoot の会話画面を見る");
      expect(body).not.toContain(MATCH_EMAIL);
    });

    it("会話の作成に email があれば、I-19 が Mautic のコンタクトと lower(email) の完全一致で対応付け、contact_link に matched を記録する（email は記録しない）", async () => {
      const displayId = nextId();
      const contactId = nextId();
      expect((await send(conversationCreated(displayId, sender(contactId, MATCH_EMAIL)))).status).toBe(200);

      const [link] = await waitForList(() => linkRows(contactId), "contact_link の行");
      expect(link).toMatchObject({ chatwootContactId: contactId, displayId, status: "matched", mauticContactId, matchCount: 1 });
      expect(JSON.stringify(link)).not.toContain("@");
      // 突合が成功したので、突合の印（|match）が記録される
      const [mark] = await waitForList(() => matchRows(displayId), "突合の印");
      expect(mark).toMatchObject({ dedupKey: `${displayId}|conversation_created|match`, displayId, messageId: "conversation_created" });
    });

    it("同じ会話の 2 通目以降のメッセージは記録するが、通知は増えない", async () => {
      const displayId = nextId();
      const contact = sender(nextId(), null);
      expect((await send(messageCreated(displayId, nextId(), contact))).status).toBe(200);
      await waitForList(() => conversationAlerts(displayId), "1 通目での通知");
      const second = nextId();
      expect((await send(messageCreated(displayId, second, contact))).status).toBe(200);
      await waitForList(async () => (await dedupRows(displayId)).filter((r) => r.messageId === String(second)), "2 通目の冪等キー");
      await expectNever(async () => (await conversationAlerts(displayId)).length > 1 || (await leadRows(displayId)).length > 1, { durationMs: 6_000, what: "2 通目での通知" });
    });

    it("顧客からのメッセージは display_id|message_id で記録し、email があれば突合する", async () => {
      const displayId = nextId();
      const contactId = nextId();
      const messageId = nextId();
      expect((await send(messageCreated(displayId, messageId, sender(contactId, MATCH_EMAIL)))).status).toBe(200);

      const [row] = await waitForList(() => dedupRows(displayId), "dedup_chatwoot の行");
      expect(row).toMatchObject({ dedupKey: `${displayId}|${messageId}`, displayId, messageId: String(messageId) });
      await waitForList(() => linkRows(contactId), "contact_link の行");
    });

    it("同じイベントの再送（時刻を変えて署名し直したもの）は 200 を返すが、冪等キーの行も通知も増えない", async () => {
      const displayId = nextId();
      const body = messageCreated(displayId, nextId(), sender(nextId(), null));
      expect((await send(body)).status).toBe(200);
      await waitForList(() => conversationAlerts(displayId), "1 通目の通知");

      expect((await send(body, { timestamp: String(nowSec() + 1) })).status).toBe(200);
      await expectNever(async () => (await dedupRows(displayId)).length > 1 || (await leadRows(displayId)).length > 1 || (await conversationAlerts(displayId)).length > 1, { durationMs: 8_000, what: "再送での二重の記録か通知" });
      expect(await dedupRows(displayId)).toHaveLength(1);
    });

    it("Chatwoot の email が大文字を含んでも、小文字にそろえて突合する", async () => {
      const contactId = nextId();
      expect((await send(conversationCreated(nextId(), sender(contactId, `  ${MATCH_EMAIL.toUpperCase()} `)))).status).toBe(200);
      const [link] = await waitForList(() => linkRows(contactId), "contact_link の行");
      expect(link).toMatchObject({ status: "matched", mauticContactId });
    });

    it("Mautic に一致するコンタクトが無ければ unmatched（mauticContactId は 0）で記録し、エラーにしない", async () => {
      const contactId = nextId();
      expect((await send(conversationCreated(nextId(), sender(contactId, itEmail("nobody"))))).status).toBe(200);
      const [link] = await waitForList(() => linkRows(contactId), "contact_link の行");
      expect(link).toMatchObject({ status: "unmatched", mauticContactId: 0, matchCount: 0 });
    });

    it("Mautic の検索に部分一致で掛かるだけのコンタクトは数えない（unmatched）", async () => {
      // Mautic の email: 検索は前方一致でも返しうる。I-19 は lower(email) の完全一致だけを数える（DD-04 7.1）
      const longer = itEmail("prefix-longer");
      const created = await mauticApi<{ contact: { id: number } }>("/contacts/new", { method: "POST", body: { email: longer, firstname: itName("prefix") } });
      const id = Number(created.json?.contact.id);
      cleanup.add(`Mautic のコンタクト ${id}`, () => deleteContact(id));

      const contactId = nextId();
      // Chatwoot 側は Mautic のアドレスの先頭部分（…@example.co）
      const shorter = longer.slice(0, -1);
      expect((await send(conversationCreated(nextId(), sender(contactId, shorter)))).status).toBe(200);
      const [link] = await waitForList(() => linkRows(contactId), "contact_link の行");
      expect(link).toMatchObject({ status: "unmatched", mauticContactId: 0 });
    });

    it("同じ Chatwoot のコンタクトを再び突合すると、contact_link は増えずに最新の結果で上書きされる（upsert）", async () => {
      const contactId = nextId();
      expect((await send(conversationCreated(nextId(), sender(contactId, itEmail("not-yet"))))).status).toBe(200);
      await waitForList(() => linkRows(contactId), "1 回目の突合");

      const displayId = nextId();
      expect((await send(conversationCreated(displayId, sender(contactId, MATCH_EMAIL)))).status).toBe(200);
      const updated = await waitFor(async () => {
        const list = await linkRows(contactId);
        return list[0]?.status === "matched" && list;
      }, { what: "上書きされた突合", timeoutMs: 40_000 });
      expect(updated).toHaveLength(1);
      expect(updated[0]).toMatchObject({ displayId, mauticContactId });
    });

    it("空入力: 送信者の無いメッセージも、冪等キーを記録して通知する（突合には進まない）", async () => {
      const displayId = nextId();
      expect((await send(messageCreated(displayId, nextId(), sender(nextId(), null), { sender: null, conversation: { id: displayId, inbox_id: 1 } }))).status).toBe(200);
      await waitForList(() => conversationAlerts(displayId), "通知");
      expect(await dedupRows(displayId)).toHaveLength(1);
    });

    it("空入力: イベントの無い本文（{}）は、署名と時刻が正しければ 200 を返す（記録するものが無い）", async () => {
      const res = await send({});
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ status: "accepted" });
    });
  });

  describe("異常系", () => {
    it("入力: X-Chatwoot-Signature が無ければ 401 を返し、記録も通知も突合もしない", async () => {
      const displayId = nextId();
      const contactId = nextId();
      const res = await postWebhook("chatwoot-event", JSON.stringify(conversationCreated(displayId, sender(contactId, MATCH_EMAIL))), { "x-chatwoot-timestamp": String(nowSec()) });
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: "unauthorized" });
      await expectNothingRecorded(displayId, contactId);
    });

    it("入力: 別の鍵で作った署名は 401", async () => {
      const displayId = nextId();
      const contactId = nextId();
      expect((await send(conversationCreated(displayId, sender(contactId, MATCH_EMAIL)), { signWith: "not-the-webhook-secret" })).status).toBe(401);
      await expectNothingRecorded(displayId, contactId);
    });

    it("入力: 5 分より古い時刻（リプレイ）は、その時刻で正しく署名していても 401", async () => {
      const displayId = nextId();
      const contactId = nextId();
      expect((await send(conversationCreated(displayId, sender(contactId, MATCH_EMAIL)), { timestamp: String(nowSec() - 6 * 60) })).status).toBe(401);
      await expectNothingRecorded(displayId, contactId);
    });

    it("入力: 5 分より先の時刻も 401", async () => {
      const displayId = nextId();
      const contactId = nextId();
      expect((await send(conversationCreated(displayId, sender(contactId, MATCH_EMAIL)), { timestamp: String(nowSec() + 6 * 60) })).status).toBe(401);
      await expectNothingRecorded(displayId, contactId);
    });

    it("入力: 時刻のヘッダーを書き換えると、署名が合わず 401（署名は「時刻.本文」に対して検証する）", async () => {
      const displayId = nextId();
      const contactId = nextId();
      const raw = JSON.stringify(conversationCreated(displayId, sender(contactId, MATCH_EMAIL)));
      const old = String(nowSec() - 3_600);
      const res = await postWebhook("chatwoot-event", raw, { "x-chatwoot-timestamp": String(nowSec()), "x-chatwoot-signature": signChatwoot(old, raw, secret) });
      expect(res.status).toBe(401);
      await expectNothingRecorded(displayId, contactId);
    });

    it("空入力: X-Chatwoot-Timestamp が無ければ、時刻の欠けた文字列で署名を合わせても 401（時刻の検査で止まる）", async () => {
      const displayId = nextId();
      const contactId = nextId();
      const raw = JSON.stringify(conversationCreated(displayId, sender(contactId, MATCH_EMAIL)));
      // n8n の式は欠けたヘッダーを "undefined" として連結するので、それに合わせた署名を付けても時刻が 0 とみなされて止まる
      const res = await postWebhook("chatwoot-event", raw, { "x-chatwoot-signature": signChatwoot("undefined", raw, secret) });
      expect(res.status).toBe(401);
      await expectNothingRecorded(displayId, contactId);
    });

    it("空入力: X-Chatwoot-Signature が空文字なら 401", async () => {
      const displayId = nextId();
      const contactId = nextId();
      const res = await postWebhook("chatwoot-event", JSON.stringify(conversationCreated(displayId, sender(contactId, MATCH_EMAIL))), { "x-chatwoot-timestamp": String(nowSec()), "x-chatwoot-signature": "" });
      expect(res.status).toBe(401);
      await expectNothingRecorded(displayId, contactId);
    });

    it("空入力: 本文が空（0 バイト）は、署名が無ければ 401、空の本文の正しい署名なら 200 を返して何もしない", async () => {
      expect((await postWebhook("chatwoot-event", "", { "x-chatwoot-timestamp": String(nowSec()) })).status).toBe(401);
      expect((await send("")).status).toBe(200);
    });

    it("入力: 本文が JSON でなければ、署名が正しくても n8n が 422 を返し、ワークフローは動かない", async () => {
      const res = await send(`not json ${itName("raw")}`);
      expect(res.status).toBe(422);
      expect(res.text).toContain("Failed to parse request body");
    });

    it.each([
      ["担当者の返信（outgoing）", { message_type: "outgoing" }],
      ["社内メモ（private）", { private: true }],
      ["システムの活動（activity）", { message_type: "activity" }],
    ])("入力: %s は 200 を返し、記録も突合もしない", async (_label, overrides) => {
      const displayId = nextId();
      const contactId = nextId();
      expect((await send(messageCreated(displayId, nextId(), sender(contactId, MATCH_EMAIL), overrides))).status).toBe(200);
      await expectNothingRecorded(displayId, contactId);
    });

    it("入力: メッセージ ID（id）の無い message_created は読み飛ばす（'undefined' をキーにしない）", async () => {
      const displayId = nextId();
      const contactId = nextId();
      expect((await send(messageCreated(displayId, null, sender(contactId, MATCH_EMAIL)))).status).toBe(200);
      await expectNothingRecorded(displayId, contactId);
    });

    it("入力: 購読していないイベント（conversation_status_changed）は 200 を返し、読み飛ばす", async () => {
      const displayId = nextId();
      const contactId = nextId();
      expect((await send({ ...conversationCreated(displayId, sender(contactId, MATCH_EMAIL)), event: "conversation_status_changed" })).status).toBe(200);
      await expectNothingRecorded(displayId, contactId);
    });

    describe("I-19 の Mautic が使えないとき", () => {
      // ops_settings の mauticBaseUrl を差し替えている間は、他の担当の会話の突合も失敗する（その行は後片付けで消す範囲に入る）。
      // 差し替えは 1 件ずつ短く行い、終わったら必ず元の値に戻す
      const withMauticAt = async (url: string, fn: () => Promise<void>): Promise<void> => {
        const back = await overrideSetting("mauticBaseUrl", url);
        try {
          await fn();
        } finally {
          await back();
        }
      };

      /** I-19 が失敗しても I-12 は 200 を返して冪等キーを記録し、contact_link にも突合の印にも書かない。失敗は I-19 の実行履歴に残る */
      const expectI19Failed = async (displayId: number, contactId: number): Promise<Execution> => {
        await waitForList(() => dedupRows(displayId), "dedup_chatwoot の行");
        const [failed] = await waitForList(() => i19ExecutionsFor(contactId, "error"), "I-19 の失敗した実行");
        expect(await linkRows(contactId)).toEqual([]);
        expect(await matchRows(displayId)).toEqual([]);
        return failed!;
      };

      it("サーバ: Mautic に接続できないとき、I-12 は止まらず、I-19 の失敗が実行履歴に残り、contact_link は書かない", async () => {
        const displayId = nextId();
        const contactId = nextId();
        await withMauticAt(await closedPortUrl(), async () => {
          expect((await send(messageCreated(displayId, nextId(), sender(contactId, MATCH_EMAIL)))).status).toBe(200);
          const failed = await expectI19Failed(displayId, contactId);
          expect(failed.data?.resultData?.runData?.["Mautic でメールアドレスを検索"]?.[0]?.error).toBeDefined();
        });
        // 通知（I-21）は I-19 と別の枝なので、突合が失敗しても届く
        await waitForList(() => conversationAlerts(displayId), "I-21 の通知");
      });

      it.each([401, 500])("サーバ: Mautic が %i を返すとき、再試行の後に I-19 が失敗し、contact_link は書かない", async (status) => {
        const fake = await startFakeMautic(status);
        const displayId = nextId();
        const contactId = nextId();
        try {
          await withMauticAt(fake.urlFromN8n, async () => {
            expect((await send(conversationCreated(displayId, sender(contactId, MATCH_EMAIL)))).status).toBe(200);
            const failed = await expectI19Failed(displayId, contactId);
            expect(failed.data?.resultData?.runData?.["Mautic でメールアドレスを検索"]?.[0]?.error?.httpCode).toBe(String(status));
          });
          // ノードの設定は「失敗したら 1 回だけ再試行」（maxTries 2）。401 は OAuth2 のトークンの取り直しでもう 1 回送ることがある
          expect(fake.hits()).toBeGreaterThanOrEqual(2);
        } finally {
          await fake.close();
        }
      });

      // 2026-10-07 に直した回帰の確認: 以前は冪等キーの記録の後に I-19 を呼んでいたので、突合が失敗した会話は再送しても冪等キーで弾かれ、
      // 突合をやり直せなかった。いまは突合の印（|match）を I-19 の成功の後にだけ記録するので、再送で突合だけをやり直す
      it("サーバ: 突合が失敗した会話は、Mautic が戻った後の同じイベントの再送で突合をやり直す（通知は増えない）", async () => {
        const displayId = nextId();
        const contactId = nextId();
        const body = messageCreated(displayId, nextId(), sender(contactId, MATCH_EMAIL));
        await withMauticAt(await closedPortUrl(), async () => {
          expect((await send(body)).status).toBe(200);
          await expectI19Failed(displayId, contactId);
        });
        await waitForList(() => conversationAlerts(displayId), "1 回目の通知");

        expect((await send(body, { timestamp: String(nowSec() + 1) })).status).toBe(200);
        const [link] = await waitForList(() => linkRows(contactId), "再送での突合");
        expect(link).toMatchObject({ displayId, status: "matched", mauticContactId });
        await waitForList(() => matchRows(displayId), "突合の印");
        // 通知の冪等キーは 1 回目で記録済みなので、通知も冪等キーの行も増えない
        expect(await dedupRows(displayId)).toHaveLength(1);
        await expectNever(async () => (await conversationAlerts(displayId)).length > 1, { durationMs: 5_000, what: "再送での 2 通目の通知" });
      });

      it("サーバ: 突合が済んだ会話の再送は、突合の印で弾かれて I-19 を呼ばない", async () => {
        const displayId = nextId();
        const contactId = nextId();
        const body = conversationCreated(displayId, sender(contactId, MATCH_EMAIL));
        expect((await send(body)).status).toBe(200);
        await waitForList(() => matchRows(displayId), "突合の印");
        const [first] = await linkRows(contactId);
        // I-19 に進めば Mautic に届かず失敗が残る状態にして再送し、I-19 の失敗が増えないこと（＝呼ばれないこと）を確かめる
        await withMauticAt(await closedPortUrl(), async () => {
          expect((await send(body, { timestamp: String(nowSec() + 1) })).status).toBe(200);
          await expectNever(async () => (await i19ExecutionsFor(contactId, "error")).length > 0, { durationMs: 8_000, what: "突合済みの再送での I-19 の呼び出し" });
        });
        expect(await linkRows(contactId)).toEqual([first]);
      });
    });
  });
});
