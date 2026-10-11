# faq-bot「ウィジェットを開いたときのよくあるご質問の一覧」実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 訪問者が Chatwoot のウィジェットを開いたとき、faq-bot が会話を作り、トップページの FAQ（最大 6 件）を選択肢で出す。

**Architecture:** `webwidget_triggered` の Webhook を `parseEvent` が `welcome` のイベントに変え、`handler` が「進行中の会話が無いか」を見て、`welcomeItems`（`top-` の項目）で選択肢を作り、`executeWelcome` がボットのトークンで会話を作って 1 通送る。選ばれた後は既存の「選択: FAQ の `id`」の流れに乗る（`decide.ts` は変えない）。

**Tech Stack:** TypeScript（Node 22 以上）・zod v4・vitest 5・pnpm 11。開発の Chatwoot v4.18.0（Docker。127.0.0.1:3100）。

**Spec:** `docs/superpowers/specs/2026-10-12-faq-bot-welcome-design.md`（前提は `docs/superpowers/specs/2026-10-11-faq-bot-design.md`）

## Global Constraints

- 一覧に出すのは id が `top-` で始まる項目だけ、`faq.json` の順に**最大 6 件**（`MAX_WELCOME_ITEMS = 6`、`WELCOME_PAGE_KEY = "top"`）。
- 一覧を出すのは `current_conversation` が `null` か、その `status` が `resolved` のときだけ。
- 会話の作成では `status` を渡さない。**作成の応答のステータスが `pending` でなければ送らない。**
- 一覧のメッセージには `in_reply_to` を入れない。
- 一覧の本文は「よくあるご質問です。当てはまらなければ、ご質問をそのまま入力してください。」（仮。R3 が見直す）。［上記以外を質問する］のボタンは置かない。
- 選択肢の見出しは既存の `candidateTitle`、値は FAQ の `id`。
- ログは 1 件 1 行。`event: "welcome"`・`decision`（`welcome` / `skip-active` / `skip-empty` / `skip-not-pending`）・`faq`（id の配列）・`conversation`・`ms`。**`source_id`・氏名・メール・トークンは出さない。**
- 失敗（`faq.json` が無い・Chatwoot の API の失敗）は例外にする（入口が 502）。
- `decide.ts` と Chatwoot の設定・setup は変えない。
- リポジトリの規則: **git の状態を変えるコマンド（commit など）は使わない**（各タスクの最後は「コミットしない」）。ビルド・デプロイはしない。`npm` ではなく `pnpm`。`.env` の実体・`samconfig.toml`・`secrets/` を読み書きしない。秘密値（トークン・secret・source_id）を画面やログに出さない。Python は使わない。
- コメント・文書・テスト名は日本語。テスト名は既存の書き方（正常系／異常系に分け、`空入力:`・`入力:`・`サーバ:` の接頭辞）に合わせる。

## Review Focus

1. **素早く 2 回開く**（2 つ目の `webwidget_triggered` の時点で 1 つ目の会話がまだ無い）→ 会話が 2 つできうる。仕様 5 節で許した挙動で、テストは無い。重複の度合いがログ（`decision: "welcome"` が同じ秒に 2 件）で追えることを確かめる。
2. **開いた後に打ち込み、その後で一覧の項目を押す** → 前の仕様 7.4 の規則で「古いイベント」として何もしない。既存の結合テスト（前の回答の［解決しました］を後から押す）と同じ判定で、このタスクでは足さない。
3. **一覧の項目が `faq.json` から消えた後で押す** → 既存の `decideSelection` が `faq-unmatched` で引き継ぐ。既存の単体テストで覆われている。
4. **受信箱が `lock_to_single_conversation`** → 作成の応答が既存の解決済みの会話になり、送らない（Task 4 と Task 5 の単体テストで覆う）。
5. **`webwidget_triggered` の本文の `current_conversation` に知らないステータス** → `InvalidEventError` で 400（Task 2 の単体テストで覆う）。Chatwoot は 400 では送り直さず、何もしない（訪問者は打ち込めば前の仕様の流れ）。

---

## ファイルの構成

| ファイル | 責務 | 変更 |
|---|---|---|
| `backend/faq-bot/src/chatwoot/client.ts` | `createConversation` を足す。`sendMessage` の `inReplyTo` を `number \| null` に | 修正 |
| `backend/faq-bot/src/chatwoot/events.ts` | `webwidget_triggered` → `WelcomeEvent` | 修正 |
| `backend/faq-bot/src/constants.ts` | `MESSAGES.welcome`・`WELCOME_PAGE_KEY`・`MAX_WELCOME_ITEMS` | 修正 |
| `backend/faq-bot/src/dialog/welcome.ts` | `welcomeItems`・`welcomeReply`（副作用なし） | 新規 |
| `backend/faq-bot/src/dialog/execute.ts` | `executeWelcome` | 修正 |
| `backend/faq-bot/src/handler.ts` | `welcome` の分岐とログ | 修正 |
| `backend/faq-bot/tests/helpers/chatwoot.ts` | `welcomePayload` | 修正 |
| `backend/faq-bot/tests/chatwoot/client.test.ts`・`tests/chatwoot/events.test.ts`・`tests/dialog/welcome.test.ts`（新規）・`tests/dialog/execute.test.ts`・`tests/handler.test.ts` | 単体テスト | 修正・新規 |
| `backend/faq-bot/integration/helpers/chatwoot.ts`・`integration/helpers/faq-server.ts`・`integration/welcome.test.ts`（新規） | 結合テスト | 修正・新規 |
| 文書（前の仕様・AA-02・DD-04・faq-bot の README） | 7 節 | 修正 |

---

### Task 1: T0 — ボットが作った会話がウィジェットに出るかを確かめる（コードは書かない）

**Files:**
- Create: `<scratchpad>/t0-welcome.mts`（リポジトリの外。終わったら消してよい）

**Interfaces:**
- Consumes: `backend/faq-bot/integration/helpers/state.ts` の `readState()`（`accountId`・`adminToken`・`inboxId`・`botToken`）
- Produces: 判定（出る／出ない）。**出なければ、ここで止めてユーザーに相談する**（仕様 9 節の T0）。

- [ ] **Step 1: 開発の環境が動いていることを確かめる**

Run:
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/api ; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4321/
```
Expected: `200` が 2 行（Chatwoot と Astro の dev）。Astro が止まっていれば `cd frontend/verdant-virgo && pnpm exec astro dev --background`。

- [ ] **Step 2: playwright-host でサイトを開き、ウィジェットのバブルを押す**

`mcp__playwright-host__browser_navigate` で `http://localhost:4321/` を開き、`browser_snapshot` で Chatwoot のバブルを探して `browser_click` で開く（ウィジェットが訪問者を作り、親のページに `cw_conversation` の Cookie〈JWT〉を置く）。

- [ ] **Step 3: Cookie から source_id と inbox_id を取り出す（画面に出さず、スクリプトに渡す）**

`browser_evaluate` で次を実行し、戻り値を Step 4 のスクリプトの引数にする（source_id は秘密値ではないが、ログに残さないため返事の文に書き写さない）:
```js
() => {
  const raw = document.cookie.split("; ").find((c) => c.startsWith("cw_conversation="))?.split("=")[1];
  if (!raw) return null;
  const payload = JSON.parse(atob(raw.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  return { sourceId: payload.source_id, inboxId: payload.inbox_id };
}
```
Expected: `{ sourceId: "<uuid>", inboxId: 5 }`。`null` ならバブルを開き直す。

- [ ] **Step 4: ボットのトークンで会話を作り、選択肢のメッセージを送るスクリプトを書く**

