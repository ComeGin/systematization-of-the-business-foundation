import { describe, expect, it } from "vitest";
import { VT } from "@/modules/page-transition/lib/names";
import {
  createMorph,
  morphTargetsFor,
  normalizePath,
  pageRevealScript,
} from "@/modules/page-transition/lib/morph";
import { shouldSkipTransition } from "@/modules/page-transition/lib/rules";

describe("normalizePath", () => {
  describe("正常系", () => {
    it("末尾のスラッシュを足し、クエリとハッシュを外す", () => {
      expect(normalizePath("/contact")).toBe("/contact/");
      expect(normalizePath("/contact/?cta=x&from=/")).toBe("/contact/");
      expect(normalizePath("/services/development#plans")).toBe(
        "/services/development/",
      );
    });
    it("絶対 URL はパスだけにする", () => {
      expect(normalizePath("https://comegin.com/blog/hello?x=1")).toBe(
        "/blog/hello/",
      );
    });
  });
  describe("異常系", () => {
    it("空入力: 空文字は空文字", () => expect(normalizePath("")).toBe(""));
  });
});

describe("morphTargetsFor", () => {
  describe("正常系", () => {
    it("サービス詳細は見出しだけ", () => {
      expect(morphTargetsFor("/services/development/")).toEqual([
        VT.serviceTitle,
      ]);
    });
    it("記事は見出しとアイキャッチ", () => {
      expect(morphTargetsFor("/blog/hello-world/")).toEqual([
        VT.articleTitle,
        VT.articleMedia,
      ]);
    });
    it("お問い合わせは見出し", () => {
      expect(morphTargetsFor("/contact/")).toEqual([VT.contactTitle]);
    });
    it("末尾のスラッシュの有無とクエリ・ハッシュを同じに扱う", () => {
      expect(morphTargetsFor("/contact/?cta=x")).toEqual([VT.contactTitle]);
      expect(morphTargetsFor("/contact?cta=x")).toEqual([VT.contactTitle]);
      expect(morphTargetsFor("/services/consulting")).toEqual([
        VT.serviceTitle,
      ]);
      expect(morphTargetsFor("/blog/hello-world#toc")).toEqual([
        VT.articleTitle,
        VT.articleMedia,
      ]);
    });
    it("それ以外は []", () => {
      for (const p of ["/", "/services/", "/blog/", "/pricing/", "/about/"])
        expect(morphTargetsFor(p)).toEqual([]);
    });
  });
  describe("異常系", () => {
    it("空入力: 空文字は []", () => expect(morphTargetsFor("")).toEqual([]));
    it("入力: /blog/page/2/ と /blog/category/x/ は []", () => {
      expect(morphTargetsFor("/blog/page/2/")).toEqual([]);
      expect(morphTargetsFor("/blog/category/x/")).toEqual([]);
      expect(morphTargetsFor("/blog/page/")).toEqual([]);
      expect(morphTargetsFor("/blog/category/")).toEqual([]);
    });
    it("入力: /legal/privacy/ は []", () =>
      expect(morphTargetsFor("/legal/privacy/")).toEqual([]));
    it("入力: 2 段より深いサービス・記事のパスは []", () => {
      expect(morphTargetsFor("/services/development/extra/")).toEqual([]);
      expect(morphTargetsFor("/blog/a/b/")).toEqual([]);
    });
  });
});

describe("revealTargetsFor", () => {
  const { revealTargetsFor } = createMorph(VT, shouldSkipTransition);
  describe("正常系", () => {
    it("詳細から一覧へ戻るときは、移動元の種類の名前", () => {
      expect(revealTargetsFor("/services/development/", "/services/")).toEqual([
        VT.serviceTitle,
      ]);
    });
    it("記事からブログ一覧・ページ送り・カテゴリへ戻るときは、記事の名前", () => {
      for (const to of ["/blog/", "/blog/page/2/", "/blog/category/x/", "/"]) {
        expect(revealTargetsFor("/blog/a/", to)).toEqual([
          VT.articleTitle,
          VT.articleMedia,
        ]);
      }
    });
    it("記事から記事へ移るときは [] （移動元のカードの側が名前を付ける。名前の取り合いを避ける）", () => {
      expect(revealTargetsFor("/blog/a/", "/blog/b/")).toEqual([]);
    });
  });
  describe("異常系", () => {
    it("空入力: 移動元が空なら []", () =>
      expect(revealTargetsFor("", "/services/")).toEqual([]));
    it("入力: カードの無いページ（/pricing/・/about/・/contact/）へ移るときは []", () => {
      for (const to of ["/pricing/", "/about/", "/contact/"]) {
        expect(revealTargetsFor("/services/development/", to)).toEqual([]);
      }
    });
  });
});

