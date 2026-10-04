"use client";

import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import SegmentedControl from "@cloudscape-design/components/segmented-control";
import Select, { type SelectProps } from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Textarea from "@cloudscape-design/components/textarea";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Mode = "agent" | "job";
type Notice = { type: "success" | "warning" | "error"; text: string };

/** 手動の起動。サーバーが Agent SDK を呼び、ブラウザには経過と結果だけが返る（ブラウザから Claude Code を直接呼ばない）。 */
export function ManualRunForm({ jobs }: { jobs: { id: string; description: string }[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("agent");
  const [agent, setAgent] = useState("");
  const [prompt, setPrompt] = useState("");
  const [job, setJob] = useState<SelectProps.Option | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const canSubmit = mode === "agent" ? agent.trim() !== "" && prompt.trim() !== "" : job !== null;

  async function submit() {
    setBusy(true);
    setNotice(null);
    try {
      const target =
        mode === "agent"
          ? { kind: "agent" as const, agent: agent.trim(), prompt: prompt.trim() }
          : { kind: "job" as const, jobId: job!.value! };
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target }),
      });
      const body = (await response.json().catch(() => null)) as { runId?: string; accepted?: boolean; error?: string } | null;
      if (!response.ok || !body) {
        setNotice({ type: "error", text: `起動できませんでした（${body?.error ?? response.status}）` });
      } else if (body.accepted) {
        setNotice({ type: "success", text: `起動しました（相関 ID: ${body.runId}）` });
        setPrompt("");
      } else {
        setNotice({ type: "warning", text: `見送りました。理由は実行記録（相関 ID: ${body.runId}）を見てください` });
      }
      router.refresh();
    } catch {
      setNotice({ type: "error", text: "サーバーに接続できませんでした" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Container header={<Header variant="h2" description="エージェント定義は承認済み main のチェックアウトから読まれます">手動の起動</Header>}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit && !busy) void submit();
        }}
      >
        <Form
          actions={
            <Button variant="primary" formAction="submit" loading={busy} disabled={!canSubmit}>
              起動する
            </Button>
          }
        >
          <SpaceBetween size="m">
            <SegmentedControl
              selectedId={mode}
              onChange={({ detail }) => setMode(detail.selectedId as Mode)}
              options={[
                { id: "agent", text: "エージェントを指定" },
                { id: "job", text: "定期実行の定義を指定" },
              ]}
            />
            {mode === "agent" ? (
              <>
                <FormField label="エージェント名" description="例: seo-auditor（.claude/agents/<名前>.md）">
                  <Input value={agent} onChange={({ detail }) => setAgent(detail.value)} placeholder="seo-auditor" />
                </FormField>
                <FormField label="プロンプト" description="個人情報（氏名・メールアドレス）を書かないでください">
                  <Textarea value={prompt} onChange={({ detail }) => setPrompt(detail.value)} rows={5} />
                </FormField>
              </>
            ) : (
              <FormField label="ジョブ" description="無効（enabled: false）の定義も手動なら起動できます">
                <Select
                  selectedOption={job}
                  onChange={({ detail }) => setJob(detail.selectedOption)}
                  options={jobs.map((j) => ({ value: j.id, label: j.id, description: j.description }))}
                  placeholder="ジョブを選ぶ"
                  empty="定義がありません"
                />
              </FormField>
            )}
            {notice ? <Alert type={notice.type}>{notice.text}</Alert> : null}
          </SpaceBetween>
        </Form>
      </form>
    </Container>
  );
}
