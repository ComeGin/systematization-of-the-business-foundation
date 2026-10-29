// ページごと・時間帯ごとのポスター・静止画（assets/stills/。tools/capture-stills.mjs が書き出す）の URL と、押せるものの位置（%）。
// ファイル名は <PageKey の : を _ に>-<phase>[-mobile].webp。ビルドでは _astro/ にハッシュ付きの名前で出る（1 年キャッシュ）。
import type { PageKey, Phase } from "./types";

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

const PHASES: readonly Phase[] = ["morning", "day", "dusk", "night"];

export interface Still {
  desktop: string;
  /** Mobile 用の縦長の構図（STILL_VIEWS の mobile が true のページだけ） */
  mobile: string | null;
  /** 押せるもの（anchor_<id>・frame:N）の位置。画像に対する % */
  anchors: Record<string, { x: number; y: number }> | null;
}

export function stillOf(page: PageKey, phase: Phase): Still {
  const name = `${page.replace(":", "_")}-${phase}`;
  const desktop = images[`../assets/stills/${name}.webp`];
  if (!desktop)
    throw new Error(
      `アトリエの静止画 ${name}.webp がありません。pnpm atelier:stills で書き出してください。`,
    );
  return {
    desktop,
    mobile: images[`../assets/stills/${name}-mobile.webp`] ?? null,
    anchors: anchorFiles[`../assets/stills/${name}.anchors.json`] ?? null,
  };
}

/** inline script に渡す 4 つの時間帯ぶん（その時間帯の 1 枚だけを読むため。spec §5.3） */
export function stillSet(page: PageKey): Record<Phase, Still> {
  return Object.fromEntries(
    PHASES.map((phase) => [phase, stillOf(page, phase)]),
  ) as Record<Phase, Still>;
}
