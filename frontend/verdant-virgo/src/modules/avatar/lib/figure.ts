// 代表のアバターを、ほかの three のシーンに置く「人形」として作る（2026-10-28。ヒーローの模型の承認台に立たせる。spec §6.5・§5.2）。
// stage.ts（画面の端のアバター）と同じ VRM・同じクリップを使い、身ぶりは待機の呼吸と、承認のうなずきだけ。
// three は引数で受ける（three を静的に import しない。three は loadThree() の 1 つのチャンクだけから読む。R9）。
// three-vrm と GLTFLoader は、このファイルを動的に import したときだけ読まれる（diorama の scene.ts が、アバターが写るページだけで読む）。
import type * as THREE from "three";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { toAnimationClip } from "./clip";
import type { MotionClipJson } from "./types";

export interface AvatarFigureOptions {
  modelUrl: string;
  idleUrl: string;
  nodUrl: string;
}

export interface AvatarFigure {
  /** シーンに置く根（大きさ・位置・向きは置く側が決める） */
  object: THREE.Object3D;
  /** 経過時間（秒）だけ身ぶりを進める */
  update(dtSec: number): void;
  /** 1 回うなずいて、待機の呼吸に戻る（再生中なら何もしない） */
  nod(): void;
  dispose(): void;
}

async function fetchClip(url: string): Promise<MotionClipJson> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`クリップを読めない（${response.status}）`);
  return (await response.json()) as MotionClipJson;
}

export async function createAvatarFigure(
  three: typeof import("three"),
  { modelUrl, idleUrl, nodUrl }: AvatarFigureOptions,
): Promise<AvatarFigure> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const [gltf, idleJson, nodJson] = await Promise.all([
    loader.loadAsync(modelUrl),
    fetchClip(idleUrl),
    fetchClip(nodUrl),
  ]);
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new Error("VRM ではない");
  // perf: stage.ts と同じ下ごしらえ（使わない頂点・骨を落とし、骨格を 1 つにまとめる）。VRM 0.x は後ろ向きなので +Z へ向ける
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.rotateVRM0(vrm);

  const vec = new three.Vector3();
  const hipsNode = vrm.humanoid.getNormalizedBoneNode("hips");
  const vrmHipsHeight = hipsNode
    ? Math.abs(
        hipsNode.getWorldPosition(vec).y -
          vrm.scene.getWorldPosition(new three.Vector3()).y,
      )
    : 1;
  const target = {
    humanoid: vrm.humanoid,
    meta: { metaVersion: vrm.meta.metaVersion },
  };

  const mixer = new three.AnimationMixer(vrm.scene);
  const breathe = mixer.clipAction(
    toAnimationClip(three, idleJson, target, vrmHipsHeight),
  );
  const nodAction = mixer.clipAction(
    toAnimationClip(three, nodJson, target, vrmHipsHeight),
  );
  nodAction.setLoop(three.LoopOnce, 1);
  breathe.play();
  let nodding = false;
  mixer.addEventListener("finished", (event) => {
    if (event.action !== nodAction) return;
    nodding = false;
    breathe.reset().fadeIn(0.3).play();
    nodAction.fadeOut(0.3);
  });
  mixer.update(0);
  vrm.update(0);

  return {
    object: vrm.scene,
    update(dtSec) {
      mixer.update(dtSec);
      vrm.update(dtSec);
    },
    nod() {
      if (nodding) return;
      nodding = true;
      nodAction.reset().fadeIn(0.2).play();
      breathe.fadeOut(0.2);
    },
    dispose() {
      mixer.stopAllAction();
      VRMUtils.deepDispose(vrm.scene);
    },
  };
}
