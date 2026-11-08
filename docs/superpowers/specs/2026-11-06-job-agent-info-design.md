# 監視アプリに、定期実行のジョブと Agent の「概要・入出力・結果の理由」を出す（設計）

- 日付: 2026-11-06
- 対象: `frontend/next-js`（監視アプリ）、`backend/control-plane`（その中身）、`ops/schedules/*.yaml`（定期実行の定義 21 本）
- 画面の案（モックアップ）: ブレインストーミングで見せた 2 枚（ジョブの詳細・Agent の画面）。下の 4〜6 節がその文章版

## 1. 意図と理由

ユーザーの言葉: 「監視アプリで『定期実行のジョブ』画面を見ても何を実行しているかわかりません。また、中の『Agent』の処理についても知る由がありません。」

今の画面に出るのは、ジョブの id・cron・種類・`after`・上限の秒数と、yaml の一行の `description` だけ。Agent のジョブは Agent の名前が出るだけで、Agent への指示（yaml の `prompt`）も、Agent の役割・手順・使えるツール（`.claude/agents/<name>.md`）も画面に無い。

もう一つの困りごと（2026-11-04 の夜の調査で起きたこと）: 実行記録（E-15）の `outcome` は「Agent が最後まで動いたか」で、データが取れたかは観測（E-12）の `fetch.outcome` にしか出ない。11-04 の観測 4 本はすべて「成功」だったが、中身は `permission_denied` や `unreachable` だった。画面ではそれが緑に見えて、何が起きたか分からなかった。

ジョブの画面を開いたときに分かってほしいこと（ユーザーの言葉）: **処理の概要、入出力、結果の理由**。結果の理由は**中身の理由まで**（「実行は成功だが GSC の取得は permission_denied だった。理由は〜」まで）。

## 2. 目標・非目標・反目標

**目標**
- ジョブの詳細で、①処理の概要 ②入出力 ③どの Agent が動くか（役割の一文と Agent の画面へのリンク）④直近の結果と理由（中身まで）が 1 画面で分かる
- Agent の画面（一覧と詳細）で、役割・接続先とツール（書き込めるものは区別）・使うジョブ・直近の実行の中身・手順の全文が分かる
- 実行記録の一覧（`/runs` とジョブの詳細の中の一覧）で、「実行は成功・中身に失敗あり」が一目で分かる

**非目標**
- 画面から定義を変えること（ADR-18。定義は PR でだけ変える）
- 本番の n8n のワークフロー（監視アプリのジョブではない）、提案（E-13）の画面、観測（E-12）の一覧の画面
- 失敗の通知（メール・SNS）を変えること

**反目標**（技術的に動いても失敗とみなすもの）
- 画面に出す中身を作業ツリーの未承認の定義から読むこと（ADR-18 に反する。エージェントが自分の説明を書き換えられてしまう）
- 秘密値や個人情報が画面に出ること
- 中身の失敗を「成功」の陰に隠したままにすること（今回の目的そのもの）

## 3. 制約

- **定義（ジョブの yaml・Agent の `.md`）は承認済み main のチェックアウト（`CONTROL_MAIN_CHECKOUT`）からだけ読む**（ADR-18。今の `loadSchedules`・`loadAgentDefinition` と同じ）
- **観測（E-12）は作業ツリー（`CONTROL_WORKTREE`）の `docs/audits/<source>/<audit_id>.md`** にある（エージェントがそこに書き、コミットされるまで main には無い）。読むだけ。見つからなければ main のチェックアウトの同じパスを見る。どちらにも無ければ「見つからない」と出す
- next-js と control-plane の境界の型は `backend/control-plane/src/contract.ts`。next-js は control-plane を取り込んで 1 プロセスで動かす（変数の `import()` は壊れる。メモリの「next-js は control-plane をバンドルする」）
- 画面の部品は今と同じ Cloudscape。Markdown の表示は `components/setup-status/DocSection.tsx` と同じ `react-markdown` ＋ `remark-gfm`（見出しを h4 以下に落とす・相対リンクをリンクにしない、の決まりも同じ）
- yaml の検証（`definitions/schedules.ts` の zod）は**知らないキーを黙って捨てる**。新しい欄を yaml に先に足しても、今動いている control-plane は壊れない。**新しい欄は任意（無くても読み込める）にする**（main に入る順番に依存させない）
- テスト（**2026-11-06 にユーザーが決めた: 書いて、直す**）: 今回の変更の単体テスト（control-plane・next-js）と E2E（`frontend/next-js/e2e/`）を書き、新しい欄で壊れる既存のテスト・フィクスチャ（`e2e/support/fixtures.mts` など）を直し、実行して通す。書き方はメモリの「単体テストの書き方」「E2E の作り方」と既存のテストに合わせる。**2026-11-04 に設定の状況の確認間隔を 1 時間にしたことで落ちる `tests/status/service.test.ts` も、ここで直す**
- ビルド・デプロイは指示があるまで実行しない（`.claude/rules/build-deploy.md`）。型検査（`tsc --noEmit`）と lint はしてよい

