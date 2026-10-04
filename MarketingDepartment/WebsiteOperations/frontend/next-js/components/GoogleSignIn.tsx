"use client";

import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

/**
 * Google（Workspace）でのログイン。メールとパスワードのログインは持たない（ADR-23）。
 * 通るのは Workspace のドメインのアカウントで、許可リスト（CONTROL_ADMIN_EMAILS）にあるメールだけ（lib/auth.ts）。
 * 失敗すると Better Auth が /login?error=… に戻すので、その理由をページ側（app/login/page.tsx）が error に渡す。
 */
export function GoogleSignIn({ configured, error }: { configured: boolean; error: string | null }) {
  const [busy, setBusy] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setClientError(null);
    try {
      // 成功すると Google の画面へ移動する。戻り先は同じオリジンの相対パス（trustedOrigins の検査に通る）
      const result = await authClient.signIn.social({ provider: "google", callbackURL: "/", errorCallbackURL: "/login" });
      if (result.error) setClientError(result.error.message ?? "ログインを始められませんでした");
    } catch {
      setClientError("サーバーに接続できませんでした");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Container
      header={
        <Header variant="h2" description="comegin.com の Google アカウントで、許可された人だけがログインできます">
          ログイン
        </Header>
      }
    >
      <SpaceBetween size="m">
        {configured ? null : (
          <Alert type="warning" header="Google ログインの設定が無い">
            環境変数 GOOGLE_CLIENT_ID・GOOGLE_CLIENT_SECRET が空です。setup/manual-steps.md の 7.2 で OAuth クライアントを作り、
            設定スクリプト（node setup/setup.mjs --target dev --from next-js）を実行し直してから、開発サーバーを起動し直してください。
          </Alert>
        )}
        {error ? <Alert type="error">{error}</Alert> : null}
        {clientError ? <Alert type="error">{clientError}</Alert> : null}
        <Button variant="primary" onClick={() => void signIn()} loading={busy} disabled={!configured}>
          Google でログイン
        </Button>
      </SpaceBetween>
    </Container>
  );
}
