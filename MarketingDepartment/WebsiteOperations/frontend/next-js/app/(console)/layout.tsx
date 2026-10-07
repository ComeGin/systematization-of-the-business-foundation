import { ConsoleLayout } from "@/components/layout/ConsoleLayout";
import { requirePageSession } from "@/lib/session";

// ログイン後の画面の外枠（AppLayoutToolbar）。ユーザー名を出すためにここでもセッションを読むが、
// レイアウトは画面遷移で再描画されないため、ログインの確認は各ページの requirePageSession に任せる
export default async function ConsoleRootLayout({ children }: LayoutProps<"/">) {
  const session = await requirePageSession();
  return <ConsoleLayout userName={session.user.name}>{children}</ConsoleLayout>;
}
