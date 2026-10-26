# n8n ワークフロー（Git 管理）

> **n8n を初めて触る人は、先に [GUIDE.md](GUIDE.md)（はじめての人向けの手順書）を読む。** この README は設計の背景と仕様の正本。

`middleware/n8n` の n8n に置くワークフローの JSON。設計の出典は `docs/DetailedDesign/04-server-to-server-flows.md`（4〜8 節）と `01-flow-specification-rules.md`（5〜7 節）。

**この JSON は「開発の n8n で組んで動作確認したものの書き出し」である。** 本番の n8n への取り込み・資格情報の割り当て・**有効化（publish）は人間（`R1`）が行う**。エージェントからは有効化に到達させない（`n8n-prod` の MCP は作成・更新まで。DD-04 6.2）。

**本番の n8n はオンプレで動く（ADR-21。`onprem/n8n`）。** データ（ワークフロー・資格情報・実行履歴）は AWS の RDS の `n8n` データベースにある。エディター・API・MCP は `127.0.0.1:5679`（`n8n-prod` の接続先）。クラウドの Mautic・Chatwoot の Webhook は、WireGuard 越しにリバースプロキシ（`http://10.99.0.2:5680`。`/webhook/*` の POST だけを n8n に通す）に届く。本番には開発のサンドボックスを置かない。ここにある JSON はどれも `"active": false` で、書き出し時点で公開（publish）されたものは 1 本もない。**ただし、`active` の値は「Git が決めるもの」ではなく「書き出した時点のその n8n の事実」である。** 監視アプリの定期実行 `n8n-export`（`backend/control-plane`。本番の n8n の Public API から読み、PR で出す）が動き出すと、Git の JSON は**本番の状態の写し**になり、公開されたワークフローは `"active": true` で書き出される（`id`・`versionId`・`updatedAt` などの揮発する項目は除かれる）。**Git の JSON の `active` を「公開してよい」の指示として読まない。公開は人間（`R1`）が本番のエディターで行う。**

## 一覧

| ファイル | 連携 | 種類 | 状態 |
|---|---|---|---|
| `I-11-mautic-webhook-dedup.json` | `I-11` Mautic → n8n | Webhook（`POST /webhook/mautic-event`） | 動作確認済み・未公開 |
| `I-12-chatwoot-webhook-dedup.json` | `I-12` Chatwoot → n8n | Webhook（`POST /webhook/chatwoot-event`） | 動作確認済み・未公開 |
| `I-19-email-match.json` | `I-19` Chatwoot と Mautic の email 突合 | サブワークフロー（`I-12` から呼ばれる） | 動作確認済み（Mautic の応答はピン留め）・未公開 |
| `I-21-sns-notify.json` | `I-21` n8n → Amazon SNS（開発は MailHog） | サブワークフロー（`I-11` `I-12` と監視から呼ばれる） | 動作確認済み（配信ノードはピン留め）・未公開 |
| `I-18-posthog-writeback.json` | `I-18` Mautic → PostHog の書き戻し | Webhook の骨格 | **前提待ち。何も送信しない骨格で、有効化しない**（下の「I-18」） |
| `weekly-inquiry-inventory.json` | 週次 問い合わせの棚卸し（TA-03 の週次。連携点の番号なし） | スケジュール（毎週月曜 09:00） | 動作確認済み（Chatwoot の応答はピン留め）・未公開。`inventoryEnabled` が `true` のときだけ動く |
| `n8n-schedule-heartbeat.json` | n8n のスケジュール実行のハートビート（TA-05 の項目 3） | スケジュール（5 分ごと） | 動作確認済み（AWS への送信は未実施・署名と本文はローカルで確認）・未公開。`heartbeatEnabled` が `true` のときだけ動く（**本番だけ**） |
| `ops-monitor.json` | 運用監視（TA-05 の項目 9・5。**開発環境だけ**） | スケジュール（5 分ごと・毎日 09:10） | 動作確認済み・未公開。`opsMonitorEnabled` が `true` のときだけ動く |

呼び出しの関係:

```
Mautic ──Webhook──▶ I-11 ──(顧客からの要求だけ)──────────▶ I-21 ──▶ SNS（開発は MailHog）
Chatwoot ─Webhook─▶ I-12 ──(会話の開始＝顧客の最初の公開メッセージ)─▶ I-21
                       └──(email があるとき)────────────▶ I-19 ──▶ Mautic の API ／ contact_link
週次の棚卸し ─(月曜 09:00)─▶ Chatwoot の API ─▶ I-21（lead。取得の失敗・回復は ops）
運用監視（開発）─(5 分・毎日)─▶ OpenSEO の health・sandbox-tls の期限 ─▶ I-21（ops。状態が変わったときだけ）
ハートビート ─(5 分ごと)─▶ CloudWatch の PutMetricData（I-21 は通らない。判定は CloudWatch のアラーム）
```

`I-11` `I-12` は **Webhook を受けたら、最初に署名を検証する**（次節）。検証を通ったら **先に 200 を返し**（`responseMode: responseNode`）、その後で重複排除と後続処理を行う。署名が合わなければ 401 を返してそこで止まる。重複でも 200 を返すので、上流が再送し続けることはない。後続（`I-21` `I-19`）の呼び出しは、**通知や突合が失敗しても Webhook の処理は止まらない**（`I-21` は `onError: continueRegularOutput`、`I-12` の `I-19` は `continueErrorOutput` で失敗を error 出力に流す）。失敗は呼ばれた側（`I-21` `I-19`）の実行履歴に残る（ADR-18。`E-15` の正本ではない）。

