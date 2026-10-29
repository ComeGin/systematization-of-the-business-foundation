// 置き物と Tips と移り先（spec §5.2）。置き物・Tips・移り先のページは 1 対 1（アンチゴール 1）。
// Tips の画像＝移り先の冒頭の静止画なので、still は href のページと同じでなければならない（assertPropsOneToOne が確かめる）。
import { pageKeyForPath } from "./pages";
import type { PropDef, PropId } from "./types";

const prop = (id: PropId, href: string | null): PropDef => ({
  id,
  node: `prop_${id}`,
  anchor: `anchor_${id}`,
  href,
  still: href ? pageKeyForPath(href) : null,
});

export const PROPS: Readonly<Record<PropId, PropDef>> = {
  nameplate: prop("nameplate", "/about/"),
  avatar: prop("avatar", null),
  envSetup: prop("envSetup", "/services/environment-setup/"),
  development: prop("development", "/services/development/"),
  consulting: prop("consulting", "/services/consulting/"),
  partnership: prop("partnership", "/services/partnership/"),
  pricing: prop("pricing", "/pricing/"),
  blog: prop("blog", "/blog/"),
  wall: prop("wall", null),
  contact: prop("contact", "/contact/"),
};

/** 置き物の表が 1 対 1 でなければ Error（メッセージに id と理由） */
export function assertPropsOneToOne(
  props: Readonly<Record<string, PropDef>>,
): void {
  const list = Object.values(props);
  if (list.length === 0) throw new Error("置き物の表が空です");
  const seen = new Map<string, string>();
  for (const p of list) {
    if (p.href === null) {
      if (p.still !== null)
        throw new Error(`${p.id}: 移り先が無いのに静止画（${p.still}）がある`);
      continue;
    }
    const other = seen.get(p.href);
    if (other)
      throw new Error(`${p.id}: 移り先 ${p.href} が ${other} と重なっている`);
    seen.set(p.href, p.id);
    const key = pageKeyForPath(p.href);
    if (p.still !== key)
      throw new Error(
        `${p.id}: 静止画（${p.still}）が移り先のページ（${key}）と違う`,
      );
  }
}
