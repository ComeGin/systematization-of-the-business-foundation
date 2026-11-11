# 本番のビルド・デプロイ忘れの検知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SAM スタック・Lambda のコード・ECR のイメージ・オンプレの Strapi と n8n のイメージ・公開済みの記事の配信が古くなったら、人が何もしなくても「設定の状況」で ● になり、既存のメールで知らせる。

**Architecture:** デプロイ・ビルドのときにコミットを記録する。記録先は、スタックのパラメータ `DeployedCommit`、ECR の 2 つ目のタグ `rev-<sha>`、Docker のラベル、`build-info.json` の `articles` の 4 つ。確認は、記録と `origin/main` の間で関係するパスが変わったかを `git log` で調べる。1〜4 は `cloud`・`onprem` の `check` の `items` に、5 は control-plane の `drift.ts` の新しいずれ `site-articles` に置く。git の比較は `setup/lib/drift.mjs` に 1 つにまとめる。

**Tech Stack:** Node 24（`.mjs`）・vitest・AWS CLI（読み取りだけ）・AWS SAM・Docker・TypeScript（control-plane・Astro のインテグレーション）・zod

**Spec:** `docs/superpowers/specs/2026-11-11-deploy-drift-detection-design.md`（前提: `docs/superpowers/specs/2026-11-03-setup-status-design.md`）

## Global Constraints

- **テストの作成・実行は、ユーザーの明確な指示があったときだけ**（`.claude/rules/devops-testing.md`）。指示が無ければ、各タスクのテストの手順を飛ばす。代わりに型の検査（`pnpm typecheck`）と `node --check <file>` で確かめる。
- **ビルド・デプロイ（`pnpm build`・`sam build`・`sam deploy`・`docker build`・`docker compose build`・push）は実行しない**（`.claude/rules/build-deploy.md`）。包むスクリプトは書くが、走らせない。`sam validate --lint` はビルドでもデプロイでもないので使ってよい。
- **状態を変える git コマンド（commit・checkout -b など）は使わない**（`.claude/rules/git.md`）。各タスクの最後は、コミットの代わりに `git status --short` と `git diff --stat` で差分を確かめる。
- `.env`・`samconfig.toml`・`secrets/` を Claude のツールで読まない（フックが止める）。人が実行するスクリプトの中で読むのはよい。コマンドの文字列に `.env` を書くとフックが止めるので、`.env` の扱いはスクリプトのファイルに書く。
- 確認は読み取りだけ。status-reader（`cloud/stacks/iam.yaml` の `StatusReaderPolicy`）と control-plane の主体の権限は変えない。読む AWS は `cloudformation describe-stacks`・`ecr describe-images` だけ。
- 根拠（evidence）・画面・メールに秘密値を出さない。samconfig の値・NoEcho のパラメータは出さず、名前だけを出す。版の文字列とコミットは出してよい。
- ずれは `items`（`level: "action"` など）だけに出し、モジュールの `ok` と `notes` の今の判定は変えない（spec 4.1）。
- 関係するパスから除くもの（spec 4.1）: `*.md`・`*.test.*`・`tests/`・`integration/`・`e2e/`。
- 記録が無い（この仕組みより前）ときは ●（`action`）にする。理由と直すコマンドを出す（spec 4.6）。記録のコミットが `origin/main` の履歴に無ければ !（`warn`）。git・AWS・Docker・Strapi に届かなければ例外か `unknown` にし、✓ にしない。
- 文書・コメント・画面の文言は日本語。pnpm 11・Node 24。新しいポートは使わない。

## Review Focus

- **`origin/main` に無いコミットが記録されている**（fetch していない、ブランチからのデプロイ、オブジェクトが無い）: ✓ にも ● にもせず、! と「main で記録付きでデプロイし直す／git fetch する」を出す。テストは Task 1。
- **README やテストだけの変更**: ● にしない。テストは Task 1。
- **未コミットの変更があるままデプロイ・ビルドしようとした**: 包むスクリプトが止まり、記録と実態の食い違いを作らない。テストは Task 3。
- **samconfig の値や NoEcho のパラメータ**: 根拠に値が漏れない（食い違いはパラメータの名前だけ）。テストは Task 4。
- **Strapi の記事が 1 ページ（100 件）を超える、Strapi に届かない、`build-info.json` が古い**: ? か ● になり、✓ にならない。猶予の境目（48 時間ちょうど）も扱う。テストは Task 7・Task 8。

