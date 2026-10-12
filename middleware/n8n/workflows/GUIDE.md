# n8n ワークフローの手順書（はじめての人向け）

このフォルダの JSON（8 本のワークフロー）を、n8n に取り込んで動かすまでの手順。**n8n を一度も触ったことがない人**が、上から順に進めれば終わるように書いた。設計の背景や細かい仕様は [README.md](README.md) にある（この手順書と食い違ったら README が正しい）。

画面の名前は n8n 2.39 の英語表示に合わせている（日本語化していない既定の表示）。

> **近道: 5〜9 節はスクリプトでまとめてできる。** バックエンド全体をまとめて用意するなら [`setup/`](../../../setup/README.md) の `node setup/setup.mjs --target dev`（n8n の管理者・API キーの作成も含む。下の provision はその中で呼ばれる）。n8n だけなら [`../provision/`](../provision/README.md) の `node provision.mjs --target dev` が、Data Table・資格情報・取り込み・呼び出し先の付け替え・Mautic と Chatwoot の Webhook・子の公開を 1 回で行う（シークレットのコピーも要らない）。人がやるのは、n8n の管理者と API キーの作成、Mautic と Chatwoot のトークンを設定ファイルに書くことだけ。**この手順書は、スクリプトが何をしているかを知りたいとき、画面で直したいとき、スクリプトが失敗したときに読む。**

---

## 1. まず知っておく言葉

| 言葉 | 意味 |
|---|---|
| **ワークフロー**（Workflow） | 「何かが起きたら、これとこれをする」という処理の流れ。n8n の画面では、箱（ノード）を線でつないだ図になる |
| **ノード**（Node） | 処理の 1 つ 1 つの箱。「Webhook を受ける」「表に書く」「メールを送る」など |
| **トリガー**（Trigger） | ワークフローを動かすきっかけになる最初のノード。ここでは **Webhook**（外からの HTTP の呼び出し）・**スケジュール**（決めた時刻・間隔）・**他のワークフローから呼ばれる**（サブワークフロー）の 3 種類 |
| **サブワークフロー** | 他のワークフローから呼ばれる部品のワークフロー。ここでは `I-21`（通知）と `I-19`（突き合わせ）がそれ |
| **資格情報**（Credential） | パスワードや API のキーなどの秘密の値を、n8n の中に安全にしまっておく場所。**ワークフローの JSON には入らない**ので、取り込んだ後に自分で作る |
| **Data Table** | n8n の中にある、小さな表（スプレッドシートのようなもの）。重複のチェックや設定の保存に使う。**JSON には入らない**ので、自分で作る |
| **公開**（Publish） | ワークフローを「本番で動く状態」にすること。公開するまで、本番の Webhook の URL は反応しない |
| **テスト URL と本番 URL** | Webhook には 2 つの URL がある。テスト URL（`/webhook-test/...`）は画面で「待ち受け」を押してから 120 秒だけ反応し、結果が画面に出る。本番 URL（`/webhook/...`）は公開してから反応し、結果は「実行履歴」で見る |
| **実行履歴**（Executions） | ワークフローが動いた記録。成功・失敗と、各ノードの入出力が見られる |

---

## 2. 全体の形

```
Mautic   ──(Webhook)──▶  I-11  ──(顧客からの要求だけ)──▶  I-21 通知 ──▶ メール（開発: MailHog／本番: Amazon SNS）
Chatwoot ──(Webhook)──▶  I-12  ──(顧客の最初の発言)────▶  I-21 通知
                           └──(メールアドレスがあるとき)─▶  I-19 突き合わせ ──▶ Mautic の API
I-18 … 将来用の骨格（何もしない。公開しない）

定期実行の 3 本（スケジュール。どれも ops_settings のスイッチが true のときだけ動く。**公開は人が確かめてから**）
週次 問い合わせの棚卸し ─(月曜 09:00)─▶ Chatwoot の API を読む ─▶ I-21 通知（lead。取得の失敗は ops）
n8n スケジュール実行のハートビート ─(5 分ごと)─▶ CloudWatch に PutMetricData（本番だけ有効にする）
運用監視（開発だけ）─(5 分ごと・毎日)─▶ OpenSEO の health・sandbox-tls の期限 ─▶ I-21 通知（ops。状態が変わったときだけ）
```

