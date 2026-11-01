// アトリエの three のシーン（spec §5・§6・§9）。three を触るのはここと tools/ だけ。島が出すと決めたときだけ動的 import する。
// - glb（assets/atelier.glb）を読む。色は焼き込み（素材の色 × AO）で、光は時間帯ごとの実時間の光（PHASE_LIGHTS。焼くと glb が時間帯の数だけ要る）。
// - 空: 朝・昼・夕方は equirect の画像を背景と映り込みに、夜は紺の背景に、決まった種で並べた星と淡い天の川を点で描く（spec §5.3）。
//   星はゆっくりまたたく（周期は 2 秒より十分長い。1 秒に 3 回を超えて点滅させない。2.3.1）。
// - カメラ: "walk" は道のレールの上の一人称（setWalk）、cam_* は glb のカメラ（下層ページの静止画）。どちらも設計の画角（16:9）を枠に
//   「敷き詰める」（cover。ポスターの object-fit: cover と同じ切り取り方。spec §9 の 1）。
// - frozen のときは 1 枚だけ描く（ポスター・静止画の書き出し。tools/capture-stills.mjs）。
// perf: 実行時のシャドウマップは使わない。描画解像度は島が decideQuality で決めて resize に渡す。
import type * as Three from "three";
// motion の client.ts は React の部品も出すので、three の描画（と書き出しの道具）からはトークンだけを直接読む
import { DURATION, easing } from "@/modules/motion/lib/tokens";
import type { AvatarFigure, AvatarFigureOptions } from "@/modules/avatar/lib/figure";
import { PROPS } from "./props";
import { createRail, LEFT_LANE_DX, type Rail } from "./route";
import { PHASE_LIGHTS } from "./sky";
import type { MotionName, Phase, PropId } from "./types";
import { disposeMaterial } from "./dispose";
import { frameUvs } from "./frame-uv";

export type AtelierCamera = `cam_${string}` | "walk";
export type PickId = PropId | `frame:${number}`;

export interface AtelierScene {
  render(dtMs: number): void;
  resize(width: number, height: number, dpr: number): void;
  /** レールの位置（0〜1）と視線の左右（-1〜1） */
  /** lane: 0＝右の道・1＝左の道（既定 0。lib/route.ts） */
  setWalk(t: number, look: number, lane?: number): void;
  /** 縁の光（置き物が少し明るくなる） */
  setHover(id: PickId | null): void;
  /** 押せるもの（置き物の anchor_<id>・額の中心）の canvas 上の位置（CSS px） */
  projectAnchors(): ReadonlyMap<
    PickId,
    { x: number; y: number; visible: boolean }
  >;
  /** canvas 上の点（CSS px）の下にある、押せるもの。無ければ null */
  pick(x: number, y: number): PickId | null;
  /** カメラを glb のカメラへ動かす（Task 8 で補間にする）。ms が 0 なら一瞬で */
  flyTo(camera: `cam_${string}`, ms: number): Promise<void>;
  /** 描くカメラを替える（書き出しの道具が 1 つのシーンで何枚も撮るため） */
  setCamera(camera: AtelierCamera): void;
  /** glb の rail_NN と anchor_<id> から作った道（歩く仕組みが読む） */
  readonly rail: Rail;
  /** 代表のアバター（spec §6.4）。立つまでは null */
  readonly avatar: { play(name: MotionName): Promise<void>; readonly playing: boolean } | null;
  /** アバターが立ったら true、立たなかったら（渡されていない・読めない）false で解決する */
  readonly avatarReady: Promise<boolean>;
  dispose(): void;
}

export interface AtelierSceneOptions {
  glbUrl: string;
  /** 朝・昼・夕方の空（equirect）。夜は描くので要らない */
  skyUrls: Partial<Record<Phase, string>>;
  phase: Phase;
  camera: AtelierCamera;
  /** 1 枚だけ描く（書き出し用。preserveDrawingBuffer） */
  frozen?: boolean;
  /** 額の板 frame_00〜06 に貼る絵（Task 6。null は無地） */
  frameTextures?: readonly (HTMLCanvasElement | null)[];
  avatar?: AvatarFigureOptions;
}

