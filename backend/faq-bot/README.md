# faq-bot（Chatwoot の FAQ ボット）

Chatwoot の受信箱「Web サイト」で、訪問者の質問に **Web サイトの FAQ の原文**で答えるエージェントボット。答えられないときは、ラベルを付けて担当者に引き継ぐ。

- 仕様: `docs/superpowers/specs/2026-10-11-faq-bot-design.md`（判断の経緯は AA-05 の ADR-26、連携点は AA-02 の `I-31`〜`I-33`、フローは DD-04 の 12 節）
- 本番: **Lambda（VPC の外。関数 URL）**（ADR-26。`cloud/stacks/services/faq-bot.yaml`。手順は `cloud/README.md` の 4.17）
- 開発: Node の HTTP サーバー（`127.0.0.1:3107`）。開発の Chatwoot（Docker）からは `middleware/host-relay` 経由で `http://host.docker.internal:3107/webhook` に届く
- FAQ の正本: Astro の `site-content`。ビルドが `faq.json` を出し（`frontend/verdant-virgo/src/modules/faq-export`）、ボットが 10 分ごとに読む。`【要記入】`・`【要確認】` の付いた項目は出さない
- **データの置き場を持たない。** 訪問者の発言は Chatwoot の外に残さない（ログは会話の番号・判定・スコアだけ）

## 動き

| 状況 | ボットの応答 | ラベル | ステータス |
|---|---|---|---|
| ウィジェットを開いた（会話が無いか、直前の会話が解決済み） | 会話を作り「よくあるご質問です。…」とトップページの FAQ（最大 6 件）の選択肢 | — | `pending` |
| FAQ にはっきり当たる | FAQ の回答の原文 ＋ ページの URL と［解決しました］［担当者に相談する］ | `faq-answered` | `pending` のまま |
| 候補がいくつかある | 「次のどれに近いですか？」と上位 3 件（「質問（ページ名）」）と［どれにも当てはまらない］ | — | `pending` のまま |
| 当たらない・［どれにも当てはまらない］ | 引き継ぎの案内 | `faq-unmatched` | `open`（担当者へ） |
| ［担当者に相談する］ | 引き継ぎの案内 | `faq-handoff` | `open` |
| ［解決しました］ | お礼 | — | `resolved` |
| 担当者がマクロ「解決の確認を送る」を押した（ラベル `faq-ask-resolved`） | ラベルを外して「ご質問は解決しましたか？…」と［解決しました］ | （`faq-ask-resolved` を外す） | そのまま |
| 担当者の対応中（`open`・`snoozed`）に［解決しました］ | お礼（ボタンが最新のメッセージのときだけ） | — | `resolved` |

照合は文字 2-gram の Dice 係数（外部 API なし）。しきい値は `FAQ_MATCH_HIGH`・`FAQ_MATCH_LOW`・`FAQ_MATCH_MARGIN`（既定 0.5・0.25・0.1。言い換えの例文 43 件で正答率 93.0%）。

## モジュール

| パス | 責務 |
|---|---|
| `src/config.ts`・`src/constants.ts` | 環境変数の検証（値は出さない）・既定値・文言 |
| `src/faq/` | `faq.json` の契約（`schema.ts`）と、取得・索引・更新（`store.ts`。失敗したら直前の索引） |
| `src/matcher/` | 正規化・n-gram・Dice・順位（副作用なし） |
| `src/chatwoot/` | 署名の検証・Webhook の本文の解釈・ボットのトークンで呼ぶ API |
| `src/dialog/` | 判定（`decide.ts`。副作用なし）と、Chatwoot への反映と二重回答の防止（`execute.ts`） |
| `src/handler.ts`・`src/runtime.ts` | 入口に依存しない本体と、部品の組み立て |
| `src/server.ts`・`src/index.ts` | 開発の入口（3107） |
| `src/lambda.ts`・`Makefile` | 本番の入口（コールドスタートで Secrets Manager からトークンと secret を読む）と SAM のビルド |
| `setup/index.mjs` | 開発の setup（状態ファイルのボットのトークンと secret を環境変数ファイルに写す） |

## 使い方

```bash
pnpm install
pnpm dev                # 127.0.0.1:3107（環境変数ファイルは node setup/setup.mjs --target dev --only chatwoot,faq-bot が作る）
pnpm test               # 単体テスト（外部はモック。照合の評価 tests/matcher-eval.test.ts を含む）
pnpm typecheck
pnpm test:integration   # 結合テスト（開発の Chatwoot を本物として使う）
```

結合テストの前提: `node setup/setup.mjs --target dev` が済んでいること、host-relay が 3107 を中継していること、**`pnpm dev` を止めておくこと**（テストが 127.0.0.1:3107 で faq-bot を起動する）。作ったコンタクト（`it-faq-bot-…`）は最後に消す。

環境変数は `.env.example` を見る（本番のトークンと secret は Secrets Manager の `comegin/<env>/faq-bot/*`）。

## Chatwoot の落とし穴（v4.18.0 のソースで確認）

