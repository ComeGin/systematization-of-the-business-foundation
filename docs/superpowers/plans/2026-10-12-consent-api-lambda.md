# consent-api の Lambda 化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** consent-api を ECS on Fargate から VPC の中の Lambda（ALB のターゲット）に移す。API の振る舞いは 1 つも変えない。

**Architecture:** 今の `server.ts` の中身を、入口に依存しない `handler.ts`（`HttpRequest` → `HttpResponse`。例外を投げない）に移し、開発の入口 `server.ts`（Node の http）と本番の入口 `lambda.ts`（ALB のイベント ↔ handler、Valkey の接続の使い回し）に分ける（faq-bot と同じ形）。IaC は `services/consent-api.yaml` を SAM の関数・エイリアス・lambda 型のターゲットグループに書き換え、edge・network・alarms・cluster・ecr・親テンプレートを合わせる。

**Tech Stack:** Node.js 22（Lambda は `nodejs22.x`・arm64）、TypeScript、ioredis 6、zod 4、vitest 5、esbuild、AWS SAM（CloudFormation）、`@aws-sdk/client-secrets-manager`。

**Spec:** `docs/superpowers/specs/2026-10-12-consent-api-lambda-design.md`（実装者はこの計画と一緒に必ず読む）

## Global Constraints

- パッケージマネージャは **pnpm 11**（`npm` は使わない）。作業ディレクトリは `backend/consent-api`。
- **git の状態を変えるコマンド（commit・push・checkout -b など）は使わない**（`.claude/rules/git.md`）。各タスクの最後は `git status --short` と `git diff --stat` で差分を確かめるだけ。
- **ビルドとデプロイ（`pnpm build`・`pnpm bundle`・`sam build`・`sam deploy`）は実行しない**（`.claude/rules/build-deploy.md`）。`pnpm typecheck`（`tsc --noEmit`）と `sam validate` は実行してよい。
- テストは単体・結合とも作り、実行する（仕様の D4）。単体テストの決まり: 対象ごとに `describe("正常系")` / `describe("異常系")`、公開関数・エンドポイントごとに `空入力: ` のケース、異常系の名前は `入力: ` か `サーバ: ` で始める。外部はモック。`testTimeout`/`hookTimeout` は 30 秒。**テストで src のバグを見つけたら、src を直さず `it.todo` と直上のコメントで残す。**
- 秘密値（`.env`・`samconfig.toml`）を読まない・書かない。開発の Valkey のパスワードは `docker exec ... printenv` で取り、画面に出さない。
- 文書・コメントは日本語。
- API の振る舞い（パス・本文・Cookie・CORS・エラーの本文・ヘッダー・Valkey のキー）を変えない（仕様の 4 節）。
- Lambda: タイムアウト **6 秒**、メモリ **256 MB**、予約同時実行数 **10**、エイリアス **`live`**、ターゲットグループの名前 **`comegin-<env>-consent-api`**、ヘルスチェック無効、マルチバリューヘッダー無効。
- `waitReady` の待ち時間は **3 秒**（`VALKEY_READY_TIMEOUT_MS = 3_000`）。
- AUTH トークンの Secret の ID は環境変数 **`VALKEY_PASSWORD_SECRET_ID`**（本番は `<SecretNamePrefix>/shared/VALKEY_AUTH_TOKEN`）。
- アラーム: `consent-api-errors`（`Errors` 1 分 > 0）、`consent-api-throttles`（`Throttles` 1 分 > 0）、`consent-api-target-5xx`（`HTTPCode_Target_5XX_Count` 5 分 ≥ 1）。
- 開発の Valkey を **`127.0.0.1:6380`** にだけ開く（結合テスト用）。

## Review Focus

- ALB が本文を base64 で渡す（`isBase64Encoded: true`。`Content-Type` が json 以外、または `content-encoding` 付き）とき、復号してから同じ判定をする → Task 4 のテスト「本文が base64 なら復号して渡す」。
- ALB のイベントの `headers` が無い・`body` が `null`・ヘッダー名が大文字混じり → 空のヘッダー・空の本文・小文字のヘッダーとして扱う → Task 4 の `空入力:` と「ヘッダー名を小文字にそろえる」。
- 凍結から戻ったとき接続が `reconnecting` → 各呼び出しの前に最大 3 秒待ち、来なければそのまま処理（503）、次の呼び出しで回復する → Task 4 の「呼び出しの前に ready でなければ待つ」と Task 5 の結合テスト。
- コールドスタートの初期化の失敗（Valkey に届かない）で、作りかけの接続を閉じる（再接続し続ける接続を残さない）→ Task 4 の「サーバ: 3 秒以内に ready にならなければ接続を閉じて失敗にする」。
- 要求ターゲットが URL として解釈できない（`//[`）ときも handler は例外を投げず 500 を返す → Task 2 の「サーバ: パスが URL として解釈できなければ 500」。

---

### Task 1: `waitReady` と定数

**Files:**
- Modify: `backend/consent-api/src/constants.ts`（末尾に定数を足す）
- Modify: `backend/consent-api/src/valkey.ts`（`waitReady` を足す）
- Test: `backend/consent-api/tests/valkey.test.ts`（`describe("waitReady")` を足す）

**Interfaces:**
- Produces: `export const VALKEY_READY_TIMEOUT_MS = 3_000;`（`constants.ts`）、`export function waitReady(client: Redis, timeoutMs: number): Promise<boolean>`（`valkey.ts`。`client.status === "ready"` なら即 `true`、そうでなければ `ready` のイベントで `true`、時間切れで `false`。付けたリスナーとタイマーは必ず外す）

- [ ] **Step 1: 失敗するテストを書く**

`tests/valkey.test.ts` の 2 行目の import を次に替える:

```ts
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { Redis } from "ioredis";
import { createValkey, waitReady } from "../src/valkey.js";
```

ファイルの末尾に足す:

```ts
/** status を持つ EventEmitter（ioredis の Redis の、waitReady が使う部分だけ） */
function fakeClient(status: string): EventEmitter & { status: string } {
  return Object.assign(new EventEmitter(), { status });
}

describe("waitReady", () => {
  describe("正常系", () => {
    it("すでに ready なら、待たずに true", async () => {
      const client = fakeClient("ready");
      await expect(waitReady(client as unknown as Redis, 3_000)).resolves.toBe(true);
      expect(client.listenerCount("ready")).toBe(0);
    });

    it("接続中なら ready のイベントを待って true", async () => {
      vi.useFakeTimers();
      try {
        const client = fakeClient("connecting");
        const result = waitReady(client as unknown as Redis, 3_000);
        await vi.advanceTimersByTimeAsync(1_000);
        client.status = "ready";
        client.emit("ready");
        await expect(result).resolves.toBe(true);
        expect(client.listenerCount("ready")).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("空入力: 待ち時間 0 でも ready なら true", async () => {
      await expect(waitReady(fakeClient("ready") as unknown as Redis, 0)).resolves.toBe(true);
    });
  });

  describe("異常系", () => {
    it("サーバ: 時間内に ready が来なければ false で、リスナーを残さない", async () => {
      vi.useFakeTimers();
      try {
        const client = fakeClient("reconnecting");
        const result = waitReady(client as unknown as Redis, 3_000);
        await vi.advanceTimersByTimeAsync(2_999);
        expect(client.listenerCount("ready")).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        await expect(result).resolves.toBe(false);
        expect(client.listenerCount("ready")).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("サーバ: 時間切れのあとに ready が来ても、結果は false のまま", async () => {
      vi.useFakeTimers();
      try {
        const client = fakeClient("connecting");
        const result = waitReady(client as unknown as Redis, 10);
        await vi.advanceTimersByTimeAsync(10);
        client.emit("ready");
        await expect(result).resolves.toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("入力: 接続が閉じた（end）状態でも、時間まで待って false", async () => {
      vi.useFakeTimers();
      try {
        const result = waitReady(fakeClient("end") as unknown as Redis, 100);
        await vi.advanceTimersByTimeAsync(100);
        await expect(result).resolves.toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `cd backend/consent-api && pnpm test -- tests/valkey.test.ts`
Expected: FAIL（`waitReady` が export されていない）

- [ ] **Step 3: 実装する**

`src/constants.ts` の `VALKEY_CONNECT_TIMEOUT_MS` の行の下に足す:

```ts
// Lambda で、コールドスタートの接続の完了と、凍結から戻ったときの再接続を待つ上限（仕様 3.3）
export const VALKEY_READY_TIMEOUT_MS = 3_000;
```

`src/valkey.ts` の末尾に足す:

```ts
/**
 * 接続が ready になるのを待つ（Lambda の入口が使う。仕様 3.3）。enableOfflineQueue: false のため、
 * ready の前に送ったコマンドはすぐ失敗する。すでに ready なら待たない。時間切れなら false（例外にしない）
 */
export function waitReady(client: Redis, timeoutMs: number): Promise<boolean> {
  if (client.status === "ready") return Promise.resolve(true);
  return new Promise((resolve) => {
    const onReady = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      client.off("ready", onReady);
      resolve(false);
    }, timeoutMs);
    client.once("ready", onReady);
  });
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `cd backend/consent-api && pnpm test -- tests/valkey.test.ts && pnpm typecheck`
Expected: PASS、型エラーなし

- [ ] **Step 5: 差分を確かめる（コミットはしない）**

Run: `git status --short backend/consent-api && git diff --stat backend/consent-api`

---

### Task 2: 入口に依存しない本体 `handler.ts`

**Files:**
- Create: `backend/consent-api/src/handler.ts`
- Create: `backend/consent-api/tests/helpers/handle.ts`
- Create: `backend/consent-api/tests/handler.test.ts`（`tests/server.test.ts` を写して編集する）

**Interfaces:**
- Consumes: `Config`（`src/config.ts`）、`ConsentStore`・`StoreUnavailableError`（`src/store.ts`）、`buildSetCookie`・`issueId`・`readCookieId`（`src/cookie.ts`）
- Produces（`src/handler.ts`）:

```ts
export interface HttpRequest {
  readonly method: string;
  /** 要求ターゲット。クエリを含んでよい（handler が URL として解釈してパスだけを使う） */
  readonly path: string;
  /** ヘッダー名は小文字 */
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Buffer;
}
export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}
export type Handle = (req: HttpRequest) => Promise<HttpResponse>;
export interface HandlerDeps { config: Config; store: ConsentStore }
export function createHandler(deps: HandlerDeps): Handle;
```

- `handle` は**例外を投げない**。1 件ごとに stderr に JSON の 1 行（`t`・`method`・`path`〈クエリを除く〉・`status`・`ms`）を出す。
- 413 は、`POST` で `Content-Type` が json のとき、宣言された `content-length` が 1024 を超えるか、`body.length` が 1024 を超えたとき（415 の判定の後、JSON の解析の前。今と同じ順）。`Connection: close` は付けない（開発の入口が付ける）。

- [ ] **Step 1: テストの補助を書く**

`tests/helpers/handle.ts`:

```ts
import type { Handle } from "../../src/handler.js";

export interface InvokeOptions {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

export interface InvokeResult {
  status: number;
  /** ヘッダー名は小文字 */
  headers: Record<string, string>;
  text: string;
  json: unknown;
}

/** 入口（server.ts・lambda.ts）を通さずに handle を呼ぶ。ヘッダー名は入口と同じく小文字にそろえる */
export async function invoke(handle: Handle, options: InvokeOptions = {}): Promise<InvokeResult> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) headers[name.toLowerCase()] = value;
  const body = options.body === undefined ? Buffer.alloc(0) : Buffer.from(options.body);
  const res = await handle({ method: options.method ?? "GET", path: options.path ?? "/v1/consent", headers, body });
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(res.headers)) lower[name.toLowerCase()] = value;
  let json: unknown;
  try {
    json = res.body ? JSON.parse(res.body) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: lower, text: res.body, json };
}
```

- [ ] **Step 2: `tests/server.test.ts` を `tests/handler.test.ts` に写す**

Run: `cd backend/consent-api && cp tests/server.test.ts tests/handler.test.ts`

- [ ] **Step 3: `tests/handler.test.ts` の 1〜79 行目（import から `issuedId` まで）を、次に丸ごと置き換える**

