// 週次 問い合わせの棚卸し（weekly-inquiry-inventory）の集計と通知の判定。Code ノードは無く、ロジックは Edit Fields と IF の式にあるので、
// 式を評価して確かめる。HTTP ノードの出力の形は Chatwoot の GET /api/v1/accounts/{id}/conversations（{ data: { meta, payload } }）と、
// n8n の HTTP Request の onError: continueRegularOutput（失敗すると { error } だけの項目が流れる）に合わせた。実際の Chatwoot には繋がない。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evalExpression, evalIfLeft, evalSetNode, getNode, loadWorkflow } from "../helpers/workflow.mjs";

const wf = loadWorkflow("weekly-inquiry-inventory.json");
const HTTP = "未割り当ての会話を取る";
const AGG = getNode(wf, "集計する");
const HAS_WAITING = getNode(wf, "対応待ちがあるか");
const FETCH_STATE = getNode(wf, "取得の状態を伝える（I-21）");
const NOTIFY = getNode(wf, "棚卸しの結果を通知する（I-21）");
const GATE = getNode(wf, "棚卸しが有効か");

const NOW = new Date("2026-10-05T00:00:00Z"); // 月曜 09:00 JST
const NOW_SEC = NOW.getTime() / 1000;
const HOUR = 3600;

const conv = (id, waitingHours, extra = {}) => ({ id, waiting_since: waitingHours === null ? 0 : NOW_SEC - waitingHours * HOUR, ...extra });
const ok = (payload, count = payload.length) => ({ data: { meta: { unassigned_count: count, mine_count: 0, assigned_count: 5, all_count: count + 5 }, payload } });

