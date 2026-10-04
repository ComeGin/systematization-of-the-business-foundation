# 監視アプリ（next-js）

エージェントの定期実行・手動の指示・実行記録（E-15）・誤った書き込みの候補を扱う、オンプレの管理画面。Next.js 16（App Router）に、サーバー側のライブラリ [`backend/control-plane`](../../backend/control-plane/README.md) を取り込み、**1 プロセス**で動かす。設計は `docs/RequirementDefinition/TA/07-onprem-control-plane.md`。

- **`127.0.0.1:3200` にだけバインドする**（`dev` / `start` が `-p 3200 -H 127.0.0.1`）。開発では ngrok で外から開いてよい（ADR-23。`BETTER_AUTH_URL` をその URL にすると、`next.config.ts` がそのホストを `allowedDevOrigins` に入れる）。Next.js の既定の 3000 は Umami と衝突するため 3200 を使う。
- **ログインは Google（Workspace）だけ**（Better Auth の Google プロバイダー。ADR-23）。メールとパスワードのログインは持たない。通すのは `hd`（`GOOGLE_HOSTED_DOMAIN`。既定 `comegin.com`）の ID トークンで、`email_verified` が true、かつ許可リスト `CONTROL_ADMIN_EMAILS`（カンマ区切り）にあるメールだけ。ユーザーは初回のログインで作られる。Google の OAuth クライアントの作り方は `setup/manual-steps.md` の 7.2（承認済みのリダイレクト URI は `<BETTER_AUTH_URL>/api/auth/callback/google`）。
- ブラウザから Claude Code を直接呼ばない。指示はサーバー側（Route Handler）で受け、control-plane が Agent SDK を呼ぶ。ブラウザには経過と結果だけが返る。

## 起動

```bash
# 1. control-plane をビルドする（next-js は backend/control-plane の dist/ を読む）
(cd ../../backend/control-plane && pnpm install && pnpm build)

# 2. 環境変数ファイルを用意する（BETTER_AUTH_SECRET を生成する。冪等。値は表示しない）
dev/init-env.sh
#    CONTROL_MAIN_CHECKOUT・CONTROL_WORKTREE・GOOGLE_CLIENT_ID・GOOGLE_CLIENT_SECRET・CONTROL_ADMIN_EMAILS などは手で設定する（.env.example が正本）。
#    設定スクリプト（node setup/setup.mjs --target dev --only next-js）なら、~/.config/comegin/setup/dev.conf の値から書く

# 3. 開発サーバー
pnpm install
pnpm dev        # http://127.0.0.1:3200
```

`CONTROL_SCHEDULER_ENABLED` の既定は `false`（dev で誤って定期実行しないため）。`false` でもハートビートと S3 への写しの再送は動き、手動の起動は使える。control-plane の設定が不正でもサーバーは起動し、画面に原因（変数名と理由だけ）を出す。

```bash
pnpm typecheck   # next typegen && tsc --noEmit
pnpm lint
```

## 構成

```
instrumentation.ts        サーバー起動時に 1 回だけ。NEXT_RUNTIME === "nodejs" のときだけ control-plane を start()
lib/control-plane.ts      globalThis に 1 つだけ持つ（instrumentation と Route Handler でモジュールの読み込みが別になるため）
lib/auth.ts               Better Auth。DB は CONTROL_DATA_DIR/auth.sqlite（E-15 の e15.sqlite とは別ファイル）
lib/session.ts            ログイン確認。ページは requirePageSession、Route Handler は guardApiRequest
lib/api.ts                Route Handler の共通処理（ログイン → control-plane → 例外の整理）
app/api/auth/[...all]     Better Auth
app/api/runs              GET 一覧 / POST 手動の起動
app/api/runs/[runId]      GET 1 件
app/api/jobs              GET ジョブ一覧
app/api/miswrite-candidates  GET 誤った書き込みの候補
app/{page,login,setup,runs/[runId]}  画面（Cloudscape Design System）
components/               Cloudscape のコンポーネントを使う Client Component
```