```ts
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { Config } from "../src/config.js";
import { COOKIE_NAME, ID_PATTERN } from "../src/constants.js";
import { createHandler, type Handle } from "../src/handler.js";
import { ConsentStore } from "../src/store.js";
import { makeConfig } from "./helpers/config.js";
import { FakeRedis } from "./helpers/fake-redis.js";
import { type InvokeOptions, type InvokeResult, invoke } from "./helpers/handle.js";

// handler.ts（入口に依存しない本体）の検査。開発の入口（Node の http）に固有のこと
// （本文を途中で打ち切る 413・接続断・ヘッダーの大きさの上限・keep-alive）は server.test.ts で見る
const SITE = "https://comegin.com";
const OTHER_SITE = "https://evil.example";
const EXISTING_ID = "eAd5tbgdBQH8cAOA_oELjQ";
const UNKNOWN_ID = "AAAAAAAAAAAAAAAAAAAAAA";
const keyOf = (id: string) => `test:c:${id}`;
const STORED = { state: "granted", at: "2026-10-01T09:00:00.000Z", policy: "2026-09-01" };

let redis: FakeRedis;
let handle: Handle;
let stderr: MockInstance<typeof console.error>;

function start(config: Config = makeConfig(), store?: ConsentStore): void {
  handle = createHandler({ config, store: store ?? new ConsentStore(redis.asRedis(), config.VALKEY_KEY_PREFIX) });
}

beforeEach(() => {
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  redis = new FakeRedis();
  start();
});

type RequestOptions = InvokeOptions;
type TestResponse = InvokeResult;

const send = (options: RequestOptions) => invoke(handle, options);

const post = (body: string, headers: Record<string, string> = {}) =>
  send({
    method: "POST",
    body,
    headers: { Origin: SITE, "Content-Type": "application/json", ...headers },
  });

const cookieOf = (id: string, state = "granted") => `${COOKIE_NAME}=s=${state}&v=2026-10-01&id=${id}`;

function setCookie(res: TestResponse): string | undefined {
  return res.headers["set-cookie"];
}

/** ioredis が接続断・タイムアウト・応答エラーで投げる代表的なメッセージ */
const VALKEY_FAILURES = [
  ["コマンドのタイムアウト", "Command timed out"],
  ["接続断", "Connection is closed."],
  ["オフラインキューなしで未接続", "Stream isn't writeable and enableOfflineQueue options is false"],
  ["認証エラー", "NOAUTH Authentication required."],
  ["フェイルオーバー中の読み取り専用", "READONLY You can't write against a read only replica."],
] as const;

/** stderr に出たすべての文字列 */
const stderrText = () => stderr.mock.calls.flat().map(String).join("\n");

/** Set-Cookie から識別子を取り出す */
function issuedId(res: TestResponse): string {
  const value = setCookie(res)!.split("; ")[0]!.slice(COOKIE_NAME.length + 1);
  return new URLSearchParams(value).get("id")!;
}
```

- [ ] **Step 4: `tests/handler.test.ts` の残りを、次のとおり編集する**

1. `await close(server);` の行をすべて消す（3 か所）。続く `await start(...)` は `start(...)` にする（`await` を外す）。
2. `it("keep-alive を ALB のアイドルタイムアウト（60 秒）より長くし、headersTimeout はさらに長くする", ...)` を丸ごと消す。
3. 415 のテストの `const headers: http.OutgoingHttpHeaders = { Origin: SITE };` を `const headers: Record<string, string> = { Origin: SITE };` にする。
4. `it("入力: 宣言された Content-Length が 1 KiB を超えれば、本文を読まずに 413 で接続を閉じる", ...)` を次に置き換える:

```ts
    it("入力: 宣言された Content-Length が 1 KiB を超えれば、本文を見ずに 413（CORS のヘッダーは付ける）", async () => {
      const res = await send({
        method: "POST",
        headers: { Origin: SITE, "Content-Type": "application/json", "Content-Length": "4096" },
      });
      expect(res.status).toBe(413);
      expect(res.json).toEqual({ error: "payload_too_large" });
      expect(res.headers.connection).toBeUndefined();
      expect(res.headers["access-control-allow-origin"]).toBe(SITE);
    });
```

5. `it("入力: 宣言された Content-Length が極端に大きくても（1 GiB）、本文を待たずに 413", ...)` の `send({...})` から `headersOnly: true,` の行を消す。
6. `it("入力: Content-Length なし（チャンク）でも 1 KiB を超えた時点で 413", ...)` を次に置き換える:

```ts
    it("入力: Content-Length が無くても、本文が 1 KiB を超えれば 413", async () => {
      const res = await send({
        method: "POST",
        body: `{"state":"granted","pad":"${"x".repeat(1100)}"}`,
        headers: { Origin: SITE, "Content-Type": "application/json" },
      });
      expect(res.status).toBe(413);
      expect(res.json).toEqual({ error: "payload_too_large" });
      expect(redis.streams.size).toBe(0);
    });
```

7. `it("入力: 本文の途中で接続が切れても記録せず、サーバーは次のリクエストに応える", ...)` を丸ごと消す（server.test.ts に残す）。
8. `it("入力: Cookie ヘッダーが Node の上限（16 KiB）を超えれば 431 で、Valkey に触れない", ...)` を丸ごと消す（server.test.ts に残す）。
9. `describe("ルーティングと共通の応答ヘッダー")` の `describe("異常系")` の末尾に足す:

```ts
    it("サーバ: パスが URL として解釈できなければ（//[）、例外を投げず 500 internal", async () => {
      const res = await send({ path: "//[" });
      expect(res.status).toBe(500);
      expect(res.json).toEqual({ error: "internal" });
      expect(redis.calls).toEqual([]);
    });
```

10. `describe("アクセスログ")` の `describe("正常系")` の末尾に足す:

```ts
    it("ログは handle が返る前に出す（入口を問わず 1 件 1 行）", async () => {
      await send({ headers: { Origin: SITE } });
      const lines = stderr.mock.calls.map((args) => args[0]).filter((arg) => typeof arg === "string" && arg.startsWith('{"t":'));
      expect(lines).toHaveLength(1);
    });
```

- [ ] **Step 5: 失敗を確かめる**

Run: `cd backend/consent-api && pnpm test -- tests/handler.test.ts`
Expected: FAIL（`../src/handler.js` が無い）

- [ ] **Step 6: `src/handler.ts` を書く（今の `server.ts` のルーティングをそのまま移す）**

```ts
import * as z from "zod/v4";
import type { Config } from "./config.js";
import { CONSENT_PATH, HEALTH_PATH, MAX_BODY_BYTES, MAX_RECORDS_PER_ID } from "./constants.js";
import { buildSetCookie, issueId, readCookieId } from "./cookie.js";
import { type ConsentStore, StoreUnavailableError } from "./store.js";

/** 入口に依存しない要求（ヘッダー名は小文字）。開発は server.ts、本番は lambda.ts が作る */
export interface HttpRequest {
  readonly method: string;
  /** 要求ターゲット。クエリを含んでよい（ここで URL として解釈してパスだけを使う） */
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Buffer;
}

export interface HttpResponse {
  readonly status: number;
  /** Set-Cookie は 1 つだけ（ALB のマルチバリューヘッダーは無効。仕様 2.1） */
  readonly headers: Readonly<Record<string, string>>;
  /** 204 は空文字 */
  readonly body: string;
}

export type Handle = (req: HttpRequest) => Promise<HttpResponse>;

export interface HandlerDeps {
  config: Config;
  store: ConsentStore;
}

// 受け取る本文は state だけ。ポリシーの版・識別子・時刻は受け取らない（サーバーが決める）
const BodySchema = z.strictObject({ state: z.enum(["granted", "denied"]) });

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(code);
  }
}

const respond = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  },
  body: JSON.stringify(body),
});

/**
 * 同意の API の本体（仕様 3.1）。例外を投げない（Valkey の障害は 503、想定外の失敗は 500 を返す）。
 * ログは 1 件 1 行（時刻・メソッド・パス・ステータス・所要時間）。識別子と IP は出さない
 */
export function createHandler({ config, store }: HandlerDeps): Handle {
  // 公開サイトのオリジンと一致したときだけ CORS を許す（資格情報つき。* は使わない）
  const corsHeaders = (origin: string | undefined): Record<string, string> => {
    const headers: Record<string, string> = { Vary: "Origin" };
    if (origin === config.SITE_URL) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Credentials"] = "true";
    }
    return headers;
  };

  const handleGet = async (req: HttpRequest, cors: Record<string, string>): Promise<HttpResponse> => {
    const id = readCookieId(req.headers.cookie);
    const record = id ? await store.latest(id) : null;
    if (!record) return respond(200, { state: "unset" }, cors);
    return respond(200, { state: record.state, policy_version: record.policy, recorded_at: record.at }, cors);
  };

  const handlePost = async (req: HttpRequest, cors: Record<string, string>): Promise<HttpResponse> => {
    const mediaType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") throw new HttpError(415, "unsupported_media_type");

    // 開発の入口は上限を超えた本文を途中で打ち切って渡す。ALB からは本文が全部届く。どちらもここで判定する
    const declared = Number(req.headers["content-length"]);
    if ((Number.isFinite(declared) && declared > MAX_BODY_BYTES) || req.body.length > MAX_BODY_BYTES) {
      throw new HttpError(413, "payload_too_large");
    }

    let json: unknown;
    try {
      json = JSON.parse(req.body.toString("utf8"));
    } catch {
      throw new HttpError(400, "invalid_json");
    }
    const parsed = BodySchema.safeParse(json);
    if (!parsed.success) throw new HttpError(400, "invalid_body");
    const { state } = parsed.data;

    // Cookie の識別子は、形式が正しく、かつサーバーが発行済み（Stream がある）ときだけ引き継ぐ。
    // それ以外は新しく発行する。訪問者が好きな識別子で記録を作れないようにするため
    let id: string | null = null;
    const cookieId = readCookieId(req.headers.cookie);
    if (cookieId) {
      const { exists, count } = await store.inspect(cookieId);
      if (exists) {
        if (count >= MAX_RECORDS_PER_ID) throw new HttpError(429, "too_many_records");
        id = cookieId;
      }
    }
    id ??= issueId();

    const at = new Date().toISOString();
    await store.append(id, { state, at, policy: config.CONSENT_POLICY_VERSION });

    // Cookie は記録に成功したときだけ書く
    return respond(
      201,
      { state, policy_version: config.CONSENT_POLICY_VERSION, recorded_at: at },
      { ...cors, "Set-Cookie": buildSetCookie(config, state, id) },
    );
  };

  const route = async (req: HttpRequest): Promise<HttpResponse> => {
    const { pathname } = new URL(req.path, "http://localhost");
    const method = req.method;

    if (pathname === HEALTH_PATH) {
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method_not_allowed", { Allow: "GET, HEAD" });
      // プロセスが生きているかだけを見る（開発用。本番の ALB には出さない）
      return respond(200, { ok: true });
    }

    if (pathname !== CONSENT_PATH) throw new HttpError(404, "not_found");

    const origin = req.headers.origin;
    const cors = corsHeaders(origin);

    if (method === "OPTIONS") {
      if (origin !== config.SITE_URL) throw new HttpError(403, "origin_not_allowed", cors);
      return {
        status: 204,
        headers: {
          ...cors,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
        },
        body: "",
      };
    }

    if (method !== "GET" && method !== "POST") {
      throw new HttpError(405, "method_not_allowed", { ...cors, Allow: "GET, POST, OPTIONS" });
    }
    // 書き込みは必ず公開サイトのオリジンから。GET は Origin が付いたときだけ照合する
    if (method === "POST" ? origin !== config.SITE_URL : origin !== undefined && origin !== config.SITE_URL) {
      throw new HttpError(403, "origin_not_allowed", cors);
    }

    try {
      return method === "GET" ? await handleGet(req, cors) : await handlePost(req, cors);
    } catch (error) {
      if (error instanceof HttpError) throw new HttpError(error.status, error.code, { ...cors, ...error.headers });
      throw error;
    }
  };

  return async (req) => {
    const startedAt = Date.now();
    let res: HttpResponse;
    try {
      res = await route(req);
    } catch (error) {
      if (error instanceof HttpError) {
        res = respond(error.status, { error: error.code }, error.headers);
      } else if (error instanceof StoreUnavailableError) {
        console.error(`[store] ${error.message}: ${(error.cause as Error | undefined)?.message ?? "unknown"}`);
        res = respond(503, { error: "unavailable" }, corsHeaders(req.headers.origin));
      } else {
        console.error("[server] unexpected error", error);
        res = respond(500, { error: "internal" }, corsHeaders(req.headers.origin));
      }
    }
    // 識別子と IP は記録しない
    console.error(
      JSON.stringify({
        t: new Date().toISOString(),
        method: req.method,
        path: req.path.split("?")[0],
        status: res.status,
        ms: Date.now() - startedAt,
      }),
    );
    return res;
  };
}
```

- [ ] **Step 7: 通ることを確かめる**

Run: `cd backend/consent-api && pnpm test -- tests/handler.test.ts && pnpm typecheck`
Expected: PASS（`server.test.ts` はまだ古い `createServer` を使うので、このステップでは対象にしない）

- [ ] **Step 8: 差分を確かめる（コミットはしない）**

Run: `git status --short backend/consent-api`

---

### Task 3: 開発の入口を縮める（`server.ts`・`index.ts`）

**Files:**
- Modify: `backend/consent-api/src/server.ts`（全体を置き換える）
- Modify: `backend/consent-api/src/index.ts:1-9`
- Test: `backend/consent-api/tests/server.test.ts`（全体を置き換える）
- Test: `backend/consent-api/tests/index.test.ts`（モックと 2 つのテストを直す）

**Interfaces:**
- Consumes: `Handle`・`createHandler`（Task 2）
- Produces: `export function createServer(handle: Handle): http.Server`（`server.ts`）

- [ ] **Step 1: 失敗するテストを書く（`tests/server.test.ts` を丸ごと置き換える）**

