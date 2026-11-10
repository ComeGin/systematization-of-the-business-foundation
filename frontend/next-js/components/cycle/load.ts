// 改善ループのページ（/cycle と /cycle/[cycleId]）が、サーバーで読むものをまとめる。
import type { ControlPlane, CycleRow, CycleView, JobDefinition } from "control-plane";

export interface CyclePageData {
  view: CycleView;
  /** 段階に結びつくジョブの定義（概要とジョブ詳細へのリンクを出すため。段階の jobIds のものだけ） */
  jobs: JobDefinition[];
  /** 周の一覧（新しい周から。別の周へ移るため） */
  cycles: CycleRow[];
}

export async function loadCyclePageData(plane: ControlPlane, cycleId?: string): Promise<CyclePageData> {
  const [view, cycles, jobStatuses] = await Promise.all([plane.getCycle(cycleId), plane.listCycles(), plane.listJobs()]);
  const wanted = new Set(view.stages.flatMap((stage) => stage.jobIds));
  const jobs = jobStatuses.map((job) => job.definition).filter((definition) => wanted.has(definition.id));
  return { view, jobs, cycles };
}
