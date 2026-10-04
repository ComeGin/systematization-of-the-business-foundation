"use client";

import AppLayout from "@cloudscape-design/components/app-layout";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

/** 画面の外枠。ナビゲーションとツールのパネルは使わない（最小の UI）。 */
export function Shell({ title, userName, children }: { title: string; userName?: string; children: React.ReactNode }) {
  const router = useRouter();

  async function signOut() {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <AppLayout
      navigationHide
      toolsHide
      content={
        <SpaceBetween size="l">
          <Header
            variant="h1"
            description="管制ライブラリ（control-plane）の実行記録・手動の指示・誤った書き込みの候補"
            actions={
              userName ? (
                <SpaceBetween size="xs" direction="horizontal" alignItems="center">
                  <Box variant="small">{userName}</Box>
                  <Button onClick={signOut}>ログアウト</Button>
                </SpaceBetween>
              ) : undefined
            }
          >
            {title}
          </Header>
          {children}
        </SpaceBetween>
      }
    />
  );
}