---

### Task 1: git の比較の共通部品

**Files:**
- Create: `setup/lib/drift.mjs`
- Test: `setup/tests/lib/drift.test.mjs`

**Interfaces:**
- Consumes: `ctx.run(cmd, args)`（`setup/lib/core.mjs`。stdout を文字列で返し、失敗で例外）、`ctx.WORKTREE`
- Produces:
  - `export const NON_CODE_EXCLUDES: string[]`。git のパススペックで、spec 4.1 の除くもの（`:(exclude,glob)**/*.md` など）
  - `export async function commitDrift(ctx, { recorded, paths }): Promise<CommitDrift>`。`recorded` は 40 桁、`null`、`"unrecorded"` のどれか。`paths` はリポジトリのルートからの相対パス（除外は内部で足す）
    - `CommitDrift = { kind: "unrecorded" } | { kind: "outside-main", commit } | { kind: "clean", commit } | { kind: "changed", commit, entries: { sha, subject }[] }`。`entries` は新しい順
  - `export async function newestInMain(ctx, commits: string[]): Promise<string | null>`。`origin/main` の履歴にあるもののうち最も新しいもの。`rev-list --count <c>..origin/main` が最小のものを選ぶ
  - `export function describeChanges(entries): string`。例「3 件: 最初 abc1234 件名 〜 最後 def5678 件名」。件名は 50 字で切る。`drift.ts` の書き方に合わせる
  - `export async function uncommittedPaths(repoDir: string, paths: string[], run): Promise<string[]>`。`git -C <repoDir> status --porcelain -- <paths>` の行。包むスクリプトが使う。`run` は `(cmd, args) => Promise<string>`
  - `export async function headCommit(repoDir, run): Promise<string>`

- [ ] **Step 1: 失敗するテストを書く**（`fakeCtx` の `run` を、git のサブコマンドごとの応答に差し替える。`setup/tests/helpers/fake-ctx.mjs`）
  - `it("入力: recorded が null か unrecorded なら kind unrecorded で、git を呼ばない")`
  - `it("入力: merge-base --is-ancestor が 1 を返すと kind outside-main")`
  - `it("入力: log の出力が空なら kind clean")`
  - `it("入力: log の出力が 2 行なら kind changed で entries は 2 件、新しい順")`
  - `it("入力: log の引数に NON_CODE_EXCLUDES と <recorded>..origin/main が入り、git は -C ctx.WORKTREE で呼ばれる")`
  - `it("入力: newestInMain は履歴に無いものを除き、rev-list --count が最小のものを返す")`
  - `it("入力: uncommittedPaths は porcelain の行を返し、空なら []")`
- [ ] **Step 2: 実行して失敗を確かめる** — `cd setup && pnpm vitest run tests/lib/drift.test.mjs`（「Cannot find module」で FAIL）
- [ ] **Step 3: `setup/lib/drift.mjs` を実装する**。git は `ctx.run("git", ["-C", ctx.WORKTREE, ...])`。`merge-base --is-ancestor` の終了コードは、`ctx.run` の例外の `code` で見分ける（1 は履歴に無い、それ以外は例外のまま投げる）。
- [ ] **Step 4: 実行して通ることを確かめる** — 同じコマンドで PASS
- [ ] **Step 5: 差分を確かめる** — `git status --short setup/lib setup/tests/lib`

### Task 2: テンプレートに `DeployedCommit` を足す

**Files:**
- Modify: `cloud/template.yaml`（`Parameters:` 133 行目付近・`Resources:`）
- Modify: `cloud/global/template.yaml`（`Parameters:` 12 行目付近・`Resources:`）

**Interfaces:**
- Produces: どちらのスタックも `Parameters` に `DeployedCommit` を持つ（`Type: String`、`Default: unrecorded`、`AllowedPattern: '^(unrecorded|[0-9a-f]{40})$'`、NoEcho なし）。`AWS::SSM::Parameter` の `DeployedCommitParameter` を持つ（本番は `Name: !Sub '/comegin/${EnvName}/deployed-commit'`、global は `!Sub '/comegin/${EnvName}/global-deployed-commit'`、`Type: String`、`Value: !Ref DeployedCommit`）。Task 4 は `parameterOf(stack, "DeployedCommit")` で読む

