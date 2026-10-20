// リポジトリルートからの相対パスの断片。読み先・書き先のパスは必ずここから組み立てる。
// （2026-10-11 に MarketingDepartment/WebsiteOperations の下からリポジトリ直下へ移した）

export const PROPOSALS_DIR = "docs/proposals";
export const AUDITS_DIR = "docs/audits";
export const OPS_DIR = "ops";
export const CLOUD_DIR = "cloud";
export const SCHEDULES_DIR = `${OPS_DIR}/schedules`;
export const MCP_REGISTRY_FILE = `${OPS_DIR}/mcp-registry.yaml`;
export const VERDANT_VIRGO_DIR = "frontend/verdant-virgo";
export const N8N_WORKFLOWS_DIR = "middleware/n8n/workflows";

export const AGENT_DEFINITIONS_DIR = ".claude/agents";

/** Playwright のブラウザの既定の置き場（実ホームからの相対）。builtin a11y が PLAYWRIGHT_BROWSERS_PATH で明示して渡す */
export const PLAYWRIGHT_BROWSERS_SUBDIR = ".cache/ms-playwright";
