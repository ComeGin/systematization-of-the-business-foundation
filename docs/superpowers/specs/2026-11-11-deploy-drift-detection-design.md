# 本番のビルド・デプロイ忘れの検知（クラウドのスタック・Lambda・イメージ・オンプレのイメージ・記事の配信）

- 作成: 2026-11-11
- 前提の設計: `docs/superpowers/specs/2026-11-03-setup-status-design.md`（監視アプリの「設定の状況」。特に 5.1・5.3・6.2）
- 印の意味は前提の設計に合わせる: ● 更新が必要（`action`）／! 警告／? 確かめられない（`unknown`）／◇ 人が確かめる（`manual`）／✓

## 1. 何のためか

PR をマージした後や設定を変えた後に、本番へのビルド・デプロイが必要なのに**誰も気づかないまま**、本番が古いコードや古い設定で動き続けることがある。これが問題（ユーザーの言葉: 「気づかないままなのが問題」）。

2026-11-11 時点で、気づける仕組みがあるのは次のものだけである。

- 監視アプリ（control-plane の `dist/`・next-js の `.next/`）: `frontend/next-js/setup/prod/index.mjs` の `buildProblems`
- 本番の MCP の `dist`: `ops/setup/index.mjs`
- 公開サイトのコードの変更: `backend/control-plane/src/status/drift.ts` の `site-redeploy`（配信中の `build-info.json` のコミットと `origin/main` を比べる）
- 本番の n8n のワークフロー: 同じファイルの `n8n-workflows`

次の 5 つ（と、同じ穴の 1 つ）は、作られているか・状態が正常かしか見ていない。そのため、古くなっていても ✓ になる。

1. **本番の SAM スタック**（`cloud/template.yaml`・`cloud/stacks/**`）と **global スタック**（`cloud/global/`）の変更が、`sam deploy` されていない
2. **Lambda のコード**（faq-bot・consent-api・admin-auth・admin-auth-ops。`sam build` でまとめるもの）の変更が、デプロイされていない
3. **ECR のイメージ**（`cloud/images/chatwoot`・`cloud/images/mautic`）の変更が、ビルド・プッシュ・デプロイされていない
4. **オンプレの本番の Strapi のイメージ**（`onprem/strapi/compose.yml` が `backend/strapi-system` からビルドする）の変更が、ビルド・再起動されていない
   - 〔判断: 設計者〕同じ穴の **オンプレの本番の n8n のイメージ**（`onprem/n8n/Dockerfile`）も同じ仕組みで含める
5. **公開済みの記事が、配信中のサイトに入っていない**。改善ループの `published-article-check` は毎晩、周の承認画面に「配信」の項目を作る。しかし、承認されないまま放っておかれると、どこにも ● が出ない

## 2. 決めたこと（ユーザーの決定）

- **知らせ方は、既存の「設定の状況」（`/setup-status`）と既存のメール（6.2 の SNS `comegin-ops-alert`）で十分。** 新しい通知の経路は作らない。
- **「本番で動いているもののコミット」は、デプロイ・ビルドのときに記録する**（時刻で比べる方式は採らない）。理由: 時刻で比べると、コメントや README だけの変更で `sam deploy` が「変更なし」になり、消せない ● が残る。消せない ● はいずれ無視され、「気づかないまま」に戻る。人が打つ `sam deploy`・`docker build`・`docker compose build` に引数（または包むスクリプト）が増えることは受け入れる。
- **5（記事）も「設定の状況」の ● とメールにする。** 周の承認画面の「配信」の項目とは別に出す。
- **5 には 48 時間の猶予を置く**（2026-11-11。builder check の後の決定）。公開・更新から 48 時間たっても配信されていない記事があるときだけ ● にする。普段の流れ（公開 → その夜 0 時に配信の項目 → 人が承認）では承認までの約 1 日 ● が残り、週 2 回の記事作成でほぼ常に ● になり、無視されるため。
- **オンプレの n8n のバージョンの更新も検知する。ファイルは移さず、追跡しない `onprem/n8n/.env` を読んで比べる**（同上）。

## 3. やること・やらないこと

