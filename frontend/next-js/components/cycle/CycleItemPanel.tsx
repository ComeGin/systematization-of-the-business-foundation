"use client";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Checkbox from "@cloudscape-design/components/checkbox";
import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import Link from "@cloudscape-design/components/link";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Textarea from "@cloudscape-design/components/textarea";
import type { CycleView } from "control-plane";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatTime } from "@/components/common/navigation";
import { CYCLE_ITEM_KIND_LABEL, CYCLE_ITEM_STATE_LABEL, CYCLE_ITEM_STATE_TYPE } from "@/components/layout/labels";
import { CommandList } from "./CommandList";
import { executeItem, rejectItem, approveItem } from "./cycle-api";
import { ItemPreview } from "./ItemPreview";

type Item = CycleView["items"][number];

const ACTION_LABEL = { approve: "OK", reject: "差し戻し", execute: "実行した" } as const;
const REASON_MAX = 500;

/** article・campaign の記事にアイキャッチ画像が無いか（表紙に結ぶまで OK させない。control-plane の service.ts と同じ条件） */
function coverMissing(item: Item): boolean {
  const preview = item.preview;
  return (preview.kind === "article" || preview.kind === "campaign") && !preview.coverUrl;
}

/** OK を押せる項目か。proposal は PR の承認で進む・配信できない deploy・中身がまだ無い・アイキャッチの無い項目は押させない */
function canApprove(item: Item): boolean {
  if (item.state !== "awaiting_review" || item.kind === "proposal") return false;
  if (item.preview.kind === "pending") return false;
  if (item.preview.kind === "deploy" && item.preview.blocked) return false;
  if (coverMissing(item)) return false;
  return true;
}

/** OK を出せない理由（OK 待ちの項目に出す） */
function notApprovableReason(item: Item): string {
  if (coverMissing(item)) {
    return "アイキャッチ画像がまだ無い。表紙に結ぶまで待つ（結んだ後、次の cycle-collect で中身が更新されると OK を出せる）。";
  }
  return "この項目には OK を出せない（中身がまだ無いか、配信の条件を満たしていない）。";
}

/** 手順を出す状態（OK の後）。それ以前は、OK の前に行う手順（アイキャッチを表紙に結ぶ）があるときだけ出す */
const STEP_STATES: ReadonlySet<Item["state"]> = new Set(["approved", "executed", "failed_check", "confirmed"]);
const PRE_APPROVAL_STATES: ReadonlySet<Item["state"]> = new Set(["preparing", "awaiting_review"]);

/**
 * 項目 1 件。概要・根拠のシグナル・中身のプレビュー・確認項目のチェックボックスと OK／差し戻し・
 * OK の後の手順（コマンドはコピーできる）と「実行した」・確かめた結果を出す。
 * 親が key に itemId と updatedAt を渡す（項目の中身が差し替わったら、チェックを入れ直す）。
 */
