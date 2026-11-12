import type { ControlPlaneConfig } from "../config.js";
import type { BuiltinHandler } from "../context.js";
import type { BuiltinJob } from "../contract.js";
import { i13File } from "./i13-file.js";
import { miswriteCheck } from "./miswrite-check.js";
import { silenceCheck } from "./silence-check.js";
import { lighthouse } from "./lighthouse.js";
import { a11y } from "./a11y.js";
import { n8nExport } from "./n8n-export.js";
import { articleCover } from "./article-cover.js";
import { backup } from "./backup.js";
import { campaignAssetUpload } from "./campaign-asset-upload.js";
import { cycleClose, cycleOpen } from "./cycle.js";
import { cycleCollect } from "./cycle-collect.js";
import { publishedArticleCheck } from "./published-article-check.js";
import { heartbeat, runlogFlush } from "./simple.js";

export const BUILTIN_HANDLERS: Readonly<Record<BuiltinJob, BuiltinHandler>> = {
  heartbeat,
  "i13-file": i13File,
  "miswrite-check": miswriteCheck,
  "silence-check": silenceCheck,
  lighthouse,
  a11y,
  "published-article-check": publishedArticleCheck,
  "runlog-flush": runlogFlush,
  "n8n-export": n8nExport,
  "article-cover": articleCover,
  "campaign-asset-upload": campaignAssetUpload,
  "cycle-open": cycleOpen,
  "cycle-collect": cycleCollect,
  "cycle-close": cycleClose,
  backup,
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
    case "n8n-export": {
      // n8n の 2 変数は両方揃ったときだけ有効（config.n8nExport が null なら、どちらが欠けていても両方を挙げる）。GitHub は I-13 と同じ 4 変数
      const missing: string[] = [];
      if (!config.n8nExport) missing.push("CONTROL_N8N_EXPORT_URL", "CONTROL_N8N_EXPORT_API_KEY");
      if (!config.github) missing.push("GITHUB_TOKEN", "GITHUB_REPOSITORY", "I13_ISSUE_NUMBER", "I13_REVIEWER");
      return missing;
    }
    case "published-article-check": {
      const missing: string[] = [];
      if (!config.strapi) missing.push("CONTROL_STRAPI_URL", "CONTROL_STRAPI_READ_TOKEN");
      if (!config.siteUrl) missing.push("SITE_URL");
      return missing;
    }
    case "article-cover": {
      // アップロードに書き込みトークンが要る。無いまま生成すると費用だけが出るため、これも不足として挙げる
      const missing: string[] = [];
      if (!config.openai) missing.push("OPENAI_API_KEY");
      if (!config.strapi) missing.push("CONTROL_STRAPI_URL", "CONTROL_STRAPI_READ_TOKEN");
      if (!config.strapi?.writeToken) missing.push("CONTROL_STRAPI_WRITE_TOKEN");
      return missing;
    }
    case "campaign-asset-upload": {
      // アップロードと記事への添付に書き込みトークンが要る
      const missing: string[] = [];
      if (!config.strapi) missing.push("CONTROL_STRAPI_URL", "CONTROL_STRAPI_READ_TOKEN");
      if (!config.strapi?.writeToken) missing.push("CONTROL_STRAPI_WRITE_TOKEN");
      return missing;
    }
    case "cycle-open":
    case "cycle-collect":
    case "cycle-close":
      // 周の判定に起点が要る。Strapi・Mautic・GitHub が無いときは、それを使う項目だけを確かめられない理由つきで飛ばす（ジョブは止めない）
      return config.cycleAnchor ? [] : ["CONTROL_CYCLE_ANCHOR"];
    case "heartbeat":
    case "runlog-flush":
    case "backup":
      return config.aws ? [] : AWS_VARS;
    default:
      return [];
  }
}
