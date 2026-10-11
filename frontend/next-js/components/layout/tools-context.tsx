"use client";

import Link from "@cloudscape-design/components/link";
import { createContext, useContext } from "react";

/** Tools（ヘルプのパネル）を開く。ConsoleLayout が値を入れる。 */
export const ToolsContext = createContext<{ openTools: () => void }>({ openTools: () => {} });

/** 見出しの横の「情報」リンク。押すと Tools のパネルにその画面の説明を開く。 */
export function InfoLink() {
  const { openTools } = useContext(ToolsContext);
  return (
    <Link variant="info" onFollow={openTools}>
      情報
    </Link>
  );
}
