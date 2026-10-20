// three-globe が静的に import する `three/webgpu`・`three/tsl` を、ビルドのときだけ空の部品に差し替える Vite プラグイン。astro.config.mjs に登録する。
//
// perf: three-globe（2.42 以降のすべて）は、heatmaps の GPU 計算のために `three/webgpu`（WebGPURenderer・ノード・WebGL バックエンドの一式）と
//       `three/tsl` を先頭で import する。heatmaps は使わないのに、地球儀のチャンクが約 1.5MB（WebGPU の一式が約 1MB）になり、
//       three の実装が WebGL 用・WebGPU 用に 2 か所へ入る。使わない一式をビルドから外し、three のチャンクを 1 つに保つ。
// - 前提: three-globe 2.45.3（package.json で exact に固定）の import の形（`import { StorageInstancedBufferAttribute, WebGPURenderer } from 'three/webgpu'`・
//   `import * as tsl from 'three/tsl'`）と、importer のパスに `/three-globe/` が含まれること。版を上げるときは、差し替えが効いているか確かめる
//   （e2e motion-vivid.spec.ts の「Globe のチャンクにスタブの印があり、1MB 未満」が、効かなくなったことを検知する）。
// - 差し替えるのは importer が three-globe のときだけ（ほかの部品の `three/webgpu` は触らない）。
// - three-globe の heatmaps（heatmapsData）を使うと、差し替えた部品が「使えない」と例外を投げる。この地球儀は hex の陸地・点・輪だけを使う。
// - dev サーバーは依存の事前最適化（optimizeDeps）でまとめて読むので、何もしない（apply: "build"）。
import type { Plugin } from "vite";

const PREFIX = "\0comegin-three-globe-stub:";

const STUBS: Record<string, string> = {
  "three/webgpu": `
const unavailable = () => {
  throw new Error("three-globe の heatmaps（WebGPU）は、このサイトのビルドでは使えない（src/modules/motion/vite-plugin.ts）");
};
export class WebGPURenderer {
  constructor() {
    unavailable();
  }
}
export class StorageInstancedBufferAttribute {
  constructor() {
    unavailable();
  }
}
`,
  "three/tsl": "export {};",
};

export function comeginThreeGlobeWebgpuStub(): Plugin {
  return {
    name: "comegin-three-globe-webgpu-stub",
    enforce: "pre",
    apply: "build",
    resolveId(source, importer) {
      if (!importer || !(source in STUBS)) return null;
      if (!/[\\/]three-globe[\\/]/.test(importer)) return null;
      return PREFIX + source;
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null;
      return STUBS[id.slice(PREFIX.length)] ?? null;
    },
  };
}