## Webhook の署名検証（`I-11` `I-12`）

どちらの Webhook も、n8n の Webhook ノードの認証は `none` で、**署名をワークフローの中で検証する**。Mautic は独自のヘッダーを付けられず、Chatwoot の署名は静的なトークンではないため、Webhook ノードの認証（Header Auth など）は使えない。

```
Webhook（Raw Body を binary で受ける）
  → 署名を計算（Crypto ノード。鍵は Crypto 資格情報）
  → 計算した署名と受け取った署名を、それぞれ SHA-256 にする
  → 一致するか（Chatwoot は時刻が 5 分以内かも見る）
       ├ 一致    → 200 を返す → 以降の処理
       └ 不一致・署名なし → 401 を返して止まる
```

| | `I-11`（Mautic） | `I-12`（Chatwoot） |
|---|---|---|
| ヘッダー | `Webhook-Signature` | `X-Chatwoot-Signature`（`sha256=` + 16 進）、`X-Chatwoot-Timestamp` |
| 署名の対象 | **生の本文**（Mautic の `json_encode` の結果そのまま）の HMAC-SHA256 を base64 にしたもの | **`{タイムスタンプ}.{生の本文}`** の HMAC-SHA256 |
| 鍵の出どころ | Mautic の Webhook の `Secret` | Chatwoot の Webhook ごとのシークレット（Webhook の編集画面で見られる。Chatwoot 4.12〔2026-03〕以降。`docker-compose.yaml` が `chatwoot/chatwoot:latest` なので、本番では版を固定すること） |
| リプレイの対策 | なし（署名の対象に時刻が無い。`dedup_mautic` が同じ本文の再送を 7 日は弾く） | タイムスタンプが 5 分より古い・新しいものは 401 |

**選んだ方式と理由。**

- 秘密値は **Crypto ノードの資格情報（`Hmac Secret`）** に置く。n8n 2.7 以降の Crypto ノード v2 は HMAC の鍵をノードのパラメーターではなく Crypto 資格情報から読むので、**ワークフローの JSON（Git に入るもの）に鍵が入らない**。
- **環境変数・ランナーの設定は要らない。** Code ノードで `crypto` を使う案は、`NODE_FUNCTION_ALLOW_BUILTIN=crypto` をタスクランナー側（`/etc/n8n-task-runners.json` の `env-overrides`）に足す必要があり、Code ノードは資格情報を読めないため鍵を渡すのに環境変数も要る（`N8N_BLOCK_ENV_ACCESS_IN_NODE` の緩和か、ランナーへの変数の受け渡し）。どちらも Code ノードに秘密値と任意のコードの実行権限を同居させるため避けた。**このため、`compose.yml`・SAM の n8n タスク定義への変更は不要。**
- **定数時間の比較は「両辺を SHA-256 にしてから比べる」で代える。** n8n の式・IF ノードには定数時間の比較が無い。攻撃者が送る署名は SHA-256 で撹拌されてから比べられるので、比較にかかる時間の差から署名を 1 バイトずつ当てることはできない。
- n8n 2.21 以降の **Mautic Trigger ノードは署名を自分で検証する**が、使わなかった。Webhook を Mautic に API で自動登録する（Mautic の API 資格情報で登録・削除する。OAuth2 は認可コード方式で、`mautic-mcp` の client_credentials と別になる）ため、運用側で管理している Mautic の設定と衝突する。Chatwoot には同等のノードが無く、2 本を同じ方式にそろえたかった。

**確認したこと・していないこと（開発の n8n）。**

- `test_workflow` で、**署名が正しい → 200 のあと後続の処理に進む／署名が違う → 401／署名ヘッダーなし → 401／Chatwoot で時刻が古い → 401** を確認した。HMAC を計算する Crypto ノードは資格情報を持つためテストでは固定値に差し替えており、**検証の分岐と SHA-256 の比較・Respond ノード・Raw Body を文字列に戻す処理**を実際に動かした。
- Crypto ノード（v1。鍵を直接指定する版）で、`binary` の HMAC（base64）と `{時刻}.{本文}` の HMAC（16 進）が **Python の計算結果と一致する**ことを確認した（日本語を含む本文）。**v2（資格情報を使う版）の実行と、実際の HTTP リクエスト（Raw Body の中身）は未確認**。資格情報の作成と公開（publish）が要るため、次の手順で人が確認する。