```ts
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { COOKIE_NAME } from "../src/constants.js";
import { createHandler, type Handle, type HttpRequest, type HttpResponse } from "../src/handler.js";
import { createServer } from "../src/server.js";
import { ConsentStore } from "../src/store.js";
import { makeConfig } from "./helpers/config.js";
import { FakeRedis } from "./helpers/fake-redis.js";
import { close, listen, type RequestOptions, request } from "./helpers/http.js";

// 開発の入口（Node の http）の検査。API の振る舞いは handler.test.ts で見る
const SITE = "https://comegin.com";
const EXISTING_ID = "eAd5tbgdBQH8cAOA_oELjQ";

let redis: FakeRedis;
let server: http.Server;
let baseUrl: string;
let stderr: MockInstance<typeof console.error>;

async function start(handle: Handle): Promise<void> {
  server = createServer(handle);
  baseUrl = await listen(server);
}

/** 本物の handler（Valkey だけ偽物）で起動する */
const realHandle = (): Handle => {
  const config = makeConfig();
  return createHandler({ config, store: new ConsentStore(redis.asRedis(), config.VALKEY_KEY_PREFIX) });
};

beforeEach(() => {
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  redis = new FakeRedis();
});

afterEach(async () => {
  await close(server);
});

const send = (options: RequestOptions) => request(baseUrl, options);

/** サーバーへの接続がすべて閉じるまで待つ（途中で切られたリクエストの後始末を待つ） */
async function waitForNoConnections(): Promise<void> {
  await vi.waitFor(async () => {
    const count = await new Promise<number>((resolve, reject) =>
      server.getConnections((error, value) => (error ? reject(error) : resolve(value))),
    );
    expect(count).toBe(0);
  });
}

describe("createServer", () => {
  describe("正常系", () => {
    it("handle にメソッド・クエリ付きのパス・小文字のヘッダー・本文を渡し、結果をそのまま書き出す", async () => {
      let received: HttpRequest | undefined;
      await start(async (req) => {
        received = req;
        return { status: 201, headers: { "X-Test": "1", "Set-Cookie": "a=b; Path=/" }, body: '{"ok":true}' };
      });
      const res = await send({
        method: "POST",
        path: "/v1/consent?x=1",
        body: '{"state":"granted"}',
        headers: { Origin: SITE, "Content-Type": "application/json" },
      });
      expect(received).toMatchObject({ method: "POST", path: "/v1/consent?x=1" });
      expect(received!.headers.origin).toBe(SITE);
      expect(received!.headers["content-type"]).toBe("application/json");
      expect(received!.body.toString("utf8")).toBe('{"state":"granted"}');
      expect(res.status).toBe(201);
      expect(res.headers["x-test"]).toBe("1");
      expect(res.headers["set-cookie"]).toEqual(["a=b; Path=/"]);
      expect(res.json).toEqual({ ok: true });
    });

    it("空入力: 本文の無い GET には空の Buffer を渡す", async () => {
      let received: HttpRequest | undefined;
      await start(async (req) => {
        received = req;
        return { status: 200, headers: {}, body: "" };
      });
      await send({});
      expect(received!.body.length).toBe(0);
    });

    it("本物の handler と組み合わせて、同意を記録して Cookie を返す", async () => {
      await start(realHandle());
      const res = await send({
        method: "POST",
        body: '{"state":"granted"}',
        headers: { Origin: SITE, "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
      expect(res.headers["set-cookie"]![0]).toMatch(new RegExp(`^${COOKIE_NAME}=s=granted&`));
      expect(redis.streams.size).toBe(1);
    });

    it("keep-alive を 60 秒より長くし、headersTimeout はさらに長くする", async () => {
      await start(realHandle());
      expect(server.keepAliveTimeout).toBeGreaterThan(60_000);
      expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
      expect(server.requestTimeout).toBeGreaterThan(0);
    });
  });

  describe("異常系", () => {
    it("入力: 宣言された Content-Length が 1 KiB を超えれば、本文を読まずに 413 で接続を閉じる", async () => {
      await start(realHandle());
      const res = await send({
        method: "POST",
        headersOnly: true,
        headers: { Origin: SITE, "Content-Type": "application/json", "Content-Length": "4096" },
      });
      expect(res.status).toBe(413);
      expect(res.json).toEqual({ error: "payload_too_large" });
      expect(res.headers.connection).toBe("close");
      expect(res.headers["access-control-allow-origin"]).toBe(SITE);
    });

    it("入力: 宣言された Content-Length が極端に大きくても（1 GiB）、本文を待たずに 413", async () => {
      await start(realHandle());
      const res = await send({
        method: "POST",
        headersOnly: true,
        headers: { Origin: SITE, "Content-Type": "application/json", "Content-Length": String(1024 ** 3) },
      });
      expect(res.status).toBe(413);
      expect(redis.calls).toEqual([]);
    });

    it("入力: Content-Length なし（チャンク）でも 1 KiB を超えた時点で読むのをやめ、413 で接続を閉じる", async () => {
      let size = -1;
      const handle = realHandle();
      await start(async (req) => {
        size = req.body.length;
        return handle(req);
      });
      const res = await send({
        method: "POST",
        chunked: true,
        body: `{"state":"granted","pad":"${"x".repeat(5_000)}"}`,
        headers: { Origin: SITE, "Content-Type": "application/json" },
      });
      expect(res.status).toBe(413);
      expect(res.headers.connection).toBe("close");
      // 1 回の write は 1 つのチャンクで届きうるため、上限を超えたことだけを見る（何バイトで止まるかは見ない）
      expect(size).toBeGreaterThan(1024);
      expect(redis.streams.size).toBe(0);
    });

    // 接続断が読み取りの例外になるか、途中までの本文で終わるかは Node の版による。どちらでも記録しないことだけを見る
    it("入力: 本文の途中で接続が切れても記録せず、サーバーは次のリクエストに応える", async () => {
      await start(realHandle());
      const req = http.request(new URL("/v1/consent", baseUrl), {
        method: "POST",
        agent: false,
        headers: { Origin: SITE, "Content-Type": "application/json", "Content-Length": "100" },
      });
      req.on("error", () => {});
      req.write('{"state":"gra');
      await new Promise((resolve) => setTimeout(resolve, 20));
      req.destroy();
      await waitForNoConnections();
      expect(redis.calls).toEqual([]);

      const res = await send({
        method: "POST",
        body: '{"state":"granted"}',
        headers: { Origin: SITE, "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
    });

    it("入力: Cookie ヘッダーが Node の上限（16 KiB）を超えれば 431 で、handle を呼ばない", async () => {
      const handle = vi.fn(realHandle());
      await start(handle);
      const res = await send({
        headers: { Origin: SITE, Cookie: `pad=${"x".repeat(20_000)}; ${COOKIE_NAME}=id=${EXISTING_ID}` },
      });
      expect(res.status).toBe(431);
      expect(handle).not.toHaveBeenCalled();
    });

    it("サーバ: handle が例外を投げたら（約束違反）、詳細を出さずに 500 internal", async () => {
      await start(async () => {
        throw new TypeError("boom: internal detail");
      });
      const res = await send({ headers: { Origin: SITE } });
      expect(res.status).toBe(500);
      expect(res.json).toEqual({ error: "internal" });
      expect(res.text).not.toContain("boom");
      expect(stderr).toHaveBeenCalledWith("[server] unexpected error", expect.any(TypeError));
    });

    it("サーバ: handle の応答が返らなくても、他の接続は受け付ける", async () => {
      let calls = 0;
      await start(async (): Promise<HttpResponse> => {
        calls += 1;
        if (calls === 1) return new Promise(() => {});
        return { status: 200, headers: {}, body: "" };
      });
      void send({}).catch(() => {});
      const res = await send({});
      expect(res.status).toBe(200);
    });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `cd backend/consent-api && pnpm test -- tests/server.test.ts`
Expected: FAIL（`createServer` が `Handle` を受け取らない／型が合わない）

- [ ] **Step 3: `src/server.ts` を丸ごと置き換える**

```ts
import http from "node:http";
import { HEADERS_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS, MAX_BODY_BYTES, REQUEST_TIMEOUT_MS } from "./constants.js";
import type { Handle } from "./handler.js";

interface ReadBody {
  body: Buffer;
  /** 最後まで読んだか。読み残しがあれば、応答に Connection: close を付けて接続を閉じる */
  complete: boolean;
}

/**
 * 本文を上限 + 1 バイトまで読む（判定は handler が行う）。宣言された長さが上限を超えていれば読まない。
 * 接続が途中で切れたら例外になる
 */
async function readBody(req: http.IncomingMessage): Promise<ReadBody> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { body: Buffer.alloc(0), complete: false };
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    chunks.push(buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return { body: Buffer.concat(chunks), complete: false };
  }
  return { body: Buffer.concat(chunks), complete: true };
}

/**
 * 開発の入口（3104。仕様 3.1）。要求を HttpRequest に詰めて handle を呼び、結果を書き出すだけ。
 * 本番は lambda.ts（ALB のターゲット）で、keep-alive などの設定は開発だけの意味になる
 */
export function createServer(handle: Handle): http.Server {
  const server = http.createServer(async (req, res) => {
    let read: ReadBody;
    try {
      read = await readBody(req);
    } catch {
      // 本文の途中で接続が切れた。記録しない
      res.destroy();
      return;
    }
    try {
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(req.headers)) headers[name] = Array.isArray(value) ? value.join(", ") : value;
      const result = await handle({ method: req.method ?? "GET", path: req.url ?? "/", headers, body: read.body });
      res.writeHead(result.status, read.complete ? result.headers : { ...result.headers, Connection: "close" });
      res.end(result.body);
    } catch (error) {
      // handle は例外を投げない約束。投げたら詳細を出さずに 500 にする
      console.error("[server] unexpected error", error);
      if (res.headersSent) return void res.end();
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "internal" }));
    }
  });

  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}
```

`src/constants.ts` の keep-alive のコメントを次に替える（値は変えない）:

```ts
// 開発の入口（server.ts）だけが使う。以前の ECS では ALB のアイドルタイムアウト（既定 60 秒）より長くする必要があった
```

- [ ] **Step 4: `src/index.ts` の 1〜9 行目を替える**

```ts
import { loadConfig } from "./config.js";
import { SERVER_NAME, SHUTDOWN_TIMEOUT_MS } from "./constants.js";
import { createHandler } from "./handler.js";
import { createServer } from "./server.js";
import { ConsentStore } from "./store.js";
import { createValkey } from "./valkey.js";

// 開発の入口（pnpm dev・compose）。本番は lambda.ts
const config = loadConfig();
const valkey = createValkey(config);
const server = createServer(createHandler({ config, store: new ConsentStore(valkey, config.VALKEY_KEY_PREFIX) }));
```

18 行目のコメント `// ECS の停止（SIGTERM）では、...` を `// 停止（SIGTERM・SIGINT）では、処理中のリクエストを終えてから Valkey を閉じる（開発だけ。Lambda では要らない）` に替える。

- [ ] **Step 5: `tests/index.test.ts` を直す**

`vi.hoisted` と `vi.mock` を次に替える:

```ts
const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  createValkey: vi.fn(),
  createServer: vi.fn(),
  createHandler: vi.fn(),
}));
vi.mock("../src/config.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../src/valkey.js", () => ({ createValkey: mocks.createValkey }));
vi.mock("../src/server.js", () => ({ createServer: mocks.createServer }));
vi.mock("../src/handler.js", () => ({ createHandler: mocks.createHandler }));

/** createHandler が返す handle の代わり */
const HANDLE = () => Promise.resolve({ status: 200, headers: {}, body: "" });
```

`beforeEach` に `mocks.createHandler.mockReturnValue(HANDLE);` を足す。

「設定を読み、その設定で Valkey とサーバーを作る」を次に替える:

```ts
    it("設定を読み、その設定で Valkey・handler・サーバーを作る", async () => {
      await boot();
      expect(mocks.loadConfig).toHaveBeenCalledTimes(1);
      expect(mocks.createValkey).toHaveBeenCalledWith(config);
      // resetModules 後の index.ts と同じモジュールのクラスで照合する
      const { ConsentStore } = await import("../src/store.js");
      expect(mocks.createHandler).toHaveBeenCalledWith({ config, store: expect.any(ConsentStore) });
      expect(mocks.createServer).toHaveBeenCalledWith(HANDLE);
    });
```

「ストアは作った Valkey と VALKEY_KEY_PREFIX を使う」の 1 行目の取り出しを替える:

```ts
      const { store } = mocks.createHandler.mock.calls[0]![0] as { store: ConsentStore };
```

「空入力: 必須の環境変数が無く loadConfig が止めたら、...」の末尾に `expect(mocks.createHandler).not.toHaveBeenCalled();` を足す。「サーバ: Valkey のクライアントが作れなければ、...」の末尾に `expect(mocks.createHandler).not.toHaveBeenCalled();` を足す。

- [ ] **Step 6: 単体テストをすべて通す**

Run: `cd backend/consent-api && pnpm test && pnpm typecheck`
Expected: PASS（全ファイル）、型エラーなし

