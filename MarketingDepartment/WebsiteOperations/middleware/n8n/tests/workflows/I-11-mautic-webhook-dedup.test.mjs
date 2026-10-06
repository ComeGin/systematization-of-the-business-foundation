// I-11 の Code ノード「イベント分割とキー生成」。Mautic の Webhook の本文をイベントごとに分け、冪等キーを作る。
// 本文の形は Mautic の WebhookModel::getWebhookPayload（イベント種別ごとの配列。各イベントに timestamp〈ISO 8601〉が付く）、
// LeadBundle・FormBundle の WebhookSubscriber（contact / submission / segment・action / points）に合わせた。
import { afterEach, describe, expect, it, vi } from "vitest";
import { getNode, loadWorkflow, referencedNodeNames, runCodeNode, webhookItem } from "../helpers/workflow.mjs";

const wf = loadWorkflow("I-11-mautic-webhook-dedup.json");
const CODE = getNode(wf, "イベント分割とキー生成");
const WEBHOOK = "Mautic からの Webhook";

const TS = "2026-10-04T10:00:00+09:00";
const SEC = Date.parse(TS) / 1000;

const run = (body) => runCodeNode(CODE, { nodes: { [WEBHOOK]: webhookItem(body, { "webhook-signature": "x" }) }, input: [{ json: { status: "accepted" } }] }).then((out) => out.map((i) => i.json));

const contact = (id, company) => ({ id, fields: { core: company ? { company: { value: company } } : {} } });
const formSubmit = (leadId, alias, extra = {}) => ({ submission: { id: 10, lead: leadId === null ? null : { id: leadId, fields: { core: { company: { value: "株式会社テスト" } } } }, form: { alias } }, timestamp: TS, ...extra });

afterEach(() => {
  vi.useRealTimers();
});

describe("ノードの前提", () => {
  it("Run Once for All Items の JavaScript で、本文は Webhook ノードから直接読む", () => {
    expect(CODE.parameters).toMatchObject({ mode: "runOnceForAllItems", language: "javaScript" });
    expect(referencedNodeNames(CODE.parameters.jsCode)).toEqual([WEBHOOK]);
  });
});

describe("フォーム送信（mautic.form_on_submit）", () => {
  it("README の確認用の本文から、1 件のイベントと冪等キー（contact_id|種別|秒）を作る", async () => {
    const out = await run({ "mautic.form_on_submit": [{ submission: { id: 1, lead: { id: 1 }, form: { alias: "consult" } }, timestamp: TS }] });
    expect(out).toEqual([
      {
        dedupKey: `1|mautic.form_on_submit|${SEC}`,
        contactId: 1,
        eventType: "mautic.form_on_submit",
        timestampSec: SEC,
        kind: "demo-requested",
        topic: "comegin-lead-alert",
        company: "",
        formAlias: "consult",
      },
    ]);
  });

  it("無料相談（consult）は demo-requested として通知の対象にし、会社名を submission.lead から取る", async () => {
    const [ev] = await run({ "mautic.form_on_submit": [formSubmit(42, "consult")] });
    expect(ev).toMatchObject({ contactId: 42, kind: "demo-requested", topic: "comegin-lead-alert", company: "株式会社テスト" });
  });

  it("無料 DL（source_dl / source-dl）などほかのフォームは、記録はするが通知しない（kind・topic が空）", async () => {
    const out = await run({ "mautic.form_on_submit": [formSubmit(42, "source_dl"), formSubmit(43, "source-dl")] });
    expect(out.map((e) => [e.contactId, e.kind, e.topic, e.formAlias])).toEqual([
      [42, "", "", "source_dl"],
      [43, "", "", "source-dl"],
    ]);
  });

  it("コンタクトに紐づかない送信（lead が null）は読み飛ばす", async () => {
    expect(await run({ "mautic.form_on_submit": [formSubmit(null, "consult")] })).toEqual([]);
  });
});

