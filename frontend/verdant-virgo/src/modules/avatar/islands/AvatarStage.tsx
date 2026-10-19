// アバターの island（AvatarDock.astro からだけ使う。client:idle）。画面の左下で、背景が透明な canvas に全身を描き、ページ・操作の合図でエモートする（設計書 §7）。
// 出し方（§7.3）:
//   - reduced-motion・WebGL なし: three を読まず、静止画（stillUrl の <img alt="">）だけ。一時停止のボタンも出さない（動かないため）。
//   - Mobile（max-width 767px か pointer: coarse）: 最初はアイコン（iconUrl）のボタン「アバターを表示する」だけ。押したら three とモデルを読む（約 4MB を勝手に読まない）。
//   - たたんだ（sessionStorage avatar:collapsed）・一時停止で開いたページ（motion:avatar）: three を読まない。出す・再開を押したら読む。
//   - 読み込みの間と失敗したときは静止画を出し、描けたら canvas に替える。
//   - Mobile で出した後（R19）: 高さは 120px（会社紹介のメンバーの節と同じ data-avatar-small）。スクロールしている間は左の画面の外へ逃がし
//     （data-avatar-away。CSS の transform）、止まって 600ms で戻す（lib/scroll-away.ts）。逃がしている間は描画を止め、合図も受理しない。
// perf: three は loadThree()（motion）の 1 つのチャンクから、描画の部品（lib/stage.ts。GLTFLoader・three-vrm）は動的 import で、出すと決めたときだけ読む。
//       画面外・タブ非表示・一時停止・たたんだ間は rAF を止める（runWhenVisible。規則 6）。
// a11y: canvas と静止画は装飾（aria-hidden・alt=""）。5 秒を超えて動く（待機の呼吸・まばたき）ので MotionPause を付ける（2.2.2。motion:avatar）。
//       一時停止の間は、まばたき・呼吸を含めて最後の姿勢で止まる。フォームの入力欄・送信ボタンやフォーカスした要素にアバターが重なるときは、
//       保存しない一時的なたたみ方をする（2.4.11）。canvas と静止画はポインターを通す（下の本文のリンクを押せる）。
// 文言は props で受ける（既定値を持たない。H-16）。
import { Minimize2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MotionPause, useReducedMotion } from "@/modules/a11y/client";
import {
  canUseWebGL,
  loadThree,
  runWhenVisible,
  type LiveZone,
} from "@/modules/motion/client";
import { createEmoteScheduler, type EmoteScheduler } from "../lib/emotes";
import {
  readCollapsed,
  readGreeted,
  writeCollapsed,
  writeGreeted,
} from "../lib/prefs";
import { watchScrollAway } from "../lib/scroll-away";
import type { AvatarRuntime, ClipName } from "../lib/stage";
import { watchTriggers } from "../lib/triggers";
import type { AvatarLabels, AvatarTrigger, EmoteId } from "../lib/types";

interface Props {
  zone: LiveZone;
  modelUrl: string;
  motionUrls: Record<ClipName, string>;
  stillUrl: string;
  iconUrl: string;
  labels: AvatarLabels;
  /** 一時停止のボタンの対象名（MotionPause の target。site-content の MOTION_PAUSE_TARGETS.avatar） */
  pauseTarget: string;
  /** エモートごとのクリップの長さ（ms。切り上げ）。その再生中は次の合図を受けない（AvatarDock がビルド時に JSON から求める。R18） */
  durationsMs: Partial<Record<EmoteId, number>>;
}

declare global {
  interface Window {
    /** 最後に再生したエモートの名前（e2e が読む。個人の情報は入れない） */
    __avatar?: { lastEmote: EmoteId | null };
  }
}

const STORAGE_KEY = "motion:avatar";
const MOBILE_QUERY = "(max-width: 767px), (pointer: coarse)";
/** フォーカスが入ったときにアバターと重ならないかを見る要素 */
const FORM_CONTROL = "form :is(input, textarea, select, button)";

type Phase = "none" | "loading" | "ready" | "failed";

interface Env {
  mobile: boolean;
}

function readPaused(): boolean {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) === "paused";
  } catch {
    return false;
  }
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const overlaps = (a: Box, b: Box) =>
  a.right > a.left &&
  b.right > b.left &&
  a.left < b.right &&
  b.left < a.right &&
  a.top < b.bottom &&
  b.top < a.bottom;

