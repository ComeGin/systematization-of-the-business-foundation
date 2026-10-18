// MotionSymbol の island（ShapeBlur ＋ 静止の SVG）。MotionSymbol.astro からだけ使う。
// 静止の <img> を SSR で出し、WebGL で最初の形を描けたら静止の方をフェードで消す（規則 5。WebGL が無ければ静止のまま）。
// reduced-motion のときは ShapeBlur を作らない（useReducedMotion はサーバーと水和の最初の描画で true＝静止から始まる）。
import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "@/modules/a11y/client";
import ShapeBlur from "../vendor/react-bits/ShapeBlur/ShapeBlur";

interface Props {
  /** 静止の形と、ShapeBlur に読ませる形（シンボルのネイビー版） */
  src: string;
  /** 静止の <img> の大きさ（px） */
  width: number;
  height: number;
}

// canvas は静止の形の 2 倍の箱にする（ぼけが箱の外へ広がっても切れないように）。
// ShapeBlur は形の長辺を「箱の短辺 × size」に描くので、size = 静止の長辺 ÷ 箱の短辺 で大きさがそろう。
const SCALE = 2;

// 止まっているときのぼけの強さ。最初はピントが合った状態（静止の SVG と同じ）で始め、ポインターが動いて離れていたらぼける（G-1 で承認。MO-5）。
// 強くぼかすとネイビーの面が薄く広がって明るい青に見えるので、形が読める強さにとどめる。
const REST_BLUR = 8;
// GL を作るのを待つ上限（ms）。ヒーローの描画を先に済ませるための待ちで、動きの時間ではない
const IDLE_TIMEOUT = 2000;

export default function SymbolBlur({ src, width, height }: Props) {
  const reduced = useReducedMotion();
  const rootRef = useRef<HTMLSpanElement>(null);
  const [idle, setIdle] = useState(false);
  const [ready, setReady] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  // ポインターが最初に動くまではピントを合わせておく（初めて見たときに「画像が崩れている」と誤解させない）
  const [primed, setPrimed] = useState(true);

  useEffect(() => {
    if (!primed) return undefined;
    const release = () => setPrimed(false);
    window.addEventListener("pointermove", release, {
      once: true,
      passive: true,
    });
    return () => window.removeEventListener("pointermove", release);
  }, [primed]);

  // 計画の client:idle の意図（ヒーローの描画を先に済ませる）。island の水和は client:media なので、GL を作るのを idle まで遅らせる
  useEffect(() => {
    if (reduced) return undefined;
    const ric =
      window.requestIdleCallback ??
      ((cb: () => void) => window.setTimeout(cb, 200));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    // 混んだ端末で idle が来ないままにならないよう、待つのは IDLE_TIMEOUT まで
    const id = ric(() => setIdle(true), { timeout: IDLE_TIMEOUT });
    return () => cancel(id);
  }, [reduced]);

  // 動きの規則 8: ヒーローの中にキーボードのフォーカスがある間は、ポインターが近いときと同じくピントを合わせる
  useEffect(() => {
    const section = rootRef.current?.closest("section");
    if (!section) return undefined;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Element | null;
      setKeyboardFocus(Boolean(target?.matches(":focus-visible")));
    };
    const onFocusOut = (event: FocusEvent) => {
      if (!section.contains(event.relatedTarget as Node | null))
        setKeyboardFocus(false);
    };
    section.addEventListener("focusin", onFocusIn);
    section.addEventListener("focusout", onFocusOut);
    return () => {
      section.removeEventListener("focusin", onFocusIn);
      section.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  const live = idle && !reduced;
  const boxWidth = Math.max(width, height) * SCALE;
  const boxHeight = boxWidth;

  return (
    <span ref={rootRef} className="relative block" style={{ width, height }}>
      <img
        src={src}
        alt=""
        width={width}
        height={height}
        decoding="async"
        className="block h-full w-full transition-opacity duration-[var(--motion-duration-medium)] ease-[var(--motion-ease-standard)]"
        style={{ opacity: live && ready ? 0 : 1 }}
      />
      {live && (
        <span
          className="pointer-events-none absolute"
          style={{
            width: boxWidth,
            height: boxHeight,
            left: (width - boxWidth) / 2,
            top: (height - boxHeight) / 2,
          }}
        >
          <ShapeBlur
            src={src}
            fill
            size={Math.max(width, height) / boxWidth}
            color="var(--color-brand-navy-700)"
            blur={REST_BLUR}
            lensSize={0.45}
            lensSoftness={0.7}
            focus
            chroma={0}
            idle={false}
            spin={0}
            forceFocus={keyboardFocus || primed}
            onReady={() => setReady(true)}
          />
        </span>
      )}
    </span>
  );
}
