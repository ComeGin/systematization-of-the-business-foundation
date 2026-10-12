# admin-auth の Lambda 化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** admin-auth を ECS on Fargate から VPC の中の Lambda 2 つ（本体 `admin-auth` は ALB のターゲット、運用 `admin-auth-ops` は `aws lambda invoke` で呼ぶ）に移す。OIDC のエンドポイント・3 段の検査・許可リスト・画面の振る舞いは変えない。

**Architecture:** 今の `index.ts` の振り分けを、入口に依存しない `handler.ts`（Web 標準の `Request` → `Response`。例外を投げない）に移す。開発の入口 `server.ts` は `toNodeHandler(handle)` を包むだけにする。本番の入口 `lambda.ts` は ALB のマルチバリューの形のイベントと `Request`/`Response` を変換し、60 秒以上のアイドルのあとはプールと auth を作り直す。`scripts/*.ts` の中身は `operations.ts` に移し、開発の CLI と運用の入口 `ops.ts` で共有する。許可リストの初期値の追加は `migrate` の最後に移す。IaC は ② と同じく、関数・エイリアス・lambda 型のターゲットグループを関数のスタックに置く。

**Tech Stack:** Node.js 22（Lambda は `nodejs22.x`・arm64）、TypeScript、Better Auth 1.7.6・`@better-auth/oauth-provider` 1.7.6、pg 8、zod 4、vitest 5、esbuild、AWS SAM、`@aws-sdk/client-secrets-manager`。

**Spec:** `docs/superpowers/specs/2026-10-12-admin-auth-lambda-design.md`（実装者はこの計画と一緒に必ず読む）。前例: ② の計画 `docs/superpowers/plans/2026-10-12-consent-api-lambda.md` と実装（`backend/consent-api/src/lambda.ts`・`Makefile`・`tests/bundle-config.test.ts`）。

## Global Constraints

- パッケージマネージャは **pnpm 11**。作業ディレクトリは `backend/admin-auth`（IaC は `cloud`）。
- **git の状態を変えるコマンドは使わない**（`.claude/rules/git.md`）。各タスクの最後は `git status --short` で差分を確かめるだけ。
- **ビルドとデプロイ（`pnpm build`・`pnpm bundle`・`sam build`・`sam deploy`）は実行しない**（`.claude/rules/build-deploy.md`）。`pnpm typecheck` と `sam validate --lint` は実行してよい。**開発のイメージの作り直し（Task 11）は、② でユーザーが了承した範囲として行う。**
- テストは単体・結合とも作り、実行する（仕様の D2）。単体テストの決まり: `describe("正常系")` / `describe("異常系")`、各公開関数・エンドポイントに `空入力: `、異常系は `入力: ` か `サーバ: ` で始める。外部はモック。`testTimeout`/`hookTimeout` は 30 秒。**src のバグを見つけたら、src を直さず `it.todo` と直上のコメントで残す。**
- 秘密値の実ファイル（`.env`・`samconfig.toml`）を読まない・書かない。**Bash のコマンド文字列に `.env` という文字列を含めない**（保護のフックが止める。必要なら scratchpad にスクリプトを書いて実行する）。開発の PostgreSQL のパスワードは `docker exec admin-auth-postgres-1 printenv POSTGRES_PASSWORD` で取り、画面に出さない。
- 文書・コメントは日本語。ログの文面（`[migrate] …`・`[alb] …`・`[admin-auth] listening on …`）は今のまま保つ（既存のテストと運用の手順が頼っている）。
- 値: 本体の Lambda はメモリ **512 MB**・タイムアウト **10 秒**・予約同時実行数 **5**・プロビジョニングされた同時実行数 **既定 0**・エイリアス **`live`**。運用の Lambda はメモリ **512 MB**・タイムアウト **60 秒**・予約同時実行数 **1**。ターゲットグループの名前 **`comegin-<env>-admin-auth`**、ヘルスチェック無効、**マルチバリューヘッダー有効**。Lambda のプールは **`max: 2`・`query_timeout: 5000`**。アイドルの判定は **60 秒**。秘密値の接頭辞は環境変数 **`SECRETS_PREFIX`**（本番は `<SecretNamePrefix>/admin-auth`）。RDS の CA は **`NODE_EXTRA_CA_CERTS=/var/runtime/ca-cert.pem`**。
- 開発の PostgreSQL を **`127.0.0.1:5434`** にだけ開く（結合テスト用）。
- cloud/README の節番号: faq-bot を **4.17**、consent-api を **4.18**、admin-auth を **4.19**（仕様の D6）。

## Review Focus

- ALB が `multiValueQueryStringParameters` をデコードせずに渡す（`redirect_uri=https%3A%2F%2F…`・`scope=openid%20email`）→ 二重にエンコードせず、そのまま URL に戻す → Task 5 の「クエリを再エンコードしない」と Task 8 の認可の流れ。
- `Set-Cookie` が複数ある応答 → `multiValueHeaders["set-cookie"]` に 1 つずつ入る（`Headers` の反復でつながらない）→ Task 5 の「Set-Cookie を配列で返す」と Task 8。
- フォーム形式のトークンの要求（ALB は base64 で渡す）と `GET` に本文が付いたイベント → 本文を復号し、`GET`・`HEAD` には付けない → Task 5 と Task 8 のトークンの要求。
- 凍結のあとの古い DB の接続 → 60 秒以上のアイドルのあとは処理の前にプールを作り直し、Secrets Manager は読み直さない → Task 5 と Task 8。
- 要求の URL を組み立てられないイベント（不正な `host` ヘッダーなど）→ 例外にせず 400 を返す（Lambda の `Errors` にしない）→ Task 5 の「入力: URL を組み立てられないイベントは 400」。

---

### Task 1: 設定・DB・秘密値の土台

**Files:**
- Modify: `backend/admin-auth/src/config.ts`（`ConfigError`・`parseConfig`・`parseAlbConfig` を足す）
- Modify: `backend/admin-auth/src/db.ts`（`createPool` に上書きを足す）
- Modify: `backend/admin-auth/src/constants.ts`（定数を足す）
- Create: `backend/admin-auth/src/secrets.ts`
- Test: `backend/admin-auth/tests/config.test.ts`・`tests/db.test.ts`（追加）、`tests/secrets.test.ts`（新規）

**Interfaces:**
- Produces:
  - `export class ConfigError extends Error {}`
  - `export function parseConfig(env?: NodeJS.ProcessEnv, options?: { requireGoogle?: boolean }): Config`（`requireGoogle` の既定は `NODE_ENV === "production"`。不正なら `ConfigError`。メッセージは `環境変数が不正です:\n  - <名前>: <理由>`）
  - `export function parseAlbConfig(env?: NodeJS.ProcessEnv): AlbConfig`（不正なら `ConfigError`）
  - `loadConfig`・`loadAlbConfig` は今と同じ出力で `process.exit(1)`
  - `export function createPool(config: Config, overrides?: { max?: number; queryTimeoutMs?: number }): pg.Pool`
  - `export function secretReader(client: Pick<SecretsManagerClient, "send">, prefix: string): (name: string) => Promise<string>`
  - 定数: `LAMBDA_DB_POOL_MAX = 2`、`DB_QUERY_TIMEOUT_MS = 5_000`、`LAMBDA_IDLE_RECYCLE_MS = 60_000`

- [ ] **Step 1: 依存を足す**

Run: `cd backend/admin-auth && pnpm add -D esbuild@^0.28.2 @aws-sdk/client-secrets-manager@^3.1146.0`
Expected: devDependencies に 2 つ（② と同じ版の指定）。

- [ ] **Step 2: 失敗するテストを書く**

`tests/config.test.ts` の 2 行目を `import { ConfigError, loadAlbConfig, loadConfig, parseAlbConfig, parseConfig } from "../src/config.js";` にし、末尾に足す:

```ts
// Lambda の入口が使う。プロセスを終了させず、例外にする（初期化の失敗として次の呼び出しでやり直すため）
describe("parseConfig", () => {
  describe("正常系", () => {
    it("正しい環境変数なら loadConfig と同じ設定を返し、何も出さない", () => {
      const stderr = captureStderr();
      expect(parseConfig(validEnv())).toEqual(loadConfig(validEnv()));
      expect(stderr.spy).not.toHaveBeenCalled();
    });

    it("requireGoogle: false なら、NODE_ENV=production でも Google の設定を求めない（運用の入口）", () => {
      const config = parseConfig(validEnv({ NODE_ENV: "production" }), { requireGoogle: false });
      expect(config.GOOGLE_CLIENT_ID).toBeUndefined();
    });
  });

  describe("異常系", () => {
    it("入力: NODE_ENV=production で Google の設定が無ければ、既定では ConfigError", () => {
      expect(() => parseConfig(validEnv({ NODE_ENV: "production" }))).toThrow(ConfigError);
    });

    it("空入力: 環境変数が 1 つも無ければ、必須の名前を並べた ConfigError を投げ、終了しない", () => {
      const exit = mockExit();
      let error: unknown;
      try {
        parseConfig({});
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ConfigError);
      for (const name of ["BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "DATABASE_HOST", "DATABASE_USERNAME", "DATABASE_PASSWORD"]) {
        expect((error as Error).message).toContain(`- ${name}:`);
      }
      expect(exit).not.toHaveBeenCalled();
    });

    it("入力: 例外のメッセージに値（シークレット・DB のパスワード）を入れない", () => {
      let message = "";
      try {
        parseConfig(validEnv({ BETTER_AUTH_SECRET: "short", DATABASE_PORT: DB_PASSWORD }));
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("BETTER_AUTH_SECRET");
      expect(message).not.toContain(DB_PASSWORD);
      expect(message).not.toContain(SECRET);
    });
  });
});

describe("parseAlbConfig", () => {
  const albEnv = { ALB_CLIENT_ID: "alb-admin-gate", ALB_CLIENT_SECRET: "alb-secret-0123456789abcdefghijklmnopq", ALB_PROTECTED_HOSTS: "Chat.comegin.com" };

  describe("正常系", () => {
    it("正しければ loadAlbConfig と同じ値を返す", () => {
      expect(parseAlbConfig(albEnv)).toEqual(loadAlbConfig(albEnv));
    });
  });

  describe("異常系", () => {
    it("空入力: 何も無ければ ConfigError を投げ、終了しない", () => {
      const exit = mockExit();
      expect(() => parseAlbConfig({})).toThrow(ConfigError);
      expect(exit).not.toHaveBeenCalled();
    });

    it("入力: シークレットが短くても、値をメッセージに入れない", () => {
      let message = "";
      try {
        parseAlbConfig({ ...albEnv, ALB_CLIENT_SECRET: "short-secret-value" });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("ALB_CLIENT_SECRET");
      expect(message).not.toContain("short-secret-value");
    });
  });
});
```

`tests/db.test.ts` の `describe("createPool")` の `describe("正常系")` の末尾に足す:

```ts
    it("Lambda の入口はプールの上限と問い合わせのタイムアウトを上書きできる。上書きしなければ query_timeout は付けない", () => {
      createPool(loadConfig(validEnv()), { max: 2, queryTimeoutMs: 5_000 });
      createPool(loadConfig(validEnv()));
      expect(poolInstances[0]?.options).toMatchObject({ max: 2, query_timeout: 5_000 });
      expect(poolInstances[1]?.options.max).toBe(10);
      expect(poolInstances[1]?.options.query_timeout).toBeUndefined();
    });
```

`tests/secrets.test.ts`:

```ts
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { describe, expect, it, vi } from "vitest";
import { secretReader } from "../src/secrets.js";

describe("secretReader", () => {
  describe("正常系", () => {
    it("<接頭辞>/<名前> の Secret を GetSecretValue で読み、文字列を返す", async () => {
      const send = vi.fn().mockResolvedValue({ SecretString: "value-1" });
      const read = secretReader({ send } as never, "comegin/prod/admin-auth");
      await expect(read("DB_PASSWORD")).resolves.toBe("value-1");
      const command = send.mock.calls[0]![0] as GetSecretValueCommand;
      expect(command).toBeInstanceOf(GetSecretValueCommand);
      expect(command.input).toEqual({ SecretId: "comegin/prod/admin-auth/DB_PASSWORD" });
    });
  });

  describe("異常系", () => {
    it("空入力: 接頭辞が空なら、SDK を呼ばずに失敗する", async () => {
      const send = vi.fn();
      await expect(secretReader({ send } as never, "")("DB_PASSWORD")).rejects.toThrow("SECRETS_PREFIX");
      expect(send).not.toHaveBeenCalled();
    });

    it("サーバ: 文字列の値が無ければ失敗し、メッセージは Secret の名前だけ", async () => {
      const send = vi.fn().mockResolvedValue({ SecretBinary: new Uint8Array([1]) });
      await expect(secretReader({ send } as never, "p")("X")).rejects.toThrow("p/X に値が無い");
    });

    it("サーバ: SDK の例外（権限・NAT の断）はそのまま投げる", async () => {
      const send = vi.fn().mockRejectedValue(new Error("AccessDeniedException"));
      await expect(secretReader({ send } as never, "p")("X")).rejects.toThrow("AccessDeniedException");
    });
  });
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `cd backend/admin-auth && pnpm exec vitest run tests/config.test.ts tests/db.test.ts tests/secrets.test.ts`
Expected: FAIL（`parseConfig` などが無い、`secrets.js` が無い、`query_timeout` が付かない）

- [ ] **Step 4: 実装する**

`src/config.ts` の `EnvSchema`・`reportAndExit`・`loadConfig`・`AlbSchema` の後の `loadAlbConfig` を次の形にする（`BaseSchema` と `AlbSchema` の定義は変えない）:

```ts
/** 設定が不正。メッセージは変数名と理由だけ（値は入れない） */
export class ConfigError extends Error {}

const describeIssues = (error: z.ZodError): string =>
  `環境変数が不正です:\n${error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n")}`;

/**
 * 検証して返す。不正なら ConfigError を投げる（Lambda の入口が使う。プロセスを終了させない）。
 * requireGoogle の既定は NODE_ENV=production のとき真。運用の入口は Google を使わないので偽を渡す
 */
export function parseConfig(env: NodeJS.ProcessEnv = process.env, options: { requireGoogle?: boolean } = {}): Config {
  const result = BaseSchema.safeParse(env);
  if (!result.success) throw new ConfigError(describeIssues(result.error));
  const requireGoogle = options.requireGoogle ?? result.data.NODE_ENV === "production";
  if (requireGoogle) {
    const missing = (["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const).filter((key) => !result.data[key]);
    if (missing.length > 0) {
      throw new ConfigError(`環境変数が不正です:\n${missing.map((key) => `  - ${key}: NODE_ENV=production では必須です`).join("\n")}`);
    }
  }
  return result.data;
}

/** 開発の入口と CLI が使う。不正なら変数名と理由だけを stderr に出して終了する */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  try {
    return parseConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`[config] ${error.message}`);
    process.exit(1);
  }
}
```

`EnvSchema`（`superRefine`）と `reportAndExit` は消す（`parseConfig` が同じ検査をする）。`export type Config = z.infer<typeof EnvSchema>;` は `export type Config = z.infer<typeof BaseSchema>;` にする。ALB 側:

```ts
export function parseAlbConfig(env: NodeJS.ProcessEnv = process.env): AlbConfig {
  const result = AlbSchema.safeParse(env);
  if (!result.success) throw new ConfigError(describeIssues(result.error));
  return result.data;
}

