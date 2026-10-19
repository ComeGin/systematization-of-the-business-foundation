import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { toClipJson } from "@/modules/avatar/tools/convert-mixamo.mjs";

// toClipJson（Mixamo のクリップ → MotionClipJson）。FBX ファイルは読まず、three の Bone・Group・AnimationClip で
// 小さな Mixamo 風の骨格（mixamorig:Hips と子の mixamorig:Spine）とクリップを組む。

const S = Math.SQRT1_2;
const round4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0; // + 0 で -0 を 0 にする

/** 腰（高さ hipsY）と背骨（腰からの位置 10）だけの骨格。休止姿勢の回転を骨ごとに渡せる */
function makeRig(
  options: {
    hipsY?: number;
    hipsRest?: THREE.Quaternion;
    spineRest?: THREE.Quaternion;
    withFinger?: boolean;
    withExtra?: boolean;
  } = {},
) {
  const root = new THREE.Group();
  const hips = new THREE.Bone();
  hips.name = "mixamorig:Hips";
  hips.position.set(0, options.hipsY ?? 104.27, 0);
  if (options.hipsRest) hips.quaternion.copy(options.hipsRest);
  const spine = new THREE.Bone();
  spine.name = "mixamorig:Spine";
  spine.position.set(0, 10, 0);
  if (options.spineRest) spine.quaternion.copy(options.spineRest);
  root.add(hips);
  hips.add(spine);
  if (options.withFinger) {
    const finger = new THREE.Bone();
    finger.name = "mixamorig:LeftHandIndex1";
    spine.add(finger);
  }
  if (options.withExtra) {
    const end = new THREE.Bone();
    end.name = "mixamorig:HeadTop_End";
    spine.add(end);
  }
  return root;
}

const quatTrack = (name: string, values: number[]) =>
  new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, [0, 1], values);

