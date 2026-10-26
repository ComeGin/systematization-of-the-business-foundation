// 監視アプリの E2E の globalSetup。webServer（E2E のインスタンス）が起動した後に 1 回だけ動く。
//   1. 開発の Chatwoot が動いているかを確かめる（誤った書き込みの突き合わせが読む）
//   2. 許可リストのメール（ADMIN_EMAIL）のセッションを作り、e2e/.auth/admin.json（Git の管理外）に storageState として書く
//   3. E2E が開くページと API を、本物のブラウザで 1 回ずつ開いておく（暖機。下の warmUp）
// サンドボックス（E-15・ログイン用の SQLite・main の写し）は webServer のコマンドが起動の前に作り直している（sandbox.mjs）。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "@playwright/test";
import { createSession, storageStateOf } from "./support/auth.mjs";
import { ADMIN_STATE } from "./support/fixtures.mjs";
import { ADMIN_EMAIL, BASE_URL, JOBS } from "./support/sandbox.mjs";

export default async function globalSetup() {
  try {
    const res = await fetch("http://127.0.0.1:3100/api", { signal: AbortSignal.timeout(10_000) });
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    throw new Error(`開発の Chatwoot（127.0.0.1:3100）に届かない（${String(error)}）。開発スタックを起動してから実行する`);
  }

  const state = storageStateOf(await createSession(ADMIN_EMAIL));
  mkdirSync(dirname(ADMIN_STATE), { recursive: true });
  writeFileSync(ADMIN_STATE, JSON.stringify(state), { mode: 0o600 });

  await warmUp(state);
}

/**
 * next dev は、ページ・Route Handler・クライアントの JS を初めて使うときにその場で変換する。冷えた状態だと 1 つに十数秒〜1 分かかり、
 * 最初に流れるテストの待ちを超える（2026-10-25 の実行で、遷移が間に合わない・水和の前に押してブラウザの素のフォーム送信になる、を確認）。
 * そのため、テストの前に本物のブラウザで一通り開いて変換を済ませる。オンプレの外への通信は止める（Google の認可の画面など）
 */
async function warmUp(state: ReturnType<typeof storageStateOf>) {
  const browser = await chromium.launch();
  try {
    for (const storageState of [undefined, state]) {
      const context = await browser.newContext({ baseURL: BASE_URL, storageState });
      await context.route(
        (url) => url.hostname !== "127.0.0.1" && url.hostname !== "localhost",
        (route) => route.abort("blockedbyclient"),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(180_000);
      const paths = storageState
        ? ["/runs", "/runs/new", `/runs/new?jobId=${JOBS.published}`, "/jobs", `/jobs/${JOBS.published}`, "/miswrite-candidates", "/runs/01K00000000000000000000000"]
        : ["/login"];
      for (const path of paths) {
        await page.goto(path);
        await page.waitForLoadState("load");
        // クライアントの遷移（Link・router.push）は HTML とは別に RSC の応答を取りに行き、これもルートごとに初回だけ変換される
        await context.request.get(path, { headers: { rsc: "1" } });
      }
      // Route Handler（ログインの開始と API）。ログインの開始は認可の URL を返すだけで、Google には届かない
      await context.request.post("/api/auth/sign-in/social", {
        headers: { origin: BASE_URL },
        data: { provider: "google", callbackURL: "/", disableRedirect: true },
      });
      for (const path of ["/api/runs", "/api/runs/01K00000000000000000000000", "/api/jobs", "/api/miswrite-candidates"]) await context.request.get(path);
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
