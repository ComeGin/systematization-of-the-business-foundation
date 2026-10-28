// ページごとのポスター・静止画（assets/stills/。tools/capture-stills.mjs が書き出す）の URL と、部品の位置（%）。
// ビルドでは _astro/ にハッシュ付きの名前で出る（1 年キャッシュ）。ファイル名は PageKey の : を _ に変えたもの。
import type { PageKey, PartId } from "./types";

const images = import.meta.glob<string>("../assets/stills/*.webp", {
  eager: true,
  query: "?url",
  import: "default",
});
const anchorFiles = import.meta.glob<Record<string, { x: number; y: number }>>(
  "../assets/stills/*.anchors.json",
  {
    eager: true,
    import: "default",
  },
);

export interface Still {
  desktop: string;
  /** A のページだけ（B は 4:3 の 1 枚） */
  mobile: string | null;
  anchors: Partial<Record<PartId, { x: number; y: number }>>;
  mobileAnchors: Partial<Record<PartId, { x: number; y: number }>> | null;
}

export function stillOf(page: PageKey): Still {
  const name = page.replace(":", "_");
  const desktop = images[`../assets/stills/${name}.webp`];
  if (!desktop)
    throw new Error(
      `模型の静止画 ${name}.webp がありません。pnpm diorama:stills で書き出してください。`,
    );
  return {
    desktop,
    mobile: images[`../assets/stills/${name}-mobile.webp`] ?? null,
    anchors: anchorFiles[`../assets/stills/${name}.anchors.json`] ?? {},
    mobileAnchors:
      anchorFiles[`../assets/stills/${name}-mobile.anchors.json`] ?? null,
  };
}
