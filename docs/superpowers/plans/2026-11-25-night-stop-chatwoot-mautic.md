# Chatwoot・Mautic の夜間の停止（0〜8 時）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 本番の mautic-web・mautic-cron・chatwoot-web・chatwoot-worker を毎日 0:00〜7:50（JST）に 0 台にし、公開サイトは 0〜8 時を受付時間外と表示し、Chatwoot・Mautic を使う定期実行を手動にする。

**Architecture:** ECS の台数は、mautic-cron で使っている Application Auto Scaling の予定（`NightlyStopScalableTarget`）を 4 つのサービスに広げる。公開サイトは、ブラウザの時計を JST に直して受付時間外を判定する小さなモジュールを 1 つ置き、フォームとチャットがそれを使う。定期実行は YAML の `enabled` と `after` を変えるだけ。

**Tech Stack:** AWS SAM（CloudFormation）、Node（setup スクリプト）、Astro + React（公開サイト）、YAML（ops/schedules）。

**Spec:** `docs/superpowers/specs/2026-11-25-night-stop-chatwoot-mautic-design.md`

## Global Constraints

- 止める: `cron(0 0 * * ? *)`、戻す: `cron(50 7 * * ? *)`、タイムゾーン `Asia/Tokyo`。4 つのサービスとも同じ時刻（親のパラメータ 1 組）。
- 公開サイトの受付時間外: **JST の 0:00 以上 8:00 未満**。
- 案内の文言（01-content-spec.md に足してから写す。一字一句同じに）: 「0時から8時までは受け付けを停止しています。8時以降にお送りください。お急ぎの場合は kamegin4@comegin.com までメールでご連絡ください。」（数字と単位の間は既存の §5.1 の表記「3営業日以内」「2,000文字以内」に合わせて空けない）。チャット用は「0時から8時まではチャットを停止しています。8時以降にお試しください。お急ぎの場合は kamegin4@comegin.com までメールでご連絡ください。」
- 文書・コメントはすべて日本語。日付は 2026-11-25、「ユーザーの決定」と書く。
- リポジトリの規則: テストを書かない・実行しない、`pnpm build`・`sam build`・デプロイをしない、git の書き込み系コマンドを使わない（コミットはしない。作業ツリーの差分まで）。
- `.env` を読まない。`grep -r` ではなく `rg` を使う。

## Review Focus

1. 23:59 にフォームを開き、0:01 に送信を押した → 送信せず受付時間外の案内を出す（送信の直前に判定し直す。Task 3）。
2. 7:59 に開いたページを 8:01 に操作した → 送信できる（判定は押した時点の時刻。描画時の判定を固定しない。Task 3）。
3. ブラウザのタイムゾーンが JST 以外（海外・UTC の端末）→ JST で判定する（`Date.now()` の UTC に +9 時間。`jst.ts` と同じ方法。Task 3）。
4. 夜間にデプロイした → スケジュールの作り直しで 0 台のまま残りうる。README と設定スクリプトの案内が「デプロイは 8:00〜24:00」と、戻す `update-service` のコマンドを出す（Task 2・5）。
5. 同意済みの訪問者が 0〜8 時にページを開いた → ウィジェットの SDK を読み込まない（Chatwoot に要求を出さない）。8 時を過ぎて「チャットで質問する」を押したら、その場で読み込んで開く（Task 3）。

---

### Task 1: ECS の夜間の停止を 4 つのサービスに広げる（`cloud/`）

**Files:**
- Modify: `cloud/template.yaml`（296〜317 行の `NightlyStop*` のパラメータとコメント、1170〜1260 行あたりの `MauticWebService`・`ChatwootWebService`・`ChatwootWorkerService` の `Parameters`）
- Modify: `cloud/stacks/services/mautic-web.yaml`（Parameters の末尾・`Conditions`・Resources の末尾）
- Modify: `cloud/stacks/services/chatwoot-web.yaml`（89〜90 行のコメントを置き換え、Resources の末尾）
- Modify: `cloud/stacks/services/chatwoot-worker.yaml`（77〜78 行のコメントを置き換え、Resources の末尾）
- Modify: `cloud/stacks/services/mautic-cron.yaml`（89〜105 行の既定値、288 行のコメント）
- Modify: `cloud/stacks/alarms.yaml`（481〜482 行のコメント）

