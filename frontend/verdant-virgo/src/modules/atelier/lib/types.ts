// アトリエ（ヒーロー第 2 版）の型。three・DOM に依存しない。
// 設計は docs/superpowers/specs/2026-10-28-hero-atelier-design.md。

/** 冒頭にアトリエの絵を出すページ（spec §7）。規約・ポリシー（C）は含まない */
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
  | "contactThanks"
  | "accessibility";

/** 置き物（spec §5.2） */
export type PropId =
  | "nameplate"
  | "avatar"
  | "envSetup"
  | "development"
  | "consulting"
  | "partnership"
  | "pricing"
  | "blog"
  | "wall"
  | "contact";

export interface PropDef {
  id: PropId;
  /** glb の置き物のノード名（原点は底面の中心） */
  node: `prop_${PropId}`;
  /** glb のボタンを重ねる点のノード名 */
  anchor: `anchor_${PropId}`;
  /** Tips を押した移り先。移らない置き物は null */
  href: string | null;
  /** 移り先の冒頭の静止画（= Tips の画像）。href と同じページ */
  still: PageKey | null;
}

/** 展示の壁の額（spec §8） */
export type FrameId =
  | "experience"
  | "jis"
  | "lighthouse"
  | "agents"
  | `case:${"keizu" | "egnity" | "sho-rise"}`;

export interface FrameDef {
  id: FrameId;
  kind: "self" | "case";
  /** 実績を裏付けるページ。無ければ Tips を持たない飾りの額 */
  href: string | null;
  still: PageKey | null;
}

/** 冒頭の静止画のカメラ（glb の cam_<PageKey の : を _ に>） */
export interface StillView {
  camera: `cam_${string}`;
  /** 静止画にアバターが写る */
  showsAvatar: boolean;
  /** Mobile 用の縦長の構図を別に書き出す */
  mobile: boolean;
}

export type Phase = "morning" | "day" | "dusk" | "night";

/** 代表のアバターの身ぶり（待機の idle を含まない） */
export type MotionName =
  "greeting" | "nod" | "peace" | "point" | "show-full-body" | "think";