/** 集計する → （その結果で）取得の状態・対応待ちの判定・通知の入力を評価する */
function evaluate(httpJson) {
  const nodes = { [HTTP]: [{ json: httpJson }] };
  const agg = evalSetNode(AGG, { nodes });
  const after = { ...nodes, 集計する: [{ json: agg }] };
  const inputs = (node) => Object.fromEntries(Object.entries(node.parameters.workflowInputs.value).map(([k, v]) => [k, evalExpression(v, { nodes: after })]));
  return { agg, hasWaiting: evalIfLeft(HAS_WAITING, { nodes: after }), fetch: inputs(FETCH_STATE), notify: inputs(NOTIFY) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("集計する・取得の状態・対応待ちの判定", () => {
  describe("正常系", () => {
    it("未割り当ての件数・最も長い待ち時間・会話の番号を内訳にし、取得は ok、対応待ちありとして通知する", () => {
      const r = evaluate(ok([conv(12, 30), conv(13, 5), conv(14, 1)]));
      expect(r.agg).toEqual({ ok: true, unassigned: 3, detail: "未割り当て 3 件／最も長い待ち 30 時間／未割り当ての会話 #12 #13 #14" });
      expect(r.fetch).toMatchObject({ channel: "ops", kind: "weekly-inventory:fetch", state: "ok", detail: "" });
      expect(r.hasWaiting).toBe(true);
      expect(r.notify).toMatchObject({ channel: "lead", kind: "weekly-inventory", idLabel: "unassigned", id: "3", state: "", detail: r.agg.detail });
    });

    it("会話の番号は先頭の 10 件だけを載せ、件数が 10 を超えれば「ほか」を付ける（件数は meta の総数。1 ページ目より多くてもよい）", () => {
      const payload = Array.from({ length: 25 }, (_, i) => conv(100 + i, 1));
      const { agg } = evaluate(ok(payload, 40));
      expect(agg.unassigned).toBe(40);
      expect(agg.detail).toBe(`未割り当て 40 件／最も長い待ち 1 時間／未割り当ての会話 ${payload.slice(0, 10).map((c) => `#${c.id}`).join(" ")} ほか`);
    });

    it("待ち時間は時間単位の切り捨てで、waiting_since が 0（待っていない）の会話は待ち時間の計算に入れない", () => {
      const { agg } = evaluate(ok([conv(1, null), conv(2, 2.9)]));
      expect(agg.detail).toContain("最も長い待ち 2 時間");
    });

    it("meta の件数が文字列でも数にする", () => {
      expect(evaluate({ data: { meta: { unassigned_count: "2" }, payload: [conv(1, 1), conv(2, 1)] } }).agg.unassigned).toBe(2);
    });

    it("内訳には件数・番号・待ち時間だけを載せ、会話の連絡先・本文は載せない", () => {
      const pii = { meta: { sender: { name: "山田 太郎", email: "taro@example.com", phone_number: "+819000000000" } }, messages: [{ content: "料金を知りたい" }] };
      const { agg } = evaluate(ok([conv(1, 3, pii)]));
      for (const s of ["山田", "taro@example.com", "+819000000000", "料金"]) expect(agg.detail).not.toContain(s);
    });

    it("空入力: 未割り当てが 0 件なら、取得は ok だが対応待ちは無しとして通知しない", () => {
      const r = evaluate(ok([]));
      expect(r.agg).toEqual({ ok: true, unassigned: 0, detail: "未割り当て 0 件／最も長い待ち 0 時間／未割り当ての会話 なし" });
      expect(r.fetch.state).toBe("ok");
      expect(r.hasWaiting).toBe(false);
    });
  });

  describe("異常系", () => {
    it("サーバ: 取得に失敗した（401・5xx・タイムアウトで error だけが来る）なら取得は ng で ops に伝え、lead には通知しない", () => {
      const r = evaluate({ error: { message: "401 - Unauthorized", httpCode: "401" } });
      expect(r.agg).toMatchObject({ ok: false, unassigned: 0 });
      expect(r.fetch.state).toBe("ng");
      expect(r.hasWaiting).toBe(false);
    });

    it("サーバ: JSON でない応答（n8n は本文の文字列を data に入れる）なら取得は ng で、例外にしない", () => {
      const r = evaluate({ data: "<html>502 Bad Gateway</html>" });
      expect(r.agg.ok).toBe(false);
      expect(r.fetch.state).toBe("ng");
      expect(r.hasWaiting).toBe(false);
    });

    it("サーバ: payload が無い応答（meta だけ）なら、件数があっても取得は ng で通知しない", () => {
      const r = evaluate({ data: { meta: { unassigned_count: 3 } } });
      expect(r.agg).toMatchObject({ ok: false, unassigned: 3 });
      expect(r.hasWaiting).toBe(false);
    });

    // detail の式は、payload が配列でなければ 0 件として扱う（以前は .map の TypeError で「集計する」が失敗し、ng の通知まで進まなかった）
    it("サーバ: payload が配列でない（オブジェクトの）応答でも、集計が例外にならずに取得を ng として伝える", () => {
      const r = evaluate({ data: { meta: { unassigned_count: 2 }, payload: { 0: conv(1, 3), 1: conv(2, 1) } } });
      expect(r.agg).toEqual({ ok: false, unassigned: 2, detail: "未割り当て 2 件／最も長い待ち 0 時間／未割り当ての会話 なし" });
      expect(r.fetch).toMatchObject({ channel: "ops", kind: "weekly-inventory:fetch", state: "ng" });
      expect(r.hasWaiting).toBe(false);
    });

    it("空入力: 応答が空（{}）なら取得は ng", () => {
      const r = evaluate({});
      expect(r.agg).toEqual({ ok: false, unassigned: 0, detail: "未割り当て 0 件／最も長い待ち 0 時間／未割り当ての会話 なし" });
      expect(r.fetch.state).toBe("ng");
    });
  });
});

describe("棚卸しのスイッチ（IF の左辺。ops_settings の inventoryEnabled）", () => {
  const left = (rows) => evalIfLeft(GATE, { nodes: { 設定を読む: rows.map((json) => ({ json })) } });

  describe("正常系", () => {
    it("行の値が 'true' なら 'true'", () => {
      expect(left([{ key: "inventoryEnabled", value: "true" }])).toBe("true");
    });

    it("取得先の URL は ops_settings の chatwootBaseUrl と chatwootAccountId から組む", () => {
      const http = getNode(wf, HTTP);
      const nodes = { 設定を読む: [{ json: { key: "chatwootBaseUrl", value: "http://host.docker.internal:3100" } }, { json: { key: "chatwootAccountId", value: "1" } }] };
      expect(evalExpression(http.parameters.url, { nodes })).toBe("http://host.docker.internal:3100/api/v1/accounts/1/conversations");
    });
  });

  describe("異常系", () => {
    it("空入力: ops_settings が 0 行ならスイッチは 'false'", () => {
      expect(left([])).toBe("false");
    });

    it("入力: 'true' 以外の値（'TRUE'・'yes'）では進まない", () => {
      expect(left([{ key: "inventoryEnabled", value: "TRUE" }])).not.toBe("true");
      expect(left([{ key: "inventoryEnabled", value: "yes" }])).not.toBe("true");
    });
  });
});
