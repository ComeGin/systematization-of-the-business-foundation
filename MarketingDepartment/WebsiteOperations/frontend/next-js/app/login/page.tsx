import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { Shell } from "@/components/Shell";
import { countUsers } from "@/lib/auth";
import { getSession } from "@/lib/session";

export default async function LoginPage() {
  if (await getSession()) redirect("/");
  if ((await countUsers()) === 0) redirect("/setup"); // 最初の管理者がまだいない
  return (
    <Shell title="監視アプリ">
      <AuthForm mode="login" />
    </Shell>
  );
}