export function loadAlbConfig(env: NodeJS.ProcessEnv = process.env): AlbConfig {
  try {
    return parseAlbConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`[config] ${error.message}`);
    process.exit(1);
  }
}
```

`src/constants.ts` の `DB_CONNECT_TIMEOUT_MS` の下に足す:

```ts
// Lambda の入口（lambda.ts。仕様 3.4）。1 つの実行環境が同時に処理するのは 1 件だけだが、Better Auth は 1 件の中で問い合わせを並べることがある
export const LAMBDA_DB_POOL_MAX = 2;
// 凍結のあとの死んだ接続で問い合わせが固まらないようにする保険
export const DB_QUERY_TIMEOUT_MS = 5_000;
// これ以上アイドルが続いたら、処理の前にプールと auth を作り直す（ALB の IdP の呼び出しの一連の流れ〈数秒〉では作り直さない長さ）
export const LAMBDA_IDLE_RECYCLE_MS = 60_000;
```

`src/db.ts` の `createPool` を次にする:

```ts
/** overrides は入口ごとの調整（Lambda の入口がプールの上限と問い合わせのタイムアウトを渡す。lambda.ts） */
export function createPool(config: Config, overrides: { max?: number; queryTimeoutMs?: number } = {}): pg.Pool {
  const pool = new pg.Pool({
    host: config.DATABASE_HOST,
    port: config.DATABASE_PORT,
    database: config.DATABASE_NAME,
    user: config.DATABASE_USERNAME,
    password: config.DATABASE_PASSWORD,
    // 有効にしたときは証明書を検証する（本番の Lambda は NODE_EXTRA_CA_CERTS=/var/runtime/ca-cert.pem で RDS の CA を信頼させる）
    ssl: config.DATABASE_SSL ? { rejectUnauthorized: true } : false,
    max: overrides.max ?? DB_POOL_MAX,
    connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
    ...(overrides.queryTimeoutMs === undefined ? {} : { query_timeout: overrides.queryTimeoutMs }),
  });
  // アイドル接続が切れたときに未処理のエラーでプロセスが落ちないようにする
  pool.on("error", (error) => {
    console.error(`[db] ${error.message}`);
  });
  return pool;
}
```

`src/secrets.ts`:

```ts
import { GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/**
 * <prefix>/<name> の Secret を読む関数を返す（Lambda の本体と運用の入口がコールドスタートで使う。仕様 3.6）。
 * 値はログにも例外のメッセージにも出さない（Secret の名前だけ）
 */
export function secretReader(client: Pick<SecretsManagerClient, "send">, prefix: string): (name: string) => Promise<string> {
  return async (name) => {
    if (!prefix) throw new Error("SECRETS_PREFIX が未設定");
    const out = await client.send(new GetSecretValueCommand({ SecretId: `${prefix}/${name}` }));
    if (!out.SecretString) throw new Error(`${prefix}/${name} に値が無い`);
    return out.SecretString;
  };
}
```

- [ ] **Step 5: 通ることを確かめる**

Run: `cd backend/admin-auth && pnpm exec vitest run && pnpm typecheck`
Expected: すべて PASS（既存の `loadConfig`・`loadAlbConfig` のテストも出力を変えていないので通る）

- [ ] **Step 6: 差分を確かめる（コミットはしない）**

Run: `git status --short backend/admin-auth`

---

### Task 2: 入口に依存しない本体 `handler.ts`

**Files:**
- Create: `backend/admin-auth/src/handler.ts`
- Test: `backend/admin-auth/tests/handler.test.ts`

**Interfaces:**
- Consumes: `consentPage`・`errorPage`・`signInPage`・`Page`（`src/pages.ts`）、定数（`src/constants.ts`）
- Produces:

```ts
export type Handle = (req: Request) => Promise<Response>;
export interface HandlerDeps { auth: { handler: (req: Request) => Promise<Response> } }
export function createHandler(deps: HandlerDeps): Handle;
```

- 振り分けは今の `index.ts` と同じ。ルート直下の discovery 2 本（`GET`・`HEAD`）は `/api/auth` を前に付けた URL の `Request` を作って渡す。ログは書き換え後のパスで、クエリは出さない。`auth.handler` の例外と想定外の例外は 500 の `internal error`（`text/plain; charset=utf-8`・`no-store`）。

- [ ] **Step 1: 失敗するテストを書く（`tests/handler.test.ts`）**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHandler, type Handle } from "../src/handler.js";
import { captureStderr, DB_PASSWORD } from "./helpers/env.js";

// handler.ts（入口に依存しない本体）の検査。auth は偽物（Better Auth の中身は auth.test.ts）
const BASE = "http://localhost:3103";
let authHandler: ReturnType<typeof vi.fn<(req: Request) => Promise<Response>>>;
let handle: Handle;
let stderr: ReturnType<typeof captureStderr>;

beforeEach(() => {
  stderr = captureStderr();
  authHandler = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  handle = createHandler({ auth: { handler: authHandler } });
});

const call = (method: string, path: string, init: RequestInit = {}) => handle(new Request(`${BASE}${path}`, { method, ...init }));
const lastLog = () => JSON.parse(String(stderr.spy.mock.calls.at(-1)?.[0])) as Record<string, unknown>;

describe("振り分け", () => {
  describe("正常系", () => {
    it("GET /healthz は DB（auth）に触れずに 200 ok を返す", async () => {
      const res = await call("GET", "/healthz");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(authHandler).not.toHaveBeenCalled();
    });

    it("HEAD /healthz も 200", async () => {
      expect((await call("HEAD", "/healthz")).status).toBe(200);
    });

    it("/api/auth/ 配下は、メソッドと本文を保ったまま Better Auth に渡す", async () => {
      await call("POST", "/api/auth/oauth2/token", { body: "grant_type=authorization_code", headers: { "content-type": "application/x-www-form-urlencoded" } });
      const req = authHandler.mock.calls[0]![0];
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/api/auth/oauth2/token");
      expect(await req.text()).toBe("grant_type=authorization_code");
    });

    it("ルート直下の openid-configuration は、クエリを保ったまま issuer 配下に付け替えて渡す", async () => {
      await call("GET", "/.well-known/openid-configuration?x=1");
      const url = new URL(authHandler.mock.calls[0]![0].url);
      expect(url.pathname).toBe("/api/auth/.well-known/openid-configuration");
      expect(url.search).toBe("?x=1");
    });

    it("ルート直下の oauth-authorization-server も付け替える", async () => {
      await call("GET", "/.well-known/oauth-authorization-server");
      expect(new URL(authHandler.mock.calls[0]![0].url).pathname).toBe("/api/auth/.well-known/oauth-authorization-server");
    });

    it("RFC 8414 の issuer を後ろに付ける形は、付け替えずにそのまま渡す", async () => {
      await call("GET", "/.well-known/oauth-authorization-server/api/auth");
      expect(new URL(authHandler.mock.calls[0]![0].url).pathname).toBe("/.well-known/oauth-authorization-server/api/auth");
    });

    it("Better Auth の応答（複数の Set-Cookie を含む）をそのまま返す", async () => {
      const headers = new Headers();
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      authHandler.mockResolvedValue(new Response(null, { status: 302, headers }));
      const res = await call("GET", "/api/auth/callback/google");
      expect(res.status).toBe(302);
      expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    });

    it("GET /sign-in はログイン画面を、CSP とキャッシュ禁止のヘッダー付きで返す", async () => {
      const res = await call("GET", "/sign-in?client_id=a&sig=s");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("管理画面へのログイン");
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    });

    it("GET /consent は同意画面を返す", async () => {
      expect(await (await call("GET", "/consent")).text()).toContain("skip_consent");
    });

    it("GET /error は error クエリに応じた文言を返す", async () => {
      expect(await (await call("GET", "/error?error=FORBIDDEN")).text()).toContain("許可リスト");
    });

    it("空入力: GET /error に error クエリが無ければ既定の文言を返す", async () => {
      expect(await (await call("GET", "/error")).text()).toContain("ログインに失敗しました");
    });

    it("空入力: / は 404 not found", async () => {
      const res = await call("GET", "/");
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("not found");
      expect(authHandler).not.toHaveBeenCalled();
    });
  });

  describe("異常系", () => {
    it("入力: POST /healthz は 404", async () => {
      expect((await call("POST", "/healthz")).status).toBe(404);
    });

    it("入力: /api/auth（末尾のスラッシュ無し）と似た名前のパスは Better Auth に渡さない", async () => {
      expect((await call("GET", "/api/auth")).status).toBe(404);
      expect((await call("GET", "/api/authx/jwks")).status).toBe(404);
      expect(authHandler).not.toHaveBeenCalled();
    });

    it("入力: GET 以外の discovery は付け替えない", async () => {
      await call("POST", "/.well-known/openid-configuration");
      expect(new URL(authHandler.mock.calls[0]![0].url).pathname).toBe("/.well-known/openid-configuration");
    });

    it("入力: GET /error はクエリの値を埋め込まない", async () => {
      expect(await (await call("GET", `/error?error=${encodeURIComponent("<script>x</script>")}`)).text()).not.toContain("<script>x</script>");
    });

    it("入力: POST /sign-in は 404", async () => {
      expect((await call("POST", "/sign-in")).status).toBe(404);
    });

    it("サーバ: Better Auth が投げたら 500 internal error で、本文に例外の中身を出さない", async () => {
      authHandler.mockRejectedValue(new Error(`password authentication failed: ${DB_PASSWORD}`));
      const res = await call("POST", "/api/auth/oauth2/token");
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body).toBe("internal error");
      expect(body).not.toContain(DB_PASSWORD);
    });
  });
});

describe("アクセスログ", () => {
  describe("正常系", () => {
    it("JSON の 1 行で、メソッド・パス・ステータス・所要時間を出し、クエリ（認可コードや署名）は出さない", async () => {
      await call("GET", "/sign-in?code=SECRETCODE&sig=SIGVALUE");
      const line = String(stderr.spy.mock.calls.at(-1)?.[0]);
      expect(lastLog()).toMatchObject({ method: "GET", path: "/sign-in", status: 200 });
      expect(typeof lastLog().ms).toBe("number");
      expect(line).not.toContain("SECRETCODE");
      expect(line).not.toContain("SIGVALUE");
    });

    it("付け替えた discovery は、付け替え後のパスで記録する", async () => {
      await call("GET", "/.well-known/openid-configuration?state=STATEVALUE");
      expect(lastLog().path).toBe("/api/auth/.well-known/openid-configuration");
      expect(String(stderr.spy.mock.calls.at(-1)?.[0])).not.toContain("STATEVALUE");
    });
  });

  describe("異常系", () => {
    it("サーバ: 500 のときもステータスつきで 1 行出す", async () => {
      authHandler.mockRejectedValue(new Error("boom"));
      await call("GET", "/api/auth/jwks");
      expect(lastLog()).toMatchObject({ path: "/api/auth/jwks", status: 500 });
    });

    it("空入力: 本文の無い 404 も記録する", async () => {
      await call("GET", "/nothing");
      expect(lastLog()).toMatchObject({ status: 404 });
    });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `cd backend/admin-auth && pnpm exec vitest run tests/handler.test.ts`
Expected: FAIL（`../src/handler.js` が無い）

- [ ] **Step 3: `src/handler.ts` を書く**

```ts
import { AUTH_BASE_PATH, CONSENT_PATH, ERROR_PATH, HEALTH_PATH, SIGN_IN_PATH } from "./constants.js";
import { consentPage, errorPage, type Page, signInPage } from "./pages.js";

/** 入口に依存しない本体の型。開発は server.ts（toNodeHandler）、本番は lambda.ts（ALB のイベント）が Request を作る */
export type Handle = (req: Request) => Promise<Response>;

export interface HandlerDeps {
  auth: { handler: (req: Request) => Promise<Response> };
}

const ROOT_WELL_KNOWN_PATHS = new Set(["/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"]);

const text = (status: number, body: string): Response =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

const page = (p: Page): Response =>
  new Response(p.html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": p.csp,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });

/**
 * 管理画面の関門の本体（仕様 3.1）。振り分けは以前の index.ts と同じ。例外を投げない（想定外の失敗は 500）。
 * ログは 1 件 1 行（時刻・メソッド・パス・ステータス・所要時間）。クエリ（認可コードや署名）とメールは出さない
 */
export function createHandler({ auth }: HandlerDeps): Handle {
  const route = async (req: Request, url: URL): Promise<Response> => {
    const isRead = req.method === "GET" || req.method === "HEAD";
    // ヘルスチェック。DB は見ない（開発用。本番の ALB ではヘルスチェックを使わない）
    if (url.pathname === HEALTH_PATH && isRead) return text(200, "ok");

    let target = req;
    // ルート直下の discovery は、issuer（/api/auth）配下の同じ内容への別名として返す
    if (isRead && ROOT_WELL_KNOWN_PATHS.has(url.pathname)) {
      url.pathname = `${AUTH_BASE_PATH}${url.pathname}`;
      target = new Request(url, req);
    }

    // Better Auth（認可・トークン・UserInfo・JWKS・ソーシャルログインのコールバック・discovery）。
    // RFC 8414 のパスを issuer の後ろに付ける形（/.well-known/oauth-authorization-server/api/auth）も同じハンドラーが返す
    if (url.pathname.startsWith(`${AUTH_BASE_PATH}/`) || url.pathname.startsWith("/.well-known/")) {
      try {
        return await auth.handler(target);
      } catch (error) {
        console.error("[auth] unhandled error", error);
        return text(500, "internal error");
      }
    }

    if (isRead && url.pathname === SIGN_IN_PATH) return page(signInPage());
    if (isRead && url.pathname === CONSENT_PATH) return page(consentPage());
    if (isRead && url.pathname === ERROR_PATH) return page(errorPage(url.searchParams.get("error")));
    return text(404, "not found");
  };

  return async (req) => {
    const startedAt = Date.now();
    const url = new URL(req.url);
    let res: Response;
    try {
      res = await route(req, url);
    } catch (error) {
      console.error("[server] unexpected error", error);
      res = text(500, "internal error");
    }
    // クエリ（認可コードや署名を含む）は記録しない。付け替えたときは付け替え後のパス
    console.error(
      JSON.stringify({ t: new Date().toISOString(), method: req.method, path: url.pathname, status: res.status, ms: Date.now() - startedAt }),
    );
    return res;
  };
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `cd backend/admin-auth && pnpm exec vitest run tests/handler.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 差分を確かめる（コミットはしない）**

Run: `git status --short backend/admin-auth`

---

### Task 3: 開発の入口 `server.ts` と、縮めた `index.ts`

**Files:**
- Create: `backend/admin-auth/src/server.ts`
- Modify: `backend/admin-auth/src/index.ts`（全体を置き換える）
- Test: `backend/admin-auth/tests/server.test.ts`（新規）、`backend/admin-auth/tests/index.test.ts`（全体を置き換える）

**Interfaces:**
- Consumes: `Handle`・`createHandler`（Task 2）
- Produces: `export function createServer(handle: Handle): http.Server`

- [ ] **Step 1: 失敗するテストを書く**

`tests/server.test.ts`:

```ts
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Handle } from "../src/handler.js";
import { createServer } from "../src/server.js";
import { captureStderr } from "./helpers/env.js";

// 開発の入口（Node の http と toNodeHandler）の検査。127.0.0.1 のポート 0 で起動する
let server: http.Server;
let base: string;
let stderr: ReturnType<typeof captureStderr>;

async function start(handle: Handle): Promise<void> {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** node:http で送る（要求ターゲットを fetch が正規化しないように） */
function raw(path: string, headers: http.OutgoingHttpHeaders = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/`, { method: "GET", path, headers, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end();
  });
}

beforeEach(() => {
  stderr = captureStderr();
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("createServer", () => {
  describe("正常系", () => {
    it("handle に x-forwarded-proto と host から組み立てた URL の Request を渡し、応答を書き出す", async () => {
      let received: Request | undefined;
      await start(async (req) => {
        received = req;
        return new Response("hi", { status: 201, headers: { "x-test": "1" } });
      });
      const res = await raw("/sign-in?x=1", { host: "auth.example", "x-forwarded-proto": "https" });
      expect(received!.url).toBe("https://auth.example/sign-in?x=1");
      expect(res.status).toBe(201);
      expect(res.headers["x-test"]).toBe("1");
      expect(res.text).toBe("hi");
    });

    it("複数の Set-Cookie を 1 つずつ書き出す", async () => {
      await start(async () => {
        const headers = new Headers();
        headers.append("set-cookie", "a=1; Path=/");
        headers.append("set-cookie", "b=2; Path=/");
        return new Response(null, { status: 302, headers });
      });
      const res = await raw("/api/auth/callback/google");
      expect(res.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    });

    it("keep-alive を 60 秒より長くし、headersTimeout はさらに長くする", async () => {
      await start(async () => new Response("ok"));
      expect(server.keepAliveTimeout).toBeGreaterThan(60_000);
      expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
      expect(server.requestTimeout).toBe(30_000);
    });

    it("空入力: 本文の無い応答も書き出す", async () => {
      await start(async () => new Response(null, { status: 204 }));
      const res = await raw("/");
      expect(res.status).toBe(204);
      expect(res.text).toBe("");
    });
  });

  describe("異常系", () => {
    it("入力: 解釈できない要求ターゲット（//[）は handle を呼ばずに 400 bad request で、クエリを記録しない", async () => {
      const handle = vi.fn<Handle>(async () => new Response("ok"));
      await start(handle);
      const res = await raw("//[?code=SECRETCODE");
      expect(res.status).toBe(400);
      expect(res.text).toBe("bad request");
      expect(handle).not.toHaveBeenCalled();
      expect(stderr.text()).toContain('"status":400');
      expect(stderr.text()).not.toContain("SECRETCODE");
    });

    it("サーバ: handle が投げたら（約束違反）、詳細を出さずに 500 internal error", async () => {
      await start(async () => {
        throw new Error("boom: internal detail");
      });
      const res = await raw("/api/auth/jwks");
      expect(res.status).toBe(500);
      expect(res.text).toBe("internal error");
      expect(stderr.text()).toContain("[server] unexpected error");
    });
  });
});
```

`tests/index.test.ts` を丸ごと置き換える:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureStderr, DB_PASSWORD, mockExit, SECRET, stubValidEnv } from "./helpers/env.js";

// index.ts は import した時点で起動する。server・handler・auth・db を偽物にして、起動と停止の手順だけを見る
// （振り分けは handler.test.ts、待ち受けの細部は server.test.ts）
const mocks = vi.hoisted(() => ({
  server: undefined as unknown as Record<string, ReturnType<typeof import("vitest").vi.fn>>,
  createServer: vi.fn(),
  createHandler: vi.fn(() => "HANDLE"),
  createAuth: vi.fn(() => ({ handler: vi.fn() })),
  pool: { end: vi.fn(), query: vi.fn() },
}));
vi.mock("../src/server.js", () => ({ createServer: mocks.createServer }));
vi.mock("../src/handler.js", () => ({ createHandler: mocks.createHandler }));
vi.mock("../src/auth.js", () => ({ createAuth: mocks.createAuth }));
vi.mock("../src/db.js", () => ({ createPool: () => mocks.pool }));

let signals: Map<string, () => void>;
let stderr: ReturnType<typeof captureStderr>;

async function load() {
  vi.resetModules();
  await import("../src/index.js");
}

beforeEach(() => {
  stubValidEnv({ ADMIN_BOOTSTRAP_EMAILS: "a@comegin.com" });
  stderr = captureStderr();
  signals = new Map();
  vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
    signals.set(event, listener);
    return process;
  }) as never);
  mocks.server = {
    listen: vi.fn((_port: number, _host: string, cb?: () => void) => cb?.()),
    close: vi.fn((cb?: () => void) => cb?.()),
    closeIdleConnections: vi.fn(),
  };
  mocks.createServer.mockReset().mockReturnValue(mocks.server);
  mocks.createHandler.mockClear();
  mocks.createAuth.mockClear();
  mocks.pool.end.mockReset().mockResolvedValue(undefined);
  mocks.pool.query.mockReset();
});

describe("起動", () => {
  describe("正常系", () => {
    it("auth から handler を作り、設定のホストとポートで待ち受け、issuer をログに出す", async () => {
      vi.stubEnv("PORT", "4555");
      vi.stubEnv("HOST", "127.0.0.1");
      await load();
      expect(mocks.createAuth.mock.calls[0]?.[1]).toBe(mocks.pool);
      expect(mocks.createHandler).toHaveBeenCalledWith({ auth: mocks.createAuth.mock.results[0]?.value });
      expect(mocks.createServer).toHaveBeenCalledWith("HANDLE");
      expect(mocks.server.listen).toHaveBeenCalledWith(4555, "127.0.0.1", expect.any(Function));
      expect(stderr.text()).toContain("issuer http://localhost:3103/api/auth");
    });

    it("許可リストの初期値は追加しない（migrate に移した。仕様 3.5）。起動で DB に触れない", async () => {
      await load();
      expect(mocks.pool.query).not.toHaveBeenCalled();
      expect(stderr.text()).not.toContain("allowlist bootstrap");
    });

    it("起動のログにシークレットと DB のパスワードを出さない", async () => {
      await load();
      expect(stderr.text()).not.toContain(SECRET);
      expect(stderr.text()).not.toContain(DB_PASSWORD);
    });
  });

  describe("異常系", () => {
    it("入力: 設定が不正なら、DB にもサーバーにも触れる前に終了する", async () => {
      vi.stubEnv("BETTER_AUTH_SECRET", "short");
      mockExit();
      await expect(load()).rejects.toThrow("process.exit(1)");
      expect(mocks.createAuth).not.toHaveBeenCalled();
      expect(mocks.createServer).not.toHaveBeenCalled();
    });

    it("空入力: 必須の環境変数が空なら終了し、名前を出す", async () => {
      vi.stubEnv("DATABASE_HOST", "");
      mockExit();
      await expect(load()).rejects.toThrow("process.exit(1)");
      expect(stderr.text()).toContain("DATABASE_HOST");
    });
  });
});

