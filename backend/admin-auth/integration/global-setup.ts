import { createConnection } from "node:net";
import { dropItDatabase, IT_DATABASE, recreateItDatabase, unpausePostgres } from "./helpers/postgres.js";

const reachable = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });

/** 前提が欠けていれば、足りないものを示して止まる。前回のテストが pause したまま落ちていたら戻す。専用の DB を作り直す */
export default async function setup(): Promise<() => Promise<void>> {
  try {
    unpausePostgres();
  } catch {
    throw new Error("結合テストの前提が足りない: admin-auth-postgres-1 が無い（cd backend/admin-auth && docker compose up -d postgres）");
  }
  if (!(await reachable(5434))) {
    throw new Error("結合テストの前提が足りない: 127.0.0.1:5434 に届かない（compose.yml の ports を反映: docker compose up -d postgres）");
  }
  await recreateItDatabase();
  return async () => {
    unpausePostgres();
    await dropItDatabase().catch((error: unknown) => console.error(`[integration] ${IT_DATABASE} を消せなかった:`, error));
  };
}
