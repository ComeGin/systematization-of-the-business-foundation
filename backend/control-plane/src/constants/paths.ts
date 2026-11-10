// リポジトリルートからの相対パスの断片。読み先・書き先のパスは必ずここから組み立てる。
// （2026-10-11 に MarketingDepartment/WebsiteOperations の下からリポジトリ直下へ移した）

export const PROPOSALS_DIR = "docs/proposals";
export const AUDITS_DIR = "docs/audits";
export const OPS_DIR = "ops";
export const CLOUD_DIR = "cloud";
export const SCHEDULES_DIR = `${OPS_DIR}/schedules`;
/** アイキャッチ画像のプロンプトの雛形（承認済み main の写しから読む。作業ツリーのものは使わない） */
export const COVER_PROMPT_FILE = `${OPS_DIR}/prompts/article-cover.md`;
/** キャンペーンの配布物の原稿の置き場（作業ツリー。`campaign-assets/<proposal_id>/`）。builtin campaign-asset-upload が読む */
export const CAMPAIGN_ASSETS_DIR = "campaign-assets";
/** Agent Plugins 1.0.0 の plugin.json のスキーマの写し（承認済み main の写しから読む。作業ツリーのものは使わない。ADR-18） */
export const AGENT_PLUGINS_SCHEMA_FILE = `${OPS_DIR}/schemas/agent-plugins-1.0.0/plugin.schema.json`;
/** 承認の確認項目（項目の種類ごと。承認済み main の写しから読む。作業ツリーのものは使わない。spec 5.4） */
export const APPROVAL_CHECKLISTS_FILE = `${OPS_DIR}/approval-checklists.yaml`;
/** 周ごとの差し戻しの要約の書き出し先（作業ツリー。docs/cycles/<周 ID>.md。次の周の proposal-writer と作用のジョブが読む） */
export const CYCLES_DOC_DIR = "docs/cycles";
export const MCP_REGISTRY_FILE = `${OPS_DIR}/mcp-registry.yaml`;
export const VERDANT_VIRGO_DIR = "frontend/verdant-virgo";
export const N8N_WORKFLOWS_DIR = "middleware/n8n/workflows";

export const AGENT_DEFINITIONS_DIR = ".claude/agents";

/** Playwright のブラウザの既定の置き場（実ホームからの相対）。builtin a11y が PLAYWRIGHT_BROWSERS_PATH で明示して渡す */
export const PLAYWRIGHT_BROWSERS_SUBDIR = ".cache/ms-playwright";
