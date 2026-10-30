// アトリエの island（three で描いた canvas・歩く操作・MotionPause）。AtelierHero からだけ使う。
// ポスター（.astro が最初の HTML に出す <picture>）を先に見せ、three で描けたら canvas に替える（spec §6.1・§9 の 1）。
// perf: three・glb は重いので、(1) WebGL が使えて reduced-motion でなく、(2) 画面に入り、一時停止でなく、(3) 遅い端末と判定されておらず、
//       (4) ページの読み込みが終わって手が空いてから読む。最初の 3 秒のフレーム時間で解像度を決め、遅ければポスターに戻す（decideQuality）。
//       判定は sessionStorage の atelier:quality に残し、次のページでは測り直さない。768px 未満は Mobile の glb（テクスチャが半分）を読む。
// 歩く（spec §6.2）: 道のレール（glb の rail_NN）の上を、加減速しながら進む（lib/walk.ts）。進む合図は
//   マウス … canvas の空いた所（文字・ボタン・置き物の上でない所）にカーソルがある間。カーソルの左右で視線がわずかに振れる
//   スマートフォン … 空いた所を 300ms 以上、ほぼ動かさずに押している間（縦のスワイプはページのスクロール。touch-action: pan-y）
//   キーボード … 「前へ進む」（次の止まる所まで）・「入口に戻る」のボタンと、ヒーローの中にフォーカスがある間の ↑・↓
//   ホイールは使わない（ページのスクロールを乗っ取らない）。進んだ位置は sessionStorage の atelier:pos に残す。
// a11y: 5 秒を超えて自動で動く（星・アバターの待機）ので MotionPause（storageKey motion:atelier）を付ける（2.2.2）。
//       止めている間も歩く操作はでき、歩いている間だけ描く（spec §6.5）。画面外・タブ非表示の間は rAF を止める。canvas は飾りなので aria-hidden。
import { useCallback, useEffect, useRef, useState } from "react";
import { MotionPause, useReducedMotion } from "@/modules/a11y/client";
import {
  canUseWebGL,
  loadThree,
  runWhenVisible,
} from "@/modules/motion/client";
import type { AvatarFigureOptions } from "@/modules/avatar/lib/figure";
import { drawFrameArt, type FrameArt } from "../lib/frame-art";
import { decideQuality, type Quality } from "../lib/quality";
import type { AtelierScene } from "../lib/scene";
import { pickMotion } from "../lib/motions";
import type { MotionName, Phase } from "../lib/types";
import { createWalker, type Walker } from "../lib/walk";
import { pageKeyForPath } from "../lib/pages";
import { STILL_VIEWS } from "../lib/pages";
import { afterFlight, writeVt } from "../lib/transition";
import { DURATION } from "@/modules/motion/lib/tokens";
import AtelierTouch, { type AtelierTouchCopy } from "./AtelierTouch";

export interface AtelierWalkCopy {
  forward: string;
  back: string;
  /** 操作の案内 */
  hint: string;
}

interface Props {
  page: "top";
  glbUrl: string;
  mobileGlbUrl: string;
  skyUrls: Partial<Record<Phase, string>>;
  pauseLabel: string;
  resumeLabel: string;
  /** 一時停止のボタンの対象名（MOTION_PAUSE_TARGETS.atelier） */
  pauseTarget: string;
  walk: AtelierWalkCopy;
    /** 中央の前方に立たせる代表のアバター（spec §6.4）と、名札（site-content/atelier.ts の avatarName） */
    avatar?: AvatarFigureOptions;
  avatarName?: string;
  /** 押せる置き物・額と Tips（spec §6.3・§8） */
  touch?: AtelierTouchCopy;
  /** 展示の壁の額 frame_00〜06 に描く文字（null は無地の額。spec §8） */
  frames?: readonly (FrameArt | null)[];
}

const PAUSE_KEY = "motion:atelier";
const QUALITY_KEY = "atelier:quality";
/**
 * 一度でもカメラが動いたか（歩く・Tips から移る前の移動）。動いたら、そのセッションの間は文字の板を隠す（2026-10-30 ユーザーの指示）。
 * AtelierHero の inline script が最初の描画の前に読み、根に data-atelier-moved を付ける（読み込み直しで板が一瞬出ない）
 */
const MOVED_KEY = "atelier:moved";