**Interfaces:**
- Produces: 子テンプレート 4 つが同じパラメータ `NightlyStopEnabled`・`NightlyStopSchedule`・`NightlyStartSchedule`・`NightlyStopTimezone` と条件 `UseNightlyStop` とリソース `NightlyStopScalableTarget` を持つ。

- [ ] **Step 1: 親の既定値を変える。** `NightlyStopSchedule` の Default を `cron(0 0 * * ? *)`、`NightlyStartSchedule` を `cron(50 7 * * ? *)`。上のコメントを書き直す（経緯: 10-26 に導入、11-04 に再開を 3:45 へ、11-12 に Chatwoot を外した、**11-25 に費用を優先して 4 つとも 0:00〜7:50 にした。再開を 7:50 にしたのは 8:00 に受け付けを始めるため。夜間の定期実行は手動にした〈ops/README〉。公開サイトは 0〜8 時を受付時間外と表示する**）。「mautic-web は止めない」「このパラメータは Chatwoot に渡さない」の文は消す。
- [ ] **Step 2: 親から 3 つのサービスに 4 つのパラメータを渡す。** `MauticCronService` と同じ 4 行（`NightlyStopEnabled: !Ref NightlyStopEnabled` など）を `MauticWebService`・`ChatwootWebService`・`ChatwootWorkerService` の `Parameters` の先頭に足す。
- [ ] **Step 3: 子テンプレート 3 つに定義を足す。** 中身は `git show 6a371bce^:cloud/stacks/services/chatwoot-web.yaml` にある、消す前の定義（Parameters の 4 つ・`Conditions` の `UseNightlyStop`・Resources の `NightlyStopScalableTarget`）と同じにする。違いは既定値（Step 1 と同じ cron）とコメント（サービスごとに、止まっているあいだに何が起きないかを書く: mautic-web＝公開サイトのフォームの受け付け・Mautic の API・メールのリンクの追跡と配信停止のページ、chatwoot-web＝チャットのウィジェットと FAQ ボット、chatwoot-worker＝Webhook〈I-12〉・メールのイベントが朝まで溜まる）。mautic-web は既に `Conditions:` があるので、そこへ `UseNightlyStop` を足す。
- [ ] **Step 4: mautic-cron の既定値とコメントを Step 1 にそろえる**（22 時・3 時 45 分の記述を 0 時・7 時 50 分に。「mautic-web は止めない〈夜間のフォームを受け付ける〉」は消す）。
- [ ] **Step 5: alarms.yaml の 481〜482 行のコメントを直す**（11-25 から chatwoot-web・mautic-web を 0〜7:50 に止めるので、ALB の 503 は毎晩出る。だから対象から外したまま、と書く）。
- [ ] **Step 6: 静的検査。** Run: `cd cloud && sam validate --lint -t template.yaml && for f in stacks/services/{mautic-web,mautic-cron,chatwoot-web,chatwoot-worker}.yaml; do sam validate --lint -t $f || exit 1; done`
  Expected: すべて `is a valid SAM Template`（エラー 0）。
- [ ] **Step 7: 残りを確かめる。** Run: `rg -n "22 時|3 時 45|cron\(0 22|cron\(45 3" cloud/template.yaml cloud/stacks` Expected: 0 件。

### Task 2: 設定スクリプトの案内（`cloud/setup/aws.mjs`・`setup/lib/fix-guides.mjs`）

**Files:**
- Modify: `cloud/setup/aws.mjs:120-151`
- Modify: `setup/lib/fix-guides.mjs:27`

**Interfaces:**
- Consumes: Task 1 の時刻（0:00〜7:50）。
- Produces: `NIGHTLY_STOP_SERVICES = new Set(["mautic-web", "mautic-cron", "chatwoot-web", "chatwoot-worker"])`（export の名前は変えない）。