### やること（目標）

- 1〜5 のそれぞれが古くなったら、人が何もしなくても、1 時間以内に「設定の状況」で ● になり、既存の決まり（前提の設計の 6.2）どおりメールが届く。
- 根拠（evidence）に**何が変わったか**（コミットの短い SHA・件名・PR 番号。記事なら slug）と、**何を実行すれば直るか**（コマンドと正本の節）を出す。今の `site-redeploy` と同じ書き方にする。
- 1〜4 は、同じ結果を `node setup/setup.mjs --target prod --check` でも見られる（最初の問い「設定スクリプトがビルド・デプロイの必要性を検知できるか」への答え）。5 は今の `site-redeploy` と同じく「設定の状況」だけに出る（Strapi の読み取りの設定を control-plane が持つため。5 節）。

### やらないこと（非目標）

- 自動でビルド・デプロイ・再起動はしない。知らせるだけ。
- 開発環境（`--target dev`）のずれは見ない。
- 記録が無い過去のデプロイの「本当のコミット」は推測しない（4.6）。

### こうなったら失敗（反目標）

- 消せない ● が出る。正しく記録付きでデプロイし直したのに ● が残る。
- 確かめられないときに ✓ を出す。AWS・Docker・Strapi に届かない、記録が読めないときは ? にする（✓ にも ● にもしない）。
- 監視アプリや設定スクリプトが本番に書き込む。確認は読み取りだけ（前提の設計の反目標と同じ）。
- 状況の確認専用の主体（`comegin-prod-status-reader`）や監視アプリの主体（`comegin-prod-control-plane`）の権限を広げる。下の 4 の作りは、既にある `cloudformation:DescribeStacks`・`ecr:DescribeImages` だけで読めるようにする。
- 秘密値が根拠・画面・メールに出る。NoEcho のパラメータの値、トークンなどは出さない。

## 4. 確かめ方

### 4.1 共通の考え方

- 本番で動いているものに、**作ったときの 40 桁のコミット**を記録しておく。その記録から `origin/main` までの間に、**関係するパスを変えたコミット**（`git log <記録>..origin/main -- <パス>`）があれば ● にする。比べ方は `drift.ts` の `checkSiteRedeploy` にそろえる。
  - 記録のコミットが `origin/main` の履歴に無い（ブランチからデプロイした、など）とき: `git merge-base --is-ancestor` で見分ける。〔判断: 設計者〕マージ前のブランチからデプロイし、その後にマージした場合は、マージで記録のコミットが履歴に入るので比べられる。それでも履歴に無ければ ! 警告にし、「main 以外からのデプロイ。main で記録付きでデプロイし直すと消える」と出す。
  - **関係するパス**から、明らかにコードでないもの（`*.md`・テスト〈`*.test.*`・`tests/`・`integration/`・`e2e/`〉）を除く。除いたものだけの変更では ● にしない。
  - `origin/main` を新しくするのは、今と同じく監視アプリの `fetchMain`（1 時間ごと）。設定スクリプトを人が直接 `--check` したときは、人が fetch した `origin/main` と比べる（今の `next-js-prod` と同じ）。
- **記録付きでデプロイし直せば、必ず ✓ に戻る**ことを保証する。リソースに変更が無くても記録だけは新しくなるようにする（4.2）。
- 根拠の PR 番号は、`drift.ts` の `pullRequestOf` と同じ方法で引く（取れなければコミットだけ）。〔判断: 設計者〕1〜4 はモジュールの `check`（子プロセス）で動き、GitHub のトークンを渡していないので、コミットだけでよい。
- 〔判断: 設計者〕ずれは `items`（`level: "action"`）だけに出し、モジュール全体の `ok` は変えない（今の手順の判定〈モジュールの `ok` を見る段階〉を、ずれで巻き添えにしないため）。

### 4.2 SAM スタック（1）と Lambda のコード（2）

