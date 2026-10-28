// 模型（diorama）の型。設計は docs/superpowers/specs/2026-10-28-hero-diorama-design.md。
// 模型は「ComeGin の仕事場」。土台の上に基盤の部品が並び、まわりに ComeGin の仕事（受託開発・コンサル・業務提携）の場所がある。

/** 模型の部品。名前は glb のノード名（part_<id> など）にもそのまま使う */
export type PartId =
  | "base"
  | "shelf"
  | "desk"
  | "roster"
  | "pipe"
  | "gauge"
  | "agents"
  | "approval"
  | "shipping"
  | "site"
  | "workshop"
  | "drafting"
  | "bridge"
  | "priceTag";

export interface PartDef {
  id: PartId;
  /** system＝基盤の部品、work＝ComeGin の仕事の場所、prop＝小物（値札） */
  kind: "system" | "work" | "prop";
  /** 実際の製品・仕組みの名前（パネルに添える）。仕事の場所・小物は空 */
  products: readonly string[];
  /** トップのヒーローで押せるか（HTML のボタンを重ねる） */
  touchable: boolean;
  /** 持ち上げる単位のノード（原点は底面の中心） */
  node: `part_${PartId}`;
  /** ボタンと名前の札を重ねる点のノード */
  anchor: `anchor_${PartId}`;
  /** 部品の下の接地影の板のノード。土台と値札には無い */
  shadow: `shadow_${PartId}` | null;
}

/** 粒の段階。inflow＝流れ込み（白）、proposal＝提案（青）、approved＝承認済み（金） */
export type Stage = "inflow" | "proposal" | "approved";

export type FlowId =
  | "inquiryForm"
  | "inquiryChat"
  | "article"
  | "improveSite"
  | "improveCrm"
  | "improveChat";

/** 経路の 1 段。stage は粒がこの部品を「出るとき」の段階 */
export interface FlowStep {
  part: PartId;
  stage: Stage;
}

/** 模型が出るページ。サービス詳細は service:<slug> */
export type PageKey =
  | "top"
  | "services"
  | "service:environment-setup"
  | "service:development"
  | "service:consulting"
  | "service:partnership"
  | "about"
  | "pricing"
  | "blog"
  | "contact"
  | "contactThanks";

export interface PageView {
  /** live-touch＝動く・押せる（トップ）、live-view＝動く・眺めるだけ（サービス）、still＝静止画（B） */
  mode: "live-touch" | "live-view" | "still";
  /** カメラが寄る部品。全景のページは null */
  focus: PartId | null;
  /** glb のカメラのノード名（cam_ ＋ PageKey。: は _） */
  camera: `cam_${string}`;
  /** その構図に、模型の中の代表のアバターが写るか（写るなら、見えている間は端のアバターを出さない。H-13） */
  showsAvatar: boolean;
}
