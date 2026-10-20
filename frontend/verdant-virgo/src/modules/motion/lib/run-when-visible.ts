// 画面外とタブの非表示で動きを止める共通の処理（動きの規則 6）。React に依存しない（素の <script> からも使う）。
// 見えている（要素が画面に入っている、かつタブが表示されている）ときだけ active=true を通知する。

export interface RunWhenVisibleOptions {
  /** 画面に入る少し前から動かし始めるときの余白（IntersectionObserver の rootMargin） */
  rootMargin?: string;
}

/**
 * el が見えているかどうかの変化を onChange で受け取る。最初の判定も 1 回通知する。戻り値で監視をやめる。
 * IntersectionObserver が無い環境では、タブの表示だけで判定する。
 */
export function runWhenVisible(
  el: Element,
  onChange: (active: boolean) => void,
  { rootMargin = "0px" }: RunWhenVisibleOptions = {},
): () => void {
  let intersecting = typeof IntersectionObserver === "undefined";
  let last: boolean | null = null;

  const notify = () => {
    const active = intersecting && document.visibilityState === "visible";
    if (active === last) return;
    last = active;
    onChange(active);
  };

  const observer =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(
          (entries) => {
            intersecting = entries.some((entry) => entry.isIntersecting);
            notify();
          },
          { rootMargin },
        );
  observer?.observe(el);
  document.addEventListener("visibilitychange", notify);
  if (!observer) notify();

  return () => {
    observer?.disconnect();
    document.removeEventListener("visibilitychange", notify);
  };
}
