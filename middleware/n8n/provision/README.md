# provision（n8n のワークフローをまとめて用意するスクリプト）

[GUIDE.md](../workflows/GUIDE.md) の 5〜9 節（Data Table・資格情報・取り込み・呼び出し先の付け替え・Mautic と Chatwoot の Webhook・子の公開）を、**1 回のコマンドで行う**スクリプト。手でやると 30 か所ほどのクリックとシークレットの写しが要るところを、自動にする。

## 何をするか

1. **接続の確認**: n8n の API キー、Mautic のトークン、Chatwoot の管理者のトークンが通るか。
2. **Data Table**: 5 つの表（`dedup_mautic` `dedup_chatwoot` `ops_settings` `monitor_state` `contact_link`）を作る（あれば足りない列だけを足す）。`ops_settings` に設定の行を入れる。**接続先など環境から決まる行**（`notifyBackend`・`mauticBaseUrl`・`snsTopicArn*`・`chatwootBaseUrl`・`chatwootAccountId`）は毎回上書きし、**定期実行のスイッチ**（`inventoryEnabled`・`heartbeatEnabled`・`opsMonitorEnabled`・`heartbeatNamespace`）は**無いときだけ**既定値（`false`）で入れる（人が `true` にした値を再実行で戻さない）。
3. **Mautic の Webhook**（I-11 用）を作る。Mautic が作った **Secret をそのまま受け取る**。
4. **Chatwoot の Webhook**（I-12 用）を作る。Chatwoot が作った **シークレットをそのまま受け取る**。
5. **n8n の資格情報**を作る（あれば値を入れ直す）: 署名鍵 2 つ（3・4 のシークレット）、Mautic の API、Chatwoot の API（Header Auth `api_access_token`。週次の棚卸し用。`CHATWOOT_N8N_API_TOKEN`、空なら管理者のトークンで代用して、本番では警告を出す）、開発は MailHog の SMTP と、使われない AWS のダミー（I-21 の SNS のノードは資格情報が必須で、無いと n8n が公開を拒むため。開発は MailHog に送るので SNS のノードは通らない）／本番は AWS（SNS）と、使われない SMTP のダミー（同じ理由。本番は SNS に送るので MailHog のノードは通らない）。
6. **ワークフロー**を子 → 親の順に取り込む（あれば更新）。資格情報を割り当て、子の呼び出し先を取り込み先の ID に付け替え、タグを付ける。
7. **子（I-21・I-19）を公開する**。親（I-11・I-12）は `--publish` を付けたときだけ公開する。I-18 は公開しない。**定期実行の 3 本（週次の棚卸し・ハートビート・運用監視）は、`--publish` を付けても公開しない**（人が確かめてから公開する。`ops-monitor` は開発だけに取り込む）。

**シークレットは画面にもログにも出ない。** Mautic・Chatwoot が作ったシークレットは、スクリプトの中だけを通って n8n の資格情報に入る（人がコピーしない）。

**何度実行しても同じ結果になる。** 名前（ワークフロー・資格情報・Data Table）と送り先の URL（Webhook）で既存のものを探し、あれば更新、無ければ作る。途中で失敗したら、原因を直してもう一度実行すればよい。

## 事前にやること（人が 1 回だけ）

1. **n8n の管理者を作る**: n8n の画面を初めて開くと出る **Set up owner account** で作る。
2. **n8n の API キーを作る**: n8n の画面の左下のアカウントのメニュー → **Settings** → **n8n API** → **Create an API key**。表示されたキーを控える（画面を閉じると二度と表示されない）。
3. **Mautic の API 資格情報を用意する**: Mautic の **Settings（歯車）→ Configuration → API Settings** で API を有効にし、**Settings → API Credentials** で OAuth 2 のクライアントを作る（`mautic-mcp` で使っているものがあれば同じでよい）。
4. **Chatwoot の管理者のアクセストークンを用意する**: 管理者（Administrator）でログインし、左下のプロフィール → **Profile Settings** の **Access Token** を控える。アカウントの ID は、ブラウザの URL の `/app/accounts/<数字>/` の数字。
5. **開発環境の中継を起動する**（開発環境だけ）: `cd ../../host-relay && docker compose up -d`。

