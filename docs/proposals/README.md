# 改善提案（`E-13 ImprovementProposal`）

`agent/proposal-writer` だけが起票する `E-13` の置き場。型の定義と項目の意味は [DA-01 の 6 節](../RequirementDefinition/DA/01-conceptual-data-model.md)、状態遷移は [DD-01 の 8 節](../DetailedDesign/01-flow-specification-rules.md)、起票前チェックと起票（`I-13`）は [DD-06](../DetailedDesign/06-proposal-loop-flows.md) にある。この README は実装用の規約である（食い違ったら上位の文書が正しい）。

## 置き場とファイル名

```
docs/proposals/<proposal_id>.md     例 docs/proposals/PRP-2026-0001.md
```

- `proposal_id` は `PRP-<西暦>-<連番 4 桁>`。連番は**既存ファイルの最大値 + 1**（起票者が 1 本だけなのでロックは要らない。DD-01 の 3.6）
- ファイル名に ULID を使わない
- **却下された提案も削除しない**（同じ提案の再起票を検出するため）

## frontmatter

項目は DA-01 の 6.1 のとおり。実装で迷いやすい点だけを書く。

```yaml
---
proposal_id: PRP-2026-0001
created_at: 2026-10-04T07:00:00+09:00
created_by: agent/proposal-writer
agent_run_id: 01JBQZ8F3K7XN2M5V9TWRC4HED   # 監視アプリが渡した相関 ID（ULID）。E-15 を引くキー
evidence:
  - audit_id: AUD-2026-1004-lighthouse-0001
    source: lighthouse
    ref: docs/audits/lighthouse/AUD-2026-1004-lighthouse-0001.md
    summary: "トップページの LH-seo は 1.0 を維持、LH-performance が 0.84"
target:
  entity: E-05
  identifier: "url_path=/"
  also_affects: []
change:
  kind: technical_seo          # content_rewrite | cta_swap | internal_link | technical_seo | experiment_start | config_change | accessibility | email_campaign
  description: "..."
  diff_ref: null               # 起票時は null。I-13 が PR 番号を書き戻す（例 "PR #12"）
expectation:
  metric: LH-performance
  baseline: 0.84
  target: 0.90
  judge_after: 2026-11-03
  judge_by: R3
risk:
  level: low                   # low | medium | high（reversible=false なら high）
  description: "..."
  blast_radius: "..."
approval:
  state: draft                 # draft | review | approved | rejected | applied | rolled_back
  approver: null
  decided_at: null
  record_ref: null
applied_at: null
verification:
  state: pending               # pending | improved | no_change | degraded
  verified_at: null
  result: null
  audit_ref: null
rollback:
  procedure: "..."
  reversible: true
  deadline: 2026-12-03
---
```

## 変更の種類（`change.kind`）

| 種類 | 変えるもの | 適用の主体 | 起票 |
|---|---|---|---|
| `content_rewrite` | 記事の本文 | エージェントが Strapi の下書きとして作り、公開は `R2`（人） | する |
| `cta_swap` | CTA の差し替え | エージェントが差分を作り、配信は人 | する |
| `internal_link` | 内部リンク | エージェントが差分を作り、配信は人 | する |
| `technical_seo` | 構造化データ・メタ情報などの技術 SEO | エージェントが差分を作り、配信は人 | する |
| `accessibility` | a11y の違反を直すコード | エージェントが差分を作り、公開の前に人がスクリーンリーダーで確かめる | する |
| `email_campaign` | Mautic のメールとキャンペーン（`target.entity` は `mautic_segment`、`target.identifier` は `segment:<既存のセグメントの名前>#<テーマの slug>`。slug は英小文字・数字・ハイフン。同じセグメントへの同じテーマだけが重複になる） | **エージェントが未公開で作り、公開（送信）は人** | する（読み手が介護・障がい福祉の法人・事業所の課題で、根拠の `E-12` があるとき） |
| `config_change` | 安全装置・設定の変更 | 人が手で行う（作用のジョブを作らない。画面では「人が手で行う」項目） | する（安全装置が実際に妨げになった事例があるとき） |
| `experiment_start` | AB テストの開始 | — | **しない**（AB テストは扱わない。2026-11-09。過去の `E-13` を読めるよう値としてだけ残る） |

## 状態を動かせる主体

| 遷移 | 主体 | エージェントが行えるか |
|---|---|---|
| （無）→ `draft` | `agent/proposal-writer` | 可 |
| `draft` → `review` | `I-13`（監視アプリが PR を作る。1 周目は人間） | 不可 |
| `review` → `approved` / `rejected` | `R2`（PR のレビュー） | **不可** |
| `approved` → `applied` | 本番に作用させた主体（MCP の書き込みは Claude Code、配信と n8n の有効化は人間） | 一部のみ |
| `applied` → `verification` の判定 | 再計測はエージェント、判定は `R3` | 再計測のみ |
| `applied` → `rolled_back` | `R1` / `R2` | 不可 |

禁止: `draft` → `applied`、`applied` → `draft`、検証後 → `applied`。

## 起票前チェック

`agent/proposal-writer` は起票の前に DD-06 の 1.2 の 15 項目をすべて検査する。1 つでも通らなければ起票せず、最終出力の `SUMMARY:` 行に理由を書く（監視アプリが `E-15` に `skipped` として残す）。

## 本文

承認者（`R2`）が読む説明を書く。**個人情報と、会話やフォームの本文を書かない。** 人は ID で指す。
