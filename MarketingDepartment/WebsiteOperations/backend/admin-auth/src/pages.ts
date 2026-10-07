import { randomBytes } from "node:crypto";
import { AUTH_BASE_PATH } from "./constants.js";

// 運用者にだけ見せる最小のページ。外部のスクリプト・スタイル・画像は読み込まず、インラインは nonce で許す
export interface Page {
  html: string;
  csp: string;
}

const ERROR_MESSAGES: Record<string, string> = {
  FORBIDDEN: "このアカウントでは管理画面にログインできません。Workspace のアカウントで、許可リストに載っている必要があります。",
  access_denied: "Google でのログインが取り消されました。もう一度お試しください。",
};
const DEFAULT_ERROR_MESSAGE = "ログインに失敗しました。もう一度お試しください。それでも失敗するときは管理者に連絡してください。";

function layout(title: string, body: string, script?: string): Page {
  const nonce = randomBytes(16).toString("base64");
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style nonce="${nonce}">
  body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #1a1a1a; display: grid; place-items: center; min-height: 100vh; margin: 0; }
  main { background: #fff; padding: 2rem 2.5rem; border-radius: 8px; box-shadow: 0 1px 4px rgba(0, 0, 0, .15); max-width: 28rem; }
  h1 { font-size: 1.25rem; margin-top: 0; }
  button { font: inherit; padding: .6rem 1.2rem; border: 1px solid #1a1a1a; border-radius: 4px; background: #1a1a1a; color: #fff; cursor: pointer; }
  button[disabled] { opacity: .6; cursor: default; }
  p.note { color: #555; font-size: .9rem; }
  p.error { color: #b00020; }
</style>
</head>
<body>
<main>
${body}
</main>
${script ? `<script nonce="${nonce}">\n${script}\n</script>` : ""}
</body>
</html>
`;
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  return { html, csp };
}

// 認可リクエストの署名つきクエリ（oauth_query）を、@better-auth/oauth-provider のクライアントと同じ規則で取り出す。
// 署名の検証はサーバー側が行う
const SIGN_IN_SCRIPT = `
const button = document.getElementById("sign-in");
const message = document.getElementById("message");

function buildSignedOAuthQuery(search) {
  const params = new URLSearchParams(search);
  if (!params.has("sig")) return undefined;
  const names = new Set(params.getAll("ba_param"));
  if (names.size === 0) return undefined;
  const signed = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    if (key === "sig" || key === "ba_param" || names.has(key)) signed.append(key, value);
  }
  return signed.toString();
}

button.addEventListener("click", async () => {
  button.disabled = true;
  message.textContent = "";
  try {
    const response = await fetch("${AUTH_BASE_PATH}/sign-in/social", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        provider: "google",
        callbackURL: "/",
        errorCallbackURL: "/error",
        oauth_query: buildSignedOAuthQuery(window.location.search),
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.url) throw new Error("sign-in failed");
    window.location.assign(data.url);
  } catch {
    message.textContent = "ログインを開始できませんでした。もう一度お試しください。";
    button.disabled = false;
  }
});
`;

export function signInPage(): Page {
  return layout(
    "管理画面へのログイン",
    `<h1>管理画面へのログイン</h1>
<p>Google Workspace のアカウントでログインしてください。管理者の許可リストに載っているアカウントだけが入れます。</p>
<p><button id="sign-in" type="button">Google でログイン</button></p>
<p id="message" class="error" role="alert"></p>`,
    SIGN_IN_SCRIPT,
  );
}

// 管理画面の ALB は skip_consent で登録するため、通常は表示されない
export function consentPage(): Page {
  return layout(
    "同意は不要です",
    `<h1>この画面は使いません</h1>
<p class="note">管理画面のログインでは、同意の確認を行いません。この画面が表示されたときは、クライアントの登録（skip_consent）を確認してください。</p>`,
  );
}

export function errorPage(code: string | null): Page {
  // 自前のキーだけを見る（constructor・__proto__・toString などプロトタイプのプロパティを文言にしない）
  const message = (code && Object.hasOwn(ERROR_MESSAGES, code) && ERROR_MESSAGES[code]) || DEFAULT_ERROR_MESSAGE;
  return layout(
    "ログインできません",
    `<h1>ログインできません</h1>
<p class="error">${message}</p>
<p><a href="/sign-in">ログインの画面へ戻る</a></p>
<p class="note">管理画面から来た場合は、ブラウザで管理画面を開き直すと、もう一度ログインを始められます。</p>`,
  );
}
