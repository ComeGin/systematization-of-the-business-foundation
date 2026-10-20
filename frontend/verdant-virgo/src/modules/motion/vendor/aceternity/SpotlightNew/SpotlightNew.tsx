// 出典: Aceternity UI「Spotlight New」（https://ui.aceternity.com/components/spotlight-new。registry: https://ui.aceternity.com/registry/spotlight-new.json）。2026-10-19 に shadcn CLI（@aceternity/spotlight-new）で取り込んだ原本。
// ライセンス: Aceternity UI の無料の部品（Pro ではない）。詳しくは vendor/aceternity/README.md。
// a11y・性能・トークンのための変更には「// a11y:」「// perf:」「// token:」の印を付ける（計画書 P-10）。
//
// 変更のまとめ（形・配置・角度・大きさは原本のまま。動かし方と色だけを替えた）:
// perf:  motion/react（JS で x を毎フレーム動かす）をやめ、CSS の animation にした。理由は 3 つ。
//        (1) transform の animation は合成だけで動き、メインスレッドも rAF も使わない。
//        (2) island にしなくても Astro がサーバー側で描ける（JS を読まない。Mobile・JS 無しでも壊れない）。
//        (3) 一時停止を global.css の [data-motion-paused="true"] { animation-play-state: paused } に任せられる（motion/react は止められない）。
//        keyframes（hero-spot-drift・hero-spot-in）は motion/sections/hero/HeroBackdrop.astro にある。
// a11y:  動きは呼び出し側が md 以上・hover あり・reduced-motion でない場合だけ表示する（HeroBackdrop）。この部品は装飾で、操作を受けない（pointer-events-none）。
// token: 漂う 1 周を --motion-duration-ambient（8000ms）にした（原本は 7 秒）。緩急は --motion-ease-standard。色は原本の hsla の直書きをやめ、
//        パレット（--color-brand-blue-300・500）の color-mix にした。濃さは navy.900 の地の上で光の筋が見える程度に上げた。
"use client";
import React from "react";

type SpotlightProps = {
  gradientFirst?: string;
  gradientSecond?: string;
  gradientThird?: string;
  translateY?: number;
  width?: number;
  height?: number;
  smallWidth?: number;
  /** 往復の片道の時間（CSS の時間）。既定は --motion-duration-ambient */
  duration?: string;
  xOffset?: number;
};

export const Spotlight = ({
  gradientFirst = "radial-gradient(68.54% 68.72% at 55.02% 31.46%, color-mix(in srgb, var(--color-brand-blue-300) 22%, transparent) 0, color-mix(in srgb, var(--color-brand-blue-500) 8%, transparent) 50%, transparent 80%)",
  gradientSecond = "radial-gradient(50% 50% at 50% 50%, color-mix(in srgb, var(--color-brand-blue-300) 16%, transparent) 0, color-mix(in srgb, var(--color-brand-blue-500) 6%, transparent) 80%, transparent 100%)",
  gradientThird = "radial-gradient(50% 50% at 50% 50%, color-mix(in srgb, var(--color-brand-blue-300) 12%, transparent) 0, color-mix(in srgb, var(--color-brand-blue-500) 5%, transparent) 80%, transparent 100%)",
  translateY = -350,
  width = 560,
  height = 1380,
  smallWidth = 240,
  duration = "var(--motion-duration-ambient)",
  xOffset = 100,
}: SpotlightProps = {}) => {
  // perf: 往復は alternate の片道を duration とする（there-and-back で 2 倍）。x の幅は --hero-spot-x でそれぞれの組に渡す
  const drift = (x: number): React.CSSProperties =>
    ({
      "--hero-spot-x": `${x}px`,
      animation: `hero-spot-drift ${duration} var(--motion-ease-standard) infinite alternate`,
    }) as React.CSSProperties;

  return (
    <div
      // perf: 原本の motion.div（opacity 0→1 を 1.5 秒）は CSS の hero-spot-in に置き換えた
      style={{ animation: "hero-spot-in calc(var(--motion-duration-large) * 2) var(--motion-ease-standard) both" }}
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      <div
        style={drift(xOffset)}
        className="absolute top-0 left-0 w-screen h-screen z-40 pointer-events-none"
      >
        <div
          style={{
            transform: `translateY(${translateY}px) rotate(-45deg)`,
            background: gradientFirst,
            width: `${width}px`,
            height: `${height}px`,
          }}
          className={`absolute top-0 left-0`}
        />

        <div
          style={{
            transform: "rotate(-45deg) translate(5%, -50%)",
            background: gradientSecond,
            width: `${smallWidth}px`,
            height: `${height}px`,
          }}
          className={`absolute top-0 left-0 origin-top-left`}
        />

        <div
          style={{
            transform: "rotate(-45deg) translate(-180%, -70%)",
            background: gradientThird,
            width: `${smallWidth}px`,
            height: `${height}px`,
          }}
          className={`absolute top-0 left-0 origin-top-left`}
        />
      </div>

      <div
        style={drift(-xOffset)}
        className="absolute top-0 right-0 w-screen h-screen z-40 pointer-events-none"
      >
        <div
          style={{
            transform: `translateY(${translateY}px) rotate(45deg)`,
            background: gradientFirst,
            width: `${width}px`,
            height: `${height}px`,
          }}
          className={`absolute top-0 right-0`}
        />

        <div
          style={{
            transform: "rotate(45deg) translate(-5%, -50%)",
            background: gradientSecond,
            width: `${smallWidth}px`,
            height: `${height}px`,
          }}
          className={`absolute top-0 right-0 origin-top-right`}
        />

        <div
          style={{
            transform: "rotate(45deg) translate(180%, -70%)",
            background: gradientThird,
            width: `${smallWidth}px`,
            height: `${height}px`,
          }}
          className={`absolute top-0 right-0 origin-top-right`}
        />
      </div>
    </div>
  );
};
