// I-12 の Code ノード「イベントの整理とキー生成」。Chatwoot の Webhook（conversation_created・message_created）を整理し、
// 冪等キー（display_id|message_id）を作る。本文の形は Chatwoot の Webhook（会話はトップレベルの id が display_id、
// メッセージは conversation.id が display_id。message_type は "incoming" などの文字列）に合わせた。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getNode, loadWorkflow, referencedNodeNames, runCodeNode, webhookItem } from "../helpers/workflow.mjs";

const wf = loadWorkflow("I-12-chatwoot-webhook-dedup.json");
const CODE = getNode(wf, "イベントの整理とキー生成");
const WEBHOOK = "Chatwoot からの Webhook";
const NOW = new Date("2026-10-05T03:00:00.500Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

const run = (body) =>
  runCodeNode(CODE, { nodes: { [WEBHOOK]: webhookItem(body, { "x-chatwoot-signature": "sha256=x", "x-chatwoot-timestamp": "0" }) }, input: [{ json: { status: "accepted" } }] }).then((out) =>
    out.map((i) => i.json),
  );

const sender = (overrides = {}) => ({ id: 55, name: "山田 太郎", email: "Taro.Yamada@Example.COM", type: "contact", additional_attributes: { company_name: "株式会社テスト" }, ...overrides });

const conversationCreated = (overrides = {}) => ({
  event: "conversation_created",
  id: 12, // display_id
  inbox_id: 1,
  status: "open",
  meta: { sender: sender() },
  messages: [],
  ...overrides,
});

const messageCreated = (overrides = {}) => ({
  event: "message_created",
  id: 1001,
  content: "料金を知りたい",
  message_type: "incoming",
  content_type: "text",
  private: false,
  sender: sender(),
  conversation: { id: 12, inbox_id: 1, meta: { sender: sender() } },
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ノードの前提", () => {
  it("Run Once for All Items の JavaScript で、本文は Webhook ノードから直接読む", () => {
    expect(CODE.parameters).toMatchObject({ mode: "runOnceForAllItems", language: "javaScript" });
    expect(referencedNodeNames(CODE.parameters.jsCode)).toEqual([WEBHOOK]);
  });
});

describe("会話の作成（conversation_created）", () => {
  it("トップレベルの id を display_id とし、メッセージ ID の部分は固定の conversation_created にする", async () => {
    expect(await run(conversationCreated())).toEqual([
      {
        dedupKey: "12|conversation_created",
        event: "conversation_created",
        displayId: 12,
        messageId: "conversation_created",
        chatwootContactId: 55,
        email: "taro.yamada@example.com",
        kind: "conversation-opened",
        topic: "comegin-lead-alert",
        company: "株式会社テスト",
        receivedAtSec: NOW_SEC,
      },
    ]);
  });

  it("送信者が無くても会話の開始としては通知の対象にし、email・会社名は空、コンタクト ID は null にする", async () => {
    const [ev] = await run(conversationCreated({ meta: {} }));
    expect(ev).toMatchObject({ displayId: 12, chatwootContactId: null, email: "", company: "", kind: "conversation-opened" });
  });

  it("id（display_id）が無ければ何も出さない", async () => {
    expect(await run(conversationCreated({ id: undefined }))).toEqual([]);
    expect(await run(conversationCreated({ id: null }))).toEqual([]);
  });
});

describe("メッセージの作成（message_created）", () => {
  it("顧客からの公開メッセージは conversation.id（display_id）と message の id でキーを作り、通知の対象にはしない", async () => {
    const [ev] = await run(messageCreated());
    expect(ev).toMatchObject({
      dedupKey: "12|1001",
      event: "message_created",
      displayId: 12,
      messageId: "1001",
      chatwootContactId: 55,
      email: "taro.yamada@example.com",
      kind: "",
      topic: "",
    });
  });

  it("message_type が数値の 0（incoming）でも顧客からのメッセージとして扱う", async () => {
    expect(await run(messageCreated({ message_type: 0 }))).toHaveLength(1);
  });

  it.each(["outgoing", "activity", "template", 1, 2, 3, undefined])("顧客以外のメッセージ（message_type=%s）は読み飛ばす", async (type) => {
    expect(await run(messageCreated({ message_type: type }))).toEqual([]);
  });

  it("社内メモ（private: true）は incoming でも読み飛ばす", async () => {
    expect(await run(messageCreated({ private: true }))).toEqual([]);
  });

  it("sender が無ければ、会話の meta.sender を送信者とみなす", async () => {
    const [ev] = await run(messageCreated({ sender: undefined, conversation: { id: 12, meta: { sender: sender({ id: 77, email: "other@example.com" }) } } }));
    expect(ev).toMatchObject({ chatwootContactId: 77, email: "other@example.com" });
  });

  it("会話の情報が無い（display_id が分からない）メッセージは読み飛ばす", async () => {
    expect(await run(messageCreated({ conversation: undefined }))).toEqual([]);
    expect(await run(messageCreated({ conversation: {} }))).toEqual([]);
  });

  // 2026-10-06 に直した不具合: 以前は messageId = String(body.id) で、id が無いと文字列 'undefined' になり、
  // 同じ会話の id の無いメッセージがすべて同じキー（<display_id>|undefined）として重複扱いになっていた
  it.each([undefined, null])("message_created の本文の id が %s なら読み飛ばす（キー <display_id>|undefined を作らない）", async (id) => {
    expect(await run(messageCreated({ id }))).toEqual([]);
  });
});

describe("対象外のイベント", () => {
  it.each(["conversation_updated", "conversation_status_changed", "message_updated", "webwidget_triggered", "contact_created", undefined])("%s は読み飛ばす", async (event) => {
    expect(await run({ ...messageCreated(), event })).toEqual([]);
  });

  it("本文が空・無いときは何も出さない", async () => {
    expect(await run({})).toEqual([]);
    expect(await run(undefined)).toEqual([]);
  });
});

describe("重複排除のキー", () => {
  it("同じイベントの再送は、受信時刻が変わっても同じキーになる", async () => {
    const [first] = await run(messageCreated());
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const [second] = await run(messageCreated());
    expect(second.dedupKey).toBe(first.dedupKey);
    expect(second.receivedAtSec).toBe(first.receivedAtSec + 60);
  });

  it("同じ会話の、会話の作成と最初のメッセージは別のキーになる", async () => {
    const [conv] = await run(conversationCreated());
    const [msg] = await run(messageCreated());
    expect(conv.dedupKey).not.toBe(msg.dedupKey);
  });

  it("メッセージ ID が同じでも会話が違えば別のキーになる", async () => {
    const [a] = await run(messageCreated({ conversation: { id: 12 } }));
    const [b] = await run(messageCreated({ conversation: { id: 13 } }));
    expect(a.dedupKey).not.toBe(b.dedupKey);
  });

  it("キーに email を入れない", async () => {
    const [ev] = await run(messageCreated());
    expect(ev.dedupKey).not.toContain("@");
  });
});

describe("email の整え方（I-19 の突合の入力）", () => {
  it("前後の空白を除き、小文字にする", async () => {
    const [ev] = await run(messageCreated({ sender: sender({ email: "  MiXeD@Example.Com  " }) }));
    expect(ev.email).toBe("mixed@example.com");
  });

  it("email が null・未定義なら空文字にする（I-19 を呼ばない分岐に入る）", async () => {
    expect((await run(messageCreated({ sender: sender({ email: null }) })))[0].email).toBe("");
    expect((await run(messageCreated({ sender: sender({ email: undefined }) })))[0].email).toBe("");
  });
});

describe("後続のノードとのつながり", () => {
  it("冪等キーの記録（dedup_chatwoot への insert）が使う $json の項目は Code ノードの出力にあり、email は記録しない", async () => {
    const [ev] = await run(messageCreated());
    const insert = getNode(wf, "冪等キーを記録");
    const columns = insert.parameters.columns.value;
    expect(Object.keys(columns)).not.toContain("email");
    const used = Object.values(columns).flatMap((v) => [...String(v).matchAll(/\$json\.(\w+)/g)].map((m) => m[1]));
    expect(used).not.toContain("email");
    for (const key of used) expect(ev, key).toHaveProperty(key);
  });

  it("I-21 の通知には email を渡さない", () => {
    const call = getNode(wf, "I-21 通知を呼ぶ");
    expect(JSON.stringify(call.parameters.workflowInputs.value)).not.toContain("email");
  });

  it("I-19 の呼び出しに渡す項目（chatwootContactId・displayId・email）は Code ノードの出力にある", async () => {
    const [ev] = await run(messageCreated());
    const call = getNode(wf, "I-19 突合を呼ぶ");
    const used = Object.values(call.parameters.workflowInputs.value).flatMap((v) => [...String(v).matchAll(/\('イベントの整理とキー生成'\)\.item\.json\.(\w+)/g)].map((m) => m[1]));
    expect(new Set(used)).toEqual(new Set(["chatwootContactId", "displayId", "email"]));
    for (const key of used) expect(ev, key).toHaveProperty(key);
  });
});
