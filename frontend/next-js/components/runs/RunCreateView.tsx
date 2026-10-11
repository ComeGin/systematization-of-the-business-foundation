"use client";

import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import ContentLayout from "@cloudscape-design/components/content-layout";
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
import { useFollow } from "@/components/common/navigation";
import { InfoLink } from "@/components/layout/tools-context";

type Mode = "agent" | "job";

/**
 * 新規: 手動の起動。サーバーが Agent SDK を呼び、ブラウザには経過と結果だけが返る（ブラウザから Claude Code を直接呼ばない）。
 * 受け付けたら（見送りでも記録は作られる）その実行の詳細へ移る。
 */
export function RunCreateView({ jobs, initialJobId }: { jobs: { id: string; description: string }[]; initialJobId: string | null }) {
  const router = useRouter();
  const follow = useFollow();
  const jobOptions: SelectProps.Option[] = jobs.map((j) => ({ value: j.id, label: j.id, description: j.description }));
  const initialJob = jobOptions.find((option) => option.value === initialJobId) ?? null;
  const [mode, setMode] = useState<Mode>(initialJob ? "job" : "agent");
  const [agent, setAgent] = useState("");
  const [prompt, setPrompt] = useState("");
  const [job, setJob] = useState<SelectProps.Option | null>(initialJob);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = mode === "agent" ? agent.trim() !== "" && prompt.trim() !== "" : job !== null;

  async function submit() {
    setBusy(true);
    setError(null);
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
      if (!response.ok || !body?.runId) {
        setError(`起動できませんでした（${body?.error ?? response.status}）`);
        return;
      }
      // 見送り（accepted=false）でも skipped の記録が作られる。理由は詳細の「要約」に出る
      router.push(`/runs/${body.runId}`);
    } catch {
      setError("サーバーに接続できませんでした");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ContentLayout
      header={
        <Header variant="h1" info={<InfoLink />} description="エージェント定義は承認済み main のチェックアウトから読まれます">
          手動の起動
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
          errorText={error}
          actions={
            <SpaceBetween size="xs" direction="horizontal">
              <Button variant="link" href="/runs" onFollow={follow} formAction="none">
                キャンセル
              </Button>
              <Button variant="primary" formAction="submit" loading={busy} disabled={!canSubmit}>
                起動する
              </Button>
            </SpaceBetween>
          }
        >
          <Container header={<Header variant="h2">起動する対象</Header>}>
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
                    options={jobOptions}
                    placeholder="ジョブを選ぶ"
                    empty="定義がありません"
                  />
                </FormField>
              )}
            </SpaceBetween>
          </Container>
        </Form>
      </form>
    </ContentLayout>
  );
}