**記録の方法**:
- 親テンプレート（`cloud/template.yaml`）と global テンプレート（`cloud/global/template.yaml`）に、パラメータ `DeployedCommit`（文字列。既定値は空。NoEcho にしない）を足す。
- パラメータを変えるだけでは、変更セットが空になり、記録が残らないおそれがある。そこで、必ず変更が生まれるように、値を小さなリソースに渡す。〔判断: 設計者〕案は `AWS::SSM::Parameter`（`/comegin/<env>/deployed-commit`。String。秘密値ではない）。変更セットに出るのはこの 1 件だけにする。SSM パラメータは空の値を受け付けないので、既定値が空のときは条件で作らないか、仮の値（例 `unrecorded`）にする（作る人が決める。仮の値は 4.6 の「記録が無い」として扱う）。スタックのタグで記録する方式は採らない（タグを変えると全リソースが変更セットに並び、人が変更セットを確かめる妨げになる）。
- 読むのは `cloudformation:DescribeStacks` の `Parameters` の `DeployedCommit`（status-reader に既にある権限）。SSM を読む権限は足さない。
- **デプロイのコマンドは包むスクリプトにする**: `cloud/deploy.mjs`（〔判断: 設計者〕名前と形は作る人が決めてよい）。人が `cd cloud && sam build && sam deploy` の代わりに実行する。
  - SAM CLI のコマンドラインの `--parameter-overrides` は、`samconfig.toml` の `parameter_overrides` を**丸ごと置き換える**（作る人は SAM CLI 1.154 以上で確かめる。合わさるなら、読み込みは要らない）。そのため、スクリプトが `samconfig.toml` の該当の環境（`default`・`global`）の `parameter_overrides` を読み、`DeployedCommit=<HEAD>` を足して渡す。
  - `samconfig.toml` は秘密値を含みうるので、値を画面に出さない。Claude Code のフックは `samconfig.toml` を読めないが、人が実行するスクリプトは読める。
  - 関係するパスに未コミットの変更があるときは止める（記録が実態と食い違うため）。
  - `sam build` は省けない（`cloud/README.md` の 4.2）。スクリプトが `sam build` → `sam deploy` の順で実行する。global は `--config-env global`。`confirm_changeset = true` は今のまま（人が変更セットを確かめる）。

**比べるパス**:
- スタック（1）: `cloud/template.yaml`・`cloud/stacks/**`（本番スタック）、`cloud/global/**`（global スタック）
- Lambda のコード（2）: テンプレートの `CodeUri` が指すパッケージ（作る人がテンプレートから特定する。faq-bot・consent-api・admin-auth・admin-auth-ops を想定）の `src/**`・`package.json`・パッケージごとのロックファイルと `pnpm-workspace.yaml`・`Makefile`・`tsconfig.json`（`sam build` の入力）。faq-bot は Astro の `faq.json` を実行時に読むので、`faq-export` は含めない（builder check で確かめた）
- 1 と 2 は同じコマンドで直るが、別の項目にして根拠を分ける（何が古いかがわかるように）。

**あわせて見るもの**:
- `samconfig.toml` の `parameter_overrides`（作業ツリーの追跡しないファイル。`cloud/setup/index.mjs` の `samParameters` と同じく `ctx.WORKTREE` から読む）と、デプロイ済みスタックの `Parameters` の食い違い。例: タグを書き換えたのに `sam deploy` していない。NoEcho（値が `****`）のものと `DeployedCommit` は比べない。根拠にはパラメータの**名前だけ**を出す（値は出さない）。

### 4.3 ECR のイメージ（3）

**記録の方法**:
- イメージをビルドするときに、ラベル `org.opencontainers.image.revision=<HEAD>` を付ける。さらに、同じイメージに**2 つ目のタグ `rev-<40 桁のコミット>`** を付けてプッシュする。ECR のタグは上書きできないが、別のタグを足すことはできる（作る人が今のリポジトリの設定〈タグの不変性〉で確かめる）。
- 読むのは `ecr:DescribeImages`（status-reader に既にある権限）。スタックの `Parameters` の `ChatwootImageTag`・`MauticImageTag` のタグで引き、同じイメージの `imageTags` の `rev-*` からコミットを取る。`rev-*` が複数あるとき（中身が同じでキャッシュから同じダイジェストになった）は、`origin/main` の履歴の中で最も新しいものを使う。
- ラベルは補助（`docker inspect` で人が確かめられる）。監視は ECR のタグだけで判定する（ラベルを読むにはマニフェストの取得の権限が要るため）。
- ビルド・プッシュの手順（`cloud/setup/index.mjs` の `imageSteps` と `cloud/README.md` の 4.7・4.12）を、ラベルと `rev-` のタグを含むものに改める。〔判断: 設計者〕手で打つ行が増えるので、`cloud/deploy.mjs` と同じく包むスクリプト（例 `cloud/images/build-push.mjs <chatwoot|mautic>`）にしてよい。

