import { ConfigErrorView } from "@/components/common/ConfigErrorView";
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
  const rows = await state.plane.listRuns({ limit: PAGE_SIZE + 1, outcome: outcome ?? undefined, before: before ?? undefined });

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
    />
  );
}
