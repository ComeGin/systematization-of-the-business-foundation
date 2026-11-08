---
audit_id: AUD-2026-1105-conversations-0002
source: conversations
created_by: agent/conversation-triage
target_ref: "E-10 inbox=all"
measured_at: 2026-11-05T04:00:00+09:00
metrics: {}
fetch:
  outcome: unreachable
  attempts: 4
  correlation_id: 01M6KYXBXCQNXG6VBZ3EF5G3RK
  measured_at: 2026-11-05T04:05:00+09:00
  note: 'chatwoot-prod が複数回(list_conversations x3, filter_conversations x1)にわたり 503 を返し続けたため、未解決会話の取得を断念した。'
---

本番 Chatwoot (chatwoot-prod) への接続試行がすべて 503 (サーバーエラー) で失敗した。`chatwoot_list_conversations`（パラメータを変えて2回再試行）および `chatwoot_filter_conversations` の計4回とも同じ結果であり、特定のパラメータに起因する問題ではなくサーバー側の不調と判断した。本日の未解決会話の一次切り分けは実施できなかった。社内メモ・ラベル付けも行っていない。後続の実行での再取得を推奨する。