**比べるパス**: `cloud/images/<製品>/**`（`.dockerignore` で除くものは除く。ただし `Dockerfile` 自体はビルドの入力なので残す）。上流のタグとダイジェスト（今は `cloud/setup/index.mjs` の `IMAGES` の `upstreamTag`・`upstreamDigest`）も、変われば作り直しが要る。〔判断: 設計者〕これを `cloud/images/<製品>/` の中のファイル（例 `upstream.json`）に移し、設定スクリプトとビルドのスクリプトの両方がそこを読む。そうすれば、比べるパスに上流の変更も含まれる（`cloud/setup/index.mjs` の無関係な変更で ● にしないため）。

**あわせて見るもの**: タグを上げてプッシュしたが `sam deploy` していない、は 4.2 の「samconfig とスタックのパラメータの食い違い」で ● になる。プッシュを忘れたタグは、今の `imageExists` の検査（段階 images）で ● になる。

### 4.4 オンプレの本番のイメージ（4。Strapi と n8n）

**記録の方法**:
- `onprem/strapi/compose.yml`・`onprem/n8n/compose.yml` の `build` に `labels: { org.opencontainers.image.revision: ${GIT_COMMIT:-} }` を足す。人は `GIT_COMMIT=$(git rev-parse HEAD) docker compose build` でビルドする（`onprem/README.md` と `onprem/setup/index.mjs` の案内を改める）。〔判断: 設計者〕包むスクリプトにするかは作る人が決めてよい。未コミットの変更があるときに止めるのは 4.2 と同じ。
- 読むのは `onprem/setup/index.mjs` の `check` で、`docker image inspect`（イメージのラベル）と `docker inspect`（動いているコンテナが使っているイメージの ID）。どちらも読み取りだけ。

**判定**:
- イメージのラベルのコミットから `origin/main` までに、関係するパスの変更があれば ●「ビルドし直しが要る」。
  - Strapi: `backend/strapi-system/**`（`*.md` などは 4.1 のとおり除く。ビルドの入力に入らないもの〈`.dockerignore` で除くもの〉も除く）、`onprem/strapi/**`
  - n8n: `onprem/n8n/Dockerfile`・`onprem/n8n/compose.yml`・ビルドの入力のファイル
- **n8n のバージョンの更新**（ユーザーの決定。ファイルは移さない）: n8n を作り直す理由のほとんどはバージョンの更新で、その値は追跡しない `onprem/n8n/.env` にあり git の差分に出ない。`onprem/setup/index.mjs` の `check` が `.env` から `N8N_VERSION`・`N8N_DIGEST`・`N8N_RUNNERS_DIGEST` の 3 つだけを読み（ほかの行は読まない・値は画面に出さない。版の文字列は秘密値ではないので根拠に出してよい）、次を比べる。
  - **動いているコンテナ**（`docker inspect`。n8n はイメージのタグ・ラベル、runners は pull したイメージのダイジェスト）と違う → ●「`.env` を上げたが作り直し・再起動していない」
  - **`onprem/n8n/.env.example`**（`origin/main` のもの）と違う → ●「雛形は上がったが `.env` が古い」。〔判断: 設計者〕雛形が古く `.env` が新しい（人が先に上げた）ときは ! 警告（雛形の更新を促す）
  - n8n と runners の版の一致の決まり（`N8N_VERSION` を揃える）が崩れていれば ●
