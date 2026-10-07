import { describe, expect, it } from "vitest";
import { NAVIGATION_ITEMS, resolveRoute } from "@/components/layout/routes";
import { SAMPLE_RUN_ID } from "../../helpers/control-plane";

const ROOT = { text: "監視アプリ", href: "/" };
const RUNS = { text: "実行記録", href: "/runs" };
const JOBS = { text: "定期実行のジョブ", href: "/jobs" };

describe("resolveRoute", () => {
  describe("正常系", () => {
    it("/runs は実行記録の一覧（表）", () => {
      expect(resolveRoute("/runs")).toEqual({
        breadcrumbs: [ROOT, RUNS],
        activeHref: "/runs",
        help: "runs-list",
        contentType: "table",
      });
    });

    it("/runs/new は手動の起動（フォーム）で、ナビゲーションは「手動の起動」を選ぶ", () => {
      expect(resolveRoute("/runs/new")).toEqual({
        breadcrumbs: [ROOT, RUNS, { text: "手動の起動", href: "/runs/new" }],
        activeHref: "/runs/new",
        help: "runs-new",
        contentType: "form",
      });
    });

    it("/runs/<run_id> は実行の詳細で、パンくずの末尾は run_id、ナビゲーションは一覧を選ぶ", () => {
      expect(resolveRoute(`/runs/${SAMPLE_RUN_ID}`)).toEqual({
        breadcrumbs: [ROOT, RUNS, { text: SAMPLE_RUN_ID, href: `/runs/${SAMPLE_RUN_ID}` }],
        activeHref: "/runs",
        help: "run-detail",
        contentType: "default",
      });
    });

    it("/jobs はジョブの一覧（表）", () => {
      expect(resolveRoute("/jobs")).toEqual({ breadcrumbs: [ROOT, JOBS], activeHref: "/jobs", help: "jobs-list", contentType: "table" });
    });

    it("/jobs/<id> はジョブの詳細。id が new でも詳細として扱う（ジョブには新規の画面が無い）", () => {
      expect(resolveRoute("/jobs/daily-seo")).toEqual({
        breadcrumbs: [ROOT, JOBS, { text: "daily-seo", href: "/jobs/daily-seo" }],
        activeHref: "/jobs",
        help: "job-detail",
        contentType: "default",
      });
      expect(resolveRoute("/jobs/new").help).toBe("job-detail");
    });

    it("/miswrite-candidates は誤った書き込みの候補の一覧（表）。下の階層があっても一覧として扱う", () => {
      const expected = {
        breadcrumbs: [ROOT, { text: "誤った書き込みの候補", href: "/miswrite-candidates" }],
        activeHref: "/miswrite-candidates",
        help: "miswrite-candidates",
        contentType: "table",
      };
      expect(resolveRoute("/miswrite-candidates")).toEqual(expected);
      expect(resolveRoute("/miswrite-candidates/x")).toEqual(expected);
    });

    it("末尾のスラッシュは無視する", () => {
      expect(resolveRoute("/runs/").help).toBe("runs-list");
      expect(resolveRoute("/jobs/daily-seo/").breadcrumbs.at(-1)).toEqual({ text: "daily-seo", href: "/jobs/daily-seo/" });
    });

    it("パンくずの文はパーセントエンコードを戻して出し、リンクは元のパスのままにする", () => {
      const pathname = "/jobs/%E6%97%A5%E6%AC%A1";
      expect(resolveRoute(pathname).breadcrumbs.at(-1)).toEqual({ text: "日次", href: pathname });
    });

    it("返すパンくずは呼び出しごとの新しい配列で、共有の定数を書き換えない", () => {
      const first = resolveRoute("/runs");
      first.breadcrumbs.push({ text: "x", href: "/x" });
      expect(resolveRoute("/runs").breadcrumbs).toEqual([ROOT, RUNS]);
    });
  });

  describe("異常系", () => {
    it.each(["/login", "/RUNS", "/unknown/page"])("入力: 知らないパス（%s）はパンくずを先頭だけにし、ヘルプを出さない", (pathname) => {
      expect(resolveRoute(pathname)).toEqual({ breadcrumbs: [ROOT], activeHref: pathname, help: null, contentType: "default" });
    });

    it.each(["/", ""])("空入力: パス「%s」は先頭だけのパンくずにし、ヘルプを出さない", (pathname) => {
      expect(resolveRoute(pathname)).toEqual({ breadcrumbs: [ROOT], activeHref: pathname, help: null, contentType: "default" });
    });

    // Next.js は壊れたパーセントエンコードの URL を DecodeError として 400 で返すため、usePathname() からは届かない前提。
    // 届いた場合は decodeURIComponent の URIError がそのまま出る（外枠ごと描けない）ことを記録しておく
    it("入力: 壊れたパーセントエンコードは URIError を投げる（Next.js が 400 で返すため画面には届かない）", () => {
      expect(() => resolveRoute("/jobs/%E0%A4%A")).toThrow(URIError);
    });
  });
});

describe("NAVIGATION_ITEMS", () => {
  describe("正常系", () => {
    it("サイドのナビゲーションは実行記録・手動の起動・ジョブ・候補の順で、すべてアプリ内のパス", () => {
      expect(NAVIGATION_ITEMS.map((item) => item.href)).toEqual(["/runs", "/runs/new", "/jobs", "/miswrite-candidates"]);
      for (const item of NAVIGATION_ITEMS) expect(item.text).not.toBe("");
    });

    it("ナビゲーションの各項目は、resolveRoute で自分自身を選択中にする", () => {
      for (const item of NAVIGATION_ITEMS) expect(resolveRoute(item.href).activeHref).toBe(item.href);
    });
  });
});
