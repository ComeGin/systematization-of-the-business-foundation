// three.js を読む唯一の入口（地球儀 GlobeOsaka とアバター AvatarStage が使う）。
// perf: three は約 700KB と重いので、最初の描画に載せない。動的 import の Promise を 1 つだけ作って使い回し、
//       2 つの部品が同じチャンクを共有する（`rg -l "WebGLRenderer" dist/_astro` が 1 になること）。
//       three を静的に import する部品（R3F を使う地球儀の原本など）も、この入口と同じ three のチャンクを指す。
// 読み込みに失敗したときは Promise を捨てる（通信が戻ったあと、ページを開き直さずに次の呼び出しで読み直せる）。

/** 大阪（事業所の所在地。大阪市城東区）。地球儀の点の位置と、静止画の中心 */
export const OSAKA = { lat: 34.6937, lng: 135.5023 } as const;

let pending: Promise<typeof import("three")> | null = null;

/** three を読む。何度呼んでも読み込みは 1 回で、同じモジュールが返る */
export function loadThree(): Promise<typeof import("three")> {
  if (!pending) {
    pending = import("three").catch((error: unknown) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}

/** canUseWebGL の結果（1 ページで 1 回だけ確かめる。地球儀とアバターが同じ結果を使う） */
let webglSupported: boolean | null = null;

/**
 * このブラウザで WebGL が使えるか。three を読む前に確かめ、使えなければ three を取りに行かない（静止画のまま）。
 * ブラウザの外（ビルド時）では false（覚えない）。
 * perf: 確かめるために作った文脈は、その場で WEBGL_lose_context で解放する（ブラウザの文脈の数の上限を使わない）。
 */
export function canUseWebGL(): boolean {
  if (typeof document === "undefined") return false;
  if (webglSupported !== null) return webglSupported;
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  try {
    const canvas = document.createElement("canvas");
    gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  } catch {
    gl = null;
  }
  webglSupported = !!gl;
  try {
    gl?.getExtension?.("WEBGL_lose_context")?.loseContext();
  } catch {
    // 解放できなくても結果は変えない
  }
  return webglSupported;
}
