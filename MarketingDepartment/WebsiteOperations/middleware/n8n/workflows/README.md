# n8n ワークフロー（Git 管理）

`middleware/n8n` の n8n に置くワークフローの JSON。設計の出典は `docs/DetailedDesign/04-server-to-server-flows.md`（4〜8 節）と `01-flow-specification-rules.md`（5〜7 節）。

**この JSON は「開発の n8n で組んで動作確認したものの書き出し」である。** 本番の n8n への取り込み・資格情報の割り当て・**有効化（publish）は人間（`R1`）が行う**。エージェントからは有効化に到達させない（`n8n-prod` の MCP は作成・更新まで。DD-04 6.2）。

**本番の n8n はオンプレで動く（ADR-21。`onprem/n8n`）。** データ（ワークフロー・資格情報・実行履歴）は AWS の RDS の `n8n` データベースにある。エディター・API・MCP は `127.0.0.1:5679`（`n8n-prod` の接続先）。クラウドの Mautic・Chatwoot の Webhook は、WireGuard 越しにリバースプロキシ（`http://10.99.0.2:5680`。`/webhook/*` の POST だけを n8n に通す）に届く。本番には開発のサンドボックスを置かない。ここにある JSON はどれも `"active": false` で、書き出し時点で公開（publish）されたものは 1 本もない。

## 一覧

| ファイル | 連携 | 種類 | 状態 |
|---|---|---|---|
| `I-11-mautic-webhook-dedup.json` | `I-11` Mautic → n8n | Webhook（`POST /webhook/mautic-event`） | 動作確認済み・未公開 |
| `I-12-chatwoot-webhook-dedup.json` | `I-12` Chatwoot → n8n | Webhook（`POST /webhook/chatwoot-event`） | 動作確認済み・未公開 |
| `I-19-email-match.json` | `I-19` Chatwoot と Mautic の email 突合 | サブワークフロー（`I-12` から呼ばれる） | 動作確認済み（Mautic の応答はピン留め）・未公開 |
| `I-21-sns-notify.json` | `I-21` n8n → Amazon SNS（開発は MailHog） | サブワークフロー（`I-11` `I-12` と監視から呼ばれる） | 動作確認済み（配信ノードはピン留め）・未公開 |
| `I-18-posthog-writeback.json` | `I-18` Mautic → PostHog の書き戻し | Webhook の骨格 | **前提待ち。何も送信しない骨格で、有効化しない**（下の「I-18」） |

呼び出しの関係:

```
Mautic ──Webhook──▶ I-11 ──(顧客からの要求だけ)──────────▶ I-21 ──▶ SNS（開発は MailHog）
Chatwoot ─Webhook─▶ I-12 ──(会話の開始)──────────────────▶ I-21
                       └──(email があるとき)────────────▶ I-19 ──▶ Mautic の API ／ contact_link
```

`I-11` `I-12` は **Webhook を受けたら、最初に署名を検証する**（次節）。検証を通ったら **先に 200 を返し**（`responseMode: responseNode`）、その後で重複排除と後続処理を行う。署名が合わなければ 401 を返してそこで止まる。重複でも 200 を返すので、上流が再送し続けることはない。後続（`I-21` `I-19`）の呼び出しは `onError: continueRegularOutput` で、**通知や突合が失敗しても Webhook の処理は止まらない**。失敗は呼ばれた側（`I-21` `I-19`）の実行履歴に残る（ADR-18。`E-15` の正本ではない）。

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
- **冪等キー**: **`contact_id` + イベント種別 + `timestamp`（秒）**。Data Table `dedup_mautic`、保持 7 日（毎日 03:00 に 7 日を過ぎた行を削除）。重複なら何もせず 200。
  - **DD-01 6.2 の「`contact_id` + `timestamp`」にイベント種別を足している。** Mautic は 1 回のフォーム送信で `lead_post_save`・`points_change`・`list_change`・`form_on_submit` を同じ秒に出す。種別がないと、先に届いたイベントが後続の `form_on_submit`（無料相談の通知）を重複と見なして落とす。本物の再送（同じ種別・同じ秒）はこれまでどおり弾く。キーは Code ノード「イベント分割とキー生成」の 1 行で戻せる。
