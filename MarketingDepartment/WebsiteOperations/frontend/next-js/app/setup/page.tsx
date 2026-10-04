import { redirect } from "next/navigation";
import { connection } from "next/server";
import { AuthForm } from "@/components/AuthForm";
import { Shell } from "@/components/Shell";
import { countUsers } from "@/lib/auth";

// ユーザーが 0 人のときだけ開く。最初の管理者を作ったら新規登録は閉じる（lib/auth.ts の databaseHooks）
export default async function SetupPage() {
  await connection(); // ユーザー数で分岐するので、ビルド時に静的化しない（ビルド中に DB も開かない）
  if ((await countUsers()) > 0) redirect("/login");
  return (
    <Shell title="監視アプリ">
      <AuthForm mode="setup" />
    </Shell>
  );
}
