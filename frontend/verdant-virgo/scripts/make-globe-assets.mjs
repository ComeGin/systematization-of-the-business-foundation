// サービス一覧の地球儀（GlobeOsaka）が使う陸地のデータを作る。出力は 2 つ。
//   1. src/modules/motion/vendor/aceternity/Globe/globe.json … 3D の地球儀が読む陸地（GeoJSON）。
//      three-globe の例（Natural Earth の 110m。パブリックドメイン）から、大阪を正面にしたときに見える範囲の国だけを残す。
//      地球儀は大阪を軸に左右へゆっくり振れるだけで一周しないので、見えない側の国は要らない（約 480KB → 小さく）。
//      プロパティは描画に使わないので落とし、座標は小数 1 桁（約 11km。hex の一辺より細かい）に丸める。
//   2. src/modules/motion/sections/globe3d/globe-land.svg … 静止画（Mobile・reduced-motion・JS なし・WebGL なし）の陸地。
//      大阪が中心の正射図法。CSS の mask に使う（色は CSS のトークンで決める）。
// 使い方（frontend/verdant-virgo で）: node scripts/make-globe-assets.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(
  root,
  "node_modules/three-globe/example/country-polygons/ne_110m_admin_0_countries.geojson",
);
const OUT_JSON = resolve(
  root,
  "src/modules/motion/vendor/aceternity/Globe/globe.json",
);
const OUT_SVG = resolve(
  root,
  "src/modules/motion/sections/globe3d/globe-land.svg",
);

// 大阪（src/modules/motion/lib/three.ts の OSAKA と同じ）
const OSAKA = { lat: 34.6937, lng: 135.5023 };
// 遠近のカメラが球の中心から見込む角は約 70.5 度（acos(100/300)）。左右の振れ幅 30 度を足し、余白を取って 105 度
const KEEP_WITHIN_DEG = 105;

const rad = (deg) => (deg * Math.PI) / 180;
const round = (value, digits) => Number(value.toFixed(digits));

/** 大阪からの角距離（度） */
function distanceFromOsaka(lng, lat) {
  const cos =
    Math.sin(rad(OSAKA.lat)) * Math.sin(rad(lat)) +
    Math.cos(rad(OSAKA.lat)) *
      Math.cos(rad(lat)) *
      Math.cos(rad(lng - OSAKA.lng));
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

const geo = JSON.parse(readFileSync(SOURCE, "utf8"));

/** 外周と穴のリング（[lng, lat] の列）を、丸めて重複を除く */
const roundRing = (ring) => {
  const out = [];
  for (const [lng, lat] of ring) {
    const point = [round(lng, 1), round(lat, 1)];
    const last = out[out.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) out.push(point);
  }
  return out;
};

/** 閉じたリングは 4 点以上（丸めて 1 点・2 点に潰れた小さな島は、h3 の polygonToCells が失敗するので捨てる） */
const isValidRing = (ring) => ring.length >= 4;

const polygonsOf = (geometry) =>
  geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;

const features = [];
for (const feature of geo.features) {
  const polygons = polygonsOf(feature.geometry);
  const near = polygons.some((polygon) =>
    polygon[0].some(
      ([lng, lat]) => distanceFromOsaka(lng, lat) <= KEEP_WITHIN_DEG,
    ),
  );
  if (!near) continue;
  const coordinates = polygons.flatMap((polygon) => {
    const [outer, ...holes] = polygon.map(roundRing);
    // 外周が潰れた島は丸ごと捨てる。穴だけ潰れたときは穴だけ捨てる
    return isValidRing(outer) ? [[outer, ...holes.filter(isValidRing)]] : [];
  });
  if (coordinates.length === 0) continue;
  features.push({
    type: "Feature",
    properties: {},
    geometry: { type: "MultiPolygon", coordinates },
  });
}

mkdirSync(dirname(OUT_JSON), { recursive: true });
writeFileSync(
  OUT_JSON,
  JSON.stringify({ type: "FeatureCollection", features }) + "\n",
);

// --- 静止画: 大阪が中心の正射図法 -------------------------------------------
const phi0 = rad(OSAKA.lat);
let path = "";
for (const feature of features) {
  for (const polygon of feature.geometry.coordinates) {
    const ring = polygon[0];
    const points = ring.map(([lng, lat]) => {
      const phi = rad(lat);
      const dl = rad(lng - OSAKA.lng);
      const visible =
        Math.sin(phi0) * Math.sin(phi) +
          Math.cos(phi0) * Math.cos(phi) * Math.cos(dl) >=
        0;
      let x = Math.cos(phi) * Math.sin(dl);
      let y =
        Math.cos(phi0) * Math.sin(phi) -
        Math.sin(phi0) * Math.cos(phi) * Math.cos(dl);
      if (!visible) {
        // 水平線の向こう側は、円周へ寄せる（見える側の輪郭を切る近似）
        const length = Math.hypot(x, y) || 1;
        x /= length;
        y /= length;
      }
      return { x, y, visible };
    });
    if (!points.some((p) => p.visible)) continue;
    path +=
      "M" +
      points
        .map((p) => `${Math.round(p.x * 1000)} ${Math.round(-p.y * 1000)}`)
        .join("L") +
      "Z";
  }
}

writeFileSync(
  OUT_SVG,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1000 -1000 2000 2000"><path d="${path}" fill="#000"/></svg>\n`,
);

console.log(
  `globe.json: ${features.length} 国 / ${(JSON.stringify({ features }).length / 1024).toFixed(0)}KB、globe-land.svg: ${(path.length / 1024).toFixed(0)}KB`,
);
