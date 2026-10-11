"use client";

import AppLayoutToolbar from "@cloudscape-design/components/app-layout-toolbar";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Header from "@cloudscape-design/components/header";
import TopNavigation from "@cloudscape-design/components/top-navigation";
import { APP_LAYOUT_LABELS } from "./labels";

/** ログイン前の画面（/login）の外枠。ナビゲーションと Tools は出さない。 */
export function PublicLayout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <div id="top-nav" style={{ position: "sticky", top: 0, zIndex: 1002 }}>
        <TopNavigation identity={{ href: "/login", title: "ComeGin 監視アプリ" }} />
      </div>
      <AppLayoutToolbar
        headerSelector="#top-nav"
        ariaLabels={APP_LAYOUT_LABELS}
        navigationHide
        toolsHide
        maxContentWidth={720}
        content={<ContentLayout header={<Header variant="h1">{title}</Header>}>{children}</ContentLayout>}
      />
    </>
  );
}
