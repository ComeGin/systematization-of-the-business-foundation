# faq-bot「担当者の返信の後に［解決しました］ボタンを出す」実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 担当者が Chatwoot のマクロ「解決の確認を送る」（ラベル `faq-ask-resolved` を付ける）を押すと、faq-bot がラベルを外して［解決しました］ボタンを送り、訪問者が押せば `open` の会話でも `resolved` にする。

**Architecture:** `conversation_updated` の Webhook を `parseEvent` が `ask-resolved` のイベントに変え（本文の `labels` にラベルがあるときだけ）、`executeAskResolved` が会話を読み直してラベルを外し、ボタンを 1 通送る。ボタンの［解決しました］は既存の `__resolved` で、`execute` は判定が `resolved` のときだけ `open` の会話でも続ける（ボタンが最新のメッセージのときに限る）。Chatwoot の setup がラベルとマクロを作る。

**Tech Stack:** TypeScript（Node 22 以上）・zod v4・vitest 5・pnpm 11。開発の Chatwoot v4.18.0（127.0.0.1:3100）。

**Spec:** `docs/superpowers/specs/2026-10-12-faq-bot-ask-resolved-design.md`（前提は `2026-10-11-faq-bot-design.md` と `2026-10-12-faq-bot-welcome-design.md`）

## Global Constraints

- ラベル名は `faq-ask-resolved`（`LABELS.askResolved`）。マクロ名は「解決の確認を送る」（`visibility: global`、動作は `add_label: ["faq-ask-resolved"]` だけ）。
- ボタンの本文は「ご質問は解決しましたか？まだご不明な点があれば、そのまま入力してください。」（`MESSAGES.askResolved`。仮。R3 が見直す）。選択肢は［解決しました］（`MESSAGES.choiceResolved`・`CHOICE.resolved`）だけ。`in_reply_to` は入れない。
- **ボタンを送る前にラベルを外す。** 本文の `labels` にラベルが無いイベントは、Chatwoot の API を呼ばずに `ignore`。
- `show` の結果が `resolved` なら何もしない（ラベルも外さない）。ラベルがもう無ければ何もしない。
- 訪問者の［解決しました］は `open` の会話でも受け付ける。**ほかの判定は今までどおり `pending` のときだけ。** `open` の会話では、ボタン自身が最新のメッセージのときだけお礼を送って `resolved` にする（ボットの別の返事・担当者・訪問者のメッセージが後にあれば何もしない）。
- ログは 1 件 1 行。`event: "ask-resolved"`・`conversation`・`decision`（`ask-resolved` / `skip-resolved` / `skip-no-label`）・`ms`。
- 失敗（Chatwoot の API の失敗）は例外（入口が 502）。
- リポジトリの規則: git の状態を変えるコマンドは使わない（各タスクの最後は「コミットしない」）。ビルド・デプロイはしない。`pnpm` を使う。秘密値を出さない。Python は使わない。コメント・文書・テスト名は日本語、テスト名は正常系／異常系と `空入力:`・`入力:`・`サーバ:` の接頭辞。

## Review Focus

1. **引き継ぎの案内（ボットのテキスト。`in_reply_to` が回答のメッセージ）が最新の `open` の会話で、回答の［解決しました］が届く** → 今の `shouldSend` は「送信済み（false）」と判定し、そのままだとお礼なしに `resolved` にしてしまう。`open` では `send === true` のときだけ続ける（Task 3 の単体テストで覆う）。
2. **担当者がラベル `faq-ask-resolved` を手で付ける**（マクロを使わない）→ 同じ結果になる（ボットはラベルしか見ない）。テストは不要。
3. **ボットが別のラベル（`faq-answered` など）を付け替えたときの `conversation_updated`** → 本文の `labels` に `faq-ask-resolved` が無いので `ignore`（Task 1 の単体テストで覆う）。
4. **解決済みの会話でマクロを押す** → `skip-resolved`、ラベルは残る（Task 3 の単体テストで覆う）。
5. **マクロを素早く 2 回押す** → 仕様 5 節で、まれに 2 通出うることを許した。テストは無い。

---

## ファイルの構成

| ファイル | 責務 | 変更 |
|---|---|---|
| `backend/faq-bot/src/constants.ts` | `LABELS.askResolved`・`MESSAGES.askResolved` | 修正 |
| `backend/faq-bot/src/chatwoot/events.ts` | `conversation_updated` → `AskResolvedEvent` / `ignore` | 修正 |
| `backend/faq-bot/src/dialog/ask-resolved.ts` | `askResolvedReply()` | 新規 |
| `backend/faq-bot/src/dialog/execute.ts` | `executeAskResolved`、`execute` の `open` での［解決しました］ | 修正 |
| `backend/faq-bot/src/handler.ts` | `ask-resolved` の分岐とログ | 修正 |
| `backend/faq-bot/tests/helpers/chatwoot.ts` | `conversationUpdatedPayload` | 修正 |
| `backend/faq-bot/tests/chatwoot/events.test.ts`・`tests/dialog/ask-resolved.test.ts`（新規）・`tests/dialog/execute.test.ts`・`tests/handler.test.ts` | 単体テスト | 修正・新規 |
| `backend/faq-bot/integration/helpers/chatwoot.ts`・`integration/ask-resolved.test.ts`（新規） | 結合テスト | 修正・新規 |
| `backend/chatwoot-system/setup/index.mjs` | ラベル・マクロの作成と `--check` | 修正 |
| 文書（前の仕様・AA-02・DD-04・faq-bot の README・`cloud/README.md`・`setup/README.md`） | 仕様 7 節 | 修正 |

---

### Task 1: `conversation_updated` を `ask-resolved` のイベントに変える

