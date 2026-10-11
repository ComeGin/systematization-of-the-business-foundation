# faq-bot: ウィジェットを開いたときに「よくあるご質問」の一覧を出す

- 日付: 2026-10-12
- 状態: 設計の承認待ち（会話での設計はユーザーが承認済み）
- 前提: `docs/superpowers/specs/2026-10-11-faq-bot-design.md`（以下「前の仕様」）。この仕様は前の仕様への**追加**で、前の仕様の規則（`pending` の間だけ答える・二重回答の防止・ラベル・失敗時の扱い）はそのまま効く

## 1. 目的と合意した理解

**目的**: 訪問者がチャットのウィジェットを開いた時点で、ボットが「よくあるご質問」の一覧（選択肢）を出す。訪問者は打ち込まずに選ぶだけで FAQ の回答を得られる。

**ユーザーが決めたこと（2026-10-12）**

| # | 決定 |
|---|---|
| W1 | 一覧を出すのは**ウィジェットを開いた時**（最初の発言への返事に添える案、Chatwoot のヘルプセンターの「人気の記事」を使う案は採らない） |
| W2 | 一覧の中身は**トップページの FAQ**（`frontend/verdant-virgo/src/modules/site-content/top.ts` の `TOP.faq.items`）を、ページの順のまま使う。`faq.json` の契約も site-content の型も変えない。一覧を変えたいときはトップページの FAQ を変える（サイトとチャットの「よくある」が揃う） |
| W3 | この設計（2〜7 節）を承認（2026-10-12） |

**設計で決めたこと**

- **一覧は最大 6 件。** 会話の中でユーザーに示した選択肢では「最大 5 件」としたが、トップページの FAQ は 6 件ですべて完成している。5 件にすると、問い合わせにつながる「無料相談では何をしますか？」が外れるため 6 件にした（ユーザーは設計 1 の提示で承認）。
- **［上記以外を質問する］のボタンは置かない。** ウィジェットの入力欄はいつでも使えるため、本文で案内する。

**選ばなかった案と理由**

| 案 | 採らない理由 |
|---|---|
| 最初の発言への返事に一覧を添える | 訪問者が何か打つまで一覧が見えず、「打たずに選べる」という目的を満たさない |
| Chatwoot のヘルプセンター（ウィジェットのホームの「Popular Articles」。`app/javascript/widget/components/pageComponents/Home/Article/ArticleContainer.vue`） | FAQ を Chatwoot のヘルプセンターにも複製するため正本が二重になる。同じ内容の公開ページ（`/hc/<slug>/…`）ができ、SEO に不利 |
| site-content に「よくある」の印（順位）を付ける | ページをまたいで選べるが、`faq.json` の契約と site-content の型が変わる。今はトップページの FAQ で足りる |
| ボットの回答の実績で決める | 本番のログ（CloudWatch）を改善ループが読む仕組みが新たに要る。実績が貯まってから、W2 の「トップページの FAQ を変える」提案（E-13）として扱える |

## 2. 確かめた事実（開発の Chatwoot v4.18.0 のソース。2026-10-12）

- **ウィジェットのバブルを開くと `webwidget.triggered` が送られる**（`app/javascript/sdk/IFrameHelper.js` の `onBubbleToggle`）。ただしウィジェットが未読の表示（`unread-messages`）とキャンペーンの表示（`campaigns`）のときは送らない（`app/javascript/widget/App.vue` の `createWidgetEvents`）。受け口は `POST /api/v1/widget/events`（`Api::V1::Widget::EventsController`。`name` と `website_token`）。
- **ボットには `webwidget_triggered` として届く**（`app/listeners/agent_bot_listener.rb`）。本文は `ContactInbox#webhook_data` に `event` と `event_info` を足したもの: `id`（ContactInbox の id）・`contact`・`inbox`（`id` を含む）・`account`（`id` を含む）・**`current_conversation`（その訪問者のこの受信箱の最後の会話。無ければ `null`）**・`source_id`。署名・時刻のヘッダーはメッセージのイベントと同じ（`AgentBots::WebhookJob` → `Webhooks::Trigger`）。
- **この送信に失敗しても Chatwoot は何もしない。** `handle_failure` が会話を `open` にするのはメッセージのイベントのときだけで、`webwidget_triggered` には会話が無い。送り直しは前の仕様と同じく 429・500 のときだけ。
- **ボットのトークンで会話を作れる**（`BOT_ACCESSIBLE_ENDPOINTS` に `conversations#create`）。`POST /api/v1/accounts/{account_id}/conversations` に `source_id` と `inbox_id` を渡すと、その ContactInbox の会話を作る（`ConversationBuilder`）。**`status` を渡さなければ、ボットが付いた受信箱では `pending` で始まる**（前の仕様 1 節の事実）。応答の `id` は会話の `display_id`、`status` はそのステータス。
- **受信箱が `lock_to_single_conversation` のときは、作らずに既存の最後の会話を返す**（`ConversationBuilder#look_up_exising_conversation`）。解決済みの会話が返ると、そこに一覧を出しても `pending` でないため選択に答えない。開発の受信箱「チャットサポート」（ID 5）は `false`（2026-10-12 に確認）。この食い違いに備え、**作成の応答のステータスが `pending` でなければ送らない**（3 節の 5）。
- 会話の `webhook_data`（`current_conversation`）は `Conversations::EventDataPresenter` が作り、`id`（`display_id`）と `status` を含む。
- **ウィジェットは「最後の会話」に書き込む**（`Api::V1::Widget::BaseController#conversation` が `conversations.last`）。ボットが作った会話が最後の会話になるので、訪問者の次の発言はその会話に入る。
- **ウィジェットは ActionCable の `message.created` を受けて表示に足す**（`app/javascript/widget/helpers/actionCable.js`）。**ボットが作った会話のメッセージが、開いているウィジェットに実際に出るかは、実装の最初に開発の環境で確かめる**（9 節の T0。出なければ止めてユーザーに相談する）。
- **T0 の結果（2026-10-12）**: 再読み込みなしで届く。ただし**初めて開いたときはウィジェットがホーム画面のまま**で、ボタンが「会話を開始」から「会話を続行」に変わり、押すと一覧が見える（`app/javascript/widget/App.vue` の `toggle-open`: 開いたときにメッセージの画面へ移るのは `messageCount` があるときだけ）。訪問者は打つためにも同じボタンを押すので、打つ前に一覧が見える（1 節の目的は満たす）。2 回目以降の開閉ではメッセージの画面に直行する。

