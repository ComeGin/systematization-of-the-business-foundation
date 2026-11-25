# Chatwoot・Mautic の夜間の停止（0〜8 時）設計

2026-11-25。ユーザーの決定。

## 目的

費用を下げるため、本番の Chatwoot（chatwoot-web・chatwoot-worker）と Mautic（mautic-web・mautic-cron）を毎日 0:00〜8:00（日本時間）は 0 台にする。
そのあいだに Chatwoot・Mautic を使う定期実行は自動では起動せず、監視アプリの「今すぐ実行」で手動で実行する。

2026-11-12 に Chatwoot を常時稼働にした決定（定期実行が 503 で失敗していたため）を、費用を優先してやめる。定期実行の衝突は「手動にする」ことで避ける。

## 目標・目標外

- 目標: 4 つのサービスの夜間の停止。公開サイトで 0〜8 時は「受付時間外」と表示する（案 A）。Chatwoot・Mautic を使う定期実行を手動にする。
- 目標外: Aurora の自動一時停止など、データの置き場の夜間の停止。夜間の送信を預かって朝に送る仕組み（案 C）。
- 失敗とみなすもの: 夜間の利用者が、理由の分からない「送信できませんでした」を見る。朝になってもサービスが 0 台のまま残る。

## 案（ユーザーが A を選んだ）

| 案 | 内容 | 得失 |
|---|---|---|
| **A（採用）** | 0〜8 時はフォームとチャットの代わりに「8 時以降に受け付けます」と表示する。ブラウザの時計で判定する | サーバーを足さない。夜間の問い合わせは取りこぼすが、利用者には理由が伝わる |
| B | 何もしない | 手間なし。押し直しても失敗し、不具合に見える |
| C | Lambda と SQS で夜間の送信を預かり、8 時に Mautic へ送り直す | 取りこぼし無し。作る量と個人情報の置き場が増える |

## 設計

### 1. ECS の夜間の停止（`cloud/`）

- 仕組みは今の mautic-cron と同じ（Application Auto Scaling の `ScalableTarget` に `nightly-stop`・`morning-start` の 2 つの予定。`UseNightlyStop` の条件で、DesiredCount が 0 のサービスには作らない）。これを mautic-web・chatwoot-web・chatwoot-worker にも置く（Chatwoot の 2 つは 2026-11-12 のコミット 6a371bce で消したものを戻す）。
- 親の `NightlyStopSchedule` を `cron(0 0 * * ? *)`、`NightlyStartSchedule` を `cron(50 7 * * ? *)` にする。4 つとも同じ時刻。
  - **Claude の判断:** 再開は 7:50 にする。タスクの起動とヘルスチェックに数分かかるので、8:00 に受け付けを始められるようにするため（0 台の時間は 10 分短くなる）。
  - mautic-cron は 22:00〜3:45 から 0:00〜7:50 に変わる（22〜24 時は動くので、mautic-cron だけ見ると少し増える）。
- 台数のアラームは「希望数 − 実行数」で見ているので、止めても鳴らない。ALB の 503 は 2026-11-11 までと同じく、アラームの対象から外したままにする。
- `cloud/setup/aws.mjs` の `NIGHTLY_STOP_SERVICES` を 4 つにし、案内の時刻を 0〜8 時にする。`setup/lib/fix-guides.mjs` の「昼にデプロイ」の時刻も直す。
- **デプロイは 8:00〜24:00 に行う**（夜間に行うと、スケジュールの作り直しの途中で 0 台のまま残ることがある。README の 4.11 の手順はそのまま使える）。

### 2. 公開サイト（`frontend/verdant-virgo`）

