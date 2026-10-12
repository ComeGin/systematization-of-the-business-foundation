import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { BOT_PORT, CHATWOOT, readState } from "./helpers/state.js";

const portInUse = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });

/** 前提が欠けていれば、足りないものを並べて止まる */
export default async function setup(): Promise<void> {
  const problems: string[] = [];
  const api = await fetch(`${CHATWOOT}/api`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.json()).catch(() => null);
  if (api?.data_services !== "ok") problems.push(`Chatwoot が ${CHATWOOT} で動いていない（cd backend/chatwoot-system && docker compose up -d）`);

  let state: ReturnType<typeof readState> | null = null;
  try {
    state = readState();
  } catch (error) {
    problems.push((error as Error).message);
  }

  const listening = execFileSync("ss", ["-ltn"], { encoding: "utf8" });
  if (!new RegExp(`172\\.17\\.0\\.1:${BOT_PORT}\\b`).test(listening)) problems.push(`host-relay が ${BOT_PORT} を中継していない（cd middleware/host-relay && docker compose up -d）`);
  if (await portInUse(BOT_PORT)) problems.push(`127.0.0.1:${BOT_PORT} が使われている（faq-bot の pnpm dev を止める。テストが起動する）`);

  if (state && api) {
    const res = await fetch(`${CHATWOOT}/api/v1/accounts/${state.accountId}/inboxes/${state.inboxId}/agent_bot`, { headers: { api_access_token: state.adminToken } });
    const body = res.ok ? ((await res.json()) as { agent_bot?: { id?: number } }) : null;
    if (body?.agent_bot?.id !== state.botId) problems.push("FAQ ボットが Web サイトの受信箱に接続されていない（node setup/setup.mjs --target dev --only chatwoot）");
  }
  if (problems.length) throw new Error(`結合テストの前提が足りない:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
}
