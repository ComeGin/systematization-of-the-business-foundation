// E-13 ImprovementProposal の frontmatter（docs/proposals/README.md の形）を zod で検証する。
import { parse as parseYaml } from "yaml";
import * as z from "zod/v4";
import { ULID_PATTERN } from "../ulid.js";

const nullableString = z.string().nullable();

export const ProposalSchema = z.object({
  proposal_id: z.string().regex(/^PRP-\d{4}-\d{4}$/, "PRP-<西暦>-<連番 4 桁> にしてください"),
  created_at: z.string().min(1),
  created_by: z.string().min(1),
  agent_run_id: z.string().regex(ULID_PATTERN, "ULID にしてください"),
  evidence: z
    .array(
      z.object({
        audit_id: z.string().min(1),
        source: z.string().min(1),
        ref: z.string().min(1),
        summary: z.string(),
      }),
    )
    .min(1, "evidence は 1 件以上必要です"),
  target: z.object({
    entity: z.string().min(1),
    identifier: z.string().min(1),
    also_affects: z.array(z.string()).default([]),
  }),
  change: z.object({
    kind: z.enum(["content_rewrite", "cta_swap", "internal_link", "technical_seo", "experiment_start", "config_change"]),
    description: z.string().min(1),
    diff_ref: nullableString,
  }),
  expectation: z.object({
    metric: z.string().min(1),
    baseline: z.union([z.number(), z.string()]).nullable(),
    target: z.union([z.number(), z.string()]).nullable(),
    judge_after: z.string().min(1),
    judge_by: z.string().min(1),
  }),
  risk: z.object({
    level: z.enum(["low", "medium", "high"]),
    description: z.string(),
    blast_radius: z.string(),
  }),
  approval: z.object({
    state: z.enum(["draft", "review", "approved", "rejected", "applied", "rolled_back"]),
    approver: nullableString,
    decided_at: nullableString,
    record_ref: nullableString,
  }),
  applied_at: nullableString,
  verification: z.object({
    state: z.enum(["pending", "improved", "no_change", "degraded"]),
    verified_at: nullableString,
    result: nullableString,
    audit_ref: nullableString,
  }),
  rollback: z.object({
    procedure: z.string().min(1),
    reversible: z.boolean(),
    deadline: z.string().min(1),
  }),
});

export type Proposal = z.infer<typeof ProposalSchema>;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

export type ParsedProposal = { ok: true; value: Proposal } | { ok: false; reason: string };

export function parseProposal(text: string): ParsedProposal {
  const match = FRONTMATTER.exec(text);
  if (!match?.[1]) return { ok: false, reason: "frontmatter が無い" };
  let raw: unknown;
  try {
    raw = parseYaml(match[1]);
  } catch {
    return { ok: false, reason: "frontmatter が YAML として読めない" };
  }
  const parsed = ProposalSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    };
  }
  return { ok: true, value: parsed.data };
}

/** frontmatter の change.diff_ref の行だけを書き換える（他の行・本文には触れない）。 */
export function setDiffRef(text: string, diffRef: string): string | null {
  const match = FRONTMATTER.exec(text);
  if (!match?.[1]) return null;
  const front = match[1];
  const replaced = front.replace(/^([ \t]+diff_ref:).*$/m, (_line, key: string) => `${key} ${JSON.stringify(diffRef)}`);
  if (replaced === front) return null;
  return text.replace(front, () => replaced);
}
