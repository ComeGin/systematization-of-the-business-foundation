import { ConfigErrorView } from "@/components/common/ConfigErrorView";
import { DailyOpsPanel } from "@/components/jobs/DailyOpsPanel";
import { RunsListView } from "@/components/runs/RunsListView";
import { getControlPlaneState } from "@/lib/control-plane";
import { isRunOutcome, ULID } from "@/lib/ids";
import { requirePageSession } from "@/lib/session";

const PAGE_SIZE = 50;

// 一覧: 実行記録（E-15）。?outcome= で絞り込み、?before=<run_id> で古いページへさかのぼる
export default async function RunsPage(props: PageProps<"/runs">) {
  await requirePageSession();
  const state = getControlPlaneState();
  if (!state.plane) return <ConfigErrorView message={state.error} />;

  const { outcome: rawOutcome, before: rawBefore } = await props.searchParams;
  const outcome = isRunOutcome(rawOutcome) ? rawOutcome : null;
  const before = typeof rawBefore === "string" && ULID.test(rawBefore) ? rawBefore : null;
  // 1 件多く読んで、さらに古い記録があるかを知る
  // 「毎日の運用」は絞り込み・さかのぼりのない最新のページにだけ出す（入口の画面。2026-11-26）
  const showDailyOps = outcome === null && before === null;
  const [rows, jobs] = await Promise.all([
    state.plane.listRuns({ limit: PAGE_SIZE + 1, outcome: outcome ?? undefined, before: before ?? undefined }),
    showDailyOps ? state.plane.listJobs() : Promise.resolve([]),
  ]);

  const page = rows.slice(0, PAGE_SIZE);
  // 「中身」の列のため、表示する実行の観測をまとめて 1 回で読む（51 件目は次のページの有無を知るためだけなので読まない）
  const observations = Object.fromEntries((await state.plane.listRunObservations(page.map((run) => run.runId))).map((o) => [o.runId, o]));
  return (
    <RunsListView
      runs={page}
      observations={observations}
      hasOlder={rows.length > PAGE_SIZE}
      outcome={outcome}
      before={before}
      pageSize={PAGE_SIZE}
      notice={showDailyOps ? <DailyOpsPanel jobs={jobs} now={new Date().toISOString()} /> : null}
    />
  );
}