`<scratchpad>/t0-welcome.mts`:
```ts
// T0: ボットのトークンで作った会話のメッセージが、開いているウィジェットに出るかを確かめる（使い捨て）
import { readState } from "/home/kamegin/ComeGin/systematization-of-the-business-foundation/backend/faq-bot/integration/helpers/state.ts";

const [sourceId, inboxId] = [process.argv[2], Number(process.argv[3])];
const state = readState();
const base = `http://127.0.0.1:3100/api/v1/accounts/${state.accountId}/conversations`;
const headers = { api_access_token: state.botToken, "Content-Type": "application/json" };

const created = await fetch(base, { method: "POST", headers, body: JSON.stringify({ source_id: sourceId, inbox_id: inboxId }) });
const conversation = (await created.json()) as { id: number; status: string; meta?: { sender?: { id?: number } } };
console.log(`作成: HTTP ${created.status} 会話 ${conversation.id} ステータス ${conversation.status} コンタクト ${conversation.meta?.sender?.id}`);

const sent = await fetch(`${base}/${conversation.id}/messages`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    content: "T0: よくあるご質問です。",
    message_type: "outgoing",
    private: false,
    content_type: "input_select",
    content_attributes: { items: [{ title: "料金は税込ですか？", value: "top-3" }] },
  }),
});
console.log(`送信: HTTP ${sent.status}`);
```

- [ ] **Step 5: スクリプトを実行する**

Run（`<sourceId>` と `<inboxId>` は Step 3 の値）:
```bash
cd /home/kamegin/ComeGin/systematization-of-the-business-foundation/backend/faq-bot && pnpm exec tsx <scratchpad>/t0-welcome.mts <sourceId> <inboxId>
```
Expected: `作成: HTTP 200 会話 <n> ステータス pending コンタクト <id>` と `送信: HTTP 200`。ステータスが `pending` でなければ、仕様 2 節の前提が違うので止めて相談する。

- [ ] **Step 6: ウィジェットに出たかを見る**

ページを**再読み込みせずに** `browser_snapshot` と `browser_take_screenshot`（`faq-bot-welcome-t0.png`）で、ウィジェットに「T0: よくあるご質問です。」と［料金は税込ですか？］が出ているかを見る。出ていなければ 5 秒待ってもう一度見る。

Expected: 再読み込みなしで出る → Task 2 へ進む。
- 再読み込みしたときだけ出る／出ない → **止めてユーザーに相談する**（見たものとスクリーンショットを添える）。

- [ ] **Step 7: 後片付け**

管理者のトークンで、Step 5 のコンタクトを消す（会話も消える）。`<scratchpad>/t0-cleanup.mts`:
```ts
// T0 の後片付け: 管理者のトークンでコンタクトを消す（使い捨て）
import { readState } from "/home/kamegin/ComeGin/systematization-of-the-business-foundation/backend/faq-bot/integration/helpers/state.ts";

const state = readState();
const res = await fetch(`http://127.0.0.1:3100/api/v1/accounts/${state.accountId}/contacts/${process.argv[2]}`, {
  method: "DELETE",
  headers: { api_access_token: state.adminToken },
});
console.log(`削除: HTTP ${res.status}`);
```
Run:
```bash
cd /home/kamegin/ComeGin/systematization-of-the-business-foundation/backend/faq-bot && pnpm exec tsx <scratchpad>/t0-cleanup.mts <contactId>
```
Expected: `削除: HTTP 200`。ブラウザは `browser_close` で閉じる。

- [ ] **Step 8: 結果を進捗の記録に書く（コミットしない）**

---

### Task 2: `webwidget_triggered` を `welcome` のイベントに変える

**Files:**
- Modify: `backend/faq-bot/src/chatwoot/events.ts`
- Modify: `backend/faq-bot/tests/helpers/chatwoot.ts`
- Test: `backend/faq-bot/tests/chatwoot/events.test.ts`

**Interfaces:**
- Consumes: `ConversationStatus`（`src/chatwoot/types.ts`）
- Produces:
  ```ts
  export interface WelcomeEvent {
    readonly kind: "welcome";
    readonly accountId: number;
    readonly inboxId: number;
    readonly sourceId: string;
    /** その訪問者のこの受信箱の最後の会話のステータス（会話が無ければ null） */
    readonly currentStatus: ConversationStatus | null;
  }
  export type BotEvent = QuestionEvent | SelectionEvent | WelcomeEvent | { readonly kind: "ignore"; readonly reason: string };
  ```
  `tests/helpers/chatwoot.ts` の `welcomePayload(overrides?: Record<string, unknown>): Record<string, unknown>`

- [ ] **Step 1: テストのヘルパーに `welcomePayload` を足す**

`backend/faq-bot/tests/helpers/chatwoot.ts` の末尾に足す:
```ts
/** webwidget_triggered（訪問者がウィジェットを開いた）の本文。ContactInbox#webhook_data ＋ event・event_info の形 */
export function welcomePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "webwidget_triggered",
    id: 55,
    contact: { id: 7, name: "it-visitor" },
    inbox: { id: 3, name: "Web サイト" },
    account: { id: 1, name: "ComeGin" },
    current_conversation: null,
    source_id: "3f1c2b9e-0000-4000-8000-000000000000",
    event_info: { widget_language: "ja", browser_language: "ja" },
    ...overrides,
  };
}
```

- [ ] **Step 2: 失敗するテストを書く**

`backend/faq-bot/tests/chatwoot/events.test.ts` の import を次に変える:
```ts
import { questionPayload, selectionPayload, welcomePayload } from "../helpers/chatwoot.js";
```
「正常系」の `describe` の最後（「空入力: 本文の無い発言…」の後）に足す:
```ts
    it("会話の無い訪問者がウィジェットを開いたら welcome（currentStatus は null）", () => {
      expect(parseEvent(welcomePayload())).toEqual({
        kind: "welcome",
        accountId: 1,
        inboxId: 3,
        sourceId: "3f1c2b9e-0000-4000-8000-000000000000",
        currentStatus: null,
      });
    });

    it("直前の会話があれば、そのステータスを currentStatus に入れる", () => {
      expect(parseEvent(welcomePayload({ current_conversation: { id: 40, status: "resolved" } }))).toMatchObject({ kind: "welcome", currentStatus: "resolved" });
      expect(parseEvent(welcomePayload({ current_conversation: { id: 41, status: "pending" } }))).toMatchObject({ kind: "welcome", currentStatus: "pending" });
    });
```
「異常系」の `describe` の最後に足す:
```ts
    it("空入力: source_id が空の webwidget_triggered は InvalidEventError", () => {
      expect(() => parseEvent(welcomePayload({ source_id: "" }))).toThrow(InvalidEventError);
    });

    it("入力: inbox か account の無い webwidget_triggered は InvalidEventError", () => {
      const { inbox: _inbox, ...noInbox } = welcomePayload();
      const { account: _account, ...noAccount } = welcomePayload();
      expect(() => parseEvent(noInbox)).toThrow(InvalidEventError);
      expect(() => parseEvent(noAccount)).toThrow(InvalidEventError);
    });

    it("入力: 知らないステータスの current_conversation は InvalidEventError", () => {
      expect(() => parseEvent(welcomePayload({ current_conversation: { id: 40, status: "bot" } }))).toThrow(InvalidEventError);
    });