- 受付時間外の判定を 1 か所に置く（例 `src/modules/service-hours/`。0:00〜8:00 JST。ブラウザの時計を JST に直して判定する。時刻の正本は `cloud/template.yaml` で、コメントで結ぶ）。
- 無料相談のフォーム（`ContactForm.tsx`）: 受付時間外なら、送信のボタンのすぐ上に案内を出し（最終レビューの後に、フォームの上から移した。ボタンの近くで理由が分かり、レイアウトもずれにくい）、送信のボタンを押せなくする。入力はできる（朝に送れるように）。送信の直前にも判定し直す（23:59 に開いて 0:01 に押した場合）。
- チャット（`chat/lib/chatwoot.ts`・`ChatLoader.astro`）: 受付時間外ならウィジェットを読み込まない。「チャットで質問する」を押したら、ボタンの近くに受付時間外の案内を出す（今の失敗の案内と同じ出し方）。
- 文言は `docs/` の 01-content-spec.md に足してから写す（今の文言の決め方に合わせる）。案: 「0 時から 8 時までは受け付けを停止しています。8 時以降にお送りください。お急ぎの場合は kamegin4@comegin.com までメールでご連絡ください。」
- **Claude の判断:** 8:00 を過ぎてもタスクの起動が遅れた場合は、今のエラーの表示（時間をおいてもう一度）に任せる。

### 3. 定期実行（`ops/schedules`・n8n）

- `enabled: false` にする（スケジューラに登録されず、監視アプリの「今すぐ実行」は使える）:
  - `daily-observe-conversations`（Chatwoot）
  - `daily-miswrite-check`（Chatwoot）
  - `daily-observe-analytics`（Mautic）
  - 説明文に「2026-11-25 から手動。8:00 以降に今すぐ実行する」を書く。
- すでに `enabled: false` のもの（`cycle-campaign`・`campaign-asset-upload`）は、有効にするときに夜間は Mautic が止まっていることを説明文に書く。
- `cycle-collect`（7:00）は自動のまま。Mautic を読むのはキャンペーンの項目だけで、外部の呼び出しの失敗はその項目だけ飛ばして続ける作りになっている（コードの変更は無し）。キャンペーンの項目がある日は 8:00 以降に今すぐ実行し直す、と説明文に書く。
- n8n の `weekly-inquiry-inventory`（月曜 7:00。Chatwoot を読む）: provision は公開しない（`publish: never`）ので、JSON はそのまま。本番で公開済みなら非公開にし、8:00 以降に画面から手動で実行する、と `onprem/README.md`・`middleware/n8n` の README に書く。
- `daily-propose`（4:30）の `after` から `daily-observe-analytics`・`daily-observe-conversations` を外し、`daily-observe-seo`・`daily-observe-ops` だけにする（2026-11-25 のユーザーの決定。案 A）。
  - 外さないと、`after` は「当日に success があること」を求めるので、毎日見送られて提案が 1 件も出なくなる（`backend/control-plane/src/engine.ts` の after の判定。手動の実行には効かない）。
  - 提案エージェントは、手動で実行した会話・集計の観測（14 日以内）があれば根拠に使い、無ければ他の観測だけで判断する。起票前チェックの 15 項目に、会話・集計の E-12 を必須にするものは無い（14 日を超えたものは検査 3 で根拠から外れるだけ）。
  - 案 B（daily-propose も手動にする）は採らなかった。提案の段が自動で回らなくなるため。
  - 同じ理由で、`monthly-analysis`（毎月 1 日 05:00）の `after` も `daily-observe-seo` だけにした（最終レビューの指摘。残すと毎月見送られる）。
  - 記事の下書きの経路（キーワード調査 → 企画 → 下書き）は Chatwoot・Mautic・daily-propose を通らないので、影響を受けない。

### 4. 文書

- `cloud/README.md` の 3.1（費用の表）と 4.11（夜間の停止）、`ops/README.md`、`setup/00-setup-overview.md`、各テンプレートのコメント、`docs/DetailedDesign/02-public-path-flows.md` の 4・5 節（チャットとフォーム）に受付時間外を足す。
- 開発環境には夜間の停止を入れない（開発の公開サイトでも判定は効くが、`PUBLIC_*` が開発のスタックを向くだけで害は無い）。

## 決まっていないこと・作る人に任せること

- 受付時間外の案内の見た目（今のフォームの注意書きと同じ部品で作る）。
- 費用の新しい見積もり（README の 3.1 の表の単価から計算し直す）。
- テストは書かない・実行しない（リポジトリの規則。指示があれば書く）。ビルド・デプロイもしない。
