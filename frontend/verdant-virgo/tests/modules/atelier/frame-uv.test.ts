import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { frameUvs } from "@/modules/atelier/lib/frame-uv";

// 展示の壁の額の板に、額の絵（480×630 の canvas）を貼る UV（2026-10-29。静止画の額が空白だった不具合）。
// glb の板は XZ 平面（y の幅 0。法線 +Y）に作られ、ノードの回転（X 軸に +90°）で壁に立つ。ローカルの x・y で張ると v がどこでも同じになり、
// 絵の端の 1 行だけが伸びて空白に見えた。世界の向き（法線から「見る人の右」と上）で張る

/** glb と同じ形の板: XZ 平面の 4 頂点（幅 0.48・高さ 0.63）、法線 +Y、X 軸に +90° 回して壁に立てる */
function glbBoard() {
  const geometry = new THREE.BufferGeometry();
  const w = 0.24;
  const h = 0.315;
  // 0: 左上（-x, -z）、1: 右上（+x, -z）、2: 左下（-x, +z）、3: 右下（+x, +z）。+90° の X 回転で z は世界の -y になる（-z が上）
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-w, 0, -h, w, 0, -h, -w, 0, h, w, 0, h]), 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
  const mesh = new THREE.Mesh(geometry);
  mesh.position.set(-1.86, 1.65, 0.022);
  mesh.quaternion.set(0.7071068, 0, 0, 0.7071068);
  mesh.updateWorldMatrix(true, false);
  return mesh;
}

describe("frameUvs", () => {
  describe("正常系", () => {
    it("glb の板（XZ 平面を X 軸に 90° 回して立てた）でも、u は見る人の左→右、v は下→上に 0〜1 で張る", () => {
      const mesh = glbBoard();
      const uv = frameUvs(THREE, mesh.geometry, mesh.matrixWorld);
      const at = (i: number) => [uv[i * 2], uv[i * 2 + 1]].map((n) => Math.round(n * 1000) / 1000);
      expect(at(0)).toEqual([0, 1]); // 左上
      expect(at(1)).toEqual([1, 1]); // 右上
      expect(at(2)).toEqual([0, 0]); // 左下
      expect(at(3)).toEqual([1, 0]); // 右下
    });

    it("すでに XY 平面に立っている板（法線 +Z）でも同じ向きで張る", () => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, 1, 0, 1, 1, 0, -1, -1, 0, 1, -1, 0]), 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
      const uv = frameUvs(THREE, geometry, new THREE.Matrix4());
      expect([...uv]).toEqual([0, 1, 1, 1, 0, 0, 1, 0]);
    });
  });

  describe("異常系", () => {
    it("空入力: 頂点の無い板は空の UV を返し、投げない", () => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([]), 3));
      expect(frameUvs(THREE, geometry, new THREE.Matrix4()).length).toBe(0);
    });
  });
});