**Files:**
- Modify: `backend/faq-bot/src/constants.ts`、`backend/faq-bot/src/chatwoot/events.ts`、`backend/faq-bot/tests/helpers/chatwoot.ts`
- Test: `backend/faq-bot/tests/chatwoot/events.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AskResolvedEvent {
    readonly kind: "ask-resolved";
    readonly accountId: number;
    /** display_id */
    readonly conversationId: number;
  }
  export type BotEvent = QuestionEvent | SelectionEvent | WelcomeEvent | AskResolvedEvent | { readonly kind: "ignore"; readonly reason: string };
  // constants.ts
  LABELS.askResolved === "faq-ask-resolved"
  MESSAGES.askResolved === "ご質問は解決しましたか？まだご不明な点があれば、そのまま入力してください。"
  // tests/helpers/chatwoot.ts
  export function conversationUpdatedPayload(overrides?: Record<string, unknown>): Record<string, unknown>;
  ```

- [ ] **Step 1: 定数とテストのヘルパーを足す**

`backend/faq-bot/src/constants.ts` の `LABELS` を次に置き換える:
```ts
export const LABELS = {
  answered: "faq-answered",
  unmatched: "faq-unmatched",
  handoff: "faq-handoff",
  // 担当者がマクロ「解決の確認を送る」で付ける。ボットが外して［解決しました］ボタンを送る（2026-10-12 の解決の確認の仕様）
  askResolved: "faq-ask-resolved",
} as const;
```
`MESSAGES` の `welcome` の行の後に足す:
```ts
  askResolved: "ご質問は解決しましたか？まだご不明な点があれば、そのまま入力してください。",
```
`backend/faq-bot/tests/helpers/chatwoot.ts` の末尾に足す:
```ts
/** conversation_updated（会話の更新。ラベルの変更など）の本文。会話の webhook_data ＋ event・changed_attributes の形 */
export function conversationUpdatedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "conversation_updated",
    id: 12,
    status: "open",
    inbox_id: 3,
    labels: ["faq-handoff", "faq-ask-resolved"],
    account: { id: 1, name: "ComeGin" },
    changed_attributes: [{ label_list: { previous_value: ["faq-handoff"], current_value: ["faq-handoff", "faq-ask-resolved"] } }],
    ...overrides,
  };
}
```

- [ ] **Step 2: 失敗するテストを書く**

`backend/faq-bot/tests/chatwoot/events.test.ts` の import を次に変える:
```ts
import { conversationUpdatedPayload, questionPayload, selectionPayload, welcomePayload } from "../helpers/chatwoot.js";
```
「正常系」の `describe` の最後に足す:
```ts
    it("ラベル faq-ask-resolved が付いた会話の更新は ask-resolved", () => {
      expect(parseEvent(conversationUpdatedPayload())).toEqual({ kind: "ask-resolved", accountId: 1, conversationId: 12 });
    });

    it("ラベル faq-ask-resolved の無い会話の更新（ボットのラベルの付け替え・ステータスの変更など）は ignore", () => {
      expect(parseEvent(conversationUpdatedPayload({ labels: ["faq-answered"] }))).toMatchObject({ kind: "ignore" });
    });

    it("空入力: labels が空・null の会話の更新は ignore", () => {
      expect(parseEvent(conversationUpdatedPayload({ labels: [] }))).toMatchObject({ kind: "ignore" });
      expect(parseEvent(conversationUpdatedPayload({ labels: null }))).toMatchObject({ kind: "ignore" });
    });
```
「異常系」の `describe` の最後に足す:
```ts
    it("入力: id か account の無い conversation_updated は InvalidEventError", () => {
      const { id: _id, ...noId } = conversationUpdatedPayload();
      const { account: _account, ...noAccount } = conversationUpdatedPayload();
      expect(() => parseEvent(noId)).toThrow(InvalidEventError);
      expect(() => parseEvent(noAccount)).toThrow(InvalidEventError);
    });
```

- [ ] **Step 3: テストが落ちることを確かめる**

Run: `cd backend/faq-bot && pnpm test tests/chatwoot/events.test.ts`
Expected: FAIL。「ask-resolved」の 1 件は `{ kind: "ignore", reason: "event:conversation_updated" }` が返って落ち、異常系の 1 件は例外が出ずに落ちる（ignore の 2 件は今でも通る）。

- [ ] **Step 4: 実装する**

`backend/faq-bot/src/chatwoot/events.ts` の import を次に変える:
```ts
import { LABELS, MAX_QUESTION_CHARS } from "../constants.js";
```
`WelcomePayload` の定義の後に足す:
```ts
// 会話の webhook_data（conversation_updated）の必要な部分だけ。id は display_id
const ConversationUpdatedPayload = z.object({
  id: z.number().int().positive(),
  labels: z.array(z.string()).nullish(),
  account: z.object({ id: z.number().int().positive() }).passthrough(),
});
```
`WelcomeEvent` の後に足し、`BotEvent` を置き換える:
```ts
/** 担当者がラベル faq-ask-resolved を付けた（マクロ「解決の確認を送る」）。ボットが［解決しました］ボタンを送る */
export interface AskResolvedEvent {
  readonly kind: "ask-resolved";
  readonly accountId: number;
  /** display_id */
  readonly conversationId: number;
}

export type BotEvent = QuestionEvent | SelectionEvent | WelcomeEvent | AskResolvedEvent | { readonly kind: "ignore"; readonly reason: string };
```
`parseWelcome` の後に足す:
```ts
/** ラベル faq-ask-resolved が付いているときだけ ask-resolved。ほかの更新（ステータス・担当・ボットのラベル）は API を呼ばずに ignore */
function parseConversationUpdated(body: unknown): BotEvent {
  const parsed = ConversationUpdatedPayload.safeParse(body);
  if (!parsed.success) throw new InvalidEventError(`形式が違う（${parsed.error.issues[0]?.path.join(".") || "root"}）`);
  if (!(parsed.data.labels ?? []).includes(LABELS.askResolved)) return ignore("no-ask-resolved-label");
  return { kind: "ask-resolved", accountId: parsed.data.account.id, conversationId: parsed.data.id };
}
```
`parseEvent` の `if (name === "webwidget_triggered") return parseWelcome(body);` の次の行に足す:
```ts
  if (name === "conversation_updated") return parseConversationUpdated(body);
```

