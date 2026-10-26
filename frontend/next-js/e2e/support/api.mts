// 監視アプリの API を直接呼ぶ補助（テストデータを作る・終わるまで待つ）。画面の操作の検証は spec 側で行う。
import type { APIRequestContext } from "@playwright/test";
import type { ManualRunAccepted, ManualRunRequest, RunRecord } from "control-plane";
import { BASE_URL } from "./sandbox.mjs";

/** 手動で起動する（同じオリジンからの POST。完了を待たずに返る。受け付けたら 202、起動の前に見送ったら 200） */
export async function startRun(request: APIRequestContext, cookie: string, target: ManualRunRequest["target"]): Promise<ManualRunAccepted> {
  const res = await request.post("/api/runs", { headers: { cookie, origin: BASE_URL }, data: { target } });
  if (res.status() !== 202 && res.status() !== 200) throw new Error(`手動の起動が受け付けられない（HTTP ${res.status()}: ${(await res.text()).slice(0, 200)}）`);
  return (await res.json()) as ManualRunAccepted;
}

/** 実行が終わるまで GET /api/runs/[runId] を見に行く */
export async function waitForRun(request: APIRequestContext, cookie: string, runId: string, timeoutMs = 60_000): Promise<RunRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request.get(`/api/runs/${runId}`, { headers: { cookie } });
    const run = res.ok() ? ((await res.json()) as { run?: RunRecord }).run : undefined;
    if (run?.status === "finished") return run;
    if (Date.now() >= deadline) throw new Error(`run ${runId} の完了を ${timeoutMs}ms 待ったが届かなかった（最後: ${run?.status ?? `HTTP ${res.status()}`}）`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * 起動して終わるまで待つ。同じジョブ・エージェントが別のテストで実行中なら、設計どおり「継続中のため見送り」になるので、待って起動し直す
 */
export async function runToCompletion(request: APIRequestContext, cookie: string, target: ManualRunRequest["target"]): Promise<RunRecord> {
  for (let attempt = 1; ; attempt += 1) {
    const run = await waitForRun(request, cookie, (await startRun(request, cookie, target)).runId);
    if (run.skipReason !== "前回の実行が継続中のため起動を見送った" || attempt >= 5) return run;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}