- `I-11` `I-12` は外から呼ばれる**親**、`I-21` `I-19` は親から呼ばれる**子**（サブワークフロー）。定期実行の 3 本は自分で動き、`I-21` を呼ぶ（呼び先の付け替えは 8.2）。
- **子を先に取り込み、子を先に公開する**のが、この手順書の一番大事な順番。親は子を ID で呼ぶので、子が無いと親の設定ができず、子が公開されていないと本番で親が失敗する（エラー `Workflow is not active and cannot be executed`）。

---

## 3. どの n8n に入れるか

| | 開発環境 | 本番（オンプレ。ADR-21） |
|---|---|---|
| 画面の URL | `http://127.0.0.1:5678` | `http://127.0.0.1:5679` |
| 起動の手順 | `middleware/n8n`（`./dev/init-env.sh` → `docker compose up -d`） | `onprem/n8n`（`onprem/README.md`） |
| 通知の送り先 | MailHog（ローカルのメールの受け皿） | Amazon SNS |
| Mautic・Chatwoot | 開発用のローカルのもの | クラウド（AWS）のもの |
| 公開してよい人 | 確認のために短時間だけ（終わったら戻す） | **`R1` だけ** |

**最初は開発環境で一通りやる。** 本番は、開発環境で動いたのを確かめてから、同じ手順を繰り返す（違うところは 10 節）。

> **開発環境の n8n が ngrok でインターネットに出ている場合は、作業の間は閉じておく。** 公開した Webhook に外から届いてしまうため。

### 初めて n8n を開くとき

1. ブラウザで画面の URL を開く。
2. 初回は **Set up owner account**（管理者の作成）の画面が出る。メールアドレス・名前・パスワードを入れて作る。このアカウントは n8n の中だけのもの。
3. 左のメニューの **Overview** が、ワークフロー・資格情報・Data Table の一覧の入口になる。

---

## 4. 事前に起動しておく: 開発環境の中継（`middleware/host-relay`）

n8n と Chatwoot はコンテナ（Docker）の中で動いている。**コンテナの中から見た `127.0.0.1` はコンテナ自身**なので、パソコン本体で `127.0.0.1` だけに開いているサービス（Mautic・Mautic の MailHog・n8n・Chatwoot・OpenSEO）には、そのままでは届かない。そこで、開発環境では中継を動かしておく。

```bash
cd middleware/host-relay && docker compose up -d     # 一度起動すれば、再起動のたびに自動で上がる
```

中継があると、コンテナからは **`host.docker.internal`** という名前でパソコン本体のサービスに届く。開発環境で設定する宛先は次のとおり（詳しくは [host-relay の README](../../host-relay/README.md)）。

| 設定する場所 | 値 |
|---|---|
| Data Table `ops_settings` の `mauticBaseUrl` | `http://host.docker.internal:8000` |
| 資格情報 `MailHog SMTP（開発）` | Host `host.docker.internal`、Port `1025` |
| Chatwoot の Webhook の URL | `http://host.docker.internal:5678/webhook/chatwoot-event` |
| Data Table `ops_settings` の `chatwootBaseUrl` | `http://host.docker.internal:3100`（週次の棚卸しが使う） |
| 運用監視の OpenSEO の URL | `http://host.docker.internal:3001/api/health`（ワークフローに書いてある。中継は `GET /api/health` だけを通す） |
| Mautic の Webhook の URL | `http://127.0.0.1:5678/webhook/mautic-event`（Mautic はパソコン本体で動くので、中継は通らない） |

> 中継を動かさなくても、Webhook の受け取り・署名の検証・重複のチェックは確かめられる。その場合は `I-19`（Mautic への問い合わせ）と `I-21`（メールの送信）だけが失敗する（失敗しても親の `I-11` `I-12` は止まらない）。**本番には中継を置かない**（本番の経路は 10 節）。

---

## 5. 手順 1: Data Table を 5 つ作る

ワークフローは Data Table を**名前で**探す。**名前と列名は 1 文字も違えずに**作る（大文字・小文字も区別される）。

### 作り方（1 つ分）