```bash
# 署名を作って 3 通り送る（N8N・シークレットは環境に合わせる。シークレットはシェルの履歴に残さない）
N8N=http://127.0.0.1:5678          # 開発。公開（publish）したワークフローの本番 URL（/webhook/...）に送る

# I-11（Mautic）
BODY='{"mautic.form_on_submit":[{"submission":{"id":1,"lead":{"id":1},"form":{"alias":"consult"}},"timestamp":"2026-10-04T10:00:00+09:00"}]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$MAUTIC_WEBHOOK_SECRET" -binary | base64)
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$N8N/webhook/mautic-event" -H 'Content-Type: application/json' -H "Webhook-Signature: $SIG" --data-binary "$BODY"     # 200
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$N8N/webhook/mautic-event" -H 'Content-Type: application/json' -H 'Webhook-Signature: AAAA' --data-binary "$BODY"   # 401
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$N8N/webhook/mautic-event" -H 'Content-Type: application/json' --data-binary "$BODY"                                # 401

# I-12（Chatwoot）
BODY='{"event":"conversation_created","id":1,"meta":{"sender":{"id":1}}}'
TS=$(date +%s)
SIG="sha256=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$CHATWOOT_WEBHOOK_SECRET" | sed 's/^.* //')"
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$N8N/webhook/chatwoot-event" -H 'Content-Type: application/json' -H "X-Chatwoot-Timestamp: $TS" -H "X-Chatwoot-Signature: $SIG" --data-binary "$BODY"   # 200
```

確認後は、確認用に作ったワークフローの実行履歴と `dedup_*` の行（`contactId` が 1、`displayId` が 1）を消し、必要がなければ公開を戻す。

**残るリスク。**

- **鍵が空の Crypto 資格情報を作ると、誰でも署名を作れる。** 鍵が空でないことは n8n のワークフローからは検査できない（資格情報は読めない）。資格情報を作るときに必ず値を入れる。
- **Mautic の署名には時刻が含まれない**ため、署名付きの本文を盗まれると再送できる。`dedup_mautic`（冪等キー）が同じイベントの再送を 7 日は弾くが、**8 日目以降の再送は通る**。経路の制限で守る（本番の Webhook の受け口は WireGuard のアドレスの 5680 だけに開き、WireGuard の EC2 のセキュリティグループは Mautic・Chatwoot のタスクからしか受けず、EC2 が masquerade するのでプロキシが見る送信元は 10.99.0.1 だけ。経路は WireGuard で暗号化される。ADR-21）。
- **Webhook の URL を知っているだけの攻撃者は、署名なしでは何も起こせない**が、リクエストを受けて SHA-256 を計算するところまでは動く（負荷）。本番は経路の制限と、プロキシの送信元の制限（WireGuard の EC2〈10.99.0.1〉だけ）と流量制限（全体で毎秒 20 件。`onprem/n8n/proxy/webhook-proxy.conf.template`）、開発は ngrok の外で公開しない運用で抑える。
- Chatwoot が古い版（4.12 より前）だと署名が付かないため、**常に 401 になる**（安全側に倒れる。通知が止まるので、版を確認する）。
- 署名を検証できるのは「本文」までで、**誰が（どの Mautic・Chatwoot が）送ったか**は鍵を共有している相手としか分からない。鍵を共有している系（ほかの Webhook）が増えたら、鍵は Webhook ごとに分ける。

## 各ワークフロー

### I-11 Mautic Webhook の受領と重複排除

- **目的**: Mautic のコンタクト系イベントを 1 件ずつに分け、重複を除いて、顧客からの要求だけを `I-21` に渡す。
- **トリガー**: Webhook `POST /webhook/mautic-event`（Mautic の Webhook に `Secret` を設定する）。Mautic 側で購読するイベントは、コンタクトの作成・更新、ポイント変更、セグメント変更（`mautic.lead_list_change`）、フォーム送信（`mautic.form_on_submit`）。会社のイベントなど、コンタクトに紐づかないものは読み飛ばす。
- **冪等キー**: **`contact_id` + イベント種別 + `timestamp`（秒）**。**`timestamp` が読めないイベントは、秒の代わりにイベントの中身のハッシュ（`h` + 16 進。cyrb53）を使う**（以前は受信時刻〈秒〉を入れていたため、秒をまたいだ再送が別のキーになり重複と見なせなかった。2026-10-07 に直した。`timestampSec` の列と通知の受付時刻は、読めないときは受信時刻のまま）。Data Table `dedup_mautic`、保持 7 日（毎日 03:00 に 7 日を過ぎた行を削除）。重複なら何もせず 200。
  - **DD-01 6.2 の「`contact_id` + `timestamp`」にイベント種別を足している。** Mautic は 1 回のフォーム送信で `lead_post_save`・`points_change`・`list_change`・`form_on_submit` を同じ秒に出す。種別がないと、先に届いたイベントが後続の `form_on_submit`（無料相談の通知）を重複と見なして落とす。本物の再送（同じ種別・同じ秒）はこれまでどおり弾く。キーは Code ノード「イベント分割とキー生成」の 1 行で戻せる。
- **通知する条件**（BA-04）: フォーム alias が `consult`（無料相談）→ `demo-requested`／セグメント `mql` に追加された → `mql`。**無料 DL（`source-dl`）は通知しない。**
- **署名の検証**: `Webhook-Signature` を検証し、合わなければ 401（上の「Webhook の署名検証」）。
- **必要な資格情報**: `Mautic Webhook 署名鍵（Crypto）`（種類は **Crypto**。`Hmac Secret` に、Mautic の Webhook の `Secret` と同じ値を入れる）。
- **Data Table**: `dedup_mautic`（`dedupKey` string／`contactId` number／`eventType` string／`timestampSec` number）。

### I-12 Chatwoot Webhook の受領と重複排除