function markMoved(root: HTMLElement | null) {
  if (!root || root.hasAttribute("data-atelier-moved")) return;
  root.setAttribute("data-atelier-moved", "");
  try {
    window.sessionStorage.setItem(MOVED_KEY, "1");
  } catch {
    // 残せなくても、このページの間は隠す
  }
}
const POS_KEY = "atelier:pos";
/** page-transition の VT.atelier と同じ名前（island から page-transition を読まないよう、値だけを持つ） */
const VT_NAME = "vt-atelier";
/** 解像度を決めるために測る時間（ms）。最初の 2 フレームはシェーダーの準備を含むので数えない */
const MEASURE_MS = 3000;
const MOBILE_QUERY = "(max-width: 767px)";
const PHASES: readonly Phase[] = ["morning", "day", "dusk", "night"];
/** 歩く速さ（レールの割合／秒。端から端まで約 15 秒）と加減速の時間（作り手の判断。spec §13） */
const WALK = { maxSpeed: 0.07, accelSec: 0.6, decelSec: 0.8 } as const;
/** 長押しと見なすまでの時間と、動いてよい距離（spec §6.2） */
const LONG_PRESS_MS = 300;
const LONG_PRESS_SLOP = 10;
/** 進んだ位置を残す間隔 */
const SAVE_EVERY_MS = 500;
/** 文字・ボタン・リンクなど、カーソルを乗せても歩かない所（Review Focus 1） */
/** 飛ぶ時間（DURATION.large）に足す余裕。描画が 1 フレームずつ遅れる端末でも、着いてから移れるように */
const FLIGHT_GRACE_MS = 400;
const UI_SELECTOR =
  "a, button, input, select, textarea, label, [data-atelier-ui], .atelier-hero__copy";

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

function readPos(): number {
  try {
    const value = Number(window.sessionStorage.getItem(POS_KEY));
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  } catch {
    return 0;
  }
}

function writePos(t: number) {
  try {
    window.sessionStorage.setItem(POS_KEY, t.toFixed(4));
  } catch {
    // 残せなくても歩ける（戻ってきたときに入口から描くだけ）
  }
}