- [ ] **Step 1:** `NIGHTLY_STOP_SERVICES` を 4 つにし、121・128・140・149 行の時刻を「0 時〜7 時 50 分」に、「3 時 45 分を過ぎてから」を「7 時 50 分を過ぎてから（起動に数分かかるので 8 時以降）」に直す。「夜間の停止が無い」側の文（141・150 行）は、どのサービスにも当てはまらなくなるが、`NIGHTLY_STOP_SERVICES` に入らないサービス（admin-auth など）のために残す。その文の「2026-11-12 から ${c.svc} は止めない」は「このサービスに夜間の停止は無い」に直す。
- [ ] **Step 2:** fix-guides.mjs の 27 行の「昼〈3 時 45 分〜22 時〉」を「8 時〜24 時」に、「Chatwoot が 0 台のまま残る」を「Chatwoot・Mautic が 0 台のまま残る」に、`--only cloud,chatwoot-prod` を `--only cloud,chatwoot-prod,mautic-prod` に直す。
- [ ] **Step 3: 構文の検査。** Run: `node --check cloud/setup/aws.mjs && node --check setup/lib/fix-guides.mjs` Expected: 出力なし・終了コード 0。
- [ ] **Step 4:** Run: `rg -n "3 時 45|22 時" cloud/setup setup/lib` Expected: 0 件。

### Task 3: 公開サイトの受付時間外（`frontend/verdant-virgo`）

**Files:**
- Create: `frontend/verdant-virgo/src/modules/service-hours/index.ts`
- Modify: `frontend/verdant-virgo/src/modules/forms/lib/messages.ts`（`CONSULT_TEXT` に 2 項目）
- Modify: `frontend/verdant-virgo/src/modules/forms/components/ContactForm.tsx`（`Status` 型・送信の処理・表示）
- Modify: `frontend/verdant-virgo/src/modules/chat/lib/messages.ts`（案内の文）
- Modify: `frontend/verdant-virgo/src/modules/chat/lib/chatwoot.ts`（`loadChatwoot`・`openChat`・`showFailureNotice`）
- Modify: `frontend/verdant-virgo/src/modules/chat/components/ChatLoader.astro`（先頭のコメントだけ）
- Modify: `docs/BasicDesign/DesignSpec/website/01-content-spec.md`（§5.1 と §8 に文言、§10 の決定の表に 1 行）
- Modify: `docs/DetailedDesign/02-public-path-flows.md`（4 節と 5 節に受付時間外の段落）

**Interfaces:**
- Produces（`@/modules/service-hours`）:
  - `export const SERVICE_CLOSED_HOURS_JST = { start: 0, end: 8 } as const;`（コメントで `cloud/template.yaml` の `NightlyStopSchedule`・`NightlyStartSchedule` が正本と書く）
  - `export function isOutsideServiceHours(now: Date = new Date()): boolean` — `now.getTime() + 9 時間` の UTC の時（`getUTCHours()`）が `start` 以上 `end` 未満なら true。ブラウザのタイムゾーンに依存しない。
- Produces（`CONSULT_TEXT`）: `closedTitle: '受付時間外です'`、`closedBody:`（Global Constraints のフォームの文）。
- Produces（chat の messages.ts）: `export const CHAT_CLOSED_NOTICE =`（Global Constraints のチャットの文）。

- [ ] **Step 1: 文言を先に仕様書へ足す。** 01-content-spec.md の §5.1 の送信失敗の文の近くに「受付時間外（2026-11-25。ユーザーの決定）」として `closedTitle`・`closedBody` を、§8（チャット）に `CHAT_CLOSED_NOTICE` を、§10 の決定の表に 1 行（0〜8 時は Chatwoot・Mautic を止めるため、フォームとチャットを受付時間外にする。設計書へのリンク）を足す。
- [ ] **Step 2: `service-hours/index.ts` を作る**（上の Interfaces どおり）。
- [ ] **Step 3: フォーム。** `Status` に `"closed"` を足す。
  - 描画: `isOutsideServiceHours()` が true のあいだ、フォームの上に `closedTitle`・`closedBody` の案内（`role="status"`。既存の送信失敗の案内と同じ部品・見た目）を出し、送信のボタンを `disabled` にする。入力欄は使えるままにする。判定は 1 分ごとに更新する（`setInterval` 60 秒。アンマウントで止める）ので、8:00 を過ぎれば押せるようになる。
  - 送信の処理: 入力の検証の後、`wasSentToday` の前に `isOutsideServiceHours()` を判定し直し、true なら `setStatus("closed")` で終える（`markSent`・`submitToMautic` を呼ばない。PostHog のイベントも送らない＝§6 のイベントの定義を変えない）。