- **目的**: Chatwoot の会話の作成と、顧客からのメッセージの受信を重複なく受け、会話の開始を `I-21` に、email があれば `I-19` に渡す。
- **会話の開始の通知は、顧客の最初の公開メッセージで行う**（2026-10-12 に変えた。以前は会話の作成〈`conversation_created`〉で通知していたが、faq-bot がウィジェットを開いただけで会話を作るようになったため。`docs/superpowers/specs/2026-10-12-faq-bot-welcome-design.md` の 5.1）。通知の枝は「冪等キーを記録 → 会話の開始か → 通知の印 `<display_id>|lead` が無い会話だけ通す → 印を記録 → `I-21`」。2 通目以降と再送は印で止まる。印も 7 日で消えるので、**7 日以上あいて再開した会話はもう一度通知する**。会話の作成は記録と突合だけ。
- **トリガー**: Webhook `POST /webhook/chatwoot-event`（Chatwoot の Webhook のシークレットを控える）。Chatwoot 側で購読するのは `conversation_created` と `message_created`。**顧客以外のメッセージ（担当者の返信・社内メモ・システムの活動）は読み飛ばす。**
- **冪等キー**: **`display_id` + `message_id`**。Data Table `dedup_chatwoot`、保持 7 日（毎日 03:05 に掃除）。会話の作成イベントにはメッセージ ID が無いので、その部分は固定の `conversation_created` を使う。**`message_created` で `body.id` が無い・`null` のイベントは読み飛ばす**（`String(undefined)` の `'undefined'` をキーにすると、同じ会話の ID の無いメッセージがすべて同じキーとして重複扱いになるため。Chatwoot は常に `id` を付けるので実害は小さい。2026-10-06 に直した）。**会話 ID は必ず `display_id`**（Webhook の `conversation.id`、会話イベントのトップレベルの `id`）。
- **突合（`I-19`）は冪等キーと別の印で重複を除く**（2026-10-07 に直した）。Code ノードから「通知の枝」（冪等キー → `I-21`）と「突合の枝」（email があるとき → 印 `<display_id>|<message_id>|match` が `dedup_chatwoot` に無いものだけ → `I-19`）に分かれ、**`I-19` が成功したときだけ印を記録する**。`I-19` が失敗した会話は、同じイベントの再送で突合だけをやり直す（Chatwoot 自身は失敗した Webhook を再送しないが、同じ会話の次の顧客のメッセージは別のイベントなので、そこでも突合される。通知は冪等キーで 1 回だけ。以前は冪等キーの記録の後に `I-19` を呼んでいたので、失敗した会話は再送しても突合をやり直せなかった）。印の行も 7 日で消える。`I-19` が何も返さない（`chatwootContactId` が無いなど突合できない入力）ときも印は記録しないので、再送のたびに `I-19` を呼ぶ（何も書かない）。
- **署名の検証**: `X-Chatwoot-Signature` と `X-Chatwoot-Timestamp` を検証し、合わない・5 分より古いときは 401。
- **必要な資格情報**: `Chatwoot Webhook 署名鍵（Crypto）`（種類は **Crypto**。`Hmac Secret` に、Chatwoot の Webhook のシークレットと同じ値を入れる）。
- **Data Table**: `dedup_chatwoot`（`dedupKey` string／`displayId` number／`messageId` string）。
- email は冪等キーの表にも通知にも載せない。`I-19` への入力としてワークフローの中だけを通る。

### I-19 Chatwoot と Mautic の email 突合

- **目的**: Chatwoot のコンタクトの email と、Mautic のコンタクトの email が**同じ人か**を突き合わせ、対応付けを記録する。**記録までで、統合（`chatwoot_merge_contacts`）は呼ばない**（統合は不可逆。人間の判断。DD-04 7.2）。
- **トリガー**: `I-12` から呼ばれる（入力は `chatwootContactId`・`displayId`・`email`）。
- **規則**: `lower(email)` の**完全一致だけ**。Mautic の検索結果（部分一致・あいまい一致を含みうる）から、`lower(email)` が完全一致するものだけを数える。1 件 → `matched`、0 件 → `unmatched`（エラーにしない）、2 件以上 → `ambiguous`（統合せず人間に返す）。
- **冪等キー**: 不要（完全一致の問い合わせは冪等。記録は `chatwootContactId` で upsert）。
- **記録先**: Data Table `contact_link`（`chatwootContactId` number／`displayId` number／`status` string／`mauticContactId` number〈なければ 0〉／`matchCount` number／`checkedAt` string）。**email は記録しない。**
- **必要な資格情報**: `Mautic API（client_credentials）`（種類は **OAuth2 API**。付与方式 Client Credentials。トークン URL は `<Mautic>/oauth/v2/token`。`mautic-mcp` と同じクライアントでよい）。
- **タイムアウト・再試行**: 30 秒（DD-01 7.2）。再試行は n8n のノード設定で 1 回（3 秒待つ）。DD-01 5.2 の分類ごとの回数（`unreachable` 2 回など）は n8n のノード設定では分けられないため、1 回に丸めている。
- **設定**: Data Table `ops_settings` の `mauticBaseUrl`（開発は `http://host.docker.internal:8000`、本番は `https://mkt.comegin.com`）。

### I-21 SNS への通知

