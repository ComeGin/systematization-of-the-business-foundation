// MotionNav の island（GooeyNav）。MotionNav.astro からだけ使う。
// 形（pill）は hover と キーボードのフォーカスで指した先へ流れ、離れると現在地へ戻る（動きの規則 8。操作の手段で体験を分けない）。
// 現在地は形とは別に、aria-current と現在の項目の下線（MotionNav.astro の CSS）で常に示す（規則 2。意味を動きに持たせない）。
import { useEffect, useRef, useState, type CSSProperties } from "react";
import GooeyNav from "../vendor/react-bits/GooeyNav/GooeyNav";
import type { MotionNavLink } from "../lib/types";
import { DURATION } from "../lib/tokens";

interface Props {
  links: MotionNavLink[];
  label: string;
}

// 色は役割トークン（GooeyNav が WebGL に渡す前に計算後の値へ解決する）
const STYLE = {
  "--gn-ink": "var(--color-role-text-heading)",
  "--gn-muted": "var(--color-role-text-body)",
  "--gn-x": "8px",
  "--gn-y": "6px",
  "--gn-gap": "4px",
  "--gn-font": "14px",
} as CSSProperties;

export default function GooeyNavIsland({ links, label }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const currentIndex = links.findIndex((link) => link.current !== undefined);
  const [preview, setPreview] = useState<number | null>(null);
  // 指した先（hover・フォーカス）を拾う。離れたら少し待ってから現在地へ戻す（項目の間を移るたびに戻らないように）
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let leaveTimer = 0;
    const indexOf = (target: EventTarget | null) => {
      const item = (target as Element | null)?.closest?.<HTMLElement>(
        "[data-gooey-index]",
      );
      return item && root.contains(item)
        ? Number(item.dataset.gooeyIndex)
        : null;
    };
    const point = (target: EventTarget | null) => {
      const index = indexOf(target);
      if (index === null) return;
      window.clearTimeout(leaveTimer);
      setPreview(index);
    };
    const release = () => {
      window.clearTimeout(leaveTimer);
      leaveTimer = window.setTimeout(() => {
        // フォーカスがまだ中にあるなら、その項目に残す
        const focused = indexOf(document.activeElement);
        setPreview(focused);
      }, DURATION.small);
    };
    const onPointerOver = (event: PointerEvent) => point(event.target);
    const onFocusIn = (event: FocusEvent) => point(event.target);
    const onFocusOut = (event: FocusEvent) => {
      if (!root.contains(event.relatedTarget as Node | null)) release();
    };
    root.addEventListener("pointerover", onPointerOver);
    root.addEventListener("pointerleave", release);
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut);
    return () => {
      window.clearTimeout(leaveTimer);
      root.removeEventListener("pointerover", onPointerOver);
      root.removeEventListener("pointerleave", release);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  // 現在地が無いページ（トップなど）では、指していない間は形を出さない（-1 は GooeyNav の「どれも選ばない」）
  const active = preview ?? currentIndex;

  return (
    <div ref={rootRef} className="motion-nav" data-motion="nav">
      <GooeyNav
        items={links.map((link) => ({
          label: link.label,
          href: link.href,
          current: link.current,
        }))}
        activeIndex={active}
        ariaLabel={label}
        theme="light"
        color="var(--color-role-surface-accent-subtle)"
        activeTextColor="var(--color-role-text-heading)"
        size="md"
        frame={false}
        animationTime={DURATION.large}
        hoverEffect={false}
        shadow={0}
        // 粒の飛び散りはヘッダーの高さ（56px）の中に収める（原本の 56px・15 粒では本文まで飛ぶ）
        spread={16}
        particleCount={8}
        style={STYLE}
      />
    </div>
  );
}