describe("セグメント変更（mautic.lead_list_change）", () => {
  const listChange = (action, segment) => ({ contact: contact(7, "Acme"), segment, action, timestamp: TS });

  it("mql に追加されたら mql として通知の対象にし、会社名を contact から取る", async () => {
    const [ev] = await run({ "mautic.lead_list_change": [listChange("added", { id: 3, name: "MQL", alias: "mql" })] });
    expect(ev).toMatchObject({ contactId: 7, eventType: "mautic.lead_list_change", kind: "mql", topic: "comegin-lead-alert", company: "Acme", formAlias: "" });
  });

  it("alias が無いときは name で mql を判定する", async () => {
    const [ev] = await run({ "mautic.lead_list_change": [listChange("added", { id: 3, name: "mql" })] });
    expect(ev.kind).toBe("mql");
  });

  it("mql から外れた（removed）ときは通知しない", async () => {
    const [ev] = await run({ "mautic.lead_list_change": [listChange("removed", { id: 3, alias: "mql" })] });
    expect(ev.kind).toBe("");
  });

  it("ほかのセグメントへの追加は通知しない", async () => {
    const [ev] = await run({ "mautic.lead_list_change": [listChange("added", { id: 4, alias: "newsletter" })] });
    expect(ev.kind).toBe("");
  });
});

describe("コンタクトの作成・更新・ポイント変更", () => {
  it("contact.id をコンタクト ID とし、通知の対象にはしない", async () => {
    const out = await run({
      "mautic.lead_post_save_new": [{ contact: contact(1), timestamp: TS }],
      "mautic.lead_post_save_update": [{ contact: contact(2), timestamp: TS }],
      "mautic.lead_points_change": [{ contact: contact(3), points: { old_points: 0, new_points: 10 }, timestamp: TS }],
    });
    expect(out.map((e) => [e.contactId, e.eventType, e.kind])).toEqual([
      [1, "mautic.lead_post_save_new", ""],
      [2, "mautic.lead_post_save_update", ""],
      [3, "mautic.lead_points_change", ""],
    ]);
  });

  it("会社名が無ければ空文字にする", async () => {
    const [ev] = await run({ "mautic.lead_post_save_update": [{ contact: { id: 2 }, timestamp: TS }] });
    expect(ev.company).toBe("");
  });
});

describe("イベントの分割", () => {
  it("1 つの種別に複数のイベントがあれば、1 件ずつに分ける", async () => {
    const out = await run({ "mautic.lead_post_save_update": [1, 2, 3].map((id) => ({ contact: contact(id), timestamp: TS })) });
    expect(out.map((e) => e.contactId)).toEqual([1, 2, 3]);
  });

  it("1 回のフォーム送信で同じ秒に出る複数の種別は、別のキーにする（form_on_submit を重複と見なさない）", async () => {
    const out = await run({
      "mautic.lead_post_save_update": [{ contact: contact(5), timestamp: TS }],
      "mautic.lead_points_change": [{ contact: contact(5), timestamp: TS }],
      "mautic.lead_list_change": [{ contact: contact(5), segment: { alias: "other" }, action: "added", timestamp: TS }],
      "mautic.form_on_submit": [formSubmit(5, "consult")],
    });
    expect(new Set(out.map((e) => e.dedupKey)).size).toBe(4);
    expect(out.find((e) => e.eventType === "mautic.form_on_submit").kind).toBe("demo-requested");
  });

  it("会社のイベントなど、コンタクトに紐づかないものは読み飛ばす", async () => {
    const out = await run({
      "mautic.company_post_save": [{ company: { id: 9, fields: {} }, timestamp: TS }],
      "mautic.lead_post_save_update": [{ contact: contact(1), timestamp: TS }],
    });
    expect(out.map((e) => e.eventType)).toEqual(["mautic.lead_post_save_update"]);
  });

  it("配列でない値（トップレベルの timestamp や単体のオブジェクト）は読み飛ばす", async () => {
    const out = await run({ timestamp: TS, "mautic.lead_post_save_update": { contact: contact(1), timestamp: TS } });
    expect(out).toEqual([]);
  });

  it("配列の中の null や空のオブジェクトは読み飛ばす", async () => {
    const out = await run({ "mautic.lead_post_save_update": [null, {}, { contact: {} }, { contact: contact(1), timestamp: TS }] });
    expect(out.map((e) => e.contactId)).toEqual([1]);
  });

  it("本文が空・無いときは何も出さない", async () => {
    expect(await run({})).toEqual([]);
    expect(await run(undefined)).toEqual([]);
  });
});