1. 左のメニューの **Overview** を開き、上のタブの **Data tables** を選ぶ。
2. 右上のボタンの横の **▼**（分割ボタン）を押し、**Create Data table** を選ぶ。
3. 名前を入れ、**From scratch**（手で列を作る）を選ぶ。
4. 表の画面で、列を足す（列の名前と型〈String / Number〉を選ぶ）。
   - `id`・`createdAt`・`updatedAt` の 3 つは**自動で付く**ので、自分では作らない。

### 作る表と列

| 表の名前 | 列（名前: 型） | 何に使うか |
|---|---|---|
| `dedup_mautic` | `dedupKey`: String、`contactId`: Number、`eventType`: String、`timestampSec`: Number | Mautic の同じイベントを 2 回処理しないため（7 日で自動削除） |
| `dedup_chatwoot` | `dedupKey`: String、`displayId`: Number、`messageId`: String | Chatwoot の同じイベントを 2 回処理しないため（7 日で自動削除） |
| `ops_settings` | `key`: String、`value`: String | 設定（通知の送り先・Mautic の URL など） |
| `monitor_state` | `checkId`: String、`state`: String | 監視の前回の状態（通知を状態が変わったときだけ送るため） |
| `contact_link` | `chatwootContactId`: Number、`displayId`: Number、`status`: String、`mauticContactId`: Number、`matchCount`: Number、`checkedAt`: String | Chatwoot と Mautic の人の対応付け（メールアドレスは記録しない） |

### `ops_settings` に行を入れる

表の画面で行を足し、次の値を入れる。

| key | value（開発環境） | value（本番） |
|---|---|---|
| `notifyBackend` | `mailhog` | `sns` |
| `mauticBaseUrl` | `http://host.docker.internal:8000` | `https://mkt.comegin.com` |
| `snsTopicArnLead` | （入れない） | SAM の出力 `LeadAlertTopicArn` の値 |
| `snsTopicArnOps` | （入れない） | SAM の出力 `OpsAlertTopicArn` の値 |
| `chatwootBaseUrl` | `http://host.docker.internal:3100` | `https://chat.comegin.com` |
| `chatwootAccountId` | Chatwoot のアカウントの ID（画面の URL の `/app/accounts/<数字>/`） | 同じ |
| `inventoryEnabled` | `false`（棚卸しを動かすときだけ `true`） | `false`（`R1` が確かめてから `true`） |
| `heartbeatEnabled` | `false`（開発は動かさない） | `false`（**アラームのデプロイ後**に `R1` が `true`） |
| `heartbeatNamespace` | `ComeGin/OnpremN8n` | `ComeGin/OnpremN8n`（IAM の条件と同じ綴り） |
| `opsMonitorEnabled` | `false`（運用監視を動かすときだけ `true`） | `false`（本番には運用監視のワークフローを入れないので使わない。行は provision が入れる） |

**スイッチ（`inventoryEnabled` `heartbeatEnabled` `opsMonitorEnabled`）は、`true` 以外・行が無いときは、そのワークフローは何もしない**（安全側）。provision は、これらの行が**無いときだけ**入れる（人が `true` にした値を、再実行で戻さない）。

**確認**: Data tables の一覧に 5 つ並び、`ops_settings` に 8 行（本番は 10 行）ある。

---

## 6. 手順 2: 資格情報を作る

### 作り方（1 つ分）

1. 左上の **+**（Create）ボタンを押し、**Credential** を選ぶ。
2. 種類（下の表の「種類」）を検索して選ぶ。
3. 値を入れる。
4. 左上の名前（既定は「〜 account」）を押して、下の表の「名前」に変える。**名前をそろえておくと、取り込んだワークフローに自動で割り当てられる**ことがある。
5. **Save** を押す。n8n が接続を試し、結果を表示する（MailHog など、試せないものもある）。

### 作る資格情報