- **目的**: 顧客からの要求（`lead`）と監視の検知（`ops`）を運用者のメールに届ける。**本番は Amazon SNS、開発は MailHog。**
- **トリガー**: サブワークフロー。入力は `channel`（`lead` / `ops`）・`kind`・`idLabel`・`id`・`company`・`sourcePath`・`receivedAtSec`・`state`・`detail`（任意）。`lead` は `I-11` `I-12` と週次の棚卸しから、`ops` は運用監視・週次の棚卸しの取得の失敗から呼ぶ（`detail` を使わない呼び出しは空にする）。
- **`detail`（任意）**: 件数・`display_id`・残り日数など、**個人情報を含まない値だけ**を呼び出し側が渡す。本文の「確認」の行の前に `内訳: ...` として 200 文字まで載る。**`detail` に email・氏名・問い合わせや会話の本文を入れない**（呼び出し側の責任。I-21 は中身を検査しない）。
- **トピック**: `lead` → `comegin-lead-alert`、`ops` → `comegin-ops-alert`。ARN は Data Table `ops_settings` の `snsTopicArnLead` / `snsTopicArnOps`（SAM の出力 `LeadAlertTopicArn` / `OpsAlertTopicArn` を人が写す）。
- **メッセージ**: **Subject は ASCII だけ**（範囲外の文字は `?` にして 99 文字以内）。形は `[comegin] lead: demo-requested (contact 1234)`／`[comegin] ops: <監視の項目> ng`。**本文に載せるのは種別・会社名・システム上の ID・流入記事のパス（クエリを除く）・受付時刻（JST）だけ。email・氏名・問い合わせ本文・会話本文は載せない**（DA-05 の 1.3）。`ops` には個人情報を一切載せない。
- **監視は状態が遷移したときだけ発行**（`ok → ng` と `ng → ok`）。前回の状態は Data Table `monitor_state`（`checkId` string／`state` string）。**発行に成功したあとに状態を保存する**ので、発行に失敗した場合は次の検知でもう一度発行を試みる。`ng` が続く間は発行しない（無料枠の月 1,000 通を守る）。状態の記録がない項目は `ok` とみなす。
- **冪等キー**: なし（Standard トピックは at-least-once。重複配信を許容する。DD-04 8.6）。
- **タイムアウト**: ワークフロー全体に **10 秒**（`executionTimeout`）。SNS の発行は再試行 1 回（3 秒待つ）。失敗しても呼び出し元（顧客対応）は止まらない。
- **配信先の切り替え**: Data Table `ops_settings` の `notifyBackend`。`sns` のときだけ SNS に発行し、未設定・それ以外は MailHog に送る（開発の既定）。**本番の n8n で `sns` にするのは人間の作業。**
- **必要な資格情報**:
  - 本番: `AWS SNS 発行（アクセスキー）`（種類は **AWS**。IAM ユーザー `comegin-<env>-onprem-n8n-sns` のアクセスキーとシークレットアクセスキー、リージョン `ap-northeast-1` を入れる。「システム資格情報」「AssumeRole」は使わない）。キーは人が発行して、本番の n8n の画面から入力する（RDS に暗号化されて保存される。`onprem/n8n/.env` には置かない）。
  - 開発: `MailHog SMTP（開発）`（種類は **SMTP**。Mautic の MailHog の SMTP。Host は `host.docker.internal`、Port は `1025`。`middleware/host-relay` の中継を通して届く）。
- **本番の AWS 認証（ADR-21）**: 本番の n8n はオンプレで動くので、ECS のタスクロールは使えない。**IAM ユーザーのアクセスキーで認証する。**
  - IAM ユーザー `comegin-<env>-onprem-n8n-sns` の権限は **2 つのトピック（`comegin-lead-alert` / `comegin-ops-alert`）への `sns:Publish` だけ**。キーは CloudFormation の出力に出ない。人が IAM のコンソールで発行する。
  - 前回の AssumeRole 用のロール（`comegin-<env>-n8n-sns-publisher`）と、`N8N_AWS_SYSTEM_CREDENTIALS_ACCESS_ENABLED` は要らない（n8n の環境変数にも置かない）。
  - 資格情報を作らない・キーを誤ると、`I-21` の SNS 発行は失敗する（`I-11` `I-12` は止まらず、失敗は `I-21` の実行履歴に残る）。
  - `ops_settings` の `snsTopicArnLead` / `snsTopicArnOps` には SAM の出力 `LeadAlertTopicArn` / `OpsAlertTopicArn` を写す。

### 週次 問い合わせの棚卸し（`weekly-inquiry-inventory.json`）

