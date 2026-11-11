---
audit_id: AUD-2026-1111-conversations-0001
source: conversations
created_by: agent/conversation-triage
target_ref: "E-10 inbox=all"
measured_at: 2026-11-11T04:00:00+09:00
metrics: {}
fetch:
  outcome: unreachable
  attempts: 2
  correlation_id: 01M73D9NW108897236PFR3Q00H
  measured_at: 2026-11-11T04:00:00+09:00
  note: 'chatwoot_list_conversations (status=open, status=pending) がいずれも 503 を返した。各 1 回再試行したが解消せず。'
---

本番 Chatwoot への接続時にサーバエラー（503）が継続したため、未解決会話の取得を実施できなかった。部分的な観測は残していない。前回（2026-11-10）と同様の状況。後続の実行で解消を確認すること。