- [ ] **Step 1: 2 つのテンプレートにパラメータとリソースを足す**。コメントに目的を書く（「デプロイしたコミットの記録。値が変わるので、リソースに変更が無くても変更セットに必ず 1 件出る。cloud/deploy.mjs が渡す。設定の状況が describe-stacks で読む」）。親テンプレートの `Metadata` の `ParameterGroups` に並びの決まりがあれば合わせる。
- [ ] **Step 2: 検証する** — `cd cloud && sam validate --lint --template-file template.yaml` と `sam validate --lint --template-file global/template.yaml --region us-east-1`（どちらもエラーが無い）。cfn-guard の規則があれば `cloud/README.md` の手順で確かめる。
- [ ] **Step 3: デプロイの主体に `ssm:PutParameter`・`ssm:AddTagsToResource` などが要るかを確かめる**。`cloud/README.md` のデプロイの主体の節と `cloud/stacks/iam.yaml` を読み、足りなければ README の注意に書く（人が SSO の管理者でデプロイするなら不要）。
- [ ] **Step 4: 差分を確かめる** — `git diff --stat cloud/template.yaml cloud/global/template.yaml`

### Task 3: デプロイとイメージのビルドを包むスクリプト

**Files:**
- Create: `cloud/lib/samconfig.mjs`、`cloud/deploy.mjs`、`cloud/images/build-push.mjs`、`cloud/images/chatwoot/upstream.json`、`cloud/images/mautic/upstream.json`
- Modify: `cloud/setup/index.mjs:59-62`（`IMAGES` の `upstreamTag`・`upstreamDigest` を `upstream.json` から読む）
- Test: `setup/tests/cloud/samconfig.test.mjs`、`setup/tests/cloud/deploy.test.mjs`

**Interfaces:**
- Consumes: Task 1 の `uncommittedPaths`・`headCommit`
- Produces:
  - `cloud/lib/samconfig.mjs`
    - `export function parameterOverrides(tomlText: string, env: "default" | "global"): string[]`。`[<env>.deploy.parameters]` の `parameter_overrides` の配列の各要素（`"Key=Value"`）。表が無ければ `[]`
    - `export function withDeployedCommit(overrides: string[], sha: string): string[]`。既存の `DeployedCommit=` を除いてから `DeployedCommit=<sha>` を足す
  - `cloud/images/<製品>/upstream.json` の形は `{ "tag": "...", "digest": "sha256:..." }`。今の値をそのまま移す（chatwoot `v4.18.0`、mautic `7.2.0-apache` と各ダイジェスト）
  - `cloud/deploy.mjs [--config-env global]`。手順は次の順。
    1. 関係するパスに未コミットの変更があれば止める（`cloud/`。default のときは Lambda の 3 パッケージも）。
    2. `HEAD` を取る。
    3. default だけ `sam build` を実行する。
    4. `sam deploy [--config-env global] --parameter-overrides <withDeployedCommit(...) の各要素>` を実行する。
    - cwd は `cloud/`。値は画面に出さない。出してよいのはパラメータの名前の数と、コミットの短い SHA だけ。
  - `cloud/images/build-push.mjs <chatwoot|mautic>`。手順は次の順。
    1. `cloud/images/<製品>` に未コミットの変更があれば止める。
    2. タグを samconfig の `ChatwootImageTag`・`MauticImageTag` から読む。
    3. 次のコマンドで、本来のタグと `rev-<HEAD>` の 2 つを付けてビルドする: `docker build --platform linux/amd64 --label org.opencontainers.image.revision=<HEAD> --build-arg UPSTREAM_TAG --build-arg UPSTREAM_DIGEST -t <ecr>/<repo>:<tag> -t <ecr>/<repo>:rev-<HEAD>`。
    4. 2 つとも push する。
    - ECR へのログインは人が先に行う（案内だけ出す）。
