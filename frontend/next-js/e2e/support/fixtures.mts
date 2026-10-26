// 監視アプリの E2E の共通の fixture。e2e のすべての spec はここの test を使う。
//
// ブラウザの通信は、オンプレ（127.0.0.1・localhost）だけを通す。オンプレの外（Google の認可の画面など）は送らずに止め、
// traffic.blocked に URL を残す（Google の認可の画面へ向かう URL の中身は、ログインの spec がここから確かめる）。
// BrowserContext はテストごとに新しく作られる。ログイン済みの状態は globalSetup が作った storageState（ADMIN_STATE）を使う。
// 後片付けは cleanup に積む（テストが失敗しても最後に必ず実行する）。
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";

/** 許可リストのメールのセッション（global-setup.mts が書く。Git の管理外） */
export const ADMIN_STATE = fileURLToPath(new URL("../.auth/admin.json", import.meta.url));

const ONPREM_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class Traffic {
  /** 止めたオンプレの外の要求の URL */
  readonly blocked: string[] = [];
}

export interface Cleanup {
  add(label: string, fn: () => Promise<void>): void;
}

export const test = base.extend<{ traffic: Traffic; cleanup: Cleanup }>({
  traffic: [
    async ({ context }, use) => {
      const traffic = new Traffic();
      await context.route(
        (url) => !ONPREM_HOSTS.has(url.hostname) && url.protocol !== "data:" && url.protocol !== "blob:",
        async (route) => {
          traffic.blocked.push(route.request().url());
          await route.abort("blockedbyclient");
        },
      );
      await use(traffic);
    },
    { auto: true },
  ],

  cleanup: async ({}, use) => {
    const tasks: [string, () => Promise<void>][] = [];
    await use({ add: (label, fn) => tasks.push([label, fn]) });
    const failures: string[] = [];
    for (const [label, fn] of tasks.reverse()) {
      await fn().catch((error: unknown) => failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`));
    }
    if (failures.length > 0) throw new Error(`後片付けに失敗した（開発スタックにテストデータが残っている）:\n${failures.join("\n")}`);
  },
});

export { expect } from "@playwright/test";

/**
 * 開いて、水和が終わるまで待つ。フォームのボタン・リンクを押すページで使う。
 * 水和の前に押すと、React の送信の処理ではなく、ブラウザの素のフォーム送信（同じ URL への GET）になる。
 * 合図は、React が水和した DOM の要素に付ける内部のプロパティ（__reactFiber$…）が main に付いたこと
 * （networkidle は dev サーバーの常時接続などで終わらないことがあり、合図にならない）
 */
export async function openHydrated(page: import("@playwright/test").Page, path?: string) {
  if (path) await page.goto(path);
  await page.waitForFunction(() => {
    const main = document.querySelector("main");
    return !!main && Object.keys(main).some((key) => key.startsWith("__reactFiber$"));
  });
}

/** ログイン済みで始める spec の先頭で使う */
export const asAdmin = { storageState: ADMIN_STATE };
