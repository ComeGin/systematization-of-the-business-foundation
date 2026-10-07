// n8n のワークフロー JSON の正規化（builtin n8n-export。固定シート 7 節）。純粋関数だけで、入出力もネットワークも持たない。
// 目的は「実行のたびに変わるフィールドを除き、キー順を固定して、同じワークフローなら毎回同じバイト列にする」こと
// （差分が毎日出ると、差分があること自体が情報でなくなる。TA-03 の 6 節）。
// 応答の形の出典: https://docs.n8n.io/connect/n8n-api/workflow （OpenAPI の Workflow）。
//   ノードにも createdAt / updatedAt があり、settings の binaryMode・credentialResolverId は「派生した内部の設定」と書かれている。

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * トップレベルから除くキー。シートの初期値に、一覧・単体の応答にある揮発・派生のものを足した。
 * pinData も除く対象だが、既存のファイルの形に合わせて、空のオブジェクトとして書き直す（normalizeWorkflow）。
 */
const DROP_TOP = new Set([
  "id",
  "versionId",
  "activeVersionId",
  "activeVersion",
  "updatedAt",
  "createdAt",
  "staticData",
  "shared",
  "triggerCount",
  "isArchived",
  "versionCounter",
  "sourceWorkflowId",
  "parentFolder",
]);
const DROP_NODE = new Set(["createdAt", "updatedAt"]);
const DROP_SETTINGS = new Set(["binaryMode", "credentialResolverId"]);

/** n8n の画面の書き出しの順（既存の workflows/*.json に合わせる）。ここに無いキーは末尾にアルファベット順 */
const TOP_ORDER = ["name", "nodes", "connections", "active", "settings", "pinData", "meta", "description", "tags", "nodeGroups"];
const NODE_ORDER = ["parameters", "id", "name", "type", "typeVersion", "position", "notes", "webhookId", "credentials", "onError"];

function orderedKeys(object: JsonObject, order: readonly string[]): string[] {
  const known = order.filter((key) => key in object);
  const rest = Object.keys(object)
    .filter((key) => !order.includes(key))
    .sort();
  return [...known, ...rest];
}

/** オブジェクトのキーを再帰的にアルファベット順にする。配列の順序は変えない（nodes・connections の中の配列を含む）。 */
function sortDeep(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!isObject(value)) return value;
  const sorted: JsonObject = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortDeep(value[key]!);
  return sorted;
}

function normalizeNode(raw: unknown): Json {
  if (!isObject(raw)) return sortDeep(raw as Json);
  const node: JsonObject = {};
  for (const key of orderedKeys(raw, NODE_ORDER)) {
    if (DROP_NODE.has(key)) continue;
    node[key] = sortDeep(raw[key]!);
  }
  return node;
}

export interface NormalizedWorkflow {
  name: string;
  active: boolean;
  /** 整形済みの JSON 文字列（インデント 2、末尾改行） */
  text: string;
  /** ノードの中に、秘密値の疑いのある値があった */
  suspectedSecret: boolean;
}

export function normalizeWorkflow(raw: unknown): NormalizedWorkflow {
  if (!isObject(raw) || typeof raw.name !== "string") throw new Error("ワークフローの形が想定と違う（name が無い）");

  const source: JsonObject = { ...raw };
  const out: JsonObject = {};

  // 公開の状態は本番の事実として残す（リード決定 2026-10-06）
  source.active = raw.active === true;
  // pinData は常に空にする（既存のファイルの形。一覧・単体とも excludePinnedData で取らない）
  source.pinData = {};

  // 変形が要るキーは先に作り替える
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((tag) => (isObject(tag) ? tag.name : null)).filter((name): name is string => typeof name === "string").sort()
    : [];
  if (tags.length > 0) source.tags = tags;
  else delete source.tags;

  if (isObject(raw.meta)) {
    const { instanceId: _instanceId, ...meta } = raw.meta;
    if (Object.keys(meta).length > 0) source.meta = meta;
    else delete source.meta;
  } else {
    delete source.meta;
  }

  if (isObject(raw.settings)) {
    source.settings = Object.fromEntries(Object.entries(raw.settings).filter(([key]) => !DROP_SETTINGS.has(key))) as JsonObject;
  }

  if (!(typeof raw.description === "string" && raw.description !== "")) delete source.description;
  if (!(Array.isArray(raw.nodeGroups) && raw.nodeGroups.length > 0)) delete source.nodeGroups;

  for (const key of orderedKeys(source, TOP_ORDER)) {
    if (DROP_TOP.has(key)) continue;
    const value = source[key]!;
    if (key === "nodes") out[key] = Array.isArray(value) ? value.map(normalizeNode) : sortDeep(value);
    else out[key] = key === "name" || key === "active" ? value : sortDeep(value);
  }

  return {
    name: raw.name.normalize("NFC"),
    active: raw.active === true,
    text: `${JSON.stringify(out, null, 2)}\n`,
    suspectedSecret: hasSuspectedSecret(out),
  };
}

