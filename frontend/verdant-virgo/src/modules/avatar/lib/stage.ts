// アバターの three.js の描画（AvatarStage の island が、出すと決めたときにだけ動的 import する。§7.3）。
// perf: three は loadThree()（motion/lib/three.ts）が読んだものを引数で受ける。このファイルから three を値として import しない（R9）。
//       GLTFLoader と three-vrm は three を静的に import するが、ビルドでは loadThree() と同じ three のチャンクを指す
//       （`rg -l "isWebGLRenderer" dist/_astro` が 1 本のまま。e2e の motion-vivid が確かめる）。
//       この部品と GLTFLoader・three-vrm は、アバターを出すときだけ読む（reduced-motion・Mobile の最初・C のページでは読まない）。
// 描画:
//   - 基本の姿勢は 2 つ（2026-10-20 の裁定 R20）。直立（stand）＝待機（idle＝BreathingIdle）のクリップの最初の 1 フレームで止めた姿勢、
//     呼吸（breathe）＝待機のクリップのループ。最初は直立で、しばらく操作が無いと rest(true) で呼吸へ、操作があると rest(false) で直立へ戻る。
//     呼吸は最初のフレーム（＝直立と同じ姿勢）から始めるので、直立から呼吸へは継ぎ目なくつながる。
//   - エモートは 1 回だけ再生して crossFadeTo で基本の姿勢に戻す。再生中に次のエモートが来たら、いまのエモートから直に切り替える。
//     エモートのクリップは初めて使うときに fetch する（idle と greeting はモデルと一緒に先に読む）。
//   - hitTest は、骨を線分（太さのあるカプセル）に見立てて、画面の座標がアバターの体に掛かっているかを返す（クリック・ホイールを受けるかの判定）。
//     canvas の透明な余白の下のリンクを塞がないため。骨の位置は最後に描いた姿勢のもの。
//   - setZoom は、枠の拡大（CSS の scale）に合わせて描画の解像度を上げる（拡大してもぼやけないように）。
//   - まばたき（表情 blink）と視線（lookAt）はコードで動かす。視線は A（vivid）でポインターを追い、B（calm）は正面（カメラ）を見る。
//   - rAF は setActive(true) の間だけ回す。止めると、まばたき・呼吸を含めて最後の姿勢のまま止まる（2.2.2）。
// a11y: canvas は呼ぶ側が aria-hidden を付ける（アバターはサイトの情報を持たない）。明滅は作らない（まばたきは目の形の変化で、画面の明るさを変えない）。
import type * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  VRMLoaderPlugin,
  VRMUtils,
  type VRM,
  type VRMHumanBoneName,
} from "@pixiv/three-vrm";
import type { LiveZone } from "@/modules/motion/client";
// motion/client は React の部品も出すので、描画の部品からは tokens を直に読む（React を引き込まない）
import { DURATION } from "@/modules/motion/lib/tokens";
import { toAnimationClip } from "./clip";
import type { EmoteId, MotionClipJson } from "./types";

export type ClipName = EmoteId | "idle";

/** カメラの画角。full＝全身（ドックと静止画）、face＝顔のアップ（たたんだときのアイコン） */
export type Framing = "full" | "face";

export interface AvatarRuntimeOptions {
  three: typeof import("three");
  canvas: HTMLCanvasElement;
  zone: LiveZone;
  modelUrl: string;
  motionUrls: Record<ClipName, string>;
  framing?: Framing;
  /** 静止画を撮るとき（capture-stills）だけ true。描いた絵を toDataURL・スクリーンショットで読めるようにする */
  preserveDrawingBuffer?: boolean;
}

export interface AvatarRuntime {
  /** rAF を回すか。false の間は 1 枚も描かない（最後の姿勢のまま） */
  setActive(active: boolean): void;
  /** エモートを 1 回再生して基本の姿勢に戻す。クリップが読めなければ false */
  play(emote: EmoteId): Promise<boolean>;
  /** 基本の姿勢を切り替える。true＝呼吸（BreathingIdle のループ）、false＝直立。エモートの再生中なら、終わったときにその姿勢へ戻る */
  rest(resting: boolean): void;
  /** 画面の座標（clientX・clientY）がアバターの体に掛かっているか */
  hitTest(x: number, y: number): boolean;
  /** 枠の拡大率（CSS の scale）。描画の解像度を合わせる */
  setZoom(zoom: number): void;
  /** いまの姿勢で 1 枚だけ描く（止めたまま出すとき・静止画を撮るとき） */
  renderOnce(): void;
  dispose(): void;
}