describe("停止", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await load();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("正常系", () => {
    it("SIGTERM・SIGINT を購読する", () => {
      expect(signals.has("SIGTERM")).toBe(true);
      expect(signals.has("SIGINT")).toBe(true);
    });

    it("SIGTERM で新しい接続を止め、処理中のリクエストを終えてから DB を閉じて exit(0) する", async () => {
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      signals.get("SIGTERM")!();
      expect(mocks.server.close).toHaveBeenCalledTimes(1);
      expect(mocks.server.closeIdleConnections).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      expect(mocks.pool.end).toHaveBeenCalledTimes(1);
    });

    it("2 回目のシグナルでは何もしない", () => {
      vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      mocks.server.close = vi.fn();
      signals.get("SIGTERM")!();
      signals.get("SIGINT")!();
      expect(mocks.server.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("異常系", () => {
    it("サーバ: 10 秒で処理が終わらなければ exit(1) で打ち切る", () => {
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      mocks.server.close = vi.fn();
      signals.get("SIGTERM")!();
      vi.advanceTimersByTime(9_999);
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(exit).toHaveBeenCalledWith(1);
    });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `cd backend/admin-auth && pnpm exec vitest run tests/server.test.ts tests/index.test.ts`
Expected: FAIL（`server.js` が無い。`index.ts` がまだ許可リストを追加する）

- [ ] **Step 3: `src/server.ts` を書く**

```ts
import http from "node:http";
import { toNodeHandler } from "better-auth/node";
import { HEADERS_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from "./constants.js";
import type { Handle } from "./handler.js";

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

/**
 * 開発の入口（3103。仕様 3.1）。toNodeHandler が Node の要求を Request にして handle を呼び、Response を書き出す
 * （複数の Set-Cookie も 1 つずつ書く）。本番は lambda.ts（ALB のターゲット）で、keep-alive などは開発だけの意味になる
 */
export function createServer(handle: Handle): http.Server {
  const nodeHandler = toNodeHandler(handle);
  const server = http.createServer((req, res) => {
    // 解釈できない要求ターゲット（例 //[）は、toNodeHandler の new Request が投げる前に 400 にする（以前の index.ts と同じ）
    if (!URL.parse(req.url ?? "/", "http://localhost")) {
      sendText(res, 400, "bad request");
      console.error(
        JSON.stringify({ t: new Date().toISOString(), method: req.method, path: (req.url ?? "").split("?")[0], status: 400, ms: 0 }),
      );
      return;
    }
    nodeHandler(req, res).catch((error: unknown) => {
      // handle は例外を投げない約束。投げたら詳細を出さずに 500 にする
      console.error("[server] unexpected error", error);
      if (!res.headersSent) sendText(res, 500, "internal error");
      else res.end();
    });
  });
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}
```

`src/constants.ts` の keep-alive のコメント `// ALB のアイドルタイムアウト（既定 60 秒）より長くする` を `// 開発の入口（server.ts）だけが使う。以前の ECS では ALB のアイドルタイムアウト（既定 60 秒）より長くする必要があった` に替える。

- [ ] **Step 4: `src/index.ts` を丸ごと置き換える**

```ts
import { createAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { AUTH_BASE_PATH, SERVER_NAME, SHUTDOWN_TIMEOUT_MS } from "./constants.js";
import { createPool } from "./db.js";
import { createHandler } from "./handler.js";
import { createServer } from "./server.js";

// 開発の入口（pnpm dev・compose）。本番は lambda.ts（本体）と ops.ts（運用）。
// 許可リストの初期値は追加しない（migrate の最後で追加する。仕様 3.5）。表が無いあいだはログインの判定が 500 になる
const config = loadConfig();
const pool = createPool(config);
const server = createServer(createHandler({ auth: createAuth(config, pool) }));

server.listen(config.PORT, config.HOST, () => {
  console.error(`[${SERVER_NAME}] listening on ${config.HOST}:${config.PORT} (issuer ${config.BETTER_AUTH_URL}${AUTH_BASE_PATH})`);
});

// 停止（SIGTERM・SIGINT）では、処理中のリクエストを終えてから DB を閉じる（開発だけ。Lambda では要らない）
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[${SERVER_NAME}] ${signal} received, shutting down`);
  const forced = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
  forced.unref();
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  server.closeIdleConnections();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
```

- [ ] **Step 5: 単体テストをすべて通す**

Run: `cd backend/admin-auth && pnpm exec vitest run && pnpm typecheck`
Expected: すべて PASS

- [ ] **Step 6: 差分を確かめる（コミットはしない）**

Run: `git status --short backend/admin-auth`

---

### Task 4: 運用の処理 `operations.ts` と、縮めた CLI

**Files:**
- Create: `backend/admin-auth/src/operations.ts`
- Modify: `backend/admin-auth/src/scripts/migrate.ts`・`src/scripts/register-alb-client.ts`（全体を置き換える）
- Test: `backend/admin-auth/tests/operations.test.ts`（新規）、`tests/scripts/migrate.test.ts`（初期値の分を足す）

**Interfaces:**
- Consumes: `ensureAllowlistTable`・`bootstrapAllowlist`（`src/allowlist.ts`）、`AlbConfig`（`src/config.ts`）、`OIDC_SCOPES`
- Produces:

```ts
export interface MigrateResult { createdTables: string[]; addedColumnsTables: string[]; bootstrapped: number }
export async function runMigrate(pool: pg.Pool, authOptions: Parameters<typeof getMigrations>[0], bootstrapEmails: string[], log?: (line: string) => void): Promise<MigrateResult>;
export type AuthMethod = "client_secret_basic" | "client_secret_post";
export interface RegisterOptions { authMethod: AuthMethod; requirePkce: boolean }
export interface RegisterResult { outcome: "created" | "updated" | "unchanged"; redirectUris: string[] }
export async function registerAlbClient(auth: Pick<Auth, "$context">, alb: AlbConfig, options: RegisterOptions): Promise<RegisterResult>;
```

- `runMigrate` は `[migrate] create tables: … / add columns: …` を出してから移行し、許可リストの表を作り、初期値を追加して `[migrate] allowlist bootstrap: <件数> added` を出す（`[migrate] done` は呼び出し側が出す）。

- [ ] **Step 1: 失敗するテストを書く**

`tests/operations.test.ts`:

```ts
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerAlbClient, runMigrate } from "../src/operations.js";
import { fakePool } from "./helpers/pool.js";

const mocks = vi.hoisted(() => ({ order: [] as string[], getMigrations: vi.fn(), runMigrations: vi.fn() }));
vi.mock("better-auth/db/migration", () => ({ getMigrations: mocks.getMigrations }));

const ALB = {
  ALB_CLIENT_ID: "alb-admin-gate",
  ALB_CLIENT_SECRET: "alb-secret-0123456789abcdefghijklmnopq",
  ALB_PROTECTED_HOSTS: ["chat.comegin.com", "mkt.comegin.com"],
};

beforeEach(() => {
  mocks.order.length = 0;
  mocks.runMigrations.mockReset().mockImplementation(async () => void mocks.order.push("runMigrations"));
  mocks.getMigrations.mockReset().mockResolvedValue({ toBeCreated: [{ table: "user" }], toBeAdded: [], runMigrations: mocks.runMigrations });
});

describe("runMigrate", () => {
  describe("正常系", () => {
    it("移行 → 許可リストの表の作成 → 初期値の追加の順に行い、結果を返す", async () => {
      const { pool, query } = fakePool((sql) => {
        mocks.order.push(sql.includes("CREATE TABLE") ? "ensure" : "bootstrap");
        return { rowCount: sql.includes("INSERT") ? 2 : 0 };
      });
      const lines: string[] = [];
      const result = await runMigrate(pool, { options: true } as never, ["a@comegin.com", "B@comegin.com"], (line) => lines.push(line));
      expect(mocks.order).toEqual(["runMigrations", "ensure", "bootstrap"]);
      expect(result).toEqual({ createdTables: ["user"], addedColumnsTables: [], bootstrapped: 2 });
      expect(query.mock.calls[1]?.[1]).toEqual([["a@comegin.com", "b@comegin.com"]]);
      expect(lines).toEqual(["[migrate] create tables: user / add columns: -", "[migrate] allowlist bootstrap: 2 added"]);
    });

    it("空入力: 初期値が空なら追加の SQL を発行せず、0 件と出す", async () => {
      const { pool, query } = fakePool();
      const lines: string[] = [];
      const result = await runMigrate(pool, {} as never, [], (line) => lines.push(line));
      expect(result.bootstrapped).toBe(0);
      expect(query).toHaveBeenCalledTimes(1);
      expect(lines.at(-1)).toBe("[migrate] allowlist bootstrap: 0 added");
    });
  });

  describe("異常系", () => {
    it("サーバ: 移行に失敗したら、表も初期値も触らずに投げる", async () => {
      mocks.runMigrations.mockRejectedValue(new Error("permission denied"));
      const { pool, query } = fakePool();
      await expect(runMigrate(pool, {} as never, ["a@comegin.com"], () => {})).rejects.toThrow("permission denied");
      expect(query).not.toHaveBeenCalled();
    });
  });
});

describe("registerAlbClient", () => {
  const adapter = { findOne: vi.fn(), update: vi.fn(), create: vi.fn() };
  const auth = { $context: Promise.resolve({ adapter }) } as never;
  const options = { authMethod: "client_secret_basic" as const, requirePkce: false };

  beforeEach(() => {
    adapter.findOne.mockReset().mockResolvedValue(null);
    adapter.update.mockReset().mockResolvedValue(undefined);
    adapter.create.mockReset().mockResolvedValue(undefined);
  });

  describe("正常系", () => {
    it("無ければ作り（created）、リダイレクト URI を返す。シークレットは SHA-256 の base64url で保存する", async () => {
      const result = await registerAlbClient(auth, ALB, options);
      expect(result).toEqual({
        outcome: "created",
        redirectUris: ["https://chat.comegin.com/oauth2/idpresponse", "https://mkt.comegin.com/oauth2/idpresponse"],
      });
      const data = adapter.create.mock.calls[0]![0].data as Record<string, unknown>;
      expect(data.clientSecret).toBe(createHash("sha256").update(ALB.ALB_CLIENT_SECRET).digest("base64url"));
      expect(data).toMatchObject({ clientId: ALB.ALB_CLIENT_ID, tokenEndpointAuthMethod: "client_secret_basic", requirePKCE: false, skipConsent: true });
    });

    it("同じ内容なら何も書かずに unchanged", async () => {
      await registerAlbClient(auth, ALB, options);
      const stored = { ...(adapter.create.mock.calls[0]![0].data as Record<string, unknown>) };
      adapter.findOne.mockResolvedValue(stored);
      adapter.create.mockClear();
      expect((await registerAlbClient(auth, ALB, options)).outcome).toBe("unchanged");
      expect(adapter.update).not.toHaveBeenCalled();
      expect(adapter.create).not.toHaveBeenCalled();
    });

    it("認証方式が変われば updated", async () => {
      await registerAlbClient(auth, ALB, options);
      adapter.findOne.mockResolvedValue({ ...(adapter.create.mock.calls[0]![0].data as Record<string, unknown>) });
      const result = await registerAlbClient(auth, ALB, { authMethod: "client_secret_post", requirePkce: true });
      expect(result.outcome).toBe("updated");
      expect(adapter.update.mock.calls[0]![0].update).toMatchObject({ tokenEndpointAuthMethod: "client_secret_post", requirePKCE: true });
    });
  });

  describe("異常系", () => {
    it("サーバ: 行の作成に失敗したら投げる", async () => {
      adapter.create.mockRejectedValue(new Error("unique violation"));
      await expect(registerAlbClient(auth, ALB, options)).rejects.toThrow("unique violation");
    });

    it("空入力: 保護するホストが 0 件でも、リダイレクト URI は空のまま登録する（検証は設定の側で行う）", async () => {
      const result = await registerAlbClient(auth, { ...ALB, ALB_PROTECTED_HOSTS: [] }, options);
      expect(result.redirectUris).toEqual([]);
    });
  });
});
```

`tests/scripts/migrate.test.ts` を直す:
1. `vi.hoisted` に `bootstrapAllowlist: vi.fn(),` を足し、`vi.mock("../../src/allowlist.js", ...)` を `vi.mock("../../src/allowlist.js", () => ({ ensureAllowlistTable: mocks.ensureAllowlistTable, bootstrapAllowlist: mocks.bootstrapAllowlist }));` にする。
2. `beforeEach` に `mocks.bootstrapAllowlist.mockReset().mockImplementation(async () => { mocks.order.push("bootstrapAllowlist"); return 1; });` を足し、`stubValidEnv()` を `stubValidEnv({ ADMIN_BOOTSTRAP_EMAILS: "a@comegin.com" })` にする。
3. `["runMigrations", "ensureAllowlistTable", "end"]`（2 か所）を `["runMigrations", "ensureAllowlistTable", "bootstrapAllowlist", "end"]` にする。
4. `describe("正常系")` の末尾に足す:

```ts
    it("最後に許可リストの初期値を追加し、件数を出す（起動時から移した。仕様 3.5）", async () => {
      await run();
      expect(mocks.bootstrapAllowlist).toHaveBeenCalledWith(mocks.pool, ["a@comegin.com"]);
      expect(stderr.text()).toContain("[migrate] allowlist bootstrap: 1 added");
    });
```

5. `describe("異常系")` の末尾に足す:

```ts
    it("サーバ: 初期値の追加に失敗しても exitCode=1 にし、done を出さない", async () => {
      mocks.bootstrapAllowlist.mockRejectedValue(new Error("check constraint"));
      await run();
      expect(process.exitCode).toBe(1);
      expect(stderr.text()).not.toContain("[migrate] done");
      expect(mocks.pool.end).toHaveBeenCalledTimes(1);
    });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `cd backend/admin-auth && pnpm exec vitest run tests/operations.test.ts tests/scripts`
Expected: FAIL（`operations.js` が無い。migrate が初期値を追加しない）

- [ ] **Step 3: `src/operations.ts` を書く**

```ts
import { createHash } from "node:crypto";
import { getMigrations } from "better-auth/db/migration";
import type pg from "pg";
import { bootstrapAllowlist, ensureAllowlistTable } from "./allowlist.js";
import type { Auth } from "./auth.js";
import type { AlbConfig } from "./config.js";
import { OIDC_SCOPES } from "./constants.js";

// 1 回だけ実行する運用の処理（仕様 3.1）。開発の CLI（scripts/*.ts）と本番の運用の Lambda（ops.ts）で共有する

export interface MigrateResult {
  createdTables: string[];
  addedColumnsTables: string[];
  bootstrapped: number;
}

/**
 * Better Auth のスキーマ（ユーザー・セッション・OAuth クライアント・JWKS など）と許可リストの表を作り、
 * 最後に許可リストの初期値を追加する（起動時から移した。仕様 3.5）。何度実行しても安全
 */
export async function runMigrate(
  pool: pg.Pool,
  authOptions: Parameters<typeof getMigrations>[0],
  bootstrapEmails: string[],
  log: (line: string) => void = (line) => console.error(line),
): Promise<MigrateResult> {
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(authOptions);
  const createdTables = toBeCreated.map((t) => t.table);
  const addedColumnsTables = toBeAdded.map((t) => t.table);
  log(`[migrate] create tables: ${createdTables.join(", ") || "-"} / add columns: ${addedColumnsTables.join(", ") || "-"}`);
  await runMigrations();
  await ensureAllowlistTable(pool);
  const bootstrapped = await bootstrapAllowlist(pool, bootstrapEmails);
  log(`[migrate] allowlist bootstrap: ${bootstrapped} added`);
  return { createdTables, addedColumnsTables, bootstrapped };
}

export type AuthMethod = "client_secret_basic" | "client_secret_post";

export interface RegisterOptions {
  authMethod: AuthMethod;
  requirePkce: boolean;
}

export interface RegisterResult {
  outcome: "created" | "updated" | "unchanged";
  redirectUris: string[];
}

/**
 * ALB の authenticate-oidc を、信頼済みの機密クライアントとして登録（なければ作成、あれば同じ内容に更新）する。
 * 公開 API（adminCreateOAuthClient）はログイン済みのユーザーのセッションを要求し client_id も指定できないため、
 * Better Auth のアダプターで oauthClient の行を直接書く。plugin の版を上げたら、書く列とシークレットの保存方式を確かめる
 */
export async function registerAlbClient(auth: Pick<Auth, "$context">, alb: AlbConfig, options: RegisterOptions): Promise<RegisterResult> {
  const { adapter } = await auth.$context;
  const now = new Date();
  const redirectUris = alb.ALB_PROTECTED_HOSTS.map((host) => `https://${host}/oauth2/idpresponse`);
  const fields = {
    // plugin の既定（storeClientSecret: "hashed"）と同じ方式: SHA-256 の base64url（パディングなし）
    clientSecret: createHash("sha256").update(alb.ALB_CLIENT_SECRET).digest("base64url"),
    name: "ALB (admin gate)",
    redirectUris,
    scopes: OIDC_SCOPES,
    tokenEndpointAuthMethod: options.authMethod,
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    applicationType: "web",
    // 自社の管理画面に、毎回「許可しますか」と聞かない
    skipConsent: true,
    enableEndSession: false,
    requirePKCE: options.requirePkce,
    disabled: false,
    clientCredentialsScopes: [],
    updatedAt: now,
  };

  const where = [{ field: "clientId", value: alb.ALB_CLIENT_ID }];
  const existing = await adapter.findOne<Record<string, unknown>>({ model: "oauthClient", where });
  // 同じ内容なら何も書かない（updatedAt も変えない）
  const { updatedAt: _updatedAt, ...desired } = fields;
  const unchanged =
    existing !== null && Object.entries(desired).every(([key, value]) => JSON.stringify(existing[key]) === JSON.stringify(value));
  if (unchanged) return { outcome: "unchanged", redirectUris };
  if (existing) {
    await adapter.update({ model: "oauthClient", where, update: fields });
    return { outcome: "updated", redirectUris };
  }
  await adapter.create({ model: "oauthClient", data: { clientId: alb.ALB_CLIENT_ID, clientDiscoveryId: null, createdAt: now, ...fields } });
  return { outcome: "created", redirectUris };
}
```

- [ ] **Step 4: CLI を縮める**

`src/scripts/migrate.ts` を丸ごと置き換える:

```ts
import { createAuthOptions } from "../auth.js";
import { loadConfig } from "../config.js";
import { createPool } from "../db.js";
import { runMigrate } from "../operations.js";

// 開発の CLI（pnpm db:migrate・compose の migrate サービス）。本番は運用の Lambda（ops.ts）の {"action":"migrate"}。
// Better Auth のスキーマと許可リストの表を作り、許可リストの初期値（ADMIN_BOOTSTRAP_EMAILS）を追加する。何度実行しても安全
const config = loadConfig();
const pool = createPool(config);

try {
  await runMigrate(pool, createAuthOptions(config, pool), config.ADMIN_BOOTSTRAP_EMAILS);
  console.error("[migrate] done");
} catch (error) {
  console.error(`[migrate] failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
```

`src/scripts/register-alb-client.ts` の `try { … }` の中身（`const { adapter } = …` から 3 行の `console.error` まで）を次に置き換え、`createHash` と `OIDC_SCOPES` の import と `type AuthMethod` の定義を消し、`import { type AuthMethod, registerAlbClient } from "../operations.js";` を足す（`parseArgs` と冒頭のコメントは残す。コメントの「本番は」の段を `// 本番は運用の Lambda（ops.ts）の {"action":"register-alb-client","authMethod":…,"requirePkce":…}。` に替える）:

```ts
  const { outcome } = await registerAlbClient(createAuth(config, pool), alb, { authMethod, requirePkce });
  console.error(`[alb] ${outcome} client ${alb.ALB_CLIENT_ID}`);
  console.error(`[alb] token_endpoint_auth_method=${authMethod} require_pkce=${requirePkce} skip_consent=true`);
  for (const host of alb.ALB_PROTECTED_HOSTS) console.error(`[alb] redirect_uri https://${host}/oauth2/idpresponse`);
```

- [ ] **Step 5: 通ることを確かめる**

Run: `cd backend/admin-auth && pnpm exec vitest run && pnpm typecheck`
Expected: すべて PASS（`tests/scripts/register-alb-client.test.ts` は手を入れずに通る。出力の文面を変えていないため）

- [ ] **Step 6: 差分を確かめる（コミットはしない）**

Run: `git status --short backend/admin-auth`

---

### Task 5: 本番の入口 `lambda.ts`

**Files:**
- Create: `backend/admin-auth/src/lambda.ts`
- Test: `backend/admin-auth/tests/lambda.test.ts`

**Interfaces:**
- Consumes: `parseConfig`・`Config`（Task 1）、`createPool`・`secretReader`・定数（Task 1）、`createHandler`・`Handle`（Task 2）、`createAuth`（`src/auth.ts`）
- Produces:

```ts
export interface AlbEvent {
  readonly httpMethod?: string;
  readonly path?: string;
  readonly multiValueHeaders?: Readonly<Record<string, readonly string[] | undefined>> | null;
  readonly multiValueQueryStringParameters?: Readonly<Record<string, readonly string[] | undefined>> | null;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
}
export interface AlbResult { statusCode: number; statusDescription: string; multiValueHeaders: Record<string, string[]>; body: string; isBase64Encoded: boolean }
export interface Runtime { readonly origin: string; readonly handle: Handle; close(): Promise<void> }
export function toRequest(event: AlbEvent, fallbackOrigin: string): Request;
export async function toResult(res: Response): Promise<AlbResult>;
export async function loadBaseConfig(env: NodeJS.ProcessEnv, readSecret: (name: string) => Promise<string>): Promise<Config>;
export function buildRuntime(config: Config, makePool?: typeof createPool): Runtime;
export function createLambdaHandler<B>(deps: { load: () => Promise<B>; build: (base: B) => Runtime; now?: () => number; idleMs?: number }): (event: AlbEvent) => Promise<AlbResult>;
export const handler: (event: AlbEvent) => Promise<AlbResult>;
```

- [ ] **Step 1: 失敗するテストを書く（`tests/lambda.test.ts`）**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AlbEvent, buildRuntime, createLambdaHandler, loadBaseConfig, type Runtime, toRequest, toResult } from "../src/lambda.js";
import { captureStderr, DB_PASSWORD, SECRET, validEnv } from "./helpers/env.js";

const ORIGIN = "https://auth.comegin.com";

const event = (overrides: Partial<AlbEvent> = {}): AlbEvent => ({
  httpMethod: "GET",
  path: "/api/auth/jwks",
  multiValueHeaders: { host: ["auth.comegin.com"] },
  multiValueQueryStringParameters: {},
  body: "",
  isBase64Encoded: false,
  ...overrides,
});

/** handle を差し替えた Runtime。close の呼び出しを数える */
const runtime = (handle: Runtime["handle"]): Runtime & { close: ReturnType<typeof vi.fn> } => ({
  origin: ORIGIN,
  handle,
  close: vi.fn(async () => {}),
});

beforeEach(() => {
  captureStderr();
});

describe("toRequest", () => {
  describe("正常系", () => {
    it("ヘッダーの複数の値をすべて渡し、host から https の URL を組み立てる", () => {
      const req = toRequest(event({ multiValueHeaders: { host: ["auth.comegin.com"], accept: ["text/html"], "x-forwarded-for": ["1.1.1.1", "2.2.2.2"] } }), ORIGIN);
      expect(req.url).toBe("https://auth.comegin.com/api/auth/jwks");
      expect(req.headers.get("accept")).toBe("text/html");
      expect(req.headers.get("x-forwarded-for")).toBe("1.1.1.1, 2.2.2.2");
    });

    it("クエリは ALB がデコードしていないので、再エンコードせずにそのまま戻す（同じキーの複数の値も保つ）", () => {
      const req = toRequest(
        event({
          path: "/api/auth/oauth2/authorize",
          multiValueQueryStringParameters: { redirect_uri: ["https%3A%2F%2Fchat.comegin.com%2Foauth2%2Fidpresponse"], scope: ["openid%20email"], a: ["1", "2"] },
        }),
        ORIGIN,
      );
      expect(req.url).toBe(
        "https://auth.comegin.com/api/auth/oauth2/authorize?redirect_uri=https%3A%2F%2Fchat.comegin.com%2Foauth2%2Fidpresponse&scope=openid%20email&a=1&a=2",
      );
      expect(new URL(req.url).searchParams.get("redirect_uri")).toBe("https://chat.comegin.com/oauth2/idpresponse");
    });

    it("base64 の本文（フォーム形式のトークンの要求）を復号して渡す", async () => {
      const body = "grant_type=authorization_code&code=abc";
      const req = toRequest(
        event({ httpMethod: "POST", path: "/api/auth/oauth2/token", body: Buffer.from(body).toString("base64"), isBase64Encoded: true }),
        ORIGIN,
      );
      expect(await req.text()).toBe(body);
    });

    it("空入力: ヘッダー・クエリ・本文・メソッド・パスが無ければ、BETTER_AUTH_URL のホストで GET / を作る", async () => {
      const req = toRequest({ multiValueHeaders: null, multiValueQueryStringParameters: null, body: null }, ORIGIN);
      expect(req.method).toBe("GET");
      expect(req.url).toBe("https://auth.comegin.com/");
      expect(req.body).toBeNull();
    });
  });

  describe("異常系", () => {
    it("入力: GET に本文が付いたイベントでも、本文は付けない", () => {
      expect(toRequest(event({ body: "x=1" }), ORIGIN).body).toBeNull();
    });

    it("入力: HEAD にも本文を付けない", () => {
      expect(toRequest(event({ httpMethod: "HEAD", body: "x=1" }), ORIGIN).body).toBeNull();
    });
  });
});

describe("toResult", () => {
  describe("正常系", () => {
    it("Set-Cookie を 1 つずつ配列で返し、ほかのヘッダーも配列にする", async () => {
      const headers = new Headers({ location: "https://chat.comegin.com/oauth2/idpresponse?code=x" });
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      const result = await toResult(new Response(null, { status: 302, headers }));
      expect(result.statusCode).toBe(302);
      expect(result.statusDescription).toBe("302 Found");
      expect(result.multiValueHeaders["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
      expect(result.multiValueHeaders.location).toEqual(["https://chat.comegin.com/oauth2/idpresponse?code=x"]);
    });

    it("JSON・HTML・JavaScript の本文はそのまま、isBase64Encoded は false", async () => {
      for (const type of ["application/json", "text/html; charset=utf-8", "application/javascript", "application/jwk-set+json"]) {
        const result = await toResult(new Response('{"k":"日本"}', { headers: { "content-type": type } }));
        expect(result).toMatchObject({ body: '{"k":"日本"}', isBase64Encoded: false });
      }
    });

    it("空入力: 本文の無い応答は空文字で、isBase64Encoded は false", async () => {
      expect(await toResult(new Response(null, { status: 204 }))).toMatchObject({ body: "", isBase64Encoded: false, statusDescription: "204 No Content" });
    });
  });

  describe("異常系", () => {
    it("入力: 型の無い本文と画像は base64 にする", async () => {
      const bytes = new Uint8Array([0xff, 0x00, 0x10]);
      const result = await toResult(new Response(bytes, { headers: { "content-type": "image/png" } }));
      expect(result).toMatchObject({ body: Buffer.from(bytes).toString("base64"), isBase64Encoded: true });
      const untyped = new Response(bytes);
      untyped.headers.delete("content-type");
      expect((await toResult(untyped)).isBase64Encoded).toBe(true);
    });
  });
});

describe("loadBaseConfig", () => {
  describe("正常系", () => {
    it("秘密値を 3 つ読み、設定に入れて返す。ALB_CLIENT_SECRET は読まない", async () => {
      const readSecret = vi.fn(async (name: string) => `${name}-value-0123456789abcdefghijklmnop`);
      const env = { ...validEnv({ NODE_ENV: "production", GOOGLE_CLIENT_ID: "gid" }), BETTER_AUTH_SECRET: undefined, DATABASE_PASSWORD: undefined };
      const config = await loadBaseConfig(env, readSecret);
      expect(readSecret.mock.calls.map((c) => c[0]).sort()).toEqual(["BETTER_AUTH_SECRET", "DB_PASSWORD", "GOOGLE_CLIENT_SECRET"]);
      expect(config.DATABASE_PASSWORD).toBe("DB_PASSWORD-value-0123456789abcdefghijklmnop");
      expect(config.GOOGLE_CLIENT_SECRET).toBe("GOOGLE_CLIENT_SECRET-value-0123456789abcdefghijklmnop");
    });
  });

  describe("異常系", () => {
    it("サーバ: 秘密値を読めなければ失敗する", async () => {
      await expect(loadBaseConfig(validEnv(), async () => Promise.reject(new Error("AccessDeniedException")))).rejects.toThrow("AccessDeniedException");
    });

    it("入力: 設定が不正なら、プロセスを終了させずに例外にし、値を出さない", async () => {
      const exit = vi.spyOn(process, "exit");
      const error = await loadBaseConfig(validEnv({ DATABASE_HOST: "" }), async () => DB_PASSWORD).catch((e: Error) => e);
      expect((error as Error).message).toContain("DATABASE_HOST");
      expect((error as Error).message).not.toContain(DB_PASSWORD);
      expect(exit).not.toHaveBeenCalled();
    });

    it("空入力: 秘密値が空文字なら、設定の検証で失敗する", async () => {
      await expect(loadBaseConfig(validEnv(), async () => "")).rejects.toThrow("BETTER_AUTH_SECRET");
    });
  });
});

describe("buildRuntime", () => {
  describe("正常系", () => {
    it("Lambda 用のプール（max 2・query_timeout 5 秒）で auth と handle を作り、close でプールを閉じる", async () => {
      const end = vi.fn(async () => {});
      // connect も持たせる（Better Auth は pg の Pool を connect の有無で見分ける。無いとアダプターの判別に失敗して未処理の reject になりうる）
      const makePool = vi.fn(() => ({ end, on: vi.fn(), query: vi.fn(), connect: vi.fn() }) as never);
      const config = (await import("../src/config.js")).parseConfig(validEnv());
      const built = buildRuntime(config, makePool);
      expect(makePool).toHaveBeenCalledWith(config, { max: 2, queryTimeoutMs: 5_000 });
      expect(built.origin).toBe("http://localhost:3103");
      const res = await built.handle(new Request("http://localhost:3103/healthz"));
      expect(res.status).toBe(200);
      await built.close();
      expect(end).toHaveBeenCalledTimes(1);
    });
  });
});

describe("createLambdaHandler", () => {
  const okHandle = async () => new Response("ok", { headers: { "content-type": "text/plain" } });

  describe("正常系", () => {
    it("ALB のイベントを handle に渡し、結果を ALB の形で返す", async () => {
      const handler = createLambdaHandler({ load: async () => "BASE", build: () => runtime(okHandle) });
      await expect(handler(event())).resolves.toMatchObject({ statusCode: 200, body: "ok", isBase64Encoded: false });
    });

    it("秘密値と設定の読み込みは 1 回だけ。アイドルが 60 秒未満なら作り直さない", async () => {
      let clock = 1_000_000;
      const load = vi.fn(async () => "BASE");
      const build = vi.fn(() => runtime(okHandle));
      const handler = createLambdaHandler({ load, build, now: () => clock });
      await handler(event());
      clock += 59_999;
      await handler(event());
      expect(load).toHaveBeenCalledTimes(1);
      expect(build).toHaveBeenCalledTimes(1);
    });

    it("60 秒以上空いたら、処理の前にプールと auth を作り直し、古い方を閉じる。秘密値は読み直さない", async () => {
      let clock = 1_000_000;
      const load = vi.fn(async () => "BASE");
      const first = runtime(okHandle);
      const second = runtime(okHandle);
      const build = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
      const handler = createLambdaHandler({ load, build, now: () => clock });
      await handler(event());
      clock += 60_000;
      await handler(event());
      expect(build).toHaveBeenCalledTimes(2);
      expect(first.close).toHaveBeenCalledTimes(1);
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("空入力: 項目の無いイベントでも、BETTER_AUTH_URL のホストで処理する", async () => {
      let received: Request | undefined;
      const handler = createLambdaHandler({
        load: async () => "BASE",
        build: () =>
          runtime(async (req) => {
            received = req;
            return new Response("ok");
          }),
      });
      await handler({});
      expect(received!.url).toBe("https://auth.comegin.com/");
    });
  });

  describe("異常系", () => {
    it("サーバ: 読み込みに失敗したら例外を投げ（Errors に数え、ALB は 502）、次の呼び出しでやり直す", async () => {
      const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("AccessDeniedException")).mockResolvedValue("BASE");
      const handler = createLambdaHandler({ load, build: () => runtime(okHandle) });
      await expect(handler(event())).rejects.toThrow("AccessDeniedException");
      await expect(handler(event())).resolves.toMatchObject({ statusCode: 200 });
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("サーバ: 古いプールを閉じるのに失敗しても、処理を続ける", async () => {
      let clock = 0;
      const first = runtime(okHandle);
      first.close.mockRejectedValue(new Error("Connection terminated"));
      const build = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(runtime(okHandle));
      const handler = createLambdaHandler({ load: async () => "BASE", build, now: () => clock });
      await handler(event());
      clock += 60_000;
      await expect(handler(event())).resolves.toMatchObject({ statusCode: 200 });
    });

    it("入力: URL を組み立てられないイベント（不正な host）は、handle を呼ばずに 400 を返す（Errors にしない）", async () => {
      const handle = vi.fn(okHandle);
      const handler = createLambdaHandler({ load: async () => "BASE", build: () => runtime(handle) });
      const result = await handler(event({ multiValueHeaders: { host: ["bad host[]"] } }));
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe("bad request");
      expect(handle).not.toHaveBeenCalled();
    });

    it("サーバ: 失敗のログに秘密値を出さない", async () => {
      const stderr = captureStderr();
      const handler = createLambdaHandler({ load: async () => Promise.reject(new Error("load failed")), build: () => runtime(okHandle) });
      await handler(event()).catch(() => {});
      expect(stderr.text()).not.toContain(SECRET);
      expect(stderr.text()).not.toContain(DB_PASSWORD);
    });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `cd backend/admin-auth && pnpm exec vitest run tests/lambda.test.ts`
Expected: FAIL（`../src/lambda.js` が無い）

- [ ] **Step 3: `src/lambda.ts` を書く**

```ts
import { STATUS_CODES } from "node:http";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createAuth } from "./auth.js";
import { type Config, parseConfig } from "./config.js";
import { DB_QUERY_TIMEOUT_MS, LAMBDA_DB_POOL_MAX, LAMBDA_IDLE_RECYCLE_MS } from "./constants.js";
import { createPool } from "./db.js";
import { createHandler, type Handle } from "./handler.js";
import { secretReader } from "./secrets.js";

// 本番の入口（ALB のターゲット。マルチバリューヘッダーは有効。仕様 2.1・3.2）。
// SAM の Handler は index.handler（bundle が dist-lambda/index.mjs を作る）
export interface AlbEvent {
  readonly httpMethod?: string;
  readonly path?: string;
  readonly multiValueHeaders?: Readonly<Record<string, readonly string[] | undefined>> | null;
  readonly multiValueQueryStringParameters?: Readonly<Record<string, readonly string[] | undefined>> | null;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
}

export interface AlbResult {
  statusCode: number;
  statusDescription: string;
  multiValueHeaders: Record<string, string[]>;
  body: string;
  isBase64Encoded: boolean;
}

export interface Runtime {
  /** host ヘッダーが無いときに使う（BETTER_AUTH_URL） */
  readonly origin: string;
  readonly handle: Handle;
  close(): Promise<void>;
}

/** ALB のイベント → Request。クエリは ALB がデコードしていないので、そのまま戻す。GET・HEAD には本文を付けない */
export function toRequest(event: AlbEvent, fallbackOrigin: string): Request {
  const headers = new Headers();
  for (const [name, values] of Object.entries(event.multiValueHeaders ?? {})) {
    for (const value of values ?? []) headers.append(name, value);
  }
  const host = headers.get("host") ?? new URL(fallbackOrigin).host;
  const query = Object.entries(event.multiValueQueryStringParameters ?? {})
    .flatMap(([key, values]) => (values ?? []).map((value) => `${key}=${value}`))
    .join("&");
  const method = event.httpMethod ?? "GET";
  const withBody = method !== "GET" && method !== "HEAD" && !!event.body;
  return new Request(`https://${host}${event.path ?? "/"}${query ? `?${query}` : ""}`, {
    method,
    headers,
    body: withBody ? Buffer.from(event.body!, event.isBase64Encoded ? "base64" : "utf8") : undefined,
  });
}

const TEXT_TYPE = /^(text\/|application\/(json|javascript|xml)\b|application\/[\w.+-]+\+(json|xml)\b)/i;

/** Response → ALB の応答。Set-Cookie は 1 つずつ配列にする（Headers の反復はつなげてしまう） */
export async function toResult(res: Response): Promise<AlbResult> {
  const multiValueHeaders: Record<string, string[]> = {};
  res.headers.forEach((value, name) => {
    if (name !== "set-cookie") multiValueHeaders[name] = [value];
  });
  const cookies = res.headers.getSetCookie();
  if (cookies.length > 0) multiValueHeaders["set-cookie"] = cookies;
  const bytes = Buffer.from(await res.arrayBuffer());
  const isText = bytes.length === 0 || TEXT_TYPE.test(res.headers.get("content-type") ?? "");
  const reason = STATUS_CODES[res.status];
  return {
    statusCode: res.status,
    statusDescription: reason ? `${res.status} ${reason}` : String(res.status),
    multiValueHeaders,
    body: isText ? bytes.toString("utf8") : bytes.toString("base64"),
    isBase64Encoded: !isText,
  };
}

/** 秘密値を 3 つ読み、設定を検証する（不正なら例外。process.exit は使わない）。ALB_CLIENT_SECRET は読まない（仕様 3.6） */
export async function loadBaseConfig(env: NodeJS.ProcessEnv, readSecret: (name: string) => Promise<string>): Promise<Config> {
  const [betterAuthSecret, dbPassword, googleSecret] = await Promise.all([
    readSecret("BETTER_AUTH_SECRET"),
    readSecret("DB_PASSWORD"),
    readSecret("GOOGLE_CLIENT_SECRET"),
  ]);
  return parseConfig({ ...env, BETTER_AUTH_SECRET: betterAuthSecret, DATABASE_PASSWORD: dbPassword, GOOGLE_CLIENT_SECRET: googleSecret });
}

/** プール（Lambda 用の大きさと問い合わせのタイムアウト）・auth・handler を組み立てる（仕様 3.4） */
export function buildRuntime(config: Config, makePool: typeof createPool = createPool): Runtime {
  const pool = makePool(config, { max: LAMBDA_DB_POOL_MAX, queryTimeoutMs: DB_QUERY_TIMEOUT_MS });
  return { origin: config.BETTER_AUTH_URL, handle: createHandler({ auth: createAuth(config, pool) }), close: () => pool.end() };
}

/**
 * 秘密値と設定の読み込み（load）は最初の呼び出しで 1 回だけ（失敗したら次でやり直す。例外は Errors に数え、ALB は 502）。
 * 前の呼び出しの終わりから idleMs 以上空いたら、処理の前に Runtime（プール・auth）を作り直す。凍結のあいだに
 * 通り道が接続を黙って捨てても、古い接続で問い合わせが固まらないようにするため（仕様 3.4）
 */
export function createLambdaHandler<B>(deps: {
  load: () => Promise<B>;
  build: (base: B) => Runtime;
  now?: () => number;
  idleMs?: number;
}): (event: AlbEvent) => Promise<AlbResult> {
  const now = deps.now ?? (() => Date.now());
  const idleMs = deps.idleMs ?? LAMBDA_IDLE_RECYCLE_MS;
  let base: Promise<B> | null = null;
  let runtime: Runtime | null = null;
  let lastDoneAt = 0;
  return async (event) => {
    base ??= deps.load().catch((error: unknown) => {
      base = null;
      throw error;
    });
    const loaded = await base;
    if (runtime && now() - lastDoneAt >= idleMs) {
      const old = runtime;
      runtime = null;
      void old.close().catch(() => {});
    }
    runtime ??= deps.build(loaded);
    try {
      let request: Request;
      try {
        request = toRequest(event, runtime.origin);
      } catch {
        return await toResult(new Response("bad request", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } }));
      }
      return await toResult(await runtime.handle(request));
    } finally {
      lastDoneAt = now();
    }
  };
}

export const handler = createLambdaHandler({
  load: () => loadBaseConfig(process.env, secretReader(new SecretsManagerClient({}), process.env.SECRETS_PREFIX ?? "")),
  build: (config: Config) => buildRuntime(config),
});
```

- [ ] **Step 4: 通ることを確かめる**

Run: `cd backend/admin-auth && pnpm exec vitest run && pnpm typecheck`
Expected: すべて PASS

- [ ] **Step 5: 差分を確かめる（コミットはしない）**

Run: `git status --short backend/admin-auth`

---

### Task 6: 運用の入口 `ops.ts`

**Files:**
- Create: `backend/admin-auth/src/ops.ts`
- Test: `backend/admin-auth/tests/ops.test.ts`

**Interfaces:**
- Consumes: `parseConfig`・`parseAlbConfig`・`createPool`・`secretReader`（Task 1）、`runMigrate`・`registerAlbClient`（Task 4）、`createAuth`・`createAuthOptions`
- Produces:

```ts
export interface OpsContext { config: Config; alb: AlbConfig }
export type OpsResult = { ok: true; action: "migrate" | "register-alb-client"; result: unknown } | { ok: false; error: string };
export async function loadOpsContext(env: NodeJS.ProcessEnv, readSecret: (name: string) => Promise<string>): Promise<OpsContext>;
export function createOpsHandler(load: () => Promise<OpsContext>, makePool?: typeof createPool): (event: unknown) => Promise<OpsResult>;
export const handler: (event: unknown) => Promise<OpsResult>;
```

- 不正な入力は秘密値を読む前に `{ ok: false, error }`（値は入れない）。呼び出しごとにプールを作り、終わったら閉じる（運用はまれなので使い回さない。問い合わせのタイムアウトも付けない）。

- [ ] **Step 1: 失敗するテストを書く（`tests/ops.test.ts`）**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOpsHandler, loadOpsContext, type OpsContext } from "../src/ops.js";
import { captureStderr, validEnv } from "./helpers/env.js";

const mocks = vi.hoisted(() => ({ runMigrate: vi.fn(), registerAlbClient: vi.fn(), createAuth: vi.fn(() => ({ auth: true })), createAuthOptions: vi.fn(() => ({ options: true })) }));
vi.mock("../src/operations.js", () => ({ runMigrate: mocks.runMigrate, registerAlbClient: mocks.registerAlbClient }));
vi.mock("../src/auth.js", () => ({ createAuth: mocks.createAuth, createAuthOptions: mocks.createAuthOptions }));

const ALB_SECRET = "alb-secret-0123456789abcdefghijklmnopq";
const ALB_ENV = { ALB_CLIENT_ID: "alb-admin-gate", ALB_PROTECTED_HOSTS: "chat.comegin.com", ADMIN_BOOTSTRAP_EMAILS: "a@comegin.com" };

let end: ReturnType<typeof vi.fn>;
let makePool: ReturnType<typeof vi.fn>;
let context: OpsContext;

beforeEach(async () => {
  captureStderr();
  end = vi.fn(async () => {});
  makePool = vi.fn(() => ({ end }) as never);
  context = await loadOpsContext({ ...validEnv(), ...ALB_ENV }, async (name) => (name === "ALB_CLIENT_SECRET" ? ALB_SECRET : `${name}-value-0123456789abcdefghijklmnop`));
  mocks.runMigrate.mockReset().mockResolvedValue({ createdTables: [], addedColumnsTables: [], bootstrapped: 1 });
  mocks.registerAlbClient.mockReset().mockResolvedValue({ outcome: "created", redirectUris: ["https://chat.comegin.com/oauth2/idpresponse"] });
});

describe("loadOpsContext", () => {
  describe("正常系", () => {
    it("秘密値を 3 つ読み（Google は読まない）、Google の設定を求めずに検証する", async () => {
      const readSecret = vi.fn(async (name: string) => (name === "ALB_CLIENT_SECRET" ? ALB_SECRET : `${name}-value-0123456789abcdefghijklmnop`));
      const ctx = await loadOpsContext({ ...validEnv({ NODE_ENV: "production" }), ...ALB_ENV }, readSecret);
      expect(readSecret.mock.calls.map((c) => c[0]).sort()).toEqual(["ALB_CLIENT_SECRET", "BETTER_AUTH_SECRET", "DB_PASSWORD"]);
      expect(ctx.alb.ALB_CLIENT_SECRET).toBe(ALB_SECRET);
      expect(ctx.config.ADMIN_BOOTSTRAP_EMAILS).toEqual(["a@comegin.com"]);
    });
  });

  describe("異常系", () => {
    it("入力: ALB の設定が足りなければ例外にし、終了しない", async () => {
      const exit = vi.spyOn(process, "exit");
      await expect(loadOpsContext(validEnv(), async () => ALB_SECRET)).rejects.toThrow("ALB_CLIENT_ID");
      expect(exit).not.toHaveBeenCalled();
    });
  });
});

describe("createOpsHandler", () => {
  describe("正常系", () => {
    it("migrate: 移行を実行し、結果を返して、プールを閉じる", async () => {
      const handler = createOpsHandler(async () => context, makePool);
      const result = await handler({ action: "migrate" });
      expect(result).toEqual({ ok: true, action: "migrate", result: { createdTables: [], addedColumnsTables: [], bootstrapped: 1 } });
      expect(mocks.runMigrate).toHaveBeenCalledWith(expect.anything(), { options: true }, ["a@comegin.com"]);
      expect(end).toHaveBeenCalledTimes(1);
    });

    it("register-alb-client: 既定は client_secret_basic・PKCE なし", async () => {
      const handler = createOpsHandler(async () => context, makePool);
      const result = await handler({ action: "register-alb-client" });
      expect(result).toMatchObject({ ok: true, action: "register-alb-client" });
      expect(mocks.registerAlbClient).toHaveBeenCalledWith({ auth: true }, context.alb, { authMethod: "client_secret_basic", requirePkce: false });
      expect(end).toHaveBeenCalledTimes(1);
    });

    it("register-alb-client: 認証方式と PKCE を指定できる", async () => {
      const handler = createOpsHandler(async () => context, makePool);
      await handler({ action: "register-alb-client", authMethod: "client_secret_post", requirePkce: true });
      expect(mocks.registerAlbClient.mock.calls[0]?.[2]).toEqual({ authMethod: "client_secret_post", requirePkce: true });
    });
  });

  describe("異常系", () => {
    it.each([
      ["知らない action", { action: "drop" }],
      ["余計な項目", { action: "migrate", extra: 1 }],
      ["不正な認証方式", { action: "register-alb-client", authMethod: "none" }],
      ["真偽値でない PKCE", { action: "register-alb-client", requirePkce: "yes" }],
    ])("入力: %s は、秘密値を読まずに ok: false を返す", async (_label, input) => {
      const load = vi.fn(async () => context);
      const result = await createOpsHandler(load, makePool)(input);
      expect(result.ok).toBe(false);
      expect(load).not.toHaveBeenCalled();
      expect(makePool).not.toHaveBeenCalled();
    });

    it("空入力: イベントが空・null でも ok: false を返す", async () => {
      const handler = createOpsHandler(async () => context, makePool);
      expect((await handler({})).ok).toBe(false);
      expect((await handler(null)).ok).toBe(false);
    });

    it("サーバ: 実行に失敗したら投げ（呼び出し元に FunctionError として見える）、プールは閉じる", async () => {
      mocks.runMigrate.mockRejectedValue(new Error("permission denied"));
      const handler = createOpsHandler(async () => context, makePool);
      await expect(handler({ action: "migrate" })).rejects.toThrow("permission denied");
      expect(end).toHaveBeenCalledTimes(1);
    });

    it("サーバ: 読み込みに失敗したら投げ、次の呼び出しでやり直す", async () => {
      const load = vi.fn<() => Promise<OpsContext>>().mockRejectedValueOnce(new Error("AccessDeniedException")).mockResolvedValue(context);
      const handler = createOpsHandler(load, makePool);
      await expect(handler({ action: "migrate" })).rejects.toThrow("AccessDeniedException");
      await expect(handler({ action: "migrate" })).resolves.toMatchObject({ ok: true });
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("入力: ok: false のエラーに入力の値を入れない", async () => {
      const result = await createOpsHandler(async () => context, makePool)({ action: "secret-value-xyz" });
      expect(JSON.stringify(result)).not.toContain("secret-value-xyz");
    });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `cd backend/admin-auth && pnpm exec vitest run tests/ops.test.ts`
Expected: FAIL（`../src/ops.js` が無い）

- [ ] **Step 3: `src/ops.ts` を書く**

```ts
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import * as z from "zod/v4";
import { createAuth, createAuthOptions } from "./auth.js";
import { type AlbConfig, type Config, parseAlbConfig, parseConfig } from "./config.js";
import { createPool } from "./db.js";
import { registerAlbClient, runMigrate } from "./operations.js";
import { secretReader } from "./secrets.js";

// 運用の入口（admin-auth-ops。ALB にはつながない。運用者が aws lambda invoke で呼ぶ。仕様 2.3）。
// SAM の Handler は ops.handler（bundle が dist-lambda/ops.mjs を作る）
const EventSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("migrate") }),
  z.strictObject({
    action: z.literal("register-alb-client"),
    authMethod: z.enum(["client_secret_basic", "client_secret_post"]).default("client_secret_basic"),
    requirePkce: z.boolean().default(false),
  }),
]);

