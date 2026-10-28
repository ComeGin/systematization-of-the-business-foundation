// 模型の three のシーン（spec §5・§6・§8・§9）。three を触るのはここと tools/ だけ。島が出すと決めたときだけ動的 import する。
// - glb（assets/diorama.glb）を読む。色は焼き込み（紙・木の色 × 陰影）で、光は環境光と暖色のランプ（影なし）。影は部品ごとの接地影の板（放射状）。
// - 粒は lib/particles.ts の状態機械を、anchor_<id> の間の放物線に置く（1 つの InstancedMesh）。色は段階（白・青・金）。
// - 持ち上げはばね（part_<id> を 0.12 上げ、shadow_<id> を薄く小さく）。ランプは 8 秒周期でわずかに揺らぎ、ポインターの方へ最大 4 度傾く。
// - frozen のときは粒を出さずに 1 枚だけ描く（ポスター・静止画の書き出し。tools/capture-stills.mjs）。
// perf: 実行時のシャドウマップは使わない。描画解像度は島が decideQuality で決めて resize に渡す。
import type * as Three from "three";
// motion の client.ts は React の部品も出すので、three の描画（と書き出しの道具）からはトークンだけを直接読む（avatar/lib/scroll-away.ts と同じ）
import { DURATION, easing } from "@/modules/motion/lib/tokens";
import { PARTS } from "./parts";
import { FLOWS } from "./flows";
import { createParticleSystem, STAGE_COLOR } from "./particles";
import type { Arrival } from "./particles";
import type { FlowId, PartId } from "./types";

export interface DioramaScene {
  render(dtMs: number): void;
  resize(width: number, height: number, dpr: number): void;
  setHover(part: PartId | null): void;
  /** カメラを部品へ寄せる（null で元の位置へ戻す）。DURATION.large・emphasized */
  focusPart(part: PartId | null): void;
  /** -0.5〜0.5（視差とランプの傾き） */
  setPointer(x: number, y: number): void;
  /** canvas 上の点（CSS px）の下にある、押せる部品。無ければ null */
  pick(x: number, y: number): PartId | null;
  /** anchor_<id> の canvas 上の位置（CSS px） */
  projectAnchors(): ReadonlyMap<
    PartId,
    { x: number; y: number; visible: boolean }
  >;
  dispose(): void;
}

export interface DioramaSceneOptions {
  glbUrl: string;
  /** glb のカメラのノード名（PAGE_VIEWS[page].camera） */
  camera: string;
  colors: { proposal: string; room: string };
  /** 粒を出さず 1 枚だけ描く（書き出し用。preserveDrawingBuffer） */
  frozen?: boolean;
  /**
   * 枠が設計より横長のとき、設計の画角をどこに置くか。center（既定）は中央、end は右端（左に文字を重ねるヒーロー）。
   * end のとき、設計の画角の左には同じ模型の続きが見える（ポスターは object-position: right で同じ位置に置く）
   */
  align?: "center" | "end";
  /** 承認台の横に立たせる代表のアバター（模型の中にアバターが写るページだけ。PAGE_VIEWS の showsAvatar） */
  avatar?: { modelUrl: string; idleUrl: string; nodUrl: string };
  /** 粒が区間の終点に着いた（承認台のうなずきなど。Task 9） */
  onArrival?: (arrival: Arrival) => void;
}

const LIFT = 0.12;
const LEG_MS = 1600;
// 流れごとの自動で生まれる間隔（ms）。問い合わせと改善の循環が、どれか 1 本はいつも見えている程度
const SPAWN_EVERY_MS: Partial<Record<FlowId, number>> = {
  inquiryForm: 5200,
  inquiryChat: 6400,
  article: 9000,
  improveSite: 7000,
  improveCrm: 11000,
  improveChat: 13000,
};
const MAX_PARTICLES = 48;
const LAMP_TILT_RAD = (4 * Math.PI) / 180;
/** 模型の中のアバターの大きさ（身長 約 1.6 → 約 0.9。承認台〈高さ 0.65〉より少し高い人形）と、承認台の方への向き */
const AVATAR_SCALE = 0.55;
const AVATAR_TURN = 0.35;