- **目的**: Chatwoot の「未割り当て」（`open` で担当者がいない）会話を毎週数え、`R3` に知らせる（TA-03 の週次、BA-04 の PDCA の週次）。**エージェントを使わない決定論的な処理として本番の n8n に残す**（ADR-17）。**読み取りだけ**で、顧客への返信・社内メモの作成はしない。
- **トリガー**: 毎週月曜 09:00（JST。cron `0 9 * * 1`）。
- **「未対応」の定義（`R3` の決定。2026-10-06）**: `status=open` で担当者のいない会話だけ。担当者がいる会話（返信待ちを含む）、`pending`（ボットの対応中）・`snoozed`・`resolved` は数えない。0 件のときは通知しない。
- **条件**: `ops_settings` の `inventoryEnabled` が `true`。行が無い・それ以外なら何もしない。
- **中身**: Chatwoot の `GET /api/v1/accounts/{id}/conversations`（`status=open`・`assignee_type=unassigned`・`sort_by=waiting_since_asc` の 1 回）。件数は応答の `meta.unassigned_count`（全ページの総数）、最も長い待ちは 1 ページ目（25 件）の `waiting_since` の最小値、`display_id` は応答の `id`（先頭 10 件）。ページは進めない（`R3` の決定）。
- **通知**: `I-21` の `lead`（`kind=weekly-inventory`）。件名 `[comegin] lead: weekly-inventory (unassigned 12)`、本文の「内訳」に `未割り当て 12 件／最も長い待ち 53 時間／未割り当ての会話 #101 #102 ... ほか`。**0 件のときは通知しない**（生きていることはハートビートで見る。毎週のメールを出さない）。**氏名・email・会話の本文は読まず、載せない。**
- **失敗**: Chatwoot が応答しない・トークンが無効のときは `I-21` の `ops`（`kind=weekly-inventory:fetch`。`ok → ng` のときだけ 1 通。回復も 1 通）。
- **必要な資格情報**: `Chatwoot API（api_access_token）`（種類は **Header Auth**。Name `api-access-token`〈ハイフン。本番の ALB がアンダースコアのヘッダーを捨てるため〉）。`ops_settings` の `chatwootBaseUrl`・`chatwootAccountId`。
- **実行履歴**: 成功した実行のデータは保存しない。**失敗した実行には Chatwoot の応答（コンタクトの名前・メールを含みうる）が 90 日残る**（`I-11` `I-12` と同じ残り方。DA-05 の未決定事項）。
- **確認したこと**: `test_workflow`（Chatwoot の応答はピン留め）で、集計・通知（MailHog に届いた件名と本文を確認）・0 件のとき通知しない・取得失敗で `ng`・回復で `ok` を確認した。**実際の Chatwoot への接続（中継 3100 とトークン）と、本番の `chat.comegin.com` への到達は未確認。**

### n8n のスケジュール実行のハートビート（`n8n-schedule-heartbeat.json`）

- **目的**: 本番の n8n（オンプレ）の定期実行が止まったことを、n8n の外（CloudWatch のアラーム）で知る（TA-05 の項目 3）。**判定は n8n の外で行う**（n8n が止まっても気づけるように）。
- **トリガー**: 5 分ごと。**条件**: `ops_settings` の `heartbeatEnabled` が `true`（**本番だけ**。既定は `false`）。
- **送るもの**: CloudWatch の `PutMetricData`（Query API。`POST https://monitoring.ap-northeast-1.amazonaws.com/`、`Version=2010-08-01`）。**名前空間 `ComeGin/OnpremN8n`（`ops_settings` の `heartbeatNamespace`）・メトリクス `ScheduleHeartbeat`・値 1・単位 `Count`・ディメンションなし**。綴りが IAM の条件（`cloudwatch:namespace`）と違うと `AccessDenied`（cloud の `iam.yaml`・`observability.yaml`）。
- **認証**: 資格情報 `AWS SNS 発行（アクセスキー）` を HTTP Request の **Predefined Credential Type（AWS）** で使い回す（IAM ユーザーは同じ。権限は SNS の発行と、名前空間つきの `PutMetricData`）。サービス（`monitoring`）とリージョンは URL から導かれて署名される。
- **本文はフォーム（`application/x-www-form-urlencoded`）で渡す。** AWS の資格情報は、本文が JSON のオブジェクトだと `JSON.stringify` して署名するため、実際に送る本文と食い違う。
- **実行履歴**: 成功した実行は保存しない（5 分ごと＝1 日 288 回。保存すると 90 日で約 2.6 万件になる）。失敗は保存する。失敗を握りつぶさない（判定は CloudWatch）。
- **確認したこと**: 動いている n8n（2.39.5）で、HTTP Request ノードが作る形（`uri`＋`form`）で AWS 資格情報の署名を呼び、サービス `monitoring`・`ap-northeast-1` で署名されること、**実際に送る本文・`content-length`・`content-type` が署名した内容と一致すること**（宛先をコンテナ内の一時的な HTTP サーバーにして確認。AWS には送っていない）を確認した。`heartbeatEnabled` の `true`／`false` で CloudWatch のノードに進む／進まないことも確認した。**AWS への実際の送信（IAM・名前空間の綴り・アラームの動き）は、AWS のデプロイ後の実機で確認する。**

### 運用監視（`ops-monitor.json`。**開発環境の n8n だけ**）