```

- [ ] **Step 3: テストが落ちることを確かめる**

Run: `cd backend/faq-bot && pnpm test tests/chatwoot/events.test.ts`
Expected: FAIL。新しい 5 件のうち、正常系の 2 件は `{ kind: "ignore", reason: "event:webwidget_triggered" }` が返って落ち、異常系の 3 件は例外が投げられずに落ちる。

- [ ] **Step 4: 実装する**

`backend/faq-bot/src/chatwoot/events.ts` を次のように変える。

import に型を足す:
```ts
import * as z from "zod/v4";
import { MAX_QUESTION_CHARS } from "../constants.js";
import type { ConversationStatus } from "./types.js";
```
`MessagePayload` の定義の後に足す:
```ts
// ContactInbox#webhook_data（webwidget_triggered）の必要な部分だけ。current_conversation は会話の EventDataPresenter#webhook_data
const WelcomePayload = z.object({
  source_id: z.string().min(1),
  inbox: z.object({ id: z.number().int().positive() }).passthrough(),
  account: z.object({ id: z.number().int().positive() }).passthrough(),
  current_conversation: z
    .object({ status: z.enum(["open", "resolved", "pending", "snoozed"]) })
    .passthrough()
    .nullish(),
});
```
`SelectionEvent` の後に足し、`BotEvent` を置き換える:
```ts
/** 訪問者がウィジェットを開いた（webwidget_triggered。会話はまだ無いか、直前の会話がある） */
export interface WelcomeEvent {
  readonly kind: "welcome";
  readonly accountId: number;
  readonly inboxId: number;
  readonly sourceId: string;
  /** その訪問者のこの受信箱の最後の会話のステータス（会話が無ければ null） */
  readonly currentStatus: ConversationStatus | null;
}

