// I-21 SNS 通知（サブワークフロー）の、通知の組み立てと分岐の式。Code ノードは無く、ロジックは Edit Fields・IF・SNS の式にあるので評価して確かめる。
// 式の中の DateTime（n8n が式に渡す Luxon）は外部ライブラリなので、使っている呼び方（fromSeconds → setZone → toFormat）だけを持つ偽物に差し替える。
// SNS・MailHog には繋がない。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evalExpression, evalIfLeft, evalSetNode, getNode, loadWorkflow } from "../helpers/workflow.mjs";

const wf = loadWorkflow("I-21-sns-notify.json");
const TRIGGER = "サブワークフローの入力";
const MESSAGE = getNode(wf, "メッセージを組み立てる");
const CHANGED = getNode(wf, "ok と ng が入れ替わったか");
const BACKEND = getNode(wf, "本番の配信（SNS）か");
const SNS = getNode(wf, "SNS に発行");

const NOW = new Date("2026-10-05T03:00:00Z");

/** Luxon の DateTime の偽物。Asia/Tokyo と 'yyyy-MM-dd HH:mm' だけを扱う（ほかの呼び方なら失敗させて、式の変更に気付けるようにする） */
const DateTime = {
  fromSeconds: (sec) => ({
    setZone: (zone) => {
      if (zone !== "Asia/Tokyo") throw new Error(`想定外のタイムゾーン: ${zone}`);
      return {
        toFormat: (fmt) => {
          if (fmt !== "yyyy-MM-dd HH:mm") throw new Error(`想定外の書式: ${fmt}`);
          // Luxon は数でない秒から無効な日時を作り、toFormat は "Invalid DateTime" を返す
          if (!Number.isFinite(sec)) return "Invalid DateTime";
          return new Date(sec * 1000 + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
        },
      };
    },
  }),
};

const lead = (over = {}) => ({ channel: "lead", kind: "demo-requested", idLabel: "contact", id: "42", company: "株式会社テスト", sourcePath: "/blog/a?utm_source=x", receivedAtSec: 1_791_000_000, state: "", detail: "", ...over });
const ops = (over = {}) => ({ channel: "ops", kind: "ops-monitor:9", idLabel: "", id: "", company: "", sourcePath: "", receivedAtSec: 1_791_000_000, state: "ng", detail: "", ...over });
const build = (input) => evalSetNode(MESSAGE, { nodes: { [TRIGGER]: [{ json: input }] }, globals: { DateTime } });
const AT = "2026-10-03 13:00 JST"; // 1_791_000_000 秒（2026-10-03T04:00:00Z）を JST にしたもの

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("メッセージを組み立てる（Edit Fields）", () => {
  describe("正常系", () => {
    it("顧客からの要求（lead）は、種別・会社名・システム上の ID・流入記事（クエリを除く）・受付時刻・確認先を並べる", () => {
      expect(build(lead())).toEqual({
        subject: "[comegin] lead: demo-requested (contact 42)",
        body: ["種別: demo-requested", "会社名: 株式会社テスト", "システム上の ID: contact 42", "流入記事: /blog/a", `受付: ${AT}`, "確認: Mautic のコンタクト画面を見る"].join("\n"),
      });
    });

    it("Chatwoot の会話（idLabel が contact 以外）は、Chatwoot の会話画面を確認先にする", () => {
      expect(build(lead({ kind: "conversation-opened", idLabel: "conversation", id: "12" })).body.split("\n").at(-1)).toBe("確認: Chatwoot の会話画面を見る");
    });

    it("監視（ops）は、種別・状態・検知時刻・確認先を並べる", () => {
      expect(build(ops())).toEqual({
        subject: "[comegin] ops: ops-monitor:9 ng",
        body: ["種別: ops-monitor:9", "状態: ng", `検知: ${AT}`, "確認: 監視の項目 ops-monitor:9 を確認する"].join("\n"),
      });
    });

    it("detail があれば「内訳」の行を、最後の「確認」の行の直前に入れる（lead・ops のどちらでも）", () => {
      const o = build(ops({ detail: "最短の期限まで 12 日（2026-10-17）" })).body.split("\n");
      expect(o.at(-2)).toBe("内訳: 最短の期限まで 12 日（2026-10-17）");
      expect(o.at(-1)).toMatch(/^確認: /);
      const l = build(lead({ kind: "weekly-inventory", idLabel: "unassigned", id: "3", company: "", sourcePath: "", detail: "未割り当て 3 件" })).body.split("\n");
      expect(l).toEqual(["種別: weekly-inventory", "システム上の ID: unassigned 3", `受付: ${AT}`, "内訳: 未割り当て 3 件", "確認: Chatwoot の会話画面を見る"]);
    });

    it("空入力: detail・company・sourcePath が空なら、その行を出さない", () => {
      const body = build(lead({ company: "", sourcePath: "", detail: "" })).body;
      expect(body).not.toMatch(/会社名|流入記事|内訳/);
    });

    it("空入力: receivedAtSec が 0・空なら、今の時刻を受付の時刻にする", () => {
      expect(build(ops({ receivedAtSec: 0 })).body).toContain("検知: 2026-10-05 12:00 JST");
      expect(build(ops({ receivedAtSec: "" })).body).toContain("検知: 2026-10-05 12:00 JST");
    });
  });

  describe("異常系", () => {
    it("入力: 件名の ASCII 以外の文字は ? に置き換える（SNS の Subject は ASCII だけ）", () => {
      expect(build(ops({ kind: "監視", state: "ng" })).subject).toBe("[comegin] ops: ?? ng");
    });

    it("入力: 件名が長すぎれば 99 文字で切る（SNS の Subject は 100 文字未満）", () => {
      const { subject } = build(lead({ kind: "x".repeat(200) }));
      expect(subject).toHaveLength(99);
      expect(subject).toMatch(/^[ -~]+$/);
    });

    it("入力: detail の改行・連続した空白は 1 つの空白にまとめ、200 文字で切る（1 行に収める）", () => {
      const line = build(ops({ detail: `a\n\nb\t c${"x".repeat(300)}` })).body.split("\n").find((l) => l.startsWith("内訳: "));
      expect(line.startsWith("内訳: a b c")).toBe(true);
      expect(line).toHaveLength("内訳: ".length + 200);
    });

    it("入力: 会社名は 100 文字、流入記事は 200 文字で切る", () => {
      const body = build(lead({ company: "社".repeat(150), sourcePath: `/${"p".repeat(300)}` })).body.split("\n");
      expect(body.find((l) => l.startsWith("会社名: "))).toHaveLength("会社名: ".length + 100);
      expect(body.find((l) => l.startsWith("流入記事: "))).toHaveLength("流入記事: ".length + 200);
    });

    it("入力: receivedAtSec が数でなければ、検知の時刻は Invalid DateTime になる（例外にはしない）", () => {
      expect(build(ops({ receivedAtSec: "abc" })).body).toContain("検知: Invalid DateTime JST");
    });

    it("空入力: 入力がすべて空でも例外にせず、件名は ASCII のまま組み立てる", () => {
      const r = build({});
      expect(r.subject).toBe("[comegin] lead: undefined (undefined undefined)");
      expect(r.body.split("\n")[0]).toBe("種別: undefined");
    });
  });
});

describe("ok と ng が入れ替わったか（IF）", () => {
  const changed = (input, previous) => {
    const node = CHANGED.parameters.conditions.conditions[0];
    const ctx = { json: previous, nodes: { [TRIGGER]: [{ json: input }] } };
    return evalExpression(node.leftValue, ctx) !== evalExpression(node.rightValue, ctx);
  };

  describe("正常系", () => {
    it("前回と状態が違うときだけ通知する（ok → ng・ng → ok）", () => {
      expect(changed(ops({ state: "ng" }), { checkId: "ops-monitor:9", state: "ok" })).toBe(true);
      expect(changed(ops({ state: "ok" }), { checkId: "ops-monitor:9", state: "ng" })).toBe(true);
      expect(changed(ops({ state: "ng" }), { checkId: "ops-monitor:9", state: "ng" })).toBe(false);
    });

    it("前回の状態を読む Data Table は、行が無くても次へ進む（alwaysOutputData）", () => {
      expect(getNode(wf, "前回の状態を読む").alwaysOutputData).toBe(true);
    });

    it("空入力: 前回の状態の行が無い（初回）なら ok だったとみなし、最初の ng だけを通知する", () => {
      expect(changed(ops({ state: "ng" }), {})).toBe(true);
      expect(changed(ops({ state: "ok" }), {})).toBe(false);
    });
  });
});

describe("配信先の選び方（本番の配信（SNS）か・SNS に発行）", () => {
  const settings = (rows, input = ops()) => ({ nodes: { 設定を読む: rows.map((json) => ({ json })), [TRIGGER]: [{ json: input }] } });
  const ROWS = [
    { key: "notifyBackend", value: "sns" },
    { key: "snsTopicArnLead", value: "arn:aws:sns:ap-northeast-1:000000000000:comegin-lead-alert" },
    { key: "snsTopicArnOps", value: "arn:aws:sns:ap-northeast-1:000000000000:comegin-ops-alert" },
  ];

  describe("正常系", () => {
    it("notifyBackend が sns なら SNS に送り、ops は ops のトピック、lead は lead のトピックに出す", () => {
      expect(evalIfLeft(BACKEND, settings(ROWS))).toBe("sns");
      expect(evalExpression(SNS.parameters.topic.value, settings(ROWS, ops()))).toMatch(/comegin-ops-alert$/);
      expect(evalExpression(SNS.parameters.topic.value, settings(ROWS, lead()))).toMatch(/comegin-lead-alert$/);
    });
  });

  describe("異常系", () => {
    it("空入力: ops_settings が 0 行なら MailHog（開発）に送る（本番の SNS を既定にしない）", () => {
      expect(evalIfLeft(BACKEND, settings([]))).toBe("mailhog");
    });

    it("空入力: トピックの行が無ければトピックは未定義になる（SNS ノードが失敗し、呼び出し側は onError で止まらない）", () => {
      expect(evalExpression(SNS.parameters.topic.value, settings([{ key: "notifyBackend", value: "sns" }]))).toBeUndefined();
    });
  });
});