- **Route Handler はすべてログイン必須**（未ログインは 401）。状態を変える要求（POST）は `Origin` が自分のホストと同じときだけ受ける（403）。
- 環境変数は `control-plane` の `loadControlPlaneConfig` が検証する。next-js は直接読まない（`BETTER_AUTH_*`・`GOOGLE_*`・`CONTROL_ADMIN_EMAILS` と `CONTROL_DATA_DIR` の解決だけ例外。`lib/auth.ts`）。
- `next.config.ts` の `serverExternalPackages` に `control-plane` と `@anthropic-ai/claude-agent-sdk` を入れて、バンドルせず Node の `require` に任せる（`node:sqlite`・Agent SDK・AWS SDK を使うため）。`node:sqlite` は control-plane の側で開き、next-js には import しない。
- `next build` の間は `instrumentation.ts` は何も起動しない（`NEXT_PHASE`）。
- 開発サーバーを止めると、実行中のエージェントは打ち切られる。落ち方によっては run が `running` のまま残るが、次の起動時に `failure`（「プロセスの停止または再起動で中断された」）に確定する。

## UI

最小の UI。見た目には凝らない。UI は Cloudscape Design System（`@cloudscape-design/components`）で作る。Cloudscape のコンポーネントはクライアント側のフックを使うため、Server Component から直接使わず、`components/` の Client Component 経由にする。以前のスキャフォールドの Tailwind の CSS（`app/globals.css`）は使わないので削除した（`postcss.config.mjs` と Tailwind の依存はスキャフォールドのまま）。

| 画面 | 内容 |
|---|---|
| `/` | 手動の起動、実行記録（E-15。実行中は自動で読み直す）、定期実行のジョブ、誤った書き込みの候補 |
| `/runs/[runId]` | 実行 1 件（要約・対象の ID・失敗分類・費用・S3 の写し） |
| `/login` | Google でのログイン（失敗すると `?error=` 付きで戻り、理由の種類はサーバーのログ `[auth] login refused: …` に残る） |

## 依存と pnpm の方針

`pnpm-workspace.yaml` に `minimumReleaseAge: 10080`・`trustPolicy: no-downgrade`・`blockExoticSubdeps: true` を設定している（他の自作プロジェクトと同じ）。`allowBuilds` はスキャフォールドのまま。除外を入れた場合は、その理由を `pnpm-workspace.yaml` のコメントに書く。

- `trustPolicyExclude` に 3 件（`eslint-import-resolver-typescript@3.10.1`・`semver@6.3.1`・`undici-types@6.21.0`。バージョンまで指定）を入れている。`eslint-config-next@16.3.5` の推移的依存で、既存のロックファイルにも含まれていた。2026-10-04 にユーザー判断で除外した。`eslint-config-next` を上げたら、まず除外を外して確かめる。`minimumReleaseAge` は緩めていない。
- **TODO（2026-10-07 以降）:** Cloudscape は 7 日の期間に収まる版（`@cloudscape-design/components` 3.0.1387・`global-styles` 1.0.70）に固定している。ユーザーが追加した版（3.0.1391 / 1.0.71）へ上げ直す。
- `control-plane` は `link:../../backend/control-plane`。`next.config.ts` の `turbopack.root` を W（`MarketingDepartment/WebsiteOperations`）にしているのは、Turbopack が root の外のファイルを解決しないため（link: の依存を読むには、プロジェクトと依存の親を root にする）。

## 未決定・TODO

- 画面から S3 の写しの再送を起動する操作は無い（起動時・10 分ごと・各実行の終了時に自動で再送する）
- 実行の打ち切り（キャンセル）の操作は無い（`timeout_sec` とプロセスの停止だけ）
- 定期実行の失敗・見送りを誰にどう知らせるか（DD-07 の 8 節）。画面に出すだけでは、見る人がいなければ沈黙と同じ
