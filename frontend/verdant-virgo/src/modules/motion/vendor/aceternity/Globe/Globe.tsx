// 出典: Aceternity UI「Globe（GitHub Globe）」（https://ui.aceternity.com/components/github-globe。registry: https://ui.aceternity.com/registry/globe.json）。2026-10-19 に shadcn CLI（@aceternity/globe）で取り込んだ原本。
// ライセンス: Aceternity UI の無料の部品（Pro ではない）。詳しくは vendor/aceternity/README.md。
// a11y・性能・トークンのための変更には「// a11y:」「// perf:」「// token:」の印を付ける（計画書 P-10）。
// 変えた点の一覧と理由は vendor/aceternity/README.md の「Globe」を参照。
"use client";
import { useEffect, useRef, useState } from "react";
import { PerspectiveCamera, type Group } from "three";
import ThreeGlobe from "three-globe";
import { Canvas, extend, useFrame, useThree } from "@react-three/fiber";
// perf: 陸地のデータは registry に無いので three-globe の例（Natural Earth の 110m）を複写し、
//       大阪を正面にしたときに見える範囲の国だけに絞った（scripts/make-globe-assets.mjs。README を参照）
import countries from "./globe.json";
declare module "@react-three/fiber" {
  interface ThreeElements {
    threeGlobe: ThreeElements["mesh"] & {
      new (): ThreeGlobe;
    };
  }
}

extend({ ThreeGlobe: ThreeGlobe });

const cameraZ = 300;
// perf: 原本の PerspectiveCamera(50, 1.2, 180, 1800) を Canvas の camera prop に渡す形にした（描画のたびに作り直さない）。
//       位置は原本が OrbitControls の距離の固定で決めていた cameraZ。OrbitControls（drei）は使わない（下の「a11y:」）

const rad = (deg: number) => (deg * Math.PI) / 180;

// token: 原本の arcs（Position[]）をやめ、点だけを受ける。弧は出さない（設計書 §6。販売先は大阪府内で、どこへ弧を伸ばしても事実に反する）
export type GlobeMarker = {
  lat: number;
  lng: number;
  /** #rrggbb（色は呼び出し側が役割トークンから解決して渡す） */
  color: string;
};

export type GlobeConfig = {
  pointSize?: number;
  globeColor: string;
  showAtmosphere?: boolean;
  atmosphereColor: string;
  atmosphereAltitude?: number;
  emissive: string;
  emissiveIntensity?: number;
  shininess?: number;
  /** 陸地の hex の色（#rrggbb） */
  polygonColor: string;
  /** 陸地の不透明度（0〜1） */
  polygonOpacity: number;
  ambientLight: string;
  directionalLeftLight: string;
  directionalTopLight: string;
  pointLight: string;
  /** 脈打つ輪の広がる大きさ（度）。1 周の時間は pulsePeriodMs */
  maxRings?: number;
  /** 輪が 1 つ出てから次が出るまで（ms）。光の明るさの周期は 1 秒以上（2.3.1） */
  pulsePeriodMs: number;
  /** 正面に向ける場所 */
  initialPosition: { lat: number; lng: number };
  /** a11y: 原本の autoRotate（一周する自転）をやめ、正面を軸に左右へ振れる幅（度）。陸地のデータは見える範囲の国だけなので一周させない */
  swayDeg: number;
  /** 振れの 1 周（往復）の時間（ms） */
  swayPeriodMs: number;
};

interface WorldProps {
  globeConfig: GlobeConfig;
  markers: GlobeMarker[];
  /** a11y/perf: 見えていて、一時停止でない間だけ true。false の間は rAF を回さない（three-globe の自前の rAF も止める） */
  active: boolean;
  /** 地球儀の組み立てが終わった */
  onReady?: () => void;
}

/** '#rrggbb' と不透明度から rgba() を作る（three-globe の輪の色は t ごとの文字列で渡す） */
function rgba(hex: string, alpha: number) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
}