| 名前 | 種類 | 入れる値 | 使うワークフロー |
|---|---|---|---|
| `Mautic Webhook 署名鍵（Crypto）` | **Crypto** | **Hmac Secret** に、Mautic の Webhook の **Secret**（9.3 で Mautic の Webhook を作ると自動で作られる）。**先に資格情報だけ作っておき、値は 9.3 で入れてよい** | I-11 |
| `Chatwoot Webhook 署名鍵（Crypto）` | **Crypto** | **Hmac Secret** に、Chatwoot の Webhook のシークレット（9.3 で Chatwoot の Webhook を作ると表示される）。**値は 9.3 で入れてよい** | I-12 |
| `Mautic API（client_credentials）` | **OAuth2 API** | Grant Type: **Client Credentials**、Access Token URL: `<Mautic の URL>/oauth/v2/token`、Client ID と Client Secret: Mautic の API 資格情報（`mautic-mcp` と同じものでよい）、Authentication: **Body** | I-19 |
| `MailHog SMTP（開発）` | **SMTP** | Host: `host.docker.internal`（4 節の中継を通る）、Port: `1025`、SSL/TLS: 使わない、User・Password: 空（**開発環境だけ**）。届いたメールは `http://127.0.0.1:8025` で見る | I-21 |
| `AWS SNS 発行（アクセスキー）` | **AWS** | Access Key ID と Secret Access Key: IAM ユーザー `comegin-prod-onprem-n8n-sns` のキー（`cloud/README.md` の 4.5 で発行）、Region: `ap-northeast-1`（**本番だけ**）。**SNS への発行と、CloudWatch へのハートビート（`PutMetricData`）の両方に同じ資格情報を使う**（IAM の権限は SNS の発行と、名前空間 `ComeGin/OnpremN8n` への `PutMetricData` だけ） | I-21・n8n スケジュール実行のハートビート |
| `Chatwoot API（api_access_token）` | **Header Auth** | Name: `api_access_token`、Value: Chatwoot のアクセストークン（会話の一覧を読めればよい。**管理者のトークンは避け**、エージェントの権限のユーザーで発行する） | 週次 問い合わせの棚卸し |

> **Crypto の資格情報の Hmac Secret は、必ず値を入れる。** 空のまま作ると、誰でも正しい署名を作れてしまう（n8n からは空かどうかを確かめられない）。

---

## 7. 手順 3: ワークフローを取り込む（子 → 親の順）

**この順番で取り込む**: `I-21` → `I-19` → `I-11` → `I-12` →（必要なら）`I-18` → 定期実行の 3 本（`weekly-inquiry-inventory.json`・`n8n-schedule-heartbeat.json`・`ops-monitor.json`。**`ops-monitor` は開発環境だけ**）。

### 取り込み方（1 本分）

1. ブラウザで n8n の画面（開発環境 `http://127.0.0.1:5678`）を開く。
2. 画面の**左上の「+」ボタン**（Create）を押す。小さなメニューが出るので **Workflow** を選ぶ。
   - 何も置かれていない画面（「Add first step…」と出る）が開く。これが空のワークフロー。
3. 画面の**右上の「⋯」**（点が 3 つ並んだボタン）を押す。メニューの **Import from File** を選ぶ。
4. ファイルを選ぶ画面が開くので、このフォルダ（`middleware/n8n/workflows/`）の JSON を選ぶ。1 本目は `I-21-sns-notify.json`。
5. 画面にノード（箱）が線でつながって並ぶ。**左上のワークフローの名前**が `I-21 SNS 通知` に変わっていれば、取り込めている。
6. 何も押さなくてよい。n8n は自動で保存する（**保存しただけでは本番では動かない**。動かすのは 9 節の公開）。
7. 画面の左のメニューの **Overview** を押すと一覧に戻る。一覧に `I-21 SNS 通知` が増えている。

同じ操作を、**`I-19-email-match.json` → `I-11-mautic-webhook-dedup.json` → `I-12-chatwoot-webhook-dedup.json`** の順に繰り返す（`I-18-posthog-writeback.json` は将来用なので、取り込まなくてよい）。定期実行の 3 本も同じ操作で取り込む（子の `I-21` を先に取り込んでおく）。

取り込むと、**資格情報が割り当てられていないノードに赤い三角の警告**が出ることがある。これは正常で、次の手順 4 で直す。

> うまくいかないとき: **Import from File** が見当たらない場合は、空のワークフローを開いていない（一覧の画面のまま）ことが多い。2 からやり直す。同じ JSON を 2 回取り込むと同じ名前のワークフローが 2 つできるので、余分なほうは一覧の **⋯** → **Archive**（アーカイブ）で片づける。

---

## 8. 手順 4: 取り込んだ後の設定

### 8.1 資格情報を割り当てる

ノードをダブルクリックして開き、**Credential to connect with** の欄で、手順 2 で作った資格情報を選ぶ。

