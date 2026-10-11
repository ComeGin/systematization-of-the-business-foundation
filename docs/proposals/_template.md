---
# E-13 ImprovementProposal のテンプレート。規約は docs/proposals/README.md、項目の意味は DA-01 の 6 節。
# agent/proposal-writer だけが docs/proposals/PRP-<西暦>-<連番 4 桁>.md として起票する。コメントは消してよい。
proposal_id: PRP-2026-0001
created_at: 2026-10-04T07:00:00+09:00
created_by: agent/proposal-writer
agent_run_id: 01JBQZ8F3K7XN2M5V9TWRC4HED   # 渡された CORRELATION_ID（監視アプリを通らない実行では自分で発行した ULID）
evidence:                                  # 1 件以上。fetch.outcome が ok / empty_but_ok で、measured_at が 14 日以内のものだけ
  - audit_id: AUD-2026-1004-lighthouse-0001
    source: lighthouse
    ref: docs/audits/lighthouse/AUD-2026-1004-lighthouse-0001.md
    summary: "要旨だけ。会話本文・email・氏名・電話番号・GSC の個々の検索クエリを書かない"
target:
  entity: E-05                             # 変更対象の E-ID
  identifier: "url_path=/"                 # documentId / url_path / cta_id など
  also_affects: []
change:
  kind: technical_seo                      # content_rewrite | cta_swap | internal_link | technical_seo | experiment_start | config_change
  description: "何を、どう変えるか"
  diff_ref: null                           # 起票時は null。I-13 が PR 番号を書き戻す
expectation:
  metric: LH-performance                   # DA-02 の指標 ID
  baseline: 0.99
  target: 1.0
  judge_after: 2026-11-03                  # 既定は 30 日後
  judge_by: R3
risk:
  level: low                               # low | medium | high（reversible: false なら high）
  description: "想定される悪影響"
  blast_radius: "影響範囲"
approval:
  state: draft                             # 起票時は必ず draft。agent は他の値を書かない
  approver: null
  decided_at: null
  record_ref: null
applied_at: null
verification:
  state: pending
  verified_at: null
  result: null
  audit_ref: null
rollback:
  procedure: "コマンド・PR 番号・版番号まで具体的に書く"
  reversible: true                         # Git の外（n8n / Mautic / PostHog / OpenSEO）に作用するなら false
  deadline: 2026-12-03
---

# 提案の説明

承認者（`R2`）が読む説明を書く。個人情報と、会話・フォームの本文を書かない。人は ID で指す。

## 背景（根拠）

`evidence[]` の `E-12` を `audit_id` で指しながら、何が観測されたかを要旨で書く。

## 変更内容

## 期待する効果と判定

## リスクとロールバック
