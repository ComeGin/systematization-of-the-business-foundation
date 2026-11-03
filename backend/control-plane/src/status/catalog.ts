// 設定の状況の「手順の一覧（カタログ）」を、承認済み main のチェックアウトから読んで型にする。
// 正本は setup/status/steps.mjs（副作用のない ESM。形はそのファイルの冒頭のコメント）。
// 作業ツリーの書き換えは次の確認に効かない（ADR-18）ので、読み先は必ず CONTROL_MAIN_CHECKOUT。
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as z from "zod/v4";

export const CATALOG_FILE = "setup/status/steps.mjs";
/** この版のカタログだけを読む。steps.mjs の CATALOG_VERSION と同じ値 */
export const SUPPORTED_CATALOG_VERSION = 1;

/** カタログを読めない・形が不正（メッセージに値は入れない。場所と理由だけ） */
export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

const WHO = ["自動", "人・端末", "人・画面", "人・GitHub", "人・ブラウザ", "判断"] as const;
const KIND = ["検査", "警告", "申告", "未検査", "判断"] as const;
const DRIFT_IDS = ["site-redeploy", "n8n-workflows"] as const;

const nonEmpty = z.string().min(1);

const ProbeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("item"), key: nonEmpty }),
  z.object({ kind: z.literal("items"), keys: z.array(nonEmpty).min(1) }),
  z.object({ kind: z.literal("module"), module: nonEmpty, phase: nonEmpty }),
  z.object({ kind: z.literal("drift"), id: z.enum(DRIFT_IDS) }),
  z.object({ kind: z.literal("none") }),
]);

const DocRefSchema = z.object({ file: nonEmpty, heading: nonEmpty });

const ItemSchema = z.object({
  id: nonEmpty,
  title: nonEmpty,
  who: z.enum(WHO),
  kind: z.enum(KIND),
  overviewText: nonEmpty,
  probe: ProbeSchema,
  docs: z.array(DocRefSchema),
  stopId: nonEmpty.optional(),
});

const StepSchema = z.object({
  id: nonEmpty,
  title: nonEmpty,
  items: z.array(ItemSchema),
});

const CatalogSchema = z
  .object({
    version: z.literal(SUPPORTED_CATALOG_VERSION),
    productApiModules: z.array(nonEmpty),
    steps: z.array(StepSchema).min(1),
  })
  .superRefine((catalog, ctx) => {
    // id の重複は、画面の key と評価結果の対応を壊す
    const stepIds = new Set<string>();
    const itemIds = new Set<string>();
    catalog.steps.forEach((step, i) => {
      if (stepIds.has(step.id)) ctx.addIssue({ code: "custom", message: "段階の id が重複している", path: ["steps", i, "id"] });
      stepIds.add(step.id);
      step.items.forEach((item, j) => {
        if (itemIds.has(item.id)) ctx.addIssue({ code: "custom", message: "項目の id が重複している", path: ["steps", i, "items", j, "id"] });
        itemIds.add(item.id);
      });
    });
  });

export type CatalogProbe = z.infer<typeof ProbeSchema>;
export type CatalogDocRef = z.infer<typeof DocRefSchema>;
export type CatalogItem = z.infer<typeof ItemSchema>;
export type CatalogStep = z.infer<typeof StepSchema>;
export type Catalog = z.infer<typeof CatalogSchema>;

/** カタログの docs に現れるファイルの集合（手順書の読み出しの許可リスト）。 */
export function catalogDocFiles(catalog: Catalog): Set<string> {
  const files = new Set<string>();
  for (const step of catalog.steps) for (const item of step.items) for (const doc of item.docs) files.add(doc.file);
  return files;
}

/** zod の指摘を「場所: 理由」にする。入力の値は含めない（zod の文言も値を含まないものだけ使う）。 */
function describeIssues(error: z.ZodError): string {
  const lines = error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  const more = error.issues.length > 5 ? `（ほか ${error.issues.length - 5} 件）` : "";
  return lines.join("; ") + more;
}

/**
 * mainCheckout/setup/status/steps.mjs を import() して検証する。
 * 同じプロセスで main が進んだときに古い版を掴まないよう、読み込みのたびにファイルの更新時刻を `?mtime=` に付ける（`?t=` は Vite が時刻の印として取り除くため使わない）。
 */
export async function loadCatalog(mainCheckout: string): Promise<Catalog> {
  const file = join(mainCheckout, CATALOG_FILE);
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    throw new CatalogError(`カタログ（${CATALOG_FILE}）が承認済み main のチェックアウトに無い`);
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(`${pathToFileURL(file).href}?mtime=${mtimeMs}`)) as Record<string, unknown>;
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    throw new CatalogError(`カタログ（${CATALOG_FILE}）を読み込めない（${name}）`);
  }

  if (mod.CATALOG_VERSION !== SUPPORTED_CATALOG_VERSION) {
    throw new CatalogError(
      `カタログの版（CATALOG_VERSION）がこの監視アプリの対応する版（${SUPPORTED_CATALOG_VERSION}）と違う。監視アプリか main のどちらかが古い`,
    );
  }

  const parsed = CatalogSchema.safeParse({
    version: mod.CATALOG_VERSION,
    productApiModules: mod.PRODUCT_API_MODULES,
    steps: mod.STEPS,
  });
  if (!parsed.success) throw new CatalogError(`カタログ（${CATALOG_FILE}）の形が不正: ${describeIssues(parsed.error)}`);
  return parsed.data;
}
