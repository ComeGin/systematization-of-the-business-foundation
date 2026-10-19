// MotionBlobs の island（MetaBalls ＋ MotionPause）。MotionBlobs.astro からだけ使う。
// 静止の SVG（粒が 1 つに寄り合った形）を出し、WebGL で描けたら canvas に替える（規則 5）。reduced-motion のときは静止の SVG のまま（規則 4）。
// 5 秒を超えて自動で動くので MotionPause を付ける（規則 3・2.2.2）。画面外・タブ非表示・一時停止の間は rAF を止める（規則 6）。
// バナー（置き場所の aside）に hover か キーボードのフォーカスが入ると、粒が寄り合って 1 つになる（規則 8。「一緒に考える」）。
import { useEffect, useRef, useState } from "react";
import { MotionPause, useReducedMotion } from "@/modules/a11y/client";
import MetaBalls from "../vendor/react-bits/MetaBalls/MetaBalls";
import { cssColor } from "../lib/tokens";
import { useVisible } from "../lib/use-visible";

interface Props {
  pauseLabel: string;
  resumeLabel: string;
  /** 一時停止のボタンの対象名（名前を、ヒーローの一時停止のボタンと分ける） */
  pauseTarget: string;
  /** true のとき、自前の一時停止のボタンを出さず、最寄りの [data-motion-paused] に従って止まる（A の CTA。CtaGlow のボタンが付け外しする） */
  externalPause?: boolean;
}

const STORAGE_KEY = "motion:cta-blobs";
// 粒を置く箱の最小の幅。これより狭いときは置かない（文字の後ろに回らないように）
const MIN_WIDTH = 120;
// 文字・CTA から空ける幅
const GAP = 24;

interface Area {
  left: number;
  width: number;
}

/**
 * 粒の置き場所を測る。CTA を中心に左右同じ幅の箱にし、粒が寄り合うと CTA の後ろへ吸い込まれて見えるようにする（G-1 で承認）。
 * 左の端は文字の右端から GAP、右の端はバナーの右端までに収める（文字の後ろに回らない）。CTA が文字の下にある（縦積み）・狭いときは null
 */
function measureArea(root: HTMLElement): Area | null {
  const host = root.closest("aside");
  if (!host) return null;
  const hostRect = host.getBoundingClientRect();
  const cta = Array.from(host.querySelectorAll<HTMLElement>("a, button")).find((el) => !root.contains(el));
  if (!cta) return null;
  let textRight = hostRect.left;
  const range = document.createRange();
  for (const el of Array.from(host.querySelectorAll("h2, h3, p"))) {
    if (root.contains(el)) continue;
    range.selectNodeContents(el);
    for (const rect of Array.from(range.getClientRects())) textRight = Math.max(textRight, rect.right);
  }
  const ctaRect = cta.getBoundingClientRect();
  const center = ctaRect.left + ctaRect.width / 2;
  const half = Math.min(center - (textRight + GAP), hostRect.right - center);
  if (ctaRect.left - GAP < textRight || half * 2 < MIN_WIDTH) return null;
  return { left: center - half - hostRect.left, width: half * 2 };
}

