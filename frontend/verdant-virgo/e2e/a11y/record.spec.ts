// ゲート G-M（Task 12）でユーザーに見せる動画の撮影。検査ではないので、普段の pnpm a11y では走らない（RECORD=1 のときだけ）。
// 走らせ方（先に SITE_URL=https://comegin.com pnpm build を済ませる）:
//   RECORD=1 pnpm exec playwright test e2e/a11y/record.spec.ts --reporter=line --workers=1
// 動画は .a11y/videos/（Git 管理外）に <desktop|mobile>-<normal|reduced>-<home|pricing>.webm で書く。
// ほかに、エモート 6 種の見本（desktop-normal-emotes.webm）と、Globe の見本（desktop-normal-services.webm。/ と /pricing/ には Globe が無い）。
// 撮っている間の動画は test-results/record/ に出て、名前を付けて写した後に消す。撮り終えたら test-results/ を片付ける。
// 撮ったままの動画は大きい（Desktop は 1 分で約 20MB）ので、見せる前に ffmpeg で詰め直す
//   （ffmpeg -i in.webm -c:v libvpx-vp9 -crf 40 -b:v 0 -deadline good -cpu-used 5 -row-mt 1 -an out.webm。1 分で約 2.5MB）。
//
// アバターは動かして撮る（fixture の avatarLive）。同意バナーは画面を隠すので「同意しない」で閉じてから撮る。
// Mobile のアバターは最初はアイコンだけなので、押して出してから撮る（reduced-motion では静止画が出る）。
// スクロールは人が読む速さにする（400px を滑らかに送って 1.2 秒止める）。着いてから最初の 3 秒は止めて、到着の動きと挨拶を映す。
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { open } from "./axe";
import { A11Y_DIR } from "./routes";
import { AVATAR_LABELS } from "../../src/modules/site-content/a11y";

test.skip(!process.env.RECORD, "撮影だけ（RECORD=1 のとき）");
test.use({ avatarLive: true });

const VIDEO_DIR = path.join(A11Y_DIR, "videos");
/** 撮っている間の置き場（saveAs で VIDEO_DIR に名前を付けて写し、元は消す） */
const RAW_DIR = path.join(path.dirname(A11Y_DIR), "test-results", "record");

/**
 * 動画の大きさをビューポートに合わせる。video の option は worker の単位で describe の中では変えられないので、
 * test の単位の contextOptions の recordVideo で撮る（video の option は off のままなので重ならない）。
 */
const recordAt = (size: { width: number; height: number }) => ({
  contextOptions: { recordVideo: { dir: RAW_DIR, size } },
});

/** ページを閉じて動画を名前を付けて置き、撮っている間の元の動画は消す */
async function saveVideo(page: Page, name: string) {
  const video = page.video()!;
  await page.close();
  await video.saveAs(path.join(VIDEO_DIR, `${name}.webm`));
  await video.delete();
}

const DOCK = '[data-motion="avatar"]';
const READY = `${DOCK}[data-avatar-state="ready"]`;

/** playwright.config.ts の project の viewport と同じ（動画の大きさをビューポートに合わせる） */
const SIZES = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;
type Device = keyof typeof SIZES;

/** 最後に再生したエモート（AvatarStage が window.__avatar に書く） */
const lastEmote = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __avatar?: { lastEmote: string | null } })
        .__avatar?.lastEmote ?? null,
  );

/** 同意バナーを「同意しない」で閉じる（consent-api への送信は fixture が差し替える） */
async function declineConsent(page: Page) {
  const decline = page.getByRole("button", { name: "同意しない" });
  if (await decline.isVisible()) await decline.click();
  await expect(page.locator("#cookie-banner")).toBeHidden();
}

/**
 * 着いた直後のアバター。Mobile は「アバターを表示する」を押して出す。
 * 動くときは 3D が描けて挨拶（greeting）が出るまで待つ。reduced-motion は静止画が出るのを待つ。
 */
async function settleAvatar(page: Page, device: Device, reduced: boolean) {
  if (device === "mobile") {
    const summon = page
      .locator(DOCK)
      .getByRole("button", { name: AVATAR_LABELS.summon });
    if (await summon.isVisible()) await summon.click();
  }
  if (reduced) {
    await expect(page.locator(`${DOCK} img.avatar-dock__still`)).toBeVisible();
    return;
  }
  await expect(page.locator(READY)).toBeAttached({ timeout: 40_000 });
  await expect
    .poll(() => lastEmote(page), { timeout: 15_000 })
    .toBe("greeting");
}

/** 要素の矩形（画面の座標）。無ければ null */
const rectOf = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  }, selector);

/**
 * 人が読む速さで送る。1 回に 400px を滑らかに送り（scrollBy の smooth。約 0.3 秒）、そこから 1.2 秒止める。
 * mouse.wheel を小刻みに送ると、WebGL と録画で重い間は 1 回ごとに 0.4 秒ほど待たされ、1 画面に 5 秒かかった（2026-10-19）。
 * reached が true を返すか、ページの終わりで動かなくなったらやめる。scroll は idle の合図を止める操作として数えられる（triggers.ts）。
 */
