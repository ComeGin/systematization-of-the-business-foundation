// pnpm a11y の globalTeardown。ページごとの結果（.a11y/pages/<project>/<slug>.json）を
// .a11y/summary.json に 1 本にまとめる。builtin の a11y ジョブは .a11y/ 直下の *.json だけを
// 作業ツリーへ写し、quality-checker（項目 6）は summary.json だけを読む。
//
// ■ summary.json の形式（version 1）
// {
//   "version": 1,
//   "tool": "axe-core",
//   "axe_version": "4.11.0",          // axe-core の版（results.testEngine.version）
//   "tags": ["wcag2a", ...],          // AxeBuilder.withTags に渡したタグ
//   "measured_at": "<ISO 8601>",      // 実行の開始時刻（globalSetup）
//   "finished_at": "<ISO 8601>",      // まとめた時刻
//   "base_url": "http://localhost:4323",
//   "projects": ["desktop", "mobile"],
//   "route_count": 28,                // 対象のルート数（dist のルート＋存在しないパス 1 本）。projects を掛ける前の数
//   "totals": {
//     "pages": 56,                    // route_count × projects の数
//     "pages_failed": 3,              // 違反が 1 件以上あったページ（QC-a11y-pages-failed）
//     "pages_errored": 0,             // 検査が走らなかったページ（ナビゲーションの失敗など。理由は pages[].error）
//     "pages_missing": 0,             // 結果のファイルが無いページ（テストが書く前に落ちた）。この 2 つが 0 でなければ結果を信用しない
//     "violations": 12,               // 違反の要素の数（ルール × 要素。QC-a11y-violations）
//     "violation_rules": 4,           // 違反のルールの種類の数（ページをまたいで重複を除く）
//     "serious": 7,                   // impact が critical か serious の要素の数（QC-a11y-serious）
//     "incomplete": 30                // 人の判断が要る要素の数（QC-a11y-incomplete）
//   },
//   "pages": [PageResult, ...]        // 下の型。project → route の順
// }
// PageResult の state はページの状態（初回訪問の Cookie バナー表示中は "default"。V2 で menu-open・form-error などを足す）。
// 件数はすべて「要素」単位で数える（1 つのルールが 3 要素で落ちれば 3）。
import fs from "node:fs";
import path from "node:path";
import {
  AXE_TAGS,
  BASE_URL,
  NOT_FOUND_ROUTE,
  PAGES_DIR,
  PROJECTS,
  RUN_FILE,
  SUMMARY_FILE,
  distRoutes,
  slugOf,
} from "./routes";

export type AxeNode = {
  target: string[];
  html: string;
  failureSummary?: string;
};
export type AxeItem = {
  id: string;
  impact: string | null;
  help: string;
  helpUrl: string;
  tags: string[];
  nodes: AxeNode[];
};

export type PageResult = {
  project: string;
  route: string;
  state: string;
  url: string;
  http_status: number | null;
  measured_at: string;
  axe_version: string;
  status: "passed" | "failed" | "error" | "missing";
  error: string | null;
  violations: number;
  serious: number;
  incomplete: number;
  violation_items: AxeItem[];
  incomplete_items: AxeItem[];
};

export function pageFile(
  project: string,
  route: string,
  state = "default",
): string {
  const suffix = state === "default" ? "" : `--${state}`;
  return path.join(PAGES_DIR, project, `${slugOf(route)}${suffix}.json`);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export default function globalTeardown() {
  const routes = [...distRoutes(), NOT_FOUND_ROUTE];
  const run = readJson<{ started_at: string }>(RUN_FILE);
  const pages: PageResult[] = [];
  for (const project of PROJECTS) {
    // 初回訪問の状態は全ルートぶんあるはずなので、無ければ missing として数える
    for (const route of routes) {
      const result = readJson<PageResult>(pageFile(project, route));
      pages.push(
        result ?? {
          project,
          route,
          state: "default",
          url: `${BASE_URL}${route}`,
          http_status: null,
          measured_at: "",
          axe_version: "",
          status: "missing",
          error: null,
          violations: 0,
          serious: 0,
          incomplete: 0,
          violation_items: [],
          incomplete_items: [],
        },
      );
    }
    // メニューを開いた・入力エラーなどの状態つきの結果（<slug>--<state>.json）は、あるものだけを足す
    const dir = path.join(PAGES_DIR, project);
    const stateFiles = fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((name) => name.includes("--") && name.endsWith(".json"))
      : [];
    for (const name of stateFiles.sort()) {
      const result = readJson<PageResult>(path.join(dir, name));
      if (result) pages.push(result);
    }
  }
  const sum = (key: "violations" | "serious" | "incomplete") =>
    pages.reduce((n, p) => n + p[key], 0);
  const summary = {
    version: 1,
    tool: "axe-core",
    axe_version: pages.find((p) => p.axe_version)?.axe_version ?? "",
    tags: AXE_TAGS,
    measured_at: run?.started_at ?? "",
    finished_at: new Date().toISOString(),
    base_url: BASE_URL,
    projects: [...PROJECTS],
    route_count: routes.length,
    totals: {
      pages: pages.length,
      pages_failed: pages.filter((p) => p.status === "failed").length,
      pages_errored: pages.filter((p) => p.status === "error").length,
      pages_missing: pages.filter((p) => p.status === "missing").length,
      violations: sum("violations"),
      violation_rules: new Set(
        pages.flatMap((p) => p.violation_items.map((v) => v.id)),
      ).size,
      serious: sum("serious"),
      incomplete: sum("incomplete"),
    },
    pages,
  };
  fs.writeFileSync(SUMMARY_FILE, `${JSON.stringify(summary, null, 2)}\n`);
}