- **通知する条件**（BA-04）: フォーム alias が `consult`（無料相談）→ `demo-requested`／セグメント `mql` に追加された → `mql`。**無料 DL（`source-dl`）は通知しない。**
- **署名の検証**: `Webhook-Signature` を検証し、合わなければ 401（上の「Webhook の署名検証」）。
- **必要な資格情報**: `Mautic Webhook 署名鍵（Crypto）`（種類は **Crypto**。`Hmac Secret` に、Mautic の Webhook の `Secret` と同じ値を入れる）。
- **Data Table**: `dedup_mautic`（`dedupKey` string／`contactId` number／`eventType` string／`timestampSec` number）。

### I-12 Chatwoot Webhook の受領と重複排除

- **目的**: Chatwoot の会話の作成と、顧客からのメッセージの受信を重複なく受け、会話の開始を `I-21` に、email があれば `I-19` に渡す。
- **トリガー**: Webhook `POST /webhook/chatwoot-event`（Chatwoot の Webhook のシークレットを控える）。Chatwoot 側で購読するのは `conversation_created` と `message_created`。**顧客以外のメッセージ（担当者の返信・社内メモ・システムの活動）は読み飛ばす。**
- **冪等キー**: **`display_id` + `message_id`**。Data Table `dedup_chatwoot`、保持 7 日（毎日 03:05 に掃除）。会話の作成イベントにはメッセージ ID が無いので、その部分は固定の `conversation_created` を使う。**会話 ID は必ず `display_id`**（Webhook の `conversation.id`、会話イベントのトップレベルの `id`）。
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
- **トリガー**: サブワークフロー。入力は `channel`（`lead` / `ops`）・`kind`・`idLabel`・`id`・`company`・`sourcePath`・`receivedAtSec`・`state`。`lead` は `I-11` `I-12` から、`ops` は監視（TA-05。未実装）から呼ぶ。
- **トピック**: `lead` → `comegin-lead-alert`、`ops` → `comegin-ops-alert`。ARN は Data Table `ops_settings` の `snsTopicArnLead` / `snsTopicArnOps`（SAM の出力 `LeadAlertTopicArn` / `OpsAlertTopicArn` を人が写す）。
- **メッセージ**: **Subject は ASCII だけ**（範囲外の文字は `?` にして 99 文字以内）。形は `[comegin] lead: demo-requested (contact 1234)`／`[comegin] ops: <監視の項目> ng`。**本文に載せるのは種別・会社名・システム上の ID・流入記事のパス（クエリを除く）・受付時刻（JST）だけ。email・氏名・問い合わせ本文・会話本文は載せない**（DA-05 の 1.3）。`ops` には個人情報を一切載せない。
- **監視は状態が遷移したときだけ発行**（`ok → ng` と `ng → ok`）。前回の状態は Data Table `monitor_state`（`checkId` string／`state` string）。**発行に成功したあとに状態を保存する**ので、発行に失敗した場合は次の検知でもう一度発行を試みる。`ng` が続く間は発行しない（無料枠の月 1,000 通を守る）。状態の記録がない項目は `ok` とみなす。
- **冪等キー**: なし（Standard トピックは at-least-once。重複配信を許容する。DD-04 8.6）。
- **タイムアウト**: ワークフロー全体に **10 秒**（`executionTimeout`）。SNS の発行は再試行 1 回（3 秒待つ）。失敗しても呼び出し元（顧客対応）は止まらない。
- **配信先の切り替え**: Data Table `ops_settings` の `notifyBackend`。`sns` のときだけ SNS に発行し、未設定・それ以外は MailHog に送る（開発の既定）。**本番の n8n で `sns` にするのは人間の作業。**
- **必要な資格情報**:
  - 本番: `AWS SNS 発行（アクセスキー）`（種類は **AWS**。IAM ユーザー `comegin-<env>-onprem-n8n-sns` のアクセスキーとシークレットアクセスキー、リージョン `ap-northeast-1` を入れる。「システム資格情報」「AssumeRole」は使わない）。キーは人が発行して、本番の n8n の画面から入力する（RDS に暗号化されて保存される。`onprem/n8n/.env` には置かない）。
  - 開発: `MailHog SMTP（開発）`（種類は **SMTP**。ホストの MailHog〈1025〉。n8n のコンテナから届く名前にする）。