- [ ] **Step 5: テストが通ることを確かめる**

Run: `cd backend/faq-bot && pnpm test tests/chatwoot/events.test.ts`
Expected: PASS（全件）。`pnpm typecheck` は `handler.ts` で `AskResolvedEvent` に `messageId` が無いエラーが出うる（Task 4 で解消。仮の分岐は置かない）。

- [ ] **Step 6: コミットしない（ユーザーがする）**

---

### Task 2: ボタンのメッセージ（`ask-resolved.ts`）

**Files:**
- Create: `backend/faq-bot/src/dialog/ask-resolved.ts`
- Test: `backend/faq-bot/tests/dialog/ask-resolved.test.ts`

**Interfaces:**
- Consumes: `MESSAGES.askResolved`・`MESSAGES.choiceResolved`・`CHOICE.resolved`、`Reply`
- Produces: `export function askResolvedReply(): Reply;`

- [ ] **Step 1: 失敗するテストを書く**

`backend/faq-bot/tests/dialog/ask-resolved.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { CHOICE, MESSAGES } from "../../src/constants.js";
import { askResolvedReply } from "../../src/dialog/ask-resolved.js";

describe("askResolvedReply", () => {
  describe("正常系", () => {
    it("本文と［解決しました］だけの選択肢（値は前の仕様と同じ __resolved）", () => {
      expect(askResolvedReply()).toEqual({
        kind: "select",
        content: MESSAGES.askResolved,
        items: [{ title: MESSAGES.choiceResolved, value: CHOICE.resolved }],
      });
    });
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `cd backend/faq-bot && pnpm test tests/dialog/ask-resolved.test.ts`
Expected: FAIL（`src/dialog/ask-resolved.js` が無い）。

- [ ] **Step 3: 実装する**

`backend/faq-bot/src/dialog/ask-resolved.ts`:
```ts
import type { Reply } from "../chatwoot/types.js";
import { CHOICE, MESSAGES } from "../constants.js";

/** 担当者のマクロ「解決の確認を送る」で送るボタン（2026-10-12 の解決の確認の仕様 3 節）。押されると既存の［解決しました］の流れで閉じる */
export function askResolvedReply(): Reply {
  return { kind: "select", content: MESSAGES.askResolved, items: [{ title: MESSAGES.choiceResolved, value: CHOICE.resolved }] };
}
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `cd backend/faq-bot && pnpm test tests/dialog/ask-resolved.test.ts`
Expected: PASS（1 件）。

- [ ] **Step 5: コミットしない（ユーザーがする）**

---

### Task 3: `executeAskResolved` と、`open` の会話での［解決しました］

**Files:**
- Modify: `backend/faq-bot/src/dialog/execute.ts`
- Test: `backend/faq-bot/tests/dialog/execute.test.ts`

**Interfaces:**
- Consumes: `ChatwootClient.getConversation`・`setLabels`・`sendMessage`、`LABELS.askResolved`
- Produces:
  ```ts
  export type AskResolvedOutcome = "sent" | "skip-resolved" | "skip-no-label";
  export async function executeAskResolved(client: ChatwootClient, conversationId: number, reply: Reply): Promise<AskResolvedOutcome>;
  ```
  `execute` の契約の変更: 判定が `resolved` で会話が `open` のとき、ボタン自身が最新（`shouldSend` が `true`）なら続け、そうでなければ `{ outcome: "stale", sent: false }`。

- [ ] **Step 1: 失敗するテストを書く**

