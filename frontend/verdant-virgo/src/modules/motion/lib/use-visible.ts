// React の island 用。要素が見えている（画面内かつタブが表示中）ときだけ true（動きの規則 6）。
// 素の <script> から使う run-when-visible.ts に react を引き込まないよう、ファイルを分けている。
import { useEffect, useState, type RefObject } from "react";
import { runWhenVisible, type RunWhenVisibleOptions } from "./run-when-visible";

export function useVisible(
  ref: RefObject<Element | null>,
  options?: RunWhenVisibleOptions,
): boolean {
  const [visible, setVisible] = useState(false);
  const rootMargin = options?.rootMargin;
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    return runWhenVisible(el, setVisible, { rootMargin });
  }, [ref, rootMargin]);
  return visible;
}
