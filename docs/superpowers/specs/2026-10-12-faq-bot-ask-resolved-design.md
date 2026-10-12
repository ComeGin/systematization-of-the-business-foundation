# faq-bot: 担当者の返信の後に［解決しました］ボタンを出す（マクロ「解決の確認を送る」）

- 日付: 2026-10-12
- 状態: 設計の承認待ち（会話での設計はユーザーが承認済み）
- 前提: `docs/superpowers/specs/2026-10-11-faq-bot-design.md`（以下「前の仕様」）と `docs/superpowers/specs/2026-10-12-faq-bot-welcome-design.md`（以下「一覧の仕様」）。この仕様は両方への**追加**で、前の仕様の規則（二重回答の防止・失敗時の扱い・ログ）はそのまま効く

## 1. 目的と合意した理解

**目的**: Chatwoot の管理画面から担当者（人）が返信した会話でも、訪問者が［解決しました］を押して会話を閉じられるようにする。

**ユーザーが決めたこと（2026-10-12）**

| # | 決定 |
|---|---|
| A1 | ボタンは**担当者がマクロで出す**（マクロ「解決の確認を送る」。担当者の返信のたびに自動で出す案は採らない。聞き返しの途中にも出て、続けて送るとボタンが並ぶため） |
| A2 | この設計（3〜6 節）を承認（2026-10-12） |
| A3 | 最終レビューの後: ボタンは**この更新でラベル `faq-ask-resolved` が今付いたときだけ**出す（本文の `changed_attributes` の `label_list`。残ったラベルで、後の別の更新や解決済みの会話の開き直しのときにボタンを出さない） |
| A4 | 最終レビューの後: スヌーズ中の会話の扱いは実装者に任せる → **スヌーズ中も担当者の会話として［解決しました］を受け付ける**（担当者がマクロで確認を求めた意図を通す。`open` と同じく、ボタンが最新のときだけ） |
| A5 | 最終レビューの軽い指摘（スヌーズ中・ラベルの入れ違い・`--check`）も直す |

## 2. 確かめた事実（開発の Chatwoot v4.18.0 のソース。2026-10-12）

- **管理画面からはボタン（`input_select`）を送れない。** 返信欄・定型文・マクロの「メッセージを送る」（`send_message`）はどれも文字だけ。
- **マクロは「ラベルを付ける」（`add_label`）ができる**（`app/models/macro.rb` の `ACTIONS_ATTRS`）。マクロの API は `POST /api/v1/accounts/{id}/macros`（`name`・`visibility`・`actions: [{ action_name, action_params }]`。`macros_controller.rb`）。
- **ラベルを変えると `conversation_updated` が出る**（`conversation.rb` の `allowed_keys?` に `label_list`）。**ボットにも届く**（`agent_bot_listener.rb` の `conversation_updated`。受信箱に付いたボットに送る）。本文は会話の `webhook_data`（`Conversations::EventDataPresenter`。`id` は `display_id`、`status`、`labels`、`account`〈`id`〉、`inbox_id`）に `event` と **`changed_attributes`**（`BaseListener#extract_changed_attributes`。`[{ label_list: { previous_value, current_value } }]` の形。変更が無ければ `null`）を足したもの。**同じラベルの並びを付け直しても変更にならず、イベントは出ない**（acts-as-taggable-on）。署名・時刻のヘッダーはメッセージのイベントと同じ。
- **この送信に失敗しても Chatwoot は何もしない**（`handle_failure` が会話を `open` にするのはメッセージのイベントのときだけ。一覧の仕様の 2 節と同じ）。
- **ボットのトークンでラベルの付け替え（`labels#create`）・会話の `show`・メッセージの作成・`toggle_status` を呼べる**（前の仕様の 1 節）。

## 3. 流れ

