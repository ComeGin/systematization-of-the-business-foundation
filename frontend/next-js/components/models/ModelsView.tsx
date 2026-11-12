"use client";

import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import ContentLayout from "@cloudscape-design/components/content-layout";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import Select, { type SelectProps } from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import type { AvailableModels, ModelChoice, ModelSettingTarget, ModelSettingsView } from "control-plane";
import { useState } from "react";
import { formatTime, useFollow } from "@/components/common/navigation";
import { InfoLink } from "@/components/layout/tools-context";

type AgentRow = ModelSettingsView["anthropic"]["agents"][number];

/** 選択を外す（定義・全体の既定・環境変数に従う）ときの Select の値 */
const UNSET = "__unset__";

const SOURCE_LABEL: Record<AgentRow["source"], string> = {
  agent: "この Agent の選択",
  default: "全体の既定",
  definition: "定義の model",
  sdk: "SDK の既定",
};

const SCOPE_LABEL = (scope: string): string => {
  if (scope === "anthropic:default") return "Anthropic・全体の既定";
  if (scope === "openai:image") return "OpenAI・アイキャッチ画像";
  return `Anthropic・${scope.replace(/^anthropic:agent:/, "")}`;
};

/** 一覧（とエイリアス）から Select の選択肢を作る。今の値が一覧に無ければ（読めない・終了したモデル）先頭に残す */
function modelOptions(available: AvailableModels, aliases: string[], current: string | null, unsetLabel: string): SelectProps.Options {
  const listed = new Set([...aliases, ...available.models.map((m) => m.id)]);
  const options: SelectProps.Options = [{ value: UNSET, label: unsetLabel }];
  const extra: SelectProps.Option[] = current && !listed.has(current) ? [{ value: current, label: current, description: "一覧に無い（今の値）", disabled: true }] : [];
  return [
    ...options,
    ...extra,
    ...(aliases.length ? [{ label: "エイリアス（SDK の版が決める最新）", options: aliases.map((alias) => ({ value: alias, label: alias })) }] : []),
    ...(available.models.length
      ? [
          {
            label: "モデル（API の一覧）",
            options: available.models.map((m) => ({
              value: m.id,
              label: m.displayName === m.id ? m.id : `${m.displayName}`,
              description: m.displayName === m.id ? undefined : m.id,
              tags: m.createdAt ? [m.createdAt.slice(0, 10)] : undefined,
            })),
          },
        ]
      : []),
  ];
}

function findOption(options: SelectProps.Options, value: string | null): SelectProps.Option | null {
  const wanted = value ?? UNSET;
  for (const entry of options) {
    if ("options" in entry && entry.options) {
      const hit = entry.options.find((option) => option.value === wanted);
      if (hit) return hit;
    } else if ((entry as SelectProps.Option).value === wanted) {
      return entry as SelectProps.Option;
    }
  }
  return null;
}

function choiceText(choice: ModelChoice | null): string {
  return choice ? `${choice.actor}・${formatTime(choice.updatedAt, "minute")}` : "";
}

async function saveModel(target: ModelSettingTarget, model: string | null): Promise<{ ok: true; view: ModelSettingsView } | { ok: false; error: string }> {
  const body = target.provider === "anthropic" ? { provider: "anthropic", agent: target.agent, model } : { provider: "openai", use: "image", model };
  try {
    const response = await fetch("/api/models", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await response.json().catch(() => null)) as (ModelSettingsView & { error?: string }) | null;
    if (!response.ok || !json) return { ok: false, error: json?.error ?? `失敗しました（${response.status}）` };
    return { ok: true, view: json };
  } catch {
    return { ok: false, error: "サーバーに接続できませんでした" };
  }
}

function AvailabilityAlert({ provider, configured, available, keyName }: { provider: string; configured: boolean; available: AvailableModels; keyName: string }) {
  if (!configured) return <Alert type="warning">{keyName} が無いので、{provider} のモデルは選べません（設定スクリプトの prod.conf に書いて起動し直す）。</Alert>;
  if (!available.ok) return <Alert type="warning" header="選べるモデルの一覧を読めない">{available.reason}。一覧を読めるまで、モデルは変えられません（今の値はそのまま使われます）。</Alert>;
  return null;
}