## 使い方

```bash
# 1. 設定ファイルを作る（リポジトリの外。秘密値はここにだけ書く）
mkdir -p ~/.config/comegin/n8n-provision && chmod 700 ~/.config/comegin/n8n-provision
cp provision.conf.example ~/.config/comegin/n8n-provision/dev.conf
chmod 600 ~/.config/comegin/n8n-provision/dev.conf
#    エディタで開いて N8N_API_KEY・MAUTIC_CLIENT_ID・MAUTIC_CLIENT_SECRET・CHATWOOT_API_ACCESS_TOKEN・CHATWOOT_ACCOUNT_ID を書く
#    （ほかは空のままでよい。開発環境の既定値が入る）

# 2. 接続だけを確かめる（何も作らない）
node provision.mjs --target dev --check

# 3. 用意する（子は公開、親は未公開のまま）
node provision.mjs --target dev

# 4. 確かめたら、親も公開する（開発環境で確かめる間だけ。終わったら n8n の画面で Unpublish）
node provision.mjs --target dev --publish
```

Node 22 以上だけで動く（`pnpm install` は要らない）。

## 設定スクリプト（`setup/setup.mjs`）から呼ぶ

開発環境は、バックエンド全体の設定スクリプトの n8n モジュール（`../setup/index.mjs`）が、このスクリプトを**関数として呼ぶ**。オーナー・API キー・MCP のトークンの作成から provision までが 1 回のコマンドになり、**上の「事前にやること」の 1・2 と設定ファイルの作成は要らない**（Mautic の API 資格情報だけは、画面で作って `dev.conf` に書く）。

```js
import { provision, buildConf, PROVISION_SCOPES } from "./provision.mjs";
await provision({ target: "dev", conf: buildConf("dev", values), publish: false, io: { log, warn } });
```

- `buildConf(target, values)`: `provision.conf.example` のキーの値（`values`）に、`--target` ごとの既定値を足して検証する（足りない必須項目は Error。値は出さない）。
- `provision({ target, conf, publish, checkOnly, io })`: 本体。関数として呼ぶときは `process.exit` せず、失敗は Error を投げる。`io` を渡すと出力がそちらに行く。
- `PROVISION_SCOPES`: このスクリプトが使う n8n の公開 API に必要な API キーのスコープ。モジュールが API キーを作るときに使う（公開 API を増やしたら足す）。
- CLI（`node provision.mjs ...`）は今までどおり動く。直接実行されたときだけ CLI として動き、import しても何も走らない。

設定スクリプトの状態（`~/.config/comegin/setup/dev.state.json`）と設定（`~/.config/comegin/setup/dev.conf`）から、`provision.conf.example` のキーへ次のように渡す。

| `provision.conf.example` のキー | 設定スクリプトでの出どころ |
|---|---|
| `N8N_API_KEY` | 状態の `N8N_API_KEY`（n8n モジュールが REST で作る。ラベル `setup-provision`） |
| `N8N_BASE_URL`・`MAUTIC_API_URL`・`MAUTIC_URL_FROM_N8N`・`MAUTIC_WEBHOOK_TARGET`・`CHATWOOT_API_URL`・`CHATWOOT_WEBHOOK_TARGET`・`SMTP_HOST`・`SMTP_PORT` | 既定値（`dev.conf` に同じ名前で書けば上書き） |
| `MAUTIC_CLIENT_ID`・`MAUTIC_CLIENT_SECRET` | 状態か `dev.conf` の同名のキー（無ければ、n8n モジュールが画面での作成を案内して止まる） |
| `CHATWOOT_API_ACCESS_TOKEN` | 状態の `CHATWOOT_ADMIN_TOKEN`（chatwoot モジュールが作る管理者のトークン） |
| `CHATWOOT_ACCOUNT_ID` | 状態の `CHATWOOT_ACCOUNT_ID`（chatwoot モジュール） |
| `CHATWOOT_URL_FROM_N8N`・`CHATWOOT_N8N_API_TOKEN` | 設定（`dev.conf`）に同じ名前で書いてあれば、そのまま渡す。URL の既定は `http://host.docker.internal:3100`（中継）。トークンが空なら、管理者のトークンを週次の棚卸しの資格情報に使う |
| `AWS_ACCESS_KEY_ID`・`AWS_SECRET_ACCESS_KEY`・`AWS_REGION`・`SNS_TOPIC_ARN_LEAD`・`SNS_TOPIC_ARN_OPS` | 開発環境では使わない（SNS は本番だけ。開発は MailHog）。`--target dev` で AWS のキーがあれば `AWS SNS 発行（アクセスキー）` に入れ、無ければダミーで作る（既にあれば触らない）。SNS のトピックの ARN は読まない |
| `--publish` | `dev.conf` の `N8N_PUBLISH_PARENTS=true`（既定は親を公開しない） |