`backend/faq-bot/tests/dialog/execute.test.ts` の import を次に変える:
```ts
import { execute, executeAskResolved, executeWelcome } from "../../src/dialog/execute.js";
```
ファイルの末尾に足す:
```ts
const RESOLVED: Action = { decision: "resolved", reply: { kind: "text", content: "お礼" }, addLabels: [], status: "resolved", faqIds: [], topScore: null };
const ASK = { kind: "select" as const, content: "ご質問は解決しましたか？", items: [{ title: "解決しました", value: "__resolved" }] };

describe("execute（担当者が対応中〈open〉の会話）", () => {
  describe("正常系", () => {
    it("［解決しました］は、ボタンが最新のメッセージなら open の会話でもお礼を送って resolved にする", async () => {
      const { client, calls } = fakeClient(pending({ status: "open", lastMessage: { id: 101, messageType: 1, senderType: "agent_bot", inReplyTo: null } }));
      expect(await execute(client, TARGET, RESOLVED)).toEqual({ outcome: "done", sent: true });
      expect(calls).toEqual(["getConversation", "sendMessage", "setStatus"]);
      expect(client.setStatus).toHaveBeenCalledWith(12, "resolved");
    });
  });

  describe("異常系", () => {
    it("入力: ［解決しました］以外の判定は、open の会話では今までどおり何もしない（人の担当）", async () => {
      const { client, calls } = fakeClient(pending({ status: "open" }));
      expect(await execute(client, TARGET, ANSWER)).toEqual({ outcome: "not-pending", sent: false });
      expect(calls).toEqual(["getConversation"]);
    });

    it("入力: open の会話で、ボタンへのボットの返事（引き継ぎの案内など）が最新なら、お礼なしに閉じず何もしない", async () => {
      const { client, calls } = fakeClient(pending({ status: "open", lastMessage: { id: 150, messageType: 1, senderType: "agent_bot", inReplyTo: 101 } }));
      expect(await execute(client, TARGET, RESOLVED)).toEqual({ outcome: "stale", sent: false });
      expect(calls).toEqual(["getConversation"]);
    });

    it("入力: open の会話で、ボタンの後に担当者が返信していれば何もしない（担当者の対応中に前のボタンで閉じない）", async () => {
      const { client, calls } = fakeClient(pending({ status: "open", lastMessage: { id: 160, messageType: 1, senderType: "user", inReplyTo: null } }));
      expect(await execute(client, TARGET, RESOLVED)).toEqual({ outcome: "stale", sent: false });
      expect(calls).toEqual(["getConversation"]);
    });

    it("入力: 解決済みの会話の［解決しました］は何もしない", async () => {
      const { client } = fakeClient(pending({ status: "resolved" }));
      expect(await execute(client, TARGET, RESOLVED)).toEqual({ outcome: "not-pending", sent: false });
    });
  });
});

describe("executeAskResolved", () => {
  describe("正常系", () => {
    it("ラベル faq-ask-resolved を外してから、in_reply_to なしでボタンを 1 通送る（ほかのラベルは残す）", async () => {
      const { client, calls } = fakeClient(pending({ status: "open", labels: ["faq-handoff", "faq-ask-resolved"] }));
      expect(await executeAskResolved(client, 12, ASK)).toBe("sent");
      expect(calls).toEqual(["getConversation", "setLabels", "sendMessage"]);
      expect(client.setLabels).toHaveBeenCalledWith(12, ["faq-handoff"]);
      expect(client.sendMessage).toHaveBeenCalledWith(12, ASK, null);
    });
  });

  describe("異常系", () => {
    it("入力: 解決済みの会話では何もしない（ラベルも外さない）", async () => {
      const { client, calls } = fakeClient(pending({ status: "resolved", labels: ["faq-ask-resolved"] }));
      expect(await executeAskResolved(client, 12, ASK)).toBe("skip-resolved");
      expect(calls).toEqual(["getConversation"]);
    });

    it("入力: ラベルがもう無ければ何もしない（同じイベントの重複・二度押しの 2 つ目）", async () => {
      const { client, calls } = fakeClient(pending({ status: "open", labels: ["faq-handoff"] }));
      expect(await executeAskResolved(client, 12, ASK)).toBe("skip-no-label");
      expect(calls).toEqual(["getConversation"]);
    });

    it("サーバ: ラベルを外せなければ例外（送らない）", async () => {
      const { client, calls } = fakeClient(pending({ labels: ["faq-ask-resolved"] }), "setLabels");
      await expect(executeAskResolved(client, 12, ASK)).rejects.toBeInstanceOf(ChatwootApiError);
      expect(calls).toEqual(["getConversation", "setLabels"]);
    });

    it("サーバ: 送信に失敗したら例外（ラベルは外れている。担当者がもう一度押せば出る）", async () => {
      const { client } = fakeClient(pending({ labels: ["faq-ask-resolved"] }), "sendMessage");
      await expect(executeAskResolved(client, 12, ASK)).rejects.toBeInstanceOf(ChatwootApiError);
    });
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `cd backend/faq-bot && pnpm test tests/dialog/execute.test.ts`
Expected: FAIL。`executeAskResolved is not a function`、open の［解決しました］が `not-pending` で落ちる（open の「何もしない」系は今でも通るものがある）。

- [ ] **Step 3: 実装する**

`backend/faq-bot/src/dialog/execute.ts` の import に `LABELS` を足す:
```ts
import { LABELS, MESSAGE_TYPE_OUTGOING, MESSAGE_TYPE_TEMPLATE } from "../constants.js";
```
`execute` の先頭の 2 行（`const view = …` と `if (view.status !== "pending") …`）と、`const send = …`・`if (send === "stale") …` を次に置き換える:
```ts
  const view = await client.getConversation(target.conversationId);
  // ［解決しました］だけは、担当者が対応中（open）の会話でも受け付ける（2026-10-12 の解決の確認の仕様 3 節）。ほかは pending のときだけ
  const resolvingOpen = action.decision === "resolved" && view.status === "open";
  if (view.status !== "pending" && !resolvingOpen) return { outcome: "not-pending", sent: false };

  const send = shouldSend(view.lastMessage, target.messageId);
  if (send === "stale") return { outcome: "stale", sent: false };
  // open の会話では、ボタン自身が最新のときだけ閉じる。ボタンへのボットの返事（引き継ぎの案内など）が後にあれば、お礼なしに閉じない
  if (resolvingOpen && !send) return { outcome: "stale", sent: false };
```
ファイルの末尾に足す:
```ts
export type AskResolvedOutcome = "sent" | "skip-resolved" | "skip-no-label";

/**
 * 担当者のマクロ「解決の確認を送る」（ラベル faq-ask-resolved）への応答（2026-10-12 の解決の確認の仕様 3 節の 4〜6）。
 * 会話を読み直し、解決済みなら何もしない。ラベルがまだあれば、送る前に外す（二度押し・重複したイベントで 2 通出さないため）。失敗は例外
 */
export async function executeAskResolved(client: ChatwootClient, conversationId: number, reply: Reply): Promise<AskResolvedOutcome> {
  const view = await client.getConversation(conversationId);
  if (view.status === "resolved") return "skip-resolved";
  if (!view.labels.includes(LABELS.askResolved)) return "skip-no-label";
  await client.setLabels(conversationId, view.labels.filter((label) => label !== LABELS.askResolved));
  await client.sendMessage(conversationId, reply, null);
  return "sent";
}
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `cd backend/faq-bot && pnpm test tests/dialog/execute.test.ts`
Expected: PASS（全件。既存の「pending でなければ何もしない」のテストも通る）。