- [ ] **Step 1: SAM CLI の `--parameter-overrides` が samconfig の値を置き換えるのか、合わせるのかを公式の文書で確かめる**（`aws-core:aws-mcp` の `search_documentation`、または SAM CLI の設定ファイルの文書）。合わせるなら `parameterOverrides` の読み込みを外し、`DeployedCommit=` だけを渡す。どちらだったかを `cloud/deploy.mjs` の冒頭のコメントに出典付きで書く。あわせて、`cloud/stacks/ecr.yaml` のタグの不変性（`ImageTagMutability`）で、同じイメージに 2 つ目のタグ `rev-<sha>` を push できるかを ECR の文書で確かめる（できなければ、ここで止めてユーザーに相談する）。
- [ ] **Step 2: 失敗するテストを書く**
  - `parameterOverrides`: 例の TOML（`cloud/samconfig.toml.example` と同じ形。default と global の 2 つの表）から、default は 4 要素、global は `["EnvName=prod"]`。表が無い env は `[]`。
  - `withDeployedCommit`: 既にある `DeployedCommit=unrecorded` を置き換える。
  - `deploy.mjs` の中心を `export async function runDeploy({ env, repoDir, run, readSamconfig })` として切り出し、次を試す。
    - 未コミットの行があると `sam` を呼ばずに止まる（Review Focus 3）。
    - default のときは `sam build` → `sam deploy` の順に呼ぶ。
    - global のときは `sam build` を呼ばず、`--config-env global` を付ける。
    - 渡す引数の末尾が `DeployedCommit=<40 桁>`。
- [ ] **Step 3: 実行して失敗を確かめる** — `cd setup && pnpm vitest run tests/cloud`
- [ ] **Step 4: 実装する**。`upstream.json` を読む小さな関数（`readUpstream(product)`）を `cloud/lib/samconfig.mjs` の隣（`cloud/lib/images.mjs`）に置き、`cloud/setup/index.mjs` の `IMAGES` と `build-push.mjs` の両方がそれを使う。
- [ ] **Step 5: 通ることを確かめる** — 同じコマンドで PASS。`node --check cloud/deploy.mjs cloud/images/build-push.mjs`
- [ ] **Step 6: 差分を確かめる** — `git status --short cloud setup/tests/cloud`

### Task 4: cloud の段階 deploy の items（スタック・Lambda・samconfig との食い違い）

**Files:**
- Modify: `cloud/setup/index.mjs`（`check` の `ctx.phase === "deploy"`。660 行目付近の `return { ok, notes }` に `items` を足す。`mainSteps` は `node cloud/deploy.mjs` に改める）
- Modify: `setup/status/steps.mjs`（`KNOWN_ITEM_KEYS`、P2 の `items`）、`setup/00-setup-overview.md`（P2・4 節）、`cloud/README.md`（4.1・4.2）、`setup/manual-steps.md`、`setup/README.md`
- Test: `setup/tests/modules/cloud-items.test.mjs`（段階 deploy の describe を足す）

**Interfaces:**
- Consumes: Task 1 の `commitDrift`・`describeChanges`、Task 2 の `DeployedCommit`、`parameterOf`（`cloud/setup/aws.mjs`）、`samParameters(ctx)`
- Produces: 次の 4 つの key の items（step は 4 つとも `"P2"`）。
  - `cloud.global-commit`: global スタック。パスは `cloud/global`
  - `cloud.stack-commit`: 本番スタック。パスは `cloud/template.yaml`・`cloud/stacks`
  - `cloud.lambda-code`: 本番スタックの記録と、Lambda のパス `LAMBDA_PATHS` を比べる
  - `cloud.stack-params`: samconfig とスタックの `Parameters` の食い違い。名前だけを出す
  - `LAMBDA_PATHS` は `backend/consent-api`・`backend/admin-auth`・`backend/faq-bot` の、`src`・`package.json`・`pnpm-lock.yaml`・`pnpm-workspace.yaml`・`Makefile`・`tsconfig.json`。テンプレートの `CodeUri` から確かめた 3 パッケージで、存在するものだけを使う。
  - level は `commitDrift` の結果で決める。`unrecorded`・`changed` → `action`、`outside-main` → `warn`、`clean` → `ok`。
  - `stopId` は `cloud:sam-deploy`。直すコマンドは `node cloud/deploy.mjs`、global は `node cloud/deploy.mjs --config-env global`。
