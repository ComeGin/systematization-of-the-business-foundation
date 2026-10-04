import type { ControlPlaneConfig } from "../config.js";
import type { BuiltinHandler } from "../context.js";
import type { BuiltinJob } from "../contract.js";
import { i13File } from "./i13-file.js";
import { miswriteCheck } from "./miswrite-check.js";
import { silenceCheck } from "./silence-check.js";
import { lighthouse } from "./lighthouse.js";
import { heartbeat, publishedArticleCheck, runlogFlush } from "./simple.js";

export const BUILTIN_HANDLERS: Readonly<Record<BuiltinJob, BuiltinHandler>> = {
  heartbeat,
  "i13-file": i13File,
  "miswrite-check": miswriteCheck,
  "silence-check": silenceCheck,
  lighthouse,
  "published-article-check": publishedArticleCheck,
  "runlog-flush": runlogFlush,
};

const AWS_VARS = ["AWS_REGION", "RUNLOG_BUCKET"];

/** その builtin に必要で、設定されていない環境変数名（無ければ空）。 */
export function missingConfigFor(builtin: BuiltinJob, config: ControlPlaneConfig): string[] {
  switch (builtin) {
    case "i13-file":
      return config.github ? [] : ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "I13_ISSUE_NUMBER", "I13_REVIEWER"];
    case "miswrite-check":
      return config.miswrite
        ? []
        : [
            "MISWRITE_CHATWOOT_BASE_URL",
            "MISWRITE_CHATWOOT_ACCOUNT_ID",
            "MISWRITE_CHATWOOT_API_TOKEN",
            "MISWRITE_AGENT_USER_ID",
          ];
    case "heartbeat":
    case "runlog-flush":
      return config.aws ? [] : AWS_VARS;
    default:
      return [];
  }
}
