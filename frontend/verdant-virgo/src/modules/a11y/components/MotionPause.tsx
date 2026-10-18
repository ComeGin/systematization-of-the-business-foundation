import { PauseIcon, PlayIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { MotionPauseProps } from "../lib/types";

function readPaused(key: string): boolean {
  try {
    return window.sessionStorage.getItem(key) === "paused";
  } catch {
    return false;
  }
}

function writePaused(key: string, paused: boolean): void {
  try {
    if (paused) window.sessionStorage.setItem(key, "paused");
    else window.sessionStorage.removeItem(key);
  } catch {
    // sessionStorage が使えない（プライベートモードの制限など）ときは、このページの中だけ止める
  }
}

/**
 * 5 秒を超えて自動で動く部品に付ける一時停止ボタン（WCAG 2.2.2。計画書 P-4・動きの規則 3）。
 * ネイティブの <button>。名前を「一時停止」⇔「再開」で入れ替える（名前が変わるので aria-pressed は付けない）。
 * 押した結果は sessionStorage に覚え、ページを移っても止まったままにする。戻したときはマウントの時点で onToggle(true) を呼ぶ。
 * reduced-motion のときは部品が最初から静止するので、このボタンを出すかどうかは呼び出し側（motion）が決める。
 * 文言は props で受ける（既定値を持たない。H-16）。
 */
export default function MotionPause({
  pauseLabel,
  resumeLabel,
  onToggle,
  storageKey,
  tone = "light",
  className,
}: MotionPauseProps) {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (readPaused(storageKey)) {
      setPaused(true);
      onToggle(true);
    }
    // 戻すのはマウントの 1 回だけ（onToggle が描画ごとに変わっても呼び直さない）
  }, [storageKey]);

  const toggle = () => {
    const next = !paused;
    setPaused(next);
    writePaused(storageKey, next);
    onToggle(next);
  };

  const Icon = paused ? PlayIcon : PauseIcon;

  return (
    <button
      type="button"
      onClick={toggle}
      className={cn(
        tone === "light"
          ? buttonVariants({ variant: "outline", size: "sm" })
          : // 反転面（navy.700）の上: 白の枠と白の文字。フォーカスリングは global.css の data-surface="dark" で白になる
            "type-label inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-text-inverse bg-transparent px-2.5 text-text-inverse transition-colors hover:bg-surface-brand",
        className,
      )}
    >
      <Icon aria-hidden="true" data-icon="inline-start" className="size-4" />
      {paused ? resumeLabel : pauseLabel}
    </button>
  );
}