export type BotEvent = QuestionEvent | SelectionEvent | WelcomeEvent | { readonly kind: "ignore"; readonly reason: string };
```
`ignore` の定義の後に足す:
```ts
function parseWelcome(body: unknown): WelcomeEvent {
  const parsed = WelcomePayload.safeParse(body);
  if (!parsed.success) throw new InvalidEventError(`形式が違う（${parsed.error.issues[0]?.path.join(".") || "root"}）`);
  return {
    kind: "welcome",
    accountId: parsed.data.account.id,
    inboxId: parsed.data.inbox.id,
    sourceId: parsed.data.source_id,
    currentStatus: parsed.data.current_conversation?.status ?? null,
  };
}
```
`parseEvent` の JSDoc と先頭を次に変える（`if (typeof name !== "string")` の行の直後に 1 行足す）:
```ts
/** Webhook の本文を、ボットが扱うイベントに変える（仕様 7.1 と、2026-10-12 の一覧の仕様 3 節）。扱わないものは ignore、壊れた本文は InvalidEventError */
export function parseEvent(body: unknown): BotEvent {
  const name = typeof body === "object" && body !== null ? (body as { event?: unknown }).event : undefined;
  if (typeof name !== "string") throw new InvalidEventError("event が無い");
  if (name === "webwidget_triggered") return parseWelcome(body);
  if (name !== "message_created" && name !== "message_updated") return ignore(`event:${name}`);
```
既存のテスト「扱わないイベントは ignore」は `webwidget_triggered` を `ignore` と期待している。**`{ event: "webwidget_triggered" }` の行を消す**（このイベントは扱うようになった。形の壊れた本文は異常系のテストで覆う）:
```ts
    it("扱わないイベントは ignore", () => {
      expect(parseEvent({ event: "conversation_status_changed", id: 12 })).toMatchObject({ kind: "ignore" });
    });
```

- [ ] **Step 5: テストが通ることを確かめる**

Run: `cd backend/faq-bot && pnpm test tests/chatwoot/events.test.ts`
Expected: PASS（全件）。

- [ ] **Step 6: 型の検査（`handler.ts` の分岐は Task 6。ここでは型の不一致が出ないことだけ）**

Run: `cd backend/faq-bot && pnpm typecheck`
Expected: エラーが出る場合は `src/handler.ts` の `event.conversationId` など（`WelcomeEvent` に無い項目）。**出たら、Task 6 の Step 4 の分岐（`if (event.kind === "welcome") return json(200, { result: "ignored" });` を仮に置く）で埋めず、そのまま Task 6 まで進めてよい**。仮の分岐を置く場合は、Task 6 で必ず置き換える。

- [ ] **Step 7: コミットしない（ユーザーがする）**

---

### Task 3: 一覧の項目と本文（`welcome.ts` と定数）

**Files:**
- Modify: `backend/faq-bot/src/constants.ts`
- Create: `backend/faq-bot/src/dialog/welcome.ts`
- Test: `backend/faq-bot/tests/dialog/welcome.test.ts`

**Interfaces:**
- Consumes: `FaqSnapshot`（`src/faq/store.ts`）、`FaqItem`（`src/faq/schema.ts`）、`candidateTitle`（`src/dialog/decide.ts`）、`Reply`（`src/chatwoot/types.ts`）
- Produces:
  ```ts
  export function welcomeItems(snapshot: Pick<FaqSnapshot, "items">): FaqItem[];
  export function welcomeReply(items: readonly FaqItem[]): Reply; // kind は "select"
  ```
  定数 `WELCOME_PAGE_KEY = "top"`・`MAX_WELCOME_ITEMS = 6`・`MESSAGES.welcome`

- [ ] **Step 1: 失敗するテストを書く**

`backend/faq-bot/tests/dialog/welcome.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { MESSAGES } from "../../src/constants.js";
import { welcomeItems, welcomeReply } from "../../src/dialog/welcome.js";
import { makeFaqItem } from "../helpers/faq.js";

const item = (id: string, question = `質問 ${id}`, context: string | null = null) => makeFaqItem({ id, question, context });

describe("welcomeItems", () => {
  describe("正常系", () => {
    it("トップページの項目（top-）だけを faq.json の順にとる", () => {
      const items = [item("top-1"), item("pricing-1", "料金", "料金"), item("top-3"), item("services-consulting-2")];
      expect(welcomeItems({ items }).map((i) => i.id)).toEqual(["top-1", "top-3"]);
    });

    it("最大 6 件", () => {
      const items = Array.from({ length: 8 }, (_, n) => item(`top-${n + 1}`));
      expect(welcomeItems({ items }).map((i) => i.id)).toEqual(["top-1", "top-2", "top-3", "top-4", "top-5", "top-6"]);
    });

    it("空入力: トップページの項目が無ければ空", () => {
      expect(welcomeItems({ items: [item("pricing-1")] })).toEqual([]);
      expect(welcomeItems({ items: [] })).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: top で始まっても、ページの key が違う id（topics-1 など）は出さない", () => {
      expect(welcomeItems({ items: [item("topics-1"), item("top-2")] }).map((i) => i.id)).toEqual(["top-2"]);
    });
  });
});

describe("welcomeReply", () => {
  describe("正常系", () => {
    it("本文と、質問（context があれば括弧つき）の見出し・FAQ の id の値の選択肢", () => {
      expect(welcomeReply([item("top-3", "料金は税込ですか？"), item("top-9", "契約の期間", "コンサル")])).toEqual({
        kind: "select",
        content: MESSAGES.welcome,
        items: [
          { title: "料金は税込ですか？", value: "top-3" },
          { title: "契約の期間（コンサル）", value: "top-9" },
        ],
      });
    });
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `cd backend/faq-bot && pnpm test tests/dialog/welcome.test.ts`
Expected: FAIL（`src/dialog/welcome.js` が無い）。

- [ ] **Step 3: 定数を足す**

`backend/faq-bot/src/constants.ts` の `MAX_CANDIDATES` の行の後に足す:
```ts
// ウィジェットを開いたときの一覧（2026-10-12 の仕様）: トップページの FAQ（faq-export の id が「top-<順番>」）を最大 6 件
export const WELCOME_PAGE_KEY = "top";
export const MAX_WELCOME_ITEMS = 6;
```
`MESSAGES` の `candidatesPrompt` の行の後に足す:
```ts
  welcome: "よくあるご質問です。当てはまらなければ、ご質問をそのまま入力してください。",
```

- [ ] **Step 4: 実装する**

`backend/faq-bot/src/dialog/welcome.ts`:
```ts
import type { Reply } from "../chatwoot/types.js";
import { MAX_WELCOME_ITEMS, MESSAGES, WELCOME_PAGE_KEY } from "../constants.js";
import type { FaqItem } from "../faq/schema.js";
import type { FaqSnapshot } from "../faq/store.js";
import { candidateTitle } from "./decide.js";

/** ウィジェットを開いたときに出す FAQ（2026-10-12 の仕様 3 節）。トップページの項目を faq.json の順に最大 6 件 */
export function welcomeItems(snapshot: Pick<FaqSnapshot, "items">): FaqItem[] {
  return snapshot.items.filter((item) => item.id.startsWith(`${WELCOME_PAGE_KEY}-`)).slice(0, MAX_WELCOME_ITEMS);
}

/** 一覧のメッセージ。選ばれると既存の「選択: FAQ の id」の流れ（decide.ts）で答える */
export function welcomeReply(items: readonly FaqItem[]): Reply {
  return {
    kind: "select",
    content: MESSAGES.welcome,
    items: items.map((item) => ({ title: candidateTitle(item), value: item.id })),
  };
}
```

- [ ] **Step 5: テストが通ることを確かめる**

Run: `cd backend/faq-bot && pnpm test tests/dialog/welcome.test.ts`
Expected: PASS（5 件）。

- [ ] **Step 6: コミットしない（ユーザーがする）**

---

### Task 4: Chatwoot のクライアントに会話の作成を足す

**Files:**
- Modify: `backend/faq-bot/src/chatwoot/client.ts`
- Modify: `backend/faq-bot/tests/handler.test.ts:19-27`（差し替えの `client` に `createConversation` を足す）
- Modify: `backend/faq-bot/tests/dialog/execute.test.ts:18-33`（`fakeClient` に `createConversation` を足す）
- Test: `backend/faq-bot/tests/chatwoot/client.test.ts`

**Interfaces:**
- Consumes: `ConversationStatus`（`src/chatwoot/types.ts`）
- Produces:
  ```ts
  export interface CreatedConversation {
    /** display_id（会話の番号。他の API のパスに使う） */
    readonly id: number;
    readonly status: ConversationStatus;
  }
  // ChatwootClient に足す・変える:
  createConversation(sourceId: string, inboxId: number): Promise<CreatedConversation>;
  sendMessage(conversationId: number, reply: Reply, inReplyTo: number | null): Promise<void>; // null なら in_reply_to を送らない
  ```

- [ ] **Step 1: 失敗するテストを書く**

`backend/faq-bot/tests/chatwoot/client.test.ts` の「正常系」の `describe` の最後に足す:
```ts
    it("createConversation は source_id と inbox_id で会話を作り、番号とステータスを返す（status は渡さない）", async () => {
      const { fetchImpl, calls } = recordingFetch(jsonResponse({ id: 31, status: "pending", inbox_id: 3, messages: [], meta: { sender: { id: 7 } } }));
      expect(await makeClient(fetchImpl).createConversation("3f1c2b9e-0000-4000-8000-000000000000", 3)).toEqual({ id: 31, status: "pending" });
      expect(calls[0]).toMatchObject({ url: BASE, method: "POST", headers: { api_access_token: "bot-token" } });
      expect(calls[0]!.body).toEqual({ source_id: "3f1c2b9e-0000-4000-8000-000000000000", inbox_id: 3 });
    });

    it("sendMessage（select）は in_reply_to が null なら送らない（一覧のメッセージ）", async () => {
      const { fetchImpl, calls } = recordingFetch(jsonResponse({ id: 401 }));
      const items = [{ title: "料金は税込ですか？", value: "top-3" }];
      await makeClient(fetchImpl).sendMessage(31, { kind: "select", content: "よくあるご質問です。", items }, null);
      expect(calls[0]!.body).toEqual({
        content: "よくあるご質問です。",
        message_type: "outgoing",
        private: false,
        content_type: "input_select",
        content_attributes: { items },
      });
    });

    it("sendMessage（text）は in_reply_to が null なら content_attributes を送らない", async () => {
      const { fetchImpl, calls } = recordingFetch(jsonResponse({ id: 402 }));
      await makeClient(fetchImpl).sendMessage(31, { kind: "text", content: "こんにちは" }, null);
      expect(calls[0]!.body).toEqual({ content: "こんにちは", message_type: "outgoing", private: false });
    });
```
「異常系」の `describe` の最後に足す:
```ts
    it("入力: createConversation の応答の形が違えば ChatwootApiError（本文は入れない）", async () => {
      const { fetchImpl } = recordingFetch(jsonResponse({ id: "31", status: "pending" }));
      const error = await makeClient(fetchImpl).createConversation("s", 3).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ChatwootApiError);
      expect((error as Error).message).toBe("POST conversations: 応答の形が違う");
    });
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `cd backend/faq-bot && pnpm test tests/chatwoot/client.test.ts`
Expected: FAIL（`createConversation is not a function`、null の `in_reply_to` が `content_attributes` に入っている）。

- [ ] **Step 3: 実装する**

`backend/faq-bot/src/chatwoot/client.ts` を次のように変える。

import を変える:
```ts
import * as z from "zod/v4";
import type { ConversationStatus, ConversationView, Reply } from "./types.js";
```
`ChatwootApiError` の後に足す:
```ts
export interface CreatedConversation {
  /** display_id（会話の番号。他の API のパスに使う） */
  readonly id: number;
  readonly status: ConversationStatus;
}
```
`ChatwootClient` を置き換える:
```ts
/**
 * ボットのトークンで呼べる API だけ（access_token_auth_helper.rb の BOT_ACCESSIBLE_ENDPOINTS）。
 * メッセージの一覧は呼べないため、二重回答の判定は会話の show の last_non_activity_message で行う（仕様 7.4）
 */
export interface ChatwootClient {
  getConversation(conversationId: number): Promise<ConversationView>;
  /** ウィジェットを開いた訪問者の会話を作る（2026-10-12 の仕様 3 節）。status は渡さない（ボットの付いた受信箱では pending になる） */
  createConversation(sourceId: string, inboxId: number): Promise<CreatedConversation>;
  /** inReplyTo が null なら in_reply_to を送らない（一覧のメッセージは訪問者の発言への返事でない） */
  sendMessage(conversationId: number, reply: Reply, inReplyTo: number | null): Promise<void>;
  setLabels(conversationId: number, labels: readonly string[]): Promise<void>;
  setStatus(conversationId: number, status: "open" | "resolved"): Promise<void>;
}
```
`ConversationSchema` の後に足す:
```ts
const CreatedSchema = z.object({
  id: z.number().int().positive(),
  status: z.enum(["open", "resolved", "pending", "snoozed"]),
});
```
返す object の `getConversation` の後に足す:
```ts
    async createConversation(sourceId, inboxId) {
      const parsed = CreatedSchema.safeParse(await call("POST", "", { source_id: sourceId, inbox_id: inboxId }));
      if (!parsed.success) throw new ChatwootApiError(200, "POST conversations", "応答の形が違う");
      return { id: parsed.data.id, status: parsed.data.status };
    },
```
`sendMessage` を置き換える:
```ts
    async sendMessage(conversationId, reply, inReplyTo) {
      const replyTo = inReplyTo === null ? {} : { in_reply_to: inReplyTo };
      const body =
        reply.kind === "text"
          ? { content: reply.content, message_type: "outgoing", private: false, ...(inReplyTo === null ? {} : { content_attributes: replyTo }) }
          : {
              content: reply.content,
              message_type: "outgoing",
              private: false,
              content_type: "input_select",
              content_attributes: { items: reply.items, ...replyTo },
            };
      await call("POST", `/${conversationId}/messages`, body);
    },
```

- [ ] **Step 4: テストの差し替えのクライアントを、新しいインターフェースに合わせる**

`backend/faq-bot/tests/handler.test.ts` の `setup` の `client` に 1 行足す（`getConversation` の後）:
```ts
    createConversation: vi.fn(async () => ({ id: 31, status: "pending" as const })),
```
`backend/faq-bot/tests/dialog/execute.test.ts` の `fakeClient` を次に置き換える（作成の応答を引数で変えられるようにする。既存の呼び出し `fakeClient(view)`・`fakeClient(view, "sendMessage")` はそのまま動く）:
```ts
function fakeClient(view: ConversationView, failOn?: keyof ChatwootClient, created: CreatedConversation = { id: 31, status: "pending" }) {
  const calls: string[] = [];
  const step = (name: keyof ChatwootClient) => async () => {
    calls.push(name);
    if (failOn === name) throw new ChatwootApiError(503, name, "HTTP 503");
  };
  const client = {
    getConversation: vi.fn(async () => {
      await step("getConversation")();
      return view;
    }),
    createConversation: vi.fn(async () => {
      await step("createConversation")();
      return created;
    }),
    sendMessage: vi.fn(step("sendMessage")),
    setLabels: vi.fn(step("setLabels")),
    setStatus: vi.fn(step("setStatus")),
  } satisfies ChatwootClient;
  return { client, calls };
}
```
同じファイルの import を変える:
```ts
import { ChatwootApiError, type ChatwootClient, type CreatedConversation } from "../../src/chatwoot/client.js";
```

- [ ] **Step 5: テストが通ることを確かめる**

Run: `cd backend/faq-bot && pnpm test tests/chatwoot/client.test.ts tests/dialog/execute.test.ts tests/handler.test.ts`
Expected: PASS（全件）。

- [ ] **Step 6: コミットしない（ユーザーがする）**

---

### Task 5: `executeWelcome`（会話を作って一覧を送る）

**Files:**
- Modify: `backend/faq-bot/src/dialog/execute.ts`
- Test: `backend/faq-bot/tests/dialog/execute.test.ts`

**Interfaces:**
- Consumes: `ChatwootClient.createConversation`・`sendMessage`（Task 4）、`WelcomeEvent`（Task 2）、`Reply`
- Produces:
  ```ts
  export interface WelcomeResult {
    readonly outcome: "sent" | "not-pending";
    readonly conversationId: number;
  }
  export async function executeWelcome(
    client: ChatwootClient,
    target: Pick<WelcomeEvent, "sourceId" | "inboxId">,
    reply: Reply,
  ): Promise<WelcomeResult>;
  ```

- [ ] **Step 1: 失敗するテストを書く**

`backend/faq-bot/tests/dialog/execute.test.ts` の import を変える:
```ts
import { execute, executeWelcome } from "../../src/dialog/execute.js";
```
ファイルの末尾に足す:
```ts
const WELCOME = { kind: "select" as const, content: "よくあるご質問です。", items: [{ title: "料金は税込ですか？", value: "top-3" }] };
const OPENED = { sourceId: "3f1c2b9e-0000-4000-8000-000000000000", inboxId: 3 };

describe("executeWelcome", () => {
  describe("正常系", () => {
    it("会話を作ってから、in_reply_to なしで一覧を 1 通送る", async () => {
      const { client, calls } = fakeClient(pending());
      expect(await executeWelcome(client, OPENED, WELCOME)).toEqual({ outcome: "sent", conversationId: 31 });
      expect(calls).toEqual(["createConversation", "sendMessage"]);
      expect(client.createConversation).toHaveBeenCalledWith(OPENED.sourceId, 3);
      expect(client.sendMessage).toHaveBeenCalledWith(31, WELCOME, null);
    });

    it("作った会話が pending でなければ送らない（受信箱が lock_to_single_conversation で、解決済みの会話が返った場合）", async () => {
      const { client, calls } = fakeClient(pending(), undefined, { id: 40, status: "resolved" });
      expect(await executeWelcome(client, OPENED, WELCOME)).toEqual({ outcome: "not-pending", conversationId: 40 });
      expect(calls).toEqual(["createConversation"]);
    });
  });

  describe("異常系", () => {
    it("サーバ: 会話を作れなければ例外（送らない）", async () => {
      const { client, calls } = fakeClient(pending(), "createConversation");
      await expect(executeWelcome(client, OPENED, WELCOME)).rejects.toBeInstanceOf(ChatwootApiError);
      expect(calls).toEqual(["createConversation"]);
    });

    it("サーバ: 送信に失敗したら例外（空の pending の会話が残る。仕様 5 節）", async () => {
      const { client, calls } = fakeClient(pending(), "sendMessage");
      await expect(executeWelcome(client, OPENED, WELCOME)).rejects.toBeInstanceOf(ChatwootApiError);
      expect(calls).toEqual(["createConversation", "sendMessage"]);
    });
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `cd backend/faq-bot && pnpm test tests/dialog/execute.test.ts`
Expected: FAIL（`executeWelcome` が無い）。

- [ ] **Step 3: 実装する**

`backend/faq-bot/src/dialog/execute.ts` の import を変える:
```ts
import type { ChatwootClient } from "../chatwoot/client.js";
import type { EventTarget, WelcomeEvent } from "../chatwoot/events.js";
import type { LastMessage, Reply } from "../chatwoot/types.js";
```
ファイルの末尾に足す:
```ts
export interface WelcomeResult {
  readonly outcome: "sent" | "not-pending";
  readonly conversationId: number;
}

/**
 * ウィジェットを開いた訪問者の会話を作り、一覧を 1 通送る（2026-10-12 の仕様 3 節の 5・6）。
 * 作成の応答が pending でなければ送らない（受信箱が lock_to_single_conversation だと、既存の解決済みの会話が返る。
 * そこに一覧を出しても、pending でないため選択に答えられない）。失敗は例外（仕様 5 節）
 */
export async function executeWelcome(client: ChatwootClient, target: Pick<WelcomeEvent, "sourceId" | "inboxId">, reply: Reply): Promise<WelcomeResult> {
  const created = await client.createConversation(target.sourceId, target.inboxId);
  if (created.status !== "pending") return { outcome: "not-pending", conversationId: created.id };
  await client.sendMessage(created.id, reply, null);
  return { outcome: "sent", conversationId: created.id };
}
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `cd backend/faq-bot && pnpm test tests/dialog/execute.test.ts`
Expected: PASS（全件）。

- [ ] **Step 5: コミットしない（ユーザーがする）**

---

### Task 6: 本体（`handler.ts`）で `welcome` を扱う

**Files:**
- Modify: `backend/faq-bot/src/handler.ts`
- Test: `backend/faq-bot/tests/handler.test.ts`

**Interfaces:**
- Consumes: `WelcomeEvent`（Task 2）、`welcomeItems`・`welcomeReply`（Task 3）、`executeWelcome`（Task 5）
- Produces: 応答の本文 `{"result":"welcome"}`・`{"result":"skip-active"}`・`{"result":"skip-empty"}`・`{"result":"skip-not-pending"}`（200）。ログ 1 行 `{ t, level: "info", event: "welcome", decision, conversation, faq, ms }`

- [ ] **Step 1: 失敗するテストを書く**

`backend/faq-bot/tests/handler.test.ts` の import を次に変える:
```ts
import { describe, expect, it, vi } from "vitest";
import { ChatwootApiError, type ChatwootClient } from "../src/chatwoot/client.js";
import type { ConversationStatus } from "../src/chatwoot/types.js";
import { MESSAGES } from "../src/constants.js";
import type { FaqItem } from "../src/faq/schema.js";
import { buildSnapshot, FaqUnavailableError, type FaqSource } from "../src/faq/store.js";
import { createHandler, type HttpRequest } from "../src/handler.js";
import { questionPayload, sign, welcomePayload } from "./helpers/chatwoot.js";
import { makeConfig } from "./helpers/config.js";
import { makeFaqItem } from "./helpers/faq.js";
```
`setup` を次に置き換える（既存の呼び出し `setup()`・`setup({ faqFails: true })`・`setup({ clientFails: true })` はそのまま動く）:
```ts
function setup(options: { faqFails?: boolean; clientFails?: boolean; faqItems?: FaqItem[]; createdStatus?: ConversationStatus } = {}) {
  const faq: FaqSource = {
    current: vi.fn(async () => {
      if (options.faqFails) throw new FaqUnavailableError("faq.json をまだ一度も取得できていない");
      return buildSnapshot(options.faqItems ?? [makeFaqItem()], 0);
    }),
  };
  const client = {
    getConversation: vi.fn(async () => {
      if (options.clientFails) throw new ChatwootApiError(503, "GET conversations/12", "HTTP 503");
      return { status: "pending" as const, labels: [], lastMessage: { id: 101, messageType: 0, senderType: "contact", inReplyTo: null } };
    }),
    createConversation: vi.fn(async () => {
      if (options.clientFails) throw new ChatwootApiError(503, "POST conversations", "HTTP 503");
      return { id: 31, status: options.createdStatus ?? ("pending" as const) };
    }),
    sendMessage: vi.fn(async () => {}),
    setLabels: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
  } satisfies ChatwootClient;
  const log = vi.fn();
  const handle = createHandler({ config: CONFIG, faq, client, nowSeconds: () => NOW, log });
  return { handle, client, faq, log };
}
```
`describe("createHandler", …)` の後（ファイルの末尾）に足す:
```ts
describe("createHandler（ウィジェットを開いたとき）", () => {
  const SOURCE_ID = "3f1c2b9e-0000-4000-8000-000000000000";

  describe("正常系", () => {
    it("会話の無い訪問者が開いたら、会話を作って一覧を 1 通送り、source_id を含まないログを 1 行出す", async () => {
      const { handle, client, log } = setup();
      expect(await handle(signed(JSON.stringify(welcomePayload())))).toEqual({ status: 200, body: '{"result":"welcome"}' });
      expect(client.createConversation).toHaveBeenCalledWith(SOURCE_ID, 3);
      expect(client.sendMessage).toHaveBeenCalledWith(
        31,
        { kind: "select", content: MESSAGES.welcome, items: [{ title: "料金は税込ですか？", value: "top-3" }] },
        null,
      );
      expect(client.getConversation).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "welcome", decision: "welcome", conversation: 31, faq: ["top-3"] }));
      expect(JSON.stringify(log.mock.calls)).not.toContain(SOURCE_ID);
    });

    it("直前の会話が resolved なら、新しい会話を作って一覧を出す", async () => {
      const { handle, client } = setup();
      const res = await handle(signed(JSON.stringify(welcomePayload({ current_conversation: { id: 40, status: "resolved" } }))));
      expect(res.body).toBe('{"result":"welcome"}');
      expect(client.createConversation).toHaveBeenCalledTimes(1);
    });

    it("進行中の会話（pending・open・snoozed）があれば何もしない（FAQ も読まない）", async () => {
      for (const status of ["pending", "open", "snoozed"]) {
        const { handle, client, faq, log } = setup();
        const res = await handle(signed(JSON.stringify(welcomePayload({ current_conversation: { id: 41, status } }))));
        expect(res).toEqual({ status: 200, body: '{"result":"skip-active"}' });
        expect(client.createConversation).not.toHaveBeenCalled();
        expect(faq.current).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "welcome", decision: "skip-active" }));
      }
    });

    it("空入力: トップページの項目が無ければ、会話を作らない", async () => {
      const { handle, client } = setup({ faqItems: [makeFaqItem({ id: "pricing-1" })] });
      expect((await handle(signed(JSON.stringify(welcomePayload())))).body).toBe('{"result":"skip-empty"}');
      expect(client.createConversation).not.toHaveBeenCalled();
    });

    it("作った会話が pending でなければ送らない", async () => {
      const { handle, client, log } = setup({ createdStatus: "resolved" });
      expect((await handle(signed(JSON.stringify(welcomePayload())))).body).toBe('{"result":"skip-not-pending"}');
      expect(client.sendMessage).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ decision: "skip-not-pending", conversation: 31 }));
    });

    it("別のアカウントの webwidget_triggered は 200 で何もしない", async () => {
      const { handle, client } = setup();
      expect((await handle(signed(JSON.stringify(welcomePayload({ account: { id: 2 } }))))).body).toBe('{"result":"ignored"}');
      expect(client.createConversation).not.toHaveBeenCalled();
    });
  });

  describe("異常系", () => {
    it("サーバ: faq.json が一度も取れていなければ例外（会話を作らない）", async () => {
      const { handle, client } = setup({ faqFails: true });
      await expect(handle(signed(JSON.stringify(welcomePayload())))).rejects.toBeInstanceOf(FaqUnavailableError);
      expect(client.createConversation).not.toHaveBeenCalled();
    });

    it("サーバ: 会話の作成の失敗は例外", async () => {
      const { handle } = setup({ clientFails: true });
      await expect(handle(signed(JSON.stringify(welcomePayload())))).rejects.toBeInstanceOf(ChatwootApiError);
    });

    it("入力: 形の壊れた webwidget_triggered は 400", async () => {
      const { handle } = setup();
      expect(await handle(signed(JSON.stringify(welcomePayload({ source_id: "" }))))).toEqual({ status: 400, body: '{"error":"invalid_event"}' });
    });
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `cd backend/faq-bot && pnpm test tests/handler.test.ts`
Expected: FAIL（`welcome` のイベントが `decide` に渡り、`event.conversationId` が無いため想定と違う動きか例外になる。Task 2 の Step 6 で仮の分岐を置いた場合は `{"result":"ignored"}` が返って落ちる）。

- [ ] **Step 3: 実装する**

`backend/faq-bot/src/handler.ts` の import を次に変える:
```ts
import type { ChatwootClient } from "./chatwoot/client.js";
import { type BotEvent, InvalidEventError, parseEvent, type WelcomeEvent } from "./chatwoot/events.js";
import { verifySignature } from "./chatwoot/signature.js";
import type { Config } from "./config.js";
import { HEALTH_PATH, MAX_BODY_BYTES, SIGNATURE_TOLERANCE_SECONDS, WEBHOOK_PATH } from "./constants.js";
import { decide } from "./dialog/decide.js";
import { execute, executeWelcome } from "./dialog/execute.js";
import { welcomeItems, welcomeReply } from "./dialog/welcome.js";
import type { FaqSource } from "./faq/store.js";
```
`createHandler` の中、`const thresholds = …` の行の後に足す:
```ts
  /**
   * ウィジェットを開いたとき（2026-10-12 の仕様 3 節）。進行中の会話があれば何もしない（開くたびに一覧を出さない）。
   * 会話が無いか直前の会話が resolved なら、トップページの FAQ の一覧を新しい会話に出す。ログに source_id を出さない
   */
  async function handleWelcome(event: WelcomeEvent, startedAt: number): Promise<HttpResponse> {
    const done = (decision: string, extra: Record<string, unknown> = {}): HttpResponse => {
      log({ t: new Date().toISOString(), level: "info", event: event.kind, decision, ...extra, ms: Date.now() - startedAt });
      return json(200, { result: decision });
    };
    if (event.currentStatus !== null && event.currentStatus !== "resolved") return done("skip-active");
    const items = welcomeItems(await faq.current());
    if (items.length === 0) return done("skip-empty");
    const result = await executeWelcome(client, event, welcomeReply(items));
    return done(result.outcome === "sent" ? "welcome" : "skip-not-pending", { conversation: result.conversationId, faq: items.map((item) => item.id) });
  }
```
アカウントの確認の後（`return json(200, { result: "ignored" });` の `}` の直後、`const snapshot = await faq.current();` の前）に足す:
```ts
    if (event.kind === "welcome") return handleWelcome(event, startedAt);
```
（Task 2 の Step 6 で仮の分岐を置いた場合は、それを消してこの行にする。）

- [ ] **Step 4: テストが通ることを確かめる**

Run: `cd backend/faq-bot && pnpm test tests/handler.test.ts`
Expected: PASS（全件）。

- [ ] **Step 5: 単体テスト全体と型の検査**

Run: `cd backend/faq-bot && pnpm test > <workspace>/unit.log 2>&1; tail -n 8 <workspace>/unit.log; pnpm typecheck`
Expected: すべて PASS（前回の 151 件 ＋ このタスク群で足した件数）。`typecheck` はエラー 0。件数を進捗の記録に書く（Task 8 で文書に使う）。

- [ ] **Step 6: コミットしない（ユーザーがする）**

---

### Task 7: 結合テスト（開発の Chatwoot を本物として使う）

**Files:**
- Modify: `backend/faq-bot/integration/helpers/faq-server.ts`（固定の FAQ の id をトップページの形に）
- Modify: `backend/faq-bot/integration/helpers/chatwoot.ts`（`Visitor.open` を足す）
- Create: `backend/faq-bot/integration/welcome.test.ts`

**Interfaces:**
- Consumes: `startBot`・`startFaqServer`・`readState`・`Admin`・`Visitor`・`waitFor`・`botMessage`（既存）
- Produces: `Visitor.open(): Promise<void>`（ウィジェットのバブルを開いたのと同じ `POST /api/v1/widget/events` の `webwidget.triggered`）

- [ ] **Step 1: 固定の FAQ にトップページの項目を入れる**

`backend/faq-bot/integration/helpers/faq-server.ts` の `FIXTURE_FAQ.items` の先頭の 1 件（`id: "it-tax"`）を、次の 2 件に置き換える（一覧はトップページの項目〈`top-`〉だけを順に出すため。既存の結合テストは id を見ていない）:
```ts
    { id: "top-1", question: "ソースコードは本当に無料ですか？", answer: "はい。ソースコードを無料で公開しています。", url: "http://localhost:4321/#top-faq", context: null },
    { id: "top-3", question: "料金は税込ですか？", answer: "表示価格はすべて税別です。", url: "http://localhost:4321/#top-faq", context: null },
```

- [ ] **Step 2: 訪問者がウィジェットを開く操作を足す**

`backend/faq-bot/integration/helpers/chatwoot.ts` の `Visitor` の `say` の前に足す:
```ts
  /** バブルを開いたのと同じ（SDK の onBubbleToggle → POST /api/v1/widget/events。Chatwoot がボットに webwidget_triggered を送る） */
  async open(): Promise<void> {
    await ok(await fetch(this.url("/api/v1/widget/events"), { method: "POST", headers: this.headers(), body: JSON.stringify({ name: "webwidget.triggered", event_info: {} }) }), "widget event");
  }
```

- [ ] **Step 3: 結合テストを書く**

`backend/faq-bot/integration/welcome.test.ts`:
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

const isWelcome = (m: { content: string | null }) => m.content === MESSAGES.welcome;

describe("ウィジェットを開いたときの一覧（開発の Chatwoot）", () => {
  describe("正常系", () => {
    it("会話の無い訪問者が開くと、ボットが pending の会話を作り、トップページの FAQ を順に出す", async () => {
      const visitor = await newVisitor();
      await visitor.open();
      const welcome = await botMessage(visitor, isWelcome, "一覧");
      expect(welcome.content_type).toBe("input_select");
      expect(welcome.content_attributes?.items).toEqual([
        { title: "ソースコードは本当に無料ですか？", value: "top-1" },
        { title: "料金は税込ですか？", value: "top-3" },
      ]);
      expect(await admin.conversation(welcome.conversation_id)).toEqual({ status: "pending", labels: [] });
    });

    it("一覧の項目を選ぶと、その FAQ の原文で答え、faq-answered を付ける", async () => {
      const visitor = await newVisitor();
      await visitor.open();
      const welcome = await botMessage(visitor, isWelcome, "一覧");
      await visitor.select(welcome.id, { title: "料金は税込ですか？", value: "top-3" });
      const answer = await botMessage(visitor, (m) => (m.content ?? "").startsWith("表示価格はすべて税別です。"), "選んだ FAQ の回答");
      expect(answer.conversation_id).toBe(welcome.conversation_id);
      const labeled = await waitFor(async () => {
        const c = await admin.conversation(welcome.conversation_id);
        return c.labels.length > 0 ? c : null;
      }, "ラベルが付く");
      expect(labeled).toEqual({ status: "pending", labels: ["faq-answered"] });
    });

    it("直前の会話が解決済みなら、開いたときに新しい会話で一覧を出す", async () => {
      const visitor = await newVisitor();
      const { conversation_id: first } = await visitor.say("料金は税込ですか？");
      const reply = await botMessage(visitor, (m) => m.content_type === "input_select", "回答");
      await visitor.select(reply.id, { title: "解決しました", value: "__resolved" });
      await waitFor(async () => (await admin.conversation(first)).status === "resolved", "会話が resolved になる");
      await visitor.open();
      const welcome = await botMessage(visitor, isWelcome, "新しい会話の一覧");
      expect(welcome.conversation_id).not.toBe(first);
    });
  });

  describe("異常系", () => {
    it("入力: 進行中の会話がある訪問者が開いても、新しい会話も一覧も作らない", async () => {
      const visitor = await newVisitor();
      const { conversation_id } = await visitor.say("料金は税込ですか？");
      await botMessage(visitor, (m) => m.content_type === "input_select", "回答");
      await visitor.open();
      // 何も起きないことを確かめるため、Webhook が処理されるだけの時間を待つ
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      const messages = await visitor.messages();
      expect(messages.every((m) => m.conversation_id === conversation_id)).toBe(true);
      expect(messages.some(isWelcome)).toBe(false);
    });
  });
});
```

- [ ] **Step 4: 前提を確かめてから結合テストを走らせる**

前提: 開発の Chatwoot が動いている、host-relay が 3107 を中継している、**`pnpm dev`（faq-bot）を止めておく**（テストが 3107 で起動する）。
Run: `cd backend/faq-bot && pnpm test:integration > <workspace>/integration.log 2>&1; tail -n 15 <workspace>/integration.log`
Expected: PASS（既存の 12 件 ＋ 新しい 4 件 ＝ 16 件）。落ちたら superpowers:systematic-debugging で原因を探す（テストを合わせて通さない）。

- [ ] **Step 5: コミットしない（ユーザーがする）**

---

### Task 8: 文書の更新と、本物のウィジェットでの確認

**Files:**
- Modify: `docs/superpowers/specs/2026-10-11-faq-bot-design.md`（5 節・7.1 節）
- Modify: `docs/RequirementDefinition/AA/02-integration-architecture.md:69-70`（I-31・I-32）と 3.11 節
- Modify: `docs/DetailedDesign/04-server-to-server-flows.md`（12 節の表のトリガー・完成度と、12.3 節を新設）
- Modify: `backend/faq-bot/README.md`（「動き」の表と「Chatwoot の落とし穴」）

**Interfaces:**
- Consumes: Task 6 の Step 5 の単体テストの件数、Task 7 の Step 4 の結合テストの件数
- Produces: なし

- [ ] **Step 1: 前の仕様を更新する**

`docs/superpowers/specs/2026-10-11-faq-bot-design.md` の 5 節の「- `id` は「ページの識別子-ページ内の順番…」」の行の直後に足す:
```markdown
- **トップの項目（`top-`）は、ウィジェットを開いたときの一覧にも使う**（`docs/superpowers/specs/2026-10-12-faq-bot-welcome-design.md`。2026-10-12 に追加）。id の形を変えると一覧が空になる。
```
7.1 節の表の `message_updated` の行の直後に足す:
```markdown
| `webwidget_triggered` | 訪問者がウィジェットを開いた。会話が無いか直前の会話が `resolved` のときだけ、会話を作ってトップページの FAQ の一覧を出す（2026-10-12 に追加。`docs/superpowers/specs/2026-10-12-faq-bot-welcome-design.md`） |
```

- [ ] **Step 2: AA-02 を更新する**

`docs/RequirementDefinition/AA/02-integration-architecture.md` の I-31 の行の「受信箱「Web サイト」のメッセージの作成・選択肢の選択」を「受信箱「Web サイト」のメッセージの作成・選択肢の選択・ウィジェットを開いた（`webwidget_triggered`。2026-10-12 に追加）」に変える。
I-32 の行の「（ボットのトークン。会話の show・メッセージの作成・ラベル・ステータス）」を「（ボットのトークン。会話の show・会話の作成〈ウィジェットを開いたときの一覧。2026-10-12 に追加〉・メッセージの作成・ラベル・ステータス）」に変える。
3.11 節の段落の末尾に足す:
```markdown
**2026-10-12 に、ウィジェットを開いたときにトップページの FAQ を選択肢で出す機能を足した**（`docs/superpowers/specs/2026-10-12-faq-bot-welcome-design.md`。会話が無いか直前の会話が解決済みのときだけ、ボットが会話を作る）。
```

- [ ] **Step 3: DD-04 の 12 節を更新する**

`docs/DetailedDesign/04-server-to-server-flows.md` の 12 節の表の「トリガー」の値の末尾（「`faq.json` はコールドスタートと 10 分ごと」の前）に「、訪問者がウィジェットを開いた（`webwidget_triggered`。2026-10-12 に追加。12.3）」を足す。
「完成度」の値の「単体 151 件・結合 12 件」を、Task 6 と Task 7 で確かめた件数に変える。
12.2 節の最後の段落の後に足す:
```markdown
### 12.3 ウィジェットを開いたときの一覧（2026-10-12 に追加）

仕様は `docs/superpowers/specs/2026-10-12-faq-bot-welcome-design.md`。

1. `webwidget_triggered` の本文の `current_conversation` が `null` か `resolved` のときだけ進む（進行中の会話があれば何もしない）。
2. `faq.json` のトップページの項目（id が `top-`）を順に最大 6 件とる。0 件なら何もしない。
3. ボットのトークンで会話を作る（`status` は渡さず、ボットの付いた受信箱では `pending` になる）。応答が `pending` でなければ送らない（受信箱が `lock_to_single_conversation` のとき）。
4. 一覧（`input_select`。値は FAQ の id。`in_reply_to` なし）を 1 通送る。選ばれた後は 12.1 の「選択: FAQ の id」と同じ。

`webwidget_triggered` の送信に失敗しても、Chatwoot は何もしない（会話を `open` にするのはメッセージのイベントのときだけ）。素早く 2 回開くと会話が 2 つできうる（Chatwoot の側に排他の手段が無い）。
```

- [ ] **Step 4: faq-bot の README を更新する**

`backend/faq-bot/README.md` の「動き」の表の先頭の行（「FAQ にはっきり当たる」）の前に足す:
```markdown
| ウィジェットを開いた（会話が無いか、直前の会話が解決済み） | 会話を作り「よくあるご質問です。…」とトップページの FAQ（最大 6 件）の選択肢 | — | `pending` |
```
「Chatwoot の落とし穴」の最後に足す:
```markdown
- **ウィジェットのバブルを開くと `webwidget_triggered` が届く**（本文は `ContactInbox#webhook_data`。`current_conversation` はその訪問者の最後の会話で、無ければ `null`）。**この送信に失敗しても Chatwoot は何もしない**（会話を `open` にするのはメッセージのイベントのときだけ）。
- **ボットのトークンでも会話を作れる**（`conversations#create`。`source_id` と `inbox_id`）。ただし受信箱が `lock_to_single_conversation` だと、作らずに最後の会話を返す（解決済みでも）。そのため作成の応答が `pending` でなければ一覧を送らない（`dialog/execute.ts` の `executeWelcome`）。
```

- [ ] **Step 5: 本物のウィジェットで確かめる（playwright-host）**

1. faq-bot の dev を起動する: `cd backend/faq-bot && pnpm dev`（バックグラウンド）。`curl -s http://127.0.0.1:3107/healthz` が `{"ok":true}` を返すまで待つ。
2. `mcp__playwright-host__browser_navigate` で `http://localhost:4321/` を開き、バブルを押す。
3. ウィジェットに「よくあるご質問です。…」と 6 件（トップページの FAQ。開発の `faq.json` は `http://localhost:4321/faq.json`）が出ることを `browser_snapshot` で確かめ、`browser_take_screenshot`（`faq-bot-welcome.png`）を撮る。
4. ［料金は税込ですか？］を押し、「表示価格はすべて税別です。」と［解決しました］［担当者に相談する］が出ることを確かめ、`browser_take_screenshot`（`faq-bot-welcome-answer.png`）を撮る。
5. ウィジェットを閉じて開き直し、一覧が**もう一度出ない**ことを確かめる（会話は `pending` で進行中）。
6. 後片付け: このブラウザの訪問者のコンタクトを管理者のトークンで消す（Task 1 の Step 7 と同じ。コンタクトの id は管理者の API の会話の `meta.sender.id`）。faq-bot の dev を止める。`browser_close`。

Expected: 3〜5 のとおりに見える。違えば superpowers:systematic-debugging。

- [ ] **Step 6: 最後に全体を走らせる**

Run:
```bash
cd backend/faq-bot && pnpm test > <workspace>/unit-final.log 2>&1; tail -n 6 <workspace>/unit-final.log; pnpm typecheck
```
Expected: 単体はすべて PASS、型の検査はエラー 0。（結合テストは Task 7 で通したものから、コードを変えていなければ走らせ直さない。）

- [ ] **Step 7: コミットしない（ユーザーがする）**
