import { describe, expect, it } from "vitest";
import { consentPage, errorPage, signInPage } from "../src/pages.js";

function nonceOf(csp: string): string {
  const match = /script-src 'nonce-([^']+)'/.exec(csp);
  if (!match?.[1]) throw new Error("nonce not found");
  return match[1];
}

/** ログイン画面に埋め込んだ buildSignedOAuthQuery を取り出して、関数として評価する */
function extractBuildSignedOAuthQuery(html: string): (search: string) => string | undefined {
  const match = /function buildSignedOAuthQuery\(search\) \{[\s\S]*?\n\}/.exec(html);
  if (!match) throw new Error("buildSignedOAuthQuery not found");
  return new Function(`${match[0]}\nreturn buildSignedOAuthQuery;`)() as (search: string) => string | undefined;
}

describe("CSP と nonce", () => {
  it("外部のリソースを読み込めない CSP にする", () => {
    const { csp } = signInPage();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
  });

  it("インラインの script と style は CSP と同じ nonce を持つ", () => {
    const { html, csp } = signInPage();
    const nonce = nonceOf(csp);
    expect(csp).toContain(`style-src 'nonce-${nonce}'`);
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
  });

  it("nonce はページを作るたびに変わる", () => {
    expect(nonceOf(signInPage().csp)).not.toBe(nonceOf(signInPage().csp));
  });

  it("検索エンジンに載せない", () => {
    expect(errorPage(null).html).toContain('<meta name="robots" content="noindex, nofollow">');
  });
});

describe("signInPage", () => {
  it("Better Auth のソーシャルログインへ Google を指定して POST し、失敗時は /error へ戻す", () => {
    const { html } = signInPage();
    expect(html).toContain('fetch("/api/auth/sign-in/social"');
    expect(html).toContain('provider: "google"');
    expect(html).toContain('errorCallbackURL: "/error"');
    expect(html).toContain('credentials: "same-origin"');
  });

  describe("buildSignedOAuthQuery（署名つきの認可クエリの取り出し）", () => {
    const build = extractBuildSignedOAuthQuery(signInPage().html);

    it("sig が無ければ undefined", () => {
      expect(build("?client_id=a&ba_param=client_id")).toBeUndefined();
    });

    it("ba_param が無ければ undefined", () => {
      expect(build("?client_id=a&sig=s")).toBeUndefined();
    });

    it("署名の対象（ba_param に挙げた名前）と sig・ba_param だけを残し、順序を保つ", () => {
      const query = build("?client_id=a&extra=x&state=s1&ba_param=client_id&ba_param=state&sig=SIG");
      expect(query).toBe("client_id=a&state=s1&ba_param=client_id&ba_param=state&sig=SIG");
    });

    it("同じ名前の値が複数あればすべて残す", () => {
      expect(build("?scope=a&scope=b&ba_param=scope&sig=x")).toBe("scope=a&scope=b&ba_param=scope&sig=x");
    });
  });
});

describe("consentPage", () => {
  it("スクリプトを含まない", () => {
    expect(consentPage().html).not.toContain("<script");
  });

  it("skip_consent の確認を促す", () => {
    expect(consentPage().html).toContain("skip_consent");
  });
});

describe("errorPage", () => {
  it("FORBIDDEN は許可リストの説明を出す", () => {
    expect(errorPage("FORBIDDEN").html).toContain("許可リストに載っている必要があります");
  });

  it("access_denied はログインの取り消しの説明を出す", () => {
    expect(errorPage("access_denied").html).toContain("Google でのログインが取り消されました");
  });

  it("コードが無いときは既定の文言を出す", () => {
    expect(errorPage(null).html).toContain("ログインに失敗しました");
  });

  it("未知のコードは既定の文言にし、クエリの値を HTML に埋め込まない（XSS にならない）", () => {
    const payload = `"><script>alert(1)</script><img src=x onerror=alert(1)>`;
    const { html } = errorPage(payload);
    expect(html).toContain("ログインに失敗しました");
    expect(html).not.toContain(payload);
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("<script");
  });

  it("大文字小文字が違うコードは既知のコードとみなさない", () => {
    expect(errorPage("forbidden").html).toContain("ログインに失敗しました");
  });

  it.todo("不具合候補: error=constructor / __proto__ / toString など Object.prototype のプロパティ名で、既定の文言ではなく 'function Object() { [native code] }' や '[object Object]' が表示される（src/pages.ts:119。ERROR_MESSAGES がプロトタイプを持つ通常のオブジェクトで、in/hasOwn の確認がない）");

  it("戻り先はログインの画面", () => {
    expect(errorPage(null).html).toContain('<a href="/sign-in">');
  });

  it("エラー画面にはスクリプトを含まない", () => {
    expect(errorPage("FORBIDDEN").html).not.toContain("<script");
  });
});
