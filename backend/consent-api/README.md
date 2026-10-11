# consent-api

公開サイトの Cookie 同意の状態を、サーバー側に**追記だけ**で記録する小さな API（開発ポート 3104。本番は ALB 配下の ECS on Fargate、ホスト名 `consent.comegin.com`）。
Node 標準の `http` と Valkey クライアント（`ioredis`）だけで作り、DB は持たない。

設計の出典: `docs/DetailedDesign/02-public-path-flows.md` の 3.3・3.4・4.4・8 節、`docs/RequirementDefinition/TA/06-aws-runtime.md` の 4.8・5.3・5.5、`docs/BasicDesign/DesignSpec/website/01-content-spec.md` の 8.1.1。

訪問者のリクエストを**直接受ける**自作コードなので、できることを意図的に絞っている。パスを増やさない（TA-06 の 5.3 の許可リストは 2 本だけ）。

## API

| メソッドとパス | 用途 |
|---|---|
| `POST /v1/consent` | 同意の記録。本文は `{"state":"granted"}` か `{"state":"denied"}` だけ（撤回も `denied` として 1 件積む） |
| `GET /v1/consent` | Cookie の識別子の最新の状態を返す |
| `OPTIONS /v1/consent` | CORS のプリフライト |
| `GET /healthz` | ALB のターゲットのヘルスチェック用。**外部に出すパスの許可リストには入れない** |

### POST /v1/consent

- `Content-Type: application/json` 必須（違えば 415）。本文は 1 KiB まで（超えれば 413）。
- 本文のキーは `state` だけ。ほかのキー（識別子・ポリシーの版・時刻）が付くと 400。**識別子・版・時刻はサーバーが決める**ため、クライアントが送った値は受け取らない。
- `Origin` が `SITE_URL` と一致しなければ 403（`Origin` なしも 403）。
- 成功すると 201 と `Set-Cookie`。本文は `{"state","policy_version","recorded_at"}`。識別子は本文に返さない（Cookie だけが持つ）。
- 識別子の扱い:
  - Cookie の識別子が**形式に合い、かつ Valkey にその Stream がある**ときだけ引き継ぐ（同じ訪問者の撤回・再同意は同じ Stream に積まれる）。
  - それ以外はサーバーが新しく発行する。訪問者が好きな識別子で記録を作ったり、他人の記録に積んだりできないようにするため（識別子は 128 ビットの乱数で、推測できない）。
- 1 つの識別子に積める記録は 200 件まで。超えると 429（`too_many_records`）。
  - 理由: 同じ Cookie を持ち回って連打されても、Stream が際限なく伸びないようにするため。WAF のレート制限（consent は最も厳しくする。TA-06 の 5.5）とは別の保険。
  - **トリミングはしない**ので、すでにある記録は消えない。通常の利用で 200 件に届くことはない（同意を押す回数は数回）。
- Valkey に届かない・2 秒以内に返らないときは 503（`unavailable`）。**このとき Cookie は書かない。**

### GET /v1/consent

- Cookie が無い・形式が不正・Stream が無いときは `{"state":"unset"}`。Cookie は書かない。
- あるときは `{"state","policy_version","recorded_at"}`。サーバーの現行の版（`CONSENT_POLICY_VERSION`）と違う版に同意していたかどうかは、呼び出し側が `policy_version` を比べて決める。
- `Origin` が付いているときは `SITE_URL` と一致しなければ 403。

### エラー

どれも `{"error":"<コード>"}`。`invalid_json` `invalid_body` `unsupported_media_type` `payload_too_large` `origin_not_allowed` `method_not_allowed` `not_found` `too_many_records` `unavailable` `internal`。
応答にはすべて `Cache-Control: no-store` を付ける。

## Cookie `comegin_consent`

| 属性 | 値 |
|---|---|
| 値 | `s=<granted\|denied>&v=<ポリシーの版>&id=<識別子>`（例 `s=granted&v=2026-10-01&id=eAd5tbgdBQH8cAOA_oELjQ`）。エンコードは不要で、JS は `new URLSearchParams(値)` でそのまま読める |
| `Max-Age` | 31536000（12 か月） |
| `Path` | `/` |
| `Secure` | あり |
| `SameSite` | `Lax` |
| `HttpOnly` | **付けない**（ページの描画時に JS が同期で読むため。DD-02 の 3.3） |
| `Domain` | `COOKIE_DOMAIN`（本番 `.comegin.com`）。空なら付けない（開発の localhost） |

氏名・メールアドレス・IP・PostHog の `distinct_id` は入れない。

## CORS

- `SITE_URL`（1 つのオリジン）だけを許し、`Access-Control-Allow-Credentials: true` を付ける。**`*` は使わない**。
- プリフライトは許したオリジンにだけ 204（`GET, POST, OPTIONS`、`Content-Type`、`Max-Age=600`）。ほかのオリジンは 403。
- `Vary: Origin` を付ける。

## Valkey のキー設計

