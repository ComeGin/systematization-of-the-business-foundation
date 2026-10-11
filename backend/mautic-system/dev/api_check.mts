/**
 * Mautic API 動作確認スクリプト（OAuth2 Authorization Code フロー）
 *
 * 処理の流れ:
 *   1. ブラウザで認可画面を開き、ローカルのコールバックサーバーで認可コードを受け取る
 *   2. 認可コードをアクセストークンに交換する
 *   3. 簡単な参照 API（/api/users/self, /api/contacts）を呼び出す
 *
 * 事前準備:
 *   Mautic 管理画面 > 設定 > API 認証情報 で OAuth2 クライアントを作成し、
 *   リダイレクト URI に MAUTIC_REDIRECT_URI と同じ値（既定: http://localhost:8765/callback）を登録する。
 *
 * 実行例（Node.js 23.6 以上。型注釈をそのまま除去して実行するため依存パッケージ不要）:
 *   export MAUTIC_CLIENT_ID=...
 *   export MAUTIC_CLIENT_SECRET=...
 *   node dev/api_check.mts   # mautic-system 直下から（dev/ 内なら node api_check.mts）
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const BASE_URL = (process.env.MAUTIC_BASE_URL ?? "https://comegin-mautic-dev.ngrok.app").replace(/\/+$/, "");
const REDIRECT_URI = process.env.MAUTIC_REDIRECT_URI ?? "http://localhost:8765/callback";
const CALLBACK_TIMEOUT_MS = 300_000;
const HTTP_TIMEOUT_MS = 30_000;

type TokenResponse = {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope: string | null;
  refresh_token?: string;
};

type MauticUser = {
  id: number;
  username: string;
  email: string;
  role?: { name: string } | null;
};

type MauticContact = {
  id: number;
  fields?: { all?: Record<string, string | null> };
};

type ContactListResponse = {
  total: string | number;
  // 該当 0 件の場合、Mautic は contacts を {} ではなく [] で返す
  contacts: Record<string, MauticContact> | [];
};

function fail(message: string): never {
  console.error(`[ERROR] ${message}`);
  process.exit(1);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) fail(`環境変数 ${name} が未設定です`);
  return value;
}

function mask(token: string): string {
  return token.length > 12 ? `${token.slice(0, 6)}...${token.slice(-4)}` : "***";
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  // ブラウザを開けなくても、表示済みの URL を手動で開けば続行できる
  spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

// ---------------------------------------------------------------------------
// 1. 認可コードの取得
// ---------------------------------------------------------------------------
async function fetchAuthorizationCode(clientId: string): Promise<string> {
  // Mautic（oauth2-php）は PKCE 非対応のため、state で CSRF を防ぐ
  const state = randomBytes(32).toString("base64url");
  const redirect = new URL(REDIRECT_URI);

  const params = await new Promise<URLSearchParams>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end();
        return;
      }

      const ok = url.searchParams.has("code") && url.searchParams.get("state") === state;
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(ok ? "認可コードを受け取りました。ターミナルに戻ってください。" : "認可に失敗しました。");

      clearTimeout(timer);
      server.close();
      resolve(url.searchParams);
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`${CALLBACK_TIMEOUT_MS / 1000} 秒以内にコールバックを受信できませんでした`));
    }, CALLBACK_TIMEOUT_MS);

    server.on("error", reject);
    server.listen(Number(redirect.port || 80), redirect.hostname, () => {
      const authorizeUrl = new URL(`${BASE_URL}/oauth/v2/authorize`);
      authorizeUrl.search = new URLSearchParams({
        client_id: clientId,
        grant_type: "authorization_code",
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        state,
      }).toString();

      console.log("[1/3] 認可コードを取得します");
      console.log(`      ブラウザが開かない場合は次の URL を開いてください:\n      ${authorizeUrl}`);
      openBrowser(authorizeUrl.toString());
    });
  }).catch((error: Error) => fail(error.message));

  const error = params.get("error");
  if (error) fail(`認可エラー: ${error} - ${params.get("error_description") ?? ""}`);
  if (params.get("state") !== state) fail("state が一致しません（CSRF の可能性があるため中断します）");
  const code = params.get("code");
  if (!code) fail(`コールバックに code が含まれていません: ${params}`);

  console.log(`      OK: code=${mask(code)}`);
  return code;
}

// ---------------------------------------------------------------------------
// 2. 認可コード → アクセストークン
// ---------------------------------------------------------------------------
async function exchangeCodeForToken(clientId: string, clientSecret: string, code: string): Promise<TokenResponse> {
  console.log("[2/3] 認可コードをアクセストークンに交換します");
  const response = await fetch(`${BASE_URL}/oauth/v2/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      // 認可リクエスト時と同じ値でなければ redirect_uri_mismatch になる
      redirect_uri: REDIRECT_URI,
      code,
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) fail(`トークン交換に失敗しました (${response.status}): ${await response.text()}`);

  const token = (await response.json()) as TokenResponse;
  console.log(
    `      OK: access_token=${mask(token.access_token)} expires_in=${token.expires_in}s ` +
      `refresh_token=${token.refresh_token ? "あり" : "なし"}`,
  );
  return token;
}

// ---------------------------------------------------------------------------
// 3. 参照 API
// ---------------------------------------------------------------------------
async function callApi<T>(accessToken: string, path: string, query: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${BASE_URL}/api${path}`);
  url.search = new URLSearchParams(query).toString();

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) fail(`GET /api${path} が失敗しました (${response.status}): ${await response.text()}`);
  return (await response.json()) as T;
}

async function runReadApis(accessToken: string): Promise<void> {
  console.log("[3/3] 参照 API を呼び出します");

  const me = await callApi<MauticUser>(accessToken, "/users/self");
  console.log(`      GET /api/users/self -> id=${me.id} username=${me.username} role=${me.role?.name}`);

  const { total, contacts } = await callApi<ContactListResponse>(accessToken, "/contacts", {
    limit: "5",
    orderBy: "id",
    orderByDir: "DESC",
    minimal: "true",
  });
  console.log(`      GET /api/contacts   -> total=${total}`);
  for (const contact of Object.values(contacts)) {
    const fields = contact.fields?.all ?? {};
    console.log(`        - id=${contact.id} email=${fields.email} name=${fields.firstname} ${fields.lastname}`);
  }

  if (process.env.MAUTIC_VERBOSE) console.log(JSON.stringify(me, null, 2));
}

async function main(): Promise<void> {
  const clientId = requireEnv("MAUTIC_CLIENT_ID");
  const clientSecret = requireEnv("MAUTIC_CLIENT_SECRET");
  console.log(`Mautic: ${BASE_URL}\nRedirect URI: ${REDIRECT_URI}\n`);

  const code = await fetchAuthorizationCode(clientId);
  const token = await exchangeCodeForToken(clientId, clientSecret, code);
  await runReadApis(token.access_token);

  console.log("\n動作確認が完了しました");
}

await main();