- [ ] **Step 7: 差分を確かめる（コミットはしない）**

Run: `git status --short backend/consent-api && git diff --stat backend/consent-api`

---

### Task 4: 本番の入口 `lambda.ts` とビルドの設定

**Files:**
- Create: `backend/consent-api/src/lambda.ts`
- Create: `backend/consent-api/Makefile`
- Modify: `backend/consent-api/package.json`（scripts と devDependencies）
- Modify: `backend/consent-api/.gitignore`、`backend/consent-api/.dockerignore`（`dist-lambda` を足す）
- Test: `backend/consent-api/tests/lambda.test.ts`

**Interfaces:**
- Consumes: `createHandler`・`Handle`・`HttpRequest`・`HttpResponse`（Task 2）、`createValkey`・`waitReady`（Task 1）、`VALKEY_READY_TIMEOUT_MS`（Task 1）、`loadConfig`（`src/config.ts`）
- Produces（`src/lambda.ts`）:

```ts
export interface AlbEvent {
  readonly httpMethod?: string;
  readonly path?: string;
  readonly headers?: Readonly<Record<string, string | undefined>> | null;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
}
export interface AlbResult {
  statusCode: number;
  statusDescription: string;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: false;
}
export interface Runtime { readonly handle: Handle; readonly valkey: Redis }
export function toRequest(event: AlbEvent): HttpRequest;
export function toResult(res: HttpResponse): AlbResult;
export async function loadValkeyPassword(client: Pick<SecretsManagerClient, "send">, secretId: string): Promise<string>;
export async function initRuntime(deps?: { env?: NodeJS.ProcessEnv; loadPassword?: () => Promise<string> }): Promise<Runtime>;
export function createLambdaHandler(init: () => Promise<Runtime>, readyTimeoutMs?: number): (event: AlbEvent) => Promise<AlbResult>;
export const handler: (event: AlbEvent) => Promise<AlbResult>;
```

- [ ] **Step 1: 依存と scripts を足す**

Run: `cd backend/consent-api && pnpm add -D esbuild@^0.28.2 @aws-sdk/client-secrets-manager@^3.1146.0`
Expected: `package.json` の devDependencies に 2 つが入る（faq-bot と同じ版の指定。`minimumReleaseAge` で 7 日未満の版は入らない）

`package.json` の `scripts` を次にする（`bundle`・`test:integration` を足し、`clean` に `dist-lambda` を足す）:

```json
  "scripts": {
    "build": "tsc",
    "bundle": "esbuild src/lambda.ts --bundle --platform=node --target=node22 --format=esm --sourcemap --outfile=dist-lambda/index.mjs --external:@aws-sdk/*",
    "start": "node --env-file-if-exists=.env dist/index.js",
    "dev": "tsx watch --env-file-if-exists=.env src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "clean": "rm -rf dist dist-lambda"
  },
```

`"description"` を `"Cookie consent recorder (writes append-only records to Valkey. AWS Lambda behind the ALB in production)"` にする。

`Makefile`（タブでインデントする）:

```make
# SAM の BuildMethod: makefile が呼ぶ（cloud/stacks/services/consent-api.yaml の Metadata）。
# npm を使わず、pnpm（pnpm-workspace.yaml のサプライチェーン対策つき）で依存を入れ、esbuild で 1 ファイルにまとめる。
# @aws-sdk/* は Lambda の実行環境にあるので含めない（package.json の bundle）。
build-ConsentApiFunction:
	pnpm install --frozen-lockfile
	pnpm run bundle
	cp dist-lambda/index.mjs dist-lambda/index.mjs.map "$(ARTIFACTS_DIR)/"
```

`.gitignore` に `dist-lambda/` を、`.dockerignore` に `dist-lambda` と `Makefile` を足す。

- [ ] **Step 2: 失敗するテストを書く（`tests/lambda.test.ts`）**

```ts
import { EventEmitter } from "node:events";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { HttpRequest } from "../src/handler.js";
import { type AlbEvent, createLambdaHandler, initRuntime, loadValkeyPassword, type Runtime, toRequest, toResult } from "../src/lambda.js";

// Valkey の接続は偽物にする（実接続しない）。waitReady はテストごとに結果を決める
const mocks = vi.hoisted(() => ({ createValkey: vi.fn(), waitReady: vi.fn() }));
vi.mock("../src/valkey.js", () => ({ createValkey: mocks.createValkey, waitReady: mocks.waitReady }));

const SITE = "https://comegin.com";
const ENV = {
  VALKEY_URL: "rediss://cache.example:6379",
  SITE_URL: SITE,
  COOKIE_DOMAIN: ".comegin.com",
  CONSENT_POLICY_VERSION: "2026-10-01",
  VALKEY_PASSWORD_SECRET_ID: "comegin/prod/shared/VALKEY_AUTH_TOKEN",
};

let stderr: MockInstance<typeof console.error>;
let valkey: EventEmitter & { status: string; disconnect: ReturnType<typeof vi.fn> };

beforeEach(() => {
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  valkey = Object.assign(new EventEmitter(), { status: "ready", disconnect: vi.fn() });
  mocks.createValkey.mockReset().mockReturnValue(valkey);
  mocks.waitReady.mockReset().mockResolvedValue(true);
});

const event = (overrides: Partial<AlbEvent> = {}): AlbEvent => ({
  httpMethod: "GET",
  path: "/v1/consent",
  headers: { origin: SITE },
  body: "",
  isBase64Encoded: false,
  ...overrides,
});

/** handle を差し替えた Runtime（Valkey は偽物） */
const runtimeWith = (handle: Runtime["handle"]): Runtime => ({ handle, valkey: valkey as unknown as Runtime["valkey"] });

describe("toRequest", () => {
  describe("正常系", () => {
    it("メソッド・パス・本文をそのまま渡し、ヘッダー名を小文字にそろえる", () => {
      const req = toRequest(
        event({ httpMethod: "POST", headers: { Origin: SITE, "Content-Type": "application/json" }, body: '{"state":"granted"}' }),
      );
      expect(req).toMatchObject({ method: "POST", path: "/v1/consent" });
      expect(req.headers).toEqual({ origin: SITE, "content-type": "application/json" });
      expect(req.body.toString("utf8")).toBe('{"state":"granted"}');
    });

    it("本文が base64 なら復号して渡す", () => {
      const req = toRequest(event({ body: Buffer.from('{"state":"denied"}').toString("base64"), isBase64Encoded: true }));
      expect(req.body.toString("utf8")).toBe('{"state":"denied"}');
    });

    it("空入力: headers・body・メソッド・パスが無ければ、空のヘッダー・空の本文・GET・/ にする", () => {
      const req = toRequest({ headers: null, body: null });
      expect(req).toEqual({ method: "GET", path: "/", headers: {}, body: Buffer.alloc(0) });
    });
  });

  describe("異常系", () => {
    it("入力: 値が undefined のヘッダーは undefined のまま渡す（文字列にしない）", () => {
      const req = toRequest(event({ headers: { Cookie: undefined } }));
      expect(req.headers.cookie).toBeUndefined();
    });

    it("入力: base64 の印が無い本文は、base64 らしく見えても復号しない", () => {
      const req = toRequest(event({ body: "eyJzdGF0ZSI6ImdyYW50ZWQifQ==", isBase64Encoded: false }));
      expect(req.body.toString("utf8")).toBe("eyJzdGF0ZSI6ImdyYW50ZWQifQ==");
    });
  });
});

describe("toResult", () => {
  describe("正常系", () => {
    it("ステータス・理由句・ヘッダー（Set-Cookie を含む）・本文を ALB の形にする", () => {
      const result = toResult({ status: 201, headers: { "Set-Cookie": "comegin_consent=x", Vary: "Origin" }, body: "{}" });
      expect(result).toEqual({
        statusCode: 201,
        statusDescription: "201 Created",
        headers: { "Set-Cookie": "comegin_consent=x", Vary: "Origin" },
        body: "{}",
        isBase64Encoded: false,
      });
    });

    it("空入力: 本文が空の 204 も、そのまま返す", () => {
      expect(toResult({ status: 204, headers: {}, body: "" })).toMatchObject({ statusCode: 204, statusDescription: "204 No Content", body: "" });
    });
  });

  describe("異常系", () => {
    it("入力: 理由句の無いステータスは数字だけにする", () => {
      expect(toResult({ status: 599, headers: {}, body: "" }).statusDescription).toBe("599");
    });
  });
});

describe("loadValkeyPassword", () => {
  describe("正常系", () => {
    it("Secret の ID で GetSecretValue を呼び、文字列の値を返す", async () => {
      const send = vi.fn().mockResolvedValue({ SecretString: "auth-token" });
      await expect(loadValkeyPassword({ send } as never, "comegin/prod/shared/VALKEY_AUTH_TOKEN")).resolves.toBe("auth-token");
      const command = send.mock.calls[0]![0] as GetSecretValueCommand;
      expect(command).toBeInstanceOf(GetSecretValueCommand);
      expect(command.input).toEqual({ SecretId: "comegin/prod/shared/VALKEY_AUTH_TOKEN" });
    });
  });

  describe("異常系", () => {
    it("空入力: Secret の ID が空なら、SDK を呼ばずに失敗する", async () => {
      const send = vi.fn();
      await expect(loadValkeyPassword({ send } as never, "")).rejects.toThrow("VALKEY_PASSWORD_SECRET_ID");
      expect(send).not.toHaveBeenCalled();
    });

    it("サーバ: Secret に文字列の値が無ければ失敗し、メッセージに値を含めない", async () => {
      const send = vi.fn().mockResolvedValue({ SecretBinary: new Uint8Array([1]) });
      await expect(loadValkeyPassword({ send } as never, "id")).rejects.toThrow("id に値が無い");
    });

    it("サーバ: SDK の例外（権限・NAT の断）はそのまま投げる", async () => {
      const send = vi.fn().mockRejectedValue(new Error("AccessDeniedException"));
      await expect(loadValkeyPassword({ send } as never, "id")).rejects.toThrow("AccessDeniedException");
    });
  });
});

describe("initRuntime", () => {
  describe("正常系", () => {
    it("読んだパスワードで Valkey を作り、ready を待ってから handle を返す", async () => {
      const runtime = await initRuntime({ env: ENV, loadPassword: async () => "auth-token" });
      expect(mocks.createValkey).toHaveBeenCalledWith(expect.objectContaining({ VALKEY_PASSWORD: "auth-token", VALKEY_URL: ENV.VALKEY_URL }));
      expect(mocks.waitReady).toHaveBeenCalledWith(valkey, 3_000);
      expect(runtime.valkey).toBe(valkey);
      const res = await runtime.handle({ method: "GET", path: "/healthz", headers: {}, body: Buffer.alloc(0) });
      expect(res.status).toBe(200);
    });

    it("空入力: パスワードが空文字なら認証なし（開発の Valkey）で作る", async () => {
      await initRuntime({ env: ENV, loadPassword: async () => "" });
      expect((mocks.createValkey.mock.calls[0]![0] as { VALKEY_PASSWORD?: string }).VALKEY_PASSWORD).toBeUndefined();
    });
  });

  describe("異常系", () => {
    it("サーバ: 3 秒以内に ready にならなければ、接続を閉じて失敗にする", async () => {
      mocks.waitReady.mockResolvedValue(false);
      await expect(initRuntime({ env: ENV, loadPassword: async () => "auth-token" })).rejects.toThrow("Valkey");
      expect(valkey.disconnect).toHaveBeenCalledTimes(1);
    });

    it("サーバ: パスワードを読めなければ、Valkey を作らずに失敗する", async () => {
      await expect(
        initRuntime({
          env: ENV,
          loadPassword: async () => {
            throw new Error("ResourceNotFoundException");
          },
        }),
      ).rejects.toThrow("ResourceNotFoundException");
      expect(mocks.createValkey).not.toHaveBeenCalled();
    });

    it("サーバ: 失敗のメッセージとログにパスワードを出さない", async () => {
      mocks.waitReady.mockResolvedValue(false);
      const error = await initRuntime({ env: ENV, loadPassword: async () => "auth-token-should-not-leak" }).catch((e: Error) => e);
      expect(String((error as Error).message)).not.toContain("auth-token-should-not-leak");
      expect(stderr.mock.calls.flat().map(String).join("\n")).not.toContain("auth-token-should-not-leak");
    });
  });
});

describe("createLambdaHandler", () => {
  describe("正常系", () => {
    it("ALB のイベントを handle に渡し、結果を ALB の形で返す", async () => {
      let received: HttpRequest | undefined;
      const handler = createLambdaHandler(async () =>
        runtimeWith(async (req) => {
          received = req;
          return { status: 200, headers: { Vary: "Origin" }, body: '{"state":"unset"}' };
        }),
      );
      const result = await handler(event({ headers: { Origin: SITE } }));
      expect(received!.headers.origin).toBe(SITE);
      expect(result).toMatchObject({ statusCode: 200, body: '{"state":"unset"}', isBase64Encoded: false });
    });

    it("初期化は最初の呼び出しの 1 回だけで、以後は同じ handle を使う", async () => {
      const init = vi.fn(async () => runtimeWith(async () => ({ status: 200, headers: {}, body: "" })));
      const handler = createLambdaHandler(init);
      await handler(event());
      await handler(event());
      await handler(event());
      expect(init).toHaveBeenCalledTimes(1);
    });

    it("呼び出しの前に ready でなければ待つ（凍結から戻ったときの再接続）", async () => {
      const handle = vi.fn(async () => ({ status: 200, headers: {}, body: "" }));
      const handler = createLambdaHandler(async () => runtimeWith(handle), 3_000);
      await handler(event());
      expect(mocks.waitReady).toHaveBeenCalledWith(valkey, 3_000);
      expect(handle).toHaveBeenCalledTimes(1);
    });

    it("空入力: 本文の無いイベントでも handle を呼ぶ", async () => {
      const handle = vi.fn(async () => ({ status: 200, headers: {}, body: "" }));
      const handler = createLambdaHandler(async () => runtimeWith(handle));
      await handler({});
      expect(handle).toHaveBeenCalledWith({ method: "GET", path: "/", headers: {}, body: Buffer.alloc(0) });
    });
  });

  describe("異常系", () => {
    it("サーバ: 初期化に失敗したら例外を投げ（Errors に数え、ALB は 502）、次の呼び出しでやり直す", async () => {
      const init = vi
        .fn<() => Promise<Runtime>>()
        .mockRejectedValueOnce(new Error("Valkey に 3 秒以内に接続できない"))
        .mockResolvedValue(runtimeWith(async () => ({ status: 200, headers: {}, body: "" })));
      const handler = createLambdaHandler(init);
      await expect(handler(event())).rejects.toThrow("Valkey");
      await expect(handler(event())).resolves.toMatchObject({ statusCode: 200 });
      expect(init).toHaveBeenCalledTimes(2);
    });

    it("サーバ: 待っても ready にならなければ、そのまま handle を呼ぶ（handle が 503 を返す）", async () => {
      mocks.waitReady.mockResolvedValue(false);
      const handle = vi.fn(async () => ({ status: 503, headers: {}, body: '{"error":"unavailable"}' }));
      const handler = createLambdaHandler(async () => runtimeWith(handle));
      await expect(handler(event())).resolves.toMatchObject({ statusCode: 503 });
      expect(handle).toHaveBeenCalledTimes(1);
    });
  });
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `cd backend/consent-api && pnpm test -- tests/lambda.test.ts`
Expected: FAIL（`../src/lambda.js` が無い）

- [ ] **Step 4: `src/lambda.ts` を書く**

```ts
import { STATUS_CODES } from "node:http";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { Redis } from "ioredis";
import { loadConfig } from "./config.js";
import { VALKEY_READY_TIMEOUT_MS } from "./constants.js";
import { createHandler, type Handle, type HttpRequest, type HttpResponse } from "./handler.js";
import { ConsentStore } from "./store.js";
import { createValkey, waitReady } from "./valkey.js";

