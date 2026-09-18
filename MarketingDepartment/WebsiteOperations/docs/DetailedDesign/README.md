# 詳細設計

`RequirementDefinition/` の 4 層（BA / DA / AA / TA）が「何を作るか」を決めたのに対し、この文書群は **「システムとシステムをどう繋ぐか」** を実装着手できる粒度まで下ろしたものである。

出発点は **AA-02 の連携点カタログ（`I-01`〜`I-24`。うち `I-14` は廃止したため実質 23 本。`I-22`〜`I-24` は 2026-09-18 に OpenSEO の採用で追加）** と **AA-04 のループ 6 段階**。その 2 つに、実装に必要な次の 7 項目を与えるのがこの層の仕事にあたる。

- ペイロードのスキーマ（項目名・型・必須）
- 冪等キーの具体（何をキーにし、どこに保存し、いつまで保持するか）
- リトライの可否・回数・間隔
- タイムアウトの数値
- 失敗時の記録先と、記録する分類
- 観測点（どこを見れば失敗に気づけるか）
- 状態遷移の主体と実行手段

## この文書群の読み方

**AA-02 と AA-04 を先に読む。** この層は上位層の内容を再掲せず、ID（`I-xx` / `E-xx` / `CAP-xx` / `R1`〜`R4`）で参照する。同じことを 2 か所に書くと、片方だけ更新されて食い違うためである。

**分け方は「経路の性質」であって「実装の順」ではない。** AA-02 の 1.3 が公開経路と運用経路をセキュリティ境界として分離しているので、ファイルの境界をその線に合わせた。**ファイル境界がそのまま到達可能性の境界になる**（公開経路のファイルに書かれた連携からは、運用経路の連携に到達できない）。実装の順で読みたい場合は下の「着手順との対応」を使う。

### 状態について

**実装状態（`実装済み` / `未配線` / `未着手`）の正本は AA-02 のカタログであり、ここでは繰り返さない。** 代わりにこの層は**詳細設計の完成度**という別の軸で状態を持つ。

| 値 | 意味 |
|---|---|
| `仕様確定` | この文書だけで実装に着手できる |
| `条件付き` | 仕様は確定したが、実行の前に外部の作業（手動設定・アカウント発行・承認）が 1 つ以上要る |
| `前提待ち` | 上位層の未決定事項が解けるまで仕様を確定できない |

## 索引

| ファイル | 内容 |
|---|---|
| [01-flow-specification-rules.md](01-flow-specification-rules.md) | **横断規約。** フロー仕様の書式、相関 ID、失敗分類、リトライ、冪等キー、タイムアウト、`E-13` の状態遷移 |
| [02-public-path-flows.md](02-public-path-flows.md) | **公開経路。** ブラウザが発信元の 4 本（`I-05` `I-06` `I-07` `I-08`） |
| [03-operation-path-flows.md](03-operation-path-flows.md) | **運用経路。** エージェントが発信元の 5 本（`I-03` `I-04` `I-16` `I-17` `I-22`）。**`I-22` は OpenSEO の MCP**（ホスト内で閉じる） |
| [04-server-to-server-flows.md](04-server-to-server-flows.md) | **サーバ間通知。** ブラウザもエージェントも介さない 9 本（`I-01` `I-02` `I-11` `I-12` `I-18` `I-19` `I-21` `I-23` `I-24`）。**`I-21` は Amazon SNS への通知、`I-23` は DataForSEO（費用が発生する）** |
| [05-build-and-delivery-flows.md](05-build-and-delivery-flows.md) | **ビルドと配信。** `I-09` `I-10` `I-20` |
| [06-proposal-loop-flows.md](06-proposal-loop-flows.md) | **提案と承認。** `I-13` `I-15` と、ループ 6 段階の実行仕様。**`I-14` の廃止**（通知は GitHub の PR に一本化）。**`I-15` は OpenSEO 経由に変更** |
| [07-failure-and-degradation.md](07-failure-and-degradation.md) | **異常系。** トンネル断・欠測・二重送信の検出仕様と縮退運転 |

## 連携点とファイルの対応

AA-02 のカタログ 24 本すべての行き先。**どの連携も必ず 1 つのファイルに属する**（漏れの検査に使う）。廃止した `I-14` も、廃止したこと自体を追えるように行を残す。

