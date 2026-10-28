// 模型の island（three で描いた canvas ＋ MotionPause）。DioramaHero・DioramaIntro からだけ使う。
// ポスター（.astro が最初の HTML に出す <picture>）を先に見せ、three で描けたら canvas に替える（動きの規則 5。spec §9 の 1）。
// perf: three・glb は重いので、(1) WebGL が使えて reduced-motion でなく、(2) 画面に入り、一時停止でなく、(3) 遅い端末と判定されておらず、
//       (4) ページの読み込みが終わって手が空いてから読む。最初の 3 秒のフレーム時間で解像度を決め、遅ければポスターに戻す（decideQuality）。
//       判定は sessionStorage の diorama:quality に残し、次のページでは測り直さない（遅い端末で毎回 three を読まない）。
// a11y: 5 秒を超えて自動で動くので MotionPause（storageKey motion:diorama）を付ける（2.2.2）。画面外・タブ非表示・一時停止の間は rAF を止める（規則 6）。
//       canvas は飾りなので aria-hidden。reduced-motion のときは何も動かさず、ボタンも出さない。
import { useCallback, useEffect, useRef, useState } from "react";
import { MotionPause, useReducedMotion } from "@/modules/a11y/client";
import {
  canUseWebGL,
  cssColor,
  loadThree,
  runWhenVisible,
} from "@/modules/motion/client";
import { PAGE_VIEWS } from "../lib/pages";
import { decideQuality, type Quality } from "../lib/quality";
import type { DioramaScene } from "../lib/scene";
import { dioramaZoomOrigin, pageKeyForPath } from "../lib/transition";
import type { PageKey, PartId } from "../lib/types";
import DioramaTouch, { type DioramaTouchCopy } from "./DioramaTouch";

interface Props {
  page: PageKey;
  glbUrl: string;
  pauseLabel: string;
  resumeLabel: string;
  /** 一時停止のボタンの対象名（MOTION_PAUSE_TARGETS.diorama） */
  pauseTarget: string;
  /** トップだけ: 押せる部品とパネル（spec §6.2〜6.4）。渡さなければ眺めるだけ（spec §6.7） */
  touch?: DioramaTouchCopy;
  /** 模型の中に立たせる代表のアバター（PAGE_VIEWS の showsAvatar のページだけ渡す） */
  avatar?: { modelUrl: string; idleUrl: string; nodUrl: string };
  /** 枠が設計より横長のとき、設計の画角を置く位置（scene.ts の align。ポスターの object-position と合わせる） */
  align?: "center" | "end";
  /** ポスターの上での部品の位置（touch のとき。ポスターに対する %） */
  stillAnchors?: Partial<Record<PartId, { x: number; y: number }>>;
}

const PAUSE_KEY = "motion:diorama";
const QUALITY_KEY = "diorama:quality";
/** 解像度を決めるために測る時間（ms）。最初の 2 フレームはシェーダーの準備を含むので数えない */
const MEASURE_MS = 3000;
const ANCHORS_EVERY_MS = 250;
/** ページの移動の拡大の中心を、行き先へ渡す sessionStorage のキー（行き先の DioramaHero・DioramaIntro の inline script が読む） */
const VT_KEY = "diorama:vt";
/** page-transition の VT.diorama と同じ名前（island から page-transition を読まないよう、値だけを持つ） */
const VT_NAME = "vt-diorama";

