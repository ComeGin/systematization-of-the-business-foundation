import { describe, expect, it } from "vitest";
import type { Catalog, CatalogItem } from "../../src/status/catalog.js";
import type { DriftResult } from "../../src/status/drift.js";
import { evaluate, mergeModuleResults, worstLevel, type ModuleResultWithTime } from "../../src/status/evaluate.js";

const AT = "2026-11-03T10:00:00.000+09:00";
const EARLIER = "2026-11-03T09:00:00.000+09:00";

const item = (id: string, probe: CatalogItem["probe"], extra: Partial<CatalogItem> = {}): CatalogItem => ({
  id,
  title: `${id} の見出し`,
  who: "自動",
  kind: "検査",
  overviewText: id,
  probe,
  docs: [{ file: "cloud/README.md", heading: "4.4" }],
  ...extra,
});

const catalogOf = (stepId: string, items: CatalogItem[]): Catalog => ({
  version: 1,
  productApiModules: [],
  steps: [{ id: stepId, title: `${stepId} の段階`, items }],
});

const result = (overrides: Partial<ModuleResultWithTime> = {}): ModuleResultWithTime => ({
  moduleId: "cloud",
  phase: "apps",
  ok: true,
  notes: [],
  items: [],
  error: null,
  skipped: false,
  checkedAt: AT,
  script: "setup/setup.mjs",
  ...overrides,
});

const only = (catalog: Catalog, results: ModuleResultWithTime[], drifts: DriftResult[] = [], fetchError: string | null = null) =>
  evaluate(catalog, results, drifts, fetchError, { checkedAt: AT }).steps[0]!.items[0]!;

