// 模型のポスターと静止画を書き出す（pnpm diorama:stills）。計画 Task 5・Task 8。spec §9 の 1・2。
//   A のページ（トップ・サービス一覧・サービス詳細 4 本）… <key>.webp（1600×900）と <key>-mobile.webp（800×450）。読み込み前のポスター
//   B のページ（会社概要・料金・ブログ一覧・お問い合わせ・送信完了）… <key>.webp（960×720。4:3 の媒体の枠）
//   どれも <name>.anchors.json（部品の anchor の位置。画像に対する %）を一緒に出す（静止のときに押せるボタンを置く位置）
// 撮り方: 実行時と同じ lib/scene.ts を、開発サーバーの Vite から読んで frozen（粒なし）で 1 枚だけ描く。
//         Blender の別のレンダラーで描かない（光の計算が違うと、ポスターから立体へ替わる瞬間にずれが見える）。
// 前提: 開発サーバー（astro dev --background。既定 http://localhost:4321）が動いていること。--base で宛先を変える。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../assets/stills");
const CAPTURE_PATH = "/__diorama-capture";

const A_KEYS = [
  "top",
  "services",
  "service:environment-setup",
  "service:development",
  "service:consulting",
  "service:partnership",
];
const B_KEYS = ["about", "pricing", "blog", "contact", "contactThanks"];

/** 書き出すもの。css は canvas の CSS の大きさ（px。2 倍で描いて縮める） */
const SHOTS = [
  ...A_KEYS.flatMap((key) => [
    { key, file: key.replace(":", "_"), css: { width: 800, height: 450 } },
    {
      key,
      file: `${key.replace(":", "_")}-mobile`,
      css: { width: 400, height: 225 },
    },
  ]),
  ...B_KEYS.map((key) => ({
    key,
    file: key,
    css: { width: 480, height: 360 },
  })),
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
html,body{margin:0}canvas{display:block}
</style></head><body><canvas id="c"></canvas></body></html>`;

/** ページの中で 1 枚描き、anchor の位置（%）を返す（Vite が /src/... の TS を変換して返す） */
async function drawInPage({ key, width, height }) {
  const canvas = document.getElementById("c");
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const [{ loadThree }, { cssColor }, { createDioramaScene }, { PAGE_VIEWS }, glb] =
    await Promise.all([
      import("/src/modules/motion/lib/three.ts"),
    import("/src/modules/motion/lib/tokens.ts"),
      import("/src/modules/diorama/lib/scene.ts"),
      import("/src/modules/diorama/lib/pages.ts"),
      import(/* @vite-ignore */ "/src/modules/diorama/assets/diorama.glb?url"),
    ]);
  const three = await loadThree();
  // 模型の中に代表のアバターが写るページ（PAGE_VIEWS の showsAvatar）は、実行時と同じく承認台の横に人形を立たせて撮る
  const asset = async (p) => (await import(/* @vite-ignore */ `${p}?url`)).default;
  const avatar = PAGE_VIEWS[key].showsAvatar
    ? {
        modelUrl: await asset("/src/modules/avatar/assets/avatar.vrm"),
        idleUrl: await asset("/src/modules/avatar/assets/motions/idle.json"),
        nodUrl: await asset("/src/modules/avatar/assets/motions/nod.json"),
      }
    : undefined;
  const scene = await createDioramaScene(three, canvas, {
    glbUrl: glb.default,
    camera: PAGE_VIEWS[key].camera,
    colors: { proposal: cssColor("--color-brand-sky"), room: "#001C40" },
    frozen: true,
    avatar,
  });
  scene.resize(width, height, 2);
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
      "使い方: pnpm diorama:stills [--base http://localhost:4321]（先に astro dev --background で開発サーバーを起動する）",
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
  try {
    for (const shot of SHOTS) {
      const context = await browser.newContext({
        deviceScaleFactor: 2,
        viewport: { width: 900, height: 600 },
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
      const anchors = await page.evaluate(drawInPage, {
        key: shot.key,
        ...shot.css,
      });
      const png = await page.locator("#c").screenshot({ timeout: 120_000 });
      const webp = await sharp(png)
        .resize(shot.css.width * 2, shot.css.height * 2, { fit: "fill" })
        .webp({ quality: 82, effort: 6 })
        .toBuffer();
      fs.writeFileSync(path.join(OUT, `${shot.file}.webp`), webp);
      fs.writeFileSync(
        path.join(OUT, `${shot.file}.anchors.json`),
        `${JSON.stringify(anchors, null, 2)}\n`,
      );
      console.log(
        `${shot.file}.webp: ${shot.css.width * 2}×${shot.css.height * 2}px、${webp.length} バイト、anchor ${Object.keys(anchors).length} 個`,
      );
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