| # | 連携（AA-02） | ファイル | 詳細設計の完成度 | 確定を止めているもの |
|---|---|---|---|---|
| `I-01` | Strapi → PostHog（記事イベント） | [04](04-server-to-server-flows.md) | `仕様確定` | — |
| `I-02` | Strapi → PostHog（例外） | [04](04-server-to-server-flows.md) | `仕様確定` | — |
| `I-03` | エージェント → Chatwoot（MCP） | [03](03-operation-path-flows.md) | `仕様確定` | — |
| `I-04` | エージェント → Mautic（MCP） | [03](03-operation-path-flows.md) | `仕様確定` | — |
| `I-05` | ブラウザ → Umami | [02](02-public-path-flows.md) | `条件付き` | Umami のサイト登録（`websiteId` の取得）／ngrok の常設 |
| `I-06` | ブラウザ → PostHog | [02](02-public-path-flows.md) | **`前提待ち`** | **同意取得の実装手段（DA-03 の未決定事項）** |
| `I-07` | ブラウザ → Chatwoot ウィジェット | [02](02-public-path-flows.md) | `条件付き` | Web サイト受信箱の作成（`website_token` の取得）／ngrok の常設 |
| `I-08` | ブラウザ → Mautic フォーム | [02](02-public-path-flows.md) | `条件付き` | Mautic のフォーム作成／ngrok の常設 |
| `I-09` | Strapi → Astro（ビルド） | [05](05-build-and-delivery-flows.md) | `条件付き` | Strapi に公開記事が 1 件以上あること／`SITE_URL` の設定 |
| `I-10` | Astro → Lighthouse CI | [05](05-build-and-delivery-flows.md) | `仕様確定` | — |
| `I-11` | Mautic → n8n（Webhook） | [04](04-server-to-server-flows.md) | `条件付き` | n8n のワークフロー作成（`承認` 分類・`R1`） |
| `I-12` | Chatwoot → n8n（Webhook） | [04](04-server-to-server-flows.md) | `条件付き` | 同上 |
| `I-13` | n8n → GitHub（起票） | [06](06-proposal-loop-flows.md) | `条件付き` | 同上／GitHub の細粒度トークン発行 |
| `I-14` | ~~n8n → Chatwoot（社内メモ）~~ | [06 の 3 節](06-proposal-loop-flows.md) | **`廃止`** | **通知は GitHub の PR に一本化**（`R1` の 2026-09-17 の決定）。Chatwoot は顧客対応の用途に限る |
| `I-15` | Search Console → **OpenSEO** → 観測エージェント | [06](06-proposal-loop-flows.md) | `条件付き` | ドメインプロパティの登録と所有権確認・OAuth クライアントの発行（**人間の作業**）。**配信ホスト名には依存しなくなった**（2026-09-18） |
| `I-16` | エージェント → Strapi（`strapi-mcp`） | [03](03-operation-path-flows.md) | `仕様確定` | —（ADR-07 でリスク受容済み。権限は Strapi 側の API トークンで絞る） |
| `I-17` | エージェント → Umami（MCP） | [03](03-operation-path-flows.md) | `仕様確定` | —（同上。ただし `I-05` が通るまで空を返す） |
| `I-18` | Mautic → PostHog（書き戻し） | [04](04-server-to-server-flows.md) | **`前提待ち`** | **越境の可否（DA-03・DA-05 の未決定事項）。決まるまで実装しない** |
| `I-19` | Chatwoot → Mautic（email 突合） | [04](04-server-to-server-flows.md) | `条件付き` | `I-08` と `I-07` の双方が通り、突合対象が生まれること |
| `I-20` | Astro `dist/` → 配信先 | [05](05-build-and-delivery-flows.md) | `条件付き` | 配信ホスト名の確定／デプロイの承認（`R1`） |
| **`I-21`** | **n8n → Amazon SNS →（メール）運用者** | [04 の 8 節](04-server-to-server-flows.md) | `条件付き` | SNS のトピック作成／**購読の確認（受信者の手作業）**／通知専用 IAM ユーザーの発行 |
| **`I-22`** | **エージェント → OpenSEO（MCP）** | [03 の 6 節](03-operation-path-flows.md) | `条件付き` | `comegin.com`・日本・日本語のプロジェクトの作成／エージェント定義の許可リスト（ADR-10）。**MCP 設定の付け替えは 2026-09-18 に済んだ** |
| **`I-23`** | **OpenSEO → DataForSEO** | [04 の 9 節](04-server-to-server-flows.md) | `仕様確定` | —（API キー設定済み。月次予算の監視手段だけが TA-05 の未決定事項） |
| **`I-24`** | **OpenSEO → 公開サイト（サイト監査）** | [04 の 10 節](04-server-to-server-flows.md) | `条件付き` | 公開サイトが存在すること（`I-20`） |

**`前提待ち` は 2 本だけ**（`I-06` と `I-18`）。どちらも技術的な不明点ではなく、**個人データの扱いに関する上位層の判断待ち**である（同意の取り方と、越境の可否）。`I-14` は廃止したため、**残る 21 本は仕様として確定できた**。

## 着手順との対応

AA-02 の 4 節の着手順を、この文書群の節に対応させる。