| ワークフロー | ノード | 資格情報 |
|---|---|---|
| I-21 SNS 通知 | `MailHog に送る（開発）` | `MailHog SMTP（開発）` |
| I-21 SNS 通知 | `SNS に発行` | `AWS SNS 発行（アクセスキー）`（**本番だけ**。開発環境では空のままでよい） |
| I-19 Chatwoot と Mautic の email 突合 | `Mautic でメールアドレスを検索` | `Mautic API（client_credentials）` |
| I-11 Mautic Webhook の受領と重複排除 | `Webhook-Signature を計算` | `Mautic Webhook 署名鍵（Crypto）` |
| I-12 Chatwoot Webhook の受領と重複排除 | `X-Chatwoot-Signature を計算` | `Chatwoot Webhook 署名鍵（Crypto）` |
| 週次 問い合わせの棚卸し | `未割り当ての会話を取る`・`割り当て済みの会話を取る` | `Chatwoot API（api_access_token）` |
| n8n スケジュール実行のハートビート | `CloudWatch に PutMetricData` | `AWS SNS 発行（アクセスキー）` |
| 運用監視 | （資格情報を使うノードは無い） | — |

### 8.2 呼び出し先（子のワークフロー）を選び直す

JSON の中の「呼び出し先」は、書き出し元の n8n のワークフローの ID のままになっている。**取り込み先では ID が違う**ので、選び直す。

| ワークフロー | ノード | 選ぶもの |
|---|---|---|
| I-11 | `I-21 通知を呼ぶ` | `I-21 SNS 通知` |
| I-12 | `I-21 通知を呼ぶ` | `I-21 SNS 通知` |
| I-12 | `I-19 突合を呼ぶ` | `I-19 Chatwoot と Mautic の email 突合` |
| 週次 問い合わせの棚卸し | `取得の状態を伝える（I-21）`・`棚卸しの結果を通知する（I-21）` | `I-21 SNS 通知` |
| 運用監視 | `状態を伝える（項目 9。I-21）`・`状態を伝える（項目 5。I-21）` | `I-21 SNS 通知` |

ノードを開き、**Source** が **Database**、**Workflow** の欄で **From list** を選び、一覧から選ぶ。入力の欄（Workflow Inputs）が表示されたら、取り込んだ値のままでよい（空になっていたら、更新ボタンで子の入力の定義を読み直す）。

### 8.3 ワークフローの設定を確かめる

各ワークフローで、右上の **⋯** → **Settings** を開き、次になっているか確かめる（JSON に入っているので、普通はそのまま）。

| ワークフロー | 確かめること | 理由 |
|---|---|---|
| I-11・I-12・I-19 | **Save successful production executions** が **Do not save** | 実行履歴にメールアドレスが残らないようにするため |
| I-21 | **Timeout Workflow** がオンで 10 秒 | 通知が詰まっても顧客対応を止めないため |
| 定期実行の 3 本 | **Save successful production executions** が **Do not save** | 5 分ごとの実行が履歴を埋めないため。棚卸しは Chatwoot の会話の抜粋が履歴に残らないようにするため |
| すべて | **Timezone** が `Asia/Tokyo` | 時刻の表示と自動削除の時刻（03:00）・棚卸しの月曜 09:00 のため |

> 確認の間は、成功した実行の記録が残らないので、成功を画面で見られない。**確かめるときだけ** I-11・I-12 を **Save** にし、**終わったら Do not save に戻す**（戻し忘れると、実行履歴にメールアドレスが残る）。

### 8.4 Data Table のノードが空に見えるとき

Data Table のノードを開いて「Currently no items exist」と表示されることがある。**表示だけの不具合**で、データは失われていない。列の欄の右にある**再読み込み（↻）ボタン**を押すと表示が戻る。

---

## 9. 手順 5: テストして、公開する

### 9.1 子を公開する（I-21 → I-19）

1. `I-21 SNS 通知` を開き、右上の **Publish** を押す。表示された画面で、もう一度 **Publish** を押す。
2. `I-19 Chatwoot と Mautic の email 突合` も同じように公開する。

子は Webhook を持たないので、公開しても外からは呼ばれない（親から呼ばれるだけ）。

### 9.2 親をテスト URL で試す（公開の前）

