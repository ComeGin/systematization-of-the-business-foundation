import { describe, expect, it } from "vitest";
import { BUILTIN_HANDLERS, missingConfigFor } from "../../src/builtin/index.js";
import type { BuiltinJob } from "../../src/contract.js";
import { makeConfig } from "../helpers/runner.js";

const github = { token: "t", repository: "o/r", baseBranch: "main", issueNumber: 1, reviewer: "u" };
const aws = { region: "ap-northeast-1", profile: null, runlogBucket: "b", heartbeatNamespace: "n" };
const miswrite = { baseUrl: "https://c", accountId: 1, apiToken: "t", agentUserId: 2 };

describe("missingConfigFor", () => {
  it("i13-file は GitHub のグループが無ければ、その変数名を返す", () => {
    expect(missingConfigFor("i13-file", makeConfig())).toEqual([
      "GITHUB_TOKEN",
      "GITHUB_REPOSITORY",
      "I13_ISSUE_NUMBER",
      "I13_REVIEWER",
    ]);
    expect(missingConfigFor("i13-file", makeConfig({ github }))).toEqual([]);
  });

  it("miswrite-check は突き合わせのグループが無ければ、その変数名を返す", () => {
    expect(missingConfigFor("miswrite-check", makeConfig())).toHaveLength(4);
    expect(missingConfigFor("miswrite-check", makeConfig({ miswrite }))).toEqual([]);
  });

  it.each(["heartbeat", "runlog-flush"] as const)("%s は AWS のグループが要る", (builtin) => {
    expect(missingConfigFor(builtin, makeConfig())).toEqual(["AWS_REGION", "RUNLOG_BUCKET"]);
    expect(missingConfigFor(builtin, makeConfig({ aws }))).toEqual([]);
  });

  it.each(["silence-check", "lighthouse", "published-article-check"] as const)("%s は追加の設定が要らない", (builtin) => {
    expect(missingConfigFor(builtin, makeConfig())).toEqual([]);
  });

  it("値（トークンなど）は返さない", () => {
    const all = (Object.keys(BUILTIN_HANDLERS) as BuiltinJob[]).flatMap((builtin) => missingConfigFor(builtin, makeConfig()));
    for (const name of all) expect(name).toMatch(/^[A-Z0-9_]+$/);
  });
});

describe("BUILTIN_HANDLERS", () => {
  it("定義で指定できる builtin のすべてにハンドラがある", () => {
    const builtins: BuiltinJob[] = [
      "heartbeat",
      "i13-file",
      "miswrite-check",
      "silence-check",
      "lighthouse",
      "published-article-check",
      "runlog-flush",
    ];
    for (const builtin of builtins) expect(typeof BUILTIN_HANDLERS[builtin]).toBe("function");
  });
});
