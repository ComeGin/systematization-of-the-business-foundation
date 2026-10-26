// E2E の共通の fixture。e2e/flows のすべての spec はここの test を使う。
//
// ブラウザの通信を 3 つに分ける（境界は support/env.ts の冒頭）:
//   1. オンプレの開発スタック（127.0.0.1・localhost）… そのまま通す。ただし Mautic の /form/submit と consent-api の /v1/consent は
//      本物に「転送」する（下の forward）。E2E のページのオリジン（127.0.0.1:4324）は開発スタックの CORS の許可に入っていないので、
//      転送のときに Origin を許可済みのオリジン（公開サイトの SITE_URL）に置き換え、応答の Access-Control-Allow-Origin をページのオリジンに戻す。
//      送信の中身は本物のサーバーが処理する（コンタクト・同意の記録は本当に作られる）。許可の設定そのものは cors.spec.ts が確かめる。
//   2. オンプレの外のうち、ページが頼るもの … 差し替える。Cal.com の embed.js は偽物（calcom-stub.ts）、PostHog は受けて記録だけ。
//   3. それ以外のオンプレの外 … 送らずに止め、traffic.blocked に残す（第三者のフォント・画像など。テストを遅く・不安定にしない）。
//
// BrowserContext はテストごとに新しく作られる（Cookie・sessionStorage を共有しない）。テストデータはテストごとに名前を変え（env.ts の e2eEmail）、
// 後片付けは cleanup に積む（テストが失敗しても最後に必ず実行する）。
import { gunzipSync } from "node:zlib";
import {
  test as base,
  expect,
  type Request,
  type Route,
} from "@playwright/test";
import { calcomStub, type CalcomMode } from "./calcom-stub";
import { deleteConsentRecord } from "./devstack";
import { DEV, E2E_BASE_URL, allowedOrigin } from "./env";
import type { Seed } from "../global-setup";

const ONPREM_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const isOnprem = (url: URL) =>
  ONPREM_HOSTS.has(url.hostname) ||
  url.protocol === "data:" ||
  url.protocol === "blob:";
const isPosthog = (url: URL) => /(^|\.)posthog\.com$/.test(url.hostname);

export interface SentForm {
  method: string;
  status: number;
  /** mauticform[<alias>] の値（alias をキーにする） */
  fields: Record<string, string>;
}

export interface SentConsent {
  method: string;
  status: number;
  body: string | null;
}

export class Traffic {
  /** 本物の Mautic に転送した送信（プリフライトを除く） */
  readonly forms: SentForm[] = [];
  /** 本物の consent-api に転送した要求（プリフライトを除く） */
  readonly consents: SentConsent[] = [];
  /** PostHog に送ろうとしたイベントの名前（読めなかった本文は "?"） */
  readonly posthogEvents: string[] = [];
  /** 読めなかった PostHog の送信（URL・Content-Type・本文の先頭。失敗したときの手がかり） */
  readonly posthogUndecoded: string[] = [];
  /** PostHog に送ろうとした要求の数（/flags・設定の読み込みを含む） */
  posthogRequests = 0;
  /** PostHog への要求（メソッドとパス） */
  readonly posthogLog: string[] = [];
  /** 止めたオンプレの外の要求（URL のオリジンとパスだけ） */
  readonly blocked: string[] = [];
}

/** posthog-js の送信の本文から、イベントの名前を取り出す（gzip・base64・JSON のどれでも） */
function posthogEventNames(request: Request): string[] {
  const buffer = request.postDataBuffer();
  if (!buffer?.length) return [];
  const candidates: string[] = [];
  try {
    candidates.push(gunzipSync(buffer).toString("utf8"));
  } catch {
    const text = buffer.toString("utf8");
    candidates.push(text);
    const data = new URLSearchParams(text).get("data");
    if (data) candidates.push(Buffer.from(data, "base64").toString("utf8"));
  }
  for (const text of candidates) {
    try {
      const parsed = JSON.parse(text) as
        | { event?: string }
        | { event?: string }[]
        | { batch?: { event?: string }[] };
      const events = Array.isArray(parsed)
        ? parsed
        : "batch" in parsed && parsed.batch
          ? parsed.batch
          : [parsed];
      return events.map((e) => (e as { event?: string }).event ?? "?");
    } catch {
      // 次の形を試す
    }
  }
  return ["?"];
}

/**
 * PostHog の偽の応答。posthog-js はリモートの設定（/array/<token>/config.js・config）を受け取るまでイベントを送らないので、
 * 何も有効にしない設定を返す（圧縮なし・フラグなし・録画なし）。拡張のスクリプトは空、/flags は空のフラグ、送信は受けるだけ
 */