/**
 * 実行モデル（2026-11-12）。Anthropic は全体の既定と Agent ごとの上書き、OpenAI はアイキャッチ画像のモデル。
 * 選ぶとすぐ保存し、次の実行から効く（実行中のものは変わらない）。画面の選択は承認済み main の定義の model より優先する。
 */
export function ModelsView({ initial }: { initial: ModelSettingsView }) {
  const follow = useFollow();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { anthropic, openai } = view;
  const anthropicReady = anthropic.configured && anthropic.available.ok;
  const openaiReady = openai.configured && openai.available.ok;

  async function change(key: string, label: string, target: ModelSettingTarget, value: string) {
    const model = value === UNSET ? null : value;
    setBusy(key);
    setError(null);
    setNotice(null);
    const result = await saveModel(target, model);
    setBusy(null);
    if (!result.ok) {
      setError(`${label} を変えられませんでした: ${result.error}`);
      return;
    }
    setView(result.view);
    setNotice(`${label} を ${model ?? "選ばない（既定に従う）"} にしました。次の実行から使われます。`);
  }

  const defaultOptions = modelOptions(anthropic.available, anthropic.aliases, anthropic.default?.model ?? null, "選ばない（各 Agent の定義の model を使う）");
  const agentOptions = (row: AgentRow) =>
    modelOptions(
      anthropic.available,
      anthropic.aliases,
      row.override?.model ?? null,
      anthropic.default ? `全体の既定に従う（${anthropic.default.model}）` : `定義の model に従う（${row.definitionModel ?? "なし"}）`,
    );
  const imageOptions = modelOptions(openai.available, [], openai.image.override?.model ?? null, `選ばない（環境変数・既定: ${openai.image.fallback ?? "なし"}）`);

  return (
    <ContentLayout
      header={
        <Header variant="h1" info={<InfoLink />} description="エージェント（Anthropic）とアイキャッチ画像（OpenAI）で使うモデルを選びます。選ぶとすぐ保存され、次の実行から使われます。">
          実行モデル
        </Header>
      }
    >
      <SpaceBetween size="l">
        {error ? (
          <Alert type="error" dismissible onDismiss={() => setError(null)}>
            {error}
          </Alert>
        ) : null}
        {notice ? (
          <Alert type="success" dismissible onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        ) : null}

        <Container header={<Header variant="h2" description="決まり方: Agent ごとの選択 → 全体の既定 → 定義（.claude/agents の model）→ SDK の既定">Anthropic（エージェント）</Header>}>
          <SpaceBetween size="m">
            <AvailabilityAlert provider="Anthropic" configured={anthropic.configured} available={anthropic.available} keyName="ANTHROPIC_API_KEY" />
            <FormField
              label="全体の既定"
              description="Agent ごとに選んでいないものは、すべてこのモデルで動きます。選ばないと、各 Agent の定義の model（今は sonnet）を使います。"
              secondaryControl={anthropic.default ? <Box variant="small" color="text-body-secondary">{choiceText(anthropic.default)}</Box> : undefined}
            >
              <Select
                selectedOption={findOption(defaultOptions, anthropic.default?.model ?? null)}
                options={defaultOptions}
                disabled={!anthropicReady || busy !== null}
                statusType={busy === "anthropic:default" ? "loading" : "finished"}
                filteringType="auto"
                onChange={({ detail }) => void change("anthropic:default", "全体の既定", { provider: "anthropic", agent: null }, detail.selectedOption.value ?? UNSET)}
              />
            </FormField>

            <Table
              variant="embedded"
              header={<Header variant="h3" counter={`(${anthropic.agents.length})`}>Agent ごと</Header>}
              items={anthropic.agents}
              trackBy="agent"
              empty="Agent の定義を読めませんでした"
              wrapLines
              columnDefinitions={[
                {
                  id: "agent",
                  header: "Agent",
                  cell: (row) => (
                    <Link href={`/agents/${encodeURIComponent(row.agent)}`} onFollow={follow}>
                      {row.agent}
                    </Link>
                  ),
                },
                { id: "definition", header: "定義の model", cell: (row) => row.definitionModel ?? "-" },
                {
                  id: "choice",
                  header: "この Agent の選択",
                  minWidth: 280,
                  cell: (row) => {
                    const options = agentOptions(row);
                    return (
                      <SpaceBetween size="xxs">
                        <Select
                          selectedOption={findOption(options, row.override?.model ?? null)}
                          options={options}
                          disabled={!anthropicReady || busy !== null}
                          statusType={busy === `agent:${row.agent}` ? "loading" : "finished"}
                          filteringType="auto"
                          ariaLabel={`${row.agent} のモデル`}
                          onChange={({ detail }) =>
                            void change(`agent:${row.agent}`, row.agent, { provider: "anthropic", agent: row.agent }, detail.selectedOption.value ?? UNSET)
                          }
                        />
                        {row.override ? (
                          <Box variant="small" color="text-body-secondary">
                            {choiceText(row.override)}
                          </Box>
                        ) : null}
                      </SpaceBetween>
                    );
                  },
                },
                {
                  id: "effective",
                  header: "次の実行で使う",
                  cell: (row) => (
                    <SpaceBetween size="xxs" direction="horizontal">
                      <Box variant="code">{row.effective ?? "（SDK の既定）"}</Box>
                      <Badge color={row.source === "agent" || row.source === "default" ? "blue" : "grey"}>{SOURCE_LABEL[row.source]}</Badge>
                    </SpaceBetween>
                  ),
                },
              ]}
            />
            <Box variant="small" color="text-body-secondary">
              エイリアス（sonnet など）は、監視アプリが使う Agent SDK の版が決めるモデルを指します。実際に使ったモデルは、実行記録の詳細の「モデル」に残ります。
            </Box>
          </SpaceBetween>
        </Container>

        <Container header={<Header variant="h2" description="builtin の article-cover が、記事のアイキャッチ画像を作るときに使います">OpenAI（アイキャッチ画像）</Header>}>
          <SpaceBetween size="m">
            <AvailabilityAlert provider="OpenAI" configured={openai.configured} available={openai.available} keyName="OPENAI_API_KEY" />
            <FormField
              label="画像のモデル"
              description="選ばないときは、環境変数 CONTROL_OPENAI_IMAGE_MODEL（無ければ既定）を使います。モデルによって 1 枚あたりの費用が違います。"
              secondaryControl={openai.image.override ? <Box variant="small" color="text-body-secondary">{choiceText(openai.image.override)}</Box> : undefined}
            >
              <Select
                selectedOption={findOption(imageOptions, openai.image.override?.model ?? null)}
                options={imageOptions}
                disabled={!openaiReady || busy !== null}
                statusType={busy === "openai:image" ? "loading" : "finished"}
                filteringType="auto"
                onChange={({ detail }) => void change("openai:image", "アイキャッチ画像のモデル", { provider: "openai", use: "image" }, detail.selectedOption.value ?? UNSET)}
              />
            </FormField>
            <Box>
              次の実行で使う: <Box variant="code">{openai.image.effective ?? "（OPENAI_API_KEY が無いので作らない）"}</Box>{" "}
              <Badge color={openai.image.source === "screen" ? "blue" : "grey"}>{openai.image.source === "screen" ? "画面の選択" : "環境変数・既定"}</Badge>
            </Box>
          </SpaceBetween>
        </Container>

        <ExpandableSection variant="container" headerText={`変更の履歴（${view.history.length}）`}>
          <Table
            variant="embedded"
            items={view.history}
            empty="まだ変更はありません"
            wrapLines
            columnDefinitions={[
              { id: "at", header: "日時", cell: (row) => formatTime(row.at, "minute") },
              { id: "scope", header: "対象", cell: (row) => SCOPE_LABEL(row.scope) },
              { id: "change", header: "変更", cell: (row) => `${row.previous ?? "（選択なし）"} → ${row.model ?? "（選択なし）"}` },
              { id: "actor", header: "変えた人", cell: (row) => row.actor },
            ]}
          />
        </ExpandableSection>
      </SpaceBetween>
    </ContentLayout>
  );
}
