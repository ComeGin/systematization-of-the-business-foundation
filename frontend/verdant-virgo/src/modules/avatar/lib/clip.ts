// MotionClipJson（Task 9 の convert-mixamo.mjs が書き出した Mixamo のクリップ）を、three の AnimationClip に直す。
// 当て直しの式は three-vrm の公式サンプル（packages/three-vrm/examples/humanoidAnimation/loadMixamoAnimation.js、MIT。v3.5.5）の後半と同じ:
//   - トラック名は「正規化された骨のノード名.quaternion|position」。AnimationMixer は vrm.scene に作り、vrm.update() が正規化された骨から実際の骨へ写す。
//   - VRM 0.x（metaVersion "0"）は 1.0 と前後が逆向きなので、回転の x・z と位置の x・z の符号を反転する。
//   - 腰の位置は Mixamo の単位のままなので、vrmHipsHeight / mixamoHipsHeight を掛ける。
// three は引数で受ける（このファイルから three を静的に import しない。three は loadThree() の 1 つのチャンクだけから読む。R9）。
import type * as THREE from "three";
import type { VRMHumanBoneName } from "@pixiv/three-vrm";
import type { MotionClipJson } from "./types";

/** toAnimationClip が使う vrm の部分（VRM の実物か、テストの偽物） */
export interface ClipTargetVrm {
  humanoid: {
    getNormalizedBoneNode(name: VRMHumanBoneName): { name: string } | null;
    normalizedRestPose?: unknown;
  };
  meta: { metaVersion: "0" | "1" };
}

export function toAnimationClip(
  three: typeof import("three"),
  json: MotionClipJson,
  vrm: ClipTargetVrm,
  vrmHipsHeight: number,
): THREE.AnimationClip {
  const vrm0 = vrm.meta.metaVersion === "0";
  const hipsScale = vrmHipsHeight / json.mixamoHipsHeight;
  const tracks: THREE.KeyframeTrack[] = [];

  for (const track of json.tracks) {
    const node = vrm.humanoid.getNormalizedBoneNode(track.bone);
    // モデルに無い骨（指を持たないモデルなど）のトラックは落とす
    if (!node) continue;
    const name = `${node.name}.${track.path}`;
    if (track.path === "quaternion") {
      // x, y, z, w の 4 個ずつ。x（i%4=0）と z（i%4=2）を反転する
      const values = vrm0 ? track.values.map((v, i) => (i % 2 === 0 ? -v : v)) : track.values;
      tracks.push(new three.QuaternionKeyframeTrack(name, track.times, values));
    } else {
      // x, y, z の 3 個ずつ。VRM 0.x では x・z（y 以外）を反転する
      const values = track.values.map((v, i) => (vrm0 && i % 3 !== 1 ? -v : v) * hipsScale);
      tracks.push(new three.VectorKeyframeTrack(name, track.times, values));
    }
  }

  return new three.AnimationClip(json.name, json.duration, tracks);
}
