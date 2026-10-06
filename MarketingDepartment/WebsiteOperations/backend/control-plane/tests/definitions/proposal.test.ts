import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROPOSALS_DIR } from "../../src/constants/paths.js";
import { parseProposal, setDiffRef } from "../../src/definitions/proposal.js";
import { repositoryRoot } from "../helpers/store.js";

const FRONT = `proposal_id: PRP-2026-0001
created_at: 2026-10-04T07:00:00+09:00
created_by: agent/proposal-writer
agent_run_id: 01JBQZ8F3K7XN2M5V9TWRC4HED
evidence:
  - audit_id: AUD-2026-1004-lighthouse-0001
    source: lighthouse
    ref: docs/audits/lighthouse/AUD-2026-1004-lighthouse-0001.md
    summary: "要旨"
target:
  entity: E-05
  identifier: "url_path=/"
change:
  kind: technical_seo
  description: "何をどう変えるか"
  diff_ref: null
expectation:
  metric: LH-performance
  baseline: 0.99
  target: 1.0
  judge_after: 2026-11-03
  judge_by: R3
risk:
  level: low
  description: "悪影響"
  blast_radius: "範囲"
approval:
  state: draft
  approver: null
  decided_at: null
  record_ref: null
applied_at: null
verification:
  state: pending
  verified_at: null
  result: null
  audit_ref: null
rollback:
  procedure: "git revert"
  reversible: true
  deadline: 2026-12-03`;

const doc = (front: string, body = "\n# 説明\n\n本文に diff_ref: という語があっても触らない\n") => `---\n${front}\n---\n${body}`;

describe("parseProposal", () => {
  it("正しい frontmatter を読み、日付は文字列のまま・also_affects の既定は空配列", () => {
    const parsed = parseProposal(doc(FRONT));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.created_at).toBe("2026-10-04T07:00:00+09:00");
    expect(parsed.value.expectation.judge_after).toBe("2026-11-03");
    expect(parsed.value.target.also_affects).toEqual([]);
    expect(parsed.value.change.diff_ref).toBeNull();
  });

  it("frontmatter が無ければ理由付きで ok=false", () => {
    expect(parseProposal("# 本文だけ")).toEqual({ ok: false, reason: "frontmatter が無い" });
  });

  it("YAML として読めなければ ok=false（例外にしない）", () => {
    expect(parseProposal(doc("proposal_id: [unclosed"))).toEqual({ ok: false, reason: "frontmatter が YAML として読めない" });
  });

  it.each([
    ["proposal_id の形", FRONT.replace("PRP-2026-0001", "PRP-26-1"), /^proposal_id: PRP-<西暦>-<連番 4 桁>/],
    ["agent_run_id が ULID でない（小文字）", FRONT.replace("01JBQZ8F3K7XN2M5V9TWRC4HED", "01jbqz8f3k7xn2m5v9twrc4hed"), /agent_run_id: ULID にしてください/],
    ["agent_run_id に Crockford で使わない文字（I・L・O・U）", FRONT.replace("01JBQZ8F3K7XN2M5V9TWRC4HED", "01JBQZ8F3K7XN2M5V9TWRC4HEI"), /agent_run_id/],
    ["evidence が空", FRONT.replace(/evidence:\n(?: {2,}.*\n)+/, "evidence: []\n"), /evidence: evidence は 1 件以上必要です/],
    ["change.kind が列挙外", FRONT.replace("kind: technical_seo", "kind: delete_everything"), /change\.kind/],
    ["approval.state が列挙外", FRONT.replace("state: draft", "state: merged"), /approval\.state/],
    ["rollback.reversible が真偽値でない", FRONT.replace("reversible: true", "reversible: maybe"), /rollback\.reversible/],
  ])("%s は ok=false で、項目のパスを理由に含める", (_label, front, reason) => {
    const parsed = parseProposal(doc(front));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toMatch(reason);
  });

  it("複数の不備は ; で区切ってまとめて返す", () => {
    const parsed = parseProposal(doc(FRONT.replace("PRP-2026-0001", "x").replace("level: low", "level: extreme")));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason.split("; ").map((issue) => issue.split(":")[0])).toEqual(["proposal_id", "risk.level"]);
  });
});

describe("setDiffRef", () => {
  it("frontmatter の change.diff_ref の行だけを書き換え、本文と他の行には触れない", () => {
    const text = doc(FRONT);
    const updated = setDiffRef(text, "https://github.com/o/r/pull/12");
    expect(updated).not.toBeNull();
    expect(updated).toContain('  diff_ref: "https://github.com/o/r/pull/12"');
    expect(updated).toContain("本文に diff_ref: という語があっても触らない");
    expect(updated!.replace('  diff_ref: "https://github.com/o/r/pull/12"', "  diff_ref: null")).toBe(text);
    const parsed = parseProposal(updated!);
    expect(parsed.ok && parsed.value.change.diff_ref).toBe("https://github.com/o/r/pull/12");
  });

  it("値は JSON の文字列として書き、$ や引用符を含んでもそのまま入る", () => {
    const value = 'PR "#12" $& $1';
    const updated = setDiffRef(doc(FRONT), value)!;
    const parsed = parseProposal(updated);
    expect(parsed.ok && parsed.value.change.diff_ref).toBe(value);
  });

  it("frontmatter が無い、または diff_ref の行が無ければ null（書き換えない）", () => {
    expect(setDiffRef("# 本文だけ", "x")).toBeNull();
    expect(setDiffRef(doc(FRONT.replace("  diff_ref: null\n", "")), "x")).toBeNull();
  });

  it("インデントの無い diff_ref（change の外）は書き換えない", () => {
    expect(setDiffRef(doc("proposal_id: PRP-2026-0001\ndiff_ref: null"), "x")).toBeNull();
  });
});

describe("実在のテンプレート（W/docs/proposals/_template.md）", () => {
  const root = repositoryRoot();

  it.skipIf(!root)("検証を通る", () => {
    const text = readFileSync(join(root!, PROPOSALS_DIR, "_template.md"), "utf8");
    expect(parseProposal(text)).toMatchObject({ ok: true });
  });
});