export default function BlobsIsland({ pauseLabel, resumeLabel, pauseTarget, externalPause = false }: Props) {
  const reduced = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const visible = useVisible(rootRef);
  const [colors, setColors] = useState<{ ball: string; cursor: string } | null>(
    null,
  );
  const [userPaused, setUserPaused] = useState(false);
  // externalPause のとき、止める手段（CtaGlow の一時停止のボタン）が水和して aside に data-motion-ready="true" が付くまでは動かさない
  // （光の縁・粒の CSS が ready まで止まっているのと同じ。止められない動きを出さない。2.2.2）。externalPause でなければ常に true
  const [externalReady, setExternalReady] = useState(!externalPause);
  const [ready, setReady] = useState(false);
  // 一度でも動き始めたか。止めた状態で開いたページ（sessionStorage）では、動かないまま canvas を出さず静止の SVG を見せる
  const [started, setStarted] = useState(false);
  const [gathered, setGathered] = useState(false);
  // 粒を置く場所。CTA を中心に、実際の文字の右端に掛からない幅で決める（幅や文言が変わっても追従する）
  const [area, setArea] = useState<Area | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    const host = root?.closest("aside");
    if (!root || !host) return undefined;
    const update = () => setArea(measureArea(root));
    const observer = new ResizeObserver(update);
    observer.observe(host);
    void document.fonts?.ready.then(update);
    update();
    return () => observer.disconnect();
  }, []);

  // 色（WebGL へは計算後の #hex）と、前のページで止めたかどうか（MotionPause と同じキー）を、動かし始める前に読む
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(STORAGE_KEY) === "paused")
        setUserPaused(true);
    } catch {
      // sessionStorage が使えないときは動かす（ボタンで止められる）
    }
    setColors({
      ball: cssColor("--color-brand-navy-500"),
      cursor: cssColor("--color-brand-navy-600"),
    });
  }, []);

  useEffect(() => {
    if (ready && !userPaused && externalReady) setStarted(true);
  }, [ready, userPaused, externalReady]);

  // externalPause: 一時停止のボタンは別の部品（CtaGlow）にある。最寄りの [data-motion-paused] の値に従って止める。
  // 属性はボタンが水和して初めて付くので、まだ無いうちは何もしない（前のページで止めた記憶は上の sessionStorage の読みが先に反映する）。
  // 属性が付く前は最寄りが無いので、バナーの aside を見張る（属性は aside に付く）。data-motion-ready="true" が付くまでは動かさない
  useEffect(() => {
    if (!externalPause) return undefined;
    const root = rootRef.current;
    const host = root?.closest("aside");
    if (!root || !host) return undefined;
    const sync = () => {
      const value = root
        .closest("[data-motion-paused]")
        ?.getAttribute("data-motion-paused");
      if (value === "true") setUserPaused(true);
      else if (value === "false") setUserPaused(false);
      setExternalReady(host.getAttribute("data-motion-ready") === "true");
    };
    const observer = new MutationObserver(sync);
    observer.observe(host, {
      attributes: true,
      attributeFilter: ["data-motion-paused", "data-motion-ready"],
    });
    sync();
    return () => observer.disconnect();
  }, [externalPause]);

  // 置き場所のバナーに hover・フォーカスが入ったら寄り合う（一時停止のボタンへのフォーカスは除く）
  useEffect(() => {
    const host = rootRef.current?.closest("aside");
    if (!host) return undefined;
    // 一時停止のボタンは準備ができてから出るので、その都度探す
    // externalPause のときのボタンは CtaGlow の中にある
    const isPause = (el: EventTarget | null) =>
      el !== null &&
      (el === rootRef.current?.querySelector("button") ||
        (el instanceof Element &&
          el.closest('[data-motion="cta-glow"]') !== null));
    const onEnter = () => setGathered(true);
    const onLeave = () =>
      setGathered(
        host.contains(document.activeElement) &&
          !isPause(document.activeElement),
      );
    const onFocusIn = (event: FocusEvent) =>
      setGathered(!isPause(event.target));
    const onFocusOut = (event: FocusEvent) => {
      if (!host.contains(event.relatedTarget as Node | null))
        setGathered(host.matches(":hover"));
    };
    host.addEventListener("pointerenter", onEnter);
    host.addEventListener("pointerleave", onLeave);
    host.addEventListener("focusin", onFocusIn);
    host.addEventListener("focusout", onFocusOut);
    return () => {
      host.removeEventListener("pointerenter", onEnter);
      host.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("focusin", onFocusIn);
      host.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  const live = !reduced && colors !== null && area !== null;
  const showCanvas = live && ready && started;

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-0"
      data-motion="blobs"
    >
      {area && (
      <div
        aria-hidden="true"
        className="absolute inset-y-0 z-0 overflow-hidden"
        style={{ left: area.left, width: area.width }}
      >
        <svg
          viewBox="0 0 120 60"
          preserveAspectRatio="xMidYMid meet"
          className="absolute inset-0 h-full w-full transition-opacity duration-[var(--motion-duration-medium)] ease-[var(--motion-ease-standard)]"
          style={{ opacity: showCanvas ? 0 : 1 }}
        >
          <circle cx="60" cy="30" r="14" fill="var(--color-brand-navy-500)" />
          <circle cx="73" cy="21" r="7" fill="var(--color-brand-navy-500)" />
          <circle cx="72" cy="40" r="6" fill="var(--color-brand-navy-600)" />
          <circle cx="48" cy="21" r="5" fill="var(--color-brand-navy-500)" />
        </svg>
        {live && (
          <div
            className="absolute inset-0 transition-opacity duration-[var(--motion-duration-medium)] ease-[var(--motion-ease-standard)]"
            style={{ opacity: showCanvas ? 1 : 0 }}
          >
            <MetaBalls
              color={colors.ball}
              cursorBallColor={colors.cursor}
              speed={0.3}
              enableMouseInteraction={false}
              animationSize={20}
              ballCount={8}
              clumpFactor={gathered ? 0.2 : 1.3}
              cursorBallSize={2.5}
              enableTransparency
              variant="solid"
              motion="orbit"
              clickBurst={false}
              paused={userPaused || !visible || !externalReady}
              dpr={1.5}
              onReady={() => setReady(true)}
            />
          </div>
        )}
      </div>
      )}
      {live && ready && !externalPause && (
        <div className="pointer-events-auto absolute right-3 bottom-3 z-[2]">
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
