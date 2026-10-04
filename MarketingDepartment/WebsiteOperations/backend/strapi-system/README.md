# 🚀 Getting started with Strapi

Strapi comes with a full featured [Command Line Interface](https://docs.strapi.io/dev-docs/cli) (CLI) which lets you scaffold and manage your project in seconds.

### `develop`

Start your Strapi application with autoReload enabled. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-develop)

```
npm run develop
# or
yarn develop
```

### `start`

Start your Strapi application with autoReload disabled. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-start)

```
npm run start
# or
yarn start
```

### `build`

Build your admin panel. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-build)

```
npm run build
# or
yarn build
```

## ⚙️ Deployment

Strapi gives you many possible deployment options for your project including [Strapi Cloud](https://cloud.strapi.io). Browse the [deployment section of the documentation](https://docs.strapi.io/dev-docs/deployment) to find the best solution for your use case.

```
yarn strapi deploy
```

## 📚 Learn more

- [Resource center](https://strapi.io/resource-center) - Strapi resource center.
- [Strapi documentation](https://docs.strapi.io) - Official Strapi documentation.
- [Strapi tutorials](https://strapi.io/tutorials) - List of tutorials made by the core team and the community.
- [Strapi blog](https://strapi.io/blog) - Official Strapi blog containing articles made by the Strapi team and the community.
- [Changelog](https://strapi.io/changelog) - Find out about the Strapi product updates, new features and general improvements.

Feel free to check out the [Strapi GitHub repository](https://github.com/strapi/strapi). Your feedback and contributions are welcome!

## ✨ Community

- [Discord](https://discord.strapi.io) - Come chat with the Strapi community including the core team.
- [Forum](https://forum.strapi.io/) - Place to discuss, ask questions and find answers, show your Strapi project and get feedback or just talk with other Community members.
- [Awesome Strapi](https://github.com/strapi/awesome-strapi) - A curated list of awesome things related to Strapi.

---

<sub>🤫 Psst! [Strapi is hiring](https://strapi.io/careers).</sub>

---

## このリポジトリでの運用メモ（本番向けの構成）

### 本番の構成（ECS on Fargate。ALB が TLS を終端する）

- イメージ: `docker build -t strapi-system .`（多段・非 root・`strapi start`）。環境変数はタスク定義から渡す。必須の変数は `.env.example`
- データベース: `DATABASE_CLIENT=postgres`（`DATABASE_SSL=true`。パスワードと鍵類は Secrets Manager から注入）
- `PUBLIC_URL`（`https://cms.comegin.com`）と `PROXY=true` が必須。無いと管理画面が Secure Cookie を発行できずログインできない
- ヘルスチェック: `GET /_health`（204）。コンテナのポートは 1337

### メディアのアップロード（`config/plugins.ts`）

- `UPLOAD_PROVIDER=local`（既定。`public/uploads`）／ `aws-s3`（`UPLOAD_S3_BUCKET` と `UPLOAD_S3_REGION` が必須）
- aws-s3 の認証は ECS のタスクロール。アクセスキーを環境変数に置かない。タスクロールには、バケットとその配下への `s3:PutObject` `s3:GetObject` `s3:DeleteObject` `s3:ListBucket` が要る
- バケットは公開しない（BucketOwnerEnforced＝ACL 無効）。Strapi が応答の URL を署名付き URL（有効 1 時間）に直す条件は `ACL === 'private'` だが、ACL を付けた PUT は BucketOwnerEnforced では拒否される。そのため `providerOptions` では `'private'`、`actionOptions` のアップロードでは `ACL: undefined` に上書きして避けている
- **実際の S3 では未確認。** デプロイ後に画像を 1 枚アップロードして、(1) 保存できること、(2) 管理画面で表示できること、(3) Content API の応答の URL が署名付きでビルドから取得できること、を確かめる（TA-06 の 11 節の確認事項）

### 記事のイベント（`src/index.ts`。DD-04 の `I-01`）

- `article_created` / `article_published` / `article_updated` は DB のライフサイクル、`article_unpublished` と `article_deleted` は Document Service のミドルウェアが 1 操作 1 件で送る
- Strapi 5 は非公開化で公開版の行を削除し、記事の削除では下書きと公開版の 2 行を削除する。DB のライフサイクルだけだと、非公開化が `article_deleted` になり、削除が 2 件になる。ミドルウェアの最中の `afterDelete` は送らない（Document Service を通らない削除だけ保険として送る）
- PostHog への送信は 5 秒で打ち切る（`src/posthog.ts`）。リトライはしない
