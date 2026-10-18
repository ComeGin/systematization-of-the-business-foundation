import type { VisuallyHiddenProps } from "../lib/types";

/**
 * 画面には出さず、支援技術にだけ読ませる文（Tailwind の sr-only）。
 * 「詳しく見る」の対象名の補いなど。文言は site-content から渡す（既定値を持たない。H-16）。
 * .astro から使うときは client:* を付けない（JS を出さずに静的な HTML になる）。
 */
export default function VisuallyHidden({
  as: Tag = "span",
  id,
  children,
}: VisuallyHiddenProps) {
  return (
    <Tag id={id} className="sr-only">
      {children}
    </Tag>
  );
}
