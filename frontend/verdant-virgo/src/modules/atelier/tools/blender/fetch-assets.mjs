// Blender（ホストの Windows）が書き出したアトリエの資産を VM へ取り込む（計画 Task 2 の Step 7）。
// 前提: Blender の中で、ROOT\out を配る小さなサーバー（ポート 8766。build_atelier.py の README の手順）が動いていること。
//   atelier.glb・atelier-mobile.glb … そのまま assets/ へ
//   sky_<phase>.png（2048×1024 の equirect） … sharp で WebP にし、307,200 バイトを超えたら品質を下げて assets/sky/<phase>.webp へ
// 使い方: node src/modules/atelier/tools/blender/fetch-assets.mjs [--host http://10.0.2.2:8766] [--only glb|sky]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, "../../assets");
const SKY_MAX = 307_200;
const PHASES = ["morning", "day", "dusk"];

const args = process.argv.slice(2);
const host = (
  args.includes("--host")
    ? args[args.indexOf("--host") + 1]
    : "http://10.0.2.2:8766"
).replace(/\/$/, "");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

async function get(name) {
  const res = await fetch(`${host}/${name}`);
  if (!res.ok) throw new Error(`${name} を取れません（${res.status}）`);
  return Buffer.from(await res.arrayBuffer());
}

if (only !== "sky") {
  for (const name of ["atelier.glb", "atelier-mobile.glb"]) {
    const buf = await get(name);
    fs.writeFileSync(path.join(ASSETS, name), buf);
    console.log(`${name}: ${buf.length} バイト`);
  }
}

if (only !== "glb") {
  const { default: sharp } = await import("sharp");
  fs.mkdirSync(path.join(ASSETS, "sky"), { recursive: true });
  for (const phase of PHASES) {
    const png = await get(`sky_${phase}.png`);
    let quality = 82;
    let webp;
    do {
      webp = await sharp(png)
        .resize(2048, 1024, { fit: "fill" })
        .webp({ quality, effort: 6 })
        .toBuffer();
      quality -= 6;
    } while (webp.length > SKY_MAX && quality > 30);
    fs.writeFileSync(path.join(ASSETS, "sky", `${phase}.webp`), webp);
    console.log(
      `sky/${phase}.webp: ${webp.length} バイト（品質 ${quality + 6}）`,
    );
  }
}