async function readAndScroll(page: Page, reached: () => Promise<boolean>) {
  const viewport = page.viewportSize()!;
  // ポインターは画面の中ほど（ヘッダーとアバターに掛からない所）に置く
  await page.mouse.move(viewport.width * 0.6, viewport.height * 0.55);
  for (let step = 0; step < 80; step++) {
    if (await reached()) return;
    const before = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => window.scrollBy({ top: 400, behavior: "smooth" }));
    await page.waitForTimeout(1_500);
    if ((await page.evaluate(() => window.scrollY)) === before) return;
  }
}

/** 要素の上端が画面の上から ratio の位置まで来たか、下端が画面に入ったか */
const reachedEl = (page: Page, selector: string, ratio: number) => async () => {
  const rect = await rectOf(page, selector);
  if (!rect) throw new Error(`${selector} が無い`);
  const height = page.viewportSize()!.height;
  return rect.bottom <= height || rect.top <= height * ratio;
};

/** /（着いてから 1-9 無料 DL ブロックまで）と /pricing/（着いてから料金カードまで） */
const SCENES = [
  { slug: "home", route: "/", target: "#source-dl", ratio: 0.3 },
  {
    slug: "pricing",
    route: "/pricing/",
    target: '[data-avatar-cue="pricing"]',
    ratio: 0.15,
  },
] as const;

for (const device of ["desktop", "mobile"] as const) {
  for (const reduced of [false, true]) {
    const mode = reduced ? "reduced" : "normal";
    test.describe(`${device}-${mode}`, () => {
      test.use(recordAt(SIZES[device]));

      for (const scene of SCENES) {
        test(`${device}-${mode}-${scene.slug}`, async ({ page }, testInfo) => {
          test.skip(
            testInfo.project.name !== device,
            `${device} の project だけ`,
          );
          test.setTimeout(180_000);
          if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
          await open(page, scene.route);
          await declineConsent(page);
          await settleAvatar(page, device, reduced);
          // 到着の動きと挨拶を映す
          await page.waitForTimeout(3_000);
          await readAndScroll(page, reachedEl(page, scene.target, scene.ratio));
          // 着いた所を少し映す
          await page.waitForTimeout(3_000);
          await saveVideo(page, `${device}-${mode}-${scene.slug}`);
        });
      }
    });
  }
}

test.describe("見本", () => {
  test.use(recordAt(SIZES.desktop));

  test("desktop-normal-services（Globe）", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "desktop の project だけ");
    test.setTimeout(120_000);
    await open(page, "/services/");
    await declineConsent(page);
    await settleAvatar(page, "desktop", false);
    // ヒーローの Globe が回るのを映す
    await page.waitForTimeout(8_000);
    let steps = 0;
    await readAndScroll(page, async () => steps++ >= 3);
    await page.waitForTimeout(2_000);
    await saveVideo(page, "desktop-normal-services");
  });

  // エモート 6 種を 1 本に入れる。再生中は次の合図を受けない（R18）ので、前のクリップの長さ（motions/*.json の duration）を待ってから次を出す。
  //   greeting 3.2 秒・point 5.7 秒・nod 1.6 秒・think 12.8 秒・show-full-body 3.0 秒・peace 1.7 秒
  // 各エモートが出た時刻（動画の何秒目か。ページを作った時刻からの概算）を標準出力に書く。
  test("desktop-normal-emotes", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "desktop の project だけ");
    test.setTimeout(240_000);
    const start = Date.now();
    const seen = async (emote: string, timeout: number) => {
      await expect.poll(() => lastEmote(page), { timeout }).toBe(emote);
      const at = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`[emote] ${emote} ${at}s`);
      testInfo.annotations.push({
        type: "emote",
        description: `${emote} ${at}s`,
      });
    };

    // 1. sessionStorage が空のまま着く → 手を振る（greeting）
    await open(page, "/services/development/");
    await declineConsent(page);
    await expect(page.locator(READY)).toBeAttached({ timeout: 40_000 });
    await seen("greeting", 15_000);
    await page.waitForTimeout(3_700);

    // 2. 主 CTA にフォーカス → 指さす（point）
    await page.locator("main [data-cta-id]").first().focus();
    await seen("point", 10_000);
    await page.waitForTimeout(6_200);

    // 3. プランの節までスクロール → うなずく（nod）
    await readAndScroll(
      page,
      reachedEl(page, '[data-avatar-cue="pricing"]', 0.6),
    );
    await seen("nod", 15_000);

    // 4. 操作を止めて待つ → 15 秒で考える（think）→ さらに 15 秒で全身を見せる（show-full-body）
    await seen("think", 30_000);
    await seen("show-full-body", 40_000);
    await page.waitForTimeout(3_500);

    // （2026-10-20 まではここで /blog/ の無料 DL のフォームを送り、喜ぶ〈peace〉を撮っていた。フォームを消したので撮らない）

    await saveVideo(page, "desktop-normal-emotes");
  });
});
