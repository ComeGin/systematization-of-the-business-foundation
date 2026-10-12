import { createConnection } from "node:net";
import { unpauseValkey } from "./helpers/valkey.js";

const reachable = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });

/** 前提が欠けていれば、足りないものを示して止まる。前回のテストが pause したまま落ちていたら戻す */
export default async function setup(): Promise<void> {
  try {
    unpauseValkey();
  } catch {
    throw new Error("結合テストの前提が足りない: consent-api-valkey-1 が無い（cd backend/consent-api && docker compose up -d valkey）");
  }
  if (!(await reachable(6380))) {
    throw new Error("結合テストの前提が足りない: 127.0.0.1:6380 に届かない（compose.yml の ports を反映: docker compose up -d valkey）");
  }
}
