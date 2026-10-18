import { describe, expect, it } from "vitest";
import { BUILTIN_HANDLERS, missingConfigFor } from "../../src/builtin/index.js";
import { n8nExport } from "../../src/builtin/n8n-export.js";
import type { BuiltinJob } from "../../src/contract.js";
import { makeConfig } from "../helpers/runner.js";

const github = { token: "t", repository: "o/r", baseBranch: "main", issueNumber: 1, reviewer: "u" };
const aws = { region: "ap-northeast-1", profile: null, runlogBucket: "b", heartbeatNamespace: "n" };
const miswrite = { baseUrl: "https://c", accountId: 1, apiToken: "t", agentUserId: 2 };
const n8n = { baseUrl: "https://n8n.example.test", apiKey: "n8n_key" };

const GITHUB_VARS = ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "I13_ISSUE_NUMBER", "I13_REVIEWER"];
const N8N_VARS = ["CONTROL_N8N_EXPORT_URL", "CONTROL_N8N_EXPORT_API_KEY"];

// 定義（ops/schedules）で指定できる builtin の全部。schedules.ts の BUILTIN_JOBS と同じ並び
const ALL_BUILTINS: BuiltinJob[] = [
  "heartbeat",
  "i13-file",
  "miswrite-check",
  "silence-check",
  "lighthouse",
  "a11y",
  "published-article-check",
  "runlog-flush",
  "n8n-export",
];

describe("missingConfigFor", () => {
  describe("正常系", () => {
    it("i13-file は GitHub のグループがあれば何も挙げない", () => {
      expect(missingConfigFor("i13-file", makeConfig({ github }))).toEqual([]);
    });

    it("miswrite-check は突き合わせのグループがあれば何も挙げない", () => {
      expect(missingConfigFor("miswrite-check", makeConfig({ miswrite }))).toEqual([]);
    });

    it.each(["heartbeat", "runlog-flush"] as const)("%s は AWS のグループがあれば何も挙げない", (builtin) => {
      expect(missingConfigFor(builtin, makeConfig({ aws }))).toEqual([]);
    });

    it("n8n-export は n8n と GitHub の両方があれば何も挙げない", () => {
      expect(missingConfigFor("n8n-export", makeConfig({ n8nExport: n8n, github }))).toEqual([]);
    });

    it.each(["silence-check", "lighthouse", "a11y", "published-article-check"] as const)("空入力: %s は連携の設定が 1 つも無くても何も挙げない", (builtin) => {
      expect(missingConfigFor(builtin, makeConfig())).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("空入力: i13-file は GitHub のグループが無ければ、その変数名を返す", () => {
      expect(missingConfigFor("i13-file", makeConfig())).toEqual(GITHUB_VARS);
    });

    it("空入力: miswrite-check は突き合わせのグループが無ければ、その変数名を返す", () => {
      expect(missingConfigFor("miswrite-check", makeConfig())).toEqual([
        "MISWRITE_CHATWOOT_BASE_URL",
        "MISWRITE_CHATWOOT_ACCOUNT_ID",
        "MISWRITE_CHATWOOT_API_TOKEN",
        "MISWRITE_AGENT_USER_ID",
      ]);
    });

    it.each(["heartbeat", "runlog-flush"] as const)("空入力: %s は AWS のグループが無ければ REGION と BUCKET を返す", (builtin) => {
      expect(missingConfigFor(builtin, makeConfig())).toEqual(["AWS_REGION", "RUNLOG_BUCKET"]);
    });

    it("空入力: n8n-export は n8n も GitHub も無ければ、n8n の 2 変数と GitHub の 4 変数を返す", () => {
      expect(missingConfigFor("n8n-export", makeConfig({ n8nExport: null }))).toEqual([...N8N_VARS, ...GITHUB_VARS]);
    });

    it("入力: n8n-export は n8n だけ無ければ、どちらが欠けていても n8n の 2 変数を両方挙げる", () => {
      expect(missingConfigFor("n8n-export", makeConfig({ n8nExport: null, github }))).toEqual(N8N_VARS);
    });

    it("入力: n8n-export は GitHub だけ無ければ、I-13 と同じ 4 変数を挙げる", () => {
      expect(missingConfigFor("n8n-export", makeConfig({ n8nExport: n8n }))).toEqual(GITHUB_VARS);
    });

    it("入力: 値（トークン・API キーなど）は返さず、変数名だけを返す", () => {
      const all = ALL_BUILTINS.flatMap((builtin) => missingConfigFor(builtin, makeConfig({ n8nExport: null })));
      expect(all.length).toBeGreaterThan(0);
      for (const name of all) expect(name).toMatch(/^[A-Z0-9_]+$/);
    });
  });
});

describe("BUILTIN_HANDLERS", () => {
  describe("正常系", () => {
    it("定義で指定できる builtin のすべてにハンドラがあり、それ以外のキーは無い", () => {
      for (const builtin of ALL_BUILTINS) expect(typeof BUILTIN_HANDLERS[builtin]).toBe("function");
      expect(Object.keys(BUILTIN_HANDLERS).sort()).toEqual([...ALL_BUILTINS].sort());
    });

    it("n8n-export には n8n-export.ts のハンドラを割り当てる", () => {
      expect(BUILTIN_HANDLERS["n8n-export"]).toBe(n8nExport);
    });
  });
});
