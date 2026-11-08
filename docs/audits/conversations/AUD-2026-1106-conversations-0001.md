---
audit_id: AUD-2026-1106-conversations-0001
source: conversations
created_by: agent/conversation-triage
target_ref: "E-10 inbox=all"
measured_at: 2026-11-06T04:00:00+09:00
metrics: {}
fetch:
  outcome: unreachable
  attempts: 4
  correlation_id: 01M6PHA2WEHBC1E0Q9X0PDZ96Z
  measured_at: 2026-11-06T04:03:00+09:00
  note: 'chatwoot-prod への list_conversations (status=open, status=pending、各1回+再試行1回の計4回)がすべて 503 で失敗。前日 (AUD-2026-1105-conversations-0002) と同時間帯・同症状。'
---

本番 Chatwoot (chatwoot-prod) への接続がすべて 503 (サーバーエラー) で失敗した。`status=open` と `status=pending` のそれぞれで初回・再試行とも同じ結果であり、特定のパラメータではなくサーバー側（またはメンテナンス状態）の不調と判断した。前日の同時刻帯の観測 (AUD-2026-1105-conversations-0002) でも同じ事象が記録されており、2日連続で深夜帯 (04:00 JST 前後) に接続不能が発生している。本日の未解決会話の一次切り分け・社内メモ・ラベル付けは実施していない。原因調査（Chatwoot 側のメンテナンスウィンドウや定期実行の時間帯設定との重なりの有無）を人間に推奨する。