- [ ] **Step 5: コミットしない（ユーザーがする）**

---

### Task 4: 本体（`handler.ts`）で `ask-resolved` を扱う

**Files:**
- Modify: `backend/faq-bot/src/handler.ts`
- Test: `backend/faq-bot/tests/handler.test.ts`

**Interfaces:**
- Consumes: `AskResolvedEvent`（Task 1）、`askResolvedReply`（Task 2）、`executeAskResolved`（Task 3）
- Produces: 応答の本文 `{"result":"ask-resolved"}`・`{"result":"skip-resolved"}`・`{"result":"skip-no-label"}`（200）。ログ 1 行 `{ t, level: "info", event: "ask-resolved", conversation, decision, ms }`

- [ ] **Step 1: 失敗するテストを書く**

`backend/faq-bot/tests/handler.test.ts` の `setup` の引数に `conversation?: Partial<ConversationView>` を足し、`getConversation` の戻り値をそれで上書きする（既存の呼び出しはそのまま動く）。import に `ConversationView` と `conversationUpdatedPayload` と `MESSAGES`（既にある）を足す:
```ts
import type { ConversationStatus, ConversationView } from "../src/chatwoot/types.js";
import { conversationUpdatedPayload, questionPayload, sign, welcomePayload } from "./helpers/chatwoot.js";
```
`setup` の型と `getConversation` を次にする:
```ts
function setup(
  options: { faqFails?: boolean; clientFails?: boolean; faqItems?: FaqItem[]; createdStatus?: ConversationStatus; conversation?: Partial<ConversationView> } = {},
) {
```
```ts
    getConversation: vi.fn(async () => {
      if (options.clientFails) throw new ChatwootApiError(503, "GET conversations/12", "HTTP 503");
      return {
        status: "pending" as ConversationStatus,
        labels: [] as readonly string[],
        lastMessage: { id: 101, messageType: 0, senderType: "contact", inReplyTo: null },
        ...options.conversation,
      };
    }),
```
ファイルの末尾に足す:
```ts
describe("createHandler（担当者のマクロ「解決の確認を送る」）", () => {
  describe("正常系", () => {
    it("ラベル faq-ask-resolved が付いたら、ラベルを外してから［解決しました］ボタンを送り、ログを 1 行出す", async () => {
      const { handle, client, log } = setup({ conversation: { status: "open", labels: ["faq-handoff", "faq-ask-resolved"] } });
      expect(await handle(signed(JSON.stringify(conversationUpdatedPayload())))).toEqual({ status: 200, body: '{"result":"ask-resolved"}' });
      expect(client.setLabels).toHaveBeenCalledWith(12, ["faq-handoff"]);
      expect(client.sendMessage).toHaveBeenCalledWith(12, { kind: "select", content: MESSAGES.askResolved, items: [{ title: "解決しました", value: "__resolved" }] }, null);
      expect(client.setLabels.mock.invocationCallOrder[0]).toBeLessThan(client.sendMessage.mock.invocationCallOrder[0]!);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "ask-resolved", conversation: 12, decision: "ask-resolved" }));
    });

    it("ラベルの無い会話の更新は、Chatwoot の API を呼ばずに 200 で何もしない", async () => {
      const { handle, client } = setup();
      expect((await handle(signed(JSON.stringify(conversationUpdatedPayload({ labels: ["faq-answered"] }))))).body).toBe('{"result":"ignored"}');
      expect(client.getConversation).not.toHaveBeenCalled();
    });

    it("解決済みの会話では何もしない（skip-resolved）", async () => {
      const { handle, client } = setup({ conversation: { status: "resolved", labels: ["faq-ask-resolved"] } });
      expect((await handle(signed(JSON.stringify(conversationUpdatedPayload())))).body).toBe('{"result":"skip-resolved"}');
      expect(client.setLabels).not.toHaveBeenCalled();
    });

    it("読み直したらラベルがもう無ければ何もしない（skip-no-label）", async () => {
      const { handle, client } = setup({ conversation: { status: "open", labels: ["faq-handoff"] } });
      expect((await handle(signed(JSON.stringify(conversationUpdatedPayload())))).body).toBe('{"result":"skip-no-label"}');
      expect(client.sendMessage).not.toHaveBeenCalled();
    });

    it("別のアカウントの会話の更新は 200 で何もしない", async () => {
      const { handle, client } = setup();
      expect((await handle(signed(JSON.stringify(conversationUpdatedPayload({ account: { id: 2 } }))))).body).toBe('{"result":"ignored"}');
      expect(client.getConversation).not.toHaveBeenCalled();
    });
  });

  describe("異常系", () => {
    it("サーバ: Chatwoot の API の失敗は例外", async () => {
      const { handle } = setup({ clientFails: true });
      await expect(handle(signed(JSON.stringify(conversationUpdatedPayload())))).rejects.toBeInstanceOf(ChatwootApiError);
    });
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `cd backend/faq-bot && pnpm test tests/handler.test.ts`
Expected: FAIL（`ask-resolved` が `decide` に渡って想定と違う結果になる）。

- [ ] **Step 3: 実装する**

`backend/faq-bot/src/handler.ts` の import を次に変える:
```ts
import { type AskResolvedEvent, type BotEvent, InvalidEventError, parseEvent, type WelcomeEvent } from "./chatwoot/events.js";
```
```ts
import { askResolvedReply } from "./dialog/ask-resolved.js";
import { execute, executeAskResolved, executeWelcome } from "./dialog/execute.js";
```
`handleWelcome` の後に足す:
```ts
  /** 担当者のマクロ「解決の確認を送る」（2026-10-12 の解決の確認の仕様 3 節）。ラベルを外してから［解決しました］ボタンを送る */
  async function handleAskResolved(event: AskResolvedEvent, startedAt: number): Promise<HttpResponse> {
    const outcome = await executeAskResolved(client, event.conversationId, askResolvedReply());
    const decision = outcome === "sent" ? "ask-resolved" : outcome;
    log({ t: new Date().toISOString(), level: "info", event: event.kind, conversation: event.conversationId, decision, ms: Date.now() - startedAt });
    return json(200, { result: decision });
  }