## 4. ジョブの定義に足す欄（ユーザーの決定: yaml に欄を足して 21 本を書き起こす）

ユーザーが決めたこと: 入出力は今の定義から自動では出せないので、**各ジョブの yaml に欄を足し、21 本分を書き起こす**。書き起こすのは実装する側（Agent の `.md` と builtin のコードを読んで書く）。

欄の形（〔判断: 設計者〕名前と形は以下で固定）:

```yaml
overview: |                # ① 処理の概要。2〜4 文。何を起動し、何を読んで、何をまとめるか。何をしないか
  毎朝 4:00 に Agent seo-auditor を起動し、…
stage: observe             # 改善ループの中の段階（下の表の値のどれか）
io:
  reads:                   # 読むもの（製品・外部 SaaS・ファイル。1 行 1 つ）
    - "OpenSEO の GSC の実績（本番の comegin.com のプロジェクト）"
    - "過去の E-12（docs/audits/gsc/）"
  writes:                  # 書くもの
    - "E-12 を 1 件（docs/audits/gsc/AUD-YYYY-MMDD-gsc-NNNN.md。作業ツリー）"
  does_not_write:          # 書かないもの（誤解されやすいものだけ。無ければ省く）
    - "本番の製品（Strapi・Mautic・Chatwoot）には書かない。費用の出るツールは持たない"
```

- `stage` の値と表示名: `measure`（計測）・`observe`（観測）・`propose`（提案）・`file`（起票）・`create`（制作。キーワード・企画・下書き）・`check`（点検。誤った書き込み・沈黙）・`maintain`（保守。写しの再送・n8n の書き出し）・`monitor`（監視。ハートビート・公開記事の確認）。画面では「改善ループの中の段階」として出す
- すべて任意。無いジョブは画面で「（定義に書かれていない）」と出す
- （2026-11-09 に追記）形が違う欄は、その欄だけ null にして WARN に欄の名前だけを出し、定義は読み込む（ジョブを止めない）。計画の「8 値以外ならその定義は errors に入る」は改めた
- 「待つもの／待たれるもの」は欄にしない。`after` と、ほかのジョブの `after` の逆引きから画面で作る
- 書き起こしは**事実だけ**（Agent の `.md`・yaml の `prompt`・builtin のコード〈`backend/control-plane/src/builtin/*.ts`〉に書いてあること）。推測で書かない。実装と食い違いが見つかったら、yaml を直さずに報告する
- `ops/README.md` の「定期実行の定義」の表に 3 つの欄を足す
- 対象 21 本: `ops/schedules/` の全ファイル（`heartbeat` を含む）

## 5. ジョブの詳細（`/jobs/[jobId]`）

上から順に:

1. 見出し: id と `description`（今と同じ）、「手動で起動」（今と同じ）
2. **① 処理の概要**: `overview`。その下に改善ループの段階（`stage`）を、全段階を並べて今の段階を強調する形で出す
3. **② 入出力**: 表で「読むもの」「書くもの」「書かないもの」「待つもの／待たれるもの」（ジョブへのリンク）
4. 定義（今の箱をそのまま）。その中に、Agent のジョブなら「Agent への指示（`prompt`）」を折りたたみで全文
5. **③ Agent**（Agent のジョブだけ）: Agent の名前（Agent の詳細へのリンク）と、役割の一文（`.md` の frontmatter の `description`）と接続先の名前だけ。手順の全文はここに出さない（ユーザーの決定: B。Agent の画面を別に作る）
6. **④ 直近の結果と理由**: 直近の実行 1 件について
   - 実行の結果（成功・部分的・失敗・見送り）・所要時間・費用
   - **中身**: その実行が書いた観測（6 節。`fetch.correlation_id` が実行の `runId` と一致するもの）ごとに、取得の結果（`fetch.outcome`）とその日本語の意味、理由（`fetch.note`）を表で出す
   - Agent の要約（`summary`）、見送りの理由（`skipReason`）、失敗の分類（`failureClass`）とその日本語の意味
