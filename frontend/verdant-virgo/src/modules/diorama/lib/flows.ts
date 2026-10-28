// 光の粒の経路（spec §5.2）。経路は docs/DetailedDesign の実際のデータの流れと一致させる（アンチゴール 1）。
// 各段の stage は、粒がその部品を「出るとき」の段階。粒の色はこの段階で決まる（白＝流れ込み・青＝提案・金＝承認済み）。
// 承認台（approval）を通らずに承認済みになる流れ、配信の口（shipping）を通らずにサイトへ届く流れは作らない（assertFlowsLogical が拒む）。
import { PARTS } from "./parts";
import type { FlowId, FlowStep, PartId, Stage } from "./types";

const s = (part: PartId, stage: Stage): FlowStep => ({ part, stage });

export const FLOWS: Readonly<Record<FlowId, readonly FlowStep[]>> = {
  // フォームの問い合わせ: サイトのフォーム（窓口を通り抜ける）→ Mautic（I-08。DD-02 §5）→ n8n（I-11。DD-04 §4）
  inquiryForm: [
    s("desk", "inflow"),
    s("roster", "inflow"),
    s("pipe", "inflow"),
  ],
  // チャットの問い合わせ: Chatwoot（I-07。DD-02 §4）→ n8n（I-12。DD-04 §5）
  inquiryChat: [s("desk", "inflow"), s("pipe", "inflow")],
  // 記事: エージェントが本番の Strapi に下書き → R2 が公開・人間が配信を承認 → 配信 → サイト（DD-03 §4・DD-06 §1.5・DD-05 §3）
  article: [
    s("agents", "proposal"),
    s("shelf", "proposal"),
    s("approval", "approved"),
    s("shipping", "approved"),
    s("site", "approved"),
  ],
  // サイトの改善: 観測（GA4・PostHog・GSC）→ 提案（E-13）→ 承認（PR）→ 配信 → サイト（DD-06 §1.1・§1.5）
  improveSite: [
    s("gauge", "inflow"),
    s("agents", "proposal"),
    s("approval", "approved"),
    s("shipping", "approved"),
    s("site", "approved"),
  ],
  // Mautic の改善: 承認の後、エージェントが本番の Mautic に直接作用する（DD-06 §1.5）
  improveCrm: [
    s("gauge", "inflow"),
    s("agents", "proposal"),
    s("approval", "approved"),
    s("roster", "approved"),
  ],
  // Chatwoot の改善: 承認の後、エージェントが本番の Chatwoot に直接作用する（DD-06 §1.5）
  improveChat: [
    s("gauge", "inflow"),
    s("agents", "proposal"),
    s("approval", "approved"),
    s("desk", "approved"),
  ],
};

const RANK: Record<Stage, number> = { inflow: 0, proposal: 1, approved: 2 };

/** 経路が論理的に破綻していないかを確かめる。破綻していれば、流れの名前と理由を書いた Error を投げる */
export function assertFlowsLogical(
  flows: Readonly<Record<string, readonly FlowStep[]>>,
): void {
  for (const [name, flow] of Object.entries(flows)) {
    const fail = (reason: string): never => {
      throw new Error(`流れ「${name}」: ${reason}`);
    };
    if (flow.length === 0) fail("段が 1 つも無い");
    let approvedSeen = false;
    flow.forEach((step, i) => {
      if (!(step.part in PARTS)) fail(`存在しない部品「${step.part}」を含む`);
      if (step.part === "approval") approvedSeen = true;
      if (step.stage === "approved" && !approvedSeen)
        fail(`approval を通らずに承認済みになる（${i + 1} 段目）`);
      if (i > 0 && RANK[step.stage] < RANK[flow[i - 1].stage])
        fail(`段階が戻る（${i + 1} 段目）`);
      if (
        (step.part === "shipping" || step.part === "site") &&
        step.stage !== "approved"
      )
        fail(`${step.part} を approved でない粒が通る（${i + 1} 段目）`);
      if (step.part === "site" && flow[i - 1]?.part !== "shipping")
        fail(`shipping を通らずに site に届く（${i + 1} 段目）`);
    });
  }
}
