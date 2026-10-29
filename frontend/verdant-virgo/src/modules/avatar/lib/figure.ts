// 代表のアバターを、ほかの three のシーンに置く「人形」として作る（2026-10-28。2026-10-29 にアトリエの身ぶりを足した。atelier spec §6.4）。
// VRM と身ぶりのクリップ（assets/motions/）を使い、待機の呼吸（idle）の上に、名前で選んだ身ぶりを 1 回だけ重ねて再生する。
// 再生中に次の身ぶりを頼まれたら、今の身ぶりが終わってから再生する（順番待ち）。クリップは作った直後に読み込みを始める（押してから待たせない）。
// three は引数で受ける（three を静的に import しない。three は loadThree() の 1 つのチャンクだけから読む。R9）。
// three-vrm と GLTFLoader は、このファイルを動的に import したときだけ読まれる（atelier の scene.ts が、アバターを立たせるときだけ読む）。
import type * as THREE from "three";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { toAnimationClip } from "./clip";
import type { MotionClipJson } from "./types";

export interface AvatarFigureOptions {
  modelUrl: string;
  /** 待機の呼吸（くり返す） */
  idleUrl: string;
  /** 身ぶりのクリップ（名前 → URL）。名前は呼ぶ側が決める（アトリエは MotionName） */
  clipUrls: Partial<Record<string, string>>;
}

export interface AvatarFigure {
  /** シーンに置く根（大きさ・位置・向きは置く側が決める） */
  object: THREE.Object3D;
  /** 経過時間（秒）だけ身ぶりを進める */
  update(dtSec: number): void;
  /** 名前の身ぶりを 1 回再生し、待機に戻ったら解決する。再生中なら、今の身ぶりの後に再生する。クリップが無い・読めないときは reject */
  play(name: string): Promise<void>;
  /** 身ぶりを再生している（または順番を待っている）間は true */
  readonly playing: boolean;
  dispose(): void;
}

async function fetchClip(url: string): Promise<MotionClipJson> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`クリップを読めない（${response.status}）`);
  return (await response.json()) as MotionClipJson;
}

export async function createAvatarFigure(
  three: typeof import("three"),
  { modelUrl, idleUrl, clipUrls }: AvatarFigureOptions,
): Promise<AvatarFigure> {
  const urls: Partial<Record<string, string>> = { ...clipUrls };
  // 身ぶりのクリップは、モデルと並べて読み始める（失敗はその名前の play で伝える。待機は止めない）
  const clips = new Map<string, Promise<MotionClipJson>>();
  for (const [name, url] of Object.entries(urls)) {
    if (!url) continue;
    const pending = fetchClip(url);
    pending.catch(() => {});
    clips.set(name, pending);
  }

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const [gltf, idleJson] = await Promise.all([
    loader.loadAsync(modelUrl),
    fetchClip(idleUrl),
  ]);
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new Error("VRM ではない");
  // perf: 使わない頂点・骨を落とし、骨格を 1 つにまとめる。VRM 0.x は後ろ向きなので +Z へ向ける
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
  breathe.play();
  const actions = new Map<string, THREE.AnimationAction>();
  let waiting = 0;
  // 順番待ちの列（前の身ぶりの成否に関わらず、次へ進む）
  let queue: Promise<void> = Promise.resolve();

  const playNow = async (name: string) => {
    const pending = clips.get(name);
    if (!pending) throw new Error(`身ぶり ${name} のクリップがありません`);
    const json = await pending;
    let action = actions.get(name);
    if (!action) {
      action = mixer.clipAction(
        toAnimationClip(three, json, target, vrmHipsHeight),
      );
      action.setLoop(three.LoopOnce, 1);
      action.clampWhenFinished = true;
      actions.set(name, action);
    }
    const current = action;
    await new Promise<void>((resolve) => {
      const onFinished = (event: { action: THREE.AnimationAction }) => {
        if (event.action !== current) return;
        mixer.removeEventListener("finished", onFinished);
        breathe.reset().fadeIn(0.3).play();
        current.fadeOut(0.3);
        resolve();
      };
      mixer.addEventListener("finished", onFinished);
      current.reset().fadeIn(0.2).play();
      breathe.fadeOut(0.2);
    });
  };

  mixer.update(0);
  vrm.update(0);

  const figure: AvatarFigure = {
    object: vrm.scene,
    get playing() {
      return waiting > 0;
    },
    update(dtSec) {
      mixer.update(dtSec);
      vrm.update(dtSec);
    },
    play(name) {
      waiting++;
      const run = queue.then(() => playNow(name));
      queue = run.then(
        () => {},
        () => {},
      );
      return run.finally(() => {
        waiting--;
      });
    },
    dispose() {
      mixer.stopAllAction();
      VRMUtils.deepDispose(vrm.scene);
    },
  };
  return figure;
}