describe("evaluate", () => {
  describe("正常系", () => {
    it("入力: module の ok で notes に「! 」が無ければ ok、根拠は notes を「／」でつなぐ", () => {
      const view = only(catalogOf("P4", [item("P4.a", { kind: "module", module: "cloud", phase: "apps" })]), [
        result({ notes: ["DB がある", "タスクが成功"] }),
      ]);
      expect(view).toMatchObject({ level: "ok", evidence: "DB がある／タスクが成功", checkedAt: AT });
    });

    it("入力: ok で '! ' の notes は warn", () => {
      const view = only(catalogOf("P4", [item("P4.a", { kind: "module", module: "cloud", phase: "apps" })]), [
        result({ notes: ["DB がある", "! SMTP の Secret が空"] }),
      ]);
      expect(view.level).toBe("warn");
    });

    it("入力: module の !ok は action", () => {
      const view = only(catalogOf("P4", [item("P4.a", { kind: "module", module: "cloud", phase: "apps" })]), [
        result({ ok: false, notes: ["DB 作成のタスクのログが無い"] }),
      ]);
      expect(view).toMatchObject({ level: "action", evidence: "DB 作成のタスクのログが無い" });
    });

    it("入力: item は key と step（カタログの段階）が一致する項目の level と根拠を使う", () => {
      const results = [
        result({
          phase: "operate",
          items: [
            { key: "cloud.ses-production", step: "P15", level: "ok", title: "SES", evidence: "本番の送信が有効" },
            { key: "cloud.ses-production", step: "P12", level: "warn", title: "SES", evidence: "サンドボックス", stopId: "cloud:ses" },
          ],
        }),
      ];
      const p12 = only(catalogOf("P12", [item("P12.ses", { kind: "item", key: "cloud.ses-production" })]), results);
      expect(p12).toMatchObject({ level: "warn", evidence: "サンドボックス", stopId: "cloud:ses" });
      const p15 = only(catalogOf("P15", [item("P15.ses", { kind: "item", key: "cloud.ses-production" })]), results);
      expect(p15).toMatchObject({ level: "ok", evidence: "本番の送信が有効" });
    });

    it("入力: カタログの stopId があればモジュールの stopId より優先する", () => {
      const view = only(
        catalogOf("P2", [item("P2.sns", { kind: "item", key: "cloud.sns-subscription" }, { stopId: "cloud:catalog" })]),
        [result({ items: [{ key: "cloud.sns-subscription", step: "P2", level: "ok", title: "", evidence: "e", stopId: "cloud:module" }] })],
      );
      expect(view.stopId).toBe("cloud:catalog");
    });

    it("入力: items は最も重い level、根拠は各 key の根拠を「／」でつなぎ、時刻は最も古いもの", () => {
      const results = [
        result({ items: [{ key: "cloud.ses-domain", step: "P4", level: "ok", title: "", evidence: "DKIM が SUCCESS" }] }),
        result({
          moduleId: "cloud",
          phase: "deploy",
          checkedAt: EARLIER,
          items: [{ key: "cloud.dmarc", step: "P4", level: "warn", title: "", evidence: "DMARC が無い" }],
        }),
      ];
      const view = only(catalogOf("P4", [item("P4.mail", { kind: "items", keys: ["cloud.ses-domain", "cloud.dmarc"] })]), results);
      expect(view).toMatchObject({ level: "warn", evidence: "DKIM が SUCCESS／DMARC が無い", checkedAt: EARLIER });
    });

    it("入力: drift はずれの確認の結果を使う", () => {
      const view = only(catalogOf("P12", [item("P12.site", { kind: "drift", id: "site-redeploy" })]), [], [
        { id: "site-redeploy", level: "action", evidence: "配信の後に main に変更 PR #60" },
      ]);
      expect(view).toMatchObject({ level: "action", evidence: "配信の後に main に変更 PR #60", checkedAt: AT });
    });

    it("入力: none は manual で、時刻を持たない", () => {
      const view = only(catalogOf("P1", [item("P1.limit", { kind: "none" }, { kind: "未検査" })]), []);
      expect(view).toMatchObject({ level: "manual", evidence: "〔未検査〕人が確かめる", checkedAt: null, stopId: null });
    });

    it("入力: 段階は最も重い level で、counts の合計は項目の数", () => {
      const catalog: Catalog = {
        version: 1,
        productApiModules: [],
        steps: [
          {
            id: "P4",
            title: "apps",
            items: [
              item("P4.ok", { kind: "module", module: "cloud", phase: "apps" }),
              item("P4.none", { kind: "none" }),
              item("P4.drift", { kind: "drift", id: "n8n-workflows" }),
            ],
          },
          { id: "R1", title: "判断", items: [item("R1.a", { kind: "none" }, { kind: "判断" })] },
        ],
      };
      const view = evaluate(catalog, [result()], [{ id: "n8n-workflows", level: "unknown", evidence: "読めない" }], null, { checkedAt: AT });
      expect(view.steps.map((s) => s.level)).toEqual(["unknown", "manual"]);
      expect(view.counts).toEqual({ ok: 1, action: 0, warn: 0, manual: 2, unknown: 1 });
      expect(view.checkedAt).toBe(AT);
    });
  });

  describe("異常系", () => {
    it("入力: module の error は unknown", () => {
      const view = only(catalogOf("P4", [item("P4.a", { kind: "module", module: "cloud", phase: "apps" })]), [
        result({ ok: false, error: "AWS に届かない" }),
      ]);
      expect(view).toMatchObject({ level: "unknown", evidence: "確かめられなかった: AWS に届かない" });
    });

    it("入力: 飛ばしたまま前回の結果も無いモジュールは unknown（1 時間に 1 回の旨）", () => {
      const view = only(catalogOf("P7", [item("P7.a", { kind: "module", module: "chatwoot-prod", phase: "apps" })]), [
        result({ moduleId: "chatwoot-prod", skipped: true }),
      ]);
      expect(view).toMatchObject({ level: "unknown", checkedAt: null });
      expect(view.evidence).toContain("1 時間に 1 回");
    });

    it("空入力: モジュールの結果が無ければ unknown で、親スクリプトの失敗を添える", () => {
      const view = evaluate(
        catalogOf("P4", [item("P4.a", { kind: "module", module: "cloud", phase: "apps" })]),
        [],
        [],
        null,
        { checkedAt: AT, runErrors: ["setup/setup.mjs の確認が 300 秒で終わらなかった"] },
      ).steps[0]!.items[0]!;
      expect(view).toMatchObject({
        level: "unknown",
        evidence: "モジュールの結果が無い（setup/setup.mjs の確認が 300 秒で終わらなかった）",
      });
    });

    it("入力: item の key が無ければ unknown「モジュールが項目を返さなかった」", () => {
      const view = only(catalogOf("P2", [item("P2.sns", { kind: "item", key: "cloud.sns-subscription" })]), [result()]);
      expect(view).toMatchObject({ level: "unknown", evidence: "モジュールが項目を返さなかった" });
    });

    it("入力: step が違う項目は当てない", () => {
      const view = only(catalogOf("P2", [item("P2.sns", { kind: "item", key: "cloud.sns-subscription" })]), [
        result({ items: [{ key: "cloud.sns-subscription", step: "P3", level: "ok", title: "", evidence: "" }] }),
      ]);
      expect(view.level).toBe("unknown");
    });

    it("入力: items の key の一部が無ければ、その key は unknown として重さに入る", () => {
      const view = only(catalogOf("P4", [item("P4.mail", { kind: "items", keys: ["cloud.ses-domain", "cloud.dmarc"] })]), [
        result({ items: [{ key: "cloud.ses-domain", step: "P4", level: "ok", title: "", evidence: "DKIM が SUCCESS" }] }),
      ]);
      expect(view).toMatchObject({ level: "unknown", evidence: "DKIM が SUCCESS／モジュールが項目を返さなかった" });
    });

    it("入力: fetch が失敗していれば drift は unknown で、理由を出す", () => {
      const view = only(
        catalogOf("P12", [item("P12.site", { kind: "drift", id: "site-redeploy" })]),
        [],
        [{ id: "site-redeploy", level: "ok", evidence: "古い結果" }],
        "GitHub のトークンのファイルを読めない（ENOENT）",
      );
      expect(view).toMatchObject({ level: "unknown", evidence: expect.stringContaining("GitHub のトークンのファイルを読めない（ENOENT）") });
    });
  });
});

describe("mergeModuleResults", () => {
  describe("正常系", () => {
    it("入力: (moduleId, phase) が同じなら、先に渡した setup.mjs のほうを使う", () => {
      const fromSetup = result({ moduleId: "ga4", phase: "google", notes: ["setup"] });
      const fromFrontend = result({ moduleId: "ga4", phase: "google", notes: ["frontend"], script: "setup/frontend.mjs" });
      const other = result({ moduleId: "verdant-virgo", phase: "apps", script: "setup/frontend.mjs" });
      expect(mergeModuleResults([fromSetup], [fromFrontend, other])).toEqual([fromSetup, other]);
    });
  });
});

describe("worstLevel", () => {
  describe("正常系", () => {
    it("入力: 重さの順は action > warn > unknown > manual > ok", () => {
      expect(worstLevel(["ok", "manual", "unknown", "warn", "action"])).toBe("action");
      expect(worstLevel(["ok", "manual", "unknown", "warn"])).toBe("warn");
      expect(worstLevel(["ok", "manual", "unknown"])).toBe("unknown");
      expect(worstLevel(["ok", "manual"])).toBe("manual");
    });
  });

  describe("異常系", () => {
    it("空入力: 空なら ok", () => {
      expect(worstLevel([])).toBe("ok");
    });
  });
});