1. 担当者が管理画面で返信した後、マクロ「解決の確認を送る」を押す。マクロはラベル `faq-ask-resolved` を付けるだけ。
2. Chatwoot がボットに `conversation_updated` を送る。ボットは署名・時刻・アカウントを確かめる（前の仕様と同じ）。
3. **本文の `changed_attributes` の `label_list` で、`faq-ask-resolved` が前の値に無く今の値にある（今付いた）ときだけ進む。** それ以外は 200 で何もしない（ステータス・担当の変更、ボットのラベルの付け替え、既に付いているラベル、ラベルを外したときのイベントはここで止まり、Chatwoot の API を呼ばない。A3）。
4. 会話の `show` を読む。**`resolved` なら何もしない**（`decision: "skip-resolved"`）。**ラベルがもう無ければ何もしない**（`skip-no-label`。同じイベントの重複や、続けて届いた別の更新のイベント）。
5. **ボタンを送る前に、ラベルを外す**（今のラベルから `faq-ask-resolved` を除いて付け替える）。二度押し・重複したイベントでボタンが 2 回出ないようにするため。
6. `input_select` を 1 通送る（`in_reply_to` は入れない）。
   - 本文: 「ご質問は解決しましたか？まだご不明な点があれば、そのまま入力してください。」（仮。R3 が見直す）
   - 選択肢: ［解決しました］（値は前の仕様と同じ `__resolved`）
7. ステータスは変えない（`open` のまま。担当者の対応中）。

**訪問者が［解決しました］を押したとき**

- 前の仕様の「選択:［解決しました］」と同じく、お礼を返して `resolved` にする。**このときだけ、担当者の会話（`open`・`snoozed`。A4）でも受け付ける**（前の仕様 7.4 は `pending` のときだけ続けていた）。
- **ほかの選択（FAQ の id・［担当者に相談する］・［どれにも当てはまらない］）は、今までどおり `pending` のときだけ**受け付ける（`open`・`snoozed` は人の担当）。
- 二重送信と古いボタンの判定は前の仕様 7.4 のまま: 最新のメッセージがそのボタン自身ならお礼を送る。**担当者の会話では、Chatwoot の自動のテンプレート（営業時間外の自動返信など）が最新でも例外にしない**（その前に訪問者の新しい発言があるため。2026-10-12 の最終レビュー）。その後に担当者や訪問者がメッセージを送っていれば、**古いイベントとして何もしない**（担当者が対応を続けているのに、訪問者が前のボタンを押して閉じてしまうのを防ぐ）。

## 4. faq-bot の変更（`backend/faq-bot`）

| ファイル | 変更 |
|---|---|
| `src/constants.ts` | `LABELS.askResolved = "faq-ask-resolved"`、`MESSAGES.askResolved`（3 節の 6 の本文） |
| `src/chatwoot/client.ts` | `getLabels(conversationId)`（`labels#index`。ボットのトークンで呼べる）。`execute` がラベルを書く直前に読み直す（5 節の入れ違い） |
| `src/chatwoot/events.ts` | `conversation_updated` を解釈して、`changed_attributes` の `label_list` で `faq-ask-resolved` が今付いていれば `AskResolvedEvent`（`kind: "ask-resolved"`・`accountId`・`conversationId`）、無ければ `ignore`。形の壊れた本文は `InvalidEventError` |
| `src/dialog/ask-resolved.ts`（新規） | `askResolvedReply(): Reply`（副作用なし） |
| `src/dialog/execute.ts` | `executeAskResolved(client, conversationId, reply)`: 3 節の 4〜6。結果は `"sent"` / `"skip-resolved"` / `"skip-no-label"`。`execute` は、判定が `resolved` のときだけ `open`・`snoozed` の会話でも続ける |
| `src/handler.ts` | `ask-resolved` のイベントを扱う。ログは前の仕様の 1 行の形に `event: "ask-resolved"`・`conversation`・`decision`（`ask-resolved` / `skip-resolved` / `skip-no-label`）・`ms` |

- **判定（`decide.ts`）は変えない。**

## 5. 失敗時の扱い