export function Globe({ globeConfig, markers, active, onReady }: WorldProps) {
  const globeRef = useRef<ThreeGlobe | null>(null);
  // 型の変更: React 19 の型では useRef() に引数が要る
  const spinRef = useRef<Group>(null);
  const phaseRef = useRef(0);
  const invalidate = useThree((state) => state.invalidate);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [isInitialized, setIsInitialized] = useState(false);

  // Initialize globe only once
  useEffect(() => {
    if (!globeRef.current && spinRef.current) {
      // perf: animateIn（出現時の拡大と一周の回転）と waitForGlobeReady はやめる。最初から正面を向けて置く
      const globe = new ThreeGlobe({
        animateIn: false,
        waitForGlobeReady: false,
      });
      // perf: three-globe は作った時点から自前の rAF（tween・輪）を回す。止めるべき間は作った直後に止める
      if (!activeRef.current) globe.pauseAnimation();
      globeRef.current = globe;
      spinRef.current.add(globe);
      setIsInitialized(true);
    }
    return () => {
      const globe = globeRef.current;
      if (globe) {
        globe.pauseAnimation();
        (globe as unknown as { _destructor?: () => void })._destructor?.();
        spinRef.current?.remove(globe);
        globeRef.current = null;
      }
    };
  }, []);

  // a11y/perf: 見えない間・一時停止の間は three-globe の rAF も止める（R3F の frameloop とは別に回るため）
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe || !isInitialized) return;
    if (active) globe.resumeAnimation();
    else globe.pauseAnimation();
  }, [active, isInitialized]);

  // Build material when globe is initialized or when relevant props change
  useEffect(() => {
    if (!globeRef.current || !isInitialized) return;

    const globeMaterial = globeRef.current.globeMaterial() as unknown as {
      color: { set: (value: string) => void };
      emissive: { set: (value: string) => void };
      emissiveIntensity: number;
      shininess: number;
    };
    globeMaterial.color.set(globeConfig.globeColor);
    globeMaterial.emissive.set(globeConfig.emissive);
    globeMaterial.emissiveIntensity = globeConfig.emissiveIntensity ?? 0.1;
    globeMaterial.shininess = globeConfig.shininess ?? 0.9;
  }, [
    isInitialized,
    globeConfig.globeColor,
    globeConfig.emissive,
    globeConfig.emissiveIntensity,
    globeConfig.shininess,
  ]);

  // Build data when globe is initialized or when data changes
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe || !isInitialized) return;

    const pulse = globeConfig.maxRings ?? 6;
    globe
      .hexPolygonsData(countries.features)
      .hexPolygonResolution(3)
      .hexPolygonMargin(0.5)
      .hexPolygonsTransitionDuration(0)
      .showAtmosphere(globeConfig.showAtmosphere ?? true)
      .atmosphereColor(globeConfig.atmosphereColor)
      .atmosphereAltitude(globeConfig.atmosphereAltitude ?? 0.15)
      .hexPolygonColor(() => rgba(globeConfig.polygonColor, globeConfig.polygonOpacity));

    // token: 原本は弧の両端を点にしていた。弧は出さないので、点は markers をそのまま使う
    globe
      .pointsData(markers)
      .pointColor((d) => (d as GlobeMarker).color)
      .pointsMerge(false)
      .pointsTransitionDuration(0)
      .pointAltitude(0.01)
      .pointRadius((globeConfig.pointSize ?? 1) * 0.9);

    // a11y: 原本は 2 秒ごとに setInterval で輪をランダムに入れ替えていた。three-globe の輪の繰り返し（ringRepeatPeriod）に任せ、
    //       大阪の点の 1 か所だけを一定の周期で脈打たせる（周期は 1 秒以上。点滅ではなく、広がって消える輪）
    const speed = pulse / (globeConfig.pulsePeriodMs / 1000);
    globe
      .ringsData(markers)
      .ringColor(
        (d: object) => (t: number) =>
          rgba((d as GlobeMarker).color, Math.max(0, 0.85 * (1 - t))),
      )
      .ringMaxRadius(pulse)
      .ringPropagationSpeed(speed)
      .ringRepeatPeriod(globeConfig.pulsePeriodMs)
      .ringResolution(64);

    // perf: 止まっている間（frameloop が 'demand'）でも、組み立てた直後の 1 枚は描く
    invalidate();
    onReady?.();
    // onReady は組み立ての 1 回の通知。props の変更では呼び直さない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isInitialized,
    markers,
    globeConfig.pointSize,
    globeConfig.showAtmosphere,
    globeConfig.atmosphereColor,
    globeConfig.atmosphereAltitude,
    globeConfig.polygonColor,
    globeConfig.polygonOpacity,
    globeConfig.maxRings,
    globeConfig.pulsePeriodMs,
  ]);

  // a11y: 正面（大阪）を軸に左右へ振れる。経度の回転（spin）を緯度の傾き（tilt）の内側に置き、大阪が画面の中心に来るようにする。
  //       時間は描画された分だけ進める（一時停止・画面外から戻っても位置が飛ばない）
  useFrame((_, delta) => {
    phaseRef.current += Math.min(delta, 0.1) * 1000;
    const swing =
      rad(globeConfig.swayDeg) *
      Math.sin((2 * Math.PI * phaseRef.current) / globeConfig.swayPeriodMs);
    if (spinRef.current) {
      spinRef.current.rotation.y =
        -rad(globeConfig.initialPosition.lng) + swing;
    }
  });

  return (
    <group rotation={[rad(globeConfig.initialPosition.lat), 0, 0]}>
      <group
        ref={spinRef}
        rotation={[0, -rad(globeConfig.initialPosition.lng), 0]}
      />
    </group>
  );
}

// a11y: 原本の WebGLRendererConfig（setPixelRatio・setSize・setClearColor を毎回呼ぶ）は不要。dpr は Canvas の prop で、背景は透明が既定

export function World(props: WorldProps) {
  const { globeConfig, active } = props;
  const [camera] = useState(() => new PerspectiveCamera(50, 1, 180, 1800));
  return (
    <Canvas
      camera={camera}
      // perf: 描画の解像度は 1.5 まで（高 DPR の端末で画素数が増えすぎない）。見えない間・一時停止の間は 'demand'（要求のある 1 回だけ描く）
      dpr={[1, 1.5]}
      frameloop={active ? "always" : "demand"}
      gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
      // a11y: canvas そのものに aria-hidden を付ける（装飾。意味は文字・形・状態で持たせる）
      onCreated={({ gl, camera: cam }) => {
        gl.domElement.setAttribute("aria-hidden", "true");
        cam.position.set(0, 0, cameraZ);
        cam.lookAt(0, 0, 0);
      }}
    >
      <ambientLight color={globeConfig.ambientLight} intensity={0.6} />
      <directionalLight
        color={globeConfig.directionalLeftLight}
        position={[-400, 100, 400]}
      />
      <directionalLight
        color={globeConfig.directionalTopLight}
        position={[-200, 500, 200]}
      />
      <pointLight
        color={globeConfig.pointLight}
        position={[-200, 500, 200]}
        intensity={0.8}
      />
      <Globe {...props} />
      {/* a11y: 原本の OrbitControls（ドラッグで回す・自動回転）は使わない。ポインターもキーボードも受けない装飾で、drei も読まない */}
    </Canvas>
  );
}