```
`if (event.kind === "welcome") return handleWelcome(event, startedAt);` の次の行に足す:
```ts
    if (event.kind === "ask-resolved") return handleAskResolved(event, startedAt);
```

- [ ] **Step 4: テストが通ることと、全体・型の検査**

Run: `cd backend/faq-bot && pnpm test tests/handler.test.ts && pnpm test && pnpm typecheck`
Expected: すべて PASS、型の検査はエラー 0。件数を進捗の記録に書く。

- [ ] **Step 5: コミットしない（ユーザーがする）**

---

### Task 5: Chatwoot の setup（ラベルとマクロ）

**Files:**
- Modify: `backend/chatwoot-system/setup/index.mjs`

**Interfaces:**
- Consumes: Chatwoot の `labels`・`macros`（`GET`／`POST /api/v1/accounts/{id}/macros`。一覧は `payload` の配列）
- Produces: 開発の Chatwoot にラベル `faq-ask-resolved` とマクロ「解決の確認を送る」。`--check` に 1 行

- [ ] **Step 1: ラベルを足す**

`FAQ_LABELS` の配列の最後に足す:
```js
  { title: "faq-ask-resolved", description: "担当者が解決の確認を送るときに付ける（マクロ「解決の確認を送る」用。ボットがすぐ外して［解決しました］ボタンを送る）", color: "#1565C0" },
```

- [ ] **Step 2: マクロを作る関数を足す**

`FAQ_LABELS` の後に定数を足す:
```js
// 担当者が管理画面から［解決しました］ボタンを出すためのマクロ（docs/superpowers/specs/2026-10-12-faq-bot-ask-resolved-design.md）。中身はラベルを付けるだけ
const ASK_RESOLVED_MACRO = { name: "解決の確認を送る", visibility: "global", actions: [{ action_name: "add_label", action_params: ["faq-ask-resolved"] }] };
```
`ensureFaqBot` の後に足す:
```js
/** マクロ「解決の確認を送る」を作る（名前で探し、あれば作らない）。管理者が作るので全員で使える（visibility: global） */
async function ensureAskResolvedMacro(ctx) {
  const base = `${BASE_URL}/api/v1/accounts/${ctx.state.get("CHATWOOT_ACCOUNT_ID")}`;
  const adminToken = ctx.state.get("CHATWOOT_ADMIN_TOKEN");
  const list = await ctx.http("Chatwoot マクロ一覧", `${base}/macros`, withToken(adminToken));
  if ((list?.payload ?? []).some((macro) => macro.name === ASK_RESOLVED_MACRO.name)) {
    ctx.log(`マクロ「${ASK_RESOLVED_MACRO.name}」は既にある`);
    return;
  }
  await ctx.http("Chatwoot マクロ作成", `${base}/macros`, { method: "POST", ...withToken(adminToken), json: ASK_RESOLVED_MACRO });
  ctx.log(`マクロ「${ASK_RESOLVED_MACRO.name}」を作った（ラベル faq-ask-resolved を付ける。ボットが［解決しました］ボタンを送る）`);
}
```
`apply` の `await ensureFaqBot(ctx);` の次の行に足す:
```js
  await ensureAskResolvedMacro(ctx);
```
`check` の「担当者への引き継ぎは管理者にメールで届く」の判定の後（`if (!isMember || !mailOn) ok = false;` の次の行）に足す:
```js
    const macros = await ctx.http("Chatwoot マクロ一覧", `${base}/macros`, withToken(adminToken)).catch(() => null);
    const hasMacro = (macros?.payload ?? []).some((macro) => macro.name === ASK_RESOLVED_MACRO.name);
    notes.push(hasMacro ? `マクロ「${ASK_RESOLVED_MACRO.name}」がある` : `マクロ「${ASK_RESOLVED_MACRO.name}」が無い`);
    if (!hasMacro) ok = false;
