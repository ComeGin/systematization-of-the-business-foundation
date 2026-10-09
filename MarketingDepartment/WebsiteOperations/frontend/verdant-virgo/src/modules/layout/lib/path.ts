/** 末尾のスラッシュをそろえて比べる（ビルドの出力形式で /services と /services/ のどちらでも来るため） */
function normalize(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * ナビの現在地。そのページなら 'page'（aria-current="page"）、配下のページ（/services/development など）なら 'true'。
 * どちらも見た目は現在地にする。
 */
export function currentState(current: string, href: string): 'page' | 'true' | undefined {
  const c = normalize(current);
  const h = normalize(href);
  if (c === h) return 'page';
  if (c.startsWith(`${h}/`)) return 'true';
  return undefined;
}
