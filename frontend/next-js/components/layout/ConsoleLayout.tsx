"use client";

import AppLayoutToolbar from "@cloudscape-design/components/app-layout-toolbar";
import BreadcrumbGroup from "@cloudscape-design/components/breadcrumb-group";
import SideNavigation from "@cloudscape-design/components/side-navigation";
import TopNavigation from "@cloudscape-design/components/top-navigation";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useFollow } from "@/components/common/navigation";
import { JobDetailHelp, JobsListHelp } from "@/components/jobs/help";
import { MiswriteCandidatesHelp } from "@/components/miswrite-candidates/help";
import { RunDetailHelp, RunsListHelp, RunsNewHelp } from "@/components/runs/help";
import { authClient } from "@/lib/auth-client";
import { APP_LAYOUT_LABELS } from "./labels";
import { NAVIGATION_ITEMS, resolveRoute, type HelpId } from "./routes";
import { ToolsContext } from "./tools-context";

const HELP: Record<HelpId, React.ReactNode> = {
  "runs-list": <RunsListHelp />,
  "runs-new": <RunsNewHelp />,
  "run-detail": <RunDetailHelp />,
  "jobs-list": <JobsListHelp />,
  "job-detail": <JobDetailHelp />,
  "miswrite-candidates": <MiswriteCandidatesHelp />,
};

/**
 * ログイン後の画面の外枠。TopNavigation（ユーザーとログアウト）＋ AppLayoutToolbar
 * （SideNavigation・パンくず・Tools のヘルプ）。中身（一覧・詳細・新規）は各モジュールのページが描く。
 */
export function ConsoleLayout({ userName, children }: { userName: string; children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const follow = useFollow();
  const route = useMemo(() => resolveRoute(pathname), [pathname]);
  const [navigationOpen, setNavigationOpen] = useState(true);
  const [toolsOpen, setToolsOpen] = useState(false);
  const tools = useMemo(() => ({ openTools: () => setToolsOpen(true) }), []);

  async function signOut() {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <ToolsContext value={tools}>
      <div id="top-nav" style={{ position: "sticky", top: 0, zIndex: 1002 }}>
        <TopNavigation
          identity={{ href: "/", title: "ComeGin 監視アプリ", onFollow: follow }}
          utilities={[
            {
              type: "menu-dropdown",
              text: userName,
              iconName: "user-profile",
              items: [{ id: "sign-out", text: "ログアウト" }],
              onItemClick: ({ detail }) => {
                if (detail.id === "sign-out") void signOut();
              },
            },
          ]}
          i18nStrings={{ overflowMenuTriggerText: "その他", overflowMenuTitleText: "すべて" }}
        />
      </div>
      <AppLayoutToolbar
        headerSelector="#top-nav"
        ariaLabels={APP_LAYOUT_LABELS}
        contentType={route.contentType}
        navigationOpen={navigationOpen}
        onNavigationChange={({ detail }) => setNavigationOpen(detail.open)}
        navigation={
          <SideNavigation
            header={{ text: "監視アプリ", href: "/" }}
            activeHref={route.activeHref}
            onFollow={follow}
            items={NAVIGATION_ITEMS.map((item) => ({ type: "link", text: item.text, href: item.href }))}
          />
        }
        breadcrumbs={
          <BreadcrumbGroup items={route.breadcrumbs} onFollow={follow} ariaLabel="パンくずリスト" expandAriaLabel="パンくずを展開" />
        }
        toolsHide={route.help === null}
        toolsOpen={toolsOpen}
        onToolsChange={({ detail }) => setToolsOpen(detail.open)}
        tools={route.help ? HELP[route.help] : undefined}
        content={children}
      />
    </ToolsContext>
  );
}
