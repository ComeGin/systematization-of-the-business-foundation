// 部品のパネル（spec §6.3・§6.4）。DioramaIsland の中だけで使う。非モーダルのダイアログ（role="dialog"）。
// - 開いたらパネル自体にフォーカスを移し、閉じたら押したボタンへ戻す（戻すのは島の役目）。Esc・閉じるボタン・外側を押すと閉じる（島が受け持つ）。
// - 文言は site-content/diorama.ts から props で受け取る（既定値を持たない。H-16）。問い合わせ窓口だけ「この窓口から始まった仕事」を足す。
// a11y: 見出しは h2（ヒーローの h1 の下）。外部リンクは新しいタブで開き、その旨を sr-only で読ませる。
import { useEffect, useRef } from "react";
import type { CaseStudy } from "@/modules/site-content/cases";
import type { DioramaPartCopy } from "@/modules/site-content/diorama";
import type { PartId } from "../lib/types";

export interface DioramaCasesCopy {
  heading: string;
  caseNote: string;
  empty: string;
  selfNote: string;
}

interface Props {
  id: PartId;
  copy: DioramaPartCopy;
  closeLabel: string;
  newTabNotice: string;
  /** 問い合わせ窓口のときだけ渡す */
  cases?: { copy: DioramaCasesCopy; items: readonly CaseStudy[] };
  /** パネルの左上（box に対する px）。null なら Mobile の置き方（box の下端に沿う） */
  position: { left: number; top: number } | null;
  onClose(): void;
}

export default function DioramaPanel({
  id,
  copy,
  closeLabel,
  newTabNotice,
  cases,
  position,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const headingId = `diorama-panel-${id}`;

  useEffect(() => {
    ref.current?.focus();
  }, [id]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={headingId}
      tabIndex={-1}
      data-diorama-panel={id}
      className="diorama-panel pointer-events-auto absolute z-[3] flex w-[min(320px,calc(100%-16px))] flex-col gap-3 rounded-lg border border-white/15 bg-[color-mix(in_srgb,var(--color-brand-navy-900)_92%,transparent)] p-5 text-left text-text-inverse shadow-xl backdrop-blur-sm outline-none focus-visible:ring-2 focus-visible:ring-white"
      style={
        position
          ? { left: position.left, top: position.top }
          : // Mobile: 模型の枠の下端に沿う。上端の部品の名前のボタンの列（高さ 52px）を覆わないよう、高さを抑えて中をスクロールさせる
            {
              left: 8,
              right: 8,
              bottom: 8,
              width: "auto",
              maxHeight: "calc(100% - 60px)",
              overflowY: "auto",
            }
      }
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id={headingId} className="type-h4 text-text-inverse">
          {copy.name}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="type-small shrink-0 rounded-md border border-white/30 px-2 py-1 text-text-inverse hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
        >
          {closeLabel}
        </button>
      </div>
      <p className="type-body phrase text-text-on-hero-muted">{copy.body}</p>
      {copy.productNote && (
        <p className="type-small text-text-on-hero-accent">
          {copy.productNote}
        </p>
      )}
      {cases && (
        <div className="flex flex-col gap-2 border-t border-white/15 pt-3">
          <p className="type-label text-text-inverse">{cases.copy.heading}</p>
          {cases.items.length > 0 ? (
            <>
              <ul className="flex flex-col gap-2">
                {cases.items.map((study) => (
                  <li
                    key={study.id}
                    className="type-small text-text-on-hero-muted"
                  >
                    {study.url ? (
                      <a
                        className="text-text-inverse underline"
                        href={study.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {study.company}
                        <span className="sr-only">{newTabNotice}</span>
                      </a>
                    ) : (
                      <span className="text-text-inverse">{study.company}</span>
                    )}
                    ：{study.summary}
                  </li>
                ))}
              </ul>
              <p className="type-small text-text-on-hero-muted">
                {cases.copy.caseNote}
              </p>
            </>
          ) : (
            <>
              <p className="type-small text-text-on-hero-muted">
                {cases.copy.empty}
              </p>
              <p className="type-small text-text-on-hero-muted">
                {cases.copy.selfNote}
              </p>
            </>
          )}
        </div>
      )}
      {copy.link && (
        <a
          className="type-small self-start text-text-inverse underline underline-offset-4"
          href={copy.link.href}
        >
          {copy.link.label}
        </a>
      )}
    </div>
  );
}