- [ ] **Step 1: 失敗するテストを書く**（既存の `healthyAws()` に `Parameters: DeployedCommit` を足す。git は `run` を差し替える）
  - `it("入力: DeployedCommit が unrecorded だと cloud.stack-commit は action で、根拠に「記録が無い」と node cloud/deploy.mjs")`
  - `it("入力: 記録の後に cloud/stacks を変えたコミットが 1 件あると cloud.stack-commit は action で、根拠に短い SHA と件名")`
  - `it("入力: 記録の後の変更が無いと 4 つの key がすべて ok")`
  - `it("入力: Lambda のパスだけが変わると cloud.lambda-code だけが action")`
  - `it("入力: samconfig の ChatwootImageTag とスタックのパラメータが違うと cloud.stack-params は action で、根拠にパラメータの名前があり値が無い")`（Review Focus 4。NoEcho の `****` と `DeployedCommit` は比べない）
  - `it("入力: items が action でも ok と notes は今と同じ")`
- [ ] **Step 2: 失敗を確かめる** — `cd setup && pnpm vitest run tests/modules/cloud-items.test.mjs`
- [ ] **Step 3: 実装する**。git が失敗したとき（`origin/main` が無いなど）は、その item だけ `unknown` にする。
- [ ] **Step 4: カタログと文書を足す**。`KNOWN_ITEM_KEYS` に 4 つの key を P2 で足す。P2 の `items` に 4 行を足す（`kind: "検査"`、`probe: item(<key>)`、`docs: cloud("4.2")`。global は `cloud("4.1")`）。`overviewText` に書いた文字列を、`setup/00-setup-overview.md` の P2 の節にそのまま入れる。文書は spec 6 節のとおり改める（`sam build && sam deploy` → `node cloud/deploy.mjs`、記録の意味、導入の直後の「記録付きでデプロイし直す」）。
- [ ] **Step 5: 通ることを確かめる** — `cd setup && pnpm vitest run tests/modules/cloud-items.test.mjs tests/status/verify-steps.test.mjs`
- [ ] **Step 6: 差分を確かめる** — `git diff --stat`

### Task 5: cloud の段階 images の item（ECR のイメージ）

**Files:**
- Modify: `cloud/setup/index.mjs`（`check` の `ctx.phase === "images"`。`imageSteps` を `node cloud/images/build-push.mjs <製品>` に改める）
- Modify: `setup/status/steps.mjs`（`KNOWN_ITEM_KEYS`、P3）、`setup/00-setup-overview.md`（P3）、`cloud/README.md`（4.7・4.12）、`setup/manual-steps.md`
- Test: `setup/tests/modules/cloud-items.test.mjs`（段階 images）

**Interfaces:**
- Consumes: Task 1 の `commitDrift`・`newestInMain`、Task 3 の `IMAGES`（`upstream.json` から読むもの）
- Produces: item `cloud.image-commit`（step は `"P3"`）。2 つのイメージを見て、level は重いほう、根拠は「Chatwoot: … ／ Mautic: …」。各イメージの比べ方は次のとおり。
  1. `ecr describe-images --image-ids imageTag=<スタックのパラメータのタグ>` の `imageDetails[0].imageTags` から `rev-` で始まるものを集める。
  2. それらの中から `newestInMain` で選んだコミットを記録とする。
  3. その記録と `cloud/images/<製品>` を `commitDrift` で比べる。
  - `rev-` のタグが無ければ `unrecorded`。
- [ ] **Step 1: 失敗するテストを書く**
  - `it("入力: imageTags に rev- が無いと action で「記録が無い」と node cloud/images/build-push.mjs chatwoot")`
  - `it("入力: rev- が 2 つあると newestInMain の結果で比べる")`
  - `it("入力: 記録の後に cloud/images/mautic の upstream.json が変わると action で根拠に Mautic")`
  - `it("入力: 両方 clean なら ok")`
- [ ] **Step 2: 失敗を確かめる** — `cd setup && pnpm vitest run tests/modules/cloud-items.test.mjs`
- [ ] **Step 3: 実装する**（今の `imageExists` の ok・notes は変えない）
- [ ] **Step 4: カタログと文書を足す**（Task 4 Step 4 と同じ手順。docs は `cloud("4.7")`）
- [ ] **Step 5: 通ることを確かめる** — `cd setup && pnpm vitest run tests/modules/cloud-items.test.mjs tests/status/verify-steps.test.mjs`
- [ ] **Step 6: 差分を確かめる** — `git diff --stat`

### Task 6: オンプレの Strapi・n8n のイメージと n8n の版

