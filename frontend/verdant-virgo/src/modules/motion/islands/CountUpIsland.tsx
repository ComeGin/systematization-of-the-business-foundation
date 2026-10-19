// CountUp の island（CountUp.astro からだけ使う）。B（calm）の数え上げ。
// 最終値の文字は最初の HTML に入っていて、読み上げはこれだけ。数え上げは aria-hidden の重ねた数字（ticker）で行う。
// 状態（data-count-state）:
//   なし（idle。最初の HTML・水和の前）… 最終値の文字。CSS が、JS が使えて reduced-motion でないときだけ clip-path で見えなくする
//                                  （水和した直後に 0 へ戻る揺れを出さないため。読み上げには残る。水和が来ないときの安全策は CountUp.astro）
//   static … 水和したが動かさない（reduced-motion・IntersectionObserver なし）。最終値が見える
//   armed … 水和した。まだ画面の外。ticker は 0 から待つ
//   counting … 画面に入った。ticker が上がる。最終値の文字は見えなくするが、読み上げには残す
//   done … 最終値だけ
// 数え上げは画面に入ったとき 1 回だけ（done から戻らない）。rAF は数えている間（--motion-duration-large の 2 倍）だけ使う。
// a11y: reduced-motion では何もしない（最終値のまま。rAF も使わない）。ticker は aria-hidden で、最終値の文字は clip-path で隠すだけなので読み上げに残る。
// 設定の判定は水和の最初の描画（useReducedMotion は true を返す）を挟まず、effect の中で直接読む（idle → static → armed の途中の描画を出さない）。
import { useEffect, useRef, useState } from "react";
import {
  onReducedMotionChange,
  prefersReducedMotion,
} from "@/modules/a11y/client";
import { formatCount } from "../lib/count";
import { DURATION, easing } from "../lib/tokens";

interface Props {
  /** 最終値の文字（"72.2%"） */
  value: string;
  className?: string;
}

type Phase = "idle" | "static" | "armed" | "counting" | "done";

// 数え上げの時間。--motion-duration-large の 2 倍（新しい値を足さない）
const COUNT_MS = DURATION.large * 2;
const ease = easing("emphasized");

export default function CountUpIsland({ value, className }: Props) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);

  // 水和したら、動かさないなら static、動かすなら armed にし、画面に入ったら counting にする。
  // 動きを減らす設定に途中で切り替わったら、数え上げの途中でも最終値（static）に戻す
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let observer: IntersectionObserver | null = null;
    if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") {
      setPhase("static");
    } else {
      setPhase("armed");
      observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          observer?.disconnect();
          setPhase((current) => (current === "armed" ? "counting" : current));
        },
        // 画面に実際に入ったとき（余白なし）に数え始める
        { rootMargin: "0px" },
      );
      observer.observe(root);
    }
    const stopListening = onReducedMotionChange((reduced) => {
      if (!reduced) return;
      observer?.disconnect();
      setPhase("static");
    });
    return () => {
      observer?.disconnect();
      stopListening();
    };
  }, []);

  useEffect(() => {
    if (phase !== "counting") return undefined;
    let frame = 0;
    let start: number | null = null;
    const tick = (now: number) => {
      start ??= now;
      const raw = Math.min(1, (now - start) / COUNT_MS);
      setProgress(ease(raw));
      if (raw < 1) frame = requestAnimationFrame(tick);
      else setPhase("done");
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  const showTicker = phase === "armed" || phase === "counting";

  return (
    <span
      ref={rootRef}
      data-count-up=""
      data-motion="count-up"
      data-count-state={phase === "idle" ? undefined : phase}
      className={className}
    >
      <span data-count-final="">{value}</span>
      {showTicker && (
        <span data-count-ticker="" aria-hidden="true">
          {formatCount(value, phase === "armed" ? 0 : progress)}
        </span>
      )}
    </span>
  );
}
