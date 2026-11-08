import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fsPromises from "node:fs/promises";
import { AUDIT_ID_PATTERN, auditDatesForRuns, loadAuditIndex, observationsForRun } from "../../src/definitions/audits.js";
import { makeTempDir, putFile } from "../helpers/store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const RUN = "01M6PHA2X77Q3VTXXPY5RYTHCF";
const OTHER_RUN = "01M6HCGMWTPM51JDBVQ11MQKPR";

let temp: ReturnType<typeof makeTempDir>;
let roots: { worktree: string; mainCheckout: string };

beforeEach(() => {
  temp = makeTempDir();
  roots = { worktree: `${temp.dir}/wt`, mainCheckout: `${temp.dir}/main` };
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  temp.cleanup();
  vi.mocked(fsPromises.readFile).mockClear();
});

function audit(
  root: string,
  id: string,
  fields: { source?: string; correlation?: string; outcome?: string; note?: string; createdBy?: string } = {},
): void {
  const source = fields.source ?? id.split("-")[3]!;
  putFile(
    root,
    `docs/audits/${source}/${id}.md`,
    [
      "---",
      `audit_id: ${id}`,
      `source: ${source}`,
      `created_by: ${fields.createdBy ?? "agent/seo-auditor"}`,
      "measured_at: 2026-11-01T23:59:59+09:00",
      "fetch:",
      `  outcome: ${fields.outcome ?? "ok"}`,
      "  attempts: 1",
      `  correlation_id: ${fields.correlation ?? RUN}`,
      "  measured_at: 2026-11-06T04:00:40+09:00",
      `  note: '${fields.note ?? ""}'`,
      "---",
      "",
      "# 観測の補足",
      "",
      "本文は読まない。",
      "",
    ].join("\n"),
  );
}

describe("AUDIT_ID_PATTERN", () => {
  describe("正常系", () => {
    it.each(["AUD-2026-1106-ops-0001", "AUD-2026-1104-site_audit-0012"])("%s に合う", (id) => {
      expect(AUDIT_ID_PATTERN.test(id)).toBe(true);
    });
  });
  describe("異常系", () => {
    it.each(["E-05", "LH-seo", RUN, "AUD-../x", "AUD-2026-1106-../ops-0001", "AUD-2026-1106-ops-0001.md", ""])("入力: %j に合わない", (id) => {
      expect(AUDIT_ID_PATTERN.test(id)).toBe(false);
    });
  });
});

