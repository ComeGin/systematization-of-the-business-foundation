// MotionPauseFor の island（a11y の MotionPause ＋ 止める対象の属性の付け外し）。MotionPauseFor.astro からだけ使う。
// 押すと、target の id を持つ要素に data-motion-paused="true"|"false" を付ける。
// 止める手段が出たら target に data-motion-ready="true" も付ける（動きを始めてよい印。JS が無い・水和の前は動かさない）。
// CSS の動きは global.css の [data-motion-paused="true"] が止め、JS の部品（rAF・WebGL）はこの属性を MutationObserver で読んで止める。
// 押した結果の記憶（sessionStorage）と、前のページで止めたときの復元は MotionPause に任せる（ここでは storage を触らない）。
// a11y: reduced-motion のときは何も描かない（動きが最初から止まっているので、止めるボタンは要らない。2.2.2 の対象外）。
//       useReducedMotion はサーバーでは true を返すので、JS が無いときもボタンは出ない（押せない死んだボタンを出さない）。
import { useEffect } from "react";
import { MotionPause, useReducedMotion } from "@/modules/a11y/client";

interface Props {
  /** 止める対象の要素の id（# は付けない） */
  target: string;
  storageKey: string;
  pauseLabel: string;
  resumeLabel: string;
  tone?: "light" | "dark";
  /** 対象名（MotionPause の target。sr-only で名前に足す） */
  targetName?: string;
  className?: string;
}

const ATTRIBUTE = "data-motion-paused";
const READY = "data-motion-ready";

function setPaused(target: string, paused: boolean): void {
  document.getElementById(target)?.setAttribute(ATTRIBUTE, String(paused));
}

export default function PauseToggle({
  target,
  storageKey,
  pauseLabel,
  resumeLabel,
  tone,
  targetName,
  className,
}: Props) {
  const reduced = useReducedMotion();

  // 子（MotionPause）の effect が先に走り、前のページで止めていれば "true" を付けている。付いていないときだけ "false" にする。
  // 止める手段（このボタン）が水和して出た印として data-motion-ready="true" も付ける。CSS はこの印が付くまで動きを始めない
  // （JS が無い・水和の前・水和に失敗したときに、止められない動きを出さない。2.2.2）
  useEffect(() => {
    if (reduced) return;
    const el = document.getElementById(target);
    if (!el) return;
    if (!el.hasAttribute(ATTRIBUTE)) el.setAttribute(ATTRIBUTE, "false");
    el.setAttribute(READY, "true");
  }, [reduced, target]);

  if (reduced) return null;

  return (
    <MotionPause
      storageKey={storageKey}
      pauseLabel={pauseLabel}
      resumeLabel={resumeLabel}
      tone={tone}
      target={targetName}
      className={className}
      onToggle={(paused) => setPaused(target, paused)}
    />
  );
}
