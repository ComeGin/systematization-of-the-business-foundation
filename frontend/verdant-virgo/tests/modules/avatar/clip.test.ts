import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { VRMHumanBoneName } from "@pixiv/three-vrm";
import { toAnimationClip } from "@/modules/avatar/lib/clip";
import type { MotionClipJson, MotionClipTrack } from "@/modules/avatar/lib/types";

// toAnimationClip（MotionClipJson → three の AnimationClip）。three は実物、vrm は getNormalizedBoneNode だけを持つ小さな偽物。
// 偽の vrm が持つ骨は hips と spine だけ（正規化された骨のノード名は Normalized_<骨の名前>）。

const S = Math.SQRT1_2;

function fakeVrm(metaVersion: "0" | "1") {
  const nodes: Partial<Record<VRMHumanBoneName, { name: string }>> = {
    hips: { name: "Normalized_hips" },
    spine: { name: "Normalized_spine" },
  };
  return {
    humanoid: { getNormalizedBoneNode: (name: VRMHumanBoneName) => nodes[name] ?? null },
    meta: { metaVersion },
  };
}

function clipJson(tracks: MotionClipTrack[]): MotionClipJson {
  return { version: 1, name: "nod", duration: 1, fps: 24, mixamoHipsHeight: 100, tracks };
}

const HIPS_POSITION: MotionClipTrack = {
  bone: "hips",
  path: "position",
  times: [0, 1],
  values: [10, 100, 20, -10, 100, -20],
};
const HIPS_ROTATION: MotionClipTrack = {
  bone: "hips",
  path: "quaternion",
  times: [0],
  values: [0.1, 0.2, 0.3, 0.9],
};
const SPINE_ROTATION: MotionClipTrack = {
  bone: "spine",
  path: "quaternion",
  times: [0, 1],
  values: [S, 0, 0, S, 0, 0, S, S],
};
const HAND_ROTATION: MotionClipTrack = {
  bone: "leftHand",
  path: "quaternion",
  times: [0],
  values: [0, 0, 0, 1],
};

const valuesOf = (track: THREE.KeyframeTrack) => Array.from(track.values, (v) => Math.round(v * 1e4) / 1e4 + 0);

describe("toAnimationClip", () => {
  describe("正常系", () => {
    it("hips と spine のトラックが、正規化された骨のノード名に付け替わる（名前・長さはクリップのまま）", () => {
      const clip = toAnimationClip(THREE, clipJson([HIPS_ROTATION, SPINE_ROTATION]), fakeVrm("1"), 1);
      expect(clip.name).toBe("nod");
      expect(clip.duration).toBe(1);
      expect(clip.tracks.map((t) => t.name)).toEqual(["Normalized_hips.quaternion", "Normalized_spine.quaternion"]);
      expect(clip.tracks[0]).toBeInstanceOf(THREE.QuaternionKeyframeTrack);
      expect(valuesOf(clip.tracks[1]!)).toEqual(valuesOf(new THREE.QuaternionKeyframeTrack("x", [0, 1], SPINE_ROTATION.values)));
    });
    it("metaVersion が 1 なら回転はそのまま", () => {
      const clip = toAnimationClip(THREE, clipJson([HIPS_ROTATION]), fakeVrm("1"), 1);
      expect(valuesOf(clip.tracks[0]!)).toEqual([0.1, 0.2, 0.3, 0.9]);
    });
    it("metaVersion が 0 なら回転の x・z の符号が反転する", () => {
      const clip = toAnimationClip(THREE, clipJson([HIPS_ROTATION]), fakeVrm("0"), 1);
      expect(valuesOf(clip.tracks[0]!)).toEqual([-0.1, 0.2, -0.3, 0.9]);
    });
    it("腰の位置が縮尺される（mixamoHipsHeight 100、vrmHipsHeight 1 で 100 → 1）", () => {
      const clip = toAnimationClip(THREE, clipJson([HIPS_POSITION]), fakeVrm("1"), 1);
      expect(clip.tracks[0]!.name).toBe("Normalized_hips.position");
      expect(clip.tracks[0]).toBeInstanceOf(THREE.VectorKeyframeTrack);
      expect(valuesOf(clip.tracks[0]!)).toEqual([0.1, 1, 0.2, -0.1, 1, -0.2]);
    });
    it("metaVersion が 0 なら位置の x・z の符号も反転する（y はそのまま）", () => {
      const clip = toAnimationClip(THREE, clipJson([HIPS_POSITION]), fakeVrm("0"), 1);
      expect(valuesOf(clip.tracks[0]!)).toEqual([-0.1, 1, -0.2, 0.1, 1, 0.2]);
    });
  });
  describe("異常系", () => {
    it("入力: モデルに無い骨のトラックは落とす", () => {
      const clip = toAnimationClip(THREE, clipJson([HAND_ROTATION, SPINE_ROTATION]), fakeVrm("0"), 1);
      expect(clip.tracks.map((t) => t.name)).toEqual(["Normalized_spine.quaternion"]);
    });
    it("入力: JSON の値を書き換えない（同じ JSON から 2 回作っても同じ値）", () => {
      const json = clipJson([HIPS_ROTATION]);
      toAnimationClip(THREE, json, fakeVrm("0"), 1);
      expect(json.tracks[0]!.values).toEqual([0.1, 0.2, 0.3, 0.9]);
    });
    it("空入力: tracks が [] なら空のクリップ", () => {
      const clip = toAnimationClip(THREE, clipJson([]), fakeVrm("0"), 1);
      expect(clip.tracks).toEqual([]);
      expect(clip.duration).toBe(1);
    });
  });
});
