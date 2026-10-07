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
  describe("正常系", () => {
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
});

describe("readCookieId", () => {
  describe("正常系", () => {
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

    it("ほかの Cookie がたくさん並んでいても（数 KiB）、同意の Cookie を探し出す", () => {
      const others = Array.from({ length: 200 }, (_, i) => `c${i}=${"v".repeat(20)}`).join("; ");
      expect(readCookieId(`${others}; ${COOKIE_NAME}=id=${VALID_ID}`)).toBe(VALID_ID);
    });
  });

  describe("異常系", () => {
    it("空入力: Cookie ヘッダーが無ければ null", () => {
      expect(readCookieId(undefined)).toBeNull();
      expect(readCookieId("")).toBeNull();
    });

    it.each(["   ", ";", "; ;", `${COOKIE_NAME}=`, `${COOKIE_NAME}=   `])(
      "空入力: 空白や区切りだけ・値が空のヘッダー（%j）は null",
      (header) => {
        expect(readCookieId(header)).toBeNull();
      },
    );

    it("入力: 名前が一部だけ一致する別の Cookie は読まない", () => {
      expect(readCookieId(`x${COOKIE_NAME}=id=${VALID_ID}`)).toBeNull();
      expect(readCookieId(`${COOKIE_NAME}_old=id=${VALID_ID}`)).toBeNull();
    });

    it("入力: 名前の大文字小文字が違う Cookie は読まない", () => {
      expect(readCookieId(`${COOKIE_NAME.toUpperCase()}=id=${VALID_ID}`)).toBeNull();
    });

    it("入力: 同意の Cookie が無ければ null", () => {
      expect(readCookieId(`other=id=${VALID_ID}; noequals`)).toBeNull();
    });

    it("入力: id の項目が無ければ null", () => {
      expect(readCookieId(`${COOKIE_NAME}=s=granted&v=2026-10-01`)).toBeNull();
    });

    it.each([
      ["短い", "abc"],
      ["長い", `${VALID_ID}x`],
      ["使えない文字", "eAd5tbgdBQH8cAOA.oELjQ"],
      ["空", ""],
      ["パス区切り", "../../../../etc/passwd"],
      ["+ が空白に読み替わる", "eAd5tbgdBQH8cAOA+oELjQ"],
      ["Valkey のキーの区切り", "eAd5tbgdBQH8:AOA_oELjQ"],
    ])("入力: 識別子の形式が違えば（%s）null", (_label, id) => {
      expect(readCookieId(`${COOKIE_NAME}=s=granted&id=${id}`)).toBeNull();
    });

    it("入力: 同名の Cookie が複数あれば最初の 1 つだけを見る（後ろの識別子に読み替えない）", () => {
      const header = `${COOKIE_NAME}=id=broken; ${COOKIE_NAME}=id=${VALID_ID}`;
      expect(readCookieId(header)).toBeNull();
    });

    it("入力: 値の中に id が 2 つあれば最初のものを使い、形式が違えば null", () => {
      expect(readCookieId(`${COOKIE_NAME}=id=${VALID_ID}&id=AAAAAAAAAAAAAAAAAAAAAA`)).toBe(VALID_ID);
      expect(readCookieId(`${COOKIE_NAME}=id=x&id=${VALID_ID}`)).toBeNull();
    });

    it("入力: 大きすぎる識別子（数 KiB）でも例外を投げず null", () => {
      expect(readCookieId(`${COOKIE_NAME}=id=${"a".repeat(8_192)}`)).toBeNull();
    });
  });
});

describe("buildSetCookie", () => {
  describe("正常系", () => {
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

    it("空入力: COOKIE_DOMAIN が空なら Domain 属性を付けない（開発の localhost）", () => {
      const cookie = parseSetCookie(buildSetCookie(makeConfig({ COOKIE_DOMAIN: "" }), "granted", VALID_ID));
      expect(cookie.attributes).not.toContain("domain");
    });

    it("書いた Cookie を readCookieId で読み戻せる", () => {
      const header = buildSetCookie(makeConfig(), "granted", VALID_ID).split("; ")[0]!;
      expect(readCookieId(header)).toBe(VALID_ID);
    });
  });
});