```
ファイルの先頭のコメントの「→ 担当者への引き継ぎのメール通知（管理者）。」を「→ マクロ「解決の確認を送る」→ 担当者への引き継ぎのメール通知（管理者）。」に変える。

- [ ] **Step 3: 開発の Chatwoot に当てて確かめる**

Run: `node setup/setup.mjs --target dev --only chatwoot && node setup/setup.mjs --target dev --only chatwoot --check`
Expected: 「ラベル faq-ask-resolved を作った」「マクロ「解決の確認を送る」を作った」が出て、`--check` が「✓ 用意できている」で「マクロ「解決の確認を送る」がある」を含む。続けて `cd setup && pnpm test` が 137 件 PASS。

- [ ] **Step 4: コミットしない（ユーザーがする）**

---

### Task 6: 結合テスト（開発の Chatwoot を本物として使う）

**Files:**
- Modify: `backend/faq-bot/integration/helpers/chatwoot.ts`（`Admin.setLabels`・`Admin.reply`）
- Create: `backend/faq-bot/integration/ask-resolved.test.ts`

**Interfaces:**
- Produces: `Admin.setLabels(conversationId: number, labels: string[]): Promise<void>`（管理者のトークンでラベルを付け替える。マクロと同じ結果）、`Admin.reply(conversationId: number, content: string): Promise<void>`（担当者の公開の返信）

- [ ] **Step 1: 管理者の操作を足す**

`backend/faq-bot/integration/helpers/chatwoot.ts` の `Admin` の `deleteContact` の前に足す:
```ts
  /** ラベルを付け替える（マクロ「解決の確認を送る」はラベル faq-ask-resolved を足すだけなので、同じ結果になる） */
  async setLabels(id: number, labels: string[]): Promise<void> {
    await ok(await fetch(this.url(`/conversations/${id}/labels`), { method: "POST", headers: { api_access_token: this.state.adminToken, "Content-Type": "application/json" }, body: JSON.stringify({ labels }) }), "labels");
  }

  /** 担当者の公開の返信（管理画面の返信欄と同じ） */
  async reply(id: number, content: string): Promise<void> {
    await ok(await fetch(this.url(`/conversations/${id}/messages`), { method: "POST", headers: { api_access_token: this.state.adminToken, "Content-Type": "application/json" }, body: JSON.stringify({ content, message_type: "outgoing", private: false }) }), "reply");
  }
```

- [ ] **Step 2: 結合テストを書く**

`backend/faq-bot/integration/ask-resolved.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MESSAGES } from "../src/constants.js";
import { startBot } from "./helpers/bot.js";
import { Admin, botMessage, Visitor, waitFor } from "./helpers/chatwoot.js";
import { startFaqServer } from "./helpers/faq-server.js";
import { readState } from "./helpers/state.js";

const state = readState();
const admin = new Admin(state);
const contacts: number[] = [];
let stopBot: () => Promise<void>;
let stopFaq: () => Promise<void>;

beforeAll(async () => {
  const faq = await startFaqServer();
  stopFaq = faq.close;
  stopBot = (await startBot(state, faq.url)).stop;
});

afterAll(async () => {
  await stopBot?.();
  await stopFaq?.();
  for (const id of contacts) await admin.deleteContact(id);
});

async function newVisitor(): Promise<Visitor> {
  const visitor = await Visitor.create(state, `it-faq-bot-${Date.now()}`);
  contacts.push(visitor.contactId);
  return visitor;
}

/** FAQ に無い質問で担当者に引き継がせ、open の会話にする */
async function handedOff(visitor: Visitor): Promise<number> {
  const { conversation_id } = await visitor.say("営業時間は何時までですか");
  await waitFor(async () => (await admin.conversation(conversation_id)).status === "open", "引き継いで open になる");
  return conversation_id;
}

const isAsk = (m: { content: string | null }) => m.content === MESSAGES.askResolved;

describe("担当者のマクロ「解決の確認を送る」（開発の Chatwoot）", () => {
  describe("正常系", () => {
    it("open の会話にラベル faq-ask-resolved を付けると、ボットがラベルを外して［解決しました］ボタンを送る", async () => {
      const visitor = await newVisitor();
      const id = await handedOff(visitor);
      await admin.reply(id, "営業時間は平日 9 時から 18 時です。");
      const before = await admin.conversation(id);
      await admin.setLabels(id, [...before.labels, "faq-ask-resolved"]);
      const ask = await botMessage(visitor, isAsk, "解決の確認のボタン");
      expect(ask.content_attributes?.items).toEqual([{ title: "解決しました", value: "__resolved" }]);
      const after = await waitFor(async () => {
        const c = await admin.conversation(id);
        return c.labels.includes("faq-ask-resolved") ? null : c;
      }, "ラベルが外れる");
      expect(after).toEqual({ status: "open", labels: ["faq-unmatched"] });
    });

    it("訪問者がそのボタンの［解決しました］を押すと、お礼を返して resolved にする（open の会話でも）", async () => {
      const visitor = await newVisitor();
      const id = await handedOff(visitor);
      await admin.setLabels(id, ["faq-unmatched", "faq-ask-resolved"]);
      const ask = await botMessage(visitor, isAsk, "解決の確認のボタン");
      await visitor.select(ask.id, { title: "解決しました", value: "__resolved" });
      await waitFor(async () => (await admin.conversation(id)).status === "resolved", "resolved になる");
      await botMessage(visitor, (m) => (m.content ?? "").startsWith("お役に立ててよかったです"), "お礼");
    });
  });

  describe("異常系", () => {
    it("入力: ボタンの後に担当者が返信してから押しても、何もしない（open のまま）", async () => {
      const visitor = await newVisitor();
      const id = await handedOff(visitor);
      await admin.setLabels(id, ["faq-unmatched", "faq-ask-resolved"]);
      const ask = await botMessage(visitor, isAsk, "解決の確認のボタン");
      await admin.reply(id, "追加でご案内です。");
      await visitor.select(ask.id, { title: "解決しました", value: "__resolved" });
      // 何も起きないことを確かめるため、Webhook が処理されるだけの時間を待つ
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      expect((await admin.conversation(id)).status).toBe("open");
      expect((await visitor.messages()).some((m) => (m.content ?? "").startsWith("お役に立ててよかったです"))).toBe(false);
    });
  });
});
```

- [ ] **Step 3: 結合テストを走らせる**

前提: Task 5 が済んでいる（ラベルがある）、開発の faq-bot（`pnpm dev`）を止める（テストが 3107 で起動する）。終わったら `pnpm dev` を起動し直す。
Run: `cd backend/faq-bot && pnpm test:integration > <workspace>/integration.log 2>&1; tail -n 15 <workspace>/integration.log`
Expected: PASS（既存の 16 件 ＋ 3 件 ＝ 19 件）。落ちたら superpowers:systematic-debugging。

- [ ] **Step 4: コミットしない（ユーザーがする）**

---

### Task 7: 文書の更新と、管理画面での確認

**Files:**
- Modify: `docs/superpowers/specs/2026-10-11-faq-bot-design.md`、`docs/RequirementDefinition/AA/02-integration-architecture.md`、`docs/DetailedDesign/04-server-to-server-flows.md`、`backend/faq-bot/README.md`、`cloud/README.md`、`setup/README.md`

- [ ] **Step 1: 前の仕様**

7.1 節の表の `webwidget_triggered` の行の直後に足す:
```markdown
| `conversation_updated` | 本文の `labels` にラベル `faq-ask-resolved`（担当者のマクロ「解決の確認を送る」）があるときだけ。ラベルを外して［解決しました］ボタンを送る（2026-10-12 に追加。`docs/superpowers/specs/2026-10-12-faq-bot-ask-resolved-design.md`） |
```
7.4 節の「1. `show` を呼ぶ（ステータス・ラベル・`last_non_activity_message`）。`pending` でなければ終了。」を「1. `show` を呼ぶ（ステータス・ラベル・`last_non_activity_message`）。`pending` でなければ終了。**ただし［解決しました］は `open` でも続け、そのときはボタン自身が最新のメッセージの場合だけお礼を送って閉じる**（2026-10-12 に追加。解決の確認の仕様の 3 節）。」に変える。

- [ ] **Step 2: AA-02 と DD-04**

AA-02 の I-31 の行の「ウィジェットを開いた（`webwidget_triggered`。2026-10-12 に追加）」の後に「・担当者のマクロ「解決の確認を送る」（`conversation_updated`。2026-10-12 に追加）」を足す。
DD-04 の 12.3 節の後に足す:
```markdown
### 12.4 担当者のマクロ「解決の確認を送る」（2026-10-12 に追加）

