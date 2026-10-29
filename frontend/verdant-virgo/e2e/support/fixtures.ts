// e2e の共通の fixture。すべての spec はここの test を使う。
//
// 外へ出る送信を、ホストではなくパスで差し替える（開発の Mautic・consent-api に実際に送らない。計画書の守る規則 7）。
// 送信先の実際の URL は、ビルドに焼き込まれた値で確かめた（2026-10-18。dist/_astro の ConsentCheckbox.*.js・consent.*.js）:
//   - Mautic:      POST https://comegin-mautic-dev.ngrok.app/form/submit?formId=<id>&ajax=1（forms/lib/mautic.ts）
//   - consent-api: POST https://comegin-consent-api-dev.ngrok.app/v1/consent（consent/lib/consent.ts）
// どちらもホストは環境で変わるので、パス（/form/submit・/v1/consent）だけで捕まえる。
// 同意の後に読み込まれる解析（GA4・PostHog）とチャット（Chatwoot の SDK）は、開発のプロジェクトを汚さないよう止める。
import { test as base, type Request, type Route } from "@playwright/test";

/** Mautic の応答の差し替え方 */
export type MauticMode =
  | "success" // {success: 1}
  | "rejected" // {success: 0, validationErrors}（Mautic が入力を受け付けない）
  | "server-error" // 500
  | "hang"; // 応答しない（フォームの 10 秒のタイムアウトを起こす）

export type SentRequest = {
  pathname: string;
  search: string;
  method: string;
  body: string | null;
};

export class Network {
  mautic: MauticMode = "success";
  /** 差し替えた要求（プリフライトを除く） */
  readonly sent: SentRequest[] = [];
  private hanging: Route[] = [];

  private record(request: Request) {
    const url = new URL(request.url());
    this.sent.push({
      pathname: url.pathname,
      search: url.search,
      method: request.method(),
      body: request.postData(),
    });
  }

  /** 異なるオリジンへの fetch なので、応答に CORS の見出しを付ける（付けないと応答を読めず network の失敗になる） */
  private cors(request: Request): Record<string, string> {
    return {
      "access-control-allow-origin": request.headers().origin ?? "*",
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-requested-with",
    };
  }

  handleMautic = async (route: Route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: this.cors(request) });
      return;
    }
    this.record(request);
    const json = (status: number, body: unknown) =>
      route.fulfill({
        status,
        headers: { ...this.cors(request), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    switch (this.mautic) {
      case "success":
        return json(200, { success: 1 });
      case "rejected":
        return json(200, {
          success: 0,
          validationErrors: { email: "invalid" },
        });
      case "server-error":
        return json(500, { error: "e2e" });
      case "hang":
        this.hanging.push(route);
        return;
    }
  };

  handleConsent = async (route: Route) => {
    const request = route.request();
    if (request.method() !== "OPTIONS") this.record(request);
    await route.fulfill({ status: 204, headers: this.cors(request) });
  };

  /** 止めておいた要求を片付ける（テストの終わり） */
  async release() {
    await Promise.all(
      this.hanging.map((route) => route.abort().catch(() => {})),
    );
    this.hanging = [];
  }

  /** そのパスへ送った要求 */
  to(pathname: string): SentRequest[] {
    return this.sent.filter((r) => r.pathname === pathname);
  }
}

const isAnalytics = (url: URL) =>
  /(^|\.)posthog\.com$/.test(url.hostname) ||
  /(^|\.)googletagmanager\.com$/.test(url.hostname) ||
  /(^|\.)google-analytics\.com$/.test(url.hostname);

export const test = base.extend<{
  net: Network;
  allowChat: boolean;
}>({
  /** true のとき Chatwoot の SDK を止めない（chat.spec.ts だけ。test.use({ allowChat: true })） */
  allowChat: [false, { option: true }],
  net: [
    async ({ context, allowChat }, use) => {
      const net = new Network();
      await context.route(
        (url) => url.pathname === "/form/submit",
        net.handleMautic,
      );
      await context.route(
        (url) => url.pathname === "/v1/consent",
        net.handleConsent,
      );
      await context.route(isAnalytics, (route) => route.abort());
      if (!allowChat) {
        await context.route(
          (url) => url.pathname === "/packs/js/sdk.js",
          (route) => route.abort(),
        );
      }
      await use(net);
      await net.release();
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
