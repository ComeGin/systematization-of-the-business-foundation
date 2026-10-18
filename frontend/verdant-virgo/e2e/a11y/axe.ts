// axe を回して、ページの結果（.a11y/pages/<project>/<slug>[--<state>].json）を書く共通の処理。
// 初回訪問の全ルート（pages.spec.ts）と、メニューを開いた・入力エラーなどの状態（states.spec.ts）が使う。
import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page, Response, TestInfo } from "@playwright/test";
import { pageFile, type AxeItem, type PageResult } from "./merge";
import { AXE_TAGS } from "./routes";
import { settleAnimations } from "../support/dom";

type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;

function toItems(list: AxeResults["violations"]): AxeItem[] {
  return list.map((r) => ({
    id: r.id,
    impact: r.impact ?? null,
    help: r.help,
    helpUrl: r.helpUrl,
    tags: r.tags,
    nodes: r.nodes.map((n) => ({
      target: n.target.map(String),
      html: n.html,
      failureSummary: n.failureSummary,
    })),
  }));
}

const countNodes = (items: AxeItem[]) =>
  items.reduce((n, i) => n + i.nodes.length, 0);

export function writeResult(result: PageResult) {
  const file = pageFile(result.project, result.route, result.state);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
}

/**
 * ページを開き、フォントの読み込みと island の水和を待つ。
 * 水和は astro-island の ssr 属性が外れることで見る（client:visible・client:media の島は画面に入るまで水和しないので除く）。
 * networkidle は Cal.com などが通信を続けると毎回打ち切りまで待つので使わない。
 */
export async function open(
  page: Page,
  route: string,
): Promise<Response | null> {
  const response = await page.goto(route, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll("astro-island[ssr]")].every((island) =>
          ["visible", "media", "only"].includes(island.getAttribute("client") ?? ""),
        ),
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => {});
  // ssr 属性が外れた後も、useEffect の再描画（水和を待って送信ボタンの disabled を外すなど）が 1〜2 フレーム遅れて来る
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  return response;
}

/**
 * いまの状態のページに axe を回し、結果を書いて返す。prepare（ページを開いて状態を作る）が失敗したら
 * error として書いてから投げ直す（summary.json の pages_errored に数える）。
 */
export async function audit(
  page: Page,
  testInfo: TestInfo,
  route: string,
  state: string,
  prepare: () => Promise<Response | null | void>,
  /** 検査から除く要素（第三者の iframe の中など。部分適合の対象。計画書の P-7） */
  exclude: string[] = [],
): Promise<{ response: Response | null; result: PageResult }> {
  const project = testInfo.project.name;
  let response: Response | null = null;
  let results: AxeResults;
  try {
    response = (await prepare()) ?? null;
    // 色の切り替わりの途中（水和でボタンが有効になる transition など）を測らない
    await settleAnimations(page);
    const builder = new AxeBuilder({ page }).withTags(AXE_TAGS);
    for (const selector of exclude) builder.exclude(selector);
    results = await builder.analyze();
  } catch (error) {
    writeResult({
      project,
      route,
      state,
      url: page.url(),
      http_status: response?.status() ?? null,
      measured_at: new Date().toISOString(),
      axe_version: "",
      status: "error",
      error: String(error instanceof Error ? error.message : error).slice(
        0,
        300,
      ),
      violations: 0,
      serious: 0,
      incomplete: 0,
      violation_items: [],
      incomplete_items: [],
    });
    throw error;
  }

  const violationItems = toItems(results.violations);
  const incompleteItems = toItems(results.incomplete);
  const result: PageResult = {
    project,
    route,
    state,
    url: page.url(),
    http_status: response?.status() ?? null,
    measured_at: new Date().toISOString(),
    axe_version: results.testEngine.version,
    status: violationItems.length > 0 ? "failed" : "passed",
    error: null,
    violations: countNodes(violationItems),
    serious: countNodes(
      violationItems.filter(
        (i) => i.impact === "critical" || i.impact === "serious",
      ),
    ),
    incomplete: countNodes(incompleteItems),
    violation_items: violationItems,
    incomplete_items: incompleteItems,
  };
  writeResult(result);
  return { response, result };
}

/** 失敗のときに読みやすいよう、ルールと要素だけを並べる */
export const brief = (items: AxeItem[]) =>
  items.map(
    (i) =>
      `${i.id}（${i.impact}）: ${i.nodes.map((n) => n.target.join(" ")).join(" , ")}`,
  );
