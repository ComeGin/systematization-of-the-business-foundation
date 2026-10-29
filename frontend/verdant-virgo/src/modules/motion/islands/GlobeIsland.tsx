// GlobeOsaka の island（3D の地球儀 ＋ MotionPause）。GlobeOsaka.astro からだけ使う。
// 静止画（GlobeOsaka.astro が最初の HTML に出す）を先に見せ、three で描けたら canvas に替える（動きの規則 5）。
// perf: three・three-globe・R3F は重いので、(1) WebGL が使えて reduced-motion でないときだけ（2026-10-20 から Mobile でも）、(2) 画面に入り、一時停止でなく、
//       (3) ページの読み込みが終わって手が空いてから、動的 import で読む。静止画のまま止めて開いたページ（sessionStorage）では読まない。
// a11y: 5 秒を超えて自動で動くので MotionPause を付ける（2.2.2）。画面外・タブ非表示・一時停止の間は rAF を止める（規則 6）。
//       reduced-motion のときは何も動かさず、ボタンも出さない。
import { useEffect, useRef, useState, type ComponentType } from "react";
import { MotionPause, useReducedMotion } from "@/modules/a11y/client";
import type { GlobeConfig, GlobeMarker } from "../vendor/aceternity/Globe/Globe";
import { canUseWebGL, loadThree, OSAKA } from "../lib/three";
import { cssColor, DURATION } from "../lib/tokens";
import { useVisible } from "../lib/use-visible";

interface Props {
  pauseLabel: string;
  resumeLabel: string;
  /** 一時停止のボタンの対象名（名前を、ヒーロー・マーキーの一時停止のボタンと分ける） */
  pauseTarget: string;
}

interface WorldProps {
  globeConfig: GlobeConfig;
  markers: GlobeMarker[];
  active: boolean;
  onReady?: () => void;
}

const STORAGE_KEY = "motion:globe";
// 正面（大阪）を軸に左右へ振れる幅（度）と往復の時間。遠近のカメラが球の中心から見込む角は約 70.5 度で、
// 振れ幅を足しても陸地のデータ（大阪から 105 度以内の国）の外は見えない（scripts/make-globe-assets.mjs）。ゆっくり: 往復に ambient の 3 倍（24 秒）
const SWAY_DEG = 30;
const SWAY_PERIOD_MS = DURATION.ambient * 3;
// 輪が広がって消える 1 周。光の明るさの周期は 1 秒以上（2.3.1）。トークンの glow（2.4 秒）
const PULSE_PERIOD_MS = DURATION.glow;

/** 手が空くのを待つ（読み込みが終わっていれば idle、終わっていなければ load の後の idle）。戻り値で取り消す */
function whenIdle(run: () => void): () => void {
  // requestIdleCallback は Safari に無い（型には「ある」と書かれているので、無いものとして扱う）
  const idle = window as Window & {
    requestIdleCallback?: Window["requestIdleCallback"];
    cancelIdleCallback?: Window["cancelIdleCallback"];
  };
  let cancelled = false;
  let idleId: number | undefined;
  let timerId: number | undefined;
  const fire = () => {
    if (cancelled) return;
    if (idle.requestIdleCallback) {
      idleId = idle.requestIdleCallback(run, { timeout: 4000 });
    } else {
      timerId = window.setTimeout(run, 200);
    }
  };
  if (document.readyState === "complete") fire();
  else window.addEventListener("load", fire, { once: true });
  return () => {
    cancelled = true;
    window.removeEventListener("load", fire);
    if (idleId !== undefined) idle.cancelIdleCallback?.(idleId);
    if (timerId !== undefined) window.clearTimeout(timerId);
  };
}