export interface OpsContext {
  config: Config;
  alb: AlbConfig;
}

export type OpsResult = { ok: true; action: "migrate" | "register-alb-client"; result: unknown } | { ok: false; error: string };

/** 秘密値を 3 つ読む（Google は読まない）。Google の設定は求めない（移行と登録に要らない。仕様 3.6） */
export async function loadOpsContext(env: NodeJS.ProcessEnv, readSecret: (name: string) => Promise<string>): Promise<OpsContext> {
  const [betterAuthSecret, dbPassword, albSecret] = await Promise.all([
    readSecret("BETTER_AUTH_SECRET"),
    readSecret("DB_PASSWORD"),
    readSecret("ALB_CLIENT_SECRET"),
  ]);
  const merged = { ...env, BETTER_AUTH_SECRET: betterAuthSecret, DATABASE_PASSWORD: dbPassword, ALB_CLIENT_SECRET: albSecret };
  return { config: parseConfig(merged, { requireGoogle: false }), alb: parseAlbConfig(merged) };
}

/**
 * 不正な入力は秘密値を読む前に { ok: false } を返す（値は入れない）。実行の失敗は例外（呼び出し元に FunctionError として見える）。
 * プールは呼び出しごとに作って閉じる（運用はまれなので使い回さない。移行は長くかかりうるので問い合わせのタイムアウトも付けない）
 */
