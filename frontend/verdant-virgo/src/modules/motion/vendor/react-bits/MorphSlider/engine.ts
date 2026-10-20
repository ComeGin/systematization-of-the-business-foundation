// 出典: React Bits「MorphSlider」（https://reactbits.dev/r/MorphSlider-TS-TW.json）の MorphEngine とシェーダー。2026-10-18 に取り込んだ原本
// （MorphSlider.tsx）から、描画の部分だけを切り出したもの。React を使わない素の <script> から使えるようにするため（perf: ページに React を足さない）。
// 操作の UI（英語ラベル・role="tab"・前へ／次へ・ドラッグ）は使わない。操作はネイティブのラジオ（motion/components/MorphGallery.astro）。
// a11y・性能のための変更には「// a11y:」「// perf:」の印を付ける（計画書 P-10）。
import { Mesh, Program, Renderer, Texture, Triangle } from "ogl";

export type MorphTransition = "melt" | "ripple" | "shear" | "swirl";

const TRANSITIONS: Record<MorphTransition, number> = {
  melt: 0,
  ripple: 1,
  shear: 2,
  swirl: 3,
};

const vertexShader = `
attribute vec2 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

// 原本のシェーダー。変えたのは 2 か所: drift（uTime による常時のゆらぎ）を外したこと（a11y: 自動で動き続けない。2.2.2）と、
// 周辺減光を uVignette で 0 にできるようにしたこと（a11y: 静止の <img> と見た目をそろえ、WebGL の有無で見え方を変えない。規則 5）
const fragmentShader = `
precision highp float;

uniform sampler2D tCurrent;
uniform sampler2D tNext;
uniform vec2 uResolution;
uniform vec2 uCurrentSize;
uniform vec2 uNextSize;
uniform float uProgress;
uniform float uDir;
uniform int uMode;
uniform float uIntensity;
uniform float uScale;
uniform float uAberration;
uniform vec2 uPointer;
uniform vec3 uOverlay;
uniform float uVignette;

varying vec2 vUv;

const float PI = 3.14159265359;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}

mat2 rot(float a) {
  float s = sin(a);
  float c = cos(a);
  return mat2(c, -s, s, c);
}

vec2 coverUV(vec2 uv, vec2 res, vec2 img) {
  float rA = res.x / max(res.y, 1.0);
  float iA = img.x / max(img.y, 1.0);
  vec2 s = vec2(1.0);
  float ratio = rA / max(iA, 0.0001);
  if (ratio > 1.0) {
    s.y = 1.0 / ratio;
  } else {
    s.x = ratio;
  }
  return (uv - 0.5) * s + 0.5;
}