export default function GlobeIsland({
  pauseLabel,
  resumeLabel,
  pauseTarget,
}: Props) {
  const reduced = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const visible = useVisible(rootRef);
  const [webgl, setWebgl] = useState(false);
  // 前のページで止めたか（MotionPause と同じキー）を、読み込みを始める前に知る
  const [userPaused, setUserPaused] = useState(false);
  const [stateKnown, setStateKnown] = useState(false);
  const [failed, setFailed] = useState(false);
  const [World, setWorld] = useState<ComponentType<WorldProps> | null>(null);
  const [config, setConfig] = useState<GlobeConfig | null>(null);
  // 点は大阪だけ（弧は出さない）
  const [markers, setMarkers] = useState<GlobeMarker[]>([]);
  const [ready, setReady] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    setWebgl(canUseWebGL());
    try {
      if (window.sessionStorage.getItem(STORAGE_KEY) === "paused")
        setUserPaused(true);
    } catch {
      // sessionStorage が使えないときは動かす（ボタンで止められる）
    }
    setStateKnown(true);
  }, []);

  const live = !reduced && webgl && !failed;

  // 読み込みは 1 回だけ。画面に入り、一時停止でなく、手が空いてから。取り消しは unmount のときだけ（途中で画面外に出ても読み終える）
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!live || !stateKnown || !visible || userPaused || startedRef.current)
      return;
    startedRef.current = true;
    cancelRef.current = whenIdle(() => {
      // three を先に取りに行く（loadThree が three のチャンクの唯一の入口。地球儀の原本の R3F も同じチャンクを指す）
      Promise.all([
        loadThree(),
        import("../vendor/aceternity/Globe/Globe"),
      ])
        .then(([, mod]) => {
          setConfig({
            // token: 地球の面は navy の階調、点と輪と大気は brand.sky、陸地は navy.300 を薄く
            globeColor: cssColor("--color-brand-navy-700"),
            emissive: cssColor("--color-brand-navy-600"),
            emissiveIntensity: 0.45,
            shininess: 0.6,
            atmosphereColor: cssColor("--color-brand-sky"),
            atmosphereAltitude: 0.18,
            showAtmosphere: true,
            polygonColor: cssColor("--color-brand-navy-200"),
            polygonOpacity: 0.9,
            ambientLight: cssColor("--color-brand-navy-200"),
            directionalLeftLight: cssColor("--color-brand-navy-50"),
            directionalTopLight: cssColor("--color-brand-navy-100"),
            pointLight: cssColor("--color-brand-navy-50"),
            pointSize: 1.6,
            maxRings: 9,
            pulsePeriodMs: PULSE_PERIOD_MS,
            initialPosition: { lat: OSAKA.lat, lng: OSAKA.lng },
            swayDeg: SWAY_DEG,
            swayPeriodMs: SWAY_PERIOD_MS,
          });
          setMarkers([
            { lat: OSAKA.lat, lng: OSAKA.lng, color: cssColor("--color-brand-sky") },
          ]);
          setWorld(() => mod.World);
        })
        .catch((error: unknown) => {
          // 読み込みに失敗したら静止画のまま（ボタンも出さない）。原因を追えるようにコンソールには出す
          console.error("[globe] 3D の読み込みに失敗しました", error);
          setFailed(true);
        });
    });
  }, [live, stateKnown, visible, userPaused]);

  useEffect(() => () => cancelRef.current?.(), []);

  // a11y: reduced-motion が途中で有効になったときも止める（live は reduced-motion でないことを含む）。canvas は最後の 1 枚が残る
  const active = live && visible && !userPaused && World !== null;
  const showCanvas = World !== null && ready;

  // 静止画との入れ替え・止まっているかを、根（GlobeOsaka.astro の [data-motion="globe"]）の属性で伝える（CSS・e2e が読む）
  useEffect(() => {
    const host = rootRef.current?.closest<HTMLElement>('[data-motion="globe"]');
    if (!host) return;
    if (showCanvas) host.setAttribute("data-globe-live", "true");
    else host.removeAttribute("data-globe-live");
    if (live) host.setAttribute("data-motion-paused", String(userPaused));
    else host.removeAttribute("data-motion-paused");
  }, [showCanvas, live, userPaused]);

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0">
      {World !== null && config !== null && (
        <div
          aria-hidden="true"
          className="absolute -inset-[10%] transition-opacity duration-[var(--motion-duration-medium)] ease-[var(--motion-ease-standard)]"
          style={{ opacity: showCanvas ? 1 : 0 }}
        >
          <World
            globeConfig={config}
            markers={markers}
            active={active}
            onReady={() => {
              // 組み立てた直後の 1 枚が描かれてから静止画と入れ替える
              requestAnimationFrame(() =>
                requestAnimationFrame(() => setReady(true)),
              );
            }}
          />
        </div>
      )}
      {live && stateKnown && (
        // Mobile は左下（2026-10-20 に、当時のヒーローの背景〈HeroBackdrop。2026-10-29 に消した〉の一時停止のボタンと重ならないよう決めた位置）
        <div className="pointer-events-auto absolute -bottom-2 left-0 z-[2] md:right-0 md:left-auto">
          <MotionPause
            pauseLabel={pauseLabel}
            resumeLabel={resumeLabel}
            storageKey={STORAGE_KEY}
            tone="dark"
            target={pauseTarget}
            onToggle={setUserPaused}
          />
        </div>
      )}
    </div>
  );
}
