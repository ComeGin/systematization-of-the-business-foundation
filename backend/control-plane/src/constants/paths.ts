// リポジトリルートからの相対パスの断片。docs と ops は W の下にあるため、必ずここから組み立てる。
export const WEBSITE_OPERATIONS_DIR = "MarketingDepartment/WebsiteOperations";

export const PROPOSALS_DIR = `${WEBSITE_OPERATIONS_DIR}/docs/proposals`;
export const AUDITS_DIR = `${WEBSITE_OPERATIONS_DIR}/docs/audits`;
export const SCHEDULES_DIR = `${WEBSITE_OPERATIONS_DIR}/ops/schedules`;
export const MCP_REGISTRY_FILE = `${WEBSITE_OPERATIONS_DIR}/ops/mcp-registry.yaml`;
export const VERDANT_VIRGO_DIR = `${WEBSITE_OPERATIONS_DIR}/frontend/verdant-virgo`;
export const N8N_WORKFLOWS_DIR = `${WEBSITE_OPERATIONS_DIR}/middleware/n8n/workflows`;

// エージェント定義は W ではなくリポジトリ直下の .claude にある
export const AGENT_DEFINITIONS_DIR = ".claude/agents";
