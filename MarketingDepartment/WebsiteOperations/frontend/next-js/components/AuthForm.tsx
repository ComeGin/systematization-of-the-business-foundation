"use client";

import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

const MIN_PASSWORD_LENGTH = 12;

/** ログイン（login）と、最初の管理者の作成（setup。ユーザーが 0 人のときだけ /setup から使える）。 */
export function AuthForm({ mode }: { mode: "login" | "setup" }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    email.trim() !== "" && password.length >= (mode === "setup" ? MIN_PASSWORD_LENGTH : 1) && (mode === "login" || name.trim() !== "");

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === "login"
          ? await authClient.signIn.email({ email: email.trim(), password })
          : await authClient.signUp.email({ name: name.trim(), email: email.trim(), password });
      if (result.error) {
        setError(mode === "login" ? "メールアドレスまたはパスワードが違います" : (result.error.message ?? "作成できませんでした"));
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("サーバーに接続できませんでした");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Container
      header={
        <Header
          variant="h2"
          description={
            mode === "login"
              ? "監視アプリはこの PC（127.0.0.1）からだけ開けます"
              : `最初の管理者を作ります。作成後は新規登録が閉じます。パスワードは ${MIN_PASSWORD_LENGTH} 文字以上`
          }
        >
          {mode === "login" ? "ログイン" : "最初の管理者の作成"}
        </Header>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit && !busy) void submit();
        }}
      >
        <Form
          actions={
            <Button variant="primary" formAction="submit" loading={busy} disabled={!canSubmit}>
              {mode === "login" ? "ログイン" : "作成する"}
            </Button>
          }
        >
          <SpaceBetween size="m">
            {mode === "setup" ? (
              <FormField label="表示名">
                <Input value={name} onChange={({ detail }) => setName(detail.value)} autoComplete="name" />
              </FormField>
            ) : null}
            <FormField label="メールアドレス">
              <Input value={email} onChange={({ detail }) => setEmail(detail.value)} type="email" autoComplete="username" />
            </FormField>
            <FormField label="パスワード">
              <Input
                value={password}
                onChange={({ detail }) => setPassword(detail.value)}
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
              />
            </FormField>
            {error ? <Alert type="error">{error}</Alert> : null}
          </SpaceBetween>
        </Form>
      </form>
    </Container>
  );
}