- [ ] **Step 4: チャット。**
  - `loadChatwoot()`: 先頭で `isOutsideServiceHours()` が true なら何もしない（`state` は `"idle"` のまま。後で読み込めるように）。
  - `openChat()`: 受付時間外なら、読み込まずに押したボタンの近くに `CHAT_CLOSED_NOTICE` を出して終える。出し方は `showFailureNotice` と同じなので、本文を引数で受け取る形にして共用する（例 `showNotice(near, text)`。メールのリンクは今と同じく `SUPPORT_EMAIL` から作る）。受付時間内なら今の処理（`state` が `"idle"` なら読み込んでから開く）。
  - `ChatLoader.astro` の先頭のコメントに、0〜8 時は読み込まないことを 1 行足す。
- [ ] **Step 5: 公開経路の設計書。** 02-public-path-flows.md の 4 節（`I-07`）と 5 節（`I-08`）に、0〜7:50 は ECS が 0 台で、サイトは 0〜8 時を受付時間外として要求を出さないこと、8 時を過ぎても起動が遅れたときは今の失敗の表示に任せることを足す。
- [ ] **Step 6: 型の検査。** Run: `cd frontend/verdant-virgo && pnpm astro check` Expected: `0 errors`（既存の warning・hint は増やさない。実行前の件数と比べる）。
- [ ] **Step 7: 文言の一致。** Run: `rg -nF "0時から8時までは受け付けを停止しています" docs/BasicDesign/DesignSpec/website/01-content-spec.md frontend/verdant-virgo/src` Expected: 仕様書とコードの 2 か所に同じ文。

### Task 4: 定期実行を手動にする（`ops/schedules`）

**Files:**
- Modify: `ops/schedules/daily-observe-conversations.yaml`・`daily-miswrite-check.yaml`・`daily-observe-analytics.yaml`（`enabled: false`・説明文）
- Modify: `ops/schedules/daily-propose.yaml`（`after`・説明文）
- Modify: `ops/schedules/cycle-collect.yaml`（6 行のコメント・説明文）
- Modify: `ops/schedules/cycle-campaign.yaml`・`campaign-asset-upload.yaml`（説明文）

**Interfaces:**
- Consumes: `loadSchedules(mainCheckout: string): Promise<LoadedSchedules>`（`backend/control-plane/src/definitions/schedules.ts`）で読めること。

- [ ] **Step 1:** 3 本を `enabled: false` にし、`enabled` の上にコメント「2026-11-25 から手動（ユーザーの決定）。0〜7:50 は Chatwoot／Mautic が 0 台のため。8:00 以降に監視アプリの『今すぐ実行』で動かす」を置く。`overview` の「本番の Chatwoot は夜間も止めない（2026-11-12）」は消し、手動であることに置き換える。`cron` は残す（有効に戻すときの目安。コメントで「enabled が false のあいだは使われない」と書く）。
- [ ] **Step 2:** daily-propose の `after` を `daily-observe-seo`・`daily-observe-ops` の 2 つにし、上にコメント（設計書の 3 節: 外した理由、手動で実行した会話・集計の観測は 14 日以内なら根拠に使われる）。`description` と `overview` の「観測 4 本」を「観測 2 本（seo・ops）。会話と集計は手動で実行したときだけ」に直す。
- [ ] **Step 3:** cycle-collect の 6 行のコメントと `overview` に、Mautic を読むのはキャンペーンの項目だけで 7:00 は Mautic が止まっている、その項目は飛ばして続く（実行は failed になる）ので、キャンペーンの項目がある日は 8:00 以降に今すぐ実行し直す、と書く。「夜間停止（22〜3:45）とは関係ない」は消す。
- [ ] **Step 4:** cycle-campaign・campaign-asset-upload の説明に「有効にするときは、0〜7:50 は Mautic が止まっているので、8:00 以降の時刻にするか手動で動かす」を足す（cycle-campaign の 04:00 のコメントにも）。
- [ ] **Step 5: 読み込みの検査。** Run: `cd backend/control-plane && pnpm exec tsx -e 'import { loadSchedules } from "./src/definitions/schedules.ts"; const r = await loadSchedules(process.cwd() + "/../.."); console.log(JSON.stringify(r, (k, v) => (k === "prompt" || k === "overview" ? undefined : v)).slice(0, 4000))'`
  Expected: 例外なし。`daily-observe-conversations`・`daily-miswrite-check`・`daily-observe-analytics` の `enabled` が false、`daily-propose` の `after` が `["daily-observe-seo","daily-observe-ops"]`。`after の … が定義に無い` の WARN が出ない。（`LoadedSchedules` の形が違えば、ジョブの配列を探して同じ点を確かめる。）