1. `I-11` を開き、最初の Webhook のノードを開く。上に **Test URL** と **Production URL** の切り替えがある。**Test URL** を表示しておく。
2. **Listen for test event**（または画面下の **Execute workflow**）を押す。**ここから 120 秒だけ**、テスト URL が反応する。
3. ターミナルで、[README.md の「Webhook の署名検証」](README.md) の curl を実行する。**送り先の URL の `/webhook/` を `/webhook-test/` に読み替える。** シークレットは、手順 2 で Crypto の資格情報に入れた値。
4. 画面の各ノードに緑のチェックが付き、データが流れたことが分かる。署名が正しければ 200、間違っていれば 401 になる。

> **シークレットをシェルの履歴に残さない。** `read -s MAUTIC_WEBHOOK_SECRET` で入力するなど、コマンドの行に直接書かない。

### 9.3 Mautic・Chatwoot に Webhook を設定する

Webhook は「Mautic・Chatwoot で何かが起きたら、この URL に知らせて」という設定。**Mautic・Chatwoot の管理画面で**行う（n8n の画面ではない）。どちらも、**製品の側で作られたシークレットを、n8n の資格情報に写す**。

送り先の URL:

| | 開発環境 | 本番 |
|---|---|---|
| Mautic → n8n | `http://127.0.0.1:5678/webhook/mautic-event` | `http://10.99.0.2:5680/webhook/mautic-event` |
| Chatwoot → n8n | `http://host.docker.internal:5678/webhook/chatwoot-event` | `http://10.99.0.2:5680/webhook/chatwoot-event` |

開発環境で Mautic と Chatwoot の URL が違うのは、Mautic はパソコン本体で、Chatwoot はコンテナの中で動いているため（4 節）。

#### Mautic の Webhook を作る（I-11 用）

1. Mautic の管理画面（開発環境 `http://127.0.0.1:8000`）に管理者でログインする。
2. 画面の**右上の歯車のアイコン**（Settings）を押す。メニューの **Webhooks** を選ぶ。
3. 一覧の画面の右上の **+ New** を押す。
4. 次のとおり入れる。

   | 欄 | 入れる値 |
   |---|---|
   | **Name** | `n8n I-11`（分かれば何でもよい） |
   | **Webhook POST Url** | 上の表の Mautic の URL |
   | **Secret** | **空のままにする**（保存すると Mautic が自動で作る） |
   | **Webhook Events**（チェックボックス） | `Contact Identified Event`、`Contact Updated Event`、`Contact Points Changed Event`、`Contact Segment Membership Change Event`、`Form Submit Event` の 5 つに印を付ける（ほかは付けない） |
   | 公開（Published）のスイッチ | **Yes**（有効） |

5. 右上の **Save & Close** を押す。
6. 一覧に戻ったら、今作った Webhook の名前を押して開き直す。**Secret** の欄に長い文字列が入っている。これを**選んでコピー**する。
7. n8n の画面に戻り、左のメニューの **Overview** → 上のタブの **Credentials** → `Mautic Webhook 署名鍵（Crypto）` を開く。**Hmac Secret** にコピーした値を貼り付けて **Save** を押す。

> Mautic の画面を日本語にしている場合は、Settings は「設定」、Webhooks は「Webhook」と表示される。
>
> Webhook の編集画面の **Send Test Payload** を押すと、Mautic から試しの送信ができる。n8n で `I-11` を公開した後（9.4）に押し、n8n の **Executions** に実行が増えれば届いている。

#### Chatwoot の Webhook を作る（I-12 用）

Chatwoot は **4.12 以上**であること（それより前の版は署名を付けない。開発環境は `backend/chatwoot-system/docker-compose.yaml` で `v4.18.0` に固定済み）。

1. Chatwoot の管理画面（開発環境 `http://127.0.0.1:3100`）に管理者でログインする。
2. 左のメニューの **Settings**（設定）を押し、**Integrations** を選ぶ。
3. 一覧の **Webhooks** の **Configure** を押す。
4. 右上の **Add new webhook** を押す。入力の画面（ポップアップ）が開く。
5. 次のとおり入れる。

   | 欄 | 入れる値 |
   |---|---|
   | **Webhook URL** | 上の表の Chatwoot の URL |
   | イベント（チェックボックス） | **Conversation Created** と **Message Created** の 2 つに印を付ける（ほかは付けない） |

