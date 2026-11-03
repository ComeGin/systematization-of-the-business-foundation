import { describe, expect, it } from "vitest";
import type { SetupStatusLevel } from "control-plane";
import {
  LEVEL_INDICATOR,
  LEVEL_ORDER,
  defaultStepId,
  docUrl,
  isExternalHttpUrl,
  resolveStepId,
  stepHref,
} from "@/components/setup-status/status-format";

const step = (id: string, level: SetupStatusLevel) => ({ id, level });

describe("LEVEL_INDICATOR（判定 → 印と文言）", () => {
  describe("正常系", () => {
    it.each([
      ["action", "error", "更新が必要"],
      ["warn", "warning", "警告"],
      ["unknown", "stopped", "確かめられない"],
      ["manual", "info", "人が確かめる"],
      ["ok", "success", "済み"],
    ] as const)("%s は %s の表示で「%s」と出す", (level, type, label) => {
      expect(LEVEL_INDICATOR[level]).toEqual({ type, label });
    });

    it("件数の並びは重い順（更新が必要・警告・確かめられない・人が確かめる・済み）で、5 種類すべてを含む", () => {
      expect(LEVEL_ORDER).toEqual(["action", "warn", "unknown", "manual", "ok"]);
      expect(Object.keys(LEVEL_INDICATOR).sort()).toEqual([...LEVEL_ORDER].sort());
    });
  });
});

describe("defaultStepId（既定の選択）", () => {
  describe("正常系", () => {
    it("更新が必要な最初の段階を選ぶ（警告より優先）", () => {
      const steps = [step("P1", "ok"), step("P2", "warn"), step("P3", "action"), step("P4", "action")];
      expect(defaultStepId(steps)).toBe("P3");
    });

    it("更新が必要が無ければ警告の最初、それも無ければ確かめられない", () => {
      expect(defaultStepId([step("P1", "ok"), step("P2", "unknown"), step("P3", "warn")])).toBe("P3");
      expect(defaultStepId([step("P1", "ok"), step("P2", "manual"), step("P3", "unknown")])).toBe("P3");
    });

    it("すべて済み・人が確かめるだけなら先頭の段階（P1）", () => {
      expect(defaultStepId([step("P1", "ok"), step("P2", "manual")])).toBe("P1");
    });
  });

  describe("異常系", () => {
    it("空入力: 段階が 0 件なら null", () => {
      expect(defaultStepId([])).toBeNull();
    });
  });
});

describe("resolveStepId（?step= の解決）", () => {
  const steps = [step("P1", "ok"), step("P2", "action"), step("R1", "manual")];

  describe("正常系", () => {
    it("実在する段階の id ならそれを選ぶ（R1 も）", () => {
      expect(resolveStepId(steps, "P1")).toBe("P1");
      expect(resolveStepId(steps, "R1")).toBe("R1");
    });

    it("空入力: 指定が無ければ既定の選択", () => {
      expect(resolveStepId(steps, undefined)).toBe("P2");
    });
  });

  describe("異常系", () => {
    it.each(["P99", "", "p1", "P1 "])("入力: 実在しない段階（「%s」）は既定の選択に戻す", (requested) => {
      expect(resolveStepId(steps, requested)).toBe("P2");
    });

    it("入力: ?step= が複数（配列）なら既定の選択に戻す", () => {
      expect(resolveStepId(steps, ["P1", "R1"])).toBe("P2");
    });

    it("空入力: 段階が 0 件なら null", () => {
      expect(resolveStepId([], "P1")).toBeNull();
    });
  });
});

describe("isExternalHttpUrl（Markdown のリンク）", () => {
  describe("正常系", () => {
    it.each(["https://example.com/a?b=c", "http://127.0.0.1:3200/x"])("絶対の http(s)（%s）はリンクにしてよい", (href) => {
      expect(isExternalHttpUrl(href)).toBe(true);
    });
  });

  describe("異常系", () => {
    it.each(["cloud/README.md", "./cloud/README.md", "../x.md", "/cloud/README.md", "#4-14", "mailto:a@example.com", "javascript:alert(1)", "data:text/html,x", "ftp://example.com"])(
      "入力: 相対パス・アンカー・http(s) 以外（%s）はリンクにしない",
      (href) => {
        expect(isExternalHttpUrl(href)).toBe(false);
      },
    );

    it("空入力: href が無い・空ならリンクにしない", () => {
      expect(isExternalHttpUrl(undefined)).toBe(false);
      expect(isExternalHttpUrl("")).toBe(false);
    });
  });
});

describe("URL の組み立て", () => {
  describe("正常系", () => {
    it("docUrl は file と heading をエンコードして API の URL にする", () => {
      const url = new URL(docUrl("cloud/README.md", "4.14 再配信 & 確認"), "http://x");
      expect(url.pathname).toBe("/api/setup-status/doc");
      expect(url.searchParams.get("file")).toBe("cloud/README.md");
      expect(url.searchParams.get("heading")).toBe("4.14 再配信 & 確認");
    });

    it("stepHref は ?step= に段階の id を持つ画面の URL にする", () => {
      expect(stepHref("P12")).toBe("/setup-status?step=P12");
    });
  });
});