7. このジョブの実行記録（今の表に「中身」の列を足す。6 節）

## 6. 「中身」の判定と表示（実行記録のすべての一覧と詳細に共通）

- **その実行が書いた観測**を、観測（E-12）の `fetch.correlation_id` が実行の `runId` と一致するもので決める〔判断: 設計者。2026-11-06 の確認で決めた〕。`targetIds` はエージェントが最終出力に自分で書く値で、当てにならない（11-06 の `daily-observe-ops` は観測を書いたのに `targetIds` が `[]`。`"E-05"`・`"LH-seo"` のように観測の ID でない値も入る）。`correlation_id` は `docs/audits/README.md` で必須の欄
- `targetIds` に含まれる観測の ID のうち、書いた観測でないものは「**この実行が対象にした（読んだ）観測**」として、実行の詳細だけに別の表で出す。一覧の「中身」には数えない（`daily-propose` がほかのジョブの失敗した観測を読んだだけで赤くならないように）
- 観測を `correlation_id` で引くため、`docs/audits/*/` の全ファイルの frontmatter を読んで `correlation_id` → 観測の索引を作る。作業ツリーと main のチェックアウトの両方を読み、同じ `audit_id` は作業ツリーを優先する。索引を作り直す頻度・キャッシュは実装する側に任せる（ファイルの更新時刻で作り直す程度でよい）
- 1 回の実行の「中身」は、**その実行が書いた観測**の `fetch.outcome` から決める
  - 書いた観測が 0 件: 「-」
  - すべて `ok` か `empty_but_ok`: 「問題なし（N 件）」
  - それ以外が 1 件以上: 「取得に失敗 M / N 件」（目立つ色）
  - 「対象にした（読んだ）観測」の ID でファイルが見つからないものは、実行の詳細のその表に「見つからない」と出す（一覧には出さない）
- 対象: `/runs` の一覧、ジョブの詳細の実行記録、実行の詳細（`/runs/[runId]`）。**実行の詳細には 5 節の ④ と同じ表**（書いた観測ごとの結果・意味・理由）と、その下に「対象にした（読んだ）観測」の表を出す
- 5 節の ④ の「中身」も、ここと同じ決め方（書いた観測）にする
- 失敗の分類 9 値（`unreachable` `timeout` `rate_limited` `permission_denied` `auth_failed` `truncated` `invalid_response` `empty_but_ok` `ok`）の日本語の意味は 1 か所に表として持ち、E-15 の `failureClass` と E-12 の `fetch.outcome` の両方に使う。意味の正本は `docs/audits/README.md` と DD-01 の 4.4。`invalid_response` には「上流が 2xx 以外（5xx を含む）を返した、または解釈できない応答」と書く（2026-11-04 に 503 がこの分類に入っていた）
- `fetch.note` と `summary` はエージェントが書いた文。**文字として出す**（HTML・Markdown として解釈しない）。長いもの（例 500 文字超）は折りたたむ〔判断: 設計者〕
- 観測のファイルのパスは ID から組み立てる。ID の形（`^AUD-\d{4}-\d{4}-[a-z_]+-\d{4}$`）に合わないもの・`source` が `docs/audits/` の下のディレクトリに無いものは読まない（任意のパスを読ませない）
- 読むのは frontmatter（`audit_id` `source` `created_by` `fetch.outcome` `fetch.note` `fetch.measured_at`）だけ。本文は出さない〔判断: 設計者〕

## 7. Agent の画面（新規。ユーザーの決定: B）

左のメニューに「Agent」を足す（「定期実行のジョブ」の次）。

**一覧（`/agents`）**: `.claude/agents/*.md`（main のチェックアウト。今は 12 本）を全部。列は 名前（詳細へのリンク）・役割（`description` の先頭の一文）・使うジョブの数（0 なら「なし（手動だけ）」）。読めない定義は、一覧の上に「読めない定義」として名前と理由を出す（値は出さない）。