/** 待機とエモートのつなぎ（秒）。★ 0.3 秒。トークンの medium（320ms）に合わせる */
const FADE_S = DURATION.medium / 1000;
/** 1 フレームの経過の上限（秒）。タブを戻したときなどに揺れもの（springBone）が跳ねないようにする */
const MAX_DELTA_S = 1 / 20;
/** カメラの縦の画角（度） */
const FOV = 30;
/** まばたきの間隔（秒）と、閉じて開くまでの長さ（秒）。明るさの変化ではないので 2.3.1 の対象外 */
const BLINK_EVERY_S: readonly [number, number] = [2.5, 6];
const BLINK_LENGTH_S = 0.16;
/** 視線の追いつく速さ（1 秒あたりの割合の指数） */
const LOOK_FOLLOW = 6;
/** 描画の解像度（devicePixelRatio × 拡大率）の上限。拡大しても GPU の負荷を上げすぎない */
const MAX_PIXEL_RATIO = 3;

/** 当たり判定の骨の並び（線分でつなぐ）と太さ（半径。m） */
const HIT_CHAINS: readonly {
  bones: readonly VRMHumanBoneName[];
  radius: number;
}[] = [
  { bones: ["hips", "spine", "chest", "neck"], radius: 0.13 },
  { bones: ["leftUpperArm", "leftLowerArm", "leftHand"], radius: 0.06 },
  { bones: ["rightUpperArm", "rightLowerArm", "rightHand"], radius: 0.06 },
  { bones: ["leftUpperLeg", "leftLowerLeg", "leftFoot"], radius: 0.08 },
  { bones: ["rightUpperLeg", "rightLowerLeg", "rightFoot"], radius: 0.08 },
];
/** 頭は頭の骨（首の付け根）の少し上を中心にした円（m） */
const HIT_HEAD_LIFT = 0.1;
const HIT_HEAD_RADIUS = 0.14;
/** 当たり判定の遊び（px）。体の縁ぎりぎりでも押せるようにする */
const HIT_SLOP_PX = 4;

/** 点 p から線分 ab までの距離 */
function distanceToSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t =
    length2 === 0
      ? 0
      : Math.min(
          Math.max(((p.x - a.x) * dx + (p.y - a.y) * dy) / length2, 0),
          1,
        );
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

async function fetchClip(url: string): Promise<MotionClipJson> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`clip ${response.status}`);
  return (await response.json()) as MotionClipJson;
}

