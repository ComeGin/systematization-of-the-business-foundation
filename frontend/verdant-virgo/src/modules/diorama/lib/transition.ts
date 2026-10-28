// ページの移動を「模型に寄るカメラ」に見せる（spec §9 の 3。計画 Task 10）。three・DOM に依存しない。
// 移動元のページの模型（view-transition-name: vt-diorama）が、行き先のページの焦点の部品の位置を中心に拡大しながら消え、
// 行き先のページのポスター（同じ名前）が現れる。拡大の中心は、移動元の画面での部品の位置（模型の枠に対する %）。
// 寄るのは、動く模型のページ（A）どうしで、行き先に焦点の部品があるときだけ。全景へ戻るとき・B（静止画）へ移るときは寄らない。
import { PAGE_VIEWS } from "./pages";
import type { PageKey, PartId } from "./types";

const SERVICE_SLUGS = [
  "environment-setup",
  "development",
  "consulting",
  "partnership",
] as const;

/** パスを PageKey に直す。模型の無いページは null */
export function pageKeyForPath(path: string): PageKey | null {
  if (!path) return null;
  const p = path.replace(/\/+$/, "") || "/";
  if (p === "/") return "top";
  if (p === "/services") return "services";
  const service = /^\/services\/([^/]+)$/.exec(p);
  if (service) {
    const slug = service[1] as (typeof SERVICE_SLUGS)[number];
    return SERVICE_SLUGS.includes(slug) ? `service:${slug}` : null;
  }
  const fixed: Record<string, PageKey> = {
    "/about": "about",
    "/pricing": "pricing",
    "/blog": "blog",
    "/contact": "contact",
    "/contact/thanks": "contactThanks",
  };
  return fixed[p] ?? null;
}

const pct = (v: number) =>
  `${Math.round(Math.min(100, Math.max(0, v)) * 100) / 100}%`;

/** 拡大の中心（CSS の transform-origin の x・y）。寄らないときは null */
export function dioramaZoomOrigin(
  from: PageKey,
  to: PageKey,
  anchors: ReadonlyMap<PartId, { x: number; y: number }>,
  size: { width: number; height: number },
): { x: string; y: string } | null {
  if (PAGE_VIEWS[from].mode === "still" || PAGE_VIEWS[to].mode === "still")
    return null;
  const focus = PAGE_VIEWS[to].focus;
  if (!focus) return null;
  const a = anchors.get(focus);
  if (!a || size.width <= 0 || size.height <= 0) return null;
  return {
    x: pct((a.x / size.width) * 100),
    y: pct((a.y / size.height) * 100),
  };
}
