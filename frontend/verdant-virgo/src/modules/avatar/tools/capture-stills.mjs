// アバターの静止画（still.webp・icon.webp）を撮る（pnpm avatar:stills）。Task 10。
//   still.webp … reduced-motion・WebGL なし・読み込み中に出す全身の待機の姿勢。336×560px（Desktop の A の枠 168×280px の 2 倍）
//   icon.webp  … たたんだとき・Mobile の最初に出す顔のアップ。112×112px（56px の 2 倍）
// 前提: 開発サーバー（astro dev --background。既定 http://localhost:4321）が動いていること。--base で宛先を変える。
// 撮り方: 開発サーバーのオリジンに、canvas だけの空のページを（Playwright の route で）出し、AvatarStage と同じ描画の部品（lib/stage.ts）を
// Vite から読んで、待機のクリップの 0 秒目を 1 枚だけ描く（rAF を回さない）。背景は透明（omitBackground）。2 倍で描いて sharp で縮める。
// 本番のページには何も足さない（撮るための経路は、このスクリプトの中だけにある）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, "../assets");
/** 撮るための空のページ（開発サーバーには無いパス。route で返す） */
const CAPTURE_PATH = "/__avatar-capture";

/** 撮るもの。css は canvas の CSS の大きさ（px）、out は書き出す大きさ（px） */
const SHOTS = [
  {
    file: "still.webp",
    framing: "full",
    css: { width: 336, height: 560 },
    out: { width: 336, height: 560 },
  },
  {
    file: "icon.webp",
    framing: "face",
    css: { width: 224, height: 224 },
    out: { width: 112, height: 112 },
  },
];

function parseArgs(argv) {
  const args = { base: "http://localhost:4321" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") args.base = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
  }
  return args;
}

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent}canvas{display:block}
</style></head><body><canvas id="c"></canvas></body></html>`;

/** ページの中で 1 枚描く（Vite が /src/... の TS を変換して返す） */
async function drawInPage({ framing, width, height }) {
  const canvas = document.getElementById("c");
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const asset = async (p) =>
    (await import(/* @vite-ignore */ `${p}?url`)).default;
  const [{ loadThree }, { createAvatarRuntime }] = await Promise.all([
    import("/src/modules/motion/lib/three.ts"),
    import("/src/modules/avatar/lib/stage.ts"),
  ]);
  const names = [
    "idle",
    "greeting",
    "nod",
    "point",
    "think",
    "peace",
    "show-full-body",
  ];
  const urls = await Promise.all(
    names.map((name) =>
      asset(`/src/modules/avatar/assets/motions/${name}.json`),
    ),
  );
  const motionUrls = Object.fromEntries(
    names.map((name, i) => [name, urls[i]]),
  );
  const three = await loadThree();
  const runtime = await createAvatarRuntime({
    three,
    canvas,
    // calm は視線を正面（カメラ）に向ける
    zone: "calm",
    modelUrl: await asset("/src/modules/avatar/assets/avatar.vrm"),
    motionUrls,
    framing,
    preserveDrawingBuffer: true,
  });
  runtime.renderOnce();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "使い方: pnpm avatar:stills [--base http://localhost:4321]（先に astro dev --background で開発サーバーを起動する）",
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

  const browser = await chromium.launch();
  try {
    for (const shot of SHOTS) {
      const context = await browser.newContext({
        deviceScaleFactor: 2,
        viewport: { width: 800, height: 800 },
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => console.error(`[page] ${error.message}`));
      await page.route(`${base}${CAPTURE_PATH}`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: PAGE_HTML,
        }),
      );
      await page.goto(`${base}${CAPTURE_PATH}`);
      await page.evaluate(drawInPage, { framing: shot.framing, ...shot.css });
      const png = await page.locator("#c").screenshot({ omitBackground: true });
      const out = path.join(ASSETS, shot.file);
      const webp = await sharp(png)
        .resize(shot.out.width, shot.out.height, { fit: "fill" })
        .webp({ quality: 90, alphaQuality: 100, effort: 6 })
        .toBuffer();
      fs.writeFileSync(out, webp);
      // 背景が透明か（四隅の alpha）と、絵が写っているか（不透明な画素の割合）を確かめて出す
      const { data, info } = await sharp(webp)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + 3];
      const corners = [
        alphaAt(0, 0),
        alphaAt(info.width - 1, 0),
        alphaAt(0, info.height - 1),
        alphaAt(info.width - 1, info.height - 1),
      ];
      let opaque = 0;
      for (let i = 3; i < data.length; i += info.channels)
        if (data[i] > 0) opaque++;
      const coverage = opaque / (info.width * info.height);
      console.log(
        `${shot.file}: ${info.width}×${info.height}px、${webp.length} バイト、四隅の alpha ${corners.join("/")}、絵の面積 ${(coverage * 100).toFixed(1)}%`,
      );
      if (corners.some((a) => a !== 0) || coverage < 0.05) {
        console.error(`${shot.file}: 背景が透明でないか、絵が写っていません。`);
        process.exitCode = 2;
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
