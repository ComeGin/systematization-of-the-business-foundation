// consent-api（127.0.0.1:3104）を外から叩く結合テスト。Valkey は compose の中の本物を使う。
// 設計は backend/consent-api/README.md と DD-02 の 8 節。許可するオリジン（SITE_URL）などはコンテナの環境変数から 1 つずつ読む。
//
// 同意の記録は追記専用（TTL・MAXLEN なし）で、API からは消せない。テストで作った Stream は afterAll で
// valkey-cli の DEL で消す（README の設計では残るものだが、開発スタックに何も残さないため）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Cleanup } from "../helpers/cleanup.ts";
import { withPaused } from "../helpers/docker.ts";
import { http, type HttpResult } from "../helpers/http.ts";
import { CONTAINERS, DEV } from "../helpers/services.ts";
import { waitFor } from "../helpers/wait.ts";
import { consentEnv, deleteKeys, firstRecordedAt, listStreamKeys, streamKey, streamLength } from "./valkey.ts";

const CONSENT_URL = `${DEV.consentApi}/v1/consent`;
const COOKIE_NAME = "comegin_consent";
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const OTHER_ORIGIN = "https://evil.example";
// 形式は正しいが、サーバーが発行していない識別子（22 文字の base64url）
const FORGED_ID = "itForgedIdAAAAAAAAAAAA";
const MAX_RECORDS_PER_ID = 200;

interface ConsentBody {
  state?: string;
  policy_version?: string;
  recorded_at?: string;
  error?: string;
}

let SITE: string;
let POLICY: string;
let COOKIE_DOMAIN: string;

const cleanup = new Cleanup();
const issuedIds = new Set<string>();
// Valkey を止めている間に送った POST は 503 を返すが、XADD はソケットに残り、再開後に Valkey が実行することがある。
// その記録は識別子が応答に出ないので、止めていた時間帯に作られた Stream を探して消す
const pauseWindows: Array<{ from: string; to: string }> = [];
let keysBefore = new Set<string>();

beforeAll(async () => {
  SITE = await consentEnv("SITE_URL");
  POLICY = await consentEnv("CONSENT_POLICY_VERSION");
  COOKIE_DOMAIN = await consentEnv("COOKIE_DOMAIN");
  if (!SITE || !POLICY) throw new Error("consent-api のコンテナから SITE_URL・CONSENT_POLICY_VERSION を読めない");
  keysBefore = await listStreamKeys();

  cleanup.add("テストで発行された識別子の Stream", async () => {
    await deleteKeys(await Promise.all([...issuedIds].map((id) => streamKey(id))));
  });
  cleanup.add("Valkey を止めていた間に積まれた Stream", async () => {
    const created = [...(await listStreamKeys())].filter((key) => !keysBefore.has(key));
    const orphans: string[] = [];
    for (const key of created) {
      const at = await firstRecordedAt(key);
      if (at && pauseWindows.some((w) => at >= w.from && at <= w.to)) orphans.push(key);
    }
    await deleteKeys(orphans);
  });
});

afterAll(async () => {
  await cleanup.runAll();
});