describe("重複排除のキー", () => {
  it("同じ本文の再送は、同じキーになる（Data Table で弾ける）", async () => {
    const body = { "mautic.form_on_submit": [formSubmit(1, "consult")] };
    expect((await run(body)).map((e) => e.dedupKey)).toEqual((await run(structuredClone(body))).map((e) => e.dedupKey));
  });

  it("1 つの本文の中で同じコンタクト・種別・秒が重なれば、1 件にまとめる", async () => {
    const out = await run({
      "mautic.lead_post_save_update": [
        { contact: contact(1), timestamp: "2026-10-04T10:00:00.100+09:00" },
        { contact: contact(1), timestamp: "2026-10-04T10:00:00.900+09:00" },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].timestampSec).toBe(SEC);
  });

  it("秒が違えば別のキーにする（別の時刻の意思表示は別の行動）", async () => {
    const out = await run({
      "mautic.lead_post_save_update": [
        { contact: contact(1), timestamp: "2026-10-04T10:00:00+09:00" },
        { contact: contact(1), timestamp: "2026-10-04T10:00:01+09:00" },
      ],
    });
    expect(out.map((e) => e.timestampSec)).toEqual([SEC, SEC + 1]);
  });

  it("タイムゾーンの表記が違っても、同じ時刻なら同じ秒になる", async () => {
    const [a] = await run({ "mautic.lead_post_save_update": [{ contact: contact(1), timestamp: "2026-10-04T10:00:00+09:00" }] });
    const [b] = await run({ "mautic.lead_post_save_update": [{ contact: contact(1), timestamp: "2026-10-04T01:00:00+00:00" }] });
    expect(a.dedupKey).toBe(b.dedupKey);
  });

  it("イベントに timestamp が無ければ、本文のトップレベルの timestamp を使う", async () => {
    const [ev] = await run({ timestamp: TS, "mautic.lead_post_save_update": [{ contact: contact(1) }] });
    expect(ev.timestampSec).toBe(SEC);
  });

  it("どちらの timestamp も読めなければ、受信時刻（秒）で代用する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:34:56.789Z"));
    const [ev] = await run({ "mautic.lead_post_save_update": [{ contact: contact(1), timestamp: "not-a-date" }] });
    expect(ev.timestampSec).toBe(Date.parse("2026-10-05T12:34:56Z") / 1000);
    expect(ev.dedupKey).toBe(`1|mautic.lead_post_save_update|${ev.timestampSec}`);
  });

  it("キーと記録する列には、email や氏名などの個人情報を入れない", async () => {
    const [ev] = await run({
      "mautic.form_on_submit": [{ submission: { id: 1, lead: { id: 1, fields: { core: { email: { value: "a@example.com" }, firstname: { value: "太郎" } } } }, form: { alias: "consult" } }, timestamp: TS }],
    });
    expect(JSON.stringify(ev)).not.toContain("a@example.com");
    expect(JSON.stringify(ev)).not.toContain("太郎");
  });
});

describe("後続のノードとのつながり", () => {
  it("冪等キーの記録（dedup_mautic への insert）が使う $json の項目は、すべて Code ノードの出力にある", async () => {
    const [ev] = await run({ "mautic.form_on_submit": [formSubmit(1, "consult")] });
    const insert = getNode(wf, "冪等キーを記録");
    const used = Object.values(insert.parameters.columns.value).flatMap((v) => [...String(v).matchAll(/\$json\.(\w+)/g)].map((m) => m[1]));
    expect(used.length).toBeGreaterThan(0);
    for (const key of used) expect(ev, key).toHaveProperty(key);
  });

  it("I-21 の呼び出しに渡す項目（kind・contactId・company・timestampSec）は Code ノードの出力にある", async () => {
    const [ev] = await run({ "mautic.form_on_submit": [formSubmit(1, "consult")] });
    const call = getNode(wf, "I-21 通知を呼ぶ");
    const used = Object.values(call.parameters.workflowInputs.value).flatMap((v) => [...String(v).matchAll(/\('イベント分割とキー生成'\)\.item\.json\.(\w+)/g)].map((m) => m[1]));
    expect(new Set(used)).toEqual(new Set(["kind", "contactId", "company", "timestampSec"]));
    for (const key of used) expect(ev, key).toHaveProperty(key);
  });
});