export function CycleItemPanel({ item }: { item: Item }) {
  const router = useRouter();
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<keyof typeof ACTION_LABEL | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");

  const approvable = canApprove(item);
  const allChecked = item.checklist.length > 0 && item.checklist.every((entry) => checked.has(entry.id));
  // 準備中（作用のジョブが止まった・中身を作れない）の項目も差し戻せる。中身の無い項目は「実行した」を押させない
  const rejectable =
    item.kind !== "proposal" &&
    (item.state === "preparing" || item.state === "awaiting_review" || item.state === "approved" || item.state === "failed_check");
  const executable = item.kind !== "proposal" && item.preview.kind !== "pending" && (item.state === "approved" || item.state === "failed_check");
  const preApprovalSteps = item.kind !== "proposal" && PRE_APPROVAL_STATES.has(item.state) && item.steps.length > 0;
  // 長さは UTF-16 の .length で数える（API の zod・control-plane の service.ts と同じ）
  const trimmedReason = reason.trim();
  const reasonValid = trimmedReason.length >= 1 && trimmedReason.length <= REASON_MAX;

  /** 失敗は画面に出し、画面を読み直す（項目が更新されていたときに、新しい中身を見せるため） */
  async function run<T>(action: keyof typeof ACTION_LABEL, call: () => Promise<{ ok: true; body: T } | { ok: false; error: string }>) {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      const result = await call();
      if (!result.ok) {
        setError(`${ACTION_LABEL[action]}できませんでした: ${result.error}`);
        router.refresh();
        return null;
      }
      router.refresh();
      return result.body;
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    // 確認項目の id は定義の順に送る（control-plane が過不足なく一致するかを検査する）。updatedAt は受け取ったまま送る
    await run("approve", () =>
      approveItem(item.itemId, item.checklist.filter((entry) => checked.has(entry.id)).map((entry) => entry.id), item.updatedAt),
    );
  }

  async function reject() {
    const body = await run("reject", () => rejectItem(item.itemId, trimmedReason));
    if (body !== null) {
      setRejectOpen(false);
      setReason("");
    }
  }

  async function execute() {
    const body = await run("execute", () => executeItem(item.itemId));
    if (body && !body.accepted) setNotice("確認は始められなかった（すでに確認中か、いまは受け付けられない）。しばらくしてから画面を確かめる");
  }

  return (
    <Container
      header={
        <Header
          variant="h2"
          description={`${CYCLE_ITEM_KIND_LABEL[item.kind]} ・ ${item.sourceRef}`}
          actions={<StatusIndicator type={CYCLE_ITEM_STATE_TYPE[item.state]}>{CYCLE_ITEM_STATE_LABEL[item.state]}</StatusIndicator>}
        >
          {item.title}
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
          <Alert type="info" dismissible onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        ) : null}
        {item.stateReason ? (
          <Alert type={item.state === "failed_check" ? "error" : "info"} header={CYCLE_ITEM_STATE_LABEL[item.state]}>
            {item.stateReason}
          </Alert>
        ) : null}

        <Box>
          <Box variant="awsui-key-label">概要（何を・なぜ）</Box>
          <span style={{ whiteSpace: "pre-wrap" }}>{item.summary}</span>
        </Box>

        <Box>
          <Box variant="awsui-key-label">根拠のシグナル</Box>
          {item.evidence.length === 0 ? (
            <span>なし</span>
          ) : (
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {item.evidence.map((entry, index) => (
                <li key={`${index}-${entry.auditId}`}>
                  <Box variant="code">{entry.auditId}</Box> {entry.summary}
                </li>
              ))}
            </ul>
          )}
        </Box>

        {item.strapiAdminUrl ? (
          <Box>
            <Box variant="awsui-key-label">Strapi の記事</Box>
            {/* 本番の Strapi はオンプレの 127.0.0.1 だけに開くので、この機械のブラウザから開く */}
            <Link href={item.strapiAdminUrl} external externalIconAriaLabel="（新しいタブで開く）">
              Strapi の管理画面で記事を開く
            </Link>
          </Box>
        ) : null}

        <div>
          <Box variant="awsui-key-label">中身</Box>
          <ItemPreview preview={item.preview} />
        </div>

        {item.state === "awaiting_review" && item.kind !== "proposal" ? (
          <SpaceBetween size="s">
            <Box variant="awsui-key-label">確認項目（すべて入れると OK を押せる）</Box>
            {item.checklist.length === 0 ? (
              <Alert type="warning">確認項目を読めないため、OK は出せない（周の上の警告を確かめる）</Alert>
            ) : (
              <SpaceBetween size="xs">
                {item.checklist.map((entry) => (
                  <Checkbox
                    key={entry.id}
                    checked={checked.has(entry.id)}
                    onChange={({ detail }) =>
                      setChecked((current) => {
                        const next = new Set(current);
                        if (detail.checked) next.add(entry.id);
                        else next.delete(entry.id);
                        return next;
                      })
                    }
                  >
                    {entry.label}
                  </Checkbox>
                ))}
              </SpaceBetween>
            )}
            {!approvable ? (
              <Box variant="small" color="text-body-secondary">
                {notApprovableReason(item)}
              </Box>
            ) : null}
          </SpaceBetween>
        ) : null}

        {preApprovalSteps ? (
          <div>
            <Box variant="awsui-key-label">OK の前に行う手順</Box>
            <CommandList steps={item.steps} />
          </div>
        ) : null}

        {STEP_STATES.has(item.state) ? (
          <div>
            <Box variant="awsui-key-label">手順（上から順に行う。コマンドはコピーして自分の端末で実行する）</Box>
            <CommandList steps={item.steps} />
          </div>
        ) : null}

        {item.state === "rejected" && item.kind !== "proposal" && item.steps.length > 0 ? (
          <div>
            <Box variant="awsui-key-label">差し戻した後に行う手順</Box>
            <CommandList steps={item.steps} />
          </div>
        ) : null}

        {approvable || rejectable || executable ? (
          <SpaceBetween size="xs" direction="horizontal">
            {approvable ? (
              <Button variant="primary" disabled={!allChecked || busy !== null} loading={busy === "approve"} onClick={() => void approve()}>
                OK
              </Button>
            ) : null}
            {executable ? (
              <Button variant="primary" disabled={busy !== null} loading={busy === "execute"} onClick={() => void execute()}>
                実行した
              </Button>
            ) : null}
            {rejectable ? (
              <Button disabled={busy !== null} onClick={() => setRejectOpen(true)}>
                差し戻す
              </Button>
            ) : null}
          </SpaceBetween>
        ) : null}

        {item.approvals.length > 0 ? (
          <KeyValuePairs
            columns={1}
            items={[
              {
                label: "操作の記録",
                value: (
                  <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                    {item.approvals.map((approval, index) => (
                      <li key={`${index}-${approval.at}`}>
                        {formatTime(approval.at)} {ACTION_LABEL[approval.action]}（{approval.actor}）
                        {approval.reason ? ` 理由: ${approval.reason}` : ""}
                      </li>
                    ))}
                  </ul>
                ),
              },
            ]}
          />
        ) : null}
      </SpaceBetween>

      <Modal
        visible={rejectOpen}
        onDismiss={() => (busy === null ? setRejectOpen(false) : undefined)}
        header="差し戻す"
        footer={
          <Box float="right">
            <SpaceBetween size="xs" direction="horizontal">
              <Button variant="link" disabled={busy !== null} onClick={() => setRejectOpen(false)}>
                キャンセル
              </Button>
              <Button variant="primary" disabled={!reasonValid} loading={busy === "reject"} onClick={() => void reject()}>
                差し戻す
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          {error && rejectOpen ? <Alert type="error">{error}</Alert> : null}
          <FormField
            label="理由"
            description={`1〜${REASON_MAX} 文字。次の周の改修案が読む。個人情報（氏名・メールアドレス）を書かない`}
            constraintText={`${trimmedReason.length} / ${REASON_MAX}`}
          >
            <Textarea value={reason} onChange={({ detail }) => setReason(detail.value)} rows={5} />
          </FormField>
        </SpaceBetween>
      </Modal>
    </Container>
  );
}