## 本番（`--target prod`）

- 設定ファイルは `~/.config/comegin/n8n-provision/prod.conf`。本番の n8n（オンプレ。`127.0.0.1:5679`）の API キー、クラウドの Mautic の API 資格情報、クラウドの Chatwoot の**管理者**のトークン（Webhook の作成用）、**棚卸し専用のトークン `CHATWOOT_N8N_API_TOKEN`（会話の一覧を読むだけのエージェントの権限のユーザーで発行する。空だと管理者のトークンを n8n に入れることになり、警告が出る）**、SNS 用の IAM ユーザーのキー、SNS のトピックの ARN を書く。
- **親（I-11・I-12）の公開（`--publish`）は `R1` の判断で行う**（エージェントは公開しない。README の「本番」）。
- Webhook の送り先は WireGuard 越しの受け口（`http://10.99.0.2:5680/webhook/...`）になる。WireGuard と `onprem/n8n` が動いていること。

## 終わった後に人が確かめること

- n8n の画面で 8 本（本番は 7 本。`ops-monitor` は開発だけ）のワークフローが並び、赤い警告が無いこと。定期実行の 3 本は未公開のまま。
- Mautic でテストのコンタクトを作る、Chatwoot でテストの会話を始める → n8n の **Executions** に実行が増えること（親を公開している場合）。
- 開発環境では、MailHog（`http://127.0.0.1:8025`）に通知が届き、本文にメールアドレス・氏名・問い合わせの本文が無いこと。

## うまくいかないとき

| 表示 | 原因と直し方 |
|---|---|
| `設定に足りない項目がある` | 表示された項目を設定ファイルに書く |
| `n8n API キーの確認: HTTP 401` | API キーの写し間違い、または別の n8n（開発／本番）のキー |
| `Mautic のトークンの取得: HTTP 400/401` | Mautic の API が無効、またはクライアントの ID・シークレットの間違い |
| `管理者（Administrator）のアクセストークンが要る` | Chatwoot のトークンが管理者のものでない |
| `シークレットを取得できなかった（Chatwoot が 4.12 より古い…）` | Chatwoot の版を確かめる（開発は `v4.18.0` に固定済み） |
| `資格情報 … の作成: HTTP 400（…）` | n8n が入力の形を受け付けなかった。括弧の中の説明を Claude に伝える |
| `呼び出し先「…」が見つからない` | JSON の子のワークフローの名前が変わった。`provision.mjs` の `WORKFLOWS` を確かめる |

## 注意

- 資格情報が既にあると、**値を入れ直す**（Webhook のシークレットを Mautic・Chatwoot の現在の値にそろえる）。n8n の画面で手で変えた値は上書きされる。
- Mautic・Chatwoot の Webhook は、**送り先の URL が同じもの**を同じ Webhook とみなす。送り先を変えた場合は新しい Webhook ができるので、古いものは各製品の画面で消す。
- `provision.mjs` の `DATA_TABLES`・`WORKFLOWS`・`MAUTIC_TRIGGERS`・`CHATWOOT_SUBSCRIPTIONS` は、[README.md](../workflows/README.md) と [GUIDE.md](../workflows/GUIDE.md) の表と同じにしておく（片方だけ直さない）。