function posthogResponse(url: URL, request: Request) {
  const config = {
    supportedCompression: [],
    hasFeatureFlags: false,
    autocapture_opt_out: true,
    captureDeadClicks: false,
    capturePerformance: false,
    sessionRecording: false,
    heatmaps: false,
    surveys: false,
    defaultIdentifiedOnly: true,
    siteApps: [],
  };
  const token = /^\/array\/([^/]+)\/config(\.js)?$/.exec(url.pathname)?.[1];
  if (token && url.pathname.endsWith(".js")) {
    const body = `window._POSTHOG_REMOTE_CONFIG = window._POSTHOG_REMOTE_CONFIG || {};
window._POSTHOG_REMOTE_CONFIG[${JSON.stringify(token)}] = { config: ${JSON.stringify(config)}, siteApps: [] };`;
    return { status: 200, contentType: "text/javascript", body };
  }
  if (token)
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(config),
    };
  if (request.resourceType() === "script")
    return { status: 200, contentType: "text/javascript", body: "" };
  if (url.pathname.startsWith("/flags")) {
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ flags: {}, errorsWhileComputingFlags: false }),
    };
  }
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ status: 1 }),
  };
}

function formFields(body: string | null): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(body ?? "")) {
    const alias = /^mauticform\[(.+)\]$/.exec(key)?.[1];
    if (alias) fields[alias] = value;
  }
  return fields;
}

/** 本物の開発スタックに転送する。Origin を許可済みの値に置き換え、CORS の応答をページのオリジンに戻す */
async function forward(route: Route): Promise<{ status: number }> {
  const request = route.request();
  const pageOrigin = (await request.headerValue("origin")) ?? E2E_BASE_URL;
  const headers = { ...(await request.allHeaders()), origin: allowedOrigin() };
  delete headers.host;
  delete headers["content-length"];
  const response = await route.fetch({
    headers,
    maxRedirects: 0,
    timeout: 60_000,
  });
  const out = response.headers();
  if (out["access-control-allow-origin"])
    out["access-control-allow-origin"] = pageOrigin;
  await route.fulfill({ response, headers: out });
  return { status: response.status() };
}

export interface Cleanup {
  /** テストの終わりに逆順で実行する。失敗はまとめて報告する（ほかの後片付けは止めない） */
  add(label: string, fn: () => Promise<void>): void;
}

export const test = base.extend<
  {
    calcom: CalcomMode;
    looksHuman: boolean;
    humanBrowser: void;
    avatarPaused: void;
    traffic: Traffic;
    cleanup: Cleanup;
  },
  { seed: Seed }
