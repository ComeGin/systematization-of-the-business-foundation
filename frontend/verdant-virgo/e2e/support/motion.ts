// モーションの e2e が共有する計測（rAF の数・レイアウトのずれ）。motion.spec.ts と motion-vivid.spec.ts が使う。
// requestAnimationFrame は init script で包んで、実際に呼ばれたコールバックの数を数える。
import type { Page } from "@playwright/test";

/**
 * rAF のコールバックの数と、レイアウトのずれ（CLS）を数える仕掛けを、ページの読み込みの前に入れる。
 * ずれは合計（__cls。参考）と、要因（sources）がすべて motion のラッパーの中の要素であるずれの合計（__motionCls。判定）を分けて数える
 * （リードの決定 R-17。フォントの差し替えでヘッダーの箱が縮み、canvas が付いて動くように、ほかの要素と一緒に動いたずれは
 *  motion が起こしたものではないので判定から外す。欧文の差し替えによる残りのずれは申し送り）
 */
export async function instrument(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __raf: number;
      __cls: number;
      __motionCls: number;
    };
    w.__raf = 0;
    w.__cls = 0;
    w.__motionCls = 0;
    const original = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      original((time) => {
        w.__raf++;
        callback(time);
      });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
        sources?: { node: Node | null }[];
      })[]) {
        if (entry.hadRecentInput) continue;
        w.__cls += entry.value;
        const sources = entry.sources ?? [];
        const fromMotion =
          sources.length > 0 &&
          sources.every((source) => {
            const node = source.node;
            const el = node instanceof Element ? node : node?.parentElement;
            return !!el?.closest(
              "[data-motion], astro-island:has([data-motion])",
            );
          });
        if (fromMotion) w.__motionCls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
}

/** ms の間に呼ばれた rAF のコールバックの数 */
export async function rafDuring(page: Page, ms: number): Promise<number> {
  await page.evaluate(
    () => ((window as unknown as { __raf: number }).__raf = 0),
  );
  await page.waitForTimeout(ms);
  return page.evaluate(() => (window as unknown as { __raf: number }).__raf);
}

export const cls = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __cls: number; __motionCls: number };
    return { total: w.__cls, motion: w.__motionCls };
  });

/**
 * selector の要素の中で、無限の CSS animation が何本あり、そのうち running が何本か。
 * 部品ごとに「動いている」「止まった」を数える（rAF だけでは、もともと rAF を使わない CSS の動きが止まった証明にならない）。
 * 根が無いときは total・running とも -1。
 */
export const animationCounts = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return { total: -1, running: -1, paused: -1 };
    const own = document
      .getAnimations()
      .filter(
        (a) =>
          a.effect?.getComputedTiming().iterations === Infinity &&
          root.contains((a.effect as KeyframeEffect).target),
      );
    return {
      total: own.length,
      running: own.filter((a) => a.playState === "running").length,
      paused: own.filter((a) => a.playState === "paused").length,
    };
  }, selector);
