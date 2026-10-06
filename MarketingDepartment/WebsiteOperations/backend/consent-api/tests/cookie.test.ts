import { describe, expect, it } from "vitest";
import { COOKIE_NAME, ID_PATTERN } from "../src/constants.js";
import { buildSetCookie, issueId, readCookieId } from "../src/cookie.js";
import { makeConfig } from "./helpers/config.js";

const VALID_ID = "eAd5tbgdBQH8cAOA_oELjQ";

/** Set-Cookie の値を「名前=値」と属性の一覧に分ける */
function parseSetCookie(header: string) {
  const [pair, ...attributes] = header.split("; ");
  const separator = pair!.indexOf("=");
  return {
    name: pair!.slice(0, separator),
    value: pair!.slice(separator + 1),
    attributes: attributes.map((attribute) => attribute.split("=")[0]!.toLowerCase()),
    attribute: (key: string) =>
      attributes.find((attribute) => attribute.toLowerCase().startsWith(`${key.toLowerCase()}=`))?.split("=")[1],
  };
}

describe("issueId", () => {
  it("128 ビット（16 バイト）を base64url にした 22 文字を返す", () => {
    const id = issueId();
    expect(id).toMatch(ID_PATTERN);
    expect(Buffer.from(id, "base64url")).toHaveLength(16);
  });

  it("呼ぶたびに別の値になる", () => {
    const ids = new Set(Array.from({ length: 100 }, () => issueId()));
    expect(ids.size).toBe(100);
  });
});

describe("readCookieId", () => {
  it("Cookie ヘッダーが無ければ null", () => {
    expect(readCookieId(undefined)).toBeNull();
    expect(readCookieId("")).toBeNull();
  });

  it("同意の Cookie から識別子を取り出す", () => {
    expect(readCookieId(`${COOKIE_NAME}=s=granted&v=2026-10-01&id=${VALID_ID}`)).toBe(VALID_ID);
  });

  it("ほかの Cookie と並んでいても、名前で探して取り出す", () => {
    const header = `ph_session=abc; ${COOKIE_NAME}=s=denied&v=2026-10-01&id=${VALID_ID}; cw_conversation=xyz`;
    expect(readCookieId(header)).toBe(VALID_ID);
  });

  it("前後の空白を無視する", () => {
    expect(readCookieId(`   ${COOKIE_NAME} =  s=granted&id=${VALID_ID}  `)).toBe(VALID_ID);
  });

  it("値の中の項目の順番に依存しない", () => {
    expect(readCookieId(`${COOKIE_NAME}=id=${VALID_ID}&s=granted&v=1`)).toBe(VALID_ID);
  });

  it("名前が一部だけ一致する別の Cookie は読まない", () => {
    expect(readCookieId(`x${COOKIE_NAME}=id=${VALID_ID}`)).toBeNull();
    expect(readCookieId(`${COOKIE_NAME}_old=id=${VALID_ID}`)).toBeNull();
  });

  it("同意の Cookie が無ければ null", () => {
    expect(readCookieId(`other=id=${VALID_ID}; noequals`)).toBeNull();
  });

  it("id の項目が無ければ null", () => {
    expect(readCookieId(`${COOKIE_NAME}=s=granted&v=2026-10-01`)).toBeNull();
  });

  it.each([
    ["短い", "abc"],
    ["長い", `${VALID_ID}x`],
    ["使えない文字", "eAd5tbgdBQH8cAOA.oELjQ"],
    ["空", ""],
  ])("識別子の形式が違えば（%s）null", (_label, id) => {
    expect(readCookieId(`${COOKIE_NAME}=s=granted&id=${id}`)).toBeNull();
  });
});

describe("buildSetCookie", () => {
  it("値は状態・ポリシーの版・識別子の 3 つだけで、URLSearchParams でそのまま読める", () => {
    const cookie = parseSetCookie(buildSetCookie(makeConfig(), "granted", VALID_ID));
    expect(cookie.name).toBe(COOKIE_NAME);
    expect(cookie.value).toBe(`s=granted&v=2026-10-01&id=${VALID_ID}`);
    expect([...new URLSearchParams(cookie.value).keys()]).toEqual(["s", "v", "id"]);
  });

  it("撤回（denied）もそのまま状態として書く", () => {
    const value = parseSetCookie(buildSetCookie(makeConfig(), "denied", VALID_ID)).value;
    expect(new URLSearchParams(value).get("s")).toBe("denied");
  });

  it("ポリシーの版は設定の CONSENT_POLICY_VERSION を使う", () => {
    const value = parseSetCookie(buildSetCookie(makeConfig({ CONSENT_POLICY_VERSION: "v2" }), "granted", VALID_ID))
      .value;
    expect(new URLSearchParams(value).get("v")).toBe("v2");
  });

  it("Max-Age は 12 か月、Path は /、Secure と SameSite=Lax を付ける", () => {
    const cookie = parseSetCookie(buildSetCookie(makeConfig(), "granted", VALID_ID));
    expect(cookie.attribute("Max-Age")).toBe(String(365 * 24 * 60 * 60));
    expect(cookie.attribute("Path")).toBe("/");
    expect(cookie.attributes).toContain("secure");
    expect(cookie.attribute("SameSite")).toBe("Lax");
  });

  it("HttpOnly は付けない（ページの描画時に JS が同期で読むため）", () => {
    expect(buildSetCookie(makeConfig(), "granted", VALID_ID).toLowerCase()).not.toContain("httponly");
  });

  it("COOKIE_DOMAIN があれば Domain 属性を付ける", () => {
    const cookie = parseSetCookie(buildSetCookie(makeConfig({ COOKIE_DOMAIN: ".comegin.com" }), "granted", VALID_ID));
    expect(cookie.attribute("Domain")).toBe(".comegin.com");
  });

  it("COOKIE_DOMAIN が空なら Domain 属性を付けない（開発の localhost）", () => {
    const cookie = parseSetCookie(buildSetCookie(makeConfig({ COOKIE_DOMAIN: "" }), "granted", VALID_ID));
    expect(cookie.attributes).not.toContain("domain");
  });

  it("書いた Cookie を readCookieId で読み戻せる", () => {
    const header = buildSetCookie(makeConfig(), "granted", VALID_ID).split("; ")[0]!;
    expect(readCookieId(header)).toBe(VALID_ID);
  });
});