- **目的**: 開発環境のサービスのうち、止まっても誰も困らないまま改善ループを止めるものを見張る（TA-05 の項目 9・5）。**本番には取り込まない**（OpenSEO も `sandbox-tls` も本番に無い）。
- **条件**: `ops_settings` の `opsMonitorEnabled` が `true`。状態が変わったとき（`ok ↔ ng`）だけ `I-21` の `ops` が 1 通出す（無料枠を守る。DD-04 の 8.5）。
- **項目 9（5 分ごと）**: `GET http://host.docker.internal:3001/api/health`（中継は `GET /api/health` だけを通す）。`ng` は、つながらない・HTTP エラー・`status` が `ok` 以外。`kind=ops-monitor:9`。通知の「内訳」には `checks` のうち `error` の項目名（`dataforseo`・`database` など）だけを載せる。**GSC の未接続は見ない**（項目 10 はエージェントの `E-12`）。
- **項目 5（毎日 09:10）: `sandbox-tls` の証明書の期限。** `middleware/n8n/compose.yml` が、`sandbox-certs` の作った証明書のうち**公開部分（`*.crt`）だけ**を `/tls/public` にコピーし、n8n には **`public/` だけを読み取り専用で `/home/node/.n8n-files/sandbox-tls` にマウント**する（秘密鍵は渡さない）。n8n 2.0 以降 `Read/Write Files from Disk` は既定で `~/.n8n-files` の下しか読めないため。ワークフローはそれを読み、**Code ノード（外部ランナー。`require` を使わず `Buffer` だけ）で X.509 の `notAfter`（DER の連続する 2 つの UTCTime の 2 つ目）を取り出し**、4 つの葉の証明書の最短の残り日数を出す。**残り 30 日未満、または 1 つも読めないときは `ng`**（`kind=ops-monitor:5`）。30 日は案。実機で 4 つとも読めて、`2028-12-19`（残り 804 日）と出ることを確認した。`ng` のときは `sandbox-tls` ボリュームを作り直す（`middleware/n8n/README.md` の「証明書の更新」）。
- **確認したこと**: 項目 9 は、n8n のコンテナから中継経由で OpenSEO の health に実際に届き、応答の形（`status`・`checks`）が想定どおりであること、`ng`（`dataforseo` が `error`）で 1 通・`ok` に戻して 1 通出ることを確認した。項目 5 は実機の証明書で `ok` を確認した。

### I-18 Mautic から PostHog への書き戻し（**前提待ち**）

- **作るが無効のまま。** PostHog（米国）への越境の可否（DA-03・DA-05 の未決定事項。判断者 `R1`）が決まるまで実装しない。冪等キーの形も決めない（email のハッシュも個人データとして越境しうるため、キー設計自体が越境の判断に依存する。DD-01 6.2・DD-04 6.1）。
- この JSON は **Webhook を受けて何もしない骨格**で、PostHog への送信ノードを持たない。誤って有効化しても何も越境しない。有効化は `config_change`（承認者 `R1`）。

## 開発の n8n で動かす前の準備

**取り込みのチェックリスト（人が行う。有効化は `R1`）**

- [ ] Data Table 5 つ（`dedup_mautic` `dedup_chatwoot` `ops_settings` `monitor_state` `contact_link`）を作り直し、`ops_settings` に行を入れる（JSON に含まれない）
- [ ] `I-11` `I-12` の「I-21 通知を呼ぶ」「I-19 突合を呼ぶ」ノードで、呼び先のワークフローを選び直す（ワークフロー ID は n8n ごとに違う）
- [ ] 定期実行の 3 本（`weekly-inquiry-inventory`・`n8n-schedule-heartbeat`・`ops-monitor`〈開発だけ〉）を取り込む。**公開しない**（スイッチも `false`）。公開は GUIDE.md の 9.7
- [ ] 資格情報を作って各ノードに割り当てる: `MailHog SMTP（開発）`（SMTP）／`Mautic API（client_credentials）`（OAuth2 API）／`Mautic Webhook 署名鍵（Crypto）`／`Chatwoot Webhook 署名鍵（Crypto）`（署名鍵は **Hmac Secret を必ず入れる**）。`AWS SNS 発行（アクセスキー）`（本番は本物のキー。SNS とハートビートの両方に使う。開発は公開の検査を通すためのダミーでよい。provision が作る）／`Chatwoot API（api_access_token）`（Header Auth。棚卸しが使う）
- [ ] 署名の curl 確認（下記）を済ませてから、**人間（`R1`）が有効化（publish）する**。エージェントは有効化しない。開発の n8n は ngrok で外に出ているため、確認のための公開は Wave 4 でユーザーが立ち会って行い、済んだら戻す

1. **Data Table を作る**（Data Table は Git の外にあり、JSON に含まれない。DD-04 4.3）。スキーマは上の各節のとおり。`ops_settings`（`key` string／`value` string）には次の行を入れる。

   | key | value |
   |---|---|
   | `notifyBackend` | `mailhog`（本番は `sns`） |
   | `mauticBaseUrl` | 開発 `http://host.docker.internal:8000` ／ 本番 `https://mkt.comegin.com` |
   | `snsTopicArnLead` / `snsTopicArnOps` | 本番だけ。SAM の出力の ARN |
   | `chatwootBaseUrl` / `chatwootAccountId` | 開発 `http://host.docker.internal:3100`／本番 `https://chat.comegin.com`、アカウントの ID（週次の棚卸し） |
   | `inventoryEnabled` / `heartbeatEnabled` / `opsMonitorEnabled` | **`false`**。定期実行のスイッチ。`true` にするのは人（provision は、行が無いときだけ入れ、既にある値を戻さない） |
   | `heartbeatNamespace` | `ComeGin/OnpremN8n` |

