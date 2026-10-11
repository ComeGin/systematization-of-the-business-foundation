"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";

/**
 * Cloudscape のリンク系（Link・SideNavigation・BreadcrumbGroup・Button の href）の onFollow を、
 * ページ全体の読み直しではなく Next.js のクライアント遷移にする。外部リンクはブラウザに任せる。
 */
export function useFollow() {
  const router = useRouter();
  return useCallback(
    (event: CustomEvent<{ href?: string; external?: boolean }>) => {
      const { href, external } = event.detail;
      if (external || !href || !href.startsWith("/")) return;
      event.preventDefault();
      router.push(href);
    },
    [router],
  );
}

/** ISO 8601 を「YYYY-MM-DD HH:mm(:ss)」にする（タイムゾーンは control-plane が付けたまま。JST）。 */
export function formatTime(iso: string | null, precision: "minute" | "second" = "second"): string {
  if (!iso) return "-";
  return iso.slice(0, precision === "minute" ? 16 : 19).replace("T", " ");
}