function readQuality(): Quality | null {
  try {
    const raw = window.sessionStorage.getItem(QUALITY_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Quality>;
    return typeof value.live === "boolean" && typeof value.dpr === "number"
      ? { live: value.live, dpr: value.dpr }
      : null;
  } catch {
    return null;
  }
}

function writeQuality(q: Quality) {
  try {
    window.sessionStorage.setItem(QUALITY_KEY, JSON.stringify(q));
  } catch {
    // 残せなくても、このページでは判定どおりに動く
  }
}

/** 手が空くのを待つ（読み込みが終わっていれば idle、終わっていなければ load の後の idle）。戻り値で取り消す */
function whenIdle(run: () => void): () => void {
  const idle = window as Window & {
    requestIdleCallback?: Window["requestIdleCallback"];
    cancelIdleCallback?: Window["cancelIdleCallback"];
  };
  let cancelled = false;
  let id: number | undefined;
  const fire = () => {
    if (cancelled) return;
    if (idle.requestIdleCallback)
      id = idle.requestIdleCallback(run, { timeout: 4000 });
    else id = window.setTimeout(run, 200);
  };
  if (document.readyState === "complete") fire();
  else window.addEventListener("load", fire, { once: true });
  return () => {
    cancelled = true;
    window.removeEventListener("load", fire);
    if (id !== undefined) (idle.cancelIdleCallback ?? window.clearTimeout)(id);
  };
}

export default function DioramaIsland({
  page,
  glbUrl,
  pauseLabel,
  resumeLabel,
  pauseTarget,
  touch,
  align = "center",
  avatar,
  stillAnchors = {},
}: Props) {
  const reduced = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<DioramaScene | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [webgl, setWebgl] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [stateKnown, setStateKnown] = useState(false);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const startedRef = useRef(false);
  // 毎フレームの合図（押せる部品の位置を合わせる。DioramaTouch）
  const frameHooks = useRef(new Set<() => void>());
  const subscribeFrame = useCallback((fn: () => void) => {
    frameHooks.current.add(fn);
    return () => {
      frameHooks.current.delete(fn);
    };
  }, []);
  const getScene = useCallback(() => sceneRef.current, []);
  // 一時停止のボタンは、前のページで止めていたとき、水和の後に「止める」→「再開する」へ文字が替わる（MotionPause が sessionStorage を読む）。
  // 右寄せのボタンの幅が変わってずれ（CLS）にならないよう、替わり終わる 2 フレーム後まで見えなくしておく
  const [pauseSettled, setPauseSettled] = useState(false);
  const disposedRef = useRef(false);
  const cancelRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setWebgl(canUseWebGL());
    try {
      if (window.sessionStorage.getItem(PAUSE_KEY) === "paused")
        setUserPaused(true);
    } catch {
      // sessionStorage が使えないときは動かす（ボタンで止められる）
    }
    setQuality(readQuality());
    setStateKnown(true);
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    return el ? runWhenVisible(el, setVisible) : undefined;
  }, []);

  const live = !reduced && webgl && !failed && quality?.live !== false;

  // 読み込みは 1 回だけ。画面に入り、一時停止でなく、手が空いてから。取り消しは unmount のときだけ（途中で画面外に出ても読み終える）
  useEffect(() => {
    if (!live || !stateKnown || !visible || userPaused || startedRef.current)
      return;
    startedRef.current = true;
    cancelRef.current = whenIdle(() => {
      Promise.all([loadThree(), import("../lib/scene")])
        .then(async ([three, { createDioramaScene }]) => {
          const box = boxRef.current;
          if (!box || disposedRef.current) return;
          const canvas = document.createElement("canvas");
          canvas.setAttribute("aria-hidden", "true");
          canvas.className = "diorama__canvas";
          box.appendChild(canvas);
          canvasRef.current = canvas;
          const scene = await createDioramaScene(three, canvas, {
            glbUrl,
            camera: PAGE_VIEWS[page].camera,
            colors: {
              proposal: cssColor("--color-brand-sky"),
              room: cssColor("--color-role-surface-hero"),
            },
            align,
            avatar,
          });
          if (disposedRef.current) {
            scene.dispose();
            return;
          }
          sceneRef.current = scene;
          const mobile = window.matchMedia("(max-width: 767px)").matches;
          const q =
            readQuality() ??
            decideQuality([], {
              mobile,
              deviceDpr: window.devicePixelRatio || 1,
            });
          scene.resize(box.clientWidth, box.clientHeight, q.dpr);
          scene.render(0);
          // 組み立てた直後の 1 枚が描かれてからポスターと入れ替える
          requestAnimationFrame(() =>
            requestAnimationFrame(() => setReady(true)),
          );
        })
        .catch((error: unknown) => {
          // 読み込みに失敗したらポスターのまま（ボタンも出さない）。原因を追えるようにコンソールには出す
          console.error("[diorama] 3D の読み込みに失敗しました", error);
          setFailed(true);
        });
    });
  }, [live, stateKnown, visible, userPaused, glbUrl, page, align]);

  useEffect(
    () => () => {
      disposedRef.current = true;
      cancelRef.current?.();
      sceneRef.current?.dispose();
      sceneRef.current = null;
    },
    [],
  );

  const active = live && ready && visible && !userPaused;

  // 描画の繰り返し。最初の MEASURE_MS で端末の速さを測る（判定済みなら測らない）
  useEffect(() => {
    const scene = sceneRef.current;
    if (!active || !scene) return undefined;
    let raf = 0;
    let last = performance.now();
    const measuring = readQuality() === null;
    const samples: number[] = [];
    let measured = 0;
    let lastAnchors = 0;
    const host = rootRef.current?.closest<HTMLElement>(
      '[data-motion="diorama"]',
    );
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      scene.render(dt);
      for (const fn of frameHooks.current) fn();
      if (measuring && measured < MEASURE_MS) {
        measured += dt;
        samples.push(dt);
        if (measured >= MEASURE_MS) {
          const mobile = window.matchMedia("(max-width: 767px)").matches;
          const q = decideQuality(samples.slice(2), {
            mobile,
            deviceDpr: window.devicePixelRatio || 1,
          });
          writeQuality(q);
          if (!q.live) {
            setFailed(true);
            return;
          }
          const box = boxRef.current;
          if (box) scene.resize(box.clientWidth, box.clientHeight, q.dpr);
        }
      }
      // ページの移動のつながり（Task 10）が読む、部品の位置（根に対する %）
      if (host && now - lastAnchors > ANCHORS_EVERY_MS) {
        lastAnchors = now;
        const box = boxRef.current;
        if (box) {
          const out: Record<string, { x: number; y: number }> = {};
          for (const [id, a] of scene.projectAnchors())
            out[id] = {
              x: (a.x / box.clientWidth) * 100,
              y: (a.y / box.clientHeight) * 100,
            };
          host.dataset.dioramaAnchors = JSON.stringify(out);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  // 大きさの変化（Desktop ⇔ Mobile をまたぐ変化を含む）
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !ready) return undefined;
    const observer = new ResizeObserver(() => {
      const scene = sceneRef.current;
      if (!scene) return;
      const q = readQuality();
      const mobile = window.matchMedia("(max-width: 767px)").matches;
      scene.resize(
        box.clientWidth,
        box.clientHeight,
        q?.dpr ??
          decideQuality([], { mobile, deviceDpr: window.devicePixelRatio || 1 })
            .dpr,
      );
      // 止まっている間は毎フレームの合図が来ないので、ここで 1 枚描き直し、押せる部品も置き直す（最終レビュー I-5）。
      // 動いている間も、新しい大きさの投影で置き直す（DioramaTouch は立体のときは自前で大きさを見ない。順番の取り違えを無くす）
      if (userPaused) scene.render(0);
      for (const fn of frameHooks.current) fn();
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [ready, userPaused]);

  // 視差とランプの傾き（ポインターの位置。根の中だけ）
  useEffect(() => {
    const host = rootRef.current?.closest<HTMLElement>(
      '[data-motion="diorama"]',
    );
    if (!host || !ready) return undefined;
    const onMove = (event: PointerEvent) => {
      const r = host.getBoundingClientRect();
      sceneRef.current?.setPointer(
        (event.clientX - r.left) / r.width - 0.5,
        (event.clientY - r.top) / r.height - 0.5,
      );
    };
    const onLeave = () => sceneRef.current?.setPointer(0, 0);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);
    return () => {
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
    };
  }, [ready]);

  // ページの移動を「模型に寄るカメラ」に見せる（spec §9 の 3）。移動の直前（pageswap）に、行き先の焦点の部品の位置（枠に対する %）を
  // sessionStorage に残す。遷移の絵は行き先の文書で描かれるので、行き先の模型の inline script がこれを読んで CSS の変数に写す
  useEffect(() => {
    const onSwap = (raw: Event) => {
      const event = raw as Event & { viewTransition?: unknown; activation?: { entry?: { url?: string } } | null };
      try {
        window.sessionStorage.removeItem(VT_KEY);
      } catch {
        return;
      }
      const url = event.activation?.entry?.url;
      if (!event.viewTransition || !url) return;
      const to = pageKeyForPath(new URL(url).pathname);
      const box = boxRef.current;
      if (!to || !box) return;
      const w = box.clientWidth;
      const h = box.clientHeight;
      const scene = ready ? sceneRef.current : null;
      const anchors = new Map<PartId, { x: number; y: number }>();
      if (scene) for (const [id, a] of scene.projectAnchors()) anchors.set(id, { x: a.x, y: a.y });
      else for (const [id, a] of Object.entries(stillAnchors) as [PartId, { x: number; y: number }][]) anchors.set(id, { x: (a.x / 100) * w, y: (a.y / 100) * h });
      const origin = dioramaZoomOrigin(page, to, anchors, { width: w, height: h });
      const back = PAGE_VIEWS[page].focus !== null && PAGE_VIEWS[to].mode !== "still" && PAGE_VIEWS[to].focus === null;
      try {
        if (origin) window.sessionStorage.setItem(VT_KEY, JSON.stringify({ mode: "zoom-in", ...origin }));
        else if (back) window.sessionStorage.setItem(VT_KEY, JSON.stringify({ mode: "zoom-out", x: "50%", y: "50%" }));
      } catch {
        // 残せなくても、形のつながり（既定の重ね合わせ）だけで移る
      }
      // 移動元の模型にも、遷移の間だけ名前を付ける（ページを去るので外さない。bfcache で戻ったときは pageshow で外す）
      if (origin || back) {
        const host = rootRef.current?.closest<HTMLElement>('[data-motion="diorama"]');
        if (host) host.style.viewTransitionName = VT_NAME;
      }
    };
    const onShow = () => {
      const host = rootRef.current?.closest<HTMLElement>('[data-motion="diorama"]');
      if (host) host.style.viewTransitionName = "";
    };
    window.addEventListener("pageswap", onSwap);
    window.addEventListener("pageshow", onShow);
    return () => {
      window.removeEventListener("pageswap", onSwap);
      window.removeEventListener("pageshow", onShow);
    };
  }, [page, ready, stillAnchors]);

  // 遅い端末・失敗: canvas を外し、三次元の資源を返す（ポスターのまま）
  useEffect(() => {
    if (!failed) return;
    sceneRef.current?.dispose();
    sceneRef.current = null;
    canvasRef.current?.remove();
    canvasRef.current = null;
    setReady(false);
  }, [failed]);

  // ポスターとの入れ替え・止まっているかを、根（[data-motion="diorama"]）の属性で伝える（CSS・e2e が読む）
  useEffect(() => {
    const host = rootRef.current?.closest<HTMLElement>(
      '[data-motion="diorama"]',
    );
    if (!host) return;
    if (ready && !failed) host.setAttribute("data-diorama-live", "true");
    else host.removeAttribute("data-diorama-live");
    if (live) host.setAttribute("data-motion-paused", String(userPaused));
    else host.removeAttribute("data-motion-paused");
  }, [ready, failed, live, userPaused]);

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0">
      <div
        ref={boxRef}
        aria-hidden="true"
        className="diorama__box absolute inset-0"
      />
      {touch && (
        <DioramaTouch
          copy={touch}
          stillAnchors={stillAnchors}
          align={align}
          boxRef={boxRef}
          getScene={getScene}
          subscribeFrame={subscribeFrame}
          live={ready && !failed}
        />
      )}
      {live && stateKnown && (
        <div
          className="pointer-events-auto absolute right-4 bottom-4 z-[2] md:right-6"
          style={pauseSettled ? undefined : { visibility: "hidden" }}
          ref={(el) => {
            // rAF を使わない（「rAF が 0」を見るほかの部品の検査に、待機中の模型の rAF を混ぜない）。約 2 フレームの間
            if (el && !pauseSettled) window.setTimeout(() => setPauseSettled(true), 34);
          }}
        >
          <MotionPause
            pauseLabel={pauseLabel}
            resumeLabel={resumeLabel}
            storageKey={PAUSE_KEY}
            tone="dark"
            target={pauseTarget}
            onToggle={setUserPaused}
          />
        </div>
      )}
    </div>
  );
}
