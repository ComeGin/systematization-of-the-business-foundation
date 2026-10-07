"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** 実行中の run があるあいだ、一覧を数秒ごとに読み直す。 */
export function AutoRefresh({ active, intervalMs = 5000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);
  return null;
}
