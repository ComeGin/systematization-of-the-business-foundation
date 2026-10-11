// サーバーの起動時に 1 回だけ呼ばれる。control-plane（スケジューラ・ハートビート・写しの再送）をここで開始する。
// Node.js のランタイムのときだけ動かす（Edge では node:sqlite などが使えない）。
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // next build の間は起動しない（定期実行・ハートビートが走らないように）
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { startControlPlane } = await import("./lib/control-plane");
  const { ensureAuthSchema } = await import("./lib/auth");

  // 失敗してもサーバーは起動し、画面に原因（変数名だけ）を出す。値は出さない
  await ensureAuthSchema().catch((error: unknown) => {
    console.error(`- ERROR auth ログイン用 DB の準備に失敗: ${error instanceof Error ? error.message : "不明"}`);
  });
  await startControlPlane();
}