6. **Create Webhook** を押す。作成すると**シークレットが表示される**ので、コピーする（後からでも、一覧の Webhook の**鉛筆のアイコン**〈編集〉を押すと見られる）。
7. n8n の画面に戻り、**Overview** → **Credentials** → `Chatwoot Webhook 署名鍵（Crypto）` を開く。**Hmac Secret** にコピーした値を貼り付けて **Save** を押す。

> シークレットは、メモ帳などに残さずに n8n へ直接貼り付ける。貼り付けた後は、n8n の画面では値が伏せて表示される。

#### 設定できたかの確かめ方

- n8n の `I-11`・`I-12` を公開（9.4）した後に、Mautic でテストのコンタクトを作る（または **Send Test Payload**）、Chatwoot でテストの会話を始める。
- n8n の各ワークフローの **Executions** タブに実行が増えれば、届いている。**401 で止まっている**ときは、シークレットの写し間違い（11 節）。

### 9.4 親を公開する（I-11・I-12）

- **開発環境**: 確認のために短時間だけ公開し、終わったら戻す（下の 9.6）。
- **本番**: 公開は **`R1` が判断して行う**（エージェントは公開しない）。
- **`I-18` は公開しない**（将来用の骨格。前提が決まっていない）。

公開すると、本番 URL（`/webhook/...`）が反応するようになる。

### 9.5 動いたことを確かめる

| 確かめること | 見る場所 |
|---|---|
| 実行の成否 | ワークフローを開き、上の **Executions** タブ（全体は左のメニューの **Executions**） |
| 重複のチェック | 同じ本文を 2 回送り、Data Table `dedup_mautic`（または `dedup_chatwoot`）の行が 1 行だけ増えること |
| 通知のメール（開発） | MailHog の画面。**本文にメールアドレス・氏名・問い合わせの本文が無いこと** |
| 通知（本番） | SNS の購読者のメール |

### 9.6 開発環境での確認が終わったら

- [ ] 親（I-11・I-12）の公開を戻す: ワークフローを開き、右上の Publish の横のメニュー（または ⋯）から **Unpublish**
- [ ] 8.3 で **Save** にした設定を **Do not save** に戻す
- [ ] 確認で増えた Data Table の行を消す（`dedup_*` は 7 日で自動で消える。`monitor_state` と `contact_link` は自動では消えない）
- [ ] ngrok を閉じたままにしておく

### 9.7 定期実行の 3 本を動かす（確かめたあとに、人が公開する）

provision・この手順書のどちらでも、**定期実行の 3 本は公開されない**（`ops_settings` のスイッチも `false`）。動かすときは、スイッチを `true` にしてから、ワークフローを公開する。

| ワークフロー | 動かす前に | 動いたことの確かめ方 |
|---|---|---|
| 週次 問い合わせの棚卸し | `inventoryEnabled=true`、資格情報 `Chatwoot API`、開発は中継（3100）。**月曜 09:00 を待たず**、ワークフローを開いて **Execute workflow**（手動実行）で試せる | 件数と `#番号` が MailHog のメールの「内訳」に出る。**氏名・メール・本文が無いこと**。0 件なら何も届かない（意図どおり） |
| 運用監視 | `opsMonitorEnabled=true`。開発の OpenSEO と中継（3001）が動いていること | OpenSEO を止めて 5 分待つと `[comegin] ops: ops-monitor:9 ng` が **1 通だけ**届く。戻すと `ok` が 1 通 |
| n8n スケジュール実行のハートビート | `heartbeatEnabled=true`（**本番だけ**。開発は動かさない）、IAM ユーザーに `PutMetricData` の権限（`cloud/` のデプロイ後）、名前空間・メトリクス名の綴りが IAM の条件と同じ | CloudWatch の `ComeGin/OnpremN8n` の `ScheduleHeartbeat` が 5 分ごとに 1 件。止めると 15 分でアラーム |

---

## 10. 本番（オンプレの n8n）で行うときの違い

手順は同じ。違うのは次の点だけ。