describe("toClipJson", () => {
  describe("正常系", () => {
    it("休止姿勢が単位回転なら、回転の値は入力と同じ（小数 4 桁）。bone は hips・spine", () => {
      const n = Math.sqrt(30);
      const q = [1 / n, 2 / n, 3 / n, 4 / n];
      const values = [0, 0, 0, 1, ...q];
      const clip = new THREE.AnimationClip("mixamo.com", 1, [
        quatTrack("mixamorig:Hips", values),
        quatTrack("mixamorig:Spine", values),
      ]);
      const json = toClipJson(makeRig(), clip, "nod", {
        keepFingers: false,
        fps: 1,
      });
      expect(json.tracks.map((t) => t.bone)).toEqual(["hips", "spine"]);
      for (const track of json.tracks) {
        expect(track.path).toBe("quaternion");
        expect(track.times).toEqual([0, 1]);
        expect(track.values).toEqual(values.map(round4));
      }
      expect(json).toMatchObject({
        version: 1,
        name: "nod",
        duration: 1,
        fps: 1,
      });
    });

    it("休止姿勢に回転がある骨は、親の休止のワールド回転 × 回転 × 自分の休止のワールド回転の逆 になる（サンプルの式）", () => {
      // 手計算: 腰の休止 = Y 軸まわり 90°、背骨の休止（ローカル）= 単位回転 → 背骨の休止のワールド回転 = Y 90°。
      // 背骨のトラック = X 軸まわり 90° のとき、Y90 × X90 × Y90⁻¹ は「Y 90° で回した X 軸（= -Z 軸）まわりの 90°」
      //   = (0, 0, -√½, √½)。
      // 腰のトラック = 休止と同じ Y 90° のとき、親（ルート）は単位回転なので 単位 × Y90 × Y90⁻¹ = 単位回転。
      const yaw90 = [0, S, 0, S];
      const pitch90 = [S, 0, 0, S];
      const rig = makeRig({ hipsRest: new THREE.Quaternion(...yaw90) });
      const clip = new THREE.AnimationClip("mixamo.com", 1, [
        quatTrack("mixamorig:Hips", [...yaw90, ...yaw90]),
        quatTrack("mixamorig:Spine", [...pitch90, ...pitch90]),
      ]);
      const json = toClipJson(rig, clip, "nod", { keepFingers: false, fps: 1 });
      const hips = json.tracks.find((t) => t.bone === "hips");
      const spine = json.tracks.find((t) => t.bone === "spine");
      expect(hips?.values).toEqual([0, 0, 0, 1, 0, 0, 0, 1]);
      expect(spine?.values).toEqual([
        0, 0, -0.7071, 0.7071, 0, 0, -0.7071, 0.7071,
      ]);
    });

    it("ルート（Armature 相当）にも回転がある 3 段の鎖では、親の休止の回転はローカルでなくワールドの回転を使う", () => {
      // 手計算: ルート = Y 軸まわり 90°、腰と背骨の休止（ローカル）= 単位回転。
      //   腰の休止のワールド回転 = Y90（ローカルは単位回転なので、ローカルを使うとここで食い違う）。
      //   背骨の休止のワールド回転 = Y90。
      // 背骨のトラック = X 軸まわり 90° → Y90 × X90 × Y90⁻¹ =「-Z 軸まわりの 90°」= (0, 0, -√½, √½)。
      //   （親のローカル〈単位回転〉を使うと X90 × Y90⁻¹ になり、一致しない）
      // 腰のトラック = 単位回転 → 親（ルート）のワールド Y90 × 単位 × Y90⁻¹ = 単位回転。
      const rig = makeRig();
      rig.quaternion.set(0, S, 0, S);
      const clip = new THREE.AnimationClip("mixamo.com", 1, [
        quatTrack("mixamorig:Hips", [0, 0, 0, 1, 0, 0, 0, 1]),
        quatTrack("mixamorig:Spine", [S, 0, 0, S, S, 0, 0, S]),
      ]);
      const json = toClipJson(rig, clip, "nod", { keepFingers: false, fps: 1 });
      const hips = json.tracks.find((t) => t.bone === "hips");
      const spine = json.tracks.find((t) => t.bone === "spine");
      expect(hips?.values).toEqual([0, 0, 0, 1, 0, 0, 0, 1]);
      expect(spine?.values).toEqual([0, 0, -0.7071, 0.7071, 0, 0, -0.7071, 0.7071]);
    });

    it("mixamorig:Hips の位置のトラックは path: position で残り、mixamoHipsHeight は腰の高さ", () => {
      const clip = new THREE.AnimationClip("mixamo.com", 1, [
        new THREE.VectorKeyframeTrack(
          "mixamorig:Hips.position",
          [0, 1],
          [1, 104.27, 2, 1.23456, 100, -3],
        ),
      ]);
      const json = toClipJson(makeRig({ hipsY: 104.27 }), clip, "idle", {
        keepFingers: false,
        fps: 1,
      });
      expect(json.mixamoHipsHeight).toBe(104.27);
      expect(json.tracks).toEqual([
        {
          bone: "hips",
          path: "position",
          times: [0, 1],
          values: [1, 104.27, 2, 1.2346, 100, -3],
        },
      ]);
    });

    it("FBXLoader が : を落とした名前（mixamorigHips）でも同じ骨に対応させる", () => {
      const rig = makeRig();
      rig.getObjectByName("mixamorig:Hips")!.name = "mixamorigHips";
      const clip = new THREE.AnimationClip("mixamo.com", 1, [
        quatTrack("mixamorigHips", [0, 0, 0, 1, 0, 0, 0, 1]),
      ]);
      const json = toClipJson(rig, clip, "nod", { keepFingers: false, fps: 1 });
      expect(json.tracks.map((t) => t.bone)).toEqual(["hips"]);
    });

    it("keepFingers: false で mixamorig:LeftHandIndex1 のトラックが落ち、true なら leftIndexProximal で残る", () => {
      const clip = new THREE.AnimationClip("mixamo.com", 1, [
        quatTrack("mixamorig:Hips", [0, 0, 0, 1, 0, 0, 0, 1]),
        quatTrack("mixamorig:LeftHandIndex1", [0, 0, 0, 1, 0, 0, 0, 1]),
      ]);
      const rig = makeRig({ withFinger: true });
      const without = toClipJson(rig, clip, "greeting", {
        keepFingers: false,
        fps: 1,
      });
      expect(without.tracks.map((t) => t.bone)).toEqual(["hips"]);
      const kept = toClipJson(rig, clip, "point", {
        keepFingers: true,
        fps: 1,
      });
      expect(kept.tracks.map((t) => t.bone)).toEqual([
        "hips",
        "leftIndexProximal",
      ]);
    });

    it("fps の間隔で書き出し直す（0〜1 秒を fps 4 で 5 点。回転は球面補間）", () => {
      const clip = new THREE.AnimationClip("mixamo.com", 1, [
        quatTrack("mixamorig:Spine", [0, 0, 0, 1, ...[S, 0, 0, S]]),
      ]);
      const json = toClipJson(makeRig(), clip, "nod", {
        keepFingers: false,
        fps: 4,
      });
      const [spine] = json.tracks;
      expect(spine.times).toEqual([0, 0.25, 0.5, 0.75, 1]);
      // 0.5 秒は X 軸まわり 45°
      expect(spine.values.slice(8, 12)).toEqual([0.3827, 0, 0, 0.9239]);
    });
  });

  describe("異常系", () => {
    it("空入力: トラックの無いクリップは tracks: []", () => {
      const clip = new THREE.AnimationClip("mixamo.com", 0, []);
      const json = toClipJson(makeRig(), clip, "idle", {
        keepFingers: false,
        fps: 30,
      });
      expect(json.tracks).toEqual([]);
      expect(json.duration).toBe(0);
    });

    it("入力: 対応表に無い骨のトラックは落とす", () => {
      const clip = new THREE.AnimationClip("mixamo.com", 1, [
        quatTrack("mixamorig:Hips", [0, 0, 0, 1, 0, 0, 0, 1]),
        quatTrack("mixamorig:HeadTop_End", [0, 0, 0, 1, 0, 0, 0, 1]),
      ]);
      const json = toClipJson(makeRig({ withExtra: true }), clip, "nod", {
        keepFingers: false,
        fps: 1,
      });
      expect(json.tracks.map((t) => t.bone)).toEqual(["hips"]);
    });

    it("入力: 腰以外の位置のトラックと scale のトラックは落とす", () => {
      const clip = new THREE.AnimationClip("mixamo.com", 1, [
        new THREE.VectorKeyframeTrack(
          "mixamorig:Spine.position",
          [0, 1],
          [0, 10, 0, 0, 11, 0],
        ),
        new THREE.VectorKeyframeTrack(
          "mixamorig:Hips.scale",
          [0, 1],
          [1, 1, 1, 1, 1, 1],
        ),
      ]);
      const json = toClipJson(makeRig(), clip, "nod", {
        keepFingers: false,
        fps: 1,
      });
      expect(json.tracks).toEqual([]);
    });

    it("入力: 骨格に腰（mixamorig:Hips）が無ければ throw", () => {
      const clip = new THREE.AnimationClip("mixamo.com", 0, []);
      expect(() =>
        toClipJson(new THREE.Group(), clip, "idle", {
          keepFingers: false,
          fps: 30,
        }),
      ).toThrow();
    });

    it("入力: fps が 0 以下なら throw", () => {
      const clip = new THREE.AnimationClip("mixamo.com", 0, []);
      expect(() =>
        toClipJson(makeRig(), clip, "idle", { keepFingers: false, fps: 0 }),
      ).toThrow();
    });
  });
});