// 本番の入口（ALB のターゲット。マルチバリューヘッダーは無効。仕様 2.1・3.2）。
// SAM の Handler は index.handler（bundle が dist-lambda/index.mjs を作る）
export interface AlbEvent {
  readonly httpMethod?: string;
  readonly path?: string;
  readonly headers?: Readonly<Record<string, string | undefined>> | null;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
}

export interface AlbResult {
  statusCode: number;
  statusDescription: string;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: false;
}

export interface Runtime {
  readonly handle: Handle;
  readonly valkey: Redis;
}

export function toRequest(event: AlbEvent): HttpRequest {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(event.headers ?? {})) headers[name.toLowerCase()] = value;
  const body = event.body ? Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8") : Buffer.alloc(0);
  return { method: event.httpMethod ?? "GET", path: event.path ?? "/", headers, body };
}

export function toResult(res: HttpResponse): AlbResult {
  const reason = STATUS_CODES[res.status];
  return {
    statusCode: res.status,
    statusDescription: reason ? `${res.status} ${reason}` : String(res.status),
    headers: { ...res.headers },
    body: res.body,
    isBase64Encoded: false,
  };
}

/** Valkey の AUTH トークンを Secrets Manager から読む（コールドスタートで 1 回だけ）。値はログに出さない（ID だけ） */
export async function loadValkeyPassword(client: Pick<SecretsManagerClient, "send">, secretId: string): Promise<string> {
  if (!secretId) throw new Error("VALKEY_PASSWORD_SECRET_ID が未設定");
  const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!out.SecretString) throw new Error(`${secretId} に値が無い`);
  return out.SecretString;
}

/**
 * 部品を組み立てる（仕様 3.3）。Valkey の接続はモジュールのスコープに 1 本持ち、呼び出しをまたいで使い回す。
 * ready の前に送ったコマンドはすぐ失敗する（enableOfflineQueue: false）ため、ここで ready を待つ。
 * 3 秒以内に来なければ、再接続を続ける接続を残さないよう閉じてから失敗にする
 */
export async function initRuntime(
  deps: { env?: NodeJS.ProcessEnv; loadPassword?: () => Promise<string> } = {},
): Promise<Runtime> {
  const env = deps.env ?? process.env;
  const loadPassword = deps.loadPassword ?? (() => loadValkeyPassword(new SecretsManagerClient({}), env.VALKEY_PASSWORD_SECRET_ID ?? ""));
  const password = await loadPassword();
  const config = loadConfig({ ...env, VALKEY_PASSWORD: password });
  const valkey = createValkey(config);
  if (!(await waitReady(valkey, VALKEY_READY_TIMEOUT_MS))) {
    valkey.disconnect();
    throw new Error(`Valkey に ${VALKEY_READY_TIMEOUT_MS / 1000} 秒以内に接続できない`);
  }
  return { valkey, handle: createHandler({ config, store: new ConsentStore(valkey, config.VALKEY_KEY_PREFIX) }) };
}

/**
 * 初期化は最初の呼び出しで 1 回だけ（失敗したら次の呼び出しでやり直す。例外は Errors に数え、ALB は 502）。
 * 各呼び出しの前に、接続が ready でなければ最大 readyTimeoutMs 待つ。来なければそのまま処理する（handle が 503 を返す）
 */
export function createLambdaHandler(
  init: () => Promise<Runtime>,
  readyTimeoutMs: number = VALKEY_READY_TIMEOUT_MS,
): (event: AlbEvent) => Promise<AlbResult> {
  let ready: Promise<Runtime> | null = null;
  return async (event) => {
    ready ??= init().catch((error: unknown) => {
      ready = null;
      throw error;
    });
    const runtime = await ready;
    await waitReady(runtime.valkey, readyTimeoutMs);
    return toResult(await runtime.handle(toRequest(event)));
  };
}

export const handler = createLambdaHandler(() => initRuntime());
```

- [ ] **Step 5: 通ることを確かめる**

Run: `cd backend/consent-api && pnpm test && pnpm typecheck`
Expected: PASS（全ファイル）、型エラーなし

- [ ] **Step 6: 差分を確かめる（コミットはしない。bundle は実行しない）**

Run: `git status --short backend/consent-api && git diff --stat backend/consent-api`

---

### Task 5: 結合テスト（ALB の形のイベント × 開発の Valkey）

**Files:**
- Modify: `backend/consent-api/compose.yml`（`valkey` に `ports` を足す）
- Create: `backend/consent-api/vitest.integration.config.ts`
- Create: `backend/consent-api/integration/global-setup.ts`
- Create: `backend/consent-api/integration/helpers/valkey.ts`
- Create: `backend/consent-api/integration/lambda.test.ts`

**Interfaces:**
- Consumes: `createLambdaHandler`・`initRuntime`・`AlbEvent`・`AlbResult`・`Runtime`（Task 4）、`COOKIE_NAME`（`src/constants.ts`）

- [ ] **Step 1: 開発の Valkey を 127.0.0.1:6380 に開く**

`compose.yml` の `valkey:` の `image:` の行の下に足し、ファイル冒頭のコメント 1 行目を替える:

```yaml
# 開発用: consent-api と Valkey。Valkey は 127.0.0.1:6380 にだけ開く（結合テストが Lambda の入口から直接つなぐため。外部には出さない）。
```

```yaml
    # 結合テスト（pnpm test:integration）が Lambda の入口から直接つなぐ。127.0.0.1 だけ
    ports:
      - "127.0.0.1:6380:6379"
```

Run: `cd backend/consent-api && docker compose up -d valkey`
Expected: `consent-api-valkey-1` が作り直され（ボリュームは残る）、`ss -ltn | grep 6380` に `127.0.0.1:6380` が出る。consent-api のコンテナは作り直さない（イメージのビルドは Task 8 でユーザーに確かめてから）。

- [ ] **Step 2: 結合テストの設定と前提の確認を書く**

`vitest.integration.config.ts`:

```ts
import { defineConfig } from "vitest/config";