## 3. 流れ

1. 訪問者がウィジェットを開く → Chatwoot が `webwidget_triggered` をボットに送る。
2. ボットは前の仕様と同じく署名・時刻を検証し、アカウントが `CHATWOOT_ACCOUNT_ID` と同じかを確かめる。
3. **一覧を出すかを決める**: `current_conversation` が `null`、またはその `status` が `resolved` のときだけ進む。それ以外（`pending`・`open`・`snoozed`）は 200 で何もしない（**開くたびに一覧を出さない**。進行中の会話はそのまま続ける）。
4. `faq.json` の索引から、**id が `top-` で始まる項目を `faq.json` の順に最大 6 件**とる（`faq-export` の id は「`<ページの key>-<元の順番>`」で、トップページの key は `top`。この id の形は前の仕様 5 節に契約として書かれている）。0 件なら 200 で何もしない。
5. ボットのトークンで会話を作る（`source_id`・`inbox_id`。`status` は渡さない）。**応答のステータスが `pending` でなければ、送らずに終える**（ログの `decision` は `skip-not-pending`。2 節の `lock_to_single_conversation`）。
6. 作った会話に `input_select` を 1 通送る。
   - 本文: 「よくあるご質問です。当てはまらなければ、ご質問をそのまま入力してください。」
   - 選択肢: 各項目の見出しは前の仕様の `candidateTitle`（トップページの項目は context が `null` なので質問だけ）、値は FAQ の `id`。
   - `in_reply_to` は入れない（訪問者の発言が無いため）。
7. ラベルもステータスも変えない（まだ何も答えていない）。

**その後**

- 訪問者が選ぶ → `message_updated`（`submitted_values` に FAQ の `id`）→ **前の仕様の「選択: FAQ の `id`」のとおり**回答の原文＋URL＋［解決しました］［担当者に相談する］を返し、`faq-answered` を足す。前の仕様 7.4 の判定では、対象（一覧のメッセージ）が `last_non_activity_message` と同じなので送る。
- 訪問者が選ばずに打ち込む → 前の仕様の質問の流れ。その後に一覧の項目を押しても、`last_non_activity_message` がボットの別の返事（`in_reply_to` が一覧より後の発言）なので**古いイベント**として何もしない（前の仕様 7.4 のまま）。
- 訪問者が何もせずに閉じる → 会話は `pending` のまま残る（前の仕様の「回答の後に離れた会話」と同じ扱い。担当者の既定の一覧〈`open`〉には出ない）。

## 4. faq-bot の変更（`backend/faq-bot`）