**詳細（`/agents/[name]`）**:
- 役割: `description` の全文
- モデル: `model`
- **接続先とツール**: `tools` を、組み込みツール（Read・Write など）と MCP の接続先（`mcp__<server>__` の `<server>`）ごとに分けて出す。MCP のツールは「参照」「書き込み」に分け、書き込みは目立たせる。分け方〔判断: 設計者〕:
  1. 接続先が `ops/mcp-registry.yaml`（main のチェックアウト）で `access_level: read_only` なら、その接続先のツールはすべて参照（名前の規則より優先する。例: `mautic-prod-ro` の `mautic_run_report`）
  2. それ以外は、ツール名（`<server>__` の後）から製品名の接頭辞（`chatwoot_` `mautic_` など、最初の `_` までが登録表の接続先の名前〈`-prod` などを除いた部分〉と一致するもの）を取り、残りが `list` `get` `query` `search` `find` `inspect` `whoami` `estimate` `execute-sql` で始まれば参照、`create` `update` `add` `delete` `remove` `set` `send` `save` `run` `merge` で始まれば書き込み（例: `chatwoot_add_private_note` → `add_private_note` → 書き込み）
  3. どちらでもないものは「不明」として中立に出す
  - 組み込みの `Write` `Edit` は「ファイルへの書き込み（作業ツリーの中だけ）」
  - 接続先の名前の横に、登録表の `access_level` があれば出す（`read_only` など）
- `disallowedTools` があれば出す
- 使うジョブ: その Agent を `agent` に持つジョブの一覧（ジョブへのリンク、cron、有効か）
- 直近の実行: その Agent の直近の実行（数件）と、それぞれの「中身」（6 節）
- **手順**: frontmatter を除いた本文（`body`）を Markdown として全文表示（`DocSection` と同じ決まり）
- 「できないこと」は独立の欄にしない〔判断: 設計者〕。frontmatter には形式上その欄が無く（Claude Code のサブエージェント形式は name・description・tools・disallowedTools・model だけ）、文から取り出すのは不確か。`description` の全文に含まれている

ジョブの詳細の ③ からは、この画面へリンクする。

## 8. ジョブの一覧（`/jobs`）

今の列に「段階」（`stage` の表示名）と「直近の中身」（6 節）を足す。`description` が一覧に無ければ、ID の下に小さく出す〔判断: 設計者。画面の幅を見て決めてよい〕。

## 9. 境界（`contract.ts`）に足すもの

形は実装する側に任せるが、少なくとも次ができること:

- `JobDefinition` に `overview`・`stage`・`io`（いずれも無ければ null や空）。`prompt` も画面に出すので公開の型に含める（今は内部の `ScheduleDefinition` だけにある）
- Agent の一覧と 1 件の取得（名前・description・tools・disallowedTools・model・body、使うジョブの id）。名前は今の `AGENT_NAME_PATTERN` で検査し、合わないものは読まない
- 実行 1 件または複数件について、観測の要約（ID・source・created_by・outcome・note・measured_at・見つかったか）を、**書いた観測**（`correlation_id` が一致）と**対象にした観測**（`targetIds` にあり、書いた観測でないもの）に分けて返す。一覧のために複数件をまとめて取れること
- Agent の接続先の `access_level`（`ops/mcp-registry.yaml`。今の `loadMcpRegistry` を使う）

## 10. 実装する側に任せること

- 画面の細かい並び・色・文言（モックアップの方向から外れない範囲で）
- 観測のファイルの読み込みのキャッシュの有無（一覧 50 件 × 数件のファイルで十分速ければ不要）
- 21 本の `overview`・`io` の文の書き方（4 節の決まりの範囲で）
- `ops/README.md`・`frontend/next-js/README.md`・`backend/control-plane/README.md` の更新の書き方

## 11. 反映の順番

1. control-plane と next-js の変更、yaml の 21 本の書き起こし、README の更新を 1 つの PR にしてよい（新しい欄は任意なので、どの順で main に入っても壊れない）
2. main に入った後、人が `CONTROL_MAIN_CHECKOUT` を更新し、`backend/control-plane` と `frontend/next-js` で `pnpm install && pnpm build` して、監視アプリを再起動する（`onprem/README.md` の手順。今と同じ）