- `${VALKEY_KEY_PREFIX}c:<識別子>` が、訪問者ごとの Stream。`XADD` で `state` `at`（ISO 8601）`policy`（ポリシーの版）の 3 項目を足すだけで、更新も削除もしない。
- **TTL も MAXLEN も付けない**（保持期間が未決のあいだは、増え続ける側に倒す。TA-06 の 11 節）。
- 接頭辞（既定 `consent:`）で Chatwoot・Mautic と名前空間を分ける。

```bash
# 記録の確認（ローカル）
docker compose exec valkey valkey-cli XRANGE consent:c:<識別子> - +
```

## 起動（ローカル）

```bash
pnpm install
cp .env.example <環境変数ファイル>   # 名前は .env.example のコメントを参照。SITE_URL などを確認する
docker compose up -d --build         # consent-api は 127.0.0.1:3104 だけに開く。Valkey はホストに公開しない
curl -i localhost:3104/healthz
```

- Valkey はホストに公開していないため、`pnpm dev` で直接動かす場合は別途 Valkey を用意して `VALKEY_URL` を合わせる。普段は compose の中で動かす。
- Valkey は AOF で永続化する（同意の記録は失うと取り戻せないため）。
- `Secure` 付きの Cookie は、ブラウザでは `localhost` に限って http でも保存される。curl では `-c` / `-b` で確かめられる。
- 公開サイトの開発サーバー（Astro、4321）から呼ぶときは `SITE_URL=http://localhost:4321`、`COOKIE_DOMAIN` は空にする。

```bash
# 例: 同意を記録し、Cookie を持って状態を取り出す
curl -si -c jar.txt -H 'Origin: http://localhost:4321' -H 'Content-Type: application/json' \
  -d '{"state":"granted"}' localhost:3104/v1/consent
curl -s -b jar.txt -H 'Origin: http://localhost:4321' localhost:3104/v1/consent
```

## 環境変数

`.env.example` が正本。

| 変数 | 内容 | secret |
|---|---|---|
| `HOST` / `PORT` | 既定 `0.0.0.0` / `3104` | |
| `VALKEY_URL` | `rediss://host:6379`（開発は `redis://valkey:6379`） | |
| `VALKEY_PASSWORD` | AUTH トークン（開発は空でよい） | ✔ |
| `VALKEY_KEY_PREFIX` | 既定 `consent:` | |
| `SITE_URL` | CORS で許すオリジン（1 つ）。パスが付いていてもオリジンだけに正規化する | |
| `COOKIE_DOMAIN` | 既定は空（本番は `.comegin.com`） | |
| `CONSENT_POLICY_VERSION` | 現行の文面の版（例 `2026-10-01`）。英数字と `. _ -` の 32 文字以内 | |

設定が不正なときは、変数名と理由だけを stderr に出して終了する（値は出さない）。

## 運用上の注意

- **ログは stderr に JSON の 1 行**（時刻・メソッド・パス・ステータス・所要時間）。識別子と IP は出さない。
- `GET /healthz` は**プロセスが生きているかだけ**を見て、Valkey は見ない。Valkey の瞬断でタスクが ALB から外れ、全リクエストが 503 になるのを避けるため。Valkey が落ちたときは、各リクエストが 503 を返す。
- Node の keep-alive は 65 秒（ALB のアイドルタイムアウト 60 秒より長い）。短いと ALB が再利用した接続の切断で 502 が出る。
- SIGTERM で処理中のリクエストを終えてから Valkey を閉じる（ECS の停止に合わせる。猶予 10 秒）。
- アプリ側のレート制限は持たない。連打の抑制は ALB の WAF（consent は最も厳しいしきい値）と、上の 1 識別子あたり 200 件の上限だけ。
- 本番のバックアップは取らない（TA-06 の 4.5・4.8）。ElastiCache を失うと、記録は戻らない（訪問者はバナーを出し直されて再び同意する）。

## 未決定事項

- **記録の保持期間（TTL）。** 今は TTL を付けない。TTL を付けると同意の証跡が消え、付けないと増え続ける。DA-05 の保持期間の表と削除請求の対象に含めるかを合わせて決める（TA-06 の 11 節。判断者 `R1`）。決まったら、Stream の末尾の記録の時刻から `EXPIRE` する方式か、定期的に古い識別子を消す方式かを選ぶ。
- **サイト側の JS でも Cookie を書くか**（DD-02 の 8.4）。今は **POST が成功したときだけ consent-api が Cookie を書く**ため、consent-api か ALB が落ちているあいだは同意が成立せず、新しい訪問者の PostHog と Chatwoot が止まる。サイト側でも Cookie を書く二重化にすると、落ちていても同意は成立し、サーバー側の記録だけが欠ける。二重化するなら、Cookie の値の形式（上の表）をサイト側の実装と共有する。
- **同意率の指標**（DD-02 の 9 節）。全体の件数を持つキーは作っていない。記録の件数で代える場合は、識別子ごとの Stream を走査するか、別に集計用のキーを足す。
- 同意の記録に対応する型（`E-xx`）は未定（DD-02 の 8.5）。決まるまで連携点の番号は振らない。
