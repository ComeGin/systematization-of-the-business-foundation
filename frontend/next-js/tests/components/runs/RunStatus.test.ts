import { describe, expect, it, vi } from "vitest";
import type { RunRecord } from "control-plane";

// Cloudscape の部品は描かずに、渡した props だけを見る（node の環境では CSS を読めないため差し替える）
const mocks = vi.hoisted(() => ({
  StatusIndicator: function StatusIndicator(_props: { type: string; children?: unknown }) {
    return null;
  },
}));

vi.mock("@cloudscape-design/components/status-indicator", () => ({ default: mocks.StatusIndicator }));

import { RunStatus, runLabel } from "@/components/runs/RunStatus";

type Element = { type: unknown; props: { type: string; children: unknown } };

const status = (run: Pick<RunRecord, "status" | "outcome">) => (RunStatus({ run }) as unknown as Element).props;

describe("RunStatus", () => {
  describe("正常系", () => {
    it.each([
      ["success", "success", "成功"],
      ["partial", "warning", "一部のみ"],
      ["failure", "error", "失敗"],
      ["skipped", "stopped", "見送り"],
    ] as const)("終わった実行の outcome=%s は %s の表示で「%s」と出す", (outcome, type, text) => {
      expect(status({ status: "finished", outcome })).toMatchObject({ type, children: text });
    });

    it("実行中は outcome に関わらず「実行中」と出す", () => {
      expect(status({ status: "running", outcome: null })).toMatchObject({ type: "in-progress", children: "実行中" });
      expect(status({ status: "running", outcome: "success" })).toMatchObject({ type: "in-progress", children: "実行中" });
    });
  });

  describe("異常系", () => {
    it("空入力: 終わっているのに outcome が null なら「不明」と出す", () => {
      expect(status({ status: "finished", outcome: null })).toMatchObject({ type: "pending", children: "不明" });
    });

    it("入力: 契約に無い outcome（新しい値が増えたときなど）も「不明」と出し、例外にしない", () => {
      expect(status({ status: "finished", outcome: "cancelled" as RunRecord["outcome"] })).toMatchObject({ children: "不明" });
    });
  });
});

describe("runLabel", () => {
  describe("正常系", () => {
    it("ジョブから起動した実行は「<job>（agent/<名前>）」", () => {
      expect(runLabel({ jobId: "daily-seo", agentName: "seo-auditor", builtin: null })).toBe("daily-seo（agent/seo-auditor）");
    });

    it("手動でエージェントを起動した実行（job が無い）は agent/<名前>", () => {
      expect(runLabel({ jobId: null, agentName: "seo-auditor", builtin: null })).toBe("agent/seo-auditor");
    });

    it("決まった処理は builtin/<名前>", () => {
      expect(runLabel({ jobId: "heartbeat", agentName: null, builtin: "heartbeat" })).toBe("heartbeat（builtin/heartbeat）");
    });
  });

  describe("異常系", () => {
    it("空入力: job・エージェント・builtin のどれも無ければ「-」", () => {
      expect(runLabel({ jobId: null, agentName: null, builtin: null })).toBe("-");
    });

    it("空入力: エージェント名が空文字なら builtin を見る", () => {
      expect(runLabel({ jobId: null, agentName: "", builtin: "heartbeat" })).toBe("builtin/heartbeat");
    });
  });
});