| ファイル | 変更 |
|---|---|
| `src/constants.ts` | `MESSAGES.welcome`（6 節の本文）、`WELCOME_PAGE_KEY = "top"`、`MAX_WELCOME_ITEMS = 6` |
| `src/chatwoot/events.ts` | `webwidget_triggered` を解釈して `WelcomeEvent`（`kind: "welcome"`・`accountId`・`inboxId`・`sourceId`・`currentStatus: ConversationStatus \| null`）を返す。形の壊れた本文は `InvalidEventError` |
| `src/chatwoot/client.ts` | `createConversation(sourceId, inboxId): Promise<{ id: number; status: ConversationStatus }>`（`id` は `display_id`） |
| `src/dialog/welcome.ts`（新規） | `welcomeItems(snapshot): FaqItem[]`（3 節の 4）と `welcomeReply(items): Reply`（副作用なし） |
| `src/dialog/execute.ts` | `executeWelcome(client, event, reply)`: 会話を作り、`pending` なら 1 通送る。結果は `{ outcome: "sent" \| "not-pending"; conversationId }` |
| `src/handler.ts` | `welcome` のイベントを 3 節の 3〜6 のとおり扱う。ログは前の仕様の 1 行の形に `event: "welcome"`（前の仕様のログと同じく、イベントの `kind` を出す）・`contact_inbox`（ContactInbox の内部の id。同じ訪問者の開閉をログだけで追うため。2026-10-12 の最終レビューで追加）・`decision`（`welcome` / `skip-active` / `skip-empty` / `skip-not-pending`）・`faq`（FAQ の id の配列。前の仕様のログと同じ項目名）を出す。訪問者の情報（`source_id`・氏名・メール）は出さない。**形の壊れた本文で 400 を返すときは、違う項目の名前だけを `warn`（`result: "invalid_event"`）で出す**（Chatwoot の更新で本文の形が変わったとき、黙って止まらないため。値は出さない。`current_conversation` のキーが無い本文も 400） |

- **判定（`decide.ts`）は変えない。** 一覧の選択は既存の「選択: FAQ の `id`」に乗る。
- **Chatwoot の設定・setup は変えない。** エージェントボットには、もともとすべてのイベントが届く。

## 5. 失敗時の扱い

| 失敗 | 扱い | 訪問者から見える結果 |
|---|---|---|
| `faq.json` を一度も取れていない（索引が空） | 例外 → `Errors` のアラーム（前の仕様 8 節と同じ）。会話は作らない | 一覧が出ない。打ち込めば前の仕様の流れ |
| トップページの項目が 0 件（すべて未完成の印付き、など） | 200。何もしない。ログの `decision` は `skip-empty` | 一覧が出ない |
| 会話の作成に失敗 | 例外（同上） | 一覧が出ない |
| 会話は作れたが送信に失敗 | 例外（同上）。**空の `pending` の会話が残る** | 一覧が出ない。打ち込めばその会話で前の仕様の流れ |
| 素早く 2 回開く（2 つ目のイベントの時点で 1 つ目の会話がまだ無い） | 会話が 2 つできうる。Chatwoot の側に排他の手段が無く、まれなので許す。ログの `contact_inbox` が同じ行が続くことで追える | 一覧が 2 回出ることがある |
| 訪問者がボットより先に打ち込む（開いてから、ボットが会話を作るまでの間〈Sidekiq の待ちと Lambda の処理。コールドスタートで数秒〉に送った） | ウィジェットが会話 A を作り、続けてボットが会話 B を作る。B が「最後の会話」になる。ボットのトークンでは訪問者の他の会話を見られないため防げない。まれなので許す（2026-10-12 の最終レビューで追加） | 最初の質問への答えは A に入り、ウィジェットには B（一覧）が出る。以後の発言は B に入る。A は `pending` のまま残るか、答えられなければ担当者に回る |
| ウィジェットのイベントの API を大量に呼ばれる | 発言による会話の作成と同じ程度の濫用の余地。同時実行の上限（5）で抑える | — |

### 5.1 下流への影響（2026-10-12 の最終レビューで判明）

ボットが会話を作ると、会話の作成を「訪問者が会話を始めた」とみなしている既存の仕組みの意味が変わる。

- **I-12 は直した（2026-10-12。ユーザーが下の案 (a) を選んだ）。** 会話の作成（`conversation_created`）では通知せず、**顧客の最初の公開メッセージ**で `conversation-opened` を通知する。2 通目以降は通知の印（`<display_id>|lead`。`dedup_chatwoot`、保持 7 日）で止める（DD-04 の 5 節）。
- **`conversation-triage` は未対応**（下の表）。

| 仕組み | 今の扱い | この機能を足した後に起きること |
|---|---|---|
| n8n の I-12（`middleware/n8n/workflows/I-12-chatwoot-webhook-dedup.json`） | Chatwoot のアカウントの Webhook の `conversation_created` を `kind: "conversation-opened"` として I-21 のリード通知（`comegin-lead-alert`）に送る。訪問者の発言（`message_created`）では通知しない | **ウィジェットを開いただけでリード通知が届く**（`pending` の会話でも `conversation_created` は送られる）。訪問者が実際に質問を打った時点では会話が既にあるため、通知は出ない。**→ 2026-10-12 に (a) で直した** |
| `conversation-triage`（`CAP-12`） | `open` と `pending` の会話を読み、社内メモを書き、未対応の件数を数える | 開いただけで中身の無い `pending` の会話もメモと件数の対象になる |