**Files:**
- Modify: `onprem/strapi/compose.yml`（`build.labels`）、`onprem/n8n/compose.yml`（`build.labels`）
- Modify: `onprem/setup/index.mjs`（`check` に `items`、`apply` の案内を `GIT_COMMIT=$(git rev-parse HEAD) docker compose build` に改める）
- Modify: `setup/status/steps.mjs`（`KNOWN_ITEM_KEYS`、P6）、`setup/00-setup-overview.md`（P6）、`onprem/README.md`（「2. Strapi」「3. n8n」・常駐の節）、`setup/manual-steps.md`
- Test: `setup/tests/modules/onprem-items.test.mjs`（新規）

**Interfaces:**
- Consumes: Task 1 の `commitDrift`・`describeChanges`、`ctx.readEnvFile`（`setup/lib/core.mjs`）
- Produces:
  - ラベル: Strapi は `org.opencontainers.image.revision: ${GIT_COMMIT:-}`。n8n は同じものに加えて `com.comegin.n8n-version: ${N8N_VERSION}`・`com.comegin.n8n-digest: ${N8N_DIGEST}`。
  - item `onprem.strapi-image`（step は `"P6"`）: イメージ `comegin/strapi-onprem:local` のラベルのコミットを、`backend/strapi-system`・`onprem/strapi` と比べる。さらに、動いているコンテナのイメージ ID がそのイメージの ID と違えば `action`（「ビルドしたが再起動していない」。`sudo systemctl restart comegin-strapi`）。
  - item `onprem.n8n-image`（step は `"P6"`）: 同じ考え方で、パスは `onprem/n8n/Dockerfile`・`onprem/n8n/compose.yml`。
  - item `onprem.n8n-version`（step は `"P6"`）: `onprem/n8n/.env` から `N8N_VERSION`・`N8N_DIGEST`・`N8N_RUNNERS_DIGEST` の 3 つだけを取り出す（ほかの値は捨て、どこにも出さない）。次と比べる。
    - 動いている n8n のラベル（`com.comegin.n8n-version`・`com.comegin.n8n-digest`）と runners のイメージの `RepoDigests` と違う → `action`
    - `git show origin/main:onprem/n8n/.env.example` の同じ 3 つと違う → `action`。雛形のほうが古い（`.env` が新しい）ときは `warn`。〔判断: 作る人〕新旧は版の文字列の比較で決め、決められなければ `action`
    - runners の版のタグと n8n の版が違う → `action`
  - Docker は `ctx.run("docker", ["image", "inspect", ...])`・`["inspect", ...]` を使う。コンテナは `docker compose -f <compose> ps -q <サービス名>` で引く（サービス名は compose の定義から確かめる）。Docker が無い、または届かないときは、その item を `unknown` にする。
- [ ] **Step 1: 失敗するテストを書く**（`run` を docker・git の応答に差し替える。`.env` は一時ディレクトリ〈`setup/tests/helpers/temp-home.mjs`〉に作り、`ctx.WORKTREE` をそこに向ける）
  - `it("入力: ラベルの revision が空だと onprem.strapi-image は action で「記録が無い」と GIT_COMMIT=… docker compose build")`
  - `it("入力: 記録の後に backend/strapi-system/src を変えたコミットがあると action")`
  - `it("入力: イメージは新しいがコンテナのイメージ ID が違うと action で「再起動していない」")`
  - `it("入力: .env の N8N_VERSION が動いている n8n のラベルと違うと onprem.n8n-version は action で、根拠に版の文字列が出て、.env のほかの値（例 DB_POSTGRESDB_PASSWORD の値）は出ない")`
  - `it("入力: .env.example が新しく .env が古いと action、逆なら warn")`
  - `it("入力: docker が無いと 3 つの item が unknown で、ok と notes は今と同じ")`
- [ ] **Step 2: 失敗を確かめる** — `cd setup && pnpm vitest run tests/modules/onprem-items.test.mjs`
- [ ] **Step 3: compose のラベルと `onprem/setup/index.mjs` を実装する**
- [ ] **Step 4: カタログと文書を足す**（P6。docs は `onprem(ON_STRAPI)`・`onprem(ON_N8N_BOOT)`）
- [ ] **Step 5: 通ることを確かめる** — `cd setup && pnpm vitest run tests/modules/onprem-items.test.mjs tests/status/verify-steps.test.mjs`。`docker compose -f onprem/strapi/compose.yml config --quiet` は `.env` が要るので実行しない。ラベルの書き方は compose の仕様（`build.labels`）を context7 で確かめる。
- [ ] **Step 6: 差分を確かめる** — `git diff --stat`

