"use client";

// 改善ループの API 呼び出し（Client Component から使う）。失敗は例外にせず、画面に出す文言を返す。

export type ApiResult<T> = { ok: true; body: T } | { ok: false; status: number; error: string };

async function post<T>(url: string, payload: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!response.ok) return { ok: false, status: response.status, error: body?.error ?? `失敗しました（${response.status}）` };
    return { ok: true, body: body as T };
  } catch {
    return { ok: false, status: 0, error: "サーバーに接続できませんでした" };
  }
}

/** OK。checked は確認項目の id。expectedUpdatedAt は画面で見た項目の updatedAt（変えずに送る） */
export function approveItem(itemId: string, checked: string[], expectedUpdatedAt: string) {
  return post<unknown>(`/api/cycle/items/${itemId}`, { action: "approve", checked, expectedUpdatedAt });
}

export function rejectItem(itemId: string, reason: string) {
  return post<unknown>(`/api/cycle/items/${itemId}`, { action: "reject", reason });
}

export function executeItem(itemId: string) {
  return post<{ accepted: boolean }>(`/api/cycle/items/${itemId}`, { action: "execute" });
}

export function startCycle() {
  return post<unknown>("/api/cycle", undefined);
}

/** 段階（①〜⑦）のジョブを今すぐ実行する。段階のジョブを順に 1 本ずつ起動する。実行中・ジョブの無い段階は accepted=false と reason */
export function runStageNow(stage: string) {
  return post<{ accepted: boolean; reason: string | null }>(`/api/cycle/stages/${stage}`, undefined);
}