void main() {
  float p = clamp(uProgress, 0.0, 1.0);
  float env = sin(p * PI);

  vec2 uv = vUv;

  vec2 uvC = uv;
  vec2 uvN = uv;
  float m = smoothstep(0.0, 1.0, p);

  if (uMode == 3) {
    vec2 c = uv - 0.5;
    float r = length(c);
    float ang = env * uIntensity * 3.5 * (1.0 - r);
    uvC = rot(ang) * c + 0.5;
    uvN = rot(-ang) * c + 0.5;
    m = smoothstep(0.0, 1.0, p);
  } else if (uMode == 1) {
    float d = distance(uv, uPointer);
    float ring = p * 1.6;
    float wave = sin((d - ring) * 30.0) * env;
    vec2 dir = normalize(uv - uPointer + 1e-4);
    vec2 disp = dir * wave * uIntensity * 0.25;
    uvC = uv + disp;
    uvN = uv + disp * 0.6;
    m = 1.0 - smoothstep(ring - 0.03, ring + 0.03, d);
  } else if (uMode == 2) {
    float slices = 14.0;
    float row = floor(uv.y * slices);
    float rnd = hash11(row);
    vec2 disp = vec2((rnd - 0.5) * env * uIntensity * 0.6, 0.0);
    uvC = uv + disp;
    uvN = uv + disp;
    float localX = uDir > 0.0 ? uv.x : 1.0 - uv.x;
    float th = p * 1.5 - 0.25 + (rnd - 0.5) * 0.25;
    m = 1.0 - smoothstep(th - 0.06, th + 0.06, localX);
  } else {
    float nn = fbm(uv * uScale);
    float warp = fbm(uv * uScale * 1.7);
    vec2 g = vec2(nn, warp) - 0.5;
    uvC = uv + g * uIntensity * 0.5 * p;
    uvN = uv - g * uIntensity * 0.5 * (1.0 - p);
    m = smoothstep(nn - 0.15, nn + 0.15, p);
  }

  vec2 sC = coverUV(uvC, uResolution, uCurrentSize);
  vec2 sN = coverUV(uvN, uResolution, uNextSize);

  float ca = uAberration * env * 0.03;

  vec3 colC = vec3(
    texture2D(tCurrent, sC + vec2(ca, 0.0)).r,
    texture2D(tCurrent, sC).g,
    texture2D(tCurrent, sC - vec2(ca, 0.0)).b
  );
  vec3 colN = vec3(
    texture2D(tNext, sN + vec2(ca, 0.0)).r,
    texture2D(tNext, sN).g,
    texture2D(tNext, sN - vec2(ca, 0.0)).b
  );

  vec3 col = mix(colC, colN, m);

  float vig = smoothstep(1.25, 0.25, length(uv - 0.5));
  col = mix(col, uOverlay, (1.0 - vig) * 0.28 * uVignette);

  gl_FragColor = vec4(col, 1.0);
}
`;

export interface MorphEngineOptions {
  /** 切り替える写真。DOM に既にある <img>（静止の代わりと同じもの）をテクスチャに使う（perf: 二重に取得しない） */
  images: HTMLImageElement[];
  startIndex: number;
  transition: MorphTransition;
  intensity: number;
  scale: number;
  aberration: number;
  /** DPR の上限（perf） */
  dprCap: number;
}

export interface MorphTween {
  /** 時間（ms）。motion/lib/tokens.ts の DURATION から渡す */
  duration: number;
  /** 0〜1 → 0〜1 の緩急。motion/lib/tokens.ts の easing() から渡す */
  ease: (x: number) => number;
}

export class MorphEngine {
  private container: HTMLElement;
  private images: HTMLImageElement[];
  private current: number;
  private renderer: Renderer;
  private gl: Renderer["gl"];
  private canvas: HTMLCanvasElement;
  private program: Program;
  private mesh: Mesh;
  private textures: (Texture | null)[];
  private raf = 0;
  private lost = false;
  private finish: (() => void) | null = null;
  private boundContextLost: (e: Event) => void;

  /**
   * WebGL が使えないときは null を返す（a11y: 原本は ogl の Renderer が例外で落ちる。呼び出し側は CSS の切り替えのままにする）。
   */
  static create(
    container: HTMLElement,
    options: MorphEngineOptions,
  ): MorphEngine | null {
    // a11y: WebGL が無い環境では ogl を呼ばない（ogl はコンテキストを作れないとコンソールにエラーを出す。WebGL なしでもエラー 0 にする）
    const probe = document.createElement("canvas");
    if (!probe.getContext("webgl2") && !probe.getContext("webgl")) return null;
    try {
      return new MorphEngine(container, options);
    } catch {
      return null;
    }
  }

  private constructor(container: HTMLElement, options: MorphEngineOptions) {
    this.container = container;
    this.images = options.images;
    this.current = options.startIndex;

    this.renderer = new Renderer({
      alpha: false,
      antialias: true,
      dpr: Math.min(window.devicePixelRatio || 1, options.dprCap),
    });
    this.gl = this.renderer.gl;
    if (!this.gl) throw new Error("WebGL を使えません");

    this.canvas = this.gl.canvas as HTMLCanvasElement;
    // a11y: 装飾の canvas。写真の意味は DOM の <img alt> が持つ
    this.canvas.setAttribute("aria-hidden", "true");
    this.canvas.className =
      "pointer-events-none absolute inset-0 block h-full w-full opacity-0";
    container.appendChild(this.canvas);

    this.textures = this.images.map(() => null);

    this.program = new Program(this.gl, {
      vertex: vertexShader,
      fragment: fragmentShader,
      uniforms: {
        tCurrent: { value: null },
        tNext: { value: null },
        uResolution: { value: [1, 1] },
        uCurrentSize: { value: [1, 1] },
        uNextSize: { value: [1, 1] },
        uProgress: { value: 0 },
        uDir: { value: 1 },
        uMode: { value: TRANSITIONS[options.transition] ?? 0 },
        uIntensity: { value: options.intensity },
        uScale: { value: options.scale },
        uAberration: { value: options.aberration },
        uPointer: { value: [0.5, 0.5] },
        uOverlay: { value: [0, 0, 0] },
        uVignette: { value: 0 },
      },
    });
    this.mesh = new Mesh(this.gl, {
      geometry: new Triangle(this.gl),
      program: this.program,
    });

    this.boundContextLost = (e: Event) => {
      e.preventDefault();
      this.lost = true;
      this.stop();
    };
    this.canvas.addEventListener(
      "webglcontextlost",
      this.boundContextLost,
      false,
    );
  }

  /** 写真がまだ読めていなければ null（そのときは呼び出し側が CSS の切り替えにする） */
  private texture(index: number): Texture | null {
    const cached = this.textures[index];
    if (cached) return cached;
    const img = this.images[index];
    if (!img || !img.complete || img.naturalWidth === 0) return null;
    const texture = new Texture(this.gl, { generateMipmaps: false });
    texture.image = img;
    this.textures[index] = texture;
    return texture;
  }

  private size(index: number): [number, number] {
    const img = this.images[index];
    return [img?.naturalWidth || 1, img?.naturalHeight || 1];
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    this.renderer.setSize(Math.max(rect.width, 1), Math.max(rect.height, 1));
    this.program.uniforms.uResolution.value = [
      this.gl.canvas.width,
      this.gl.canvas.height,
    ];
  }

  /**
   * index の写真へ溶けるように移る。動くのは呼ばれたときだけで、終わったら canvas を隠して rAF も止める（perf: 原本は常時 rAF）。
   * onSwap は「静止の <img> を新しい写真に切り替えてよい」合図（canvas を隠す直前に呼ぶ）。
   * 写真が読めていない・WebGL を失ったときは false を返す（呼び出し側がすぐ CSS で切り替える）。
   */
  goTo(index: number, tween: MorphTween, onSwap: () => void): boolean {
    if (this.lost || index === this.current) return false;
    const from = this.texture(this.current);
    const to = this.texture(index);
    if (!from || !to) return false;

    // 途中で次が選ばれたら、前の遷移はその場で終える
    this.finish?.();

    this.resize();
    const uniforms = this.program.uniforms;
    uniforms.tCurrent.value = from;
    uniforms.uCurrentSize.value = this.size(this.current);
    uniforms.tNext.value = to;
    uniforms.uNextSize.value = this.size(index);
    uniforms.uDir.value = index > this.current ? 1 : -1;
    uniforms.uProgress.value = 0;
    this.renderer.render({ scene: this.mesh });
    this.canvas.classList.remove("opacity-0");

    // perf: gsap の代わりに、トークンの緩急で進める小さな tween（動きの規則 7）
    const start = performance.now();
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      this.stop();
      this.current = index;
      onSwap();
      this.canvas.classList.add("opacity-0");
      this.finish = null;
    };
    this.finish = end;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / tween.duration);
      uniforms.uProgress.value = tween.ease(t);
      this.renderer.render({ scene: this.mesh });
      if (t < 1) this.raf = requestAnimationFrame(step);
      else end();
    };
    this.raf = requestAnimationFrame(step);
    return true;
  }

  /** 遷移を使わずに現在の位置だけをそろえる（reduced-motion・写真の未読み込みで CSS が切り替えたとき） */
  jump(index: number): void {
    this.finish?.();
    this.current = index;
  }

  private stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  destroy(): void {
    this.finish?.();
    this.stop();
    this.canvas.removeEventListener("webglcontextlost", this.boundContextLost);
    this.textures.forEach((tex) => {
      if (tex?.texture) this.gl.deleteTexture(tex.texture);
    });
    if (this.program.program) this.gl.deleteProgram(this.program.program);
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.canvas.remove();
  }
}