- 考えられる直し方: (a) I-12 で、着信のメッセージが無い `conversation_created` を飛ばし、会話の最初の着信を「会話の開始」として通知する。(b) faq-bot が作る会話に印（`additional_attributes`）を付け、I-12 と `conversation-triage` がそれを除く。(c) 決まるまで、本番の faq-bot ではこの機能を有効にしない。
- Chatwoot の担当者への通知（`NotificationListener`）は `pending` の会話を飛ばすので、影響しない。

### 5.2 一覧の会話では、挨拶メッセージと営業時間外の自動応答が出ない

`MessageTemplates::HookExecutionService`（2026-10-12 の最終レビューで確認）の条件による。

- **挨拶メッセージ**（`greeting_message`）は、会話にボットや担当者の公開メッセージ（`outgoing`）とテンプレートが 1 件も無いときだけ出る（`first_message_from_contact?`）。一覧が先にあるので出ない。
- **営業時間外の自動応答**（`out_of_office_message`）は、直近 5 分以内に公開の `outgoing` があると出ない。開いてすぐ打ち込んだ訪問者には出ない。
- 開発の受信箱（ID 5）は挨拶の本文が空で営業時間の設定も無効なので、今は影響が無い。R3 がこれらを設定するときは、この機能と両立しないことを前提にする（連絡先の入力欄〈`input_email`〉は影響を受けない）。

## 6. 文言（仮。前の仕様 14 節と同じく R3 が見直す）

- 一覧の本文: 「よくあるご質問です。当てはまらなければ、ご質問をそのまま入力してください。」

## 7. 更新する文書

| 文書 | 更新 |
|---|---|
| 前の仕様 `2026-10-11-faq-bot-design.md` | 5 節に「トップの項目〈`top-`〉は、ウィジェットを開いたときの一覧にも使う（id の形を変えると一覧が空になる）」を足す。7.1 節の表に `webwidget_triggered` の行を足し、この仕様を指す |
| `docs/RequirementDefinition/AA/02-integration-architecture.md` | I-31（Chatwoot → faq-bot の Webhook）に `webwidget_triggered` を足す。I-32（faq-bot → Chatwoot の API）に会話の作成を足す |
| `docs/DetailedDesign/04-server-to-server-flows.md` | 12 節に「ウィジェットを開いたときの一覧」の流れを足す |
| `backend/faq-bot/README.md` | 「動き」の表に 1 行、「Chatwoot の落とし穴」に 2 節の事実（`current_conversation`・失敗時に何もしない・`conversations#create`） |

## 8. 対象外

- 一覧の中身を実績で決めること（1 節の表）。
- 訪問者が開いただけの `pending` の会話の片付け（前の仕様と同じく対象外）。
- Chatwoot の受信箱の「挨拶メッセージ」（`greeting_message`）の設定は変えない。**ただし一覧の会話では挨拶メッセージが出なくなる**（5.2 節。旧版は「最初の発言の後にしか出ないため別物」と書いていたが、2026-10-12 の最終レビューで誤りと分かった）。
- 5.1 節の下流（n8n の I-12・`conversation-triage`）の変更。扱いが決まってから別の作業で行う。

## 9. テスト（D5 により単体と結合の両方を作る）

- **T0（実装の最初。確認だけ）**: 開発の Chatwoot で、ボットのトークンで作った会話のメッセージが、開いているウィジェットに出ることを playwright-host で確かめる。出なければ止めてユーザーに相談する。
- **単体**（外部はモック。前の仕様と同じ書き方）:
  - `events`: `webwidget_triggered` → `welcome`。`current_conversation` が `null` のとき・`resolved` のとき・`pending` のときの `currentStatus`。`inbox`・`account`・`source_id` が欠けた本文は `InvalidEventError`。
  - `welcome`: `top-` の項目だけを順に最大 6 件。0 件。見出しと値。
  - `execute`: 会話を作ってから送る順序。作成の応答が `pending` でなければ送らない。作成の失敗・送信の失敗で例外。
  - `handler`: 進行中の会話では何もしない（Chatwoot の API を呼ばない）、`resolved` なら出す、0 件なら何もしない、ログに `source_id` が出ない。
- **結合**（開発の Chatwoot を本物として使う。前の仕様と同じ `integration/`）:
  - ウィジェットの API（`/api/v1/widget/config` → `/api/v1/widget/events` に `webwidget.triggered`）で開く → ボットが作った会話に一覧のメッセージが出る（`pending`、選択肢 6 件以下）。
  - 一覧の項目を選ぶ → 回答の原文が返り、`faq-answered` が付く。
  - 進行中の会話がある訪問者が開いても、新しい会話は作られない。