/** head の inline script が付けた時間帯（無ければ昼。JS なしと同じ） */
function currentPhase(): Phase {
  const value = document.documentElement.dataset.atelierPhase as
    Phase | undefined;
  return value && PHASES.includes(value) ? value : "day";
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

/** 進む合図。いちばん強いものが勝つ（キー ＞ ボタンの行き先 ＞ 長押し・カーソル） */
interface Intent {
  pointer: 0 | 1;
  touch: 0 | 1;
  key: -1 | 0 | 1;
  /** 「前へ進む」「入口に戻る」の行き先（t）。着いたら null */
  goal: number | null;
  /** カーソルの左右（-1〜1） */
  look: number;
  /** 通りたい道（0＝右・1＝左。2026-10-30）。カーソル・長押しの左右、← → で決める */
  lane: 0 | 1;
}

/** 道を替えるのにかかる時間（秒）。横へなめらかに移る */
const LANE_SWITCH_SEC = 0.9;

export default function AtelierIsland({
  glbUrl,
  mobileGlbUrl,
  skyUrls,
  pauseLabel,
  resumeLabel,
  pauseTarget,
    walk,
    avatar,
  avatarName,
  touch,
  frames,
}: Props) {const reduced = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<AtelierScene | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [webgl, setWebgl] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [stateKnown, setStateKnown] = useState(false);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  /** 入口から離れたか（「入口に戻る」を出す） */
  const [away, setAway] = useState(false);
    const startedRef = useRef(false);
  /** アバターが立った（名札のボタンを出す） */
  const [avatarUp, setAvatarUp] = useState(false);
  const avatarButtonRef = useRef<HTMLButtonElement | null>(null);
    const lastMotionRef = useRef<MotionName | null>(null);
  /** Tips が開いている間は歩かない（Review Focus 1） */
  const tipsOpenRef = useRef(false);
  const onTipsOpenChange = useCallback((open: boolean) => {
    tipsOpenRef.current = open;
    if (open) intentRef.current.pointer = 0;
  }, []);
  const getScene = useCallback(() => sceneRef.current, []);
  const subscribeFrame = useCallback((fn: () => void) => {
    frameHooks.current.add(fn);
    return () => {
      frameHooks.current.delete(fn);
    };
  }, []);
  const walkerRef = useRef<Walker | null>(null);
  const intentRef = useRef<Intent>({
    pointer: 0,
    touch: 0,
    key: 0,
    goal: null,
    look: 0,
    lane: 0,
  });
  const lookRef = useRef(0);
  /** 今の道（0〜1。右の道 0 から左の道 1 へ、なめらかに移る） */
  const laneRef = useRef(0);
  const pausedRef = useRef(false);
  const visibleRef = useRef(false);
  const loopRef = useRef({
    raf: 0,
    running: false,
    measuring: false,
    measured: 0,
    samples: [] as number[],
    savedAt: 0,
  });
  // 毎フレームの合図（押せるものの位置。Task 6）
  const frameHooks = useRef(new Set<(dtMs: number) => void>());
  // 一時停止のボタンは、前のページで止めていたとき、水和の後に「止める」→「再開する」へ文字が替わる（MotionPause が sessionStorage を読む）。
  // 右寄せのボタンの幅が変わってずれ（CLS）にならないよう、替わり終わる 2 フレーム後まで見えなくしておく（第 1 版の教訓）
  const [pauseSettled, setPauseSettled] = useState(false);
  const disposedRef = useRef(false);
  const cancelRef = useRef<(() => void) | null>(null);

  pausedRef.current = userPaused;
  visibleRef.current = visible;

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
  const host = () =>
    rootRef.current?.closest<HTMLElement>('[data-motion="atelier"]') ?? null;

  // 読み込みは 1 回だけ。画面に入り、一時停止でなく、手が空いてから。取り消しは unmount のときだけ
  useEffect(() => {
    if (!live || !stateKnown || !visible || userPaused || startedRef.current)
      return;
    startedRef.current = true;
    cancelRef.current = whenIdle(() => {
      Promise.all([loadThree(), import("../lib/scene")])
        .then(async ([three, { createAtelierScene }]) => {
          const box = boxRef.current;
          if (!box || disposedRef.current) return;
          const canvas = document.createElement("canvas");
          canvas.setAttribute("aria-hidden", "true");
          canvas.className = "atelier__canvas";
          box.appendChild(canvas);
          canvasRef.current = canvas;
          const mobile = window.matchMedia(MOBILE_QUERY).matches;
          const scene = await createAtelierScene(three, canvas, {
            glbUrl: mobile ? mobileGlbUrl : glbUrl,
            skyUrls,
            phase: currentPhase(),
                        camera: "walk",
            avatar,
            // 額の文字は site-content が正本。描く書体はサイトの和文（書き出しの道具も同じ関数）
            frameTextures: (frames ?? []).map((art) => (art ? drawFrameArt(art, getComputedStyle(document.body).fontFamily) : null)),
          });
          if (disposedRef.current) {
            scene.dispose();
            return;
          }
          sceneRef.current = scene;
          const walker = createWalker({ ...WALK, start: readPos() });
          walkerRef.current = walker;
          scene.setWalk(walker.t, 0);
                    const root = host();
          if (root) {
            root.dataset.atelierT = walker.t.toFixed(3);
            root.dataset.atelierFrames = String(frames?.length ?? 0);
          }
          setAway(walker.t > 0.005);
          const q =
            readQuality() ??
            decideQuality([], {
              mobile,
              deviceDpr: window.devicePixelRatio || 1,
            });
          scene.resize(box.clientWidth, box.clientHeight, q.dpr);
          scene.render(0);
                    loopRef.current.measuring = readQuality() === null;
          scene.avatarReady.then((up) => {
            if (!up || disposedRef.current) return;
            setAvatarUp(true);
            host()?.setAttribute("data-atelier-avatar", "ready");
          });
          // 組み立てた直後の 1 枚が描かれてからポスターと入れ替える
          requestAnimationFrame(() =>
            requestAnimationFrame(() => setReady(true)),
          );
        })
        .catch((error: unknown) => {
          // 読み込みに失敗したらポスターのまま。原因を追えるようにコンソールには出す
          console.error("[atelier] 3D の読み込みに失敗しました", error);
          setFailed(true);
        });
    });
  }, [
    live,
    stateKnown,
    visible,
    userPaused,
    glbUrl,
    mobileGlbUrl,
    skyUrls,
    avatar,
  ]);

  useEffect(
    () => () => {
      disposedRef.current = true;
      cancelRef.current?.();
      cancelAnimationFrame(loopRef.current.raf);
      if (walkerRef.current) writePos(walkerRef.current.t);
      sceneRef.current?.dispose();
      sceneRef.current = null;
    },
    [],
  );

  /** いまの進む合図（-1・0・1）。ボタンの行き先は、止まるまでの距離を見て手前で合図をやめる（行き過ぎない） */
  const currentIntent = (walker: Walker): -1 | 0 | 1 => {
    const intent = intentRef.current;
    if (intent.key !== 0) return intent.key;
    if (intent.goal !== null) {
      const decel = WALK.maxSpeed / WALK.decelSec;
      const stopping = (walker.speed * walker.speed) / (2 * decel);
      const gap = intent.goal - walker.t;
      // 行き先のごく近く（レールの 0.2%）まで来たら合わせて終える（減速の見積もりの誤差で手前に止まり続けない）
      if (Math.abs(gap) <= 0.002) {
        walker.jumpTo(intent.goal);
        intent.goal = null;
        return 0;
      }
      // 止まるまでの距離に入ったら合図をやめて惰性で寄せる（行き過ぎない）。止まり切ったら、残りをまた歩く
      if (Math.abs(gap) <= stopping && walker.speed !== 0) return 0;
      return gap > 0 ? 1 : -1;
    }
    return intent.pointer || intent.touch ? 1 : 0;
  };

    /** 名札のボタンを、アバターの頭の上（anchor_avatar）に置く。画面の外・カメラの後ろなら隠す */
  const placeAvatarButton = () => {
    const button = avatarButtonRef.current;
    const scene = sceneRef.current;
    if (!button || !scene) return;
    const a = scene.projectAnchors().get("avatar");
    if (!a || !a.visible) {
      button.style.visibility = "hidden";
      return;
    }
    button.style.visibility = "";
    button.style.transform = `translate(${a.x}px, ${a.y}px)`;
  };

  /** 押すと、直前と違う身ぶりをランダムに 1 つ（spec §6.4）。再生中なら、今の身ぶりの後に再生する */
  const playAvatar = () => {
    const scene = sceneRef.current;
    if (!scene?.avatar) return;
    const name = pickMotion(lastMotionRef.current, Math.random);
    lastMotionRef.current = name;
    host()?.setAttribute("data-atelier-avatar-motion", name);
    scene.avatar.play(name).catch((error: unknown) => console.error("[atelier] 身ぶりを再生できませんでした", error));
    startLoop();
  };
  const playAvatarRef = useRef(playAvatar);
  playAvatarRef.current = playAvatar;

  // 描画の繰り返し。動いている間と、一時停止でも歩いている間だけ回す。最初の MEASURE_MS で端末の速さを測る（判定済みなら測らない）
  const startLoop = useCallback(() => {
    const scene = sceneRef.current;
    const walker = walkerRef.current;
    const state = loopRef.current;
    if (
      !scene ||
      !walker ||
      state.running ||
      !visibleRef.current ||
      disposedRef.current
    )
      return;
    state.running = true;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
            // 行き先に合わせる（jumpTo）のは currentIntent の中なので、その前の位置と比べる
      const before = walker.t;
      const intent = currentIntent(walker);
      walker.step(dt / 1000, intent);
      // 視線はゆっくり寄せる（カーソルの急な動きで景色を振らない）
      lookRef.current +=
        (intentRef.current.look - lookRef.current) * Math.min(1, dt / 400);
      // 道を替える（2 本が大きく離れている所〈アバターのそば〉では替えない。過ぎてから替える）
      const laneGoal = intentRef.current.lane;
      if (laneRef.current !== laneGoal && scene.rail.canSwitch(walker.t)) {
        const step = Math.min(1, dt / 1000 / LANE_SWITCH_SEC);
        laneRef.current =
          laneGoal > laneRef.current
            ? Math.min(laneGoal, laneRef.current + step)
            : Math.max(laneGoal, laneRef.current - step);
      }
      scene.setWalk(walker.t, lookRef.current, laneRef.current);
      const root = host();
      if (root) {
        if (walker.t !== before) root.dataset.atelierT = walker.t.toFixed(3);
        root.dataset.atelierLane = laneRef.current.toFixed(2);
        if (walker.speed !== 0) {
          root.setAttribute(
            "data-atelier-walking",
            walker.speed > 0 ? "forward" : "back",
          );
          markMoved(root);
        } else root.removeAttribute("data-atelier-walking");
      }
      if (walker.t > 0.005 !== before > 0.005) setAway(walker.t > 0.005);
      if (now - state.savedAt > SAVE_EVERY_MS && walker.t !== before) {
        state.savedAt = now;
        writePos(walker.t);
      }
            for (const fn of frameHooks.current) fn(dt);
      scene.render(dt);
      placeAvatarButton();
      if (
        state.measuring &&
        state.measured < MEASURE_MS &&
        !pausedRef.current
      ) {
        state.measured += dt;
        state.samples.push(dt);
        if (state.measured >= MEASURE_MS) {
          state.measuring = false;
          const mobile = window.matchMedia(MOBILE_QUERY).matches;
          const q = decideQuality(state.samples.slice(2), {
            mobile,
            deviceDpr: window.devicePixelRatio || 1,
          });
          writeQuality(q);
          if (!q.live) {
            state.running = false;
            setFailed(true);
            return;
          }
          const box = boxRef.current;
          if (box) scene.resize(box.clientWidth, box.clientHeight, q.dpr);
        }
      }
      // 一時停止の間は、歩いていなければ止める（星・待機の動きを止める）。画面外・タブ非表示でも止める
            const idle =
        pausedRef.current && intent === 0 && walker.speed === 0 && !scene.avatar?.playing && !host()?.hasAttribute("data-atelier-flying") &&
        (laneRef.current === intentRef.current.lane || !scene.rail.canSwitch(walker.t));
      if (idle || !visibleRef.current || disposedRef.current) {
        state.running = false;
        if (walker.t !== before || idle) writePos(walker.t);
        return;
      }
      state.raf = requestAnimationFrame(tick);
    };
    state.raf = requestAnimationFrame(tick);
  }, []);

  // 動かしてよい間は回す。止めたとき・画面外では tick が自分で止まる
  useEffect(() => {
    if (live && ready && visible && !userPaused) startLoop();
  }, [live, ready, visible, userPaused, startLoop]);

  // 大きさの変化（Desktop ⇔ Mobile をまたぐ変化を含む）
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !ready) return undefined;
    const observer = new ResizeObserver(() => {
      const scene = sceneRef.current;
      if (!scene) return;
      const mobile = window.matchMedia(MOBILE_QUERY).matches;
      scene.resize(
        box.clientWidth,
        box.clientHeight,
        readQuality()?.dpr ??
          decideQuality([], { mobile, deviceDpr: window.devicePixelRatio || 1 })
            .dpr,
      );
      // 止まっている間は毎フレームの合図が来ないので、ここで 1 枚描き直す（第 1 版の最終レビュー I-5）
            if (!loopRef.current.running) scene.render(0);
      placeAvatarButton();
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [ready]);

  // 歩く操作（マウス・長押し・キーボード）。ヒーローの区画で受ける
  useEffect(() => {
    const root = host();
    const hero = root?.closest<HTMLElement>("[data-atelier-hero]");
    if (!root || !hero || !ready || failed) return undefined;
    const intent = intentRef.current;
    const onUi = (target: EventTarget | null) =>
      target instanceof Element && !!target.closest(UI_SELECTOR);
    const local = (event: PointerEvent) => {
      const r = boxRef.current!.getBoundingClientRect();
      const x = event.clientX - r.left;
      const y = event.clientY - r.top;
      return {
        x,
        y,
        w: r.width,
        // 3D の箱の中で、3D の根（canvas・ポスター）の上にあるときだけ「空いた所」。1279px 以下は文字を 3D の下に積むので、
        // 文字のまわりの余白はヒーローの区画の中でも 3D の外（最終レビュー I-1）
        inside:
          x >= 0 && y >= 0 && x < r.width && y < r.height &&
          event.target instanceof Element && root.contains(event.target),
      };
    };
    const go = () => startLoop();

    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
            const p = local(event);
      const picked = onUi(event.target) || !p.inside ? null : (sceneRef.current?.pick(p.x, p.y) ?? null);
      // アバターの上では名札を出す（ボタンに乗せたときと同じ）
      if (picked === "avatar") avatarButtonRef.current?.setAttribute("data-hover", "");
      else avatarButtonRef.current?.removeAttribute("data-hover");
            if (onUi(event.target) || !p.inside || picked || tipsOpenRef.current) {
        intent.pointer = 0;
        intent.look = 0;
        return;
      }
      intent.pointer = 1;
      intent.goal = null;
      intent.look = Math.max(-1, Math.min(1, (p.x / p.w) * 2 - 1));
      // カーソルが画面の左半分なら左の道、右半分なら右の道を通る（2026-10-30）
      intent.lane = p.x < p.w / 2 ? 1 : 0;
      go();
    };
    const onLeave = () => {
      intent.pointer = 0;
      intent.look = 0;
    };

    let press: { id: number; x: number; y: number; timer: number } | null =
      null;
    const endPress = () => {
      if (press) window.clearTimeout(press.timer);
      press = null;
      intent.touch = 0;
    };
    const onDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || onUi(event.target)) return;
      const p = local(event);
      if (!p.inside || sceneRef.current?.pick(p.x, p.y)) return;
      endPress();
      // 長押しした所が左半分なら左の道、右半分なら右の道（2026-10-30）
      const lane: 0 | 1 = p.x < p.w / 2 ? 1 : 0;
      const timer = window.setTimeout(() => {
        intent.touch = 1;
        intent.goal = null;
        intent.lane = lane;
        go();
      }, LONG_PRESS_MS);
      press = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        timer,
      };
    };
    const onTouchMove = (event: PointerEvent) => {
      if (!press || event.pointerId !== press.id || intent.touch) return;
      if (
        Math.hypot(event.clientX - press.x, event.clientY - press.y) >
        LONG_PRESS_SLOP
      )
        endPress();
    };
    const onUp = (event: PointerEvent) => {
      if (press && event.pointerId === press.id) endPress();
    };
    // 長押しでブラウザーのメニューを出さない（文字の層は除く。選んでコピーできるように）
        // canvas の上のアバターを押した（タップした）ときも、ボタンと同じく身ぶり
    const onClick = (event: MouseEvent) => {
      if (onUi(event.target)) return;
      const r = boxRef.current!.getBoundingClientRect();
      if (sceneRef.current?.pick(event.clientX - r.left, event.clientY - r.top) === "avatar") playAvatarRef.current();
    };
    const onContext = (event: Event) => {if (!onUi(event.target)) event.preventDefault();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const arrows = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
      if (!arrows.includes(event.key)) return;
      if (
        event.target instanceof Element &&
        event.target.closest("input, textarea, select")
      )
        return;
      event.preventDefault();
      // ← → で通る道を替える（左の道・右の道。2026-10-30。2.1.1）
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        intent.lane = event.key === "ArrowLeft" ? 1 : 0;
        go();
        return;
      }
      intent.key = event.key === "ArrowUp" ? 1 : -1;
      intent.goal = null;
      go();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") intent.key = 0;
    };
    const onBlur = () => {
      intent.key = 0;
      intent.pointer = 0;
      endPress();
    };
    const onHide = () => {
      if (walkerRef.current) writePos(walkerRef.current.t);
    };

    hero.addEventListener("pointermove", onMove);
    hero.addEventListener("pointerleave", onLeave);
    hero.addEventListener("pointerdown", onDown);
    hero.addEventListener("pointermove", onTouchMove);
    hero.addEventListener("pointerup", onUp);
    hero.addEventListener("pointercancel", onUp);
        root.addEventListener("contextmenu", onContext);
    hero.addEventListener("click", onClick);
    hero.addEventListener("keydown", onKeyDown);
    hero.addEventListener("keyup", onKeyUp);
    hero.addEventListener("focusout", onBlur);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pagehide", onHide);
    return () => {
      endPress();
      hero.removeEventListener("pointermove", onMove);
      hero.removeEventListener("pointerleave", onLeave);
      hero.removeEventListener("pointerdown", onDown);
      hero.removeEventListener("pointermove", onTouchMove);
      hero.removeEventListener("pointerup", onUp);
      hero.removeEventListener("pointercancel", onUp);
            root.removeEventListener("contextmenu", onContext);
      hero.removeEventListener("click", onClick);
      hero.removeEventListener("keydown", onKeyDown);
      hero.removeEventListener("keyup", onKeyUp);
      hero.removeEventListener("focusout", onBlur);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pagehide", onHide);
    };
  }, [ready, failed, startLoop]);

    // Tips の「見る」（spec §9 の 3）: カメラが移り先の静止画と同じ位置・角度へ動き（DURATION.large・emphasized）、着いたら移る。
  // 移る直前に受け渡し（atelier:vt）を残し、pageswap で根に vt-atelier を付ける（遷移の間だけ。第 1 版の教訓: 付けっぱなしは
  // 重なりの層を作り、押せる部品が文字の下に回った）。reduced-motion・一時停止・カメラの移動中は、カメラを動かさずにすぐ移る（Review Focus 5）
  useEffect(() => {
    const root = host();
    if (!root || !ready || failed) return undefined;
    let flying = false;
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[data-atelier-tip-link]");
      if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const url = new URL(link.href, location.href);
      const to = pageKeyForPath(url.pathname);
      const scene = sceneRef.current;
      if (!to || to === "top" || !scene) return;
      writeVt(window.sessionStorage, { from: "top", to, phase: currentPhase(), at: Date.now() });
      if (reduced || pausedRef.current || flying) return; // 既定の移動に任せる
      event.preventDefault();
      flying = true;
      root.setAttribute("data-atelier-flying", to);
      markMoved(root);
      intentRef.current.pointer = 0;
      intentRef.current.goal = null;
      if (walkerRef.current) writePos(walkerRef.current.t);
      // 飛んでいる間に描画が止まっても（遅い端末の判定・失敗）、飛ぶ時間に余裕を足した上限で必ず移る（最終レビュー I-2）
      afterFlight(scene.flyTo(STILL_VIEWS[to].camera, DURATION.large), DURATION.large + FLIGHT_GRACE_MS)
        .then(() => {
          // 着いた瞬間の受け渡しの時刻（行き先は 2 秒以内のものだけを使う）
          writeVt(window.sessionStorage, { from: "top", to, phase: currentPhase(), at: Date.now() });
          location.href = url.href;
        });
      startLoop();
    };
    const onSwap = (event: Event) => {
      const swap = event as Event & { viewTransition?: unknown };
      if (swap.viewTransition && (root.hasAttribute("data-atelier-flying") || readPendingVt())) root.style.viewTransitionName = VT_NAME;
    };
    // bfcache から戻ったとき: 名前を外し、カメラを歩く位置へ戻す（同じ t から描く。Review Focus 4）
    const onShow = (event: PageTransitionEvent) => {
      root.style.viewTransitionName = "";
      root.removeAttribute("data-atelier-flying");
      flying = false;
      if (event.persisted) {
        sceneRef.current?.setCamera("walk");
        if (walkerRef.current) sceneRef.current?.setWalk(walkerRef.current.t, 0);
        sceneRef.current?.render(0);
      }
    };
    const readPendingVt = () => {
      try {
        return !!window.sessionStorage.getItem("atelier:vt");
      } catch {
        return false;
      }
    };
    root.addEventListener("click", onClick);
    window.addEventListener("pageswap", onSwap);
    window.addEventListener("pageshow", onShow);
    return () => {
      root.removeEventListener("click", onClick);
      window.removeEventListener("pageswap", onSwap);
      window.removeEventListener("pageshow", onShow);
    };
  }, [ready, failed, reduced, startLoop]);

  // 「前へ進む」の長押し（2026-10-30 ユーザーの指示）: LONG_PRESS_MS 以上押している間だけ進み、離すと止まる（次の止まる所へは行かない）。
  // 短く押す・Enter（click）は今までどおり次の止まる所まで。長押しの後に来る click は、行き先へ進ませない
  const holdRef = useRef<{ timer: number; held: boolean } | null>(null);
  const startHold = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    endHold();
    // 押している間はこのボタンが指・カーソルを持つ（歩き出すと左に「入口に戻る」が出てボタンがずれ、カーソルが外れたことになって止まった）
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const hold = {
      held: false,
      timer: window.setTimeout(() => {
        hold.held = true;
        intentRef.current.goal = null;
        intentRef.current.key = 1;
        startLoop();
      }, LONG_PRESS_MS),
    };
    holdRef.current = hold;
  };
  /** 指・ボタンを離した（または外れた）。押している間だけの合図を止める。長押しだったかは click のために残す */
  const endHold = () => {
    const hold = holdRef.current;
    if (!hold) return;
    window.clearTimeout(hold.timer);
    if (hold.held && intentRef.current.key === 1) intentRef.current.key = 0;
  };
  const onForwardClick = () => {
    const held = holdRef.current?.held;
    holdRef.current = null;
    if (!held) goTo("next");
  };

  const goTo = (target: "next" | "start") => {
    const walker = walkerRef.current;
    const scene = sceneRef.current;
    if (!walker || !scene) return;
    if (target === "start") {
      // 入口へはワープする（歩いて戻らない。2026-10-30 ユーザーの指示）。押したその場で位置と印を替え、1 枚描く
      intentRef.current.goal = null;
      walker.jumpTo(0);
      scene.setWalk(0, lookRef.current);
      const root = host();
      if (root) {
        root.dataset.atelierT = (0).toFixed(3);
        root.removeAttribute("data-atelier-walking");
      }
      setAway(false);
      writePos(0);
      scene.render(0);
      startLoop();
      return;
    }
    intentRef.current.goal = scene.rail.nextStop(walker.t);
    startLoop();
  };

  // 遅い端末・失敗: canvas を外し、三次元の資源を返す（ポスターのまま）
  useEffect(() => {
    if (!failed) return;
    cancelAnimationFrame(loopRef.current.raf);
    loopRef.current.running = false;
    sceneRef.current?.dispose();
    sceneRef.current = null;
    canvasRef.current?.remove();
    canvasRef.current = null;
    setReady(false);
  }, [failed]);

  // ポスターとの入れ替え・止まっているかを、根（[data-motion="atelier"]）の属性で伝える（CSS・e2e が読む）
  useEffect(() => {
    const root = host();
    if (!root) return;
    // 動けない（reduced-motion・WebGL なし・遅い端末・失敗）ときは、動いた記録があっても文字の板を隠さない（ポスターの上に文字が要る）
    if (stateKnown && !live) root.removeAttribute("data-atelier-moved");
    if (ready && !failed) root.setAttribute("data-atelier-live", "true");
    else {
      root.removeAttribute("data-atelier-live");
      root.removeAttribute("data-atelier-walking");
    }
    if (live) root.setAttribute("data-motion-paused", String(userPaused));
    else root.removeAttribute("data-motion-paused");
  }, [ready, failed, live, userPaused, stateKnown]);

  const showControls = ready && !failed;

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0">
      <div
        ref={boxRef}
        aria-hidden="true"
        className="atelier__box absolute inset-0"
      />
            {showControls && avatarUp && avatarName && (
        <button
          ref={(el) => {
            avatarButtonRef.current = el;
            if (el) placeAvatarButton();
          }}
          type="button"
          data-atelier-ui
          className="atelier__avatar"
          onClick={playAvatar}
        >
          <span className="atelier__avatar-dot" aria-hidden="true" />
          <span className="atelier__avatar-label type-small" data-atelier-avatar-label>
            {avatarName}
          </span>
        </button>
      )}
            {showControls && touch && (
        <AtelierTouch
          copy={touch}
          phase={currentPhase()}
          boxRef={boxRef}
          getScene={getScene}
          subscribeFrame={subscribeFrame}
          onOpenChange={onTipsOpenChange}
        />
      )}
      {showControls && (
        <div data-atelier-ui className="atelier__controls">
          <p className="atelier__hint type-small">{walk.hint}</p>
          <div className="atelier__buttons">
            {away && (
              <button
                type="button"
                className="atelier__button"
                onClick={() => goTo("start")}
              >
                {walk.back}
              </button>
            )}
            <button
              type="button"
              className="atelier__button"
              onClick={onForwardClick}
              onPointerDown={startHold}
              onPointerUp={endHold}
              onPointerCancel={() => {
                endHold();
                holdRef.current = null;
              }}
              onLostPointerCapture={endHold}
              onContextMenu={(event) => event.preventDefault()}
            >
              {walk.forward}
            </button>
          </div>
        </div>
      )}
      {live && stateKnown && (
        <div
          data-atelier-ui
          className="atelier__pause pointer-events-auto absolute right-4 bottom-4 z-[3] md:right-6 md:bottom-6"
          style={pauseSettled ? undefined : { visibility: "hidden" }}
          ref={(el) => {
            // rAF を使わない（「rAF が 0」を見るほかの部品の検査に、待機中の rAF を混ぜない）。約 2 フレームの間
            if (el && !pauseSettled)
              window.setTimeout(() => setPauseSettled(true), 34);
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
