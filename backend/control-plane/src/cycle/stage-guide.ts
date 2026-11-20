// 改善ループの画面の段階ごとの「項目はどのジョブがいつ作るか」と「今、項目が作られない・進まない理由」（2026-11-20）。
// 項目を作るのは次の 3 つだけで、ほかのジョブ（観測・計測・提案・企画・初稿・アイキャッチ）は成功しても項目を作らない:
//   - 作用のジョブ（cycle-apply-content・cycle-campaign・cycle-apply-code）: 起動したときに「作成中」の項目を作る（engine.ts の openPreparingItem）
//   - cycle-collect: 改修案・設定変更・キーワードの経路の下書きを項目にし、「作成中」を「承認待ち」か「確認できなかった」にする（builtin/cycle-collect.ts）
//   - published-article-check: 配信の項目を作る（builtin/published-article-check.ts）
// そのため cycle-collect が無効だと、②③⑤⑥ の項目は作られないか、「作成中」のまま進まない。画面はそれを理由として出す。
import type { CycleStage } from "../contract.js";

/** 項目を作るジョブ */
export const ITEM_MAKING_JOBS: ReadonlySet<string> = new Set([
  "cycle-apply-content",
  "cycle-campaign",
  "cycle-apply-code",
  "cycle-collect",
  "published-article-check",
]);

/** 項目を作る・進めるのに cycle-collect が要る段階 */
const NEEDS_COLLECT: ReadonlySet<CycleStage> = new Set(["propose", "draft", "publish", "evaluate"]);

export const COLLECT_JOB_ID = "cycle-collect";

const ITEM_SOURCE: Record<CycleStage, string> = {
  collect:
    "この段階は項目を作らない。観測のジョブ（daily-observe-*）の結果は E-12（docs/audits/）に残る。進み具合は下のジョブの直近の実行で見る。",
  propose:
    "daily-propose が改修案（E-13）を作業場に起票し、daily-i13-file が PR にする。改修案を項目（PR の状態を見せる）にするのは cycle-collect。daily-propose は項目を作らない。",
  draft:
    "作用のジョブ（cycle-apply-content・cycle-campaign）は、起動したときに「作成中」の項目を作る。中身を入れて「承認待ち」にする（成果物が無ければ「確認できなかった」にする）のは cycle-collect。" +
    "キーワードの経路の下書き（weekly-content-draft）を記事の項目にするのも cycle-collect。企画（weekly-content-plan）・アイキャッチ（article-cover）は項目を作らない。",
  review: "この段階に項目は無い。承認（OK・差し戻し）は、各段階の「承認待ち」の項目を開いて行う。",
  publish:
    "cycle-collect が、承認済みで未適用の設定変更（config_change）を「人の作業」の項目にし、ほかの段階の項目も進める（「作成中」→「承認待ち」、「実行済み」→「確認済み」）。" +
    "記事の公開そのものは Strapi の管理画面で行う。",
  evaluate:
    "cycle-apply-code は、起動したときに「作成中」の項目を作る（改修案の種類が technical_seo・accessibility・cta_swap・internal_link のとき）。" +
    "中身を入れて「承認待ち」にする（差分が無ければ「確認できなかった」にする）のは cycle-collect。計測（weekly-lighthouse・weekly-a11y）は項目を作らない。",
  deploy:
    "published-article-check が、最後に確かめた配信から公開済みの記事か公開サイトのコード（frontend/verdant-virgo）が変わった夜に、配信の項目を作る。" +
    "変わっていない夜は、成功でも項目を作らない。OK 済み・実行済み・確認できなかった配信の項目が残っているあいだも作らない。",
};

export function stageItemSource(stage: CycleStage): string {
  return ITEM_SOURCE[stage];
}

/**
 * 項目が作られない・進まない理由。cycle-collect が定義に無いか無効（enabled: false）なら、②③⑤⑥ に理由を返す。
 * 「今すぐ実行」は無効のジョブでも動かせる（手動の起動は enabled を見ない）ので、その案内も入れる。
 */
export function stageItemBlocked(stage: CycleStage, jobs: readonly { id: string; enabled: boolean }[]): string | null {
  if (!NEEDS_COLLECT.has(stage)) return null;
  const collect = jobs.find((job) => job.id === COLLECT_JOB_ID);
  if (collect?.enabled) return null;
  const state = collect ? "無効（ops/schedules/cycle-collect.yaml の enabled: false）" : "定期実行の定義に無い";
  const how =
    stage === "publish"
      ? "この段階の「今すぐ実行」で手で動かすか、定義を有効にする"
      : "⑤ 公開・送信の「今すぐ実行」で手で動かすか、定義を有効にする";
  return `cycle-collect が${state}ため、この段階の項目は作られないか、「作成中」から進まない。${how}。`;
}