- **本番の AWS 認証（ADR-21）**: 本番の n8n はオンプレで動くので、ECS のタスクロールは使えない。**IAM ユーザーのアクセスキーで認証する。**
  - IAM ユーザー `comegin-<env>-onprem-n8n-sns` の権限は **2 つのトピック（`comegin-lead-alert` / `comegin-ops-alert`）への `sns:Publish` だけ**。キーは CloudFormation の出力に出ない。人が IAM のコンソールで発行する。
  - 前回の AssumeRole 用のロール（`comegin-<env>-n8n-sns-publisher`）と、`N8N_AWS_SYSTEM_CREDENTIALS_ACCESS_ENABLED` は要らない（n8n の環境変数にも置かない）。
  - 資格情報を作らない・キーを誤ると、`I-21` の SNS 発行は失敗する（`I-11` `I-12` は止まらず、失敗は `I-21` の実行履歴に残る）。
  - `ops_settings` の `snsTopicArnLead` / `snsTopicArnOps` には SAM の出力 `LeadAlertTopicArn` / `OpsAlertTopicArn` を写す。

### I-18 Mautic から PostHog への書き戻し（**前提待ち**）

- **作るが無効のまま。** PostHog（米国）への越境の可否（DA-03・DA-05 の未決定事項。判断者 `R1`）が決まるまで実装しない。冪等キーの形も決めない（email のハッシュも個人データとして越境しうるため、キー設計自体が越境の判断に依存する。DD-01 6.2・DD-04 6.1）。
- この JSON は **Webhook を受けて何もしない骨格**で、PostHog への送信ノードを持たない。誤って有効化しても何も越境しない。有効化は `config_change`（承認者 `R1`）。

## 開発の n8n で動かす前の準備

**取り込みのチェックリスト（人が行う。有効化は `R1`）**

- [ ] Data Table 5 つ（`dedup_mautic` `dedup_chatwoot` `ops_settings` `monitor_state` `contact_link`）を作り直し、`ops_settings` に行を入れる（JSON に含まれない）
- [ ] `I-11` `I-12` の「I-21 通知を呼ぶ」「I-19 突合を呼ぶ」ノードで、呼び先のワークフローを選び直す（ワークフロー ID は n8n ごとに違う）
- [ ] 資格情報を作って各ノードに割り当てる: `MailHog SMTP（開発）`（SMTP）／`Mautic API（client_credentials）`（OAuth2 API）／`Mautic Webhook 署名鍵（Crypto）`／`Chatwoot Webhook 署名鍵（Crypto）`（署名鍵は **Hmac Secret を必ず入れる**）。本番はさらに `AWS SNS 発行（アクセスキー）`
- [ ] 署名の curl 確認（下記）を済ませてから、**人間（`R1`）が有効化（publish）する**。エージェントは有効化しない。開発の n8n は ngrok で外に出ているため、確認のための公開は Wave 4 でユーザーが立ち会って行い、済んだら戻す

1. **Data Table を作る**（Data Table は Git の外にあり、JSON に含まれない。DD-04 4.3）。スキーマは上の各節のとおり。`ops_settings`（`key` string／`value` string）には次の行を入れる。

   | key | value |
   |---|---|
   | `notifyBackend` | `mailhog`（本番は `sns`） |
   | `mauticBaseUrl` | 開発 `http://host.docker.internal:8000` ／ 本番 `https://mkt.comegin.com` |
   | `snsTopicArnLead` / `snsTopicArnOps` | 本番だけ。SAM の出力の ARN |

