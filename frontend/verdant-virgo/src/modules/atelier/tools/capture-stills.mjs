// アトリエのポスターと下層ページの静止画を書き出す（pnpm atelier:stills）。計画 Task 3 の Step 6。spec §7・§9 の 1・§10。
//   PageKey × 時間帯（朝・昼・夕方・夜）ごとに <key>-<phase>.webp と、押せるものの位置 <key>-<phase>.anchors.json（画像に対する %）
//     トップ・サービス一覧・サービス詳細 4 本（A） … 1600×900（16:9。背景に全面で敷く）と、Mobile 用の縦長 780×1040（-mobile）
//     会社概要・料金・ブログ一覧・お問い合わせ・送信完了（B） … 960×720（4:3 の媒体の枠）
//     アクセシビリティ … 1440×810（h1 の上の 16:9）
//   トップは、歩くカメラの出発点（walk・t=0）で撮る（ポスターから立体へ替わる瞬間に構図がずれないように）。ほかは glb の cam_<key>。
//   代表のアバターは、どの絵でも同じ場所（avatar_spot）に立たせて撮る（同じアトリエの別の場所なので、写る構図では写る。spec §11）。
// 撮り方: 実行時と同じ lib/scene.ts を、開発サーバーの Vite から読んで frozen で 1 枚ずつ描く（Blender の別のレンダラーで描かない）。
//   1 つの時間帯・大きさでシーンを 1 回だけ作り、カメラを替えて撮る（glb の展開とシェーダーの準備を何度もしない）。
// 前提: 開発サーバー（astro dev --background。既定 http://localhost:4321）が動いていること。--base で宛先を変える。--only <key> で 1 ページだけ。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../assets/stills");
const CAPTURE_PATH = "/__atelier-capture";
const PHASES = ["morning", "day", "dusk", "night"];
const A_KEYS = [
  "top",
  "services",
  "service:environment-setup",
  "service:development",
  "service:consulting",
  "service:partnership",
];
const B_KEYS = ["about", "pricing", "blog", "contact", "contactThanks"];
/** 予算（spec §10）。超えたら品質を下げて書き直す */
const POSTER_MAX = { desktop: 204_800, mobile: 122_880 };

/** 大きさの組。css は canvas の CSS の大きさ（px。2 倍で描く） */
const GROUPS = [
  { keys: A_KEYS, css: { width: 800, height: 450 }, suffix: "" },
  { keys: A_KEYS, css: { width: 390, height: 520 }, suffix: "-mobile" },
  { keys: B_KEYS, css: { width: 480, height: 360 }, suffix: "" },
  { keys: ["accessibility"], css: { width: 720, height: 405 }, suffix: "" },
];