/** 視線の左右の振れ幅（spec §6.2「わずかに」） */
const LOOK_MAX_RAD = (12 * Math.PI) / 180;
/** 目線の上下（1m 先で何 m 上を見るか）。天窓の空（夜は星空）が画面の上の 3 分の 1 に入る（spec §5.3） */
const LOOK_PITCH = 0.1;
/** 一人称のカメラが先を見る距離（レールの割合） */
const LOOK_AHEAD = 0.05;

/** 画面の光り方（時間帯ごと。夜は画面の明かりが灯る。spec §5.3） */
const SCREEN_GLOW: Record<Phase, number> = {
  morning: 0.35,
  day: 0.3,
  dusk: 0.9,
  night: 1.5,
};
/** 壁・天井のコンクリートの色味（テクスチャに掛ける） */
const CONCRETE_TINT = "#f3e9dc";
/** 星の数・天の川の点の数 */
const STARS = 2200;
const MILKY_WAY = 2600;

function makeStars(THREE: typeof Three, pixelRatio: number) {
  // 決まった種の乱数（毎回同じ星空。ポスターと立体の絵をそろえる）
  let seed = 20261029;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const n = STARS + MILKY_WAY;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const phase = new Float32Array(n);
  const tilt = 0.85;
  for (let i = 0; i < n; i++) {
    const band = i >= STARS;
    // 天球の上半分（天窓から見える側）。天の川は傾けた大円の周りに寄せる
    let x: number, y: number, z: number;
    if (band) {
      const a = rnd() * Math.PI * 2;
      const spread = (rnd() + rnd() + rnd() - 1.5) * 0.16;
      x = Math.cos(a);
      y = spread;
      z = Math.sin(a);
      const y2 = y * Math.cos(tilt) - x * Math.sin(tilt);
      x = y * Math.sin(tilt) + x * Math.cos(tilt);
      y = y2;
    } else {
      const u = rnd() * 2 - 1;
      const a = rnd() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      x = s * Math.cos(a);
      y = u;
      z = s * Math.sin(a);
    }
    if (y < 0.08) y = Math.abs(y) + 0.08;
    const r = 120;
    pos.set([x * r, y * r, z * r], i * 3);
    const b = band ? 0.35 + rnd() * 0.4 : 0.7 + rnd() * 0.3;
    const warm = rnd();
    col.set([b * (0.82 + 0.18 * warm), b * (0.88 + 0.08 * warm), b], i * 3);
    size[i] = band ? 0.7 + rnd() * 0.9 : 1.0 + Math.pow(rnd(), 7) * 4.5;
    phase[i] = rnd() * Math.PI * 2;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geometry.setAttribute("size", new THREE.BufferAttribute(size, 1));
  geometry.setAttribute("phase", new THREE.BufferAttribute(phase, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { time: { value: 0 }, pixelRatio: { value: pixelRatio } },
    // a11y: またたきの周期は 2π/0.45 ≒ 14 秒（2.3.1 の「1 秒に 3 回」に遠く届かない）。明るさの揺れは 25% まで
    vertexShader: `
      attribute float size; attribute vec3 color; attribute float phase;
      uniform float time; uniform float pixelRatio;
      varying vec3 vColor; varying float vTwinkle;
      void main() {
        vColor = color;
        vTwinkle = 0.75 + 0.25 * sin(time * 0.45 + phase);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = size * pixelRatio * 2.2;
      }`,
    fragmentShader: `
      varying vec3 vColor; varying float vTwinkle;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor * vTwinkle, a);
      }`,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = -1;
  return { points, material };
}

export async function createAtelierScene(
  THREE: typeof Three,
  canvas: HTMLCanvasElement,
  {
    glbUrl,
    skyUrls,
    phase,
    camera: cameraName,
    frozen = false,
    frameTextures = [],
    avatar,
  }: AtelierSceneOptions,
): Promise<AtelierScene> {
  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
    import("three/examples/jsm/loaders/GLTFLoader.js"),
    import("three/examples/jsm/libs/meshopt_decoder.module.js"),
  ]);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const light = PHASE_LIGHTS[phase];
  const skyUrl = light.skyUrlKey ? skyUrls[light.skyUrlKey] : undefined;
  const [gltf, skyTexture] = await Promise.all([
    loader.loadAsync(glbUrl),
    skyUrl
      ? new THREE.TextureLoader().loadAsync(skyUrl)
      : Promise.resolve(null),
  ]);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    preserveDrawingBuffer: frozen,
    powerPreference: "high-performance",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = light.exposure;
  const scene = new THREE.Scene();
  scene.add(gltf.scene);

  // 空と映り込み
  let stars: ReturnType<typeof makeStars> | null = null;
  if (skyTexture) {
    skyTexture.mapping = THREE.EquirectangularReflectionMapping;
    skyTexture.colorSpace = THREE.SRGBColorSpace;
    scene.background = skyTexture;
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromEquirectangular(skyTexture).texture;
    scene.environmentIntensity = 0.55;
    pmrem.dispose();
  } else {
    scene.background = new THREE.Color("#040816");
  }
  if (light.starfield) {
    stars = makeStars(THREE, Math.min(2, window.devicePixelRatio || 1));
    scene.add(stars.points);
  }

  // 光（時間帯ごと）
  scene.add(
    new THREE.HemisphereLight(
      light.hemi.sky,
      light.hemi.ground,
      light.hemi.intensity,
    ),
  );
  if (light.sun) {
    const sun = new THREE.DirectionalLight(
      light.sun.color,
      light.sun.intensity,
    );
    const [dx, dy, dz] = light.sun.dir;
    sun.position.set(-dx * 20, -dy * 20, -dz * 20);
    scene.add(sun, sun.target);
  }

  // glb の約束のノード（計画 Task 2 の Produces）
  const anchors = new Map<PickId, Three.Object3D>();
  const props = new Map<PropId, Three.Object3D>();
  const frames: Three.Mesh[] = [];
  const rails: Three.Object3D[] = [];
  const hoverMats = new Map<PickId, Three.MeshStandardMaterial[]>();
  gltf.scene.traverse((o) => {
    if (o.name.startsWith("anchor_")) anchors.set(o.name.slice(7) as PropId, o);
    else if (o.name.startsWith("prop_") && !o.name.endsWith("_mesh"))
      props.set(o.name.slice(5) as PropId, o);
    else if (/^frame_\d+$/.test(o.name) && (o as Three.Mesh).isMesh)
      frames[Number(o.name.slice(6))] = o as Three.Mesh;
    else if (/^rail_\d+$/.test(o.name)) rails.push(o);
    else if (/^lamp_\d+$/.test(o.name) && light.lamps > 0) {
      const lamp = new THREE.PointLight("#ffc98a", light.lamps, 10, 2);
      o.getWorldPosition(lamp.position);
      scene.add(lamp);
    } else if (/^screen_\d+$/.test(o.name) && (o as Three.Mesh).isMesh) {
      const m = (o as Three.Mesh).material as Three.MeshStandardMaterial;
      m.emissiveIntensity = SCREEN_GLOW[phase];
    } else if ((o as Three.Mesh).isMesh && /^concrete/.test(((o as Three.Mesh).material as Three.Material).name)) {
      // 壁・天井のコンクリートは、テクスチャのままだと緑がかった灰色に見える。少し暖かく、明るくする（焼き込みの AO はそのまま）
      ((o as Three.Mesh).material as Three.MeshStandardMaterial).color.set(CONCRETE_TINT);
    } else if (o.name === "skylight_glass" && (o as Three.Mesh).isMesh) {
      const m = (o as Three.Mesh).material as Three.MeshStandardMaterial;
      m.transparent = true;
      m.depthWrite = false;
    } else if (o.name === "thanks_tea") {
      o.visible = cameraName === "cam_contactThanks";
    }
  });
  for (const id of Object.keys(PROPS) as PropId[])
    if (!props.has(id)) throw new Error(`アトリエに prop_${id} がありません`);
  // 縁の光: 置き物ごとに素材を複製して emissive を上げる（ほかの置き物と素材を共有しないように）
  const glow = new THREE.Color(
    getComputedStyle(document.documentElement)
      .getPropertyValue("--atelier-glow")
      .trim() || "#ffd7a1",
  );
  for (const [id, o] of props) {
    const mats: Three.MeshStandardMaterial[] = [];
    o.traverse((m) => {
      const mesh = m as Three.Mesh;
      if (!mesh.isMesh || /^screen_/.test(mesh.name)) return;
      const mat = (mesh.material as Three.MeshStandardMaterial).clone();
      mat.emissive = glow.clone();
      mat.emissiveIntensity = 0;
      mesh.material = mat;
      mats.push(mat);
    });
    hoverMats.set(id, mats);
  }
    frames.forEach((f, i) => {
    // 板の UV を、世界の向き（見る人の左→右・下→上）で 0〜1 に張り直す（lib/frame-uv.ts。glb の板は XZ 平面を回して立てているので、
    // ローカルの x・y では高さを見落として額が空白になった。2026-10-29）
    const geo = f.geometry;
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    f.updateWorldMatrix(true, false);
    geo.setAttribute("uv", new THREE.BufferAttribute(frameUvs(THREE, geo, f.matrixWorld), 2));
    // 押す点は板の中心（外形の中心）
    const center = new THREE.Object3D();
    bb.getCenter(center.position);
    f.add(center);
    anchors.set(`frame:${i}`, center);
    const tex = frameTextures[i];
    const mat = (f.material as Three.MeshStandardMaterial).clone();
    if (tex) {
      const map = new THREE.CanvasTexture(tex);
      map.colorSpace = THREE.SRGBColorSpace;
            map.anisotropy = 4;
      mat.map = map;
      mat.color.set("#ffffff");
    }
    mat.emissive = glow.clone();
    mat.emissiveIntensity = 0;
    f.material = mat;
    hoverMats.set(`frame:${i}`, [mat]);
  });

  rails.sort((a, b) => a.name.localeCompare(b.name));
  const v = new THREE.Vector3();
  const railPoints = rails.map(
    (r) => r.getWorldPosition(v).toArray() as [number, number, number],
  );
  const stopPoints = (Object.keys(PROPS) as PropId[])
    .filter((id) => anchors.has(id))
    .map((id) => ({
      id,
      point: anchors.get(id)!.getWorldPosition(v).toArray() as [
        number,
        number,
        number,
      ],
    }));
  // 左の道（2026-10-30）は、glb の rail_NN が今の 9 点のときだけ作る（点の数が変わったら 1 本の道に戻す。asset.test が数を見張る）
  const rail = createRail(railPoints, stopPoints, railPoints.length === LEFT_LANE_DX.length ? LEFT_LANE_DX : undefined);

  // カメラ
  const findCam = (name: string) =>
    gltf.cameras.find((c) => c.name === name || c.parent?.name === name) as
      Three.PerspectiveCamera | undefined;
  const topCam = findCam("cam_top");
  if (!topCam) throw new Error("アトリエにカメラ cam_top がありません");
  const camera = topCam.clone();
  // 星（半径 120m の天球）まで描く。Blender のカメラは 60m 先までしか描かない
  camera.far = 400;
  let designAspect = topCam.aspect || 16 / 9;
  let designFov = topCam.fov;
  let mode: AtelierCamera = cameraName;
  const walk = { t: 0, look: 0, lane: 0 };
  const fly = {
    from: null as null | { pos: Three.Vector3; quat: Three.Quaternion },
    to: null as null | { pos: Three.Vector3; quat: Three.Quaternion },
    t: 1,
    ms: 0,
    done: null as null | (() => void),
  };
  const ease = easing("emphasized");

  const poseOf = (name: `cam_${string}`) => {
    const c = findCam(name);
    if (!c) throw new Error(`アトリエにカメラ ${name} がありません`);
    c.updateWorldMatrix(true, false);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    c.matrixWorld.decompose(pos, quat, new THREE.Vector3());
    return { pos, quat, fov: c.fov, aspect: c.aspect || 16 / 9 };
  };
  const placeWalk = () => {
    const here = rail.at(walk.t, walk.lane);
    const ahead = rail.at(Math.min(1, walk.t + LOOK_AHEAD), walk.lane);
    camera.position.fromArray(here.position);
    const dir = new THREE.Vector3()
      .fromArray(ahead.position)
      .sub(camera.position);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.fromArray(here.forward).setY(0);
    dir
      .normalize()
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), -walk.look * LOOK_MAX_RAD);
    // 目線は少しだけ上（天窓の空が入る）
    camera.lookAt(
      camera.position
        .clone()
        .add(dir)
        .add(new THREE.Vector3(0, LOOK_PITCH, 0)),
    );
  };
  let width = 1;
  let height = 1;
  const applyProjection = () => {
    camera.aspect = width / height;
    // cover: 枠が設計より横長なら横の画角を保ち（上下を切る）、縦長なら縦の画角を保つ（左右を切る）。ポスターの object-fit: cover と同じ
    camera.fov =
      camera.aspect >= designAspect
        ? (2 *
            Math.atan(
              Math.tan((designFov * Math.PI) / 360) *
                (designAspect / camera.aspect),
            ) *
            180) /
          Math.PI
        : designFov;
    camera.updateProjectionMatrix();
  };
  const setCamera = (name: AtelierCamera) => {
    mode = name;
    fly.t = 1;
    const tea = gltf.scene.getObjectByName("thanks_tea");
    if (tea) tea.visible = name === "cam_contactThanks";
    if (name === "walk") {
      designFov = topCam.fov;
      designAspect = topCam.aspect || 16 / 9;
      placeWalk();
    } else {
      const pose = poseOf(name);
      camera.position.copy(pose.pos);
      camera.quaternion.copy(pose.quat);
      designFov = pose.fov;
      designAspect = pose.aspect;
    }
    applyProjection();
  };
  setCamera(cameraName);

  const raycaster = new THREE.Raycaster();
  const pickables: [PickId, Three.Object3D][] = [
    ...[...props]
      .filter(([id]) => id !== "wall")
      .map(([id, o]) => [id, o] as [PickId, Three.Object3D]),
    ...frames.map((f, i) => [`frame:${i}`, f] as [PickId, Three.Object3D]),
  ];
  // 代表のアバター（spec §6.4）。アトリエの最初の 1 枚を待たせないよう、描き始めた後に読む。
  // 書き出し（frozen）のときは立たせてから撮る。読めなくてもアトリエは描く（アバターの居ない空間になる）
  let figure: AvatarFigure | null = null;
  const spot = gltf.scene.getObjectByName("avatar_spot");
  const loadFigure = async (): Promise<boolean> => {
    if (!avatar || !spot) return false;
    try {
      const { createAvatarFigure } = await import("@/modules/avatar/lib/figure");
      const f = await createAvatarFigure(THREE, avatar);
      spot.getWorldPosition(f.object.position);
      // 入口（rail_00）の方を向く。VRM 0.x は rotateVRM0 で +Z を向いているので、そこから回す
      const start = new THREE.Vector3().fromArray(railPoints[0]);
      f.object.rotation.y += Math.atan2(start.x - f.object.position.x, start.z - f.object.position.z);
      scene.add(f.object);
      pickables.push(["avatar", f.object]);
      figure = f;
      return true;
    } catch (error) {
      console.error("[atelier] 代表のアバターを読めませんでした", error);
      return false;
    }
  };
  const avatarReady = frozen ? Promise.resolve(await loadFigure()) : loadFigure();
  const hoverLevel = new Map<PickId, number>();
  let hover: PickId | null = null;
  let elapsed = 0;
  let frameCount = 0;

  const renderFrame = (dtMs: number) => {
    elapsed += dtMs;
    // カメラの移動（flyTo）
    if (fly.to && fly.from && fly.t < 1) {
      fly.t = fly.ms > 0 ? Math.min(1, fly.t + dtMs / fly.ms) : 1;
      const k = ease(fly.t);
      camera.position.lerpVectors(fly.from.pos, fly.to.pos, k);
      camera.quaternion.slerpQuaternions(fly.from.quat, fly.to.quat, k);
      if (fly.t >= 1) {
        fly.done?.();
        fly.done = null;
      }
    }
    // 縁の光: DURATION.small で寄せる
    for (const [id, mats] of hoverMats) {
      const target = id === hover ? 0.18 : 0;
      const cur = hoverLevel.get(id) ?? 0;
      const next = frozen
        ? target
        : cur + (target - cur) * Math.min(1, dtMs / DURATION.small);
      if (next !== cur) for (const m of mats) m.emissiveIntensity = next;
      hoverLevel.set(id, next);
    }
    if (stars) stars.material.uniforms.time.value = elapsed / 1000;
    figure?.update(frozen ? 0 : Math.min(0.1, dtMs / 1000));
    renderer.render(scene, camera);
    frameCount++;
    canvas.dataset.frame = String(frameCount);
  };

  return {
    rail,
    avatarReady,
    get avatar() {
      const f = figure;
      return f ? { play: (name: MotionName) => f.play(name), get playing() { return f.playing; } } : null;
    },
    render: renderFrame,
    resize(w, h, dpr) {
      width = Math.max(1, w);
      height = Math.max(1, h);
      renderer.setPixelRatio(dpr);
      renderer.setSize(width, height, false);
      if (stars) stars.material.uniforms.pixelRatio.value = dpr;
      applyProjection();
    },
    setWalk(t, look, lane = 0) {
      walk.t = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
      walk.lane = Math.min(1, Math.max(0, Number.isFinite(lane) ? lane : 0));
      walk.look = Math.min(1, Math.max(-1, Number.isFinite(look) ? look : 0));
      if (mode === "walk" && fly.t >= 1) placeWalk();
    },
    setHover(id) {
      hover = id;
    },
    setCamera,
    projectAnchors() {
      const out = new Map<PickId, { x: number; y: number; visible: boolean }>();
      const p = new THREE.Vector3();
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      for (const [id, a] of anchors) {
        a.getWorldPosition(p);
        const ahead = p.clone().sub(camera.position).dot(forward) > 0;
        p.project(camera);
        out.set(id, {
          x: ((p.x + 1) / 2) * width,
          y: ((1 - p.y) / 2) * height,
          visible: ahead && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1,
        });
      }
      return out;
    },
    pick(x, y) {
      raycaster.setFromCamera(
        new THREE.Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1),
        camera,
      );
      const hit = raycaster.intersectObjects(
        pickables.map(([, o]) => o),
        true,
      )[0];
      if (!hit) return null;
      for (const [id, o] of pickables) {
        let n: Three.Object3D | null = hit.object;
        while (n) {
          if (n === o) return id;
          n = n.parent;
        }
      }
      return null;
    },
    flyTo(name, ms) {
      const pose = poseOf(name);
      return new Promise<void>((resolve) => {
        fly.from = {
          pos: camera.position.clone(),
          quat: camera.quaternion.clone(),
        };
        fly.to = { pos: pose.pos, quat: pose.quat };
                fly.ms = ms;
        fly.t = ms > 0 ? 0 : 1;
        // 着いたら、そのカメラ（画角も）に切り替える（歩く位置へ戻さない）
        const arrive = () => {
          setCamera(name);
          resolve();
        };
        if (ms <= 0) arrive();
        else fly.done = arrive;
      });
    },
    dispose() {
      figure?.dispose();
      // 素材のテクスチャ（焼き込みの WebP・額の CanvasTexture）も捨てる。共有のテクスチャは 1 回だけ（最終レビュー I-7）
      const seen = new Set<Three.Texture>();
      scene.traverse((o) => {
        const mesh = o as Three.Mesh;
        if (mesh.isMesh || (o as Three.Points).isPoints) {
          mesh.geometry.dispose();
          const mats = Array.isArray(mesh.material)
            ? mesh.material
            : [mesh.material];
          for (const m of mats) disposeMaterial(m, seen);
        }
      });
      scene.environment?.dispose();
      skyTexture?.dispose();
      renderer.dispose();
      // canvas を外しても GC まで GPU の文脈が残るので、すぐに返す
      renderer.forceContextLoss();
    },
  };
}