| 失敗 | 扱い | 担当者・訪問者から見える結果 |
|---|---|---|
| 会話の `show`・ラベルの付け替えの失敗（ラベルは残る） | 例外（502）→ Lambda の `Errors` のアラーム。Chatwoot は送り直さない（送り直すのは 429・500 だけ） | ボタンが出ない。**ラベルが残ったままマクロを押し直しても、ラベルが変わらないので Chatwoot は `conversation_updated` を出さない**（2026-10-12 の最終レビューで確認。acts-as-taggable-on は同じラベルの並びを変更として扱わない）。担当者はラベル `faq-ask-resolved` を外してからマクロを押し直す。外さないままでも、後の別の更新でボタンが遅れて出ることはない（A3。今付いたときだけ反応する） |
| ラベルは外れたが送信に失敗 | 同上 | ボタンが出ない。もう一度押せば出る |
| 担当者がマクロを素早く 2 回押す | 2 つ目のイベントの時点でラベルが外れていれば `skip-no-label`。外す前に 2 つとも `show` を読んだ場合だけ 2 通出うる（排他の手段が無く、まれなので許す） | まれにボタンが 2 つ並ぶ |
| 解決済みの会話でマクロを押す | `skip-resolved`（ラベルは外さない。担当者が外す） | 何も起きない。会話を開き直してもボタンは出ない（A3） |
| ラベルの入れ違い（ボットの回答・引き継ぎのラベルの書き込みと、担当者のマクロが重なる） | ラベルの付け替えは一覧ごと書くため、`execute` は書く直前に `getLabels` で読み直す（A5）。読み直しと書き込みの間（1 往復）に重なった場合だけ、足されたラベルが消えるか、外したラベルが付き直ってボタンがもう 1 通出うる（排他の手段が無く、まれなので許す） | まれにボタンが出ない（マクロを押し直す）か、2 つ並ぶ |

## 6. Chatwoot の設定（setup と本番の手順）

- **開発**: `backend/chatwoot-system/setup/index.mjs` がラベル `faq-ask-resolved`（説明「担当者が解決の確認を送るときに付ける〈マクロ用〉」）とマクロ「解決の確認を送る」（`visibility: global`、動作は `add_label: faq-ask-resolved`）を作る（あれば作らない）。`--check` でマクロと FAQ のラベル（4 つ）があることを確かめる。
- **本番**: `cloud/README.md` の 4.14 に、ラベルとマクロを画面で作る手順を足す。

## 7. 更新する文書

| 文書 | 更新 |
|---|---|
| 前の仕様 | 7.1 節の表に `conversation_updated` の行、7.4 節に「`__resolved` は `open` でも受け付ける」を足し、この仕様を指す |
| `docs/RequirementDefinition/AA/02-integration-architecture.md` | I-31 に `conversation_updated`（解決の確認）を足す |
| `docs/DetailedDesign/04-server-to-server-flows.md` | 12 節に「解決の確認」の流れ（12.4）を足す |
| `backend/faq-bot/README.md` | 「動き」の表に 2 行（マクロ・`open` での［解決しました］）、ラベルの説明 |
| `cloud/README.md` | 4.14 にラベルとマクロ |
| `setup/README.md` | chatwoot の行にラベルとマクロ |

## 8. テスト（D5 により単体と結合の両方を作る）

- **単体**（外部はモック）:
  - `events`: `conversation_updated` で `faq-ask-resolved` が今付いた → `ask-resolved`。既に付いている・外した・ほかのラベル・ステータスの変更・`changed_attributes` が無い → `ignore`。`id`・`account` が欠けた本文 → `InvalidEventError`。
  - `execute`: ラベルを外してから送る順序、`resolved` なら何もしない、ラベルが無ければ何もしない、失敗で例外。`execute` の［解決しました］が `open` でも通り、ほかの判定は `open` で `not-pending` のまま。
  - `handler`: 一連の流れとログ。
- **結合**（開発の Chatwoot を本物として使う）:
  - 引き継いで `open` になった会話に、管理者のトークンでラベル `faq-ask-resolved` を付ける（マクロと同じ結果）→ ボットのボタンが出て、ラベルが外れる。
  - 訪問者がそのボタンの［解決しました］を押す → お礼が出て `resolved` になる。
  - ボタンの後に担当者が返信してから押す → 何も起きない（`open` のまま）。
  - スヌーズ中の会話でボタンを押す → `resolved` になる（A4）。
  - 解決済みの会話に付けたラベルは残り、会話を開き直してもボタンが出ない（A3）。