export function createOpsHandler(load: () => Promise<OpsContext>, makePool: typeof createPool = createPool): (event: unknown) => Promise<OpsResult> {
  let ready: Promise<OpsContext> | null = null;
  return async (event) => {
    const parsed = EventSchema.safeParse(event);
    if (!parsed.success) {
      return { ok: false, error: `invalid event: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.code}`).join(", ")}` };
    }
    ready ??= load().catch((error: unknown) => {
      ready = null;
      throw error;
    });
    const { config, alb } = await ready;
    const pool = makePool(config);
    try {
      if (parsed.data.action === "migrate") {
        const result = await runMigrate(pool, createAuthOptions(config, pool), config.ADMIN_BOOTSTRAP_EMAILS);
        console.error("[migrate] done");
        return { ok: true, action: "migrate", result };
      }
      const { authMethod, requirePkce } = parsed.data;
      const result = await registerAlbClient(createAuth(config, pool), alb, { authMethod, requirePkce });
      console.error(`[alb] ${result.outcome} client ${alb.ALB_CLIENT_ID}`);
      return { ok: true, action: "register-alb-client", result };
    } finally {
      await pool.end();
    }
  };
}

export const handler = createOpsHandler(() =>
  loadOpsContext(process.env, secretReader(new SecretsManagerClient({}), process.env.SECRETS_PREFIX ?? "")),
);
```

- [ ] **Step 4: 通ることを確かめる**

Run: `cd backend/admin-auth && pnpm exec vitest run && pnpm typecheck`
Expected: すべて PASS

- [ ] **Step 5: 差分を確かめる（コミットはしない）**

Run: `git status --short backend/admin-auth`

---

### Task 7: ビルドの設定（bundle・Makefile・Dockerfile）

**Files:**
- Modify: `backend/admin-auth/package.json`（scripts・description）
- Create: `backend/admin-auth/Makefile`
- Modify: `backend/admin-auth/.gitignore`・`.dockerignore`・`Dockerfile`
- Test: `backend/admin-auth/tests/bundle-config.test.ts`

- [ ] **Step 1: 失敗するテストを書く（`tests/bundle-config.test.ts`）**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 本番の bundle（esbuild の ESM 出力 2 つ）の設定の検査。bundle そのものは sam build のときに作る（このテストでは作らない）。
// pg などは CommonJS で require を呼ぶ。ESM の出力には require が無いため、banner で createRequire から用意しないと
// 読み込みの時点で「Dynamic require of … is not supported」になる（② の最終レビューで判明）
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
const makefile = readFileSync(new URL("../Makefile", import.meta.url), "utf8");
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

/** Makefile のターゲットの行（タブの後ろ）を返す */
function recipe(target: string): string[] {
  const lines = makefile.split("\n");
  const start = lines.indexOf(`${target}:`);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("\t")) break;
    body.push(line.trim());
  }
  return body;
}

describe("bundle の設定", () => {
  describe("正常系", () => {
    it("本体（index）と運用（ops）の 2 つを ESM で出し、先頭で createRequire から require を用意する", () => {
      const bundle = pkg.scripts.bundle!;
      expect(bundle).toContain("index=src/lambda.ts");
      expect(bundle).toContain("ops=src/ops.ts");
      expect(bundle).toContain("--format=esm");
      expect(bundle).toContain("--out-extension:.js=.mjs");
      expect(bundle).toMatch(/--banner:js=.*createRequire.*const require = createRequire\(import\.meta\.url\)/);
    });

    it.each([
      ["build-AdminAuthFunction", "index"],
      ["build-AdminAuthOpsFunction", "ops"],
    ])("Makefile の %s は bundle → 読み込みの確認 → %s.mjs を写す、の順", (target, name) => {
      const lines = recipe(target);
      const bundleAt = lines.indexOf("pnpm run bundle");
      const checkAt = lines.findIndex((line) => line.includes("import(") && line.includes(`dist-lambda/${name}.mjs`));
      const copyAt = lines.findIndex((line) => line.startsWith(`cp dist-lambda/${name}.mjs dist-lambda/${name}.mjs.map`));
      expect(bundleAt).toBeGreaterThanOrEqual(0);
      expect(checkAt).toBeGreaterThan(bundleAt);
      expect(copyAt).toBeGreaterThan(checkAt);
    });
  });

  describe("異常系", () => {
    it("入力: @aws-sdk は bundle に含めない（Lambda の実行環境にある）", () => {
      expect(pkg.scripts.bundle).toContain("--external:@aws-sdk/*");
    });

    it("入力: 開発の Dockerfile に本番専用の RDS の CA の取得を残さない（本番は Lambda の /var/runtime/ca-cert.pem）", () => {
      expect(dockerfile).not.toContain("rds-global-bundle");
      expect(dockerfile).not.toContain("NODE_EXTRA_CA_CERTS");
    });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `cd backend/admin-auth && pnpm exec vitest run tests/bundle-config.test.ts`
Expected: FAIL（`Makefile` が無い）

- [ ] **Step 3: 実装する（`.env` という文字列をコマンドに含めないよう、scratchpad のスクリプトで package.json を書き換える）**

scratchpad に `admin-auth-build.cjs` を書き、`cd backend/admin-auth && node <scratchpad>/admin-auth-build.cjs` で実行する:

```js
// admin-auth の package.json の scripts・Makefile・ignore（cwd は backend/admin-auth）
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.description = "Better Auth as an OIDC provider for the ALB authenticate-oidc gate (Google Workspace login, admin allowlist. AWS Lambda behind the ALB in production)";
pkg.scripts = {
  build: "tsc",
  bundle:
    "esbuild index=src/lambda.ts ops=src/ops.ts --bundle --platform=node --target=node22 --format=esm --sourcemap --outdir=dist-lambda --out-extension:.js=.mjs --external:@aws-sdk/* --banner:js=\"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);\"",
  start: pkg.scripts.start,
  dev: pkg.scripts.dev,
  typecheck: "tsc --noEmit",
  test: "vitest run",
  "test:watch": "vitest",
  "test:integration": "vitest run --config vitest.integration.config.ts",
  "db:migrate": pkg.scripts["db:migrate"],
  "alb:register": pkg.scripts["alb:register"],
  clean: "rm -rf dist dist-lambda",
};
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
const target = (name, file) => [
  `${name}:`,
  "\tpnpm install --frozen-lockfile",
  "\tpnpm run bundle",
  `\tnode --input-type=module -e "await import('./dist-lambda/${file}.mjs')"`,
  `\tcp dist-lambda/${file}.mjs dist-lambda/${file}.mjs.map "$(ARTIFACTS_DIR)/"`,
];
fs.writeFileSync(
  "Makefile",
  [
    "# SAM の BuildMethod: makefile が呼ぶ（cloud/stacks/services/admin-auth.yaml の Metadata）。本体と運用の 2 つの関数がある。",
    "# npm を使わず、pnpm（pnpm-workspace.yaml のサプライチェーン対策つき）で依存を入れ、esbuild でそれぞれ 1 ファイルにまとめる。",
    "# @aws-sdk/* は Lambda の実行環境にあるので含めない。pg などは CommonJS で require を呼ぶため、bundle の banner で require を用意している。",
    "# 読み込めることを写す前に確かめる（モジュールの最上位では接続しないので、ネットワークなしで通る）。",
    ...target("build-AdminAuthFunction", "index"),
    "",
    ...target("build-AdminAuthOpsFunction", "ops"),
    "",
  ].join("\n"),
);
const append = (file, lines) => {
  const current = fs.readFileSync(file, "utf8");
  const add = lines.filter((line) => !current.split("\n").includes(line));
  if (add.length) fs.writeFileSync(file, current.replace(/\n?$/, "\n") + add.join("\n") + "\n");
};
append(".gitignore", ["dist-lambda/"]);
append(".dockerignore", ["dist-lambda", "Makefile"]);
console.log(pkg.scripts.bundle);
```

`Dockerfile` の次の 4 行（RDS の CA の段と環境変数とコピー）を消し、コメントを足す:
- `# RDS に TLS（証明書の検証つき）でつなぐための CA。…` の行と `FROM alpine:3 AS rds-ca` と `ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /certs/rds-global-bundle.pem` と、その後の空行
- `ENV NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem`
- `COPY --from=rds-ca --chown=node:node /certs ./certs`

ファイルの冒頭のコメントの下に `# 開発の compose だけが使う（本番は Lambda。sam build が Makefile で zip にする。ADR-26）。開発の PostgreSQL は TLS を使わないので、RDS の CA は入れない` を足す。

- [ ] **Step 4: 通ることを確かめる**

Run: `cd backend/admin-auth && pnpm exec vitest run && pnpm typecheck`
Expected: すべて PASS

- [ ] **Step 5: 差分を確かめる（コミットはしない。bundle は実行しない）**

Run: `git status --short backend/admin-auth`

---

### Task 8: 結合テスト（ALB の形のイベント × 開発の PostgreSQL）

**Files:**
- Modify: `backend/admin-auth/compose.yml`（`postgres` に `ports` を足す）
- Create: `backend/admin-auth/vitest.integration.config.ts`、`integration/global-setup.ts`、`integration/helpers/postgres.ts`、`integration/lambda.test.ts`

**Interfaces:**
- Consumes: `createLambdaHandler`・`buildRuntime`・`AlbEvent`・`AlbResult`（Task 5）、`createOpsHandler`・`OpsContext`（Task 6）、`parseConfig`・`parseAlbConfig`（Task 1）、`createAuth`・`createPool`

- [ ] **Step 1: 開発の PostgreSQL を 127.0.0.1:5434 に開く**

`compose.yml` の冒頭のコメント 1 行目を `# 開発用: admin-auth（Better Auth の OIDC Provider）と PostgreSQL。PostgreSQL は 127.0.0.1:5434 にだけ開く（結合テストが Lambda の入口から直接つなぐため）。` にし、`postgres:` の `image:` の下に足す:

```yaml
    # 結合テスト（pnpm test:integration）が Lambda の入口から直接つなぐ。127.0.0.1 だけ（5432 は Chatwoot、5433 は n8n）
    ports:
      - "127.0.0.1:5434:5432"
```

Run: `cd backend/admin-auth && docker compose up -d postgres`
Expected: `admin-auth-postgres-1` が作り直され（ボリュームは残る）、`ss -ltn | grep 5434` に `127.0.0.1:5434` が出る。

- [ ] **Step 2: 設定と補助を書く**

`vitest.integration.config.ts`:

```ts
import { defineConfig } from "vitest/config";

// 結合テストの設定（単体テストは vitest.config.ts）。ALB の形のイベントで lambda.ts（本体）と ops.ts（運用）を呼び、
// 開発の PostgreSQL（127.0.0.1:5434）を本物として使う。Secrets Manager と Google だけ差し替える。
// - PostgreSQL を docker pause するテストがあるため、ファイルは 1 つずつ順に走らせる
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

`integration/helpers/postgres.ts`:

```ts
import { execFileSync } from "node:child_process";

// 開発の PostgreSQL（compose のサービス postgres）。127.0.0.1:5434 にだけ開いている（compose.yml）
export const POSTGRES_CONTAINER = "admin-auth-postgres-1";

/** コンテナの環境変数（POSTGRES_DB・POSTGRES_USER・POSTGRES_PASSWORD）。値は画面に出さない */
export function postgresEnv(name: "POSTGRES_DB" | "POSTGRES_USER" | "POSTGRES_PASSWORD"): string {
  return execFileSync("docker", ["exec", POSTGRES_CONTAINER, "printenv", name], { encoding: "utf8" }).trim();
}

export function pausePostgres(): void {
  execFileSync("docker", ["pause", POSTGRES_CONTAINER]);
}

/** 止めていなければ何もしない（afterEach から必ず呼ぶ） */
export function unpausePostgres(): void {
  const state = execFileSync("docker", ["inspect", "-f", "{{.State.Paused}}", POSTGRES_CONTAINER], { encoding: "utf8" }).trim();
  if (state === "true") execFileSync("docker", ["unpause", POSTGRES_CONTAINER]);
}
```

`integration/global-setup.ts`:

```ts
import { createConnection } from "node:net";
import { unpausePostgres } from "./helpers/postgres.js";

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
    unpausePostgres();
  } catch {
    throw new Error("結合テストの前提が足りない: admin-auth-postgres-1 が無い（cd backend/admin-auth && docker compose up -d postgres）");
  }
  if (!(await reachable(5434))) {
    throw new Error("結合テストの前提が足りない: 127.0.0.1:5434 に届かない（compose.yml の ports を反映: docker compose up -d postgres）");
  }
}
```

- [ ] **Step 3: 結合テストを書く（`integration/lambda.test.ts`）**

```ts
import { createHmac, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/auth.js";
import { parseAlbConfig, parseConfig } from "../src/config.js";
import { createPool } from "../src/db.js";
import { type AlbEvent, type AlbResult, buildRuntime, createLambdaHandler } from "../src/lambda.js";
import { createOpsHandler } from "../src/ops.js";
import { pausePostgres, postgresEnv, unpausePostgres } from "./helpers/postgres.js";

// ALB の形のイベントで本体（lambda.ts）と運用（ops.ts）を呼び、開発の PostgreSQL を本物として使う（仕様 7 節）。
// Secrets Manager の代わりに設定を直接組み立てる。Google には触れない（DB に直接作ったセッションでログイン済みにする）。
// テストのデータ（メール・クライアント ID）は it- で始め、afterAll で消す
const RUN = randomBytes(4).toString("hex");
const EMAIL = `it-admin-${RUN}@comegin.com`;
const CLIENT_ID = `it-alb-${RUN}`;
const CLIENT_SECRET = `it-secret-${randomBytes(24).toString("hex")}`;
const AUTH_HOST = "auth.it.invalid";
const PROTECTED_HOST = "chat.it.invalid";
const REDIRECT_URI = `https://${PROTECTED_HOST}/oauth2/idpresponse`;

const env = {
  NODE_ENV: "development",
  BETTER_AUTH_URL: `https://${AUTH_HOST}`,
  BETTER_AUTH_SECRET: `it-better-auth-secret-${randomBytes(16).toString("hex")}`,
  DATABASE_HOST: "127.0.0.1",
  DATABASE_PORT: "5434",
  DATABASE_NAME: postgresEnv("POSTGRES_DB"),
  DATABASE_USERNAME: postgresEnv("POSTGRES_USER"),
  DATABASE_PASSWORD: postgresEnv("POSTGRES_PASSWORD"),
  DATABASE_SSL: "false",
  GOOGLE_HOSTED_DOMAIN: "comegin.com",
  ADMIN_BOOTSTRAP_EMAILS: EMAIL,
  ALB_CLIENT_ID: CLIENT_ID,
  ALB_CLIENT_SECRET: CLIENT_SECRET,
  ALB_PROTECTED_HOSTS: PROTECTED_HOST,
};
const config = parseConfig(env, { requireGoogle: false });
const alb = parseAlbConfig(env);
const ops = createOpsHandler(async () => ({ config, alb }));
let direct: pg.Pool;
let clock = Date.now();
let builds = 0;
const lambda = createLambdaHandler({
  load: async () => config,
  build: (c: typeof config) => {
    builds += 1;
    return buildRuntime(c);
  },
  now: () => clock,
});

const event = (method: string, path: string, init: { query?: Record<string, string[]>; headers?: Record<string, string[]>; body?: string; base64?: boolean } = {}): AlbEvent => ({
  httpMethod: method,
  path,
  multiValueQueryStringParameters: init.query ?? {},
  multiValueHeaders: { host: [AUTH_HOST], "x-forwarded-for": ["192.0.2.10"], ...init.headers },
  body: init.body ?? "",
  isBase64Encoded: init.base64 ?? false,
});
const header = (res: AlbResult, name: string) => res.multiValueHeaders[name]?.[0];

/** Better Auth と同じ署名（better-call の signCookieValue: HMAC-SHA256 の base64 を . でつなぎ、URI エンコード）で、セッションの Cookie を作る */
async function sessionCookie(): Promise<string> {
  const pool = createPool(config);
  try {
    const ctx = await createAuth(config, pool).$context;
    const user = await ctx.internalAdapter.createUser({ email: EMAIL, name: "IT admin", emailVerified: true });
    const session = await ctx.internalAdapter.createSession(user.id);
    const signature = createHmac("sha256", config.BETTER_AUTH_SECRET).update(session.token).digest("base64");
    return `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`;
  } finally {
    await pool.end();
  }
}

beforeAll(() => {
  direct = new pg.Pool({ host: "127.0.0.1", port: 5434, database: env.DATABASE_NAME, user: env.DATABASE_USERNAME, password: env.DATABASE_PASSWORD, max: 1 });
});

afterEach(() => {
  unpausePostgres();
});

afterAll(async () => {
  const user = await direct.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [EMAIL]);
  for (const table of ["oauthAccessToken", "oauthRefreshToken", "oauthConsent"]) {
    const exists = await direct.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`"${table}"`]);
    if (exists.rows[0]?.ok) await direct.query(`DELETE FROM "${table}" WHERE "clientId" = $1`, [CLIENT_ID]);
  }
  for (const { id } of user.rows) {
    await direct.query(`DELETE FROM session WHERE "userId" = $1`, [id]);
    await direct.query(`DELETE FROM account WHERE "userId" = $1`, [id]);
    await direct.query(`DELETE FROM "user" WHERE id = $1`, [id]);
  }
  await direct.query(`DELETE FROM "oauthClient" WHERE "clientId" = $1`, [CLIENT_ID]);
  await direct.query(`DELETE FROM admin_allowlist WHERE email = $1`, [EMAIL]);
  await direct.end();
});