function setCookieOf(res: HttpResult): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`));
}

/** Set-Cookie の値（s=…&v=…&id=…） */
function cookieValueOf(res: HttpResult): URLSearchParams | undefined {
  const cookie = setCookieOf(res);
  return cookie ? new URLSearchParams(cookie.split(";")[0]!.slice(COOKIE_NAME.length + 1)) : undefined;
}

function issuedIdOf(res: HttpResult): string | undefined {
  return cookieValueOf(res)?.get("id") ?? undefined;
}

const cookieFor = (id: string, state = "granted") => `${COOKIE_NAME}=s=${state}&v=${POLICY}&id=${id}`;

interface PostOptions {
  /** null なら Origin を付けない */
  origin?: string | null;
  /** null なら Content-Type を付けない（本文はバイト列で送り、fetch が text/plain を補わないようにする） */
  contentType?: string | null;
  cookie?: string;
}

async function post(body: unknown, options: PostOptions = {}): Promise<HttpResult<ConsentBody>> {
  const headers: Record<string, string> = {};
  if (options.origin !== null) headers.origin = options.origin ?? SITE;
  if (options.contentType !== null) headers["content-type"] = options.contentType ?? "application/json";
  if (options.cookie) headers.cookie = options.cookie;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const res = await http<ConsentBody>(CONSENT_URL, {
    method: "POST",
    headers,
    body: options.contentType === null ? new TextEncoder().encode(text) : text,
  });
  const id = issuedIdOf(res);
  if (id) issuedIds.add(id);
  return res;
}

async function get(options: { origin?: string; cookie?: string } = {}): Promise<HttpResult<ConsentBody>> {
  const headers: Record<string, string> = {};
  if (options.origin) headers.origin = options.origin;
  if (options.cookie) headers.cookie = options.cookie;
  return http<ConsentBody>(CONSENT_URL, { headers });
}

/** 同意を 1 件記録して、発行された識別子を返す */
async function grant(state: "granted" | "denied" = "granted"): Promise<string> {
  const res = await post({ state });
  expect(res.status).toBe(201);
  return issuedIdOf(res)!;
}

/** Valkey を止めて fn を実行する。止めていた時間帯を後片付けのために残す */
async function whileValkeyPaused<T>(fn: () => Promise<T>): Promise<T> {
  const from = new Date().toISOString();
  try {
    return await withPaused(CONTAINERS.consentValkey, fn);
  } finally {
    pauseWindows.push({ from, to: new Date(Date.now() + 1_000).toISOString() });
  }
}

/** 再開後に記録できるようになるまで待つ（ioredis の再接続を待つ） */
async function waitForRecovery(): Promise<void> {
  await waitFor(async () => (await post({ state: "granted" })).status === 201, { timeoutMs: 20_000, what: "Valkey の再開後に POST が 201 になる" });
}

describe("POST /v1/consent", () => {
  describe("正常系", () => {
    it("granted は 201 と、状態・サーバーの版・記録の時刻を返し、識別子は本文に返さない", async () => {
      const res = await post({ state: "granted" });

      expect(res.status).toBe(201);
      expect(res.json).toEqual({ state: "granted", policy_version: POLICY, recorded_at: expect.any(String) });
      expect(Number.isNaN(Date.parse(res.json!.recorded_at!))).toBe(false);
      const id = issuedIdOf(res)!;
      expect(id).toMatch(ID_PATTERN);
      expect(res.text).not.toContain(id);
      expect(await streamLength(id)).toBe(1);
    });

    it("denied も 201 で記録する", async () => {
      const res = await post({ state: "denied" });

      expect(res.status).toBe(201);
      expect(res.json?.state).toBe("denied");
      expect(cookieValueOf(res)?.get("s")).toBe("denied");
    });

    it("Set-Cookie は状態・版・識別子を持ち、Max-Age 12 か月・Path=/・Secure・SameSite=Lax で、HttpOnly を付けない", async () => {
      const res = await post({ state: "granted" });

      const cookie = setCookieOf(res)!;
      const attributes = cookie.split(";").map((s) => s.trim());
      expect(cookieValueOf(res)?.get("s")).toBe("granted");
      expect(cookieValueOf(res)?.get("v")).toBe(POLICY);
      expect(attributes).toContain("Max-Age=31536000");
      expect(attributes).toContain("Path=/");
      expect(attributes).toContain("Secure");
      expect(attributes).toContain("SameSite=Lax");
      expect(attributes.map((a) => a.toLowerCase())).not.toContain("httponly");
      // 開発は COOKIE_DOMAIN が空（localhost）で Domain を付けない。設定されていればその値
      if (COOKIE_DOMAIN) expect(attributes).toContain(`Domain=${COOKIE_DOMAIN}`);
      else expect(attributes.some((a) => a.toLowerCase().startsWith("domain="))).toBe(false);
    });

    it("許したオリジンに、資格情報つきの CORS と Vary: Origin・Cache-Control: no-store を返す（* は使わない）", async () => {
      const res = await post({ state: "granted" });

      expect(res.headers.get("access-control-allow-origin")).toBe(SITE);
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
      expect(res.headers.get("vary")).toContain("Origin");
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("撤回（denied）は同じ識別子の Stream に積み増し、GET は最新の denied を返す", async () => {
      const id = await grant("granted");

      const res = await post({ state: "denied" }, { cookie: cookieFor(id) });

      expect(res.status).toBe(201);
      expect(issuedIdOf(res)).toBe(id);
      expect(await streamLength(id)).toBe(2);
      expect((await get({ cookie: cookieFor(id, "denied") })).json?.state).toBe("denied");
    });

    it("Content-Type のパラメーター（charset）と大文字小文字は問わない", async () => {
      const res = await post({ state: "granted" }, { contentType: "Application/JSON; charset=utf-8" });

      expect(res.status).toBe(201);
    });

    it("空入力: Cookie が無ければ、毎回新しい識別子を発行する", async () => {
      const first = await grant();
      const second = await grant();

      expect(second).not.toBe(first);
    });
  });

  describe("異常系", () => {
    it("入力: Content-Type が application/json でなければ 415 unsupported_media_type で、Cookie を書かない", async () => {
      const res = await post({ state: "granted" }, { contentType: "text/plain" });

      expect(res.status).toBe(415);
      expect(res.json).toEqual({ error: "unsupported_media_type" });
      expect(setCookieOf(res)).toBeUndefined();
    });

    it("空入力: Content-Type が無ければ 415", async () => {
      const res = await post({ state: "granted" }, { contentType: null });

      expect(res.status).toBe(415);
      expect(res.json).toEqual({ error: "unsupported_media_type" });
    });

    it("入力: 本文が 1 KiB を超えれば 413 payload_too_large で、Cookie を書かない", async () => {
      const res = await post({ state: "granted", pad: "x".repeat(1_100) });

      expect(res.status).toBe(413);
      expect(res.json).toEqual({ error: "payload_too_large" });
      expect(setCookieOf(res)).toBeUndefined();
    });

    it("入力: JSON として読めない本文は 400 invalid_json", async () => {
      const res = await post('{"state":');

      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "invalid_json" });
    });

    it("空入力: 本文が空なら 400 invalid_json", async () => {
      const res = await post("");

      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "invalid_json" });
    });

    it("空入力: 空のオブジェクトは 400 invalid_body", async () => {
      const res = await post({});

      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "invalid_body" });
    });

    it("入力: state 以外のキー（識別子・版）が付けば 400 invalid_body で、送った識別子の記録は作られない", async () => {
      const res = await post({ state: "granted", id: FORGED_ID, policy_version: "1999-01-01" });

      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "invalid_body" });
      expect(setCookieOf(res)).toBeUndefined();
      expect(await streamLength(FORGED_ID)).toBe(0);
    });

    it("入力: state が granted・denied 以外なら 400 invalid_body", async () => {
      const res = await post({ state: "unset" });

      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "invalid_body" });
    });

    it("入力: 別のオリジンからは 403 origin_not_allowed で、許可の CORS ヘッダーも Cookie も返さない", async () => {
      const res = await post({ state: "granted" }, { origin: OTHER_ORIGIN });

      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "origin_not_allowed" });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(setCookieOf(res)).toBeUndefined();
    });

    it("空入力: Origin が無ければ 403（書き込みは必ず公開サイトから）", async () => {
      const res = await post({ state: "granted" }, { origin: null });

      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "origin_not_allowed" });
      expect(setCookieOf(res)).toBeUndefined();
    });

    it("入力: 形式は正しいが未発行の識別子の Cookie は引き継がず、新しい識別子を発行する（偽の Stream は作られない）", async () => {
      const res = await post({ state: "granted" }, { cookie: cookieFor(FORGED_ID) });

      expect(res.status).toBe(201);
      const id = issuedIdOf(res)!;
      expect(id).toMatch(ID_PATTERN);
      expect(id).not.toBe(FORGED_ID);
      expect(await streamLength(FORGED_ID)).toBe(0);
    });

    it("入力: 形式の不正な識別子の Cookie も引き継がず、新しい識別子を発行する", async () => {
      const res = await post({ state: "granted" }, { cookie: `${COOKIE_NAME}=s=granted&v=${POLICY}&id=../../etc` });

      expect(res.status).toBe(201);
      expect(issuedIdOf(res)).toMatch(ID_PATTERN);
    });

    it("入力: 1 つの識別子に 200 件積まれていれば 429 too_many_records で、Cookie を書かず、既存の記録を消さない", async () => {
      const id = await grant();
      for (let i = 1; i < MAX_RECORDS_PER_ID; i++) {
        const res = await post({ state: i % 2 === 0 ? "granted" : "denied" }, { cookie: cookieFor(id) });
        expect(res.status).toBe(201);
      }
      expect(await streamLength(id)).toBe(MAX_RECORDS_PER_ID);

      const res = await post({ state: "granted" }, { cookie: cookieFor(id) });

      expect(res.status).toBe(429);
      expect(res.json).toEqual({ error: "too_many_records" });
      expect(setCookieOf(res)).toBeUndefined();
      expect(await streamLength(id)).toBe(MAX_RECORDS_PER_ID);
      expect((await get({ cookie: cookieFor(id) })).json?.state).toBe("denied");
    });

    it("サーバ: Valkey が応答しない間は 503 unavailable で Cookie を書かず、再開後は記録できる", async () => {
      const res = await whileValkeyPaused(() => post({ state: "granted" }, { contentType: "application/json" }));

      expect(res.status).toBe(503);
      expect(res.json).toEqual({ error: "unavailable" });
      expect(setCookieOf(res)).toBeUndefined();
      // 503 でもブラウザが応答を読めるよう、許したオリジンには CORS を返す
      expect(res.headers.get("access-control-allow-origin")).toBe(SITE);
      expect(res.headers.get("cache-control")).toBe("no-store");
      await waitForRecovery();
    });
  });
});

describe("GET /v1/consent", () => {
  describe("正常系", () => {
    it("Cookie の識別子の最新の状態・版・時刻を返し、Cookie は書かない", async () => {
      const id = await grant("granted");

      const res = await get({ origin: SITE, cookie: cookieFor(id) });

      expect(res.status).toBe(200);
      expect(res.json).toEqual({ state: "granted", policy_version: POLICY, recorded_at: expect.any(String) });
      expect(setCookieOf(res)).toBeUndefined();
      expect(res.headers.get("access-control-allow-origin")).toBe(SITE);
    });

    it("Origin の付かない GET（同一オリジンの読み込みなど）は照合せずに返す", async () => {
      const id = await grant("denied");

      const res = await get({ cookie: cookieFor(id, "denied") });

      expect(res.status).toBe(200);
      expect(res.json?.state).toBe("denied");
    });

    it("空入力: Cookie が無ければ unset を返し、Cookie は書かない", async () => {
      const res = await get({ origin: SITE });

      expect(res.status).toBe(200);
      expect(res.json).toEqual({ state: "unset" });
      expect(setCookieOf(res)).toBeUndefined();
      expect(res.headers.get("cache-control")).toBe("no-store");
    });
  });

  describe("異常系", () => {
    it("入力: 別のオリジンからは 403 origin_not_allowed", async () => {
      const id = await grant();

      const res = await get({ origin: OTHER_ORIGIN, cookie: cookieFor(id) });

      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "origin_not_allowed" });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("入力: 未発行の識別子の Cookie は unset（他人の記録も、作られていない記録も読めない）", async () => {
      const res = await get({ origin: SITE, cookie: cookieFor(FORGED_ID) });

      expect(res.status).toBe(200);
      expect(res.json).toEqual({ state: "unset" });
    });

    it("サーバ: Valkey が応答しない間、Cookie つきの GET は 503 unavailable で、Cookie なしの GET は Valkey を見ずに unset", async () => {
      const id = await grant();

      const [withCookie, withoutCookie] = await whileValkeyPaused(() =>
        Promise.all([get({ origin: SITE, cookie: cookieFor(id) }), get({ origin: SITE })]),
      );

      expect(withCookie.status).toBe(503);
      expect(withCookie.json).toEqual({ error: "unavailable" });
      expect(withoutCookie.status).toBe(200);
      expect(withoutCookie.json).toEqual({ state: "unset" });
      await waitForRecovery();
      expect((await get({ cookie: cookieFor(id) })).json?.state).toBe("granted");
    });
  });
});

describe("OPTIONS /v1/consent（プリフライト）", () => {
  describe("正常系", () => {
    it("許したオリジンには 204 と、メソッド・ヘッダー・Max-Age・Vary を返す", async () => {
      const res = await http(CONSENT_URL, {
        method: "OPTIONS",
        headers: { origin: SITE, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(SITE);
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
      expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
      expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type");
      expect(res.headers.get("access-control-max-age")).toBe("600");
      expect(res.headers.get("vary")).toContain("Origin");
    });
  });

  describe("異常系", () => {
    it("入力: ほかのオリジンには 403 で、許可のメソッドを返さない", async () => {
      const res = await http<ConsentBody>(CONSENT_URL, { method: "OPTIONS", headers: { origin: OTHER_ORIGIN, "access-control-request-method": "POST" } });

      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "origin_not_allowed" });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("access-control-allow-methods")).toBeNull();
    });

    it("空入力: Origin が無ければ 403", async () => {
      const res = await http<ConsentBody>(CONSENT_URL, { method: "OPTIONS" });

      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "origin_not_allowed" });
    });
  });
});

describe("ルーティング", () => {
  describe("異常系", () => {
    it.each(["PUT", "DELETE", "PATCH"])("入力: %s は 405 method_not_allowed で、Allow を返す", async (method) => {
      const res = await http<ConsentBody>(CONSENT_URL, { method, headers: { origin: SITE, "content-type": "application/json" }, body: '{"state":"granted"}' });

      expect(res.status).toBe(405);
      expect(res.json).toEqual({ error: "method_not_allowed" });
      expect(res.headers.get("allow")).toBe("GET, POST, OPTIONS");
      expect(setCookieOf(res)).toBeUndefined();
    });

    it("入力: 知らないパスは 404 not_found で、Cache-Control: no-store を付ける", async () => {
      const res = await http<ConsentBody>(`${DEV.consentApi}/v1/consents`, { headers: { origin: SITE } });

      expect(res.status).toBe(404);
      expect(res.json).toEqual({ error: "not_found" });
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("空入力: パスが / だけなら 404", async () => {
      const res = await http<ConsentBody>(`${DEV.consentApi}/`);

      expect(res.status).toBe(404);
      expect(res.json).toEqual({ error: "not_found" });
    });
  });
});

describe("GET /healthz", () => {
  describe("正常系", () => {
    it("GET と HEAD に 200 を返す", async () => {
      const getRes = await http(`${DEV.consentApi}/healthz`);
      const headRes = await http(`${DEV.consentApi}/healthz`, { method: "HEAD" });

      expect(getRes.status).toBe(200);
      expect(getRes.json).toEqual({ ok: true });
      expect(headRes.status).toBe(200);
    });

    it("空入力: クエリが空（? だけ）でも同じパスとして 200", async () => {
      const res = await http(`${DEV.consentApi}/healthz?`);

      expect(res.status).toBe(200);
    });
  });

  describe("異常系", () => {
    it("入力: GET・HEAD 以外は 405 で、Allow: GET, HEAD を返す", async () => {
      const res = await http<ConsentBody>(`${DEV.consentApi}/healthz`, { method: "POST" });

      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
    });

    it("サーバ: Valkey が応答しなくても 200（Valkey の瞬断でタスクが ALB から外れないように）", async () => {
      const res = await whileValkeyPaused(() => http(`${DEV.consentApi}/healthz`, { timeoutMs: 5_000 }));

      expect(res.status).toBe(200);
      expect(res.json).toEqual({ ok: true });
    });
  });
});
