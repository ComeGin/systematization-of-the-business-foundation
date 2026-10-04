# 観測結果（`E-12 AuditResult`）

観測エージェントが書く `E-12` の置き場。型の定義は [DA-01 の 4 節](../RequirementDefinition/DA/01-conceptual-data-model.md)、取得の記録（`fetch`）は [DD-01 の 4.3](../DetailedDesign/01-flow-specification-rules.md)、ファイル名は [DD-01 の 3.5](../DetailedDesign/01-flow-specification-rules.md) に従う。この README は、それらを 1 枚にまとめた実装用の規約である（食い違ったら上位の文書が正しい）。

## 置き場とファイル名

```
docs/audits/<source>/<audit_id>.md
```

| `source` | 書くエージェント | 中身 |
|---|---|---|
| `lighthouse` | `agent/seo-auditor` | Lighthouse CI の結果（`frontend/verdant-virgo/.lighthouse/` を正規化したもの） |
| `gsc` | `agent/seo-auditor` | Search Console の実績（OpenSEO 経由） |
| `serp` | `agent/seo-auditor` | 順位計測（OpenSEO のランク追跡） |
| `site_audit` | `agent/seo-auditor` | サイト監査（OpenSEO） |
| `analytics` | `agent/analytics-reporter` | Umami・PostHog・Mautic の集計値（個票を含めない） |
| `conversations` | `agent/conversation-triage` | 問い合わせの一次切り分けの集計 |
| `ops` | `agent/ops-watcher` | Error Tracking と死活 |
| `quality` | `agent/quality-checker` | 機械チェックの結果 |
| `market` | `agent/knowledge-scout` | 競合・SERP の市場データ |

- **1 つの `source` のディレクトリに書くエージェントは 1 本だけ**（AA-03 の 4.3）。採番が衝突しないのはこのためである（DD-01 の 3.6）
- `audit_id` は `AUD-<西暦>-<月日>-<source>-<連番 4 桁>`（例 `AUD-2026-1004-lighthouse-0001`）。連番は**同じ日・同じ `source` の既存ファイルの最大値 + 1**。ロックは要らない

## frontmatter

```yaml
---
audit_id: AUD-2026-1004-lighthouse-0001
source: lighthouse
created_by: agent/seo-auditor
target_ref: "E-05 url_path=/"          # 対象の E-ID と識別子
measured_at: 2026-10-04T06:00:00+09:00 # データが表す時刻（Lighthouse は計測時刻）
metrics:                               # 計測値。キーは DA-02 の指標 ID か、ツールの項目名
  LH-seo: 1.0
  LH-performance: 0.98
fetch:                                 # DD-01 の 4.3
  outcome: ok                          # ok | empty_but_ok | timeout | unreachable | auth_failed | permission_denied | rate_limited | truncated | invalid_response
  attempts: 1
  correlation_id: 01JBQZ8F3K7XN2M5V9TWRC4HED
  measured_at: 2026-10-04T06:00:05+09:00 # 取得を完了した時刻
  range:                               # 期間を持たない観測では省略
    from: 2026-09-04
    to: 2026-10-03
  note: ''
raw_ref: ".lighthouse/lhr-1759525200000.json"  # 元データへの参照（任意）
---
```

| 項目 | 必須 | 注意 |
|---|---|---|
| `audit_id` `source` `created_by` `target_ref` `measured_at` `metrics` | 必須 | `metrics` が空でよいのは `fetch.outcome` が `empty_but_ok` 以外の失敗のときだけ |
| `fetch.outcome` `fetch.attempts` `fetch.correlation_id` `fetch.measured_at` | 必須 | **`ok` と `empty_but_ok` 以外は `E-13` の `evidence` に使えない** |
| `fetch.range` | 期間を持つ観測で必須 | GSC は `range.to` が `fetch.measured_at` の 2〜3 日前になる。混同しない |
| `raw_ref` | 任意 | 個人情報を含むファイルを指さない |

## 本文

人間が読む補足だけを書く。**個人情報（氏名・メールアドレス・電話番号）と、会話やフォームの本文を書かない。** 人は ID で指す。

## 書いてはいけないもの

- 個票（Mautic のコンタクトの属性、Chatwoot の会話本文）
- 秘密値（トークン・API キー）
- 推測した値（取れなかった値は `fetch.outcome` に失敗分類を書き、`metrics` に入れない）