>({
  /** 完了画面の予約枠（Cal.com の偽物）の振る舞い。test.use({ calcom: "fail" }) で変える */
  calcom: ["ready", { option: true }],

  /**
   * true のとき、ページの JS から見えるブラウザを普通の Chrome に見せる（userAgent・userAgentData・webdriver）。
   * posthog-js は自動のブラウザ（HeadlessChrome・webdriver）をボットと判定してイベントを捨てる（本番では正しい振る舞い）ので、
   * PostHog に届くイベントの中身を確かめるテストだけ test.use({ looksHuman: true }) にする。送信先は偽物の PostHog（下の traffic）
   */
  looksHuman: [false, { option: true }],
  /**
   * アバター（A のページの左下の 3D）は、既定で「一時停止で開いた」状態にする（sessionStorage motion:avatar=paused。
   * 訪問者が止めたときと同じ振る舞いで、静止画のまま three と約 4MB のモデルを読まない）。E2E の対象ではなく、
   * 2 つのワーカーで WebGL を描くと機械の負荷で操作の待ちが延びるため（a11y の support/fixtures.ts と同じ）
   */
  avatarPaused: [
    async ({ context }, use) => {
      await context.addInitScript(() => {
        try {
          if (window.sessionStorage.getItem("motion:avatar") === null)
            window.sessionStorage.setItem("motion:avatar", "paused");
        } catch {
          // sessionStorage が使えないフレーム（第三者の iframe など）は何もしない
        }
      });
      await use();
    },
    { auto: true },
  ],

  humanBrowser: [
    async ({ context, looksHuman }, use) => {
      if (looksHuman) {
        await context.addInitScript(() => {
          const ua = navigator.userAgent.replace("HeadlessChrome", "Chrome");
          Object.defineProperty(Navigator.prototype, "userAgent", {
            get: () => ua,
          });
          Object.defineProperty(Navigator.prototype, "userAgentData", {
            get: () => undefined,
          });
          Object.defineProperty(Navigator.prototype, "webdriver", {
            get: () => false,
          });
        });
      }
      await use();
    },
    { auto: true },
  ],

  traffic: [
    async ({ context, calcom }, use) => {
      const traffic = new Traffic();

      // 3 → 2 の順に登録する（後から登録したものが先に当たる）。ページのオリジン（E2E の dev サーバー）はここを通らない
      await context.route(
        (url) => !isOnprem(url),
        async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.pathname === "/embed/embed.js") {
            if (calcom === "fail") return route.abort("connectionrefused");
            return route.fulfill({
              status: 200,
              contentType: "text/javascript",
              body: calcomStub(calcom),
            });
          }
          if (isPosthog(url)) {
            traffic.posthogRequests += 1;
            traffic.posthogLog.push(
              `${request.method()} ${url.hostname}${url.pathname} ${request.resourceType()}`,
            );
            if (request.method() === "POST") {
              const names = posthogEventNames(request);
              traffic.posthogEvents.push(...names);
              if (names.includes("?")) {
                const head =
                  request.postDataBuffer()?.subarray(0, 24).toString("hex") ??
                  "";
                traffic.posthogUndecoded.push(
                  `${url.pathname}${url.search} ${request.headers()["content-type"] ?? ""} ${head}`,
                );
              }
            }
            return route.fulfill(posthogResponse(url, request));
          }
          traffic.blocked.push(`${url.origin}${url.pathname}`);
          return route.abort("blockedbyclient");
        },
      );

      await context.route(
        (url) => url.origin === DEV.mautic && url.pathname === "/form/submit",
        async (route) => {
          const request = route.request();
          const { status } = await forward(route);
          if (request.method() !== "OPTIONS") {
            traffic.forms.push({
              method: request.method(),
              status,
              fields: formFields(request.postData()),
            });
          }
        },
      );

      await context.route(
        (url) =>
          url.origin === DEV.consentApi && url.pathname === "/v1/consent",
        async (route) => {
          const request = route.request();
          const { status } = await forward(route);
          if (request.method() !== "OPTIONS") {
            traffic.consents.push({
              method: request.method(),
              status,
              body: request.postData(),
            });
          }
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
      await fn().catch((error: unknown) =>
        failures.push(
          `${label}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
    if (failures.length > 0)
      throw new Error(
        `後片付けに失敗した（開発スタックにテストデータが残っている）:\n${failures.join("\n")}`,
      );
  },

  /** global-setup.ts が作った Strapi の記事（環境変数で受け渡す。ワーカーは親の環境変数を受け継ぐ） */
  seed: [
    async ({}, use) => {
      const raw = process.env.E2E_SEED;
      if (!raw)
        throw new Error("E2E_SEED が無い（global-setup.ts が動いていない）");
      await use(JSON.parse(raw) as Seed);
    },
    { scope: "worker" },
  ],
});

export { expect };

/** 同意の Cookie（comegin_consent）の値。無ければ undefined */
export async function consentCookie(
  context: import("@playwright/test").BrowserContext,
): Promise<string | undefined> {
  const cookie = (await context.cookies(E2E_BASE_URL)).find(
    (c) => c.name === "comegin_consent",
  );
  return cookie?.value;
}

/** 同意の Cookie の値を読む（s=…&v=…&id=…。consent/lib/consent.ts と同じ形） */
export function parseConsent(value: string | undefined): {
  state: string | null;
  version: string | null;
  id: string | null;
} {
  const params = new URLSearchParams(value ?? "");
  return {
    state: params.get("s"),
    version: params.get("v"),
    id: params.get("id"),
  };
}

/**
 * サーバー（consent-api）が発行した識別子付きの Cookie になるまで待ち、Valkey の記録の後片付けを積む。
 * 同意の操作をしたテストは、必ずこれで記録を片付ける
 */
export async function serverIssuedConsent(
  page: import("@playwright/test").Page,
  cleanup: Cleanup,
) {
  await expect
    .poll(async () => parseConsent(await consentCookie(page.context())).id)
    .toBeTruthy();
  const consent = parseConsent(await consentCookie(page.context()));
  cleanup.add("consent-api の記録", () => deleteConsentRecord(consent.id!));
  return consent;
}

/** バナーで「同意する」を押し、記録の後片付けを積む */
export async function grantConsent(
  page: import("@playwright/test").Page,
  cleanup: Cleanup,
) {
  await page.getByRole("button", { name: "同意する" }).click();
  return serverIssuedConsent(page, cleanup);
}