- **Captain（Chatwoot の AI）は有償ライセンスが要る**（`self_hosted_paid?`）。そのため Webhook 型のエージェントボットを自作した。
- **ボットのトークンで呼べる API は限られる**（`access_token_auth_helper.rb` の `BOT_ACCESSIBLE_ENDPOINTS`）: 会話の `show`・`toggle_status` など、メッセージの `create`、ラベルの `index`・`create`。**メッセージの一覧は読めない。**
- 会話の `show` の `messages` は 1 件だけで、ラベルやステータスの変更の**活動メッセージになりうる**。二重回答の判定には `last_non_activity_message` を使う。
- **ウィジェットの最初の発言の直後に、Chatwoot が連絡先の入力欄を `template`（`message_type` 3）として自動で足す。** 訪問者の新しい発言と取り違えない（`dialog/execute.ts`）。
- **ボットの返事には必ず `content_attributes.in_reply_to`（どの発言への返事か）を入れる。** Chatwoot は同じ会話のメッセージの id ならそのまま残す。最新のメッセージがボットの返事のとき、これで「送信済み（送り直し）」「続けて送られた質問の競合」「古い選択肢を後から押した」を見分ける（`dialog/execute.ts`）。
- 本文の無い発言（添付だけ）も空の質問として扱い、担当者に引き継ぐ（無視すると `pending` のまま誰にも見えなくなる）。
- **ラベルの `create` は付け替え**（今のラベルと合わせて送る）。
- **Chatwoot が送り直すのは応答が 429・500 のときだけ**（3 秒おきに最大 3 回）。タイムアウト・接続の失敗・502 では送り直さず、**会話をすぐ `open` にする**（ボットが落ちても訪問者は担当者に回る）。
- そのため**開発で faq-bot を止めていると、受信箱の `pending` の会話は、社内メモの投稿などでも Webhook が失敗して `open` になる**（結合テスト `integration/tests/chatwoot-mcp` の一部はこれで落ちる。faq-bot を動かせば通る）。
- 選択肢（`input_select`）を訪問者が選ぶと、新しいメッセージは作られず、**ボットのメッセージの `content_attributes.submitted_values` が更新され、`message_updated` が届く。**
- 新しい会話は、受信箱にボットが付いていると `pending` で始まる。`open` 以降は人の担当で、ボットは何もしない。
- **ウィジェットのバブルを開くと `webwidget_triggered` が届く**（本文は `ContactInbox#webhook_data`。`current_conversation` はその訪問者の最後の会話で、無ければ `null`）。**この送信に失敗しても Chatwoot は何もしない**（会話を `open` にするのはメッセージのイベントのときだけ）。
- **ボットのトークンでも会話を作れる**（`conversations#create`。`source_id` と `inbox_id`）。ただし受信箱が `lock_to_single_conversation` だと、作らずに最後の会話を返す（解決済みでも）。そのため作成の応答が `pending` でなければ一覧を送らない（`dialog/execute.ts` の `executeWelcome`）。
- **ウィジェットに「ボット」の名前で出る、FAQ ボット以外のメッセージは、Chatwoot の自動のメールアドレスの収集**（受信箱の `enable_email_collect`。「ご連絡先をご入力ください。」と入力欄。メールアドレスの無い訪問者の発言に Chatwoot が自動で足す `template`〈`message_type` 3〉で、ウィジェットは `template` の送り主を必ず「ボット」と表示する〈`AgentMessage.vue`〉）。集めたメールアドレスは Mautic との突合（I-19）に使うので残している（2026-10-12 にユーザーが判断）。
- **担当者への引き継ぎのメール**: ボットが会話を `open` にすると、Chatwoot が受信箱のメンバーに「新しい会話」（`conversation_creation`）の通知を作る。メールになるのは、その担当者が「新しい会話が作成されたとき」のメールを有効にしているときだけ。開発は setup が管理者を受信箱のメンバーにして有効にする。**開発のメールは Chatwoot の MailHog（`http://localhost:8026`）に届く**（n8n・Mautic の MailHog〈8025〉とは別）。受信箱の自動割り当てで「割り当てられたとき」のメールも続けて来る。
- **解決した会話に訪問者が書き込むと、新しいチャットになる**（受信箱の `allow_messages_after_resolved: false`。2026-10-12 に setup で設定）。ウィジェットは入力欄を消して「新しいチャットを開始する」を出す。
- **一覧の会話では、受信箱の挨拶メッセージと営業時間外の自動応答が出ない**（`MessageTemplates::HookExecutionService`: 挨拶は公開の `outgoing` が 1 件も無いとき、営業時間外は直近 5 分に公開の `outgoing` が無いときだけ出る）。
- **ボットが会話を作ると `conversation_created` が出る。** そのため n8n の I-12 は、リード通知を会話の作成ではなく顧客の最初の公開メッセージで行う（2026-10-12 に I-12 を変更。仕様 `2026-10-12-faq-bot-welcome-design.md` の 5.1 節）。`conversation-triage` は中身の無い `pending` の会話も数える（未対応）。
- **初めて開いたとき、ウィジェットはホーム画面のまま**で、ボットの一覧が届くとボタンが「会話を開始」から「会話を続行」に変わる。押すと一覧が見える（開いたときにメッセージの画面へ移るのは、メッセージが既にあるときだけ。`app/javascript/widget/App.vue`）。
- **管理画面からはボタン（`input_select`）を送れない**（返信欄・定型文・マクロの「メッセージを送る」はどれも文字だけ）。そのため担当者の返信の後の［解決しました］は、マクロ「解決の確認を送る」がラベル `faq-ask-resolved` を付け、ボットが `conversation_updated` の `changed_attributes` で「今付いた」ことを確かめ、ラベルを外してから送る（2026-10-12。仕様 `2026-10-12-faq-bot-ask-resolved-design.md`）。マクロを使わず担当者がラベルを手で付けても同じ。**ボタンが出ずにラベルが残っていたら（faq-bot の失敗）、ラベルを外してからマクロを押し直す**（同じラベルを付け直しても Chatwoot は変更として扱わず、`conversation_updated` が出ない）。ボットは「今付いた」ときだけ反応するので、残ったラベルで後からボタンが出ることはない。