### Task 7: 公開サイトのビルドに記事の一覧を記録する

**Files:**
- Create: `frontend/verdant-virgo/src/modules/build-info/articles.ts`
- Modify: `frontend/verdant-virgo/src/modules/build-info/index.ts`（`BuildInfo` と `astro:build:start`）、`frontend/verdant-virgo/README.md`、`cloud/README.md`（4.14 の `build-info.json` の説明）
- Test: `frontend/verdant-virgo/tests/modules/build-info/articles.test.ts`

**Interfaces:**
- Produces:
  - `export interface BuildArticle { readonly slug: string; readonly publishedAt: string; readonly updatedAt: string }`
  - `export async function fetchBuildArticles(env: { STRAPI_URL?: string; STRAPI_API_TOKEN?: string }, fetchImpl = fetch): Promise<BuildArticle[] | null>`。`/api/articles?status=published&fields[0]=slug&fields[1]=publishedAt&fields[2]=updatedAt&sort[0]=slug:asc&pagination[page]=<n>&pagination[pageSize]=100` を `meta.pagination.pageCount` まで読み、slug の昇順で返す。失敗したら `null`。
  - `BuildInfo` に `readonly articles: readonly BuildArticle[] | null` を足す。一覧は `astro:build:start` で取り（環境変数は `blog/integration.ts` と同じく Vite の `loadEnv`）、`astro:build:done` で書く。
  - control-plane（Task 8）はこの JSON の `articles` を読む。
- [ ] **Step 1: 失敗するテストを書く**
  - `it("入力: 2 ページに分かれた応答を 1 つの配列にし、slug の昇順で返す")`（Review Focus 5）
  - `it("入力: Strapi が 500 を返すと null")`
  - `it("入力: STRAPI_URL が無いと fetch を呼ばずに null")`
  - `it("入力: documentId などほかのフィールドは結果に入らない")`
- [ ] **Step 2: 失敗を確かめる** — `cd frontend/verdant-virgo && pnpm vitest run tests/modules/build-info`
- [ ] **Step 3: 実装する**。取れなかったときは `logger.warn` を出し、ビルドは止めない。
- [ ] **Step 4: 通ることを確かめる** — 同じコマンドで PASS。`pnpm astro check` は時間がかかるので、型は `pnpm exec tsc --noEmit -p .` で見る（あれば。無ければ省く）。
- [ ] **Step 5: 差分を確かめる** — `git diff --stat frontend/verdant-virgo`

### Task 8: control-plane のずれ `site-articles`（48 時間の猶予）

**Files:**
- Modify: `backend/control-plane/src/status/drift.ts`（`DriftResult` の id と新しい関数）、`backend/control-plane/src/status/service.ts`（410〜425 行目の `Promise.all` に足す。n8n と同じく `productDue` で引き継ぐ）、`backend/control-plane/src/status/catalog.ts:23`・`backend/control-plane/src/status/store.ts:86`（id の enum と、引き継ぐ時刻の任意のフィールド）
- Modify: `setup/status/verify-steps.mjs:41`（`DRIFT_IDS`）、`setup/status/steps.mjs`（P12 に行を足す）、`setup/00-setup-overview.md`（P12）、`backend/control-plane/README.md`
- Test: `backend/control-plane/tests/status/drift.test.ts`、`backend/control-plane/tests/status/service.test.ts`