describe("pageRevealScript", () => {
  describe("正常系", () => {
    it("import なしの classic script として単独で評価できる（head の inline に埋める文字列）", () => {
      const listeners: Record<string, unknown> = {};
      const win = {
        addEventListener: (type: string, fn: unknown) => (listeners[type] = fn),
      };
      // 文字列を、window だけを引数に取る関数として評価する（モジュールの束縛に頼っていないこと）
      new Function("window", pageRevealScript())(win);
      expect(typeof listeners.pagereveal).toBe("function");
    });
  });
  describe("異常系", () => {
    it("入力: バンドラー・テストの道具が差し込む識別子（__name・__vite_ssr・cov_）と /** の説明のコメントを含まない", () => {
      const script = pageRevealScript();
      for (const marker of ["__name", "__vite_ssr", "cov_", "/**"])
        expect(script).not.toContain(marker);
    });
  });
});

describe("installReveal（本文を読み終えるまで最初の描画を待たせる）", () => {
  /** head に足された要素を集める、window の最小の替え玉 */
  function fakeWindow(
    fromUrl: string | null,
    pathname: string,
    reducedMotion = false,
  ) {
    const appended: Record<string, string>[] = [];
    const win = {
      navigation: { activation: { from: fromUrl ? { url: fromUrl } : null } },
      location: { pathname },
      matchMedia: (query: string) => ({
        matches: reducedMotion && query.includes("reduce"),
      }),
      addEventListener: () => {},
      document: {
        head: {
          appendChild: (el: Record<string, string>) => appended.push(el),
        },
        createElement: () => {
          const el: Record<string, string> & {
            setAttribute?: (k: string, v: string) => void;
          } = {};
          el.setAttribute = (k, v) => (el[k] = v);
          return el;
        },
      },
    };
    return { win: win as unknown as Window, appended };
  }
  const { installReveal } = createMorph(VT, shouldSkipTransition);

  describe("正常系", () => {
    it("詳細から /services/ へ戻るときは、#site-footer を待つ rel=expect を head に足す", () => {
      const { win, appended } = fakeWindow(
        "https://comegin.com/services/development/",
        "/services/",
      );
      installReveal(win, "site-footer");
      expect(appended).toHaveLength(1);
      expect(appended[0]).toMatchObject({
        rel: "expect",
        href: "#site-footer",
        blocking: "render",
      });
    });
  });
  describe("異常系", () => {
    it("空入力: 移動元が無い（直接の訪問）ときは足さない", () => {
      const { win, appended } = fakeWindow(null, "/services/");
      installReveal(win, "site-footer");
      expect(appended).toHaveLength(0);
    });
    it("入力: 詳細から /pricing/（カードの無いページ）へ移るときは足さない", () => {
      const { win, appended } = fakeWindow(
        "https://comegin.com/services/development/",
        "/pricing/",
      );
      installReveal(win, "site-footer");
      expect(appended).toHaveLength(0);
    });
    it("入力: reduced-motion のときは、詳細から一覧へ戻っても足さない", () => {
      const { win, appended } = fakeWindow(
        "https://comegin.com/services/development/",
        "/services/",
        true,
      );
      installReveal(win, "site-footer");
      expect(appended).toHaveLength(0);
    });
    it("入力: 記事から記事・C のページへの移動では足さない", () => {
      const a = fakeWindow("https://comegin.com/blog/a/", "/blog/b/");
      installReveal(a.win, "site-footer");
      expect(a.appended).toHaveLength(0);
      const c = fakeWindow(
        "https://comegin.com/services/development/",
        "/legal/privacy/",
      );
      installReveal(c.win, "site-footer");
      expect(c.appended).toHaveLength(0);
    });
  });
});