function parseArgs(argv) {
  const args = { base: "http://localhost:4321", only: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") args.base = argv[++i];
    else if (argv[i] === "--only") args.only = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
  }
  return args;
}

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0}canvas{display:block}
</style></head><body><canvas id="c"></canvas></body></html>`;

/** ページの中でシーンを作る（Vite が /src/... の TS を変換して返す） */
async function initInPage({ phase, width, height }) {
  const canvas = document.getElementById("c");
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  document.documentElement.dataset.atelierPhase = phase;
  const url = async (p) =>
    (await import(/* @vite-ignore */ `${p}?url`)).default;
    const [{ loadThree }, { createAtelierScene }, { drawFrameArt }, { wallFrames }, { ATELIER }, { CASES }] = await Promise.all([
    import("/src/modules/motion/lib/three.ts"),
    import("/src/modules/atelier/lib/scene.ts"),
    import("/src/modules/atelier/lib/frame-art.ts"),
    import("/src/modules/atelier/lib/frames.ts"),
    import("/src/modules/site-content/atelier.ts"),
    import("/src/modules/site-content/cases.ts"),
  ]);
  // 展示の壁の額の文字（AtelierHero と同じ組み立て。他社は掲載許可の出た件だけ）
  const frameTextures = wallFrames(CASES).map((f) => {
    if (!f) return null;
    if (f.kind === "case") {
      const c = CASES.find((x) => `case:${x.id}` === f.id);
      return c ? drawFrameArt({ title: c.company, body: c.summary }) : null;
    }
    return drawFrameArt({ title: ATELIER.frames[f.id].title, body: ATELIER.frames[f.id].body });
  });
  const three = await loadThree();
  const skyUrls = {
    morning: await url("/src/modules/atelier/assets/sky/morning.webp"),
    day: await url("/src/modules/atelier/assets/sky/day.webp"),
    dusk: await url("/src/modules/atelier/assets/sky/dusk.webp"),
  };
  const scene = await createAtelierScene(three, canvas, {
    glbUrl: await url("/src/modules/atelier/assets/atelier.glb"),
    skyUrls,
    phase,
            camera: "walk",
    frozen: true,
    frameTextures,
    avatar: {
      modelUrl: await url("/src/modules/avatar/assets/avatar.vrm"),
      idleUrl: await url("/src/modules/avatar/assets/motions/idle.json"),
    },
  });
  scene.resize(width, height, 2);
  window.__atelier = { scene, width, height };
}

/** 1 枚描き、押せるものの位置（%）を返す */
function shotInPage({ camera }) {
  const { scene, width, height } = window.__atelier;
  scene.setCamera(camera);
  if (camera === "walk") scene.setWalk(0, 0);
  scene.render(0);
  const anchors = {};
  for (const [id, a] of scene.projectAnchors())
    if (a.visible)
      anchors[id] = {
        x: +((a.x / width) * 100).toFixed(2),
        y: +((a.y / height) * 100).toFixed(2),
      };
  return anchors;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "使い方: pnpm atelier:stills [--base http://localhost:4321] [--only <PageKey>]（先に astro dev --background で開発サーバーを起動する）",
    );
    return;
  }
  const [{ chromium }, { default: sharp }] = await Promise.all([
    import("@playwright/test"),
    import("sharp"),
  ]);
  const base = args.base.replace(/\/$/, "");
  const health = await fetch(`${base}/`).catch(() => null);
  if (!health) {
    console.error(
      `開発サーバー（${base}）に届きません。先に astro dev --background を起動してください。`,
    );
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  let count = 0;
  try {
    for (const phase of PHASES) {
      for (const group of GROUPS) {
        const keys = group.keys.filter((k) => !args.only || k === args.only);
        if (keys.length === 0) continue;
        const context = await browser.newContext({
          deviceScaleFactor: 2,
          viewport: { width: 900, height: 1100 },
        });
        const page = await context.newPage();
        page.on("pageerror", (error) =>
          console.error(`[page] ${error.message}`),
        );
        await page.route(`${base}${CAPTURE_PATH}`, (route) =>
          route.fulfill({
            status: 200,
            contentType: "text/html; charset=utf-8",
            body: PAGE_HTML,
          }),
        );
        await page.goto(`${base}${CAPTURE_PATH}`);
        await page.evaluate(initInPage, { phase, ...group.css });
        for (const key of keys) {
          const camera =
            key === "top" ? "walk" : `cam_${key.replace(":", "_")}`;
          const anchors = await page.evaluate(shotInPage, { camera });
          const png = await page.locator("#c").screenshot({ timeout: 120_000 });
          const file = `${key.replace(":", "_")}-${phase}${group.suffix}`;
          const max =
            key === "top"
              ? group.suffix
                ? POSTER_MAX.mobile
                : POSTER_MAX.desktop
              : Infinity;
          let quality = 82;
          let webp;
          do {
            webp = await sharp(png)
              .resize(group.css.width * 2, group.css.height * 2, {
                fit: "fill",
              })
              .webp({ quality, effort: 6 })
              .toBuffer();
            quality -= 6;
          } while (webp.length > max && quality > 30);
          fs.writeFileSync(path.join(OUT, `${file}.webp`), webp);
          fs.writeFileSync(
            path.join(OUT, `${file}.anchors.json`),
            `${JSON.stringify(anchors, null, 2)}\n`,
          );
          count++;
          console.log(
            `${file}.webp: ${group.css.width * 2}×${group.css.height * 2}px、${webp.length} バイト（品質 ${quality + 6}）、押せるもの ${Object.keys(anchors).length} 個`,
          );
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`書き出し: ${count} 枚`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