| 項目 | 本番での値 |
|---|---|
| n8n の画面 | `http://127.0.0.1:5679` |
| `ops_settings` | `notifyBackend=sns`、`mauticBaseUrl=https://mkt.comegin.com`、SNS のトピックの ARN 2 つ |
| 資格情報 | `MailHog SMTP（開発）` は作らない。`AWS SNS 発行（アクセスキー）` を作って `SNS に発行` に割り当てる |
| Mautic・Chatwoot の Webhook の URL | `http://10.99.0.2:5680/webhook/mautic-event`・`http://10.99.0.2:5680/webhook/chatwoot-event`（WireGuard 越しの受け口。`onprem/README.md`） |
| 公開 | **`R1` だけ** |
| 定期実行の 3 本 | **`運用監視` は取り込まない**（OpenSEO も `sandbox-tls` も本番に無い）。棚卸しとハートビートは取り込み、`inventoryEnabled`・`heartbeatEnabled` を `true` にしてから公開する（ハートビートは AWS のアラームと IAM のデプロイが先）。棚卸しの Chatwoot は `https://chat.comegin.com`、トークンは専用のユーザーのもの |
| 届いたことの確認 | オンプレで `docker compose logs webhook-proxy` を見て、**送信元が `10.99.0.1`** の要求が記録されていること |

---

## 11. 困ったとき

| 症状 | よくある原因 | 直し方 |
|---|---|---|
| curl が **404** | 本番 URL なのに公開していない／テスト URL なのに「待ち受け」を押していない（または 120 秒が過ぎた）／パスの打ち間違い | 9.2・9.4 をやり直す。テスト URL は `/webhook-test/`、本番 URL は `/webhook/` |
| curl が **401** | 署名の鍵が違う（Crypto の Hmac Secret と、Mautic・Chatwoot のシークレットが一致していない）／Chatwoot のタイムスタンプが 5 分より古い／Chatwoot が 4.12 より古い | 鍵を入れ直す。Chatwoot の版を確かめる |
| 親の実行が `Workflow is not active and cannot be executed` | 子（I-21・I-19）が公開されていない | 9.1 で子を公開する |
| ノードに赤い警告 | 資格情報が割り当てられていない／呼び出し先を選んでいない | 8.1・8.2 |
| I-21 が失敗する（開発） | 中継が動いていない（4 節）／資格情報の Host が `host.docker.internal` でない | `cd middleware/host-relay && docker compose ps` で 5 つ（Mautic・MailHog・n8n・Chatwoot・OpenSEO の health）動いているか見る。6 節の Host を直す |
| I-19 が失敗する（開発） | 中継が動いていない／Mautic（`dev/serve.sh`）が止まっている／OAuth2 の資格情報の値が違う | 4 節と 6 節を確かめる |
| Chatwoot の Webhook が n8n に届かない（開発） | 中継が動いていない／Chatwoot の Webhook の URL が `127.0.0.1` になっている | URL を `http://host.docker.internal:5678/...` にする（Chatwoot はコンテナの中で動くため） |
| 成功したはずなのに実行履歴に出ない | 8.3 で成功の記録を残さない設定にしている（意図どおり） | 確かめるときだけ Save にする |
| Data Table のノードが空に見える | 表示の不具合（8.4） | 再読み込みボタン |
| 棚卸し・運用監視が何もしない | `ops_settings` のスイッチが `true` でない／ワークフローを公開していない（定期実行は公開するまで動かない） | 9.7 |
| 棚卸しの取得が失敗する（開発） | 中継（3100）が動いていない／`chatwootBaseUrl` が違う／`Chatwoot API` のトークンが違う | 4 節。`ops` に `weekly-inventory:fetch ng` が 1 通届く |
| 運用監視の `ops-monitor:5` が `ng` | `sandbox-tls` の証明書を読めない（`public/` のマウントが無い）／残り 30 日未満 | `cd middleware/n8n && docker compose up -d`（`sandbox-certs` が `public/` を作る）。期限なら `middleware/n8n/README.md` の「証明書の更新」 |

---

## 12. ワークフローを直したら（Git に戻す）

n8n の画面でワークフローを直したら、JSON を書き出してこのフォルダのファイルを置き換え、PR で見てもらう。

1. ワークフローを開き、右上の **⋯** → **Download** で JSON を保存する。
2. このフォルダの同じ名前のファイルを置き換える（**資格情報の値は JSON に入らない**。入るのは資格情報の名前だけ）。
3. `git diff` で変更を確かめ、PR にする。**本番の n8n への反映（取り込み・公開）は、PR の承認の後に `R1` が行う。**
