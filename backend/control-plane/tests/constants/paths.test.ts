// 実在のディレクトリの確認だけ読み取り専用でファイルシステムを見る（書き込みはしない）
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_DEFINITIONS_DIR,
  AUDITS_DIR,
  MCP_REGISTRY_FILE,
  N8N_WORKFLOWS_DIR,
  PROPOSALS_DIR,
  SCHEDULES_DIR,
  VERDANT_VIRGO_DIR,
  WEBSITE_OPERATIONS_DIR,
} from "../../src/constants/paths.js";
import { repositoryRoot } from "../helpers/store.js";

// 定数表の検査（異常の起こりようが無いため正常系だけ）
describe("パスの定数", () => {
  describe("正常系", () => {
    it("W の下のパスは WEBSITE_OPERATIONS_DIR から組み立てる", () => {
      expect(WEBSITE_OPERATIONS_DIR).toBe("MarketingDepartment/WebsiteOperations");
      expect(PROPOSALS_DIR).toBe("MarketingDepartment/WebsiteOperations/docs/proposals");
      expect(AUDITS_DIR).toBe("MarketingDepartment/WebsiteOperations/docs/audits");
      expect(SCHEDULES_DIR).toBe("MarketingDepartment/WebsiteOperations/ops/schedules");
      expect(MCP_REGISTRY_FILE).toBe("MarketingDepartment/WebsiteOperations/ops/mcp-registry.yaml");
      expect(VERDANT_VIRGO_DIR).toBe("MarketingDepartment/WebsiteOperations/frontend/verdant-virgo");
    });

    it("n8n のワークフローの書き出し先は W/middleware/n8n/workflows", () => {
      expect(N8N_WORKFLOWS_DIR).toBe("MarketingDepartment/WebsiteOperations/middleware/n8n/workflows");
    });

    it("エージェント定義は W ではなくリポジトリ直下の .claude/agents", () => {
      expect(AGENT_DEFINITIONS_DIR).toBe(".claude/agents");
    });

    it("どれも相対パス（先頭の / や末尾の / が無い）", () => {
      for (const path of [PROPOSALS_DIR, AUDITS_DIR, SCHEDULES_DIR, MCP_REGISTRY_FILE, VERDANT_VIRGO_DIR, N8N_WORKFLOWS_DIR, AGENT_DEFINITIONS_DIR]) {
        expect(path.startsWith("/") || path.endsWith("/")).toBe(false);
      }
    });
  });
});

describe("実在のディレクトリ（リポジトリ）", () => {
  const root = repositoryRoot();

  describe("正常系", () => {
    it.skipIf(!root)("N8N_WORKFLOWS_DIR・SCHEDULES_DIR・AGENT_DEFINITIONS_DIR はディレクトリとして実在する", () => {
      for (const dir of [N8N_WORKFLOWS_DIR, SCHEDULES_DIR, AGENT_DEFINITIONS_DIR]) {
        const full = join(root!, dir);
        expect({ dir, exists: existsSync(full) && statSync(full).isDirectory() }).toEqual({ dir, exists: true });
      }
    });
  });
});
