import { redirect } from "next/navigation";
import { GoogleSignIn } from "@/components/auth/GoogleSignIn";
import { PublicLayout } from "@/components/layout/PublicLayout";
import { isGoogleConfigured } from "@/lib/auth";
import { getSession } from "@/lib/session";

// Better Auth が失敗したときに付ける ?error= の値。拒否の理由（ドメイン・許可リスト・hd）はコードが一定しない
// （mapProfileToUser の拒否は unable_to_get_user_info、databaseHooks の拒否は APIError の code）ので、文は 1 つにする。
// 理由の種類はサーバーのログ（[auth] login refused: …）に残る
function describeError(error: string | undefined): string | null {
  if (!error) return null;
  return "ログインできませんでした。comegin.com の Google アカウントで、許可リスト（CONTROL_ADMIN_EMAILS）にあるメールだけがログインできます";
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  if (await getSession()) redirect("/");
  const { error } = await searchParams;
  return (
    <PublicLayout title="ログイン">
      <GoogleSignIn configured={isGoogleConfigured()} error={describeError(typeof error === "string" ? error : undefined)} />
    </PublicLayout>
  );
}
