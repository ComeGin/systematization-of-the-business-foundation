// avatar モジュールの型（契約）。2026-10-29 から、代表のアバターはトップのアトリエの中にだけ立つ（画面の端のアバターはやめた。atelier spec §11・A-13）。
import type { VRMHumanBoneName } from "@pixiv/three-vrm";

/** 身ぶりのクリップの名前（assets/motions/。アトリエの MotionName と同じ 6 つ） */
export type VrmaEmote = "greeting" | "peace" | "show-full-body";

/** コードで関節を動かす表現（VRMA を使わない） */
export type ProceduralEmote = "nod" | "point" | "think";

export type EmoteId = VrmaEmote | ProceduralEmote;

/** Mixamo から書き出したクリップの 1 本のトラック（Task 9 の convert-mixamo.mjs が作る） */
export interface MotionClipTrack {
  bone: VRMHumanBoneName;
  path: "quaternion" | "position";
  /** 秒。小数 4 桁 */
  times: number[];
  /** quaternion は 4 個ずつ（x, y, z, w）、position は 3 個ずつ。小数 4 桁 */
  values: number[];
}

/**
 * Mixamo から書き出したクリップの JSON（src/modules/avatar/assets/motions/*.json）。Task 10 の読み込みが使う。
 * - 回転は Mixamo の休止姿勢を打ち消し、VRM 1.0 の正規化された骨の空間へ直した値（VRM 0.x の x・z の反転は再生側で行う）。
 * - 位置は hips だけで、Mixamo の単位のまま。再生側で `vrmHipsHeight / mixamoHipsHeight` を掛ける。
 */
export interface MotionClipJson {
  version: 1;
  name: EmoteId | "idle";
  /** 秒 */
  duration: number;
  /** 書き出しの間隔（fps）。既定は 24（配信量を抑えるため。R15） */
  fps: number;
  /** Mixamo の腰の高さ（位置の縮尺の基準） */
  mixamoHipsHeight: number;
  tracks: MotionClipTrack[];
}