export async function createDioramaScene(
  THREE: typeof Three,
  canvas: HTMLCanvasElement,
  {
    glbUrl,
    camera: cameraName,
    colors,
    frozen = false,
    align = "center",
    avatar,
    onArrival,
  }: DioramaSceneOptions,
): Promise<DioramaScene> {
  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
    import("three/examples/jsm/loaders/GLTFLoader.js"),
    import("three/examples/jsm/libs/meshopt_decoder.module.js"),
  ]);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(glbUrl);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    preserveDrawingBuffer: frozen,
    powerPreference: "low-power",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(colors.room);
  scene.add(new THREE.HemisphereLight("#fff4e6", "#0a1f45", 1.6));
  const spot = new THREE.SpotLight("#ffd49a", 40, 14, Math.PI / 4.2, 0.65, 1.4);
  scene.add(spot, spot.target);
  scene.add(gltf.scene);

  // token: 接地影は放射状のグラデーション（glb の shadow_<id> の無地の板を置き換える）
  const shadowCanvas = document.createElement("canvas");
  shadowCanvas.width = shadowCanvas.height = 128;
  const g = shadowCanvas.getContext("2d");
  if (g) {
    const grd = g.createRadialGradient(64, 64, 8, 64, 64, 64);
    grd.addColorStop(0, "rgba(0,0,0,0.55)");
    grd.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
  }
  const shadowMat = new THREE.MeshBasicMaterial({
    map: new THREE.CanvasTexture(shadowCanvas),
    transparent: true,
    depthWrite: false,
  });

  const parts = new Map<PartId, Three.Object3D>();
  const shadows = new Map<PartId, Three.Object3D>();
  const anchors = new Map<PartId, Three.Object3D>();
  let lampPos = new THREE.Vector3(0, 3.3, 0);
  let screenMarker: Three.Object3D | null = null;
  gltf.scene.traverse((o) => {
    if (o.name.startsWith("part_")) parts.set(o.name.slice(5) as PartId, o);
    else if (o.name.startsWith("anchor_"))
      anchors.set(o.name.slice(7) as PartId, o);
    else if (o.name.startsWith("shadow_")) {
      o.traverse((m) => {
        if ((m as Three.Mesh).isMesh) (m as Three.Mesh).material = shadowMat;
      });
      shadows.set(o.name.slice(7) as PartId, o);
    } else if (o.name === "lamp")
      lampPos = o.getWorldPosition(new THREE.Vector3());
    else if (o.name === "site_screen_marker") screenMarker = o;
    if ((o as Three.Mesh).isMesh && /bulb|球/.test(o.name))
      (o as Three.Mesh).material = new THREE.MeshBasicMaterial({
        color: "#ffe2b0",
      });
  });
  // 代表のアバター（人形）を承認台の横（avatar_spot）に立たせる。読み込みに失敗しても模型は描く（承認台だけになる）
  let figure: import("@/modules/avatar/lib/figure").AvatarFigure | null = null;
  const standPoint = gltf.scene.getObjectByName("avatar_spot");
  if (avatar && standPoint) {
    try {
      const { createAvatarFigure } = await import("@/modules/avatar/lib/figure");
      figure = await createAvatarFigure(THREE, avatar);
      standPoint.getWorldPosition(figure.object.position);
      figure.object.scale.setScalar(AVATAR_SCALE);
      // VRM 0.x は rotateVRM0 で y に π 回してある（+Z〈手前〉を向く）。上書きせず、承認台の方へ少しだけ足す
      figure.object.rotation.y += AVATAR_TURN;
      scene.add(figure.object);
    } catch (error) {
      console.error("[diorama] 模型の中のアバターを読めませんでした", error);
    }
  }
  for (const id of Object.keys(PARTS) as PartId[])
    if (!parts.has(id)) throw new Error(`模型に part_${id} がありません`);

  const camSource = gltf.cameras.find(
    (c) => c.name === cameraName || c.parent?.name === cameraName,
  );
  if (!camSource || !(camSource as Three.PerspectiveCamera).isPerspectiveCamera)
    throw new Error(`模型にカメラ ${cameraName} がありません`);
  const camera = (camSource as Three.PerspectiveCamera).clone();
  // 設計の画角（Blender で決めた縦横比 designAspect と縦の画角 designFov）を、どの枠でも「収める」（contain）。
  // 枠が設計より縦長なら縦の画角を広げて横幅を保つ。ポスター（object-fit: contain）と同じ見え方になる（spec §9 の 1）
  const designAspect = (camSource as Three.PerspectiveCamera).aspect || 16 / 9;
  const designFov = (camSource as Three.PerspectiveCamera).fov;
  camSource.updateWorldMatrix(true, false);
  camSource.matrixWorld.decompose(
    camera.position,
    camera.quaternion,
    camera.scale,
  );
  const basePos = camera.position.clone();
  const baseQuat = camera.quaternion.clone();
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(baseQuat);
  const baseTarget = basePos
    .clone()
    .add(forward.multiplyScalar(basePos.length()));

  // 持ち上げのばね
  const springs = new Map<PartId, { y0: number; y: number; v: number }>();
  for (const [id, o] of parts)
    springs.set(id, { y0: o.position.y, y: 0, v: 0 });
  let hover: PartId | null = null;

  // 粒
  const particles = createParticleSystem({
    flows: FLOWS,
    legMs: LEG_MS,
    spawnEveryMs: frozen ? {} : SPAWN_EVERY_MS,
  });
  const dots = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.035, 12, 12),
    new THREE.MeshBasicMaterial({ toneMapped: false }),
    MAX_PARTICLES,
  );
  dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  dots.count = 0;
  scene.add(dots);
  const stageColor = {
    inflow: new THREE.Color(STAGE_COLOR.inflow),
    proposal: new THREE.Color(colors.proposal || STAGE_COLOR.proposal),
    approved: new THREE.Color(STAGE_COLOR.approved),
  };

  // 小さなサイトの画面の帯（金の粒が着いたら明るくして戻す）
  let flash = 0;
  const band = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 0.22),
    new THREE.MeshBasicMaterial({
      color: "#FFD27A",
      transparent: true,
      opacity: 0,
      toneMapped: false,
    }),
  );
  if (screenMarker) {
    const m = screenMarker as Three.Object3D;
    m.updateWorldMatrix(true, false);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    m.matrixWorld.decompose(pos, quat, scl);
    band.position
      .copy(pos)
      .add(new THREE.Vector3(0, 0, 0.012).applyQuaternion(quat));
    band.quaternion.copy(quat);
    band.scale.set(scl.x * 0.9, 1, 1);
    // glTF は Y 上なので、Blender の (幅, 厚み, 高さ) は (x, z, y) に来る。板は XY 面なので高さは scl.y か scl.z の大きい方
    band.scale.y = Math.max(scl.y, scl.z) * 0.9;
    scene.add(band);
  }

  const anchorPos = (id: PartId, out: Three.Vector3) => {
    const a = anchors.get(id);
    if (a) a.getWorldPosition(out);
    return out;
  };
  const from = new THREE.Vector3();
  const to = new THREE.Vector3();
  const tmp = new THREE.Matrix4();

  // カメラ: 視差と、部品へ寄る動き
  const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  const ease = easing("emphasized");
  const focus = {
    from: new THREE.Vector3(),
    to: new THREE.Vector3(),
    lookFrom: new THREE.Vector3(),
    lookTo: new THREE.Vector3(),
    t: 1,
    part: null as PartId | null,
  };
  const camPos = basePos.clone();
  const camLook = baseTarget.clone();
  const focusPose = (part: PartId | null) => {
    if (!part) return { pos: basePos.clone(), look: baseTarget.clone() };
    const look = anchorPos(part, new THREE.Vector3()).lerp(baseTarget, 0.4);
    return {
      pos: basePos
        .clone()
        .lerp(look, 0.3)
        .add(new THREE.Vector3(0, 0.3, 0)),
      look,
    };
  };

  const raycaster = new THREE.Raycaster();
  const touchables = [...parts].filter(([id]) => PARTS[id].touchable).map(([, o]) => o);
  let width = 1;
  let height = 1;
  let elapsed = 0;
  let frames = 0;

  const renderFrame = (dtMs: number) => {
    elapsed += dtMs;
    const dt = Math.min(0.05, dtMs / 1000);
    // ばね
    for (const [id, s] of springs) {
      if (id === "base") continue;
      const target = id === hover ? LIFT : 0;
      const a = (target - s.y) * 180 - s.v * 18;
      s.v += a * dt;
      s.y += s.v * dt;
      const o = parts.get(id);
      if (o) o.position.y = s.y0 + s.y;
      const sh = shadows.get(id);
      if (sh) {
        const f = 1 - s.y * 1.2;
        sh.scale.set(f, 1, f);
      }
    }
    // ランプの揺らぎと傾き
    pointer.sx += (pointer.x - pointer.sx) * 0.06;
    pointer.sy += (pointer.y - pointer.sy) * 0.06;
    const sway = Math.sin((elapsed / DURATION.ambient) * Math.PI * 2) * 0.05;
    spot.position.set(lampPos.x + sway, lampPos.y - 0.2, lampPos.z);
    spot.target.position.set(
      Math.tan(pointer.sx * 2 * LAMP_TILT_RAD) * lampPos.y,
      0,
      Math.tan(pointer.sy * 2 * LAMP_TILT_RAD) * lampPos.y,
    );
    spot.intensity = 40 * (0.96 + 0.04 * Math.sin(elapsed / 1300));
    // カメラ
    if (focus.t < 1) focus.t = Math.min(1, focus.t + dtMs / DURATION.large);
    const k = ease(focus.t);
    camPos.lerpVectors(focus.from, focus.to, k);
    camLook.lerpVectors(focus.lookFrom, focus.lookTo, k);
    camera.position
      .copy(camPos)
      .add(new THREE.Vector3(pointer.sx * 0.3, -pointer.sy * 0.2, 0));
    camera.lookAt(camLook);
    // 粒
    if (!frozen) {
      const list = particles.step(dtMs);
      for (const a of particles.arrivals()) {
        if (a.part === "site" && a.stage === "approved") flash = 1;
        // 承認の身ぶり: 提案の粒が承認台に着いたら、代表がうなずく（spec §5.2。その粒は承認台を出るときに金色になる）
        if (a.part === "approval") figure?.nod();
        onArrival?.(a);
      }
      let n = 0;
      for (const p of list) {
        if (n >= MAX_PARTICLES) break;
        const route = FLOWS[p.flow];
        anchorPos(route[p.step].part, from);
        anchorPos(route[p.step + 1].part, to);
        const e = p.t < 0.5 ? 2 * p.t * p.t : 1 - (-2 * p.t + 2) ** 2 / 2;
        const pos = from.clone().lerp(to, e);
        pos.y += Math.sin(e * Math.PI) * from.distanceTo(to) * 0.35;
        tmp.makeTranslation(pos.x, pos.y, pos.z);
        dots.setMatrixAt(n, tmp);
        dots.setColorAt(n, stageColor[p.stage]);
        n++;
      }
      dots.count = n;
      dots.instanceMatrix.needsUpdate = true;
      if (dots.instanceColor) dots.instanceColor.needsUpdate = true;
      flash = Math.max(0, flash - dtMs / DURATION.medium / 2);
      (band.material as Three.MeshBasicMaterial).opacity = flash * 0.85;
    }
    figure?.update(frozen ? 0 : dt);
    renderer.render(scene, camera);
    frames++;
    canvas.dataset.frame = String(frames);
  };

  focus.from.copy(basePos);
  focus.to.copy(basePos);
  focus.lookFrom.copy(baseTarget);
  focus.lookTo.copy(baseTarget);

  return {
    render: renderFrame,
    resize(w, h, dpr) {
      width = Math.max(1, w);
      height = Math.max(1, h);
      renderer.setPixelRatio(dpr);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.clearViewOffset();
      if (align === "end" && camera.aspect > designAspect) {
        // 設計の画角（幅 frameW）を右端に置く: 中心が右端から frameW/2 の位置に来る大きな仮想の画面を作り、その左から width 分を描く
        const frameW = height * designAspect;
        const fullW = 2 * (width - frameW / 2);
        camera.aspect = fullW / height;
        camera.setViewOffset(fullW, height, 0, 0, width, height);
      }
      camera.fov =
        camera.aspect >= designAspect
          ? designFov
          : (2 *
              Math.atan(
                Math.tan((designFov * Math.PI) / 360) *
                  (designAspect / camera.aspect),
              ) *
              180) /
            Math.PI;
      camera.updateProjectionMatrix();
    },
    setHover(part) {
      hover = part && PARTS[part].touchable ? part : null;
    },
    focusPart(part) {
      if (part === focus.part && focus.t >= 1) return;
      const pose = focusPose(part);
      focus.from.copy(camPos);
      focus.lookFrom.copy(camLook);
      focus.to.copy(pose.pos);
      focus.lookTo.copy(pose.look);
      focus.t = 0;
      focus.part = part;
    },
    setPointer(x, y) {
      pointer.x = Math.max(-0.5, Math.min(0.5, x));
      pointer.y = Math.max(-0.5, Math.min(0.5, y));
    },
    pick(x, y) {
      raycaster.setFromCamera(new THREE.Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1), camera);
      const hit = raycaster.intersectObjects(touchables, true)[0];
      let o: Three.Object3D | null = hit?.object ?? null;
      while (o && !o.name.startsWith("part_")) o = o.parent;
      return o ? (o.name.slice(5) as PartId) : null;
    },
    projectAnchors() {
      const out = new Map<PartId, { x: number; y: number; visible: boolean }>();
      const v = new THREE.Vector3();
      for (const [id, a] of anchors) {
        a.getWorldPosition(v);
        v.project(camera);
        out.set(id, {
          x: ((v.x + 1) / 2) * width,
          y: ((1 - v.y) / 2) * height,
          visible: v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1,
        });
      }
      return out;
    },
    dispose() {
      figure?.dispose();
      renderer.dispose();
      scene.traverse((o) => {
        const mesh = o as Three.Mesh;
        if (mesh.isMesh) {
          mesh.geometry.dispose();
          const mats = Array.isArray(mesh.material)
            ? mesh.material
            : [mesh.material];
          for (const m of mats) m.dispose();
        }
      });
    },
  };
}
