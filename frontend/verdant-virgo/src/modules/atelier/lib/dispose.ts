// シーンを捨てるときの後始末（最終レビュー I-7）。material.dispose() はテクスチャを捨てないので、素材が持つテクスチャを素材ごとに捨てる。
// 遅い端末と判定されたとき・失敗したときに走る（メモリにいちばん余裕の無い端末なので、GC を待たずに返す）。
// three は型だけを読む（three の実装は loadThree() の 1 つのチャンクだけから読む。R9）。
import type * as THREE from "three";

/** 素材の、テクスチャを値に持つ項目（map・emissiveMap・roughnessMap など）を捨て、素材も捨てる。seen を渡すと、共有のテクスチャを 1 回だけ捨てる */
export function disposeMaterial(material: THREE.Material, seen: Set<THREE.Texture> = new Set()): void {
  for (const value of Object.values(material)) {
    const texture = value as THREE.Texture | null;
    if (texture && (texture as { isTexture?: boolean }).isTexture && !seen.has(texture)) {
      seen.add(texture);
      texture.dispose();
    }
  }
  material.dispose();
}
