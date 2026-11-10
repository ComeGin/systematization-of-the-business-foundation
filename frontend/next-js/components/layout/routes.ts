// 画面の一覧。パンくず・ナビゲーションの選択・Tools の中身・AppLayout の contentType を、パスから決める。
// レイアウトは画面遷移で再描画されないため（Next.js の partial rendering）、ページから渡さずに usePathname() で引く。
import type { AppLayoutToolbarProps } from "@cloudscape-design/components/app-layout-toolbar";
import type { BreadcrumbGroupProps } from "@cloudscape-design/components/breadcrumb-group";

export type HelpId =
  | "runs-list"
  | "runs-new"
  | "run-detail"
  | "jobs-list"
  | "job-detail"
  | "agents-list"
  | "agent-detail"
  | "miswrite-candidates"
  | "setup-status"
  | "cycle";

export interface RouteMeta {
  breadcrumbs: BreadcrumbGroupProps.Item[];
  /** SideNavigation で選択中にする項目。 */
  activeHref: string;
  help: HelpId | null;
  contentType: AppLayoutToolbarProps.ContentType;
}

const ROOT: BreadcrumbGroupProps.Item = { text: "監視アプリ", href: "/" };
const RUNS: BreadcrumbGroupProps.Item = { text: "実行記録", href: "/runs" };
const JOBS: BreadcrumbGroupProps.Item = { text: "定期実行のジョブ", href: "/jobs" };
const AGENTS: BreadcrumbGroupProps.Item = { text: "Agent", href: "/agents" };
const CYCLE: BreadcrumbGroupProps.Item = { text: "改善ループ", href: "/cycle" };
const SETUP_STATUS: BreadcrumbGroupProps.Item = { text: "設定の状況", href: "/setup-status" };
const CANDIDATES: BreadcrumbGroupProps.Item = { text: "誤った書き込みの候補", href: "/miswrite-candidates" };

/** サイドのナビゲーションに出すモジュール。 */
export const NAVIGATION_ITEMS = [CYCLE, SETUP_STATUS, RUNS, { text: "手動の起動", href: "/runs/new" }, JOBS, AGENTS, CANDIDATES] as const;

export function resolveRoute(pathname: string): RouteMeta {
  const [module, id] = pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  const self = (text: string) => ({ text, href: pathname });

  if (module === "cycle") {
    if (id === undefined) return { breadcrumbs: [ROOT, CYCLE], activeHref: "/cycle", help: "cycle", contentType: "default" };
    return { breadcrumbs: [ROOT, CYCLE, self(id)], activeHref: "/cycle", help: "cycle", contentType: "default" };
  }
  if (module === "setup-status") {
    return { breadcrumbs: [ROOT, SETUP_STATUS], activeHref: "/setup-status", help: "setup-status", contentType: "default" };
  }
  if (module === "runs") {
    if (id === undefined) return { breadcrumbs: [ROOT, RUNS], activeHref: "/runs", help: "runs-list", contentType: "table" };
    if (id === "new") {
      return { breadcrumbs: [ROOT, RUNS, self("手動の起動")], activeHref: "/runs/new", help: "runs-new", contentType: "form" };
    }
    return { breadcrumbs: [ROOT, RUNS, self(id)], activeHref: "/runs", help: "run-detail", contentType: "default" };
  }
  if (module === "jobs") {
    if (id === undefined) return { breadcrumbs: [ROOT, JOBS], activeHref: "/jobs", help: "jobs-list", contentType: "table" };
    return { breadcrumbs: [ROOT, JOBS, self(id)], activeHref: "/jobs", help: "job-detail", contentType: "default" };
  }
  if (module === "agents") {
    if (id === undefined) return { breadcrumbs: [ROOT, AGENTS], activeHref: "/agents", help: "agents-list", contentType: "table" };
    return { breadcrumbs: [ROOT, AGENTS, self(id)], activeHref: "/agents", help: "agent-detail", contentType: "default" };
  }
  if (module === "miswrite-candidates") {
    return {
      breadcrumbs: [ROOT, CANDIDATES],
      activeHref: "/miswrite-candidates",
      help: "miswrite-candidates",
      contentType: "table",
    };
  }
  return { breadcrumbs: [ROOT], activeHref: pathname, help: null, contentType: "default" };
}