| 順 | やること | 読む節 |
|---|---|---|
| **0** | ngrok の常設トンネル | [02 の 1 節](02-public-path-flows.md)（経路の定義）／[07 の 2 節](07-failure-and-degradation.md)（死活監視） |
| 1 | `I-05` Umami トラッカー | [02 の 2 節](02-public-path-flows.md) |
| 2 | `I-09` Astro ← Strapi | [05 の 1 節](05-build-and-delivery-flows.md) |
| 3 | `I-10` Lighthouse CI の蓄積 | [05 の 2 節](05-build-and-delivery-flows.md) |
| 4 | `I-08` CTA フォーム | [02 の 5 節](02-public-path-flows.md) |
| 5 | `I-06` PostHog トラッカー | [02 の 3 節](02-public-path-flows.md)（**`前提待ち`**） |
| 6 | `I-15` Search Console（OpenSEO 経由） | [06 の 4 節](06-proposal-loop-flows.md)／[03 の 6.3](03-operation-path-flows.md) |
| 7 | `I-11` `I-12` webhook → n8n | [04 の 3 節・4 節](04-server-to-server-flows.md) |
| 8 | `I-13` 提案の起票（通知は GitHub の PR） | [06 の 2 節・3 節](06-proposal-loop-flows.md) |
| **9** | **`I-21` 通知（Amazon SNS）** | [04 の 8 節](04-server-to-server-flows.md)（仕様）／[07 の 6 節](07-failure-and-degradation.md)（縮退運転） |
| **並行** | **`I-22` `I-23` OpenSEO の調査**（どの手順にも依存しない） | [03 の 6 節](03-operation-path-flows.md)／[04 の 9 節](04-server-to-server-flows.md) |

**ループを最初に 1 周させる最短経路**（AA-04 の 5.2）に必要なのは `I-10` と [06 の 5 節](06-proposal-loop-flows.md) だけで、上の表のどの手順にも依存しない。

## この層で新たに決めた 6 件

AA には無く、実装着手には不可欠だったもの。すべて [01-flow-specification-rules.md](01-flow-specification-rules.md) にある。

| # | 決めたこと | 節 |
|---|---|---|
| 1 | **相関 ID（ULID）を導入し、`E-13` の必須項目 `agent_run_id` の空欄を暫定で埋める** | [01 の 3 節](01-flow-specification-rules.md) |
| 2 | **失敗分類を 9 値に固定し、`empty_but_ok` を成功として扱う** | [01 の 4 節](01-flow-specification-rules.md) |
| 3 | **再試行の可否を失敗分類から決める**（`permission_denied` は再試行しない。**費用が発生する連携はすべての分類で再試行しない**） | [01 の 5 節](01-flow-specification-rules.md) |
| 4 | **冪等キーを 4 本（`I-08` `I-11` `I-12` `I-13`）に与える** | [01 の 6 節](01-flow-specification-rules.md) |
| 5 | **タイムアウトを上流の打ち切りより内側に置く**（Chatwoot は 12 秒） | [01 の 7 節](01-flow-specification-rules.md) |
| 6 | **`E-13` の状態遷移を、遷移ごとの到達可能性つきで表にする** | [01 の 8 節](01-flow-specification-rules.md) |

## 書式の規約

`docs/README.md` の規約をそのまま継承する（日本語・常体、日本語と英数字の間に半角スペース、箇条書きは `-` 固定、図は Mermaid、1 図 7±2 ノード、未確定は各ファイル末尾の「未決定事項」節へ）。この層で追加する規約は 4 つ。

- **1 連携点 = 1 節。** 節の冒頭に必ず仕様表を置き、その下にシーケンス図・ペイロード・設計判断を書く。表の項目は [01 の 2 節](01-flow-specification-rules.md) のテンプレートで固定する。
- **数値を必ず入れる。** タイムアウト・リトライ回数・保持期間は「適切に」と書かない。実データが無くて決められない場合は**暫定値を入れて根拠を併記し**、未決定事項にも上げる（AA-04 の 3.1 の上限値と同じ扱い）。
- **AA の判断を書き換えない。** この層で上位層の決定と矛盾する記述が必要になった場合は、書き換えずに未決定事項として上げる。
- **シーケンス図の participant は 5 本まで。** C4 ではないが、判読性の理由は同じ。

## 上位層から引き継いだ未決定事項のうち、詳細設計を止めているもの

各ファイルの未決定事項節には、その文書で新たに生じたものだけを書く。ここには**上位層の未決定が直接この層をブロックしているもの**を集約する。

| 項目 | 何が書けないか | 判断者 | 出典 |
|---|---|---|---|
| **同意取得の実装手段** | `I-06` の初期化タイミングと、同意状態の保存先が決まらない | `R1` `R3` | DA-03 |
| **PostHog への越境の可否** | `I-18` を設計できない（キーの形すら決められない。email のハッシュも個人データとして越境する） | `R1` | DA-03・DA-05 |
| **`E-15 AgentRun` の正本** | 相関 ID を暫定で ULID にしたが、正本が決まれば移行が要る（[01 の 3.4](01-flow-specification-rules.md)） | `R1` | DA-01・AA-03・AA-04 |
| **配信ホスト名（apex か `www` か）** | `I-20` の実行と、`SITE_URL` を含む 4 変数の値が決まらない（`I-15` は 2026-09-18 にドメインプロパティで登録すると決め、依存が外れた） | `R2` | `docs/README.md` の横断的未決定事項 |
| **ngrok の公開経路をドメインで分けるかパスで分けるか** | `I-05` `I-07` `I-08` のエンドポイント URL の形が決まらない（設計は変数のまま書いた） | `R1` | AA-02 の 5 節 |
| **`R2` の代理承認** | `E-13` の `review` 状態の滞留上限を決められない | `R1` | BA-05 |
