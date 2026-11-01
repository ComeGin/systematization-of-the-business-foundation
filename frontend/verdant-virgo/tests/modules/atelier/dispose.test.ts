import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { disposeMaterial } from "@/modules/atelier/lib/dispose";

// 遅い端末と判定されたとき・失敗したときに、シーンを捨てる（最終レビュー I-7）。material.dispose() はテクスチャを捨てないので、
// 素材が持つテクスチャ（焼き込みの map・emissiveMap・額の CanvasTexture など）を素材ごとに捨てる。three は WebGL なしで作れる実物を使う

const spyTexture = () => {
  const texture = new THREE.Texture();
  const dispose = vi.spyOn(texture, "dispose");
  return { texture, dispose };
};

describe("disposeMaterial", () => {
  describe("正常系", () => {
    it("素材が持つテクスチャ（map・emissiveMap・roughnessMap）をすべて捨て、素材も捨てる", () => {
      const map = spyTexture();
      const emissive = spyTexture();
      const rough = spyTexture();
      const material = new THREE.MeshStandardMaterial({ map: map.texture, emissiveMap: emissive.texture, roughnessMap: rough.texture });
      const own = vi.spyOn(material, "dispose");
      disposeMaterial(material);
      expect(map.dispose).toHaveBeenCalledTimes(1);
      expect(emissive.dispose).toHaveBeenCalledTimes(1);
      expect(rough.dispose).toHaveBeenCalledTimes(1);
      expect(own).toHaveBeenCalledTimes(1);
    });

    it("同じテクスチャを 2 つの素材が持っていても、捨てるのはそれぞれ 1 回（捨てた物は覚えておく）", () => {
      const shared = spyTexture();
      const seen = new Set<THREE.Texture>();
      disposeMaterial(new THREE.MeshBasicMaterial({ map: shared.texture }), seen);
      disposeMaterial(new THREE.MeshBasicMaterial({ map: shared.texture }), seen);
      expect(shared.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe("異常系", () => {
    it("空入力: テクスチャを持たない素材でも投げずに素材だけ捨てる", () => {
      const material = new THREE.MeshBasicMaterial();
      const own = vi.spyOn(material, "dispose");
      expect(() => disposeMaterial(material)).not.toThrow();
      expect(own).toHaveBeenCalledTimes(1);
    });
  });
});
