import type { Metadata } from "next";
import "@cloudscape-design/global-styles/index.css";

export const metadata: Metadata = {
  title: "ComeGin 監視アプリ",
  description: "エージェントの定期実行・手動の指示・実行記録（E-15）・誤った書き込みの候補",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