/**
 * 枠の定位置の矩形。Mobile でスクロールしている間に横へ逃がす transform（data-avatar-away。トランジションの途中を含む）の分を戻す。
 * 逃がしている間にフォーカスが入っても、戻った後に重なるかで判定するため（2.4.11）。同意バナーの translate は本当の位置なので戻さない
 */
function homeRect(frame: Element): Box {
  const rect = frame.getBoundingClientRect();
  const host = frame.closest('[data-motion="avatar"]');
  const transform = host ? getComputedStyle(host).transform : "none";
  const matrix =
    transform && transform !== "none" ? new DOMMatrixReadOnly(transform) : null;
  const dx = matrix?.m41 ?? 0;
  const dy = matrix?.m42 ?? 0;
  return {
    left: rect.left - dx,
    right: rect.right - dx,
    top: rect.top - dy,
    bottom: rect.bottom - dy,
  };
}

/** アイコン（たたんだとき・Mobile の最初）の大きさ（px）。枠の左下に置く */
const ICON_PX = 56;

/** フォーカスした要素と重なるもの。panel＝出ているアバター（枠全体）、icon＝左下のアイコンにも重なる */
type FocusHit = "none" | "panel" | "icon";

export default function AvatarStage({
  zone,
  modelUrl,
  motionUrls,
  stillUrl,
  iconUrl,
  labels,
  pauseTarget,
  durationsMs,
}: Props) {
  const reduced = useReducedMotion();
  const [env, setEnv] = useState<Env | null>(null);
  const [summoned, setSummoned] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  // フォーカスした要素と重なるための一時的なたたみ（保存しない）
  const [focusHit, setFocusHit] = useState<FocusHit>("none");
  const [userPaused, setUserPaused] = useState(false);
  const [phase, setPhase] = useState<Phase>("none");
  const [visible, setVisible] = useState(false);
  // 会社紹介のメンバー（代表の写真）が見えている間は小さくする（§7.4）
  const [teamVisible, setTeamVisible] = useState(false);
  // Mobile でスクロールしている間は左の画面の外へ逃がす（R19。保存しない）
  const [away, setAway] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<AvatarRuntime | null>(null);
  const schedulerRef = useRef<EmoteScheduler | null>(null);
  const activeRef = useRef(false);
  const unmountedRef = useRef(false);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<"collapse" | "expand" | null>(null);

  useEffect(() => {
    const mobile = window.matchMedia(MOBILE_QUERY).matches;
    setEnv({ mobile });
    setSummoned(!mobile);
    setCollapsed(readCollapsed());
    setUserPaused(readPaused());
  }, []);

  // WebGL が使えるかは three を読む直前に確かめる（reduced-motion・Mobile の押す前では GL のコンテキストを作らない）。使えなければ phase が failed
  const live = env !== null && !reduced;
  const shown = summoned && !collapsed && focusHit === "none";
  const active =
    live && phase === "ready" && shown && visible && !userPaused && !away;
  // 小さくする理由は 2 つ（会社紹介のメンバーの節・Mobile）。どちらかなら小さい（R19。Mobile では節を出入りしても小さいまま）
  const small = teamVisible || env?.mobile === true;

  // 読み込みは 1 回だけ。出ていて・一時停止でなく・動かしてよいときに始める。取り消しは unmount のときだけ
  useEffect(() => {
    if (!live || !shown || userPaused || phase !== "none") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!canUseWebGL()) {
      // WebGL が無ければ静止画のまま（three を取りに行かない。一時停止のボタンも外す）
      setPhase("failed");
      return;
    }
    setPhase("loading");
    Promise.all([loadThree(), import("../lib/stage")])
      .then(([three, stage]) =>
        stage.createAvatarRuntime({
          three,
          canvas,
          zone,
          modelUrl,
          motionUrls,
        }),
      )
      .then((runtime) => {
        // 読み込みの間に外された（ページを移った）ら、後から来た描画を捨てる
        if (unmountedRef.current) {
          runtime.dispose();
          return;
        }
        runtimeRef.current = runtime;
        runtime.renderOnce();
        setPhase("ready");
      })
      .catch((error: unknown) => {
        // 読めなければ静止画のまま（一時停止のボタンも外す）。原因を追えるようにコンソールには出す
        console.error("[avatar] 3D の読み込みに失敗しました", error);
        setPhase("failed");
      });
  }, [live, shown, userPaused, phase, zone, modelUrl, motionUrls]);

  useEffect(
    () => () => {
      unmountedRef.current = true;
      runtimeRef.current?.dispose();
      runtimeRef.current = null;
    },
    [],
  );

  // 見えているか（画面内かつタブが表示中）。たたむと hidden になり、見えていない扱いになる
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    return runWhenVisible(el, setVisible);
  }, [summoned]);

  useEffect(() => {
    activeRef.current = active;
    runtimeRef.current?.setActive(active);
  }, [active]);

  // 合図 → エモート。受理したかを返す（受理しなかった料金の節・idle は、triggers が後で出し直す。R18）。
  // 動いていない間（一時停止・たたんだ・画面外）と再生中の合図は受理しない。着いたときの挨拶はセッションで 1 回（R17）。
  // 挨拶を済ませた印と window.__avatar は、再生できてから書く（クリップが読めなかったら書かない）
  const onTrigger = useCallback(
    (trigger: AvatarTrigger): boolean => {
      const runtime = runtimeRef.current;
      if (!runtime || !activeRef.current) return false;
      // 挨拶を済ませたセッションの arrive は「済んだ」として受理する（出し直さない）
      if (trigger === "arrive" && readGreeted()) return true;
      schedulerRef.current ??= createEmoteScheduler(zone, { durationsMs });
      const emote = schedulerRef.current.request(trigger, performance.now());
      if (!emote) return false;
      runtime
        .play(emote)
        .then((played) => {
          if (!played) return;
          if (emote === "greeting") writeGreeted();
          window.__avatar = { lastEmote: emote };
        })
        .catch((error: unknown) => {
          console.error(
            "[avatar] エモートを再生できませんでした",
            emote,
            error,
          );
        });
      return true;
    },
    [zone, durationsMs],
  );

  useEffect(() => {
    if (phase !== "ready") return undefined;
    return watchTriggers(zone, onTrigger);
  }, [phase, zone, onTrigger]);

  // 会社紹介のメンバーの節が見えている間は小さく
  useEffect(() => {
    const team = document.querySelector('[data-avatar-cue="team"]');
    if (!team || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver((entries) =>
      setTeamVisible(entries.some((entry) => entry.isIntersecting)),
    );
    observer.observe(team);
    return () => observer.disconnect();
  }, []);

  // Mobile で出した後は、スクロールしている間だけ左の画面の外へ逃がす（R19）。Desktop は逃がさない。
  // a11y: アバターのボタンに見えるフォーカス（:focus-visible）がある間は逃がさない（2.4.7）。
  //       見えるフォーカスに限るのは、タップで「アバターを表示する」を押すとフォーカスがたたむボタンへ移り（キーボードの人のため）、
  //       タッチのスクロールではフォーカスが動かないので、そのままでは一度も逃がせなくなるため（タップの後のフォーカスにはリングが出ない）
  useEffect(() => {
    if (!env?.mobile || !summoned) return undefined;
    const stop = watchScrollAway({
      canHide: () => {
        const focused = document.activeElement;
        return !(
          focused &&
          rootRef.current?.contains(focused) &&
          focused.matches(":focus-visible")
        );
      },
      onChange: setAway,
    });
    return () => {
      stop();
      setAway(false);
    };
  }, [env, summoned]);

  // a11y: フォームの入力欄・送信ボタン、またはキーボードでフォーカスした要素にアバターの矩形が重なるなら、一時的にたたむ（2.4.11）
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      const root = rootRef.current;
      if (!(target instanceof Element) || !root) return;
      if (root.contains(target)) {
        // フォーカスがアバターのボタンに来たら、隠していたアイコンを見せる（たたんだ状態はそのまま。ボタンを DOM から外さない）
        setFocusHit((hit) => (hit === "icon" ? "panel" : hit));
        return;
      }
      const watched =
        target.matches(FORM_CONTROL) || target.matches(":focus-visible");
      if (!watched) {
        setFocusHit("none");
        return;
      }
      // 枠（出ているときのアバターと操作の列の範囲）と、その左下のアイコンの範囲のそれぞれと比べる。
      // 枠は定位置で見る（逃がしている間の transform を含めると、戻った後に重なるのを見落とす。R19）
      const frame = homeRect(root);
      const icon = {
        left: frame.left,
        right: frame.left + ICON_PX,
        top: frame.bottom - ICON_PX,
        bottom: frame.bottom,
      };
      const rect = target.getBoundingClientRect();
      setFocusHit(
        overlaps(icon, rect)
          ? "icon"
          : overlaps(frame, rect)
            ? "panel"
            : "none",
      );
    };
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget === null) setFocusHit("none");
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  // たたむ・出すのボタンで消えたボタンのフォーカスを、入れ替わったボタンへ移す
  useEffect(() => {
    if (focusAfter.current === "collapse") expandRef.current?.focus();
    if (focusAfter.current === "expand") collapseRef.current?.focus();
    focusAfter.current = null;
  });

  // 根に状態を出す（CSS と e2e が読む）
  useEffect(() => {
    const host = rootRef.current?.closest<HTMLElement>(
      '[data-motion="avatar"]',
    );
    if (!host) return;
    host.setAttribute("data-avatar-state", phase);
    if (small) host.setAttribute("data-avatar-small", "true");
    else host.removeAttribute("data-avatar-small");
    if (away) host.setAttribute("data-avatar-away", "true");
    else host.removeAttribute("data-avatar-away");
  }, [phase, small, away]);

  if (env === null) return null;

  const collapse = () => {
    writeCollapsed(true);
    setCollapsed(true);
    focusAfter.current = "collapse";
  };
  const expand = () => {
    writeCollapsed(false);
    setCollapsed(false);
    setFocusHit("none");
    focusAfter.current = "expand";
  };
  const summon = () => {
    setSummoned(true);
    setCollapsed(false);
    writeCollapsed(false);
    focusAfter.current = "expand";
  };

  const iconButton = "avatar-dock__icon pointer-events-auto";
  // canvas は、読み込みを始める（出ていて一時停止でない）か、読み込みを始めた後だけ置く（止めた・たたんだまま開いたページには置かない）。
  // 一度置いたら外さない（描画の部品が同じ canvas を持ち続ける）。途中で reduced-motion になったら隠して静止画に戻す
  const showCanvas =
    phase === "loading" ||
    phase === "ready" ||
    (live && phase === "none" && shown && !userPaused);
  const canvasReady = live && phase === "ready";

  return (
    <div ref={rootRef} className="avatar-dock__frame">
      {!summoned && (
        <button
          type="button"
          ref={expandRef}
          className={iconButton}
          data-hidden={focusHit === "icon" || undefined}
          aria-label={labels.summon}
          onClick={summon}
        >
          <img src={iconUrl} alt="" width={56} height={56} />
        </button>
      )}
      {summoned && !shown && (
        <button
          type="button"
          ref={expandRef}
          className={iconButton}
          data-hidden={focusHit === "icon" || undefined}
          aria-label={labels.expand}
          onClick={expand}
        >
          <img src={iconUrl} alt="" width={56} height={56} />
        </button>
      )}
      {summoned && (
        <div className="avatar-dock__panel" hidden={!shown}>
          <div ref={stageRef} className="avatar-dock__stage">
            {!canvasReady && (
              <img className="avatar-dock__still" src={stillUrl} alt="" />
            )}
            {showCanvas && (
              <canvas
                ref={canvasRef}
                aria-hidden="true"
                hidden={!live}
                className="avatar-dock__canvas"
                style={{ opacity: canvasReady ? 1 : 0 }}
              />
            )}
          </div>
          <div className="avatar-dock__controls pointer-events-auto">
            {/* たたむボタンを左に置く（一時停止のボタンは「止める」⇔「再開する」で幅が変わるので、右の端に置いてほかを動かさない。CLS） */}
            <button
              type="button"
              ref={collapseRef}
              className={cn(
                buttonVariants({ variant: "outline", size: "icon" }),
              )}
              aria-label={labels.collapse}
              onClick={collapse}
            >
              <Minimize2 aria-hidden="true" className="size-4" />
            </button>
            {live && phase !== "failed" && (
              <MotionPause
                pauseLabel={labels.pause}
                resumeLabel={labels.resume}
                storageKey={STORAGE_KEY}
                target={pauseTarget}
                onToggle={setUserPaused}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
