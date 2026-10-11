import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CHATWOOT = "http://127.0.0.1:3100";
export const BOT_PORT = 3107;

/** setup が書いた状態ファイル（~/.config/comegin/setup/dev.state.json）の値。秘密値を含むので出力しない */
export interface DevState {
  accountId: number;
  adminToken: string;
  inboxId: number;
  websiteToken: string;
  botId: number;
  botToken: string;
  botSecret: string;
}

export function readState(): DevState {
  const file = join(homedir(), ".config/comegin/setup/dev.state.json");
  const values = (JSON.parse(readFileSync(file, "utf8")) as { values: Record<string, string | undefined> }).values;
  const need = (key: string) => {
    const value = values[key];
    if (!value) throw new Error(`${key} が状態ファイルに無い（node setup/setup.mjs --target dev --only chatwoot,faq-bot）`);
    return value;
  };
  return {
    accountId: Number(need("CHATWOOT_ACCOUNT_ID")),
    adminToken: need("CHATWOOT_ADMIN_TOKEN"),
    inboxId: Number(need("CHATWOOT_INBOX_ID")),
    websiteToken: need("CHATWOOT_WEBSITE_TOKEN"),
    botId: Number(need("CHATWOOT_FAQ_BOT_ID")),
    botToken: need("CHATWOOT_FAQ_BOT_TOKEN"),
    botSecret: need("CHATWOOT_FAQ_BOT_SECRET"),
  };
}