// 結合テストの設定（単体テストは vitest.config.ts）。ALB の形のイベントで lambda.ts の handler を呼び、
// 開発の Valkey（127.0.0.1:6380）を本物として使う。Secrets Manager だけ差し替える（initRuntime の loadPassword）。
// - Valkey を docker pause するテストがあるため、ファイルは 1 つずつ順に走らせる
export default defineConfig({
  test: {
    include: ["integration/**/*.test.ts"],
    environment: "node",
    globalSetup: ["integration/global-setup.ts"],
    fileParallelism: false,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
```

`integration/helpers/valkey.ts`:

```ts
import { execFileSync } from "node:child_process";

// 開発の Valkey（compose のサービス valkey）。127.0.0.1:6380 にだけ開いている（compose.yml）
export const VALKEY_CONTAINER = "consent-api-valkey-1";
export const VALKEY_URL = "redis://127.0.0.1:6380";

/** 開発の Valkey の AUTH（コンテナの環境変数。空なら認証なし）。値は画面に出さない */
export function devValkeyPassword(): string {
  try {
    return execFileSync("docker", ["exec", VALKEY_CONTAINER, "printenv", "VALKEY_PASSWORD"], { encoding: "utf8" }).trim();
  } catch {
    return ""; // printenv は未設定で終了コード 1
  }
}

export function pauseValkey(): void {
  execFileSync("docker", ["pause", VALKEY_CONTAINER]);
}

/** 止めていなければ何もしない（afterEach から必ず呼ぶ） */
export function unpauseValkey(): void {
  const state = execFileSync("docker", ["inspect", "-f", "{{.State.Paused}}", VALKEY_CONTAINER], { encoding: "utf8" }).trim();
  if (state === "true") execFileSync("docker", ["unpause", VALKEY_CONTAINER]);
}
```

`integration/global-setup.ts`:

```ts
import { createConnection } from "node:net";
import { unpauseValkey } from "./helpers/valkey.js";

const reachable = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });

/** 前提が欠けていれば、足りないものを示して止まる。前回のテストが pause したまま落ちていたら戻す */
export default async function setup(): Promise<void> {
  try {
    unpauseValkey();
  } catch {
    throw new Error("結合テストの前提が足りない: consent-api-valkey-1 が無い（cd backend/consent-api && docker compose up -d valkey）");
  }
  if (!(await reachable(6380))) {
    throw new Error("結合テストの前提が足りない: 127.0.0.1:6380 に届かない（compose.yml の ports を反映: docker compose up -d valkey）");
  }
}
```

- [ ] **Step 3: 結合テストを書く（`integration/lambda.test.ts`）**

```ts
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { COOKIE_NAME } from "../src/constants.js";
import { type AlbEvent, type AlbResult, createLambdaHandler, initRuntime, type Runtime } from "../src/lambda.js";
import { devValkeyPassword, pauseValkey, unpauseValkey, VALKEY_URL } from "./helpers/valkey.js";

// ALB の形のイベントで lambda.ts の handler を呼び、開発の Valkey を本物として使う（仕様 7 節）。
// Secrets Manager の代わりに、開発の Valkey のパスワードを loadPassword で渡す。
// キーの接頭辞を it-consent: にして、開発のデータ（consent:）と分け、afterAll で消す
const SITE = "http://localhost:4321";
const PREFIX = "it-consent:";
const ENV = { VALKEY_URL, VALKEY_KEY_PREFIX: PREFIX, SITE_URL: SITE, COOKIE_DOMAIN: "", CONSENT_POLICY_VERSION: "2026-10-01" };

const password = devValkeyPassword();
const runtimes: Runtime[] = [];
let direct: Redis;

/** コールドスタートから始まる handler（呼ぶたびに新しい実行環境とみなす） */
function coldHandler(): (event: AlbEvent) => Promise<AlbResult> {
  return createLambdaHandler(async () => {
    const runtime = await initRuntime({ env: ENV, loadPassword: async () => password });
    runtimes.push(runtime);
    return runtime;
  });
}

const post = (state: string, extra: Record<string, string> = {}): AlbEvent => ({
  httpMethod: "POST",
  path: "/v1/consent",
  headers: { origin: SITE, "content-type": "application/json", ...extra },
  body: JSON.stringify({ state }),
  isBase64Encoded: false,
});

const get = (extra: Record<string, string> = {}): AlbEvent => ({
  httpMethod: "GET",
  path: "/v1/consent",
  headers: { origin: SITE, ...extra },
  body: "",
  isBase64Encoded: false,
});

/** Set-Cookie から、次の要求の Cookie ヘッダーの値（名前=値）を取り出す */
const cookieFrom = (res: AlbResult) => res.headers["Set-Cookie"]!.split("; ")[0]!;
const idFrom = (res: AlbResult) => new URLSearchParams(cookieFrom(res).slice(COOKIE_NAME.length + 1)).get("id")!;

async function testKeys(): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await direct.scan(cursor, "MATCH", `${PREFIX}*`, "COUNT", 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

beforeAll(() => {
  direct = new Redis(VALKEY_URL, { password: password || undefined });
});

afterEach(() => {
  unpauseValkey();
});

afterAll(async () => {
  const keys = await testKeys();
  if (keys.length > 0) await direct.del(...keys);
  await Promise.all(runtimes.map((runtime) => runtime.valkey.quit().catch(() => runtime.valkey.disconnect())));
  await direct.quit();
});

describe("ALB → Lambda → Valkey", () => {
  describe("正常系", () => {
    it("同意を記録して Cookie を返し、その Cookie で状態を取り出せる", async () => {
      const handler = coldHandler();
      const created = await handler(post("granted"));
      expect(created.statusCode).toBe(201);
      expect(created.headers["Set-Cookie"]).toMatch(new RegExp(`^${COOKIE_NAME}=s=granted&v=2026-10-01&id=`));
      expect(await direct.xlen(`${PREFIX}c:${idFrom(created)}`)).toBe(1);

      const read = await handler(get({ cookie: cookieFrom(created) }));
      expect(read.statusCode).toBe(200);
      expect(JSON.parse(read.body)).toMatchObject({ state: "granted", policy_version: "2026-10-01" });
    });

    it("撤回は同じ識別子の Stream に積まれ、最新の状態が denied になる", async () => {
      const handler = coldHandler();
      const first = await handler(post("granted"));
      const second = await handler(post("denied", { cookie: cookieFrom(first) }));
      expect(second.statusCode).toBe(201);
      expect(idFrom(second)).toBe(idFrom(first));
      expect(await direct.xlen(`${PREFIX}c:${idFrom(first)}`)).toBe(2);
      const read = await handler(get({ cookie: cookieFrom(second) }));
      expect(JSON.parse(read.body)).toMatchObject({ state: "denied" });
    });

    it("空入力: Cookie の無い GET は unset で、Valkey に何も作らない", async () => {
      const before = (await testKeys()).length;
      const res = await coldHandler()(get());
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ state: "unset" });
      expect((await testKeys()).length).toBe(before);
    });
  });

  describe("異常系", () => {
    it("入力: 別のオリジンからの POST は 403 で、Valkey に書かない", async () => {
      const before = (await testKeys()).length;
      const res = await coldHandler()(post("granted", { origin: "https://evil.example" }));
      expect(res.statusCode).toBe(403);
      expect(res.headers["Set-Cookie"]).toBeUndefined();
      expect((await testKeys()).length).toBe(before);
    });

    it("サーバ: ウォームの状態で Valkey が止まると 503 で Cookie を書かず、再開すると記録できる", async () => {
      const handler = coldHandler();
      expect((await handler(get())).statusCode).toBe(200); // 初期化を済ませる
      pauseValkey();
      const failed = await handler(post("granted"));
      expect(failed.statusCode).toBe(503);
      expect(JSON.parse(failed.body)).toEqual({ error: "unavailable" });
      expect(failed.headers["Set-Cookie"]).toBeUndefined();
      unpauseValkey();
      await vi.waitFor(async () => expect((await handler(post("granted"))).statusCode).toBe(201), { timeout: 20_000, interval: 500 });
    });

    it("サーバ: Valkey が止まった状態のコールドスタートは初期化の失敗になり、再開後の呼び出しで回復する", async () => {
      const handler = coldHandler();
      pauseValkey();
      await expect(handler(get())).rejects.toThrow("Valkey");
      unpauseValkey();
      await vi.waitFor(async () => expect((await handler(get())).statusCode).toBe(200), { timeout: 20_000, interval: 500 });
    });
  });
});
```

- [ ] **Step 4: 結合テストを実行する**

Run: `cd backend/consent-api && pnpm test:integration`
Expected: PASS（6 件）。失敗したら、テストの前提（Valkey が 6380 で動いているか）を先に疑う。src のバグなら src を直さず `it.todo` と直上のコメントで残し、報告する。

- [ ] **Step 5: 単体テストに結合テストが混ざっていないことを確かめる**

Run: `cd backend/consent-api && pnpm test`
Expected: PASS（`integration/` は `vitest.config.ts` の `include` 外）

- [ ] **Step 6: 差分を確かめる（コミットはしない）**

Run: `git status --short backend/consent-api`

---

### Task 6: IaC（SAM）を Lambda に書き換える

**Files:**
- Modify: `cloud/stacks/services/consent-api.yaml`（全体を置き換える）
- Modify: `cloud/stacks/edge.yaml`（パラメータ・ターゲットグループ・ルール 106・出力）
- Modify: `cloud/stacks/network.yaml`（`ConsentApiPort`・ALB の egress・`ConsentApiFromAlb`）
- Modify: `cloud/stacks/alarms.yaml`（パラメータ・アラームの差し替え）
- Modify: `cloud/stacks/cluster.yaml`（ロググループと出力）
- Modify: `cloud/stacks/ecr.yaml`（リポジトリ・出力・説明）
- Modify: `cloud/template.yaml`（パラメータ・`ConsentApiService`・`NetworkStack`・`EdgeStack`・`AlarmsStack`）

**Interfaces:**
- Produces（`consent-api.yaml` の出力）: `FunctionName`・`AliasArn`・`TargetGroupArn`・`TargetGroupFullName`
- 依存の向き: `ConsentApiService` → `EdgeStack`（edge が `ConsentApiTargetGroupArn` を受け取る）。`ConsentApiService` は edge を参照しない。

- [ ] **Step 1: `cloud/stacks/services/consent-api.yaml` を丸ごと置き換える**

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Description: >-
  consent-api: Cookie 同意の状態を受け取り、ElastiCache（Valkey）に記録する。ADR-26 により VPC の中の Lambda（ALB のターゲット）。
  仕様は docs/superpowers/specs/2026-10-12-consent-api-lambda-design.md。環境変数名は backend/consent-api/.env.example が正本。
  訪問者のリクエストを直接受ける唯一の自作のコード。DB を持たず、RDS の資格情報を一切渡さない（実行ロールは Valkey の AUTH トークンだけを読める。
  セキュリティグループも Valkey と、NAT 経由の Secrets Manager にしか使わない）。
  ALB の許可パスは /v1/consent の 1 本だけ（edge.yaml のルール 106）。ターゲットグループはこのスタックが持つ
  （CloudFormation で関数を登録する手段が TargetGroup の Targets だけのため。edge に置くと循環する。仕様 2.1）。
  Valkey の証明書は Amazon の CA が署名しており、Node の標準の信頼ストアで検証できる（RDS の CA とは違う）。

Parameters:
  EnvName:
    Type: String
    Default: prod
  PrivateSubnetIds:
    Type: CommaDelimitedList
    Description: private サブネットの ID（network.yaml の PrivateSubnetIds）
  SecurityGroupId:
    Type: AWS::EC2::SecurityGroup::Id
    Description: network.yaml の ConsentApiSecurityGroupId
  SecretNamePrefix:
    Type: String
    Description: secrets.yaml の SecretNamePrefix（comegin/<EnvName>）
  ValkeyEndpoint:
    Type: String
    Description: data.yaml の ValkeyEndpoint
  SiteUrl:
    Type: String
    Description: CORS で許す公開サイトのオリジン（1 つだけ。パスは付けない。例 https://comegin.com）
  CookieDomain:
    Type: String
    Default: .comegin.com
    Description: Cookie の Domain 属性。同意の Cookie を公開サイトの JavaScript が読めるよう、同一サイトのドメインにする。
  ConsentPolicyVersion:
    Type: String
    Default: '2026-10-01'
    Description: 現行のプライバシーポリシー・Cookie 文面の版。記録と Cookie に入る。
  ReservedConcurrency:
    Type: Number
    Default: 10
    MinValue: 1
    Description: 予約同時実行数（費用と乱用の上限。WAF のレート制限とは別の保険。Valkey の接続数の上限にもなる。暫定値。仕様 12 節）
  LogRetentionDays:
    Type: Number
    Default: 30
    Description: ロググループの保持日数（cluster.yaml と同じ暫定値）

Resources:
  LogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: !Sub '/aws/lambda/comegin-${EnvName}-consent-api'
      RetentionInDays: !Ref LogRetentionDays

  ConsentApiFunction:
    Type: AWS::Serverless::Function
    Metadata:
      # backend/consent-api/Makefile の build-ConsentApiFunction（pnpm と esbuild。npm を使わない）
      BuildMethod: makefile
    Properties:
      FunctionName: !Sub 'comegin-${EnvName}-consent-api'
      Description: Cookie consent recorder behind the ALB (ADR-26)
      CodeUri: ../../../backend/consent-api
      Handler: index.handler
      Runtime: nodejs22.x
      Architectures: [arm64]
      MemorySize: 256
      # Valkey の接続（3 秒）とコマンド（2 秒）に余裕を足す（仕様 2.2）
      Timeout: 6
      ReservedConcurrentExecutions: !Ref ReservedConcurrency
      # ALB にはエイリアスを登録する（デプロイのたびに ALB が現行の版を呼ぶ。AWS の推奨）
      AutoPublishAlias: live
      LoggingConfig:
        LogGroup: !Ref LogGroup
      VpcConfig:
        SecurityGroupIds:
          - !Ref SecurityGroupId
        SubnetIds: !Ref PrivateSubnetIds
      Environment:
        Variables:
          NODE_ENV: production
          VALKEY_URL: !Sub 'rediss://${ValkeyEndpoint}:6379'
          VALKEY_KEY_PREFIX: 'consent:'
          SITE_URL: !Ref SiteUrl
          COOKIE_DOMAIN: !Ref CookieDomain
          CONSENT_POLICY_VERSION: !Ref ConsentPolicyVersion
          # AUTH トークンは環境変数に置かず、コールドスタートで Secrets Manager から読む（src/lambda.ts）
          VALKEY_PASSWORD_SECRET_ID: !Sub '${SecretNamePrefix}/shared/VALKEY_AUTH_TOKEN'
      Policies:
        - Version: '2012-10-17'
          Statement:
            - Sid: ReadValkeyAuthToken
              Effect: Allow
              Action: secretsmanager:GetSecretValue
              Resource: !Sub 'arn:${AWS::Partition}:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:${SecretNamePrefix}/shared/VALKEY_AUTH_TOKEN-*'

  # ALB からの呼び出しの許可。SourceArn にターゲットグループの !Ref を使うと、許可とターゲットグループが
  # 互いを待つ循環になる（登録は許可が先に要る）ため、固定の名前とワイルドカードで絞る（仕様 2.1）
  AlbInvokePermission:
    Type: AWS::Lambda::Permission
    Properties:
      FunctionName: !Ref ConsentApiFunction.Alias
      Action: lambda:InvokeFunction
      Principal: elasticloadbalancing.amazonaws.com
      SourceAccount: !Ref AWS::AccountId
      SourceArn: !Sub 'arn:${AWS::Partition}:elasticloadbalancing:${AWS::Region}:${AWS::AccountId}:targetgroup/comegin-${EnvName}-consent-api/*'

  TargetGroup:
    Type: AWS::ElasticLoadBalancingV2::TargetGroup
    DependsOn: AlbInvokePermission
    Properties:
      Name: !Sub 'comegin-${EnvName}-consent-api'
      TargetType: lambda
      # ヘルスチェックは無効（lambda の既定。有効にすると呼び出しの料金がかかる。/healthz は開発用）
      HealthCheckEnabled: false
      Targets:
        - Id: !Ref ConsentApiFunction.Alias
      TargetGroupAttributes:
        # Set-Cookie は 1 つだけで、ブラウザが送る Cookie ヘッダーも 1 つのため無効のまま（仕様 2.1）
        - { Key: lambda.multi_value_headers.enabled, Value: 'false' }
      Tags:
        - { Key: Name, Value: !Sub 'comegin-${EnvName}-consent-api' }

Outputs:
  FunctionName:
    Value: !Ref ConsentApiFunction
  AliasArn:
    Value: !Ref ConsentApiFunction.Alias
  TargetGroupArn:
    Description: edge.yaml のルール 106 の転送先
    Value: !Ref TargetGroup
  TargetGroupFullName:
    Description: alarms.yaml の consent-api-target-5xx の次元（targetgroup/<名前>/<ID>）
    Value: !GetAtt TargetGroup.TargetGroupFullName
```

- [ ] **Step 2: `cloud/stacks/edge.yaml` を直す**

