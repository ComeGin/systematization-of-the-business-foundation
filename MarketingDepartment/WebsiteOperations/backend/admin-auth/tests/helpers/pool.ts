import type pg from "pg";
import { vi } from "vitest";

type QueryResult = { rowCount?: number | null; rows?: unknown[] };

/** pg.Pool の代わり。query の応答はテストごとに差し替える */
export function fakePool(respond: (sql: string, params?: unknown[]) => QueryResult = () => ({ rowCount: 0, rows: [] })) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const result = respond(sql, params);
    return { rowCount: result.rowCount ?? null, rows: result.rows ?? [] };
  });
  const end = vi.fn(async () => {});
  return { pool: { query, end } as unknown as pg.Pool, query, end };
}
