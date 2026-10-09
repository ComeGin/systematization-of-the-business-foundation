// 最初の描画を邪魔しないよう、ブラウザが空いたときに実行する（Q3。FCP の前に計測・チャットの読み込みを始めない）。
// requestIdleCallback が無いブラウザ（Safari）では、load の後に少し遅らせて実行する。
export function whenIdle(task: () => void): void {
  const run = () => {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(task, { timeout: 3000 });
    else setTimeout(task, 200);
  };
  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run, { once: true });
}
