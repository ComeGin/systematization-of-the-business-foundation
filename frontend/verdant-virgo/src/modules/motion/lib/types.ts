// motion モジュールの型（契約）。計画書の「インタラクションデザイン」と動きの規則 1〜8。
// 文言の既定値は持たない（03-handoff.md H-16）。文言は site-content から渡す。
import type { PhotoKey } from "@/modules/media";

/** MotionNav に渡すナビの項目。current は layout の currentState() の値をそのまま渡す */
export interface MotionNavLink {
  label: string;
  href: string;
  /** そのページなら 'page'、配下のページなら 'true'（aria-current の値） */
  current?: "page" | "true";
}

export interface MotionNavProps {
  links: MotionNavLink[];
  /** nav のランドマークの名前（既存の「メイン」） */
  label: string;
}

/** MorphGallery の 1 枚。写真は media の PHOTOS から選び、label は見えるラベル（ラジオの名前） */
export interface MorphGalleryItem {
  photo: PhotoKey;
  label: string;
}

export interface MorphGalleryProps {
  items: MorphGalleryItem[];
  /** ラジオのグループの名前にする見出しの id（新しい文言を足さない） */
  labelledby: string;
  class?: string;
}

export interface MotionSymbolProps {
  class?: string;
}

export interface MotionBlobsProps {
  /** MotionPause の名前（動いている間）。文言は site-content から */
  pauseLabel: string;
  /** MotionPause の名前（止まっている間） */
  resumeLabel: string;
  class?: string;
}

/** 送信の状態。失敗は 'idle' に戻す（形はチェックにしない。読み上げは既存の Alert に任せる） */
export type SendStatusState = "idle" | "sending" | "done";

/** ボタンの中に置く形だけの部品（aria-hidden）。Spinner と差し替える */
export interface SendStatusMarkProps {
  state: SendStatusState;
  className?: string;
}

/** ボタンの外に置く sr-only の role="status"。送信中だけ 1 回読ませる（done は読まない） */
export interface SendStatusAnnouncerProps {
  state: SendStatusState;
  /** 既存の「送信中…」（CONSULT_TEXT.submitting など） */
  sendingText: string;
}