### Task 5: 文書（費用・運用・手順）

**Files:**
- Modify: `cloud/README.md`（105〜112 行の 3.1、1144〜1149 行の 4.11、1376 行、1538 行）
- Modify: `ops/README.md`（116 行の段落と、時刻の表に関わる記述）
- Modify: `setup/00-setup-overview.md:415`
- Modify: `onprem/README.md`（`weekly-inquiry-inventory` の記述の近く。538 行）と `middleware/n8n/README.md`（棚卸しのワークフローの説明があれば）
- Modify: `middleware/n8n/workflows/weekly-inquiry-inventory.json` の付箋（`付箋: 棚卸しの範囲` の `content`）だけ — 「本番は 2026-11-25 から非公開にして、8:00 以降に画面から手動で実行する」を 1 行足す。ノードと `active` は変えない（provision は `publish: never` で公開しない）。

**Interfaces:**
- Consumes: Task 1 の時刻、Task 4 の手動のジョブ名。

- [ ] **Step 1: 費用（3.1）。** 次の値に直す（月 730 時間・既存の単価。起動している時間は 1 日 16 時間 10 分＝0.6736）。
  - mautic-web: $44.98 → **$30.30**（毎日 0 時〜7 時 50 分は 0 台）
  - chatwoot-web・chatwoot-worker: $67.47 → **$45.45**
  - mautic-cron: $17.10 → **$15.15**（1 日 16 時間 10 分）
  - 合計: 約 $397 → **約 $358**（消費税込み 約 $394、年 約 $4,730）。見出しの経緯の文に「2026-11-25 に 4 つとも 0 時〜7 時 50 分に止めて、月 $39 前後下がった」を足す。
- [ ] **Step 2: 4.11 の「夜間の停止」を書き直す。** 対象 4 つ・時刻・再開を 7:50 にした理由・止まっているあいだに起きないこと（フォーム・チャット・FAQ ボット・Mautic の API とメールのリンク・Webhook は朝に処理）・公開サイトの受付時間外・手動にした定期実行・**デプロイは 8:00〜24:00**・夜間にデプロイして 0 台のまま残ったときの `aws ecs update-service … --desired-count` の手順（今の①②の説明は残し、時刻を直す）。1376 行・1538 行の時刻と「Chatwoot は止めない」の記述も直す。
- [ ] **Step 3: ops/README の 116 行を書き直す。** 4 つを 0〜7:50 に止める、手動のジョブ 3 本と n8n の棚卸し、daily-propose の `after` を 2 本にしたこと、cycle-collect の扱い。「時刻の決め方」の表に手動の 3 本の扱いが出てくるなら合わせる。
- [ ] **Step 4:** setup/00-setup-overview.md の 415 行を「夜間の停止は 4 つとも有効（0 時〜7 時 50 分。2026-11-25）」に直す。
- [ ] **Step 5:** onprem/README と n8n の README に、本番の `weekly-inquiry-inventory` は公開済みなら非公開にし、月曜の 8:00 以降に画面から手動で実行する、と書く（公開中のままだと 7:00 に Chatwoot の 503 で失敗し、I-21 で「取得の状態」の通知が出る）。
- [ ] **Step 6: 古い記述の残り。** Run: `rg -n "夜間も止めない|3 時 45 分|22 時〜翌|Chatwoot は .*止めない|mautic-web は止めない" --glob '!docs/superpowers/**' --glob '!backend/mautic-system/**' --glob '!middleware/open-seo-main/**' .`
  Expected: 0 件（経緯として過去の日付つきで書いた文は残してよい。その場合は行ごとに確かめる）。

---

## 実装の後に人が行うこと（この計画では行わない）

- `cloud` のデプロイ（**8:00〜24:00 に**）→ `node setup/setup.mjs --target prod --check --only cloud,chatwoot-prod,mautic-prod`。
- 公開サイトのビルドと配信（`cloud/build-site.mjs`・`deploy-site.mjs`）。
- main へのマージ（定期実行の定義は承認済みの main のチェックアウトから読まれる。ADR-18）。
- 本番の n8n で `weekly-inquiry-inventory` が公開済みなら非公開にする。