2. **JSON を取り込む**（画面の操作は [GUIDE.md の 7 節](GUIDE.md)）。取り込み後、次を人が設定する（資格情報の値は JSON に含まれない。画面の操作は GUIDE.md の 8 節）。
   - `I-11` `I-12` の「I-21 通知を呼ぶ」「I-19 突合を呼ぶ」ノードのワークフローの選択（**ワークフロー ID は n8n ごとに違う**。JSON に書いてあるのは書き出し元の開発の n8n の ID）。
   - `I-11` の `Mautic Webhook 署名鍵（Crypto）`、`I-12` の `Chatwoot Webhook 署名鍵（Crypto）`（どちらも **Hmac Secret を必ず入れる**）。`I-19` の `Mautic API（client_credentials）`、`I-21` の `MailHog SMTP（開発）` / `AWS SNS 発行（アクセスキー）`。
   - 各ワークフローの設定（`I-11` `I-12` `I-19` は成功した実行のデータを保存しない。メールアドレスが実行履歴に残るのを避けるため。`I-21` は 10 秒のタイムアウト）。タグは `I-21` に `subworkflow` `notification`、`I-19` に `subworkflow` `matching`、`I-18` に `blocked`。
3. Mautic・Chatwoot の Webhook の送信先を `<n8n>/webhook/mautic-event` / `<n8n>/webhook/chatwoot-event` に向ける（各製品の管理画面での操作は [GUIDE.md の 9.3](GUIDE.md)）。**開発環境では** Mautic（ホストで動く）は `http://127.0.0.1:5678/webhook/mautic-event`、Chatwoot（コンテナで動く）は `http://host.docker.internal:5678/webhook/chatwoot-event`（`middleware/host-relay` の中継を通す。開発の n8n から Mautic・MailHog に届くのも同じ中継による）。**本番の送信先（ADR-21。人が各製品の管理画面で設定する）:**
   - Mautic: `http://10.99.0.2:5680/webhook/mautic-event`
   - Chatwoot: `http://10.99.0.2:5680/webhook/chatwoot-event`

   `10.99.0.2:5680` はオンプレの Webhook の受け口（WireGuard 越し。`onprem/README.md`）。ワークフローが公開（publish）されるまで、この URL は 404 を返す。**有効化（publish）は人間が行う。**

## 動作確認の手順（開発）

- テストの Webhook は、n8n のエディターから「ワークフローをテスト」で実行する（Test URL は `/webhook-test/...`）。本番 URL は有効化するまで動かない。
- 同じ本文を 2 回送ると、2 回目は「冪等キーを記録」まで進まない（`dedup_*` に行が増えない）ことで重複排除を確認できる。
- 通知は MailHog（`http://127.0.0.1:8025`）で受信を確認する。**SMTP の資格情報を作る前は `I-21` が失敗する。このとき `I-11` `I-12` は止まらず、失敗は `I-21` の実行履歴に残る**（意図した動作）。
- 動作確認で入れた行（`contactId` / `displayId` が 99 万台のもの、`checkId` が `test-check-990`）は、`dedup_*` は 7 日で消える。`monitor_state` と `contact_link` は掃除しないので、必要なら n8n の画面で消す。

## 未実装・要確認

- **週次の棚卸しの記録先が無い。** 件数は I-21 のメールにだけ出て、`E-12` にも Data Table にも残らない（推移を見る手段が無い）。
- **ハートビートの実機（AWS）が未確認。** 本文・署名はローカルで確認したが、IAM の名前空間の条件・アラームの発火と復旧は AWS のデプロイ後に確かめる（`cloud/README.md` の 5 節）。
- **失敗した実行の記録に、Chatwoot の応答（コンタクトの名前・メール）が残りうる**（棚卸し）。成功した実行は保存しない設定だが、失敗は保存される。DA-05 の「n8n の実行履歴に残る個人情報」の未決定事項（インスタンス全体で `EXECUTIONS_DATA_SAVE_ON_SUCCESS` を `none` にするか、失敗の保存をどうするか）と同じ論点。
- **実行履歴は 90 日で消える**（`EXECUTIONS_DATA_PRUNE=true`・`EXECUTIONS_DATA_MAX_AGE=2160`〈時間〉・`EXECUTIONS_DATA_PRUNE_MAX_COUNT=50000`。開発の `compose.yml` と `onprem/n8n/compose.yml`）。件数の上限は n8n の既定（10,000）が 90 日に届く前に効いてしまうため上げた。

- **署名検証の実機確認（資格情報を作って公開したあとの HTTP）が未了。** 上の「Webhook の署名検証」の curl の手順で、人が確認する。**開発の n8n は ngrok で外に出ているため、確認が済んだら公開（publish）を戻す。**
- **`I-19` の記録先が Data Table（`contact_link`）である。** DD-04 7 は観測点を `E-12`（`source: chatwoot`）としているが、`E-12` は Git のファイルで、n8n からは書けない。突合できた件数・できなかった件数を `E-12` に取り込む経路（エージェントが `contact_link` を読む手段）は決まっていない。
- **`I-21` の本文の日本語が配信で文字化けしないかを実地確認していない**（DD-04 8.2。実際の SNS 配信は AWS への書き込みを伴うため、ここでは行っていない）。
- `I-21` の `ops` を呼ぶのは、`ops-monitor`（`ops-monitor:9`・`ops-monitor:5`）と週次の棚卸しの取得の失敗（`weekly-inventory:fetch`）。呼び方は `channel=ops`・`kind=<監視の項目>`・`state=ok|ng`。TA-05 のほかの項目（1・2・6・7 など）は未実装。
- 本番の n8n（オンプレ）・WireGuard・Webhook の受け口のどれかが止まっている間（オンプレのマシンの停止を含む）に届く Webhook は取りこぼされる（DD-04 11 節の未決定事項のまま。ADR-21 の帰結）。