2. **JSON を取り込む**。取り込み後、次を人が設定する（資格情報の値は JSON に含まれない）。
   - `I-11` `I-12` の「I-21 通知を呼ぶ」「I-19 突合を呼ぶ」ノードのワークフローの選択（**ワークフロー ID は n8n ごとに違う**。JSON に書いてあるのは書き出し元の開発の n8n の ID）。
   - `I-11` の `Mautic Webhook 署名鍵（Crypto）`、`I-12` の `Chatwoot Webhook 署名鍵（Crypto）`（どちらも **Hmac Secret を必ず入れる**）。`I-19` の `Mautic API（client_credentials）`、`I-21` の `MailHog SMTP（開発）` / `AWS SNS 発行（アクセスキー）`。
   - 各ワークフローの設定（`I-11` `I-12` `I-19` は成功した実行のデータを保存しない。メールアドレスが実行履歴に残るのを避けるため。`I-21` は 10 秒のタイムアウト）。タグは `I-21` に `subworkflow` `notification`、`I-19` に `subworkflow` `matching`、`I-18` に `blocked`。
3. Mautic・Chatwoot の Webhook の送信先を `<n8n>/webhook/mautic-event` / `<n8n>/webhook/chatwoot-event` に向ける。**本番の送信先（ADR-21。人が各製品の管理画面で設定する）:**
   - Mautic: `http://10.99.0.2:5680/webhook/mautic-event`
   - Chatwoot: `http://10.99.0.2:5680/webhook/chatwoot-event`

   `10.99.0.2:5680` はオンプレの Webhook の受け口（WireGuard 越し。`onprem/README.md`）。ワークフローが公開（publish）されるまで、この URL は 404 を返す。**有効化（publish）は人間が行う。**

## 動作確認の手順（開発）

- テストの Webhook は、n8n のエディターから「ワークフローをテスト」で実行する（Test URL は `/webhook-test/...`）。本番 URL は有効化するまで動かない。
- 同じ本文を 2 回送ると、2 回目は「冪等キーを記録」まで進まない（`dedup_*` に行が増えない）ことで重複排除を確認できる。
- 通知は MailHog（`http://127.0.0.1:8025`）で受信を確認する。**SMTP の資格情報を作る前は `I-21` が失敗する。このとき `I-11` `I-12` は止まらず、失敗は `I-21` の実行履歴に残る**（意図した動作）。
- 動作確認で入れた行（`contactId` / `displayId` が 99 万台のもの、`checkId` が `test-check-990`）は、`dedup_*` は 7 日で消える。`monitor_state` と `contact_link` は掃除しないので、必要なら n8n の画面で消す。

## 未実装・要確認

- **署名検証の実機確認（資格情報を作って公開したあとの HTTP）が未了。** 上の「Webhook の署名検証」の curl の手順で、人が確認する。**開発の n8n は ngrok で外に出ているため、確認が済んだら公開（publish）を戻す。**
- **`I-19` の記録先が Data Table（`contact_link`）である。** DD-04 7 は観測点を `E-12`（`source: chatwoot`）としているが、`E-12` は Git のファイルで、n8n からは書けない。突合できた件数・できなかった件数を `E-12` に取り込む経路（エージェントが `contact_link` を読む手段）は決まっていない。
- **`I-21` の本文の日本語が配信で文字化けしないかを実地確認していない**（DD-04 8.2。実際の SNS 配信は AWS への書き込みを伴うため、ここでは行っていない）。
- **`I-21` の `ops`（監視）側を呼ぶワークフローはまだ無い**（TA-05 の監視項目の実装待ち）。呼び方は `channel=ops`・`kind=<監視の項目>`・`state=ok|ng`。
- 本番の n8n（オンプレ）・WireGuard・Webhook の受け口のどれかが止まっている間（オンプレのマシンの停止を含む）に届く Webhook は取りこぼされる（DD-04 11 節の未決定事項のまま。ADR-21 の帰結）。
