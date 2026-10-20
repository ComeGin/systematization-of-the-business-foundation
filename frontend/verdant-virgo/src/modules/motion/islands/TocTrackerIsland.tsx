// TocTracker の island（TocTracker.astro からだけ使う）。ブログ記事の目次の「いまここ」。
// 画面の上から 30% の線より上にある、いちばん下の見出しを「いまの節」とし、対応する目次の項目の <a> に aria-current="location" を付ける。
// 目次は LegalToc（Astro の静的な HTML）で、trackCurrent を渡したものだけ [data-toc-track] を持つ。React は目次を描かず、属性だけを付け外しする。
// Desktop の目次（sidebar）と Mobile の目次（accordion）の両方に付ける（片方は CSS で隠れているだけ）。
// a11y: 動きではなく現在地の情報なので、reduced-motion でも付ける。見た目の印の遷移は reduced-motion で 0.01ms になる（global.css）。
import { useEffect } from "react";

interface Props {
  /** 目次の項目の id（見出しの id）。順は目次の順＝本文の順 */
  ids: readonly string[];
}

const ATTRIBUTE = "aria-current";
const VALUE = "location";
// 画面の上からこの割合の線を「読んでいる位置」とみなす
const LINE = 0.3;

export default function TocTrackerIsland({ ids }: Props) {
  useEffect(() => {
    const headings = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    const links = (id: string) =>
      Array.from(
        document.querySelectorAll<HTMLAnchorElement>(
          `[data-toc-track] a[href="#${CSS.escape(id)}"]`,
        ),
      );
    let current: string | null = null;

    const update = () => {
      const line = window.innerHeight * LINE;
      let next: string | null = null;
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top <= line) next = heading.id;
        else break;
      }
      if (next === current) return;
      if (current) for (const a of links(current)) a.removeAttribute(ATTRIBUTE);
      current = next;
      if (current) for (const a of links(current)) a.setAttribute(ATTRIBUTE, VALUE);
    };

    // 線を横切る見出しの出入りで再計算する（見出しが線の上に出たとき・下に戻ったとき）。画面の上 30% の帯を観測領域にする
    const observer = new IntersectionObserver(update, {
      rootMargin: `0px 0px -${(1 - LINE) * 100}% 0px`,
      threshold: [0, 1],
    });
    for (const heading of headings) observer.observe(heading);
    // 画面のサイズが変わると線の位置が変わる
    window.addEventListener("resize", update, { passive: true });
    update();

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      if (current) for (const a of links(current)) a.removeAttribute(ATTRIBUTE);
    };
  }, [ids]);

  return null;
}