describe("loadAuditIndex と observationsForRun", () => {
  describe("正常系", () => {
    it("correlation_id が runId と一致する観測を written に、targetIds だけにある観測を referenced に分ける", async () => {
      audit(roots.worktree, "AUD-2026-1106-ops-0001", { outcome: "permission_denied", note: "権限が無い" });
      audit(roots.worktree, "AUD-2026-1104-gsc-0001", { correlation: OTHER_RUN, outcome: "ok" });
      const index = await loadAuditIndex(roots);
      const result = observationsForRun({ runId: RUN, targetIds: ["AUD-2026-1104-gsc-0001", "AUD-2026-1106-ops-0001"] }, index);
      expect(result.runId).toBe(RUN);
      expect(result.written).toEqual([
        {
          auditId: "AUD-2026-1106-ops-0001",
          source: "ops",
          createdBy: "agent/seo-auditor",
          outcome: "permission_denied",
          note: "権限が無い",
          measuredAt: "2026-11-06T04:00:40+09:00",
          found: true,
        },
      ]);
      expect(result.referenced.map((o) => [o.auditId, o.outcome, o.found])).toEqual([["AUD-2026-1104-gsc-0001", "ok", true]]);
    });

    it("targetIds が [] でも、correlation_id が一致する観測は written に入る", async () => {
      audit(roots.worktree, "AUD-2026-1106-ops-0001");
      const result = observationsForRun({ runId: RUN, targetIds: [] }, await loadAuditIndex(roots));
      expect(result.written.map((o) => o.auditId)).toEqual(["AUD-2026-1106-ops-0001"]);
      expect(result.referenced).toEqual([]);
    });

    it("written は audit_id の順", async () => {
      audit(roots.worktree, "AUD-2026-1106-analytics-0002");
      audit(roots.worktree, "AUD-2026-1106-analytics-0001");
      const result = observationsForRun({ runId: RUN, targetIds: [] }, await loadAuditIndex(roots));
      expect(result.written.map((o) => o.auditId)).toEqual(["AUD-2026-1106-analytics-0001", "AUD-2026-1106-analytics-0002"]);
    });

    it("同じ audit_id が作業ツリーと main にあれば作業ツリーの値を使い、1 件だけ返す", async () => {
      audit(roots.worktree, "AUD-2026-1106-ops-0001", { outcome: "ok" });
      audit(roots.mainCheckout, "AUD-2026-1106-ops-0001", { outcome: "unreachable" });
      const result = observationsForRun({ runId: RUN, targetIds: ["AUD-2026-1106-ops-0001"] }, await loadAuditIndex(roots));
      expect(result.written.map((o) => [o.auditId, o.outcome])).toEqual([["AUD-2026-1106-ops-0001", "ok"]]);
      expect(result.referenced).toEqual([]);
    });

    it("main にだけある観測も読む", async () => {
      audit(roots.mainCheckout, "AUD-2026-1104-gsc-0001", { outcome: "permission_denied" });
      const result = observationsForRun({ runId: RUN, targetIds: [] }, await loadAuditIndex(roots));
      expect(result.written.map((o) => [o.auditId, o.outcome])).toEqual([["AUD-2026-1104-gsc-0001", "permission_denied"]]);
    });

    it("空入力: docs/audits が無ければ written も referenced も []", async () => {
      const result = observationsForRun({ runId: RUN, targetIds: [] }, await loadAuditIndex(roots));
      expect(result).toEqual({ runId: RUN, written: [], referenced: [] });
    });
  });

  describe("異常系", () => {
    it("入力: docs/audits/<source>/ の外にある観測の形のファイルは、correlation_id が一致しても索引に入れず、開かない", async () => {
      // targetIds からパスを組み立てないので、AUD-../x のような値でも docs/audits の外は読めない（2026-11-09 の残りの指摘）
      const outside = [
        "docs/AUD-2026-1106-ops-0001.md",
        "AUD-2026-1106-ops-0001.md",
        "docs/audits/AUD-2026-1106-ops-0001.md",
        "docs/audits/ops/deep/AUD-2026-1106-ops-0002.md",
      ];
      for (const file of outside) putFile(roots.worktree, file, `---\nfetch:\n  outcome: ok\n  correlation_id: ${RUN}\n---\n`);
      vi.mocked(fsPromises.readFile).mockClear();
      const index = await loadAuditIndex(roots);
      const result = observationsForRun(
        { runId: RUN, targetIds: ["E-05", "LH-seo", OTHER_RUN, "AUD-../x", "../AUD-2026-1106-ops-0001", "AUD-2026-1106-ops-0002"] },
        index,
      );
      expect(result.written).toEqual([]);
      expect(result.referenced).toEqual([
        { auditId: "AUD-2026-1106-ops-0002", source: null, createdBy: null, outcome: null, note: null, measuredAt: null, found: false },
      ]);
      const opened = vi.mocked(fsPromises.readFile).mock.calls.map((call) => String(call[0]));
      expect(opened).toEqual([]);
    });

    it("入力: frontmatter が壊れた観測は found: true・outcome: null で返す", async () => {
      putFile(roots.worktree, "docs/audits/ops/AUD-2026-1106-ops-0002.md", "---\naudit_id: [壊れ\n---\n");
      const result = observationsForRun({ runId: RUN, targetIds: ["AUD-2026-1106-ops-0002"] }, await loadAuditIndex(roots));
      expect(result.referenced).toEqual([
        { auditId: "AUD-2026-1106-ops-0002", source: "ops", createdBy: null, outcome: null, note: null, measuredAt: null, found: true },
      ]);
    });

    it("入力: frontmatter 全体が YAML として壊れていても、correlation_id の行が読めれば written に入れ、outcome: null にする", async () => {
      // note の中のアポストロフィで全体が壊れる、という程度の誤りでも、中身の失敗を「-」に隠さない（2026-11-06 の最終レビュー）
      putFile(
        roots.worktree,
        "docs/audits/ops/AUD-2026-1106-ops-0004.md",
        `---\naudit_id: AUD-2026-1106-ops-0004\nsource: ops\nfetch:\n  outcome: permission_denied\n  correlation_id: ${RUN}\n  note: 'it's broken'\n---\n`,
      );
      const result = observationsForRun({ runId: RUN, targetIds: [] }, await loadAuditIndex(roots));
      expect(result.written).toEqual([
        { auditId: "AUD-2026-1106-ops-0004", source: "ops", createdBy: null, outcome: null, note: null, measuredAt: null, found: true },
      ]);
    });

    it("入力: note のメールアドレスと電話番号は伏せ字にし、それ以外は折り返しも長さもそのまま残す", async () => {
      audit(roots.worktree, "AUD-2026-1106-ops-0005", { note: "担当 taro@example.com に 03-1234-5678 で連絡" });
      const result = observationsForRun({ runId: RUN, targetIds: [] }, await loadAuditIndex(roots));
      expect(result.written[0]?.note).toBe("担当 [redacted:email] に [redacted:phone] で連絡");
    });

    it("サーバ: 1 つのファイルを読めない（EACCES など）ときは、そのファイルだけ found: true・outcome: null にして、ほかは読み続ける", async () => {
      audit(roots.worktree, "AUD-2026-1106-ops-0006");
      audit(roots.worktree, "AUD-2026-1106-ops-0007", { outcome: "permission_denied" });
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(fsPromises.readFile).mockImplementation((async (file: unknown, ...rest: unknown[]) => {
        if (String(file).endsWith("AUD-2026-1106-ops-0006.md")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
      }) as never);
      try {
        const index = await loadAuditIndex(roots);
        const result = observationsForRun({ runId: RUN, targetIds: ["AUD-2026-1106-ops-0006"] }, index);
        expect(result.written.map((o) => [o.auditId, o.outcome])).toEqual([["AUD-2026-1106-ops-0007", "permission_denied"]]);
        expect(result.referenced).toEqual([
          { auditId: "AUD-2026-1106-ops-0006", source: "ops", createdBy: null, outcome: null, note: null, measuredAt: null, found: true },
        ]);
      } finally {
        vi.mocked(fsPromises.readFile).mockImplementation(actual.readFile as never);
      }
    });

    it("入力: fetch が無い観測は found: true・outcome: null で返す", async () => {
      putFile(roots.worktree, "docs/audits/ops/AUD-2026-1106-ops-0003.md", "---\naudit_id: AUD-2026-1106-ops-0003\nsource: ops\n---\n");
      const result = observationsForRun({ runId: RUN, targetIds: ["AUD-2026-1106-ops-0003"] }, await loadAuditIndex(roots));
      expect(result.referenced[0]).toMatchObject({ found: true, outcome: null, source: "ops" });
    });

    it("入力: targetIds の観測がどこにも無ければ found: false", async () => {
      const result = observationsForRun({ runId: RUN, targetIds: ["AUD-2026-1106-ops-0009"] }, await loadAuditIndex(roots));
      expect(result.referenced).toEqual([
        { auditId: "AUD-2026-1106-ops-0009", source: null, createdBy: null, outcome: null, note: null, measuredAt: null, found: false },
      ]);
    });

    it("入力: README.md と _template.md と ID の形でないファイル名は索引に入れない", async () => {
      putFile(roots.worktree, "docs/audits/README.md", `---\nfetch:\n  correlation_id: ${RUN}\n---\n`);
      putFile(roots.worktree, "docs/audits/_template.md", `---\nfetch:\n  correlation_id: ${RUN}\n---\n`);
      putFile(roots.worktree, "docs/audits/ops/memo.md", `---\nfetch:\n  correlation_id: ${RUN}\n---\n`);
      const result = observationsForRun({ runId: RUN, targetIds: [] }, await loadAuditIndex(roots));
      expect(result.written).toEqual([]);
    });
  });
});

describe("auditDatesForRuns と日付での絞り込み", () => {
  describe("正常系", () => {
    it("実行の開始日（JST）とその翌日、targetIds の観測の日付を返す", () => {
      const dates = auditDatesForRuns([
        { startedAt: "2026-11-05T23:59:00.000+09:00", targetIds: ["AUD-2026-1101-gsc-0001", "E-05"] },
        { startedAt: "2026-11-05T15:30:00.000Z", targetIds: [] }, // JST では 11-06 の 00:30
      ]);
      expect([...dates].sort()).toEqual(["2026-1101", "2026-1105", "2026-1106", "2026-1107"]);
    });

    it("空入力: 実行が無ければ空", () => {
      expect(auditDatesForRuns([]).size).toBe(0);
    });

    it("dates を渡すと、その日付の観測だけを読み、ほかのファイルは開かない", async () => {
      audit(roots.worktree, "AUD-2026-1106-ops-0001");
      audit(roots.worktree, "AUD-2026-1104-gsc-0001");
      vi.mocked(fsPromises.readFile).mockClear();
      const index = await loadAuditIndex(roots, { dates: new Set(["2026-1106"]) });
      expect([...index.byId.keys()]).toEqual(["AUD-2026-1106-ops-0001"]);
      const opened = vi.mocked(fsPromises.readFile).mock.calls.map((call) => String(call[0]));
      expect(opened.some((file) => file.includes("AUD-2026-1104-gsc-0001"))).toBe(false);
    });
  });

  describe("異常系", () => {
    it("空入力: dates が空の集合なら何も読まない", async () => {
      audit(roots.worktree, "AUD-2026-1106-ops-0001");
      const index = await loadAuditIndex(roots, { dates: new Set() });
      expect(index.byId.size).toBe(0);
    });
  });
});