describe("運用の入口（ops.ts）", () => {
  describe("正常系", () => {
    it("migrate は 2 回目に表も列も作らず（冪等）、許可リストの初期値を入れる", async () => {
      await ops({ action: "migrate" });
      const second = await ops({ action: "migrate" });
      expect(second).toMatchObject({ ok: true, action: "migrate", result: { createdTables: [], addedColumnsTables: [] } });
      const rows = await direct.query(`SELECT added_by FROM admin_allowlist WHERE email = $1`, [EMAIL]);
      expect(rows.rows[0]?.added_by).toBe("bootstrap");
    });

    it("register-alb-client は created のあと unchanged", async () => {
      expect(await ops({ action: "register-alb-client" })).toMatchObject({ ok: true, result: { outcome: "created", redirectUris: [REDIRECT_URI] } });
      expect(await ops({ action: "register-alb-client" })).toMatchObject({ ok: true, result: { outcome: "unchanged" } });
    });
  });

  describe("異常系", () => {
    it("空入力: action が無ければ ok: false で、DB に触れない", async () => {
      expect(await ops({})).toMatchObject({ ok: false });
    });
  });
});

describe("本体（lambda.ts）: ALB と同じ流れ", () => {
  describe("正常系", () => {
    it("discovery と JWKS を返す", async () => {
      const discovery = await lambda(event("GET", "/.well-known/openid-configuration"));
      expect(discovery.statusCode).toBe(200);
      expect(JSON.parse(discovery.body).issuer).toBe(`https://${AUTH_HOST}/api/auth`);
      const jwks = await lambda(event("GET", "/api/auth/jwks"));
      expect(JSON.parse(jwks.body).keys[0].alg).toBe("RS256");
    });

    it("ログイン済みなら、認可 → コード → client_secret_basic のトークン → UserInfo が通る", async () => {
      const cookie = await sessionCookie();
      const authorize = await lambda(
        event("GET", "/api/auth/oauth2/authorize", {
          query: {
            response_type: ["code"],
            client_id: [CLIENT_ID],
            redirect_uri: [encodeURIComponent(REDIRECT_URI)],
            scope: ["openid%20email%20profile"],
            state: ["it-state"],
            nonce: ["it-nonce"],
          },
          headers: { cookie: [cookie], accept: ["text/html"], "sec-fetch-mode": ["navigate"], "sec-fetch-dest": ["document"] },
        }),
      );
      expect(authorize.statusCode).toBe(302);
      const location = new URL(header(authorize, "location")!);
      expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
      expect(location.searchParams.get("state")).toBe("it-state");
      const code = location.searchParams.get("code")!;

      const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }).toString();
      const token = await lambda(
        event("POST", "/api/auth/oauth2/token", {
          headers: {
            "content-type": ["application/x-www-form-urlencoded"],
            authorization: [`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`],
          },
          body: Buffer.from(form).toString("base64"),
          base64: true,
        }),
      );
      expect(token.statusCode).toBe(200);
      const tokens = JSON.parse(token.body) as { access_token: string; id_token: string };
      expect(tokens.id_token).toBeTruthy();

      const userinfo = await lambda(event("GET", "/api/auth/oauth2/userinfo", { headers: { authorization: [`Bearer ${tokens.access_token}`] } }));
      expect(userinfo.statusCode).toBe(200);
      expect(JSON.parse(userinfo.body).email).toBe(EMAIL);
    });

    it("未ログインの認可は、署名つきのクエリを持って /sign-in へ送り、クエリを二重にエンコードしない", async () => {
      const res = await lambda(
        event("GET", "/api/auth/oauth2/authorize", {
          query: { response_type: ["code"], client_id: [CLIENT_ID], redirect_uri: [encodeURIComponent(REDIRECT_URI)], scope: ["openid"], state: ["s"] },
          headers: { accept: ["text/html"], "sec-fetch-mode": ["navigate"], "sec-fetch-dest": ["document"] },
        }),
      );
      expect(res.statusCode).toBe(302);
      const location = new URL(header(res, "location")!, `https://${AUTH_HOST}`);
      expect(location.pathname).toBe("/sign-in");
      expect(location.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    });

    it("60 秒以上空いたら作り直し（プールと auth）、そのあとも応答する", async () => {
      const before = builds;
      clock += 61_000;
      expect((await lambda(event("GET", "/api/auth/jwks"))).statusCode).toBe(200);
      expect(builds).toBe(before + 1);
    });
  });

  describe("異常系", () => {
    it("入力: シークレットが違えば 401 invalid_client", async () => {
      const form = new URLSearchParams({ grant_type: "authorization_code", code: "x", redirect_uri: REDIRECT_URI }).toString();
      const res = await lambda(
        event("POST", "/api/auth/oauth2/token", {
          headers: { "content-type": ["application/x-www-form-urlencoded"], authorization: [`Basic ${Buffer.from(`${CLIENT_ID}:wrong`).toString("base64")}`] },
          body: Buffer.from(form).toString("base64"),
          base64: true,
        }),
      );
      expect(res.statusCode).toBe(401);
    });

    it("サーバ: PostgreSQL が止まると 5xx を返し（例外にしない）、再開後は 200 に戻る", async () => {
      pausePostgres();
      const failed = await lambda(event("GET", "/api/auth/jwks"));
      expect(failed.statusCode).toBeGreaterThanOrEqual(500);
      unpausePostgres();
      await vi.waitFor(async () => expect((await lambda(event("GET", "/api/auth/jwks"))).statusCode).toBe(200), { timeout: 30_000, interval: 1_000 });
    });
  });
});
```

- [ ] **Step 4: 結合テストを実行する**

Run: `cd backend/admin-auth && pnpm test:integration`
Expected: PASS（8 件）。失敗したら、まず前提（PostgreSQL が 5434 で動いているか、`migrate` が先に走ったか）を疑う。Better Auth の内部（`$context.internalAdapter`・`authCookies`・Cookie の署名）が想定と違えば、`node_modules/better-auth/dist` と `better-call/dist/crypto.mjs` を読んで合わせ、`Ruling:` として台帳に残す。src のバグなら src を直さず `it.todo` と直上のコメントで残す。

- [ ] **Step 5: 単体テストに結合テストが混ざっていないことを確かめる**

Run: `cd backend/admin-auth && pnpm exec vitest run`
Expected: PASS（`integration/` は `vitest.config.ts` の `include` 外）

- [ ] **Step 6: 差分を確かめる（コミットはしない）**

Run: `git status --short backend/admin-auth`

---

### Task 9: IaC（SAM）を Lambda 2 つに書き換える

**Files:**
- Modify: `cloud/stacks/services/admin-auth.yaml`（全体を置き換える）
- Modify: `cloud/stacks/edge.yaml`・`network.yaml`・`alarms.yaml`・`cluster.yaml`・`ecr.yaml`・`cloud/template.yaml`

**Interfaces:**
- Produces（`admin-auth.yaml` の出力）: `FunctionName`・`AliasArn`・`TargetGroupArn`・`TargetGroupFullName`・`OpsFunctionName`
- 依存の向き: `AdminAuthService` → `EdgeStack`（edge が `AdminAuthTargetGroupArn` を受け取る）。`AdminAuthService` は edge を参照しない（`AlbProtectedHosts` は親で組み立てる）。

- [ ] **Step 1: 変更前の検証の結果を残す**

Run: `cd cloud && for f in stacks/services/admin-auth.yaml stacks/edge.yaml stacks/network.yaml stacks/alarms.yaml stacks/cluster.yaml stacks/ecr.yaml template.yaml; do sam validate --lint --template $f 2>&1 | tail -1; done`
Expected: すべて valid（② の後の状態）

- [ ] **Step 2: `cloud/stacks/services/admin-auth.yaml` を丸ごと置き換える**

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Description: >-
  admin-auth: 管理画面の関門（Better Auth）。ALB の authenticate-oidc の IdP で、Google Workspace でログインさせる。
  ADR-26 により VPC の中の Lambda 2 つ: 本体（ALB のターゲット）と運用（admin-auth-ops。migrate と ALB クライアントの登録。運用者が aws lambda invoke で呼ぶ）。
  仕様は docs/superpowers/specs/2026-10-12-admin-auth-lambda-design.md。環境変数名は backend/admin-auth/.env.example が正本。
  止まっても、ALB のセッションが残っている間は管理画面を使い続けられる（新しいログインだけができなくなる）。
  ターゲットグループはこのスタックが持つ（CloudFormation で関数を登録する手段が TargetGroup の Targets だけのため。edge に置くと循環する）。
  RDS の CA は Lambda の実行環境の /var/runtime/ca-cert.pem を NODE_EXTRA_CA_CERTS で読む（証明書の検証つきで TLS 接続する）。

Parameters:
  EnvName:
    Type: String
    Default: prod
  PrivateSubnetIds:
    Type: CommaDelimitedList
    Description: private サブネットの ID（network.yaml の PrivateSubnetIds）
  SecurityGroupId:
    Type: AWS::EC2::SecurityGroup::Id
    Description: network.yaml の AdminAuthSecurityGroupId
  SecretNamePrefix:
    Type: String
    Description: secrets.yaml の SecretNamePrefix（comegin/<EnvName>）
  PostgresEndpoint:
    Type: String
    Description: data.yaml の PostgresEndpoint
  AuthHost:
    Type: String
    Description: admin-auth の公開ホスト名（BETTER_AUTH_URL = OIDC の issuer の基）
  DomainName:
    Type: String
    Default: comegin.com
    Description: Google の hd クレームと照合する Workspace のドメイン（GOOGLE_HOSTED_DOMAIN）
  GoogleClientId:
    Type: String
    Default: ''
    Description: Google の OAuth クライアント ID（Workspace の「内部」）。本体では必須。人間が Google Cloud で発行して入れる。
  AdminBootstrapEmails:
    Type: String
    Default: ''
    Description: 管理者の許可リストの初期値（カンマ区切り）。運用の Lambda の migrate の最後に表へ追加するだけ。以後の追加と削除は README の SQL で行う。
  AlbClientId:
    Type: String
    Default: alb
    Description: ALB の OIDC のクライアント ID（edge.yaml の AlbOidcClientId と同じ値）
  AlbProtectedHosts:
    Type: String
    Description: /oauth2/idpresponse を登録するホスト（カンマ区切り。親が ChatHost と MktHost から組み立てる）
  ReservedConcurrency:
    Type: Number
    Default: 5
    MinValue: 1
    Description: 本体の予約同時実行数（管理者だけが使う。RDS の接続数の上限にもなる。暫定値。仕様 12 節）
  ProvisionedConcurrency:
    Type: Number
    Default: 0
    MinValue: 0
    Description: 本体のプロビジョニングされた同時実行数（0 なら付けない）。Wave 4 の実測で ALB の IdP の呼び出しが遅ければ 1 にする（仕様の D1）
  LogRetentionDays:
    Type: Number
    Default: 30
    Description: ロググループの保持日数（cluster.yaml と同じ暫定値）

Conditions:
  HasProvisionedConcurrency: !Not [!Equals [!Ref ProvisionedConcurrency, '0']]

Resources:
  LogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: !Sub '/aws/lambda/comegin-${EnvName}-admin-auth'
      RetentionInDays: !Ref LogRetentionDays

  OpsLogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: !Sub '/aws/lambda/comegin-${EnvName}-admin-auth-ops'
      RetentionInDays: !Ref LogRetentionDays

  AdminAuthFunction:
    Type: AWS::Serverless::Function
    Metadata:
      # backend/admin-auth/Makefile の build-AdminAuthFunction（pnpm と esbuild。npm を使わない）
      BuildMethod: makefile
    Properties:
      FunctionName: !Sub 'comegin-${EnvName}-admin-auth'
      Description: Admin gate (Better Auth OIDC provider for the ALB) (ADR-26)
      CodeUri: ../../../backend/admin-auth
      Handler: index.handler
      Runtime: nodejs22.x
      Architectures: [arm64]
      # Better Auth と pg が重い。メモリに比例して CPU が増え、コールドスタートが短くなる（仕様 2.2）
      MemorySize: 512
      # DB の接続（5 秒）と問い合わせ（5 秒）の上限。ALB の IdP の呼び出しを長く待たせない
      Timeout: 10
      ReservedConcurrentExecutions: !Ref ReservedConcurrency
      AutoPublishAlias: live
      ProvisionedConcurrencyConfig: !If
        - HasProvisionedConcurrency
        - ProvisionedConcurrentExecutions: !Ref ProvisionedConcurrency
        - !Ref AWS::NoValue
      LoggingConfig:
        LogGroup: !Ref LogGroup
      VpcConfig:
        SecurityGroupIds:
          - !Ref SecurityGroupId
        SubnetIds: !Ref PrivateSubnetIds
      Environment:
        Variables:
          NODE_ENV: production
          NODE_EXTRA_CA_CERTS: /var/runtime/ca-cert.pem
          BETTER_AUTH_URL: !Sub 'https://${AuthHost}'
          DATABASE_HOST: !Ref PostgresEndpoint
          DATABASE_PORT: '5432'
          DATABASE_NAME: admin_auth
          DATABASE_USERNAME: admin_auth
          DATABASE_SSL: 'true'
          GOOGLE_CLIENT_ID: !Ref GoogleClientId
          GOOGLE_HOSTED_DOMAIN: !Ref DomainName
          # 秘密値（BETTER_AUTH_SECRET・DB_PASSWORD・GOOGLE_CLIENT_SECRET）はコールドスタートで Secrets Manager から読む（src/lambda.ts）
          SECRETS_PREFIX: !Sub '${SecretNamePrefix}/admin-auth'
      Policies:
        - Version: '2012-10-17'
          Statement:
            # ALB_CLIENT_SECRET は読めない（本体は使わない。運用の Lambda だけが読む）
            - Sid: ReadOwnSecrets
              Effect: Allow
              Action: secretsmanager:GetSecretValue
              Resource:
                - !Sub 'arn:${AWS::Partition}:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:${SecretNamePrefix}/admin-auth/BETTER_AUTH_SECRET-*'
                - !Sub 'arn:${AWS::Partition}:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:${SecretNamePrefix}/admin-auth/DB_PASSWORD-*'
                - !Sub 'arn:${AWS::Partition}:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:${SecretNamePrefix}/admin-auth/GOOGLE_CLIENT_SECRET-*'

  # 運用の Lambda（migrate・register-alb-client）。ALB に登録しない。運用者の IAM の主体が lambda:InvokeFunction で呼ぶ
  AdminAuthOpsFunction:
    Type: AWS::Serverless::Function
    Metadata:
      BuildMethod: makefile
    Properties:
      FunctionName: !Sub 'comegin-${EnvName}-admin-auth-ops'
      Description: Admin gate one-off operations (migrate, register the ALB client) (ADR-26)
      CodeUri: ../../../backend/admin-auth
      Handler: ops.handler
      Runtime: nodejs22.x
      Architectures: [arm64]
      MemorySize: 512
      # 移行は時間がかかりうる
      Timeout: 60
      # 移行と登録が重ねて走らないように
      ReservedConcurrentExecutions: 1
      LoggingConfig:
        LogGroup: !Ref OpsLogGroup
      VpcConfig:
        SecurityGroupIds:
          - !Ref SecurityGroupId
        SubnetIds: !Ref PrivateSubnetIds
      Environment:
        Variables:
          NODE_ENV: production
          NODE_EXTRA_CA_CERTS: /var/runtime/ca-cert.pem
          BETTER_AUTH_URL: !Sub 'https://${AuthHost}'
          DATABASE_HOST: !Ref PostgresEndpoint
          DATABASE_PORT: '5432'
          DATABASE_NAME: admin_auth
          DATABASE_USERNAME: admin_auth
          DATABASE_SSL: 'true'
          GOOGLE_HOSTED_DOMAIN: !Ref DomainName
          ADMIN_BOOTSTRAP_EMAILS: !Ref AdminBootstrapEmails
          ALB_CLIENT_ID: !Ref AlbClientId
          ALB_PROTECTED_HOSTS: !Ref AlbProtectedHosts
          SECRETS_PREFIX: !Sub '${SecretNamePrefix}/admin-auth'
      Policies:
        - Version: '2012-10-17'
          Statement:
            # Google の秘密値は読めない（移行と登録に要らない）
            - Sid: ReadOpsSecrets
              Effect: Allow
              Action: secretsmanager:GetSecretValue
              Resource:
                - !Sub 'arn:${AWS::Partition}:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:${SecretNamePrefix}/admin-auth/BETTER_AUTH_SECRET-*'
                - !Sub 'arn:${AWS::Partition}:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:${SecretNamePrefix}/admin-auth/DB_PASSWORD-*'
                - !Sub 'arn:${AWS::Partition}:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:${SecretNamePrefix}/admin-auth/ALB_CLIENT_SECRET-*'

  # ALB からの呼び出しの許可。SourceArn にターゲットグループの !Ref を使うと、許可とターゲットグループが
  # 互いを待つ循環になる（登録は許可が先に要る）ため、固定の名前とワイルドカードで絞る（② と同じ）
  AlbInvokePermission:
    Type: AWS::Lambda::Permission
    Properties:
      FunctionName: !Ref AdminAuthFunction.Alias
      Action: lambda:InvokeFunction
      Principal: elasticloadbalancing.amazonaws.com
      SourceAccount: !Ref AWS::AccountId
      SourceArn: !Sub 'arn:${AWS::Partition}:elasticloadbalancing:${AWS::Region}:${AWS::AccountId}:targetgroup/comegin-${EnvName}-admin-auth/*'

  TargetGroup:
    Type: AWS::ElasticLoadBalancingV2::TargetGroup
    DependsOn: AlbInvokePermission
    Properties:
      # 名前を固定している（上の許可の SourceArn で使う）。置き換えの要る変更（TargetType など）は、名前の衝突で更新が失敗する。
      # そのときは名前を変えてデプロイする（許可の SourceArn も同じ名前から作られるので一緒に変わる）
      Name: !Sub 'comegin-${EnvName}-admin-auth'
      TargetType: lambda
      # ヘルスチェックは無効（lambda の既定。有効にすると呼び出しの料金がかかる。/healthz は開発用）
      HealthCheckEnabled: false
      Targets:
        - Id: !Ref AdminAuthFunction.Alias
      TargetGroupAttributes:
        # Better Auth はログインの途中で Set-Cookie を複数返すため有効にする（無効だと 1 つしか返せない。仕様 2.1）
        - { Key: lambda.multi_value_headers.enabled, Value: 'true' }
      Tags:
        - { Key: Name, Value: !Sub 'comegin-${EnvName}-admin-auth' }

Outputs:
  FunctionName:
    Value: !Ref AdminAuthFunction
  AliasArn:
    Value: !Ref AdminAuthFunction.Alias
  OpsFunctionName:
    Description: 運用の Lambda（cloud/README の 4.19 の手順で aws lambda invoke する）
    Value: !Ref AdminAuthOpsFunction
  TargetGroupArn:
    Description: edge.yaml のルール 300 の転送先
    Value: !Ref TargetGroup
  TargetGroupFullName:
    Description: alarms.yaml の admin-auth-target-5xx の次元（targetgroup/<名前>/<ID>）
    Value: !GetAtt TargetGroup.TargetGroupFullName
```