// ---- 秘密値の検査（GitHub に越境する前。キーの中身・値は結果に出さない） ----

const SECRET_KEY = /secret|token|password|api[_-]?key|authorization/i;
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[abpr]-[A-Za-z0-9-]{10,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** 値が固定の文字列か。式（{{ }} を含む）・空・URL は除く（accessTokenUrl などの設定値を拾わない） */
function isLiteralSecretValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.startsWith("=") ? value.slice(1) : value;
  if (text.trim() === "" || text.includes("{{")) return false;
  return !/^https?:\/\//i.test(text.trim());
}

function hasSuspectedSecret(value: Json): boolean {
  if (typeof value === "string") return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
  if (Array.isArray(value)) return value.some(hasSuspectedSecret);
  if (!isObject(value)) return false;
  // 資格情報の参照（{ type: { id, name } }）は名前の表示だけで、値ではない
  if (typeof value.name === "string" && SECRET_KEY.test(value.name) && isLiteralSecretValue(value.value)) return true; // ヘッダーなどの { name, value } の対
  return Object.entries(value).some(([key, child]) => {
    if (key === "credentials") return false;
    if (SECRET_KEY.test(key) && isLiteralSecretValue(child)) return true;
    return hasSuspectedSecret(child);
  });
}

// ---- ファイル名の対応 ----

export interface LocalWorkflowFile {
  fileName: string;
  /** ファイルの中の name（NFC） */
  name: string;
}

const MAX_SLUG_LENGTH = 60;

function kebab(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
}

/** ファイル名の拠り所が無いときの名前（拡張子なし）。`I-xx` で始まる名前はその番号をそのまま残す。 */
export function slugForName(name: string, id: string): string {
  const normalized = name.normalize("NFC");
  const issue = /^I-\d+/.exec(normalized);
  if (issue) {
    const rest = kebab(normalized.slice(issue[0].length));
    return rest ? `${issue[0]}-${rest}` : issue[0];
  }
  return kebab(normalized) || `workflow-${id.replace(/[^A-Za-z0-9]/g, "")}`;
}

/**
 * ワークフローごとのファイル名（.json 付き）。承認済み main のファイルの name と n8n の名前の完全一致を優先し、
 * 無いものは名前から作る。衝突したら id を付ける。順序に依存しないよう、名前と id の順で決める。
 */
export function assignFileNames(
  workflows: readonly { id: string; name: string }[],
  local: readonly LocalWorkflowFile[],
): Map<string, string> {
  const localByName = new Map<string, string>();
  for (const file of [...local].sort((a, b) => a.fileName.localeCompare(b.fileName))) {
    if (!localByName.has(file.name)) localByName.set(file.name, file.fileName);
  }

  const sorted = [...workflows].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const result = new Map<string, string>();
  const used = new Set<string>();

  // 一致するものを先に確定させる（他のワークフローの新しい名前がそのファイル名を横取りしないように）
  for (const workflow of sorted) {
    const fileName = localByName.get(workflow.name.normalize("NFC"));
    if (fileName && !used.has(fileName)) {
      result.set(workflow.id, fileName);
      used.add(fileName);
    }
  }
  const reserved = new Set(local.map((file) => file.fileName));
  for (const workflow of sorted) {
    if (result.has(workflow.id)) continue;
    const slug = slugForName(workflow.name, workflow.id);
    let fileName = `${slug}.json`;
    if (used.has(fileName) || reserved.has(fileName)) fileName = `${slug}-${workflow.id.replace(/[^A-Za-z0-9]/g, "")}.json`;
    result.set(workflow.id, fileName);
    used.add(fileName);
  }
  return result;
}
