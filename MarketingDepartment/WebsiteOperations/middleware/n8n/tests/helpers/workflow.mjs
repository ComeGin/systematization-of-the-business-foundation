// ワークフローの JSON を読み、Code ノード（jsCode）を n8n の実行環境に似せた最小のランタイムで動かす。
// 用意するのは Code ノードが実際に使っているもの（$('ノード名').first()/.all()/.item、$input、$json）だけ。
// n8n の Code ノード（Run Once for All Items）は、コードを関数の本体として包んで実行し、
// 戻り値は { json: ... } の配列でなければならない。ここでも同じ形を検査する。
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKFLOWS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../workflows");

export function workflowFiles() {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

export function loadWorkflow(file) {
  return JSON.parse(readFileSync(join(WORKFLOWS_DIR, file), "utf8"));
}

export function getNode(workflow, name) {
  const node = workflow.nodes.find((n) => n.name === name);
  if (!node) throw new Error(`ノード「${name}」が ${workflow.name} に無い`);
  return node;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function itemsAccessor(items) {
  return {
    first: () => items[0],
    last: () => items[items.length - 1],
    all: () => items,
    get item() {
      return items[0];
    },
  };
}

/**
 * Code ノードを動かす。
 * @param {object} node Code ノード（parameters.jsCode を持つ）
 * @param {{ nodes?: Record<string, object[]>, input?: object[] }} data
 *   nodes: 参照される上流のノードの出力（ノード名 → { json } の配列）。input: 直前のノードからの入力
 * @returns {Promise<object[]>} Code ノードの出力（{ json } の配列）
 */
export async function runCodeNode(node, { nodes = {}, input = [] } = {}) {
  if (node.type !== "n8n-nodes-base.code") throw new Error(`${node.name} は Code ノードではない`);
  if (node.parameters.mode && node.parameters.mode !== "runOnceForAllItems") throw new Error(`${node.name} は Run Once for All Items ではない（このランタイムは未対応）`);
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`Referenced node doesn't exist: ${name}`);
    return itemsAccessor(nodes[name]);
  };
  const $input = itemsAccessor(input);
  const fn = new AsyncFunction("$", "$input", "$json", node.parameters.jsCode);
  const out = await fn($, $input, input[0]?.json);
  if (!Array.isArray(out)) throw new Error(`${node.name} の戻り値が配列ではない`);
  for (const item of out) {
    if (!item || typeof item.json !== "object" || item.json === null || Array.isArray(item.json)) throw new Error(`${node.name} の戻り値に { json: object } でない要素がある`);
  }
  return out;
}

/** Code ノードの中で $('ノード名') として参照しているノード名の一覧 */
export function referencedNodeNames(text) {
  return [...String(text).matchAll(/\$\(\s*'([^']+)'\s*\)|\$\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1] ?? m[2]);
}

/** Webhook ノードの出力の形（n8n の Webhook ノード v2 は headers・params・query・body を json に入れる） */
export function webhookItem(body, headers = {}) {
  return [{ json: { headers, params: {}, query: {}, body } }];
}
