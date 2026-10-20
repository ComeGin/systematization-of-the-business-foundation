// avatar モジュールの型（契約）。アバターは A（vivid）と B（calm）のページに出し、C（none）には出さない（設計書 §7）。
// 文言の既定値は持たない（H-16）。文言は site-content から渡す。
import type { VRMHumanBoneName } from "@pixiv/three-vrm";

/**
 * アバターが動きを起こす場面（2026-10-20 の裁定 R20）。
 * arrive＝出た（手を振る）、idle＝しばらく操作が無い（待機の呼吸に入る）、wake＝idle の後に操作があった（直立に戻る）、tap＝アバターを押した（ほかの身ぶり）
 */
export type AvatarTrigger = "arrive" | "idle" | "wake" | "tap";

/** VRMA（モーションファイル）で動かす表現 */
export type VrmaEmote = "greeting" | "peace" | "show-full-body";

/** コードで関節を動かす表現（VRMA を使わない） */
export type ProceduralEmote = "nod" | "point" | "think";

export type EmoteId = VrmaEmote | ProceduralEmote;

/** アバターの操作ボタンの文言（site-content から渡す） */
export interface AvatarLabels {
  pause: string;
  resume: string;
  collapse: string;
  expand: string;
  summon: string;
  /** アバター本体のボタンの名前（押すと身ぶりをする） */
  interact: string;
  /** アバター本体のボタンの補足（title。押す・拡大縮小の操作の案内） */
  interactHint: string;
}

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
