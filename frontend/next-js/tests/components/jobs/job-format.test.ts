import { describe, expect, it, vi } from "vitest";
import type { JobDefinition, JobStatus } from "control-plane";

// Cloudscape の部品は描かずに、渡した props だけを見る（node の環境では CSS を読めないため差し替える）
const mocks = vi.hoisted(() => ({
  StatusIndicator: function StatusIndicator(_props: { type: string; children?: unknown }) {
    return null;
  },
}));

vi.mock("@cloudscape-design/components/status-indicator", () => ({ default: mocks.StatusIndicator }));

import { EnabledStatus, jobKindLabel, schedulerDescription } from "@/components/jobs/job-format";

type Element = { type: unknown; props: { type: string; children: unknown } };

function definition(overrides: Partial<JobDefinition> = {}): JobDefinition {
  return {
    id: "daily-seo",
    description: "SEO の観測",
    enabled: true,
    cron: "0 9 * * *",
    kind: "agent",
    agent: "seo-auditor",
    builtin: null,
    after: [],
    timeoutSec: 600,
    maxTurns: 30,
    ...overrides,
  };
}

function job(overrides: Partial<JobDefinition> = {}, nextRunAt: string | null = "2026-10-06T09:00:00+09:00"): JobStatus {
  return { definition: definition(overrides), nextRunAt, lastRun: null };
}

const SCHEDULER_ON = "定期実行は有効です（CONTROL_SCHEDULER_ENABLED=true）";
const SCHEDULER_OFF = "定期実行は無効です（CONTROL_SCHEDULER_ENABLED=false）。手動の起動だけ動きます";
const NO_ENABLED_JOB = "有効（enabled: true）なジョブがありません";

describe("EnabledStatus", () => {
  describe("正常系", () => {
    it("有効なら success の表示で「有効」と出す", () => {
      const element = EnabledStatus({ enabled: true }) as unknown as Element;
      expect(element.type).toBe(mocks.StatusIndicator);
      expect(element.props).toMatchObject({ type: "success", children: "有効" });
    });

    it("無効なら stopped の表示で「無効」と出す", () => {
      const element = EnabledStatus({ enabled: false }) as unknown as Element;
      expect(element.props).toMatchObject({ type: "stopped", children: "無効" });
    });
  });
});

describe("jobKindLabel", () => {
  describe("正常系", () => {
    it("エージェントのジョブは agent/<名前>", () => {
      expect(jobKindLabel({ kind: "agent", agent: "seo-auditor", builtin: null })).toBe("agent/seo-auditor");
    });

    it("決まった処理のジョブは builtin/<名前>", () => {
      expect(jobKindLabel({ kind: "builtin", agent: null, builtin: "heartbeat" })).toBe("builtin/heartbeat");
    });

    it("kind で決め、反対側の項目は見ない", () => {
      expect(jobKindLabel({ kind: "builtin", agent: "seo-auditor", builtin: "n8n-export" })).toBe("builtin/n8n-export");
    });
  });

  describe("異常系", () => {
    it("空入力: エージェント名が空文字でも例外にせず、そのまま agent/ を返す（名前の検証は control-plane 側）", () => {
      expect(jobKindLabel({ kind: "agent", agent: "", builtin: null })).toBe("agent/");
    });
  });
});

describe("schedulerDescription", () => {
  describe("正常系", () => {
    it("有効なジョブに次回の起動予定があれば、定期実行は有効と推定する", () => {
      expect(schedulerDescription([job()])).toBe(SCHEDULER_ON);
    });

    it("有効なジョブのうち 1 件でも次回があれば有効と推定する", () => {
      expect(schedulerDescription([job({ id: "a" }, null), job({ id: "b" })])).toBe(SCHEDULER_ON);
    });

    it("有効なジョブがあるのに次回が 1 件も無ければ、定期実行は無効と推定する", () => {
      expect(schedulerDescription([job({}, null), job({ id: "x", enabled: false }, null)])).toBe(SCHEDULER_OFF);
    });

    it("有効なジョブが無ければ、その旨を出す（定期実行の設定は推定できない）", () => {
      expect(schedulerDescription([job({ enabled: false }, null)])).toBe(NO_ENABLED_JOB);
    });
  });

  describe("異常系", () => {
    it("空入力: ジョブが 0 件なら、有効なジョブが無い旨を出す", () => {
      expect(schedulerDescription([])).toBe(NO_ENABLED_JOB);
    });
  });
});