export async function createAvatarRuntime({
  three,
  canvas,
  zone,
  modelUrl,
  motionUrls,
  framing = "full",
  preserveDrawingBuffer = false,
}: AvatarRuntimeOptions): Promise<AvatarRuntime> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  // モデルと、最初に使う 2 本（待機・手を振る）を一緒に読む
  const [gltf, idleJson, greetingJson] = await Promise.all([
    loader.loadAsync(modelUrl),
    fetchClip(motionUrls.idle),
    fetchClip(motionUrls.greeting),
  ]);
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new Error("VRM ではない");

  // perf: 使わない頂点・骨を落とし、骨格を 1 つにまとめる（three-vrm のサンプルと同じ下ごしらえ）
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  // VRM 0.x は後ろ向きなので、カメラ（+Z）の方へ向ける
  VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse((object) => {
    object.frustumCulled = false;
  });

  const scene = new three.Scene();
  scene.add(vrm.scene);
  // 光は白（three の既定の色）。MToon は光の向きで影を付ける
  const sun = new three.DirectionalLight(undefined, Math.PI);
  sun.position.set(0.5, 1.5, 2);
  scene.add(sun);
  scene.add(new three.AmbientLight(undefined, 0.6));

  const renderer = new three.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "low-power",
    preserveDrawingBuffer,
  });
  renderer.setClearAlpha(0);
  const basePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(basePixelRatio);

  const camera = new three.PerspectiveCamera(FOV, 1, 0.05, 20);

  // 腰の高さ（Mixamo の位置の縮尺の基準。サンプルと同じく、腰の正規化された骨とモデルの根の高さの差）
  const vec = new three.Vector3();
  const hipsNode = vrm.humanoid.getNormalizedBoneNode("hips");
  const vrmHipsHeight = hipsNode
    ? Math.abs(
        hipsNode.getWorldPosition(vec).y -
          vrm.scene.getWorldPosition(new three.Vector3()).y,
      )
    : 1;
  const clipTarget = {
    humanoid: vrm.humanoid,
    meta: { metaVersion: vrm.meta.metaVersion },
  };
  const toClip = (json: MotionClipJson) =>
    toAnimationClip(three, json, clipTarget, vrmHipsHeight);

  // 基本の姿勢。直立は待機のクリップの最初の 1 フレームだけを切り出し、1 回再生して止めたまま（長さ 0 のクリップをループさせない）
  const mixer = new three.AnimationMixer(vrm.scene);
  const idleClip = toClip(idleJson);
  const breathe = mixer.clipAction(idleClip);
  const stand = mixer.clipAction(
    three.AnimationUtils.subclip(idleClip, "stand", 0, 1, idleJson.fps),
  );
  stand.setLoop(three.LoopOnce, 1);
  stand.clampWhenFinished = true;
  stand.play();
  let base = stand;
  mixer.update(0);
  vrm.update(0);

  // 画角: 全身は、足元に体の高さの 3%、頭の上に両手を上げた手（手を振る）が入る余白を取って、体の高さの 1.25 倍が縦に収まる距離。顔は頭の骨の少し上を中心に 0.36m 四方
  const fit = () => {
    const tan = Math.tan(three.MathUtils.degToRad(FOV / 2));
    if (framing === "face") {
      const head = vrm.humanoid.getNormalizedBoneNode("head");
      const center = head
        ? head.getWorldPosition(new three.Vector3())
        : new three.Vector3(0, 1.4, 0);
      center.y += 0.08;
      const span = 0.36;
      camera.position.set(center.x, center.y, center.z + span / (2 * tan));
      camera.lookAt(center);
      return;
    }
    const box = new three.Box3().setFromObject(vrm.scene);
    const height = box.max.y - box.min.y;
    const span = height * 1.25;
    const centerY = box.min.y - height * 0.03 + span / 2;
    camera.position.set(0, centerY, span / (2 * tan));
    camera.lookAt(0, centerY, 0);
  };
  fit();

  const resize = () => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  resize();
  const resizeObserver =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
  resizeObserver?.observe(canvas);

  // 視線。A はポインターを追い、B は正面（カメラ）を見る
  const lookTarget = new three.Object3D();
  const lookGoal = new three.Vector3();
  scene.add(lookTarget);
  const facing = () => lookGoal.copy(camera.position);
  facing();
  lookTarget.position.copy(lookGoal);
  if (vrm.lookAt) {
    vrm.lookAt.target = lookTarget;
    vrm.lookAt.autoUpdate = true;
  }
  const onPointerMove = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.height === 0) return;
    // 画面のずれ（px）を、モデルのある面（z=0）での距離（m）に直し、カメラとモデルの間に置いた目標へ写す
    const metersPerPx =
      (2 * camera.position.z * Math.tan(three.MathUtils.degToRad(FOV / 2))) /
      rect.height;
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 3);
    lookGoal.set(
      dx * metersPerPx,
      camera.position.y - dy * metersPerPx,
      camera.position.z * 0.6,
    );
  };
  if (zone === "vivid" && framing === "full")
    window.addEventListener("pointermove", onPointerMove, { passive: true });

  // まばたき
  let blinkWait = BLINK_EVERY_S[0];
  let blinkTime = -1;
  const blink = (delta: number) => {
    const expressions = vrm.expressionManager;
    if (!expressions) return;
    if (blinkTime < 0) {
      blinkWait -= delta;
      if (blinkWait > 0) return;
      blinkTime = 0;
    }
    blinkTime += delta;
    const progress = blinkTime / BLINK_LENGTH_S;
    if (progress >= 1) {
      expressions.setValue("blink", 0);
      blinkTime = -1;
      blinkWait =
        BLINK_EVERY_S[0] +
        Math.random() * (BLINK_EVERY_S[1] - BLINK_EVERY_S[0]);
      return;
    }
    expressions.setValue("blink", Math.sin(Math.PI * progress));
  };

  // エモート
  const clips = new Map<ClipName, Promise<THREE.AnimationClip>>([
    ["greeting", Promise.resolve(toClip(greetingJson))],
  ]);
  const clipOf = (name: EmoteId) => {
    let clip = clips.get(name);
    if (!clip) {
      clip = fetchClip(motionUrls[name]).then(toClip);
      // 失敗したら覚えない（次の合図で読み直す）
      clip.catch(() => clips.delete(name));
      clips.set(name, clip);
    }
    return clip;
  };
  let current: { action: THREE.AnimationAction; returning: boolean } | null =
    null;
  /** from から to へつなぐ。to は最初から（直立は 1 フレームなので、いつも同じ姿勢。呼吸は直立と同じ姿勢から始まる） */
  const fadeTo = (from: THREE.AnimationAction, to: THREE.AnimationAction) => {
    to.reset();
    to.setEffectiveTimeScale(1);
    to.setEffectiveWeight(1);
    to.play();
    from.crossFadeTo(to, FADE_S, false);
  };
  /** エモートが終わる前に基本の姿勢へ戻し始める */
  const returnToBase = () => {
    if (!current || current.returning) return;
    current.returning = true;
    fadeTo(current.action, base);
  };
  const playing = () => current !== null && !current.returning;

  // 当たり判定（骨を画面の座標に写す）
  const projected = new three.Vector3();
  const toScreen = (node: THREE.Object3D, rect: DOMRect, lift = 0) => {
    node.getWorldPosition(projected);
    projected.y += lift;
    projected.project(camera);
    return {
      x: rect.left + ((projected.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - projected.y) / 2) * rect.height,
    };
  };
  const hitTest = (x: number, y: number) => {
    // getBoundingClientRect は枠の拡大（CSS の scale）を含むので、拡大しても同じ式で写せる
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom)
      return false;
    const pxPerMeter =
      rect.height /
      (2 * camera.position.z * Math.tan(three.MathUtils.degToRad(FOV / 2)));
    const point = { x, y };
    const head = vrm.humanoid.getRawBoneNode("head");
    if (head) {
      const center = toScreen(head, rect, HIT_HEAD_LIFT);
      if (
        Math.hypot(x - center.x, y - center.y) <=
        HIT_HEAD_RADIUS * pxPerMeter + HIT_SLOP_PX
      )
        return true;
    }
    for (const chain of HIT_CHAINS) {
      const reach = chain.radius * pxPerMeter + HIT_SLOP_PX;
      const points = chain.bones
        .map((name) => vrm.humanoid.getRawBoneNode(name))
        .filter((node): node is THREE.Object3D => node !== null)
        .map((node) => toScreen(node, rect));
      for (let i = 1; i < points.length; i++) {
        if (distanceToSegment(point, points[i - 1]!, points[i]!) <= reach)
          return true;
      }
    }
    return false;
  };

  const step = (delta: number) => {
    mixer.update(delta);
    if (
      playing() &&
      current!.action.time >= current!.action.getClip().duration - FADE_S
    ) {
      returnToBase();
    }
    blink(delta);
    lookTarget.position.lerp(lookGoal, 1 - Math.exp(-delta * LOOK_FOLLOW));
    if (zone === "calm" || framing === "face") facing();
    vrm.update(delta);
    renderer.render(scene, camera);
  };

  // 経過は rAF の時刻から求める（止めていた間の時間は進めない）
  let rafId = 0;
  let active = false;
  let lastTime: number | null = null;
  const frame = (time: number) => {
    if (!active) return;
    rafId = requestAnimationFrame(frame);
    const delta = lastTime === null ? 0 : (time - lastTime) / 1000;
    lastTime = time;
    step(Math.min(Math.max(delta, 0), MAX_DELTA_S));
  };

  return {
    setActive(next) {
      if (next === active) return;
      active = next;
      if (active) {
        // 止めていた間の時間を進めない（再開したところから続ける）
        lastTime = null;
        rafId = requestAnimationFrame(frame);
      } else {
        cancelAnimationFrame(rafId);
      }
    },
    async play(emote) {
      let clip: THREE.AnimationClip;
      try {
        clip = await clipOf(emote);
      } catch {
        return false;
      }
      const action = mixer.clipAction(clip);
      // 再生中のエモートがあれば、そこから直に切り替える（基本の姿勢を挟まない）
      const from =
        playing() && current!.action !== action ? current!.action : base;
      action.setLoop(three.LoopOnce, 1);
      action.clampWhenFinished = true;
      fadeTo(from, action);
      current = { action, returning: false };
      return true;
    },
    rest(resting) {
      const next = resting ? breathe : stand;
      if (next === base) return;
      const previous = base;
      base = next;
      // エモートの再生中は、終わったときに新しい姿勢へ戻る（いまの見た目は変えない）
      if (!playing()) fadeTo(previous, next);
    },
    hitTest,
    setZoom(zoom) {
      const ratio = Math.min(
        basePixelRatio * Math.max(zoom, 1),
        MAX_PIXEL_RATIO,
      );
      if (ratio === renderer.getPixelRatio()) return;
      // setPixelRatio は描画の領域を作り直して消すので、止めている間は 1 枚描き直す
      renderer.setPixelRatio(ratio);
      resize();
      if (!active) renderer.render(scene, camera);
    },
    renderOnce() {
      step(0);
    },
    dispose() {
      active = false;
      cancelAnimationFrame(rafId);
      resizeObserver?.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      mixer.stopAllAction();
      VRMUtils.deepDispose(vrm.scene);
      renderer.dispose();
    },
  };
}
