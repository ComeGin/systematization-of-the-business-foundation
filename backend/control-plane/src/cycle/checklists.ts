// 承認の確認項目（ops/approval-checklists.yaml。spec 5.4）。項目の「OK」は、その種類の確認項目をすべて入れたときだけ押せる。
// 読み先は承認済み main のチェックアウト（作業ツリーからは読まない。ADR-18）。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import * as z from "zod/v4";
import { APPROVAL_CHECKLISTS_FILE } from "../constants/paths.js";
import type { CycleItemKind } from "../contract.js";

export interface ChecklistEntry {
  id: string;
  label: string;
}

export type Checklists = Record<CycleItemKind, ChecklistEntry[]>;

/** 確認項目の定義の誤り（ファイル名と理由だけ。値は含めない） */
export class ChecklistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChecklistError";
  }
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const EntrySchema = z.strictObject({
  id: z.string().regex(KEBAB, "id は kebab-case にしてください"),
  label: z.string().trim().min(1, "label が空です").max(300),
});

const ListSchema = z
  .array(EntrySchema)
  .default([])
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      if (seen.has(entry.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: `${entry.id} が重複している` });
      seen.add(entry.id);
    });
  });

/** 種類ごとの確認項目。proposal は PR で承認するので空でよい。deploy も空を許す（spec 5.4 の機械の歯止めは SEO の判定） */
const ChecklistsSchema = z.strictObject({
  article: ListSchema,
  campaign: ListSchema,
  code: ListSchema,
  deploy: ListSchema,
  proposal: ListSchema,
  manual: ListSchema,
});

const MUST_NOT_BE_EMPTY: readonly CycleItemKind[] = ["article", "campaign", "code", "manual"];

export async function loadChecklists(mainCheckout: string): Promise<Checklists> {
  let text: string;
  try {
    text = await readFile(join(mainCheckout, APPROVAL_CHECKLISTS_FILE), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ChecklistError(
      code === "ENOENT" ? `${APPROVAL_CHECKLISTS_FILE} が main のチェックアウトに無い` : `${APPROVAL_CHECKLISTS_FILE} を読めない（${code ?? "不明"}）`,
    );
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    throw new ChecklistError(`${APPROVAL_CHECKLISTS_FILE} が YAML として読めない`);
  }
  const parsed = ChecklistsSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join(" / ");
    throw new ChecklistError(`${APPROVAL_CHECKLISTS_FILE} の形が違う（${issues}）`);
  }
  const empty = MUST_NOT_BE_EMPTY.filter((kind) => parsed.data[kind].length === 0);
  if (empty.length > 0) throw new ChecklistError(`${APPROVAL_CHECKLISTS_FILE} の確認項目が空（${empty.join(", ")}）`);
  return parsed.data;
}