- [ ] **Step 3: ほかのスタックを直す（scratchpad のスクリプトで、置き換え元が見つからなければ止まるようにする。② の `t6-iac.cjs` と同じ形）**

`cloud/stacks/edge.yaml`:
1. パラメータの `AdminAuthPort`（`Type: Number`・`Default: 3103` の 3 行）と `AdminAuthHealthCheckPath`（`Type: String`・`Default: /healthz` の 3 行）を消し、`ConsentApiTargetGroupArn` のパラメータの後に足す:

```yaml
  # ---- admin-auth（ADR-26。Lambda。ターゲットグループは services/admin-auth.yaml が持つ）
  AdminAuthTargetGroupArn:
    Type: String
    Description: services/admin-auth.yaml の TargetGroupArn（ルール 300 の転送先）
```

2. リソース `AdminAuthTargetGroup`（`AdminAuthTargetGroup:` から `- { Key: Name, Value: !Sub 'comegin-${EnvName}-admin-auth' }` までと、直前の空行）を消す。
3. `AuthHostRule` の `- { Type: forward, TargetGroupArn: !Ref AdminAuthTargetGroup }` を `- { Type: forward, TargetGroupArn: !Ref AdminAuthTargetGroupArn }` にする。
4. 出力の `AdminAuthTargetGroupArn`・`AdminAuthTargetGroupFullName`（4 行）を消す。
5. ポートのパラメータ群の見出しのコメント（`# ---- コンテナの待ち受けポート`）は Mautic・Chatwoot の分が残るのでそのまま。

`cloud/stacks/network.yaml`:
1. パラメータの `AdminAuthPort`（3 行）を消す。
2. `AlbSecurityGroup` の外向きから `Description: To admin-auth }` の行を消す。
3. `AdminAuthFromAlb`（2 行）を消し、`# admin-auth は Lambda（ADR-26）。ALB は Lambda をネットワークを通さずに呼ぶため、ALB からの許可は要らない` を置く。
`AdminAuthSecurityGroup`・`PostgresFromAdminAuth` は変えない。

`cloud/stacks/alarms.yaml`:
1. パラメータ `AdminAuthTargetGroupFullName` の `Description` を `services/admin-auth.yaml の TargetGroupFullName（targetgroup/<名前>/<ID>。ADR-26 で Lambda のターゲット）` にし、`ConsentApiFunctionName` の下に足す:

```yaml
  AdminAuthFunctionName:
    Type: String
    Description: services/admin-auth.yaml の FunctionName（ADR-26 の Lambda の本体）
```

2. `AdminAuthRunningTaskAlarm`（`AdminAuthRunningTaskAlarm:` から、その中の `ReturnData: true` の行まで）と、`AdminAuthUnhealthyHostAlarm`（`AdminAuthUnhealthyHostAlarm:` から `OKActions` まで）を消す。直前の「admin-auth は止まっても訪問者に見えない…」のコメントは、新しいアラームの上に移す。
3. `ConsentApiTarget5xxAlarm` の後に足す:

```yaml

  # ---------------------------------------------------------------- Lambda: admin-auth（ADR-26。仕様 2.5）
  # admin-auth は止まっても既存の ALB のセッション（12 時間）のあいだは誰も困らないため、このアラームでしか気づけない（TA-05 の項目 24）。
  # DB の障害などの 500 は「応答として返す」ため Errors に数えられない。ターゲットの 5xx で拾う
  AdminAuthErrorsAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmName: !Sub 'comegin-${EnvName}-admin-auth-errors'
      AlarmDescription: admin-auth（Lambda）が例外・タイムアウト・初期化の失敗で止まった。ALB は 502 を返し、新しいログインができない。
      Namespace: AWS/Lambda
      MetricName: Errors
      Dimensions:
        - { Name: FunctionName, Value: !Ref AdminAuthFunctionName }
      Statistic: Sum
      Period: 60
      EvaluationPeriods: 1
      Threshold: 0
      ComparisonOperator: GreaterThanThreshold
      TreatMissingData: notBreaching
      ActionsEnabled: true
      AlarmActions: [!Ref OpsAlertTopicArn]
      OKActions: [!Ref OpsAlertTopicArn]

  AdminAuthThrottlesAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmName: !Sub 'comegin-${EnvName}-admin-auth-throttles'
      AlarmDescription: admin-auth（Lambda）が予約同時実行数の上限に達し、呼び出しを拒否した。
      Namespace: AWS/Lambda
      MetricName: Throttles
      Dimensions:
        - { Name: FunctionName, Value: !Ref AdminAuthFunctionName }
      Statistic: Sum
      Period: 60
      EvaluationPeriods: 1
      Threshold: 0
      ComparisonOperator: GreaterThanThreshold
      TreatMissingData: notBreaching
      ActionsEnabled: true
      AlarmActions: [!Ref OpsAlertTopicArn]
      OKActions: [!Ref OpsAlertTopicArn]

  AdminAuthTarget5xxAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmName: !Sub 'comegin-${EnvName}-admin-auth-target-5xx'
      AlarmDescription: admin-auth が 5xx を返した（DB の障害など）。新しいログインができない。
      Namespace: AWS/ApplicationELB
      MetricName: HTTPCode_Target_5XX_Count
      Dimensions:
        - { Name: TargetGroup, Value: !Ref AdminAuthTargetGroupFullName }
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

`cloud/stacks/cluster.yaml`: `AdminAuthLogGroup`（5 行と後ろの空行）と出力 `AdminAuthLogGroupName`（2 行）を消す。

`cloud/stacks/ecr.yaml`: `AdminAuthRepository`（`AdminAuthRepository:` から `LifecyclePolicyText` の 2 行まで）と出力 `AdminAuthRepositoryUri`（2 行）を消す。`Description` の 1 行目を `ECR リポジトリ。Mautic・Chatwoot の派生イメージ用。自作のサービス（admin-auth・consent-api・faq-bot）は Lambda（ADR-26）で、sam build が zip にするためリポジトリを持たない。…`（以降の Strapi・n8n・Cal.com・GA4 の説明は残す）にする。

`cloud/template.yaml`:
1. `Metadata` のパラメータのグループから `AdminAuthPort`・`AdminAuthImageTag`・`AdminAuthDesiredCount`・`AdminAuthCpu`・`AdminAuthMemory` を外し、`consent-api` のグループの後に足す:

```yaml
      - Label: { default: admin-auth（ADR-26。services/admin-auth.yaml） }
        Parameters: [AdminAuthReservedConcurrency, AdminAuthProvisionedConcurrency]
```

2. パラメータの `AdminAuthPort`・`AdminAuthImageTag`・`AdminAuthDesiredCount`・`AdminAuthCpu`・`AdminAuthMemory` を消し、`ConsentApiReservedConcurrency` の下に足す:

```yaml
  AdminAuthReservedConcurrency:
    Type: Number
    Default: 5
    MinValue: 1
    Description: admin-auth（Lambda の本体）の予約同時実行数（暫定値。docs/superpowers/specs/2026-10-12-admin-auth-lambda-design.md の 12 節）
  AdminAuthProvisionedConcurrency:
    Type: Number
    Default: 0
    MinValue: 0
    Description: admin-auth（本体）のプロビジョニングされた同時実行数。0 なら付けない。Wave 4 で ALB の IdP の呼び出しが遅ければ 1 にする（月 4〜5 USD 前後）
```

3. `NetworkStack` と `EdgeStack` の `AdminAuthPort: !Ref AdminAuthPort` を消し、`EdgeStack` に `AdminAuthTargetGroupArn: !GetAtt AdminAuthService.Outputs.TargetGroupArn` を足す。
4. `AdminAuthService` を次に置き換える:

```yaml
  # ---- admin-auth（ADR-26。VPC の中の Lambda 2 つ。ALB のターゲットグループもこのスタックが持ち、EdgeStack に渡す）
  # AlbProtectedHosts は EdgeStack の出力を使わずに親で組み立てる（edge がこのスタックを参照するため、使うと循環する。値は同じ）
  AdminAuthService:
    Type: AWS::Serverless::Application
    Properties:
      Location: stacks/services/admin-auth.yaml
      Parameters:
        EnvName: !Ref EnvName
        PrivateSubnetIds: !GetAtt NetworkStack.Outputs.PrivateSubnetIds
        SecurityGroupId: !GetAtt NetworkStack.Outputs.AdminAuthSecurityGroupId
        SecretNamePrefix: !GetAtt SecretsStack.Outputs.SecretNamePrefix
        PostgresEndpoint: !GetAtt DataStack.Outputs.PostgresEndpoint
        AuthHost: !Ref AuthHost
        DomainName: !Ref DomainName
        GoogleClientId: !Ref GoogleClientId
        AdminBootstrapEmails: !Ref AdminBootstrapEmails
        AlbClientId: !Ref AlbOidcClientId
        AlbProtectedHosts: !Join [',', [!Ref ChatHost, !Ref MktHost]]
        ReservedConcurrency: !Ref AdminAuthReservedConcurrency
        ProvisionedConcurrency: !Ref AdminAuthProvisionedConcurrency
```

5. `AlarmsStack` の `AdminAuthTargetGroupFullName` を `!GetAtt AdminAuthService.Outputs.TargetGroupFullName` にし、`AdminAuthFunctionName: !GetAtt AdminAuthService.Outputs.FunctionName` を足す。
6. 出力の `AdminAuthSecurityGroupId`（説明の行を含む 3 行）を次に置き換える:

```yaml
  AdminAuthOpsFunctionName:
    Description: admin-auth の運用の Lambda（migrate・register-alb-client。cloud/README の 4.19）
    Value: !GetAtt AdminAuthService.Outputs.OpsFunctionName
```

- [ ] **Step 4: 参照の取りこぼしを探す**

Run: `rg -n "AdminAuth(Port|ImageTag|DesiredCount|Cpu|Memory|HealthCheckPath|LogGroup|Repository)|AdminAuthTargetGroup\b|EdgeStack.Outputs.AdminAuth|EdgeStack.Outputs.AlbProtectedHosts" cloud/`
Expected: `cloud/README.md` の行だけ（Task 10 で直す）。`EdgeStack.Outputs.AlbProtectedHosts` は親の出力 `AlbProtectedHosts` が使うので、`template.yaml` の Outputs の 1 行は残ってよい（edge → services の向きは循環しない）。

- [ ] **Step 5: 検証する（ビルド・デプロイはしない）**

Run: `<scratchpad>/iac.sh`（② の検証スクリプト。7 本の `sam validate --lint` と、親 → 子のパラメータの突き合わせ。`check-params.cjs` の `targets` に `AdminAuthService` を足してから実行する）
Expected: 7 本とも valid、突き合わせ OK。`ProvisionedConcurrencyConfig` の `!If` を SAM が受け付けなければ、条件つきの別の形（`AWS::Lambda::Version` を使わず、`AutoPublishAlias` のまま `ProvisionedConcurrencyConfig` を常に付けて 0 を許すなど）を調べて直し、`Ruling:` に残す。

- [ ] **Step 6: 差分を確かめる（コミットはしない）**

Run: `git status --short cloud`

---

### Task 10: 文書を更新する

**Files:**
- Modify: `backend/admin-auth/README.md`・`.env.example`、`backend/faq-bot/README.md`（節番号の参照だけ）
- Modify: `cloud/README.md`、`.claude/CLAUDE.md`
- Modify: `docs/RequirementDefinition/AA/05-application-decisions.md`・`AA/01-application-landscape.md`・`TA/06-aws-runtime.md`・`TA/05-observability-and-ops.md`・`TA/04-security-and-secrets.md`・`TA/03-triggers-and-cicd.md`、`docs/DetailedDesign/07-failure-and-degradation.md`

書き換えは scratchpad のスクリプトで行い、置き換え元が 1 か所だけ見つからなければ止める（② の `t7-docs.cjs`・`minor-docs.cjs` と同じ形）。**`.env.example` は Edit で直す**（パスに `.env` を含むのでフックの対象外の名前だが、Bash のコマンドには書かない）。

- [ ] **Step 1: `backend/admin-auth/README.md`**

1. 1 段落目の `（開発ポート 3103。本番は ALB 配下の ECS on Fargate、ホスト名 `auth.comegin.com`）` を `（開発ポート 3103。本番は ALB 配下の Lambda〈VPC の中。ADR-26。2026-10-12 に ECS on Fargate から移した〉、ホスト名 `auth.comegin.com`）` にする。設計の出典の行の末尾に `、Lambda 化は `docs/superpowers/specs/2026-10-12-admin-auth-lambda-design.md`` を足す。
2. 「構成」のコードブロックを次に置き換える:

```
src/handler.ts                    入口に依存しない本体（Request → Response）。Better Auth・内蔵の画面・ヘルスチェックへの振り分け。例外を投げない
src/server.ts                     開発の入口（3103）。toNodeHandler で handler を包む
src/lambda.ts                     本番の入口（ALB のマルチバリューのイベント ⇄ Request/Response）。秘密値の読み込み、60 秒のアイドルのあとの DB の接続の作り直し
src/ops.ts                        運用の入口（admin-auth-ops。{"action":"migrate"}・{"action":"register-alb-client",…}）
src/operations.ts                 migrate と ALB クライアントの登録の本体（開発の CLI と ops.ts で共有）
src/index.ts                      開発の起動と停止
src/config.ts                     zod で環境変数を検証（loadConfig は終了、parseConfig は例外）
src/auth.ts                       Better Auth の設定（Google ログイン、hd・許可リストの検査、jwt・oauthProvider プラグイン）
src/allowlist.ts                  許可リストの表（admin_allowlist）の操作
src/pages.ts                      ログイン画面・同意画面・エラー画面（外部のスクリプトや画像を読み込まない。nonce 付きの CSP）
src/secrets.ts                    Secrets Manager の読み込み（本番の 2 つの入口）
src/scripts/migrate.ts            開発の CLI（pnpm db:migrate・compose の migrate）
src/scripts/register-alb-client.ts  開発の CLI（pnpm alb:register）
```

3. 「エンドポイント」の表の `GET /healthz` の行を `| `GET /healthz` | 開発のヘルスチェック（200）。**DB は見ない**。本番の ALB ではヘルスチェックを使わない（Lambda。ADR-26） |` にする。
4. 「許可リストの運用」の `初期値は `ADMIN_BOOTSTRAP_EMAILS`（カンマ区切り）。**起動時に表へ追加するだけ**で、削除はしない。` を `初期値は `ADMIN_BOOTSTRAP_EMAILS`（カンマ区切り）。**`migrate` の最後に表へ追加するだけ**で、削除はしない（2026-10-12 に起動時から移した。本番は運用の Lambda の migrate）。` にする。
5. 「環境変数」の表: `HOST` / `PORT` の行の内容に `（開発の入口だけ）` を足す。`ADMIN_BOOTSTRAP_EMAILS` の行の `起動時に表へ追加するだけ` を `migrate のときに表へ追加するだけ` にする。`ALB_CLIENT_ID`・`ALB_PROTECTED_HOSTS` の `登録スクリプトだけが使う` を `登録（開発の CLI と運用の Lambda）だけが使う` にする。表の最後に `| `SECRETS_PREFIX` | 本番の 2 つの入口だけ。秘密値の Secret の接頭辞（`comegin/<env>/admin-auth`）。開発は使わない | |` を足す。
6. `Docker イメージには `NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem`（…）が固定で入っている。…` の段落を次に置き換える:

```markdown
本番の Lambda は、実行環境にある Amazon の CA（RDS を含む）を `NODE_EXTRA_CA_CERTS=/var/runtime/ca-cert.pem` で読む（Node 20 以降の Lambda は既定では読み込まないため）。`DATABASE_SSL=true` で RDS に証明書を検証してつなぐのに要る。開発の Docker イメージには入れない（開発の PostgreSQL は TLS を使わない）。
```

7. 「起動（ローカル）」: `docker compose up -d --build      # postgres → migrate（一度だけ）→ admin-auth の順に起動。…` の行のコメントの末尾に `。migrate が許可リストの初期値も入れる` を足す。`- PostgreSQL はホストに公開しない。compose の中だけで動く。` を `- PostgreSQL は `127.0.0.1:5434` にだけ開いている（結合テストが Lambda の入口から直接つなぐため）。` にする。`# 本番の ECS では、DB の移行（node dist/scripts/migrate.js）のあとに、…` の行を `# 本番は運用の Lambda（admin-auth-ops）で {"action":"migrate"} のあとに {"action":"register-alb-client"} を呼ぶ（cloud/README の 4.19）` にする。起動の手順の後に足す:

