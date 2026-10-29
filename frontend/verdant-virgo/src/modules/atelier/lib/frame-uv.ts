// 展示の壁の額の板の UV（額の絵〈frame-art.ts の canvas〉を貼る）。2026-10-29。
// glb の板は XZ 平面（法線 +Y）に作られ、ノードの回転で壁に立つ。ローカルの x・y で張ると、高さの軸（ローカルの z）を見落として
// v がどこでも同じになり、絵の端の 1 行だけが伸びて額が空白に見えた（静止画・3D の両方）。
// 板を世界の向きで測る: 法線の平均を「見る人の側」とし、上は世界の +Y、右は 上 × 法線。u は左→右、v は下→上に 0〜1。
// three は引数で受ける（three の実装は loadThree() の 1 つのチャンクだけから読む。R9）。
import type * as Three from "three";

export function frameUvs(
  THREE: typeof Three,
  geometry: Three.BufferGeometry,
  matrixWorld: Three.Matrix4,
): Float32Array {
  const pos = geometry.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  if (pos.count === 0) return uv;
  const up = new THREE.Vector3(0, 1, 0);
  const normal = new THREE.Vector3();
  const nAttr = geometry.attributes.normal;
  if (nAttr) {
    const n = new THREE.Vector3();
    for (let k = 0; k < nAttr.count; k++) normal.add(n.fromBufferAttribute(nAttr, k));
    normal.transformDirection(matrixWorld);
  }
  // 法線が取れない・真上や真下を向く板は、正面（+Z）向きとみなす
  if (normal.lengthSq() < 1e-6 || Math.abs(normal.dot(up)) > 0.9) normal.set(0, 0, 1);
  const right = new THREE.Vector3().crossVectors(up, normal).normalize();
  const p = new THREE.Vector3();
  const a = new Float32Array(pos.count);
  const b = new Float32Array(pos.count);
  for (let k = 0; k < pos.count; k++) {
    p.fromBufferAttribute(pos, k).applyMatrix4(matrixWorld);
    a[k] = p.dot(right);
    b[k] = p.dot(up);
  }
  const [minA, maxA] = [Math.min(...a), Math.max(...a)];
  const [minB, maxB] = [Math.min(...b), Math.max(...b)];
  for (let k = 0; k < pos.count; k++) {
    uv[k * 2] = (a[k] - minA) / Math.max(1e-6, maxA - minA);
    uv[k * 2 + 1] = (b[k] - minB) / Math.max(1e-6, maxB - minB);
  }
  return uv;
}