仕様は `docs/superpowers/specs/2026-10-12-faq-bot-ask-resolved-design.md`。管理画面からはボタンを送れないため、担当者はマクロでラベル `faq-ask-resolved` を付け、ボットがボタンを送る。

1. `conversation_updated` の本文の `labels` に `faq-ask-resolved` が無ければ何もしない（API を呼ばない）。
2. 会話の `show` を読む。`resolved` なら何もしない。ラベルがもう無ければ何もしない。
3. ラベルを外してから、［解決しました］（`__resolved`）の `input_select` を 1 通送る（`in_reply_to` なし）。
4. 訪問者が押すと、`open` の会話でもお礼を送って `resolved` にする（ボタン自身が最新のメッセージのときだけ。担当者がその後に返信していれば何もしない）。
```

- [ ] **Step 3: faq-bot の README・cloud の README・setup の README**

`backend/faq-bot/README.md` の「動き」の表の最後に足す:
```markdown
| 担当者がマクロ「解決の確認を送る」を押した（ラベル `faq-ask-resolved`） | ラベルを外して「ご質問は解決しましたか？…」と［解決しました］ | （`faq-ask-resolved` を外す） | そのまま |
| 担当者の対応中（`open`）に［解決しました］ | お礼（ボタンが最新のメッセージのときだけ） | — | `resolved` |
```
`cloud/README.md` の 4.14 の手順 7 の最後の箇条の後に足す:
```markdown
   - **ラベル `faq-ask-resolved` と、マクロ「解決の確認を送る」を作る**（「設定 → ラベル」と「設定 → マクロ」。マクロは全員で共有し、動作は「ラベルを追加: `faq-ask-resolved`」だけ）。担当者が返信の後にこのマクロを押すと、ボットが訪問者に［解決しました］ボタンを送る（`docs/superpowers/specs/2026-10-12-faq-bot-ask-resolved-design.md`）。
```
`setup/README.md` の chatwoot の行の「エージェントボット「FAQ ボット」と受信箱への接続」の後に「・マクロ「解決の確認を送る」（ラベル `faq-ask-resolved` を付ける）」を足す（ラベルの数「3 つ」は「4 つ」に）。

- [ ] **Step 4: 本物のウィジェットで確かめる（playwright-host）**

管理画面へのログインには管理者のパスワードが要り、画面やログに出さずに扱えないため、**マクロの実行は管理者のトークンでラベルを付ける API で代える**（マクロの中身はラベルを付けるだけなので、ボットから見て同じ）。マクロがあることは Task 5 の `--check` で確かめている。

1. 開発の faq-bot を起動しておく（`pnpm dev`）。
2. 開発のサイト（`http://localhost:4321/`）のウィジェットで「営業時間は何時までですか」と送り、担当者に回す。
3. 使い捨てのスクリプト（scratchpad。`integration/helpers/chatwoot.ts` の `Admin` を使う）で、その会話に担当者の返信（`Admin.reply`）とラベル `faq-ask-resolved`（`Admin.setLabels`）を足す。会話の番号は、ウィジェットの Cookie からではなく、管理者の API の会話の一覧（受信箱 5 の最新の `open`）から取る。
4. ウィジェットに「ご質問は解決しましたか？…」と［解決しました］が出ることを確かめ、押して会話が解決済みになり、「新しいチャットを開始する」が出ることを確かめる。スクリーンショット `faq-bot-ask-resolved.png`。
5. 後片付け: 確認用のコンタクトを消す（オンライン中は 422 なので、ブラウザを閉じて 90 秒待つ）。

Expected: 2〜4 のとおりに見える。違えば superpowers:systematic-debugging。

- [ ] **Step 5: 最後に全体を走らせる**

Run: `cd backend/faq-bot && pnpm test && pnpm typecheck`
Expected: 単体テストはすべて PASS、型の検査はエラー 0。

- [ ] **Step 6: コミットしない（ユーザーがする）**