- **イメージは新しいのに、動いているコンテナが古いイメージ**（ビルドしたが `systemctl restart comegin-strapi` していない）も ● にする。根拠は「ビルドしたが再起動していない」。
- ラベルが無い・空なら ●「記録が無い」（4.6）。

### 4.5 公開済みの記事の配信（5）

**記録の方法**:
- 公開サイトのビルドで、`build-info.json`（`frontend/verdant-virgo/src/modules/build-info`）に、**ビルドが取り込んだ公開済みの記事の一覧**を足す。形は `articles: { slug, publishedAt, updatedAt }[]`（slug の昇順）。どれも公開サイトで既に公開している情報なので、公開される JSON に入れてよい。documentId・下書きは入れない。
  - 一覧は**ビルドの始め**に、ビルドが記事を読むのと同じ Strapi（`STRAPI_URL`・同じトークン）から取る。ビルドの途中で公開された記事は、本文に入っていても一覧には入らない。この場合は余計な ● が出るだけで、配信し直せば消える。逆に「一覧にあるのに本文に無い」は起きないので、取りこぼす側には倒れない。
  - 取れなかったときは `articles: null` にする（ビルドは止めない。`commit: null` と同じ扱い）。
- `_build.json`（周の配信の確認用）は今のまま。

**判定**（control-plane の `drift.ts` に新しいずれ `site-articles` を足す。`site-redeploy` とは別の項目にする）:
- 本番の Strapi の公開済みの記事の一覧（`StrapiClient.listPublishedArticles`。改善ループの `CONTROL_STRAPI_URL`・`CONTROL_STRAPI_READ_TOKEN`）と、配信中の `build-info.json` の `articles` を slug で比べ、足りない（公開）・`updatedAt` が違う（更新）・余っている（取り下げ）を出す。根拠に件数と slug（最大 5 件。超えたら「ほか N 件」）を出す。
- **48 時間の猶予**（ユーザーの決定）: 公開・更新の記事は、Strapi の `updatedAt`（公開なら `publishedAt` との新しいほう）から 48 時間たったものがあるときだけ ●。48 時間以内のものだけなら ✓ のまま、根拠に「配信待ち N 件（猶予中。最も古いものの期限 <日時 JST>）」と添える。周の記録は判定に使わない。
  - 取り下げ（Strapi に無いのに配信中のサイトにある）は、取り下げた時刻が Strapi から取れない。〔判断: 設計者〕最初に見つけた時刻を前回の結果（`driftResults` の保存）から引き継いで 48 時間を数える。引き継げないとき（初回・記録の消失）は、見つけた時刻から数える。
- 直し方の案内: 周の承認画面の「配信」の項目（`published-article-check` が作る）を承認して配信する。項目がまだ無ければ、次の夜（毎日 00:00）に作られることを書く。〔判断: 設計者〕周の項目の状態（承認待ち・承認済み など）がわかるなら、根拠に添えてよい。
- `build-info.json` に `articles` が無い（この機能より前のビルド）なら ●「記事の一覧の記録が無い。次の配信で消える」。`articles: null` なら ?。
- Strapi の読み取りの設定が無いなら ◇（`n8n-workflows` のキーが無いときと同じ扱い）。Strapi に届かないなら ?。
- Strapi は製品の API なので、前提の設計の 5.1 どおり 1 時間に 1 回まで（今の定期の確認の間隔と同じ）。

### 4.6 記録が無いとき（この仕組みより前のデプロイ）

- 今のスタック・イメージには記録が無い。これらは ●「記録が無い（この仕組みより前のデプロイ）。記録付きでデプロイし直すと消える」とし、直すコマンドを出す。? にはしない（確かめられないのではなく、記録付きのデプロイという人の作業が残っているため）。公開サイトの `build-info.json` が 404 のときの扱いと同じ。
- 〔判断: 設計者〕導入の直後は、この ● がまとめて出る（スタック 2・Lambda・イメージ 2・オンプレ 2・記事）。1 回ずつ記録付きでデプロイし直すことを、導入の手順として `setup/00-setup-overview.md` と `cloud/README.md` に書く。

## 5. どこに置くか