**Interfaces:**
- Consumes: Task 7 の `build-info.json` の `articles`、`StrapiClient.listPublishedArticles`（`backend/control-plane/src/integrations/strapi.ts`）、`this.config.strapi`（`{ baseUrl, readToken, writeToken } | null`）
- Produces:
  - `DriftResult.id` に `"site-articles"` を足す。`DriftResult` に任意の `firstSeen?: Record<string, string>` を足す（取り下げの slug → 最初に見つけた JST の ISO 8601。store の zod にも `z.record(z.string(), z.string()).optional()`）。
  - `export async function checkSiteArticles(opts: { siteUrl: string; strapi: { baseUrl: string; readToken: string } | null; previous: DriftResult | undefined; now: Date; signal: AbortSignal }): Promise<DriftResult>`。判定は次のとおり。
    - `strapi` が `null` → `manual`
    - `build-info.json` が 404、または `articles` のキーが無い → `action`「記録が無い。次の配信で消える」
    - `articles: null` → `unknown`
    - Strapi に届かない → `unknown`
    - 差を数える。公開・更新の記事は、`max(publishedAt, updatedAt)` から 48 時間を過ぎたものがあれば `action`（ちょうど 48 時間は過ぎたものとして数える）。
    - 取り下げの記事は、`previous.firstSeen` の時刻から 48 時間で数える。無ければ `now` から数える。
    - 差はあるが 48 時間以内のものだけなら `ok`。根拠は「配信待ち N 件（猶予中。最も古いものの期限 <JST>）」。
    - 差が無ければ `ok`。
    - 根拠の slug は最大 5 件で、超えたら「ほか N 件」。直し方は「周の承認画面の配信の項目を承認して配信する（無ければ毎日 00:00 に作られる）」。
  - 定数 `ARTICLE_GRACE_MS = 48 * 60 * 60 * 1000`。
- [ ] **Step 1: 失敗するテストを書く**（`drift.test.ts` の `fetchMock` の書き方に従う）
  - `it("入力: 公開から 47 時間の記事だけが未配信なら ok で、根拠に「配信待ち 1 件（猶予中」")`
  - `it("入力: 公開から 48 時間ちょうどの記事が未配信なら action で、根拠に slug")`
  - `it("入力: updatedAt が build-info と違い、49 時間たっていれば action（更新）")`
  - `it("入力: 取り下げは previous.firstSeen から数え、結果の firstSeen に引き継ぐ")`
  - `it("入力: build-info に articles のキーが無いと action、null なら unknown")`
  - `it("入力: strapi が null なら manual で、fetch を呼ばない")`
  - `it("入力: Strapi が 503 なら unknown")`
  - `it("入力: 未配信が 7 件なら slug は 5 件と「ほか 2 件」")`
  - `service.test.ts`: `it("productDue でない回は site-articles の前回の結果を引き継ぐ")`
- [ ] **Step 2: 失敗を確かめる** — `cd backend/control-plane && pnpm vitest run tests/status/drift.test.ts tests/status/service.test.ts`
- [ ] **Step 3: 実装する**。evidence は今と同じく `mask` を通る。
- [ ] **Step 4: カタログと文書を足す**。3 か所の `DRIFT_IDS` に `site-articles` を足す。P12 に `{ id: "P12.articles", title: "公開済みの記事を 48 時間以内に配信する", who: "人・画面", kind: "検査", probe: drift("site-articles"), docs: cloud("4.14") }` を足す。`overviewText` は 00-setup-overview の P12 に足す文の一部にする。
- [ ] **Step 5: 通ることを確かめる** — `cd backend/control-plane && pnpm vitest run tests/status && pnpm typecheck`。`cd setup && pnpm vitest run tests/status/verify-steps.test.mjs`
- [ ] **Step 6: 差分を確かめる** — `git diff --stat`

### Task 9: 全体の確認と導入の手順

**Files:**
- Modify: `setup/00-setup-overview.md`（4 節の「スクリプトが確かめる範囲」と、導入の直後に ● がまとめて出ることと、記録付きでデプロイし直す順番）、`cloud/README.md`・`onprem/README.md` の参照の整合

- [ ] **Step 1: 全体のテストと型の検査を実行する** — `cd setup && pnpm vitest run`、`cd backend/control-plane && pnpm vitest run && pnpm typecheck`、`cd frontend/verdant-virgo && pnpm vitest run tests/modules/build-info`（すべて PASS）
- [ ] **Step 2: `node setup/setup.mjs --target prod --list` が今までどおり動くことを確かめる**（`--check` は AWS に読み取りで触れるので、ユーザーの許可があるときだけ）
- [ ] **Step 3: 導入の手順を 00-setup-overview に書く**。次の 8 つの ● を、それぞれ記録付きでやり直すと消えることを書く。
  - global・本番スタック・Lambda（`node cloud/deploy.mjs` の 2 回）
  - Chatwoot・Mautic のイメージ（`build-push.mjs` → タグを上げて `deploy.mjs`）
  - Strapi・n8n のイメージ（`GIT_COMMIT=… docker compose build` → 再起動）
  - 記事（次の配信）
- [ ] **Step 4: 差分の全体を確かめる** — `git status --short`・`git diff --stat`