```markdown
### テスト

```bash
pnpm test               # 単体（外部はモック）
pnpm test:integration   # 結合: ALB の形のイベントで lambda.ts（本体）と ops.ts（運用）を呼び、開発の PostgreSQL（127.0.0.1:5434）を本物として使う。PostgreSQL を数秒 docker pause する
```
```

8. 「ALB クライアントの登録」の 1 つ目の箇条の前に `- 本番は運用の Lambda で行う（`aws lambda invoke --function-name comegin-<env>-admin-auth-ops --payload '{"action":"register-alb-client"}'`。`authMethod`・`requirePkce` で下のオプションと同じ指定ができる）。` を足す。
9. 「運用上の注意」: `- SIGTERM で処理中のリクエストを終えてから DB を閉じる（猶予 10 秒）。` を `- SIGTERM での停止（猶予 10 秒）は開発の入口だけ。本番の Lambda は、前の呼び出しから 60 秒以上空いたら処理の前に DB の接続（プール）と auth を作り直す（凍結のあいだに切れた接続で固まらないように）。` にする。`- 起動時に許可リストの表が無い、または DB に届かないときは、プロセスが終了する（`migrate` を先に実行する）。` を `- **`migrate` の前は許可リストの表が無く、ログインの判定が 500 になる**（起動時の検査はやめた。`migrate` を先に実行する）。` にする。末尾に `- Better Auth のレート制限はメモリ上にあり、Lambda では実行環境ごとに分かれる。実効のあるレート制限は ALB の WAF に頼る（下の「ALB 配下でのレート制限」と同じ）。` を足す。

`backend/admin-auth/.env.example` の末尾に足す（Edit で）:

```bash

# --- 本番の入口（lambda.ts・ops.ts）だけ ---
# 秘密値の Secret の接頭辞（comegin/<env>/admin-auth）。開発（compose・pnpm dev）は使わない（上の値を直接使う）
SECRETS_PREFIX=
```

`backend/faq-bot/README.md` の `手順は `cloud/README.md` の 4.14）` を `手順は `cloud/README.md` の 4.17）` にする。

- [ ] **Step 2: `cloud/README.md`**

1. 1 章: `ecr.yaml                 ECR（自作 1 本〈admin-auth〉と、Mautic・Chatwoot の 3 本。consent-api・faq-bot は Lambda で ECR を使わない）` を `ecr.yaml                 ECR（Mautic・Chatwoot の 2 本。自作のサービス〈admin-auth・consent-api・faq-bot〉は Lambda で ECR を使わない）` に。`services/<svc>.yaml      ECS のサービス 5 本（mautic-web・mautic-cron・chatwoot-web・chatwoot-worker・admin-auth）` を `services/<svc>.yaml      ECS のサービス 4 本（mautic-web・mautic-cron・chatwoot-web・chatwoot-worker）` に。`ADR-26。4.14）` を `ADR-26。4.17）` に、`ADR-26。4.15）` を `ADR-26。4.18）` に。その後に `    services/admin-auth.yaml  admin-auth（Lambda 2 つ: 本体〈ALB のターゲット〉と運用〈admin-auth-ops〉。VPC の中。ADR-26。4.19）` を足す。
2. 4.2 の `sam build` のコメントを `# 必須（2026-10-11 から）。faq-bot・consent-api・admin-auth の Lambda を各 Makefile（pnpm と esbuild）でまとめる。開発機に pnpm 11 が要る` に。その下の段落の `faq-bot（4.14）・consent-api（4.15）の` を `faq-bot（4.17）・consent-api（4.18）・admin-auth（4.19）の` に、`consent-api は ALB のルール 106 から呼ばれるので、build を飛ばすと同意の受け口が 502 になる）` を `consent-api と admin-auth は ALB から呼ばれるので、build を飛ばすと同意の受け口とログインが 502 になる）` に。
3. 4.7 の「#### 自作のイメージ（タグはコミットの短縮 SHA など、毎回変わるもの）」の見出しから、`consent-api・faq-bot は Lambda（ADR-26）で、イメージを作らない（…）。` の行までを、次の 1 段落に置き換える: `#### 自作のサービス` ＋ 空行 ＋ `自作のサービス（admin-auth・consent-api・faq-bot）は Lambda（ADR-26）で、イメージを作らない（`sam build` が zip にする。4.17〜4.19）。`
4. 4.10 の表の `| **admin-auth** |` で始まる行を `| **admin-auth** | **運用の Lambda で行う**（4.19。RunTask は使わない）。① `{"action":"migrate"}`（許可リストの初期値も入る）② `{"action":"register-alb-client"}`。**① のあとでないと、ログインの判定が 500 になる** |` にする。
5. 4.11 の表の 1 行目（`| 1 | `AdminAuthDesiredCount=1` |` で始まる行）を消し、残りの順番を 1・2 に振り直す。表の後の `consent-api は Lambda（ADR-26）で DesiredCount を持たない。`sam deploy` の時点で ALB から呼ばれる（4.15）。` を `consent-api と admin-auth は Lambda（ADR-26）で DesiredCount を持たない。`sam deploy` の時点で ALB から呼ばれる（4.18・4.19）。**admin-auth は 4.19 の migrate と登録が済むまで、管理画面に誰も入れない**（Chatwoot・Mautic を起動する前に済ませる）。` にする。
6. 4.12 の 2 の `（Chatwoot・Mautic・admin-auth）` を `（Chatwoot・Mautic）` にし、5 の後に `6. **admin-auth（Lambda）**: `sam build` → `sam deploy` のあと、スキーマが変わる版なら運用の Lambda で `{"action":"migrate"}` を呼ぶ（4.19）。` を足す。
7. `### 4.14 faq-bot（Chatwoot の FAQ ボット。ADR-26）` を `### 4.17 faq-bot（Chatwoot の FAQ ボット。ADR-26）` に、`### 4.15 consent-api（Cookie 同意の受け口。ADR-26）` を `### 4.18 consent-api（Cookie 同意の受け口。ADR-26）` に。4.18 の本文の `（4.13）` はそのまま。
8. 4.18 の節の後（`## 5. TODO 一覧` の前）に足す:

```markdown
### 4.19 admin-auth（管理画面の関門。ADR-26）

VPC の中の Lambda 2 つ。本体（`comegin-<env>-admin-auth`。ALB のターゲット）と運用（`comegin-<env>-admin-auth-ops`。ALB にはつながない）。仕様は `docs/superpowers/specs/2026-10-12-admin-auth-lambda-design.md`。**`sam build` は `backend/admin-auth/Makefile` の 2 つのターゲットを使う。** ターゲットグループ（`comegin-<env>-admin-auth`。マルチバリューヘッダー有効）は `services/admin-auth.yaml` が持ち、edge のルール 300 に渡す。

1. `sam build` → `sam deploy`。Secrets の `admin-auth/GOOGLE_CLIENT_SECRET` と `GoogleClientId` は 4.6 で入れておく。
2. DB とアプリ用ユーザーを作る（4.8 の共有のタスク）。
3. 移行（許可リストの初期値もここで入る）と、ALB の登録:

   ```bash
   OPS=$(OUT AdminAuthOpsFunctionName)
   aws lambda invoke --region ap-northeast-1 --function-name "$OPS" --cli-binary-format raw-in-base64-out --payload '{"action":"migrate"}' /dev/stdout
   aws lambda invoke --region ap-northeast-1 --function-name "$OPS" --cli-binary-format raw-in-base64-out --payload '{"action":"register-alb-client"}' /dev/stdout
   # ALB がトークンの要求で invalid_client になるときは '{"action":"register-alb-client","authMethod":"client_secret_post"}'
   ```

   結果の JSON が `{"ok":true,…}` であること。`{"ok":false,…}` は入力の誤り、`FunctionError` は実行の失敗（ロググループ `/aws/lambda/comegin-<env>-admin-auth-ops`）。
4. 確かめる: 管理画面（`chat.`・`mkt.`）を開き、`auth.` に飛んで Google でログインし、戻ってこられること。**ALB のアクセスログに `AuthTokenEpRequestFailed`・`AuthUserinfoEpRequestFailed` が無いこと**と、IdP の呼び出しの所要時間を見る。アラーム `admin-auth-errors`・`admin-auth-throttles`・`admin-auth-target-5xx` が鳴っていないこと。

- **ALB の IdP の呼び出し（トークン・UserInfo）が待つ時間は公式文書で確かめられていない。** 呼び出しの数秒前にブラウザが同じ関数を呼ぶため、起動済みである見込み（仕様の D1）。遅い・失敗するときは `AdminAuthProvisionedConcurrency=1` にしてデプロイする（常時 1 つ起動。月 4〜5 USD 前後）。
- 予約同時実行数（`AdminAuthReservedConcurrency`。既定 5）・タイムアウト（10 秒）・アイドルの判定（60 秒）は暫定値。
- ターゲットグループの名前は固定（4.18 と同じ注意。置き換えの要る変更は名前を変えてデプロイする）。
```

9. 6 章: `- **ECR は 3 本**: 自作 1 本（admin-auth）と、Mautic、Chatwoot。` を `- **ECR は 2 本**: Mautic と Chatwoot。` に、その文末の `consent-api は ADR-26 で Lambda になり、ECR を外した（2026-10-12）。` を `自作のサービス（consent-api・admin-auth）は ADR-26 で Lambda になり、ECR を外した（2026-10-12）。` に。`**イメージのタグは製品ごと**（3 個）` を `（2 個）` に。

- [ ] **Step 3: `.claude/CLAUDE.md`**

1. 自作コードの表の `consent-api は本番は ALB 配下の Lambda（VPC の中。ADR-26。2026-10-12）で、DB を持たず Valkey だけ。admin-auth は本番は ALB 配下の ECS on Fargate で、Better Auth を OIDC Provider にして ALB の `authenticate-oidc` の IdP にする` を `本番はどちらも ALB 配下の Lambda（VPC の中。ADR-26。2026-10-12）。consent-api は DB を持たず Valkey だけ。admin-auth は Better Auth を OIDC Provider にして ALB の `authenticate-oidc` の IdP にし、運用（migrate・ALB の登録）は別の Lambda（admin-auth-ops）` にする。
2. ポートの表の 3103 の行の `本番は `auth.comegin.com`。` を `本番は `auth.comegin.com`〈ALB 配下の Lambda。ADR-26。ポートを持たない〉。` にする。6380 の行の前（5680 の行の後）に `| 5434 | admin-auth の開発の PostgreSQL（`127.0.0.1` だけ。admin-auth の結合テストが Lambda の入口から直接つなぐ） |` を足す。

- [ ] **Step 4: 要件定義・詳細設計**

1. `AA/05-application-decisions.md` の ADR-26 の帰結の最後の箇条の末尾に足す: `**（2026-10-12）③ admin-auth は `docs/superpowers/specs/2026-10-12-admin-auth-lambda-design.md` で実施した（本体と運用の Lambda 2 つ。IdP の応答時間の実測は Wave 4 で行い、遅ければプロビジョニングされた同時実行数を付ける）。**`
2. `AA/01-application-landscape.md` の admin-auth の行の `**AWS**（ECS on Fargate ＋ RDS for PostgreSQL の共有インスタンス。` を `**AWS**（VPC の中の Lambda〈本体は ALB のターゲット、運用は別の関数。ADR-26。2026-10-12〉＋ RDS for PostgreSQL の共有インスタンス。` にする。
3. `TA/06-aws-runtime.md`:
   - 14 行目の末尾（② で足した注記の後）に `（**同日、`admin-auth` も Lambda〈本体と運用の 2 つ〉になり、ECS に残るのは Mautic・Chatwoot だけになった。`docs/superpowers/specs/2026-10-12-admin-auth-lambda-design.md`**）` を足す。
   - 3.1 の `- **（2026-10-12）ADR-26 で置き換え: `consent-api` は…` の箇条の後に `- **（2026-10-12）ADR-26: `admin-auth` も VPC の中の Lambda にした**（本体は ALB のターゲット、運用〈migrate・ALB の登録〉は別の関数 `admin-auth-ops`。3.3）。表の「タスク数 1」は Lambda では予約同時実行数 5 に当たる。` を足す。
   - 3.2 の表の `consent-api` の行の後に `| **`admin-auth`** | **ECR に置かない**（Lambda。`sam build` が esbuild で zip にする。ADR-26。2026-10-12） | RDS の CA は Lambda の実行環境の `/var/runtime/ca-cert.pem` を読む（以前はイメージに同梱） |` を足す。
   - 3.3 の `- **Cal.com も起動時に自分で DB を移行する**` の箇条の後に `- **（2026-10-12）`admin-auth` の移行は、運用の Lambda（`admin-auth-ops`）の `{"action":"migrate"}` で行う**（ADR-26。1 回だけのタスクの代わり。予約同時実行数 1 で、並行して走らない）。許可リストの初期値もここで入る。` を足す。
   - 5.2.1 の `- **`admin-auth` が止まると、新しいログインだけができなくなる。**` の箇条の後に `- **（2026-10-12）`admin-auth` は Lambda になった（ADR-26）。** ALB はトークンと UserInfo を、ブラウザが同じ関数を呼んだ数秒後に呼ぶため、関数は起動済みである見込み。ALB が IdP の応答を何秒待つかは公式文書で確かめられていないので、Wave 4 で実測し、遅ければプロビジョニングされた同時実行数を付ける（`docs/superpowers/specs/2026-10-12-admin-auth-lambda-design.md` の D1）。` を足す。
   - 費用の表の Fargate の行の末尾の `〈Lambda の呼び出しと実行時間の料金に替わる〉）` の後に `（**同日、`admin-auth` も外れた**）` を足す。
   - 427 行目付近の `| `admin-auth` の Google の OAuth クライアントシークレット／ALB 用のクライアントシークレット |` の行の 3 列目の先頭に `**（2026-10-12）Lambda がコールドスタートで読む。本体は Google の分、運用の Lambda だけが ALB 用を読む**。` を足す。
4. `TA/05-observability-and-ops.md`: 項目 12 の `（**2026-10-12: `consent-api` は ADR-26 で Lambda になり、項目 23 に移した**）` の後に `（**同日、`admin-auth` も Lambda になり、項目 24 に移した**）` を足す。項目 23 の行の後に足す:

```markdown
| **24** | **admin-auth（Lambda）の失敗**（2026-10-12 に追加。ADR-26） | CloudWatch の `Errors > 0`・`Throttles > 0`（1 分）と、ターゲットグループの `HTTPCode_Target_5XX_Count ≥ 1`（5 分。DB の障害の 500 は応答として返るため `Errors` に数えられない）。`cloud/stacks/alarms.yaml` の `AdminAuth*Alarm` | SNS の `ops` に直接通知（n8n を経由しない）。**止まっても既存の ALB のセッションのあいだは誰も困らないため、この通知でしか気づけない**（新しいログインだけができなくなる）。原因（RDS・Secrets Manager・Google・同時実行数）を CloudWatch Logs とメトリクスで確かめる | `未着手`（本番は未デプロイ） |
```

5. `TA/04-security-and-secrets.md` の admin-auth の秘密値の行の `Secrets Manager（ALB 用のクライアントシークレットは ALB のリスナールールにも設定する。ALB と `admin-auth` の両方が知る必要があるため）` の後に `。**（2026-10-12 ADR-26）本番は Lambda がコールドスタートで読む。本体は `BETTER_AUTH_SECRET`・DB のパスワード・Google の 3 つ、運用の Lambda（`admin-auth-ops`）は `BETTER_AUTH_SECRET`・DB のパスワード・ALB 用の 3 つだけを読める**` を足す。
6. `TA/03-triggers-and-cicd.md` の 55 行目の `（**2026-10-12 ADR-26: `consent-api` は VPC の中の Lambda〈ALB のターゲット〉になり、ECS に置かない。`sam build` が zip にする**）` の後に `（**同日、`admin-auth` も Lambda〈本体と運用の 2 つ〉になり、ECS に置かない**）` を足す。
7. `DetailedDesign/07-failure-and-degradation.md` の 6 節の表の consent-api の行の後に足す:

```markdown
| **admin-auth**（VPC の中の Lambda。本体と運用の 2 つ。ADR-26。2026-10-12 に ECS から移した） | **新しいログイン**（管理画面の関門。ALB の IdP の呼び出しが失敗する） | **既存の ALB のセッションを持つ管理者と、訪問者向けのすべて。** コールドスタートで秘密値に届かなければ初期化の失敗（ALB は 502）で、次の呼び出しでやり直す。DB が落ちていれば 500。60 秒以上のアイドルのあとは DB の接続を作り直してから処理する | `docs/superpowers/specs/2026-10-12-admin-auth-lambda-design.md` の 5 節 |
```

- [ ] **Step 5: 取りこぼしを探す**

Run: `rg -n "admin-auth" .claude/CLAUDE.md cloud/README.md backend/admin-auth/README.md docs/RequirementDefinition/TA/06-aws-runtime.md | rg "ECS|ECR|DesiredCount|RunTask|イメージ" ; rg -n "4\.1[45]）|の 4\.1[45]" cloud/README.md backend/faq-bot/README.md`
Expected: 残るのは「以前は ECS だった」旨の注記と、過去の記録だけ。2 つ目は 4.14（Astro の配信）・4.15（開発機を止めるとき）を正しく指すものだけ。

- [ ] **Step 6: 差分を確かめる（コミットはしない）**

Run: `git status --short`

---

### Task 11: 通しの確認

**Files:** なし（確認だけ）

- [ ] **Step 1: 単体テスト・型・結合テストを通す**

Run: `cd backend/admin-auth && pnpm typecheck && pnpm exec vitest run && pnpm test:integration`
Expected: すべて PASS

- [ ] **Step 2: 開発の admin-auth のイメージを作り直す（② でユーザーが了承した範囲）**

Run: `cd backend/admin-auth && docker compose up -d --build`
Expected: `migrate` が 0 で終わり（`[migrate] allowlist bootstrap: … added` が出る）、`admin-auth-admin-auth-1` が起動する。`curl -s localhost:3103/healthz` が `ok`。

- [ ] **Step 3: 直下の既存の結合テストを流す**

Run: `cd integration && IT_SERVICES=adminAuth pnpm vitest run tests/admin-auth`（`IT_SERVICES` のキーは `integration/tests/helpers/services.ts` で確かめる）
Expected: PASS。許可リストの初期値の時機の変更で前提が崩れたテストがあれば、テスト側の前提を直す（src のバグなら `it.todo`）。

- [ ] **Step 4: IaC と文書の確認**

Run: `<scratchpad>/iac.sh`、`rg -n "AdminAuthImageTag|AdminAuthDesiredCount" cloud/`
Expected: valid・突き合わせ OK、後者は何も出ない。

- [ ] **Step 5: 仕様との突き合わせ**

`docs/superpowers/specs/2026-10-12-admin-auth-lambda-design.md` の 2〜10 節を 1 項目ずつ見て、対応する変更があることを確かめる。無ければ残作業として報告する。

- [ ] **Step 6: 最終の差分を一覧にする（コミットはしない）**

Run: `git status --short && git diff --stat`