| ずれ | 置き場 | 段階・手順の番号（〔判断: 設計者〕作る人がカタログと整合させる） |
|---|---|---|
| 1 スタック（本番・global）・samconfig との食い違い | `cloud/setup/index.mjs` の `check` の `items` | 段階 deploy（P2） |
| 2 Lambda のコード | 同上 | 段階 deploy（P2） |
| 3 ECR のイメージ | 同上 | 段階 images（P3） |
| 4 オンプレの Strapi・n8n のイメージ | `onprem/setup/index.mjs` の `check` の `items` | 段階 apps（オンプレの手順の番号） |
| 5 記事の配信 | `backend/control-plane/src/status/drift.ts` の新しいずれ `site-articles` | P12 |

- 1〜4 はモジュールの `check` に置く。こうすると、設定スクリプトの `--check` と「設定の状況」（監視アプリが子プロセスで `--check --json` を実行する。前提の設計の 5.1）の両方に同じ結果が出る。
- 5 は Strapi の読み取りの設定を control-plane が持っているので、`site-redeploy` の隣に置く。ずれの id の一覧（`setup/status/verify-steps.mjs`・`backend/control-plane/src/status/catalog.ts`・`store.ts` の enum）と手順の一覧（`setup/status/steps.mjs`）に足す。
- 新しい `items` の `key` と手順の対応は、手順の一覧（`setup/status/steps.mjs`）と `setup/00-setup-overview.md` に足し、今の「両方にあることを機械で確かめる仕組み」（`verify-steps.mjs`）が通るようにする。
- 確かめられないとき（AWS の認証が使えない、など）は、今の決まり（`setup/lib/core.mjs` の冒頭。`AwsUnavailable`・`settleAwsUnavailable`）どおり例外か ? にする。Docker に届かないときも同じ。

## 6. 文書の更新

- `cloud/README.md`: 4.2（デプロイは `cloud/deploy.mjs` で。記録の意味）・4.1（global も同じ）・4.7・4.12（イメージのラベルと `rev-` のタグ）、4.14 の近く（`build-info.json` の `articles`）
- `onprem/README.md`: Strapi・n8n のビルドは `GIT_COMMIT` を付けて。ビルドの後の再起動
- `setup/00-setup-overview.md`: P2・P3・オンプレの手順・P12 の行と、4 節（スクリプトが確かめる範囲）。導入の直後の「記録付きでデプロイし直す」（4.6）
- `setup/manual-steps.md`（止まる id の早見表。案内の文を変えたもの）、`setup/README.md`
- `frontend/verdant-virgo/README.md`（`build-info.json` の形）、`backend/control-plane/README.md`（ずれの一覧）
- `ops/README.md` は変えない（定期実行は増やさない）

## 7. 作る人に任せること

- 包むスクリプトの名前・言語（Node を想定。既存の `setup` と同じく `.mjs`）・引数の形、`samconfig.toml` の読み方（TOML の配列の読み取り）。
- `DeployedCommit` を渡すリソースの種類（4.2 の SSM パラメータは案。変更セットに確実に 1 件出て、権限を広げずに `DescribeStacks` で値が読めればよい）。
- Lambda・イメージの「関係するパス」の正確な一覧（`sam build`・`docker build` の入力から決める）と、除くパスの細部。
- `items` の `key` の名前、根拠の文の細部（今の `site-redeploy` に倣う）。
- `build-info.json` の記事の一覧の取り方（ビルドが記事を読む処理と共有するか、別に取るか）。4.5 の「取りこぼす側に倒れない」が守られればよい。

## 8. 制約（リポジトリの決まり）

- テストの作成・実行は、ユーザーの明確な指示があるまで行わない（`.claude/rules/devops-testing.md`）。ビルド・デプロイも同じ（`.claude/rules/build-deploy.md`）。テンプレートを変えた後の本番への `sam deploy`、イメージのビルド・プッシュは人が行う。
- 状態を変える git コマンドは使わない（`.claude/rules/git.md`）。
- 監視アプリ・設定スクリプトの確認は読み取りだけ。status-reader と control-plane の主体の権限は変えない（前提の設計の 10 節）。
- 文書・コメント・画面の文言は日本語。
