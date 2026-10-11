// n8n スケジュール実行のハートビート（n8n-schedule-heartbeat）。スイッチの IF と、PutMetricData の名前空間の式を評価して確かめる。
// CloudWatch には繋がない（HTTP ノードは動かさない）。
import { describe, expect, it } from "vitest";
import { evalExpression, evalIfLeft, getNode, loadWorkflow } from "../helpers/workflow.mjs";

const wf = loadWorkflow("n8n-schedule-heartbeat.json");
const GATE = getNode(wf, "ハートビートが有効か");
const PUT = getNode(wf, "CloudWatch に PutMetricData");
const param = (name) => PUT.parameters.bodyParameters.parameters.find((p) => p.name === name).value;
const settings = (rows) => ({ nodes: { 設定を読む: rows.map((json) => ({ json })) } });

describe("ハートビートが有効か（IF の左辺。ops_settings の heartbeatEnabled）", () => {
  describe("正常系", () => {
    it("行の値が 'true' なら 'true'（PutMetricData へ進む）", () => {
      expect(evalIfLeft(GATE, settings([{ key: "heartbeatEnabled", value: "true" }]))).toBe("true");
    });

    it("IF は 1 回だけ判定する（executeOnce。設定の行の数だけ送らない）", () => {
      expect(GATE.executeOnce).toBe(true);
    });
  });

  describe("異常系", () => {
    it("空入力: ops_settings が 0 行ならスイッチは 'false'（既定で止まっている）", () => {
      expect(evalIfLeft(GATE, settings([]))).toBe("false");
    });

    it("入力: 'false'・'TRUE' では進まない", () => {
      expect(evalIfLeft(GATE, settings([{ key: "heartbeatEnabled", value: "false" }]))).toBe("false");
      expect(evalIfLeft(GATE, settings([{ key: "heartbeatEnabled", value: "TRUE" }]))).not.toBe("true");
    });

    it("サーバ: CloudWatch への送信が失敗したら実行を失敗にする（onError を付けない。届かないこと自体をクラウドのアラームが検知する）", () => {
      expect(PUT.onError).toBeUndefined();
      expect(PUT.parameters.options.timeout).toBeGreaterThan(0);
    });
  });
});

describe("PutMetricData の名前空間（式）", () => {
  describe("正常系", () => {
    it("ops_settings の heartbeatNamespace があれば、その値を使う", () => {
      expect(evalExpression(param("Namespace"), settings([{ key: "heartbeatNamespace", value: "ComeGin/Other" }]))).toBe("ComeGin/Other");
    });
  });

  describe("異常系", () => {
    it("空入力: 行が無いときは ComeGin/OnpremN8n（cloud の IAM の条件とアラームの名前空間）", () => {
      expect(evalExpression(param("Namespace"), settings([]))).toBe("ComeGin/OnpremN8n");
    });

    it("空入力: 値が空文字のときも ComeGin/OnpremN8n にする（|| で空文字を既定値に置き換える）", () => {
      expect(evalExpression(param("Namespace"), settings([{ key: "heartbeatNamespace", value: "" }]))).toBe("ComeGin/OnpremN8n");
    });
  });
});