1. パラメータの `ConsentApiPort`（3 行）と `ConsentApiHealthCheckPath`（3 行）を消す。
2. ポートのパラメータ群の下（`AdminAuthPort` の後）に足す:

```yaml
  # ---- consent-api（ADR-26。Lambda。ターゲットグループは services/consent-api.yaml が持つ。仕様 2.1）
  ConsentApiTargetGroupArn:
    Type: String
    Description: services/consent-api.yaml の TargetGroupArn（ルール 106 の転送先）
```

3. リソース `ConsentApiTargetGroup`（`Type: AWS::ElasticLoadBalancingV2::TargetGroup` から `Tags` の 2 行まで）を丸ごと消す。
4. ルール 106（`VisitorConsentRule`）の `Actions` を `- { Type: forward, TargetGroupArn: !Ref ConsentApiTargetGroupArn }` にする。直上のコメントの 2 行目を `# /healthz は外部に出さない（ターゲットは Lambda で、ヘルスチェックも無効。ADR-26）。` にする。
5. 出力の `ConsentApiTargetGroupArn` と `ConsentApiTargetGroupFullName`（4 行）を消す。

- [ ] **Step 3: `cloud/stacks/network.yaml` を直す**

1. パラメータの `ConsentApiPort`（3 行）を消す。
2. `AlbSecurityGroup` の `SecurityGroupEgress` から `To consent-api` の行を消す。
3. リソース `ConsentApiFromAlb`（2 行）を消し、そこに次のコメントを置く:

```yaml
  # consent-api は Lambda（ADR-26）。ALB は Lambda をネットワークを通さずに呼ぶため、ALB からの許可は要らない
```

`ConsentApiSecurityGroup` と `ValkeyFromConsentApi` は変えない（`GroupDescription` を変えると SG が置き換わる）。

- [ ] **Step 4: `cloud/stacks/alarms.yaml` を直す**

1. パラメータ `ConsentApiTargetGroupFullName` の `Description` を `services/consent-api.yaml の TargetGroupFullName（targetgroup/<名前>/<ID>。ADR-26 で Lambda のターゲット）` にする。`FaqBotFunctionName` の下に足す:

```yaml
  ConsentApiFunctionName:
    Type: String
    Description: services/consent-api.yaml の FunctionName（ADR-26 の Lambda）
```

2. `ConsentApiRunningTaskAlarm`（`Type` から `ReturnData: true` まで）と `ConsentApiUnhealthyHostAlarm`（`Type` から `OKActions` まで）を消す。
3. `FaqBotErrorsAlarm` の後に足す:

```yaml
  # ---------------------------------------------------------------- Lambda: consent-api（ADR-26。仕様 2.4）
  # Valkey の障害の 503 と想定外の 500 は「応答として返す」ため Errors に数えられない。ターゲットの 5xx で拾う。
  # 同意が成立しないと、新しい訪問者の PostHog・Chatwoot・GA4 が止まる（DD-02 の 8.4）ため、1 件で鳴らす
  ConsentApiErrorsAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmName: !Sub 'comegin-${EnvName}-consent-api-errors'
      AlarmDescription: consent-api（Lambda）が例外・タイムアウト・初期化の失敗で止まった。ALB は 502 を返している。
      Namespace: AWS/Lambda
      MetricName: Errors
      Dimensions:
        - { Name: FunctionName, Value: !Ref ConsentApiFunctionName }
      Statistic: Sum
      Period: 60
      EvaluationPeriods: 1
      Threshold: 0
      ComparisonOperator: GreaterThanThreshold
      TreatMissingData: notBreaching
      ActionsEnabled: true
      AlarmActions: [!Ref OpsAlertTopicArn]
      OKActions: [!Ref OpsAlertTopicArn]

  ConsentApiThrottlesAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmName: !Sub 'comegin-${EnvName}-consent-api-throttles'
      AlarmDescription: consent-api（Lambda）が予約同時実行数の上限に達し、呼び出しを拒否した。
      Namespace: AWS/Lambda
      MetricName: Throttles
      Dimensions:
        - { Name: FunctionName, Value: !Ref ConsentApiFunctionName }
      Statistic: Sum
      Period: 60
      EvaluationPeriods: 1
      Threshold: 0
      ComparisonOperator: GreaterThanThreshold
      TreatMissingData: notBreaching
      ActionsEnabled: true
      AlarmActions: [!Ref OpsAlertTopicArn]
      OKActions: [!Ref OpsAlertTopicArn]

  ConsentApiTarget5xxAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmName: !Sub 'comegin-${EnvName}-consent-api-target-5xx'
      AlarmDescription: consent-api が 5xx を返した（Valkey の障害の 503 か、想定外の 500）。同意が記録されず、Cookie も書かれていない。
      Namespace: AWS/ApplicationELB
      MetricName: HTTPCode_Target_5XX_Count
      Dimensions:
        - { Name: TargetGroup, Value: !Ref ConsentApiTargetGroupFullName }
        - { Name: LoadBalancer, Value: !Ref AlbFullName }
      Statistic: Sum
      Period: 300
      EvaluationPeriods: 1
      Threshold: 1
      ComparisonOperator: GreaterThanOrEqualToThreshold
      TreatMissingData: notBreaching
      ActionsEnabled: true
      AlarmActions: [!Ref OpsAlertTopicArn]
      OKActions: [!Ref OpsAlertTopicArn]
```

- [ ] **Step 5: `cluster.yaml` と `ecr.yaml` を直す**

`cluster.yaml`: リソース `ConsentApiLogGroup`（5 行）と出力 `ConsentApiLogGroupName`（2 行）を消す。

`ecr.yaml`: リソース `ConsentApiRepository`（`ConsentApiRepository:` から `LifecyclePolicyText` の 2 行まで）と出力 `ConsentApiRepositoryUri`（2 行）を消す。`Description` の 1 行目を `ECR リポジトリ。自作（admin-auth）、Mautic・Chatwoot の派生イメージ用。consent-api・faq-bot は Lambda（ADR-26）で、sam build が zip にするためリポジトリを持たない。Strapi と n8n はオンプレで動かす（ADR-21）、Cal.com は SaaS（ADR-24）、アクセス解析は GA4（SaaS。ADR-25 で Umami を廃止）なので、リポジトリを持たない。` にする。`# ライフサイクルポリシーは 6 本とも同じ内容` を `# ライフサイクルポリシーはすべて同じ内容` にする。

- [ ] **Step 6: `cloud/template.yaml` を直す**

1. `Metadata` のパラメータのグループから `ConsentApiPort`・`ConsentApiImageTag`・`ConsentApiDesiredCount`・`ConsentApiCpu`・`ConsentApiMemory` を外す。`FAQ ボット` のグループの前に足す:

```yaml
      - Label: { default: consent-api（ADR-26。services/consent-api.yaml） }
        Parameters: [ConsentApiReservedConcurrency]
```

2. パラメータの `ConsentApiPort`・`ConsentApiImageTag`・`ConsentApiDesiredCount`・`ConsentApiCpu`・`ConsentApiMemory` を消す。`ConsentPolicyVersion` の下に足す:

```yaml
  ConsentApiReservedConcurrency:
    Type: Number
    Default: 10
    MinValue: 1
    Description: consent-api（Lambda）の予約同時実行数（暫定値。docs/superpowers/specs/2026-10-12-consent-api-lambda-design.md の 12 節）
```

3. `NetworkStack` と `EdgeStack` の `Parameters` から `ConsentApiPort: !Ref ConsentApiPort` を消す。`EdgeStack` に `ConsentApiTargetGroupArn: !GetAtt ConsentApiService.Outputs.TargetGroupArn` を足す。
4. `ConsentApiService` を次に置き換える:

```yaml
  # ---- consent-api（ADR-26。VPC の中の Lambda。ALB のターゲットグループもこのスタックが持ち、EdgeStack に渡す）
  ConsentApiService:
    Type: AWS::Serverless::Application
    Properties:
      Location: stacks/services/consent-api.yaml
      Parameters:
        EnvName: !Ref EnvName
        PrivateSubnetIds: !GetAtt NetworkStack.Outputs.PrivateSubnetIds
        SecurityGroupId: !GetAtt NetworkStack.Outputs.ConsentApiSecurityGroupId
        SecretNamePrefix: !GetAtt SecretsStack.Outputs.SecretNamePrefix
        ValkeyEndpoint: !GetAtt DataStack.Outputs.ValkeyEndpoint
        SiteUrl: !Sub 'https://${SiteHost}'
        CookieDomain: !Sub '.${DomainName}'
        ConsentPolicyVersion: !Ref ConsentPolicyVersion
        ReservedConcurrency: !Ref ConsentApiReservedConcurrency
```

5. `AlarmsStack` の `ConsentApiTargetGroupFullName` を `!GetAtt ConsentApiService.Outputs.TargetGroupFullName` にし、`ConsentApiFunctionName: !GetAtt ConsentApiService.Outputs.FunctionName` を足す。

- [ ] **Step 7: 参照の取りこぼしを探す**

Run: `rg -n "ConsentApi(Port|ImageTag|DesiredCount|Cpu|Memory|HealthCheckPath|LogGroup|Repository)|ConsentApiTargetGroup\b|EdgeStack.Outputs.ConsentApi" cloud/`
Expected: 何も出ない

- [ ] **Step 8: テンプレートを検証する（ビルド・デプロイはしない）**

Run: `cd cloud && sam validate --lint --template stacks/services/consent-api.yaml && sam validate --lint --template stacks/edge.yaml && sam validate --lint --template stacks/network.yaml && sam validate --lint --template stacks/alarms.yaml && sam validate --lint --template stacks/cluster.yaml && sam validate --lint --template stacks/ecr.yaml && sam validate --lint --template template.yaml`
Expected: すべて valid。`sam` が無い環境では、MCP の `validate_cloudformation_template`（deploy-on-aws:awsiac）で同じファイルを検証する。既存の警告（変更前からあるもの）は `git stash` を使わずに、変更前の内容と比べて区別する（`git show HEAD:cloud/<file> > <scratchpad>/<file>` で取り出して検証する）。

- [ ] **Step 9: 差分を確かめる（コミットはしない）**

Run: `git status --short cloud && git diff --stat cloud`

---

### Task 7: 文書を更新する

**Files:**
- Modify: `backend/consent-api/README.md`、`backend/consent-api/.env.example`
- Modify: `cloud/README.md`
- Modify: `.claude/CLAUDE.md`
- Modify: `docs/RequirementDefinition/AA/05-application-decisions.md`、`docs/RequirementDefinition/AA/01-application-landscape.md`
- Modify: `docs/RequirementDefinition/TA/06-aws-runtime.md`、`docs/RequirementDefinition/TA/05-observability-and-ops.md`
- Modify: `docs/DetailedDesign/02-public-path-flows.md`、`docs/DetailedDesign/07-failure-and-degradation.md`

- [ ] **Step 1: `backend/consent-api/README.md`**

1. 1 段落目の `本番は ALB 配下の ECS on Fargate` を `本番は ALB 配下の Lambda（VPC の中。ADR-26。2026-10-12 に ECS on Fargate から移した）` にする。設計の出典に `docs/superpowers/specs/2026-10-12-consent-api-lambda-design.md` を足す。
2. 「API」の表の `GET /healthz` の行の用途を `開発のヘルスチェック用（本番の ALB には出さず、ターゲットのヘルスチェックも無効）` にする。
3. 「Valkey のキー設計」の後に節を足す:

