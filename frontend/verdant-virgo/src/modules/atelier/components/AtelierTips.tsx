// 置き物・額の Tips の札（spec §6.3）。AtelierTouch の中だけで使う。
// 画像は移り先の冒頭の静止画（その時間帯）、見出し、説明、「見る」のリンク。移り先の無い額は「見る」を持たない（spec §8）。
// 非モーダル（role="dialog"。aria-modal を付けない）。閉じ方（Escape・外側・ヒーローが画面から外れる）は AtelierTouch が受け持つ。
// 色は時間帯のトークン（--atelier-tip-*）。
import type { Ref } from "react";

export interface AtelierTipView {
  id: string;
  heading: string;
  body: string;
  cta?: string;
  href: string | null;
  image: string | null;
}

interface Props {
  tip: AtelierTipView;
  closeLabel: string;
  /** canvas の枠の中での位置（px）。null は枠の下端に沿わせる（Mobile） */
  position: { left: number; top: number } | null;
  linkRef?: Ref<HTMLAnchorElement>;
  onClose(): void;
  onPointerEnter?(): void;
  onPointerLeave?(): void;
}

export default function AtelierTips({
  tip,
  closeLabel,
  position,
  linkRef,
  onClose,
  onPointerEnter,
  onPointerLeave,
}: Props) {
  const headingId = `atelier-tip-${tip.id.replace(":", "-")}`;
  return (
    <div
      role="dialog"
      aria-labelledby={headingId}
      data-atelier-tips={tip.id}
      data-atelier-ui
      className={position ? "atelier-tips" : "atelier-tips atelier-tips--sheet"}
      style={position ? { left: position.left, top: position.top } : undefined}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {tip.image && (
        <img
          className="atelier-tips__image"
          src={tip.image}
          alt=""
          width={960}
          height={720}
          decoding="async"
        />
      )}
      <div className="atelier-tips__body">
        <h2 id={headingId} className="atelier-tips__heading type-label">
          {tip.heading}
        </h2>
        <p className="atelier-tips__text type-small">{tip.body}</p>
        {tip.href && tip.cta && (
          <a
            ref={linkRef}
            href={tip.href}
            className="atelier-tips__link type-label"
            data-atelier-tip-link
          >
            {tip.cta}
            <span aria-hidden="true"> →</span>
          </a>
        )}
      </div>
      <button
        type="button"
        className="atelier-tips__close"
        aria-label={closeLabel}
        onClick={onClose}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