```markdown
## 構成（本体と 2 つの入口）

```
src/handler.ts   入口に依存しない本体（ルーティング・CORS・検証・Cookie・エラー・ログ）。例外を投げない
src/server.ts    開発の入口（Node の http。3104）。本文を上限つきで読み、handler を呼ぶだけ
src/lambda.ts    本番の入口（ALB のイベント ↔ handler）。Valkey の接続を使い回し、AUTH トークンを Secrets Manager から読む
src/index.ts     開発の起動と停止（SIGTERM）
```

- **Lambda では Valkey の接続を 1 本持ち、呼び出しをまたいで使い回す。** 初期化（コールドスタート）で `ready` を最大 3 秒待ち、来なければ初期化の失敗（ALB は 502。次の呼び出しでやり直す）。各呼び出しの前にも、`ready` でなければ最大 3 秒待つ（凍結から戻ったときの再接続）。`enableOfflineQueue: false` のため、待たないと最初の要求が 503 になる。
- ビルドは `sam build` が `Makefile` の `build-ConsentApiFunction` を呼ぶ（pnpm と esbuild。`@aws-sdk/*` は実行環境にあるので含めない）。`Dockerfile` は開発の compose だけが使う。
```

4. 「起動（ローカル）」の `Valkey はホストに公開していないため、...` の箇条を `Valkey は 127.0.0.1:6380 にだけ開いている（結合テストが Lambda の入口から直接つなぐため）。pnpm dev で直接動かすときは VALKEY_URL=redis://127.0.0.1:6380 にする。` にする。起動の手順の後に足す:

```markdown
### テスト

```bash
pnpm test               # 単体（外部はモック）
pnpm test:integration   # 結合: ALB の形のイベントで lambda.ts を呼び、開発の Valkey（127.0.0.1:6380）を本物として使う。Valkey を数秒 docker pause する
```
```

5. 「環境変数」の表に行を足す: `| VALKEY_PASSWORD_SECRET_ID | 本番の入口（lambda.ts）だけが使う。AUTH トークンを入れた Secrets Manager の Secret の ID（comegin/<env>/shared/VALKEY_AUTH_TOKEN）。開発は使わない | |`。`HOST` / `PORT` の行の内容に `（開発の入口だけ）` を足す。
6. 「運用上の注意」を直す: `GET /healthz` の箇条を `GET /healthz は開発だけ。本番は ALB のターゲットのヘルスチェックを使わない（Lambda。ADR-26）。監視は Lambda の Errors・Throttles とターゲットの 5xx のアラーム（cloud/stacks/alarms.yaml）。` に、keep-alive の箇条を `Node の keep-alive（65 秒）・SIGTERM での停止は開発の入口だけの設定（本番の Lambda では使わない）。` に替え、SIGTERM の箇条を消す。

`.env.example` の末尾に足す:

```bash

# --- 本番の入口（lambda.ts）だけ ---
# AUTH トークンを入れた Secrets Manager の Secret の ID。開発（compose・pnpm dev）は使わない（VALKEY_PASSWORD を直接使う）
VALKEY_PASSWORD_SECRET_ID=
```

`.env.example` の `VALKEY_URL` のコメントに `pnpm dev で直接動かすときは redis://127.0.0.1:6380` を足す。

- [ ] **Step 2: `cloud/README.md`**

1. 25 行目: `ecr.yaml                 ECR（自作 1 本〈admin-auth〉と、Mautic・Chatwoot の 3 本。consent-api・faq-bot は Lambda で ECR を使わない）`
2. 37 行目: `services/<svc>.yaml      ECS のサービス 5 本（mautic-web・mautic-cron・chatwoot-web・chatwoot-worker・admin-auth）` とし、38 行目の後に `    services/consent-api.yaml consent-api（Lambda。VPC の中。ALB のターゲットとターゲットグループを持つ。ADR-26。4.15）` を足す。
3. 127 行目の `sam build` のコメントを `# 必須（2026-10-11 から）。faq-bot と consent-api の Lambda を各 Makefile（pnpm と esbuild）でまとめる。開発機に pnpm 11 が要る` にし、131 行目の段落の `faq-bot（4.14）の` を `faq-bot（4.14）・consent-api（4.15）の` に、`faq-bot のスタックを無条件で作るため、faq-bot をまだ使わない場合でも` を `両方のスタックを無条件で作るため、使わない場合でも` にする。
4. 4.7 の「自作のイメージ」の表から `consent-api` の行を消し、`docker build ... consent-api` と `docker push ... consent-api` の 2 行を `admin-auth` のものに替える（`$ECR/comegin/prod/admin-auth:$TAG backend/admin-auth`）。
5. 4.11 の表の 4 行目（`ConsentApiDesiredCount=1`）を消す。表の後に `consent-api は Lambda（ADR-26）で DesiredCount を持たない。sam deploy の時点で ALB から呼ばれる（4.15）。` を足す。
6. 619 行目の `**ECR は 4 本**: 自作 2 本（admin-auth・consent-api）と、` を `**ECR は 3 本**: 自作 1 本（admin-auth）と、` にし、文末に `consent-api は ADR-26 で Lambda になり、ECR を外した（2026-10-12）。` を足す。621 行目の `イメージのタグは製品ごと（4 個）` を `（3 個）` にする。
7. 4.14 の節の後（`## 5. TODO 一覧` の前）に節を足す:

```markdown
### 4.15 consent-api（Cookie 同意の受け口。ADR-26）

VPC の中の Lambda（ALB のターゲット）。仕様は `docs/superpowers/specs/2026-10-12-consent-api-lambda-design.md`。**`sam build` は `backend/consent-api/Makefile` を使い、pnpm と esbuild でまとめる。** ターゲットグループ（`comegin-<env>-consent-api`）は `services/consent-api.yaml` が持ち、edge のルール 106 に渡す。

1. `sam build` → `sam deploy`（Secrets の `shared/VALKEY_AUTH_TOKEN` は secrets.yaml が作る。人が入れる値は無い）。
2. 確かめる: 公開サイトのバナーで同意し、`comegin_consent` の Cookie が書かれること。`curl -s https://<ConsentHost>/v1/consent` が `{"state":"unset"}` を返すこと（4.13）。
3. CloudWatch のアラーム `consent-api-errors`・`consent-api-throttles`・`consent-api-target-5xx` が鳴っていないこと。ロググループ `/aws/lambda/comegin-<env>-consent-api` に 1 件 1 行のログが出て、識別子と IP が無いこと。

- **初回の呼び出し（コールドスタート）は、Secrets Manager と Valkey への接続のぶん遅い。** 訪問者はバナーの応答を待たない（DD-02 の 8.3）。
- 予約同時実行数（`ConsentApiReservedConcurrency`。既定 10）とタイムアウト（6 秒）は暫定値。`Throttles` のアラームが鳴ったら上げる。
```

- [ ] **Step 3: `.claude/CLAUDE.md`**

1. 自作コードの表の `backend/consent-api`、`backend/admin-auth` の行の説明を `consent-api は本番は ALB 配下の Lambda（VPC の中。ADR-26。2026-10-12）で、DB を持たず Valkey だけ。admin-auth は本番は ALB 配下の ECS on Fargate で、Better Auth を OIDC Provider にして ALB の authenticate-oidc の IdP にする` にする。
2. ポートの表の 3104 の行の `ALB 配下の ECS on Fargate。` を `本番は ALB 配下の Lambda〈ADR-26〉で、ポートを持たない。` にする。5433 の行の後に行を足す: `| 6380 | consent-api の開発の Valkey（`127.0.0.1` だけ。consent-api の結合テストが Lambda の入口から直接つなぐ） |`

- [ ] **Step 4: 要件定義・詳細設計**

1. `AA/05-application-decisions.md` の ADR-26 の帰結の最後の箇条（「consent-api・admin-auth の移行は...」）の末尾に足す: `**（2026-10-12）② consent-api は `docs/superpowers/specs/2026-10-12-consent-api-lambda-design.md` で実施した（ターゲットグループは関数のスタックに移した）。③ admin-auth は実測を待たずに進めることにした（ユーザーの 2026-10-12 の決定。ALB の IdP の呼び出しの直前にブラウザが同じ関数を呼ぶため、起動済みである見込み。プロビジョニングされた同時実行数を備えにする。別の仕様）。**`
2. `AA/01-application-landscape.md` 229 行目の `**AWS**（ECS on Fargate ＋ ElastiCache。` を `**AWS**（VPC の中の Lambda〈ALB のターゲット。ADR-26。2026-10-12〉＋ ElastiCache。` にする。
3. `TA/06-aws-runtime.md`:
   - 14 行目の末尾に足す: `（**2026-10-12 ADR-26: `consent-api` も ECS から外れ、VPC の中の Lambda〈ALB のターゲット〉になった。`docs/superpowers/specs/2026-10-12-consent-api-lambda-design.md`**）`
   - 86 行目の先頭に足す: `**（2026-10-12）ADR-26 で置き換え: `consent-api` は VPC の中の Lambda〈ALB のターゲット〉にした（デプロイは同じ SAM、監視は Lambda のアラームを足すだけ）。以下は 2026-10-01 の記録。** `
   - 103 行目の `consent-api` の行の 2・3 列目を `**ECR に置かない**（Lambda。`sam build` が esbuild で zip にする。ADR-26） | 依存を最小にする（公開経路に出る自作のコードのため。3.1）` にする。
   - 221 行目の `ECS on Fargate。3.1。` を `VPC の中の Lambda〈ALB のターゲット〉。ADR-26〈2026-10-12〉。3.1。` にする。
   - 602 行目の `（ECS on Fargate）。**` の後に `**（2026-10-12 ADR-26: VPC の中の Lambda に移した。ALB の後ろに置くことは変えない）**` を足す。
   - 「### 5.3」の節の表の後に箇条を足す: `- **（2026-10-12）consent-api のターゲットは lambda 型**（ADR-26）。許可パス（ルール 106）は変えない。ターゲットグループは `services/consent-api.yaml` が持つ。`
4. `TA/05-observability-and-ops.md`:
   - 122 行目（項目 12）の最後の列の `この項目の対象は Mautic・Chatwoot・Umami・`admin-auth`・`consent-api`・Cal.com` の後に `（**2026-10-12: `consent-api` は ADR-26 で Lambda になり、項目 23 に移した**）` を足す。
   - 132 行目（項目 22）の後に行を足す:

```markdown
| **23** | **consent-api（Lambda）の失敗**（2026-10-12 に追加。ADR-26） | CloudWatch の `Errors > 0`・`Throttles > 0`（1 分）と、ターゲットグループの `HTTPCode_Target_5XX_Count ≥ 1`（5 分。Valkey の障害の 503 は応答として返るため `Errors` に数えられない）。`cloud/stacks/alarms.yaml` の `ConsentApi*Alarm` | SNS の `ops` に直接通知（n8n を経由しない）。新しい訪問者の同意が成立せず、PostHog・Chatwoot・GA4 が止まる（DD-02 の 8.4）。原因（Valkey・Secrets Manager・同時実行数）を CloudWatch Logs とメトリクスで確かめる | `未着手`（本番は未デプロイ） |
```

5. `DetailedDesign/02-public-path-flows.md` の「### 8.1 なぜ ECS on Fargate なのか」の見出しの直後に足す:

```markdown
> **（2026-10-12）ADR-26 で、実行基盤を ECS on Fargate から VPC の中の Lambda（ALB のターゲット）に替えた。** 下の表の採用の理由「実行基盤が増えない」は ADR-26 で置き換えた（デプロイは同じ SAM、監視は Lambda のアラームを足すだけ）。**ALB の後ろに置くこと**（Lambda 関数 URL・API Gateway を使わないこと）は変えない（WAF のレート制限とホストの振り分けを共有するため）。仕様は `docs/superpowers/specs/2026-10-12-consent-api-lambda-design.md`。
```

6. `DetailedDesign/07-failure-and-degradation.md` の 6 節の表の faq-bot の行の後に足す:

```markdown
| **consent-api**（VPC の中の Lambda。ADR-26。2026-10-12 に ECS から移した） | 同意の記録と、同意の Cookie の発行（**新しい訪問者の PostHog・Chatwoot・GA4 の読み込みが止まる**。DD-02 の 8.4） | **公開サイトの表示と、同意済みの訪問者。** バナーは応答を待たずに閉じる（DD-02 の 8.3）。コールドスタートで Valkey・Secrets Manager に届かなければ初期化の失敗（ALB は 502）で、次の呼び出しでやり直す。ウォームの状態で Valkey が落ちていれば最大 3 秒待って 503 | `docs/superpowers/specs/2026-10-12-consent-api-lambda-design.md` の 5 節 |
```

- [ ] **Step 5: 書き換えの取りこぼしを探す**

Run: `rg -n "consent-api" .claude/CLAUDE.md cloud/README.md backend/consent-api/README.md docs/RequirementDefinition/TA/06-aws-runtime.md | rg -n "ECS|ECR|DesiredCount|イメージ"`
Expected: 残るのは「以前は ECS だった」旨の注記と、2026-10-01 の記録だけ。

- [ ] **Step 6: 差分を確かめる（コミットはしない）**

Run: `git status --short && git diff --stat`

---

### Task 8: 通しの確認

**Files:** なし（確認だけ）

- [ ] **Step 1: 単体テスト・型・結合テストを通す**

Run: `cd backend/consent-api && pnpm typecheck && pnpm test && pnpm test:integration`
Expected: すべて PASS

- [ ] **Step 2: 開発の consent-api のコンテナを作り直すか、ユーザーに確かめる**

既存の結合テスト（リポジトリ直下の `integration/tests/consent-api/`）は、開発の compose の consent-api（127.0.0.1:3104）を HTTP で叩く。新しいコード（`handler.ts` と縮めた `server.ts`）で確かめるには、イメージを作り直して起動する必要がある（`docker compose up -d --build consent-api`）。**イメージのビルドを伴うので、実行の前にユーザーの了承を得る。** 了承が無ければ、この確認は残作業として報告する。

- [ ] **Step 3: （了承を得たら）既存の結合テストを通す**

Run: `cd backend/consent-api && docker compose up -d --build consent-api && cd ../../integration && IT_SERVICES=consent-api pnpm test`
Expected: `integration/tests/consent-api/` が PASS（振る舞いを変えていない）。`IT_SERVICES` の書き方は `integration/README.md` で確かめる。

- [ ] **Step 4: 仕様との突き合わせ**

`docs/superpowers/specs/2026-10-12-consent-api-lambda-design.md` の 2〜8 節を 1 項目ずつ見て、対応する変更があることを確かめる。無ければ、その項目を残作業として報告する。

- [ ] **Step 5: 最終の差分を一覧にする（コミットはしない）**

Run: `git status --short && git diff --stat`
