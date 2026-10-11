---
# E-12 AuditResult のテンプレート。規約は docs/audits/README.md、取得の記録は DD-01 の 4.3。
# このファイルを複製して docs/audits/<source>/<audit_id>.md にする。コメントは消してよい。
audit_id: AUD-2026-1004-lighthouse-0001   # AUD-<西暦>-<月日>-<source>-<連番 4 桁>。同じ日・同じ source の最大連番 + 1
source: lighthouse                        # lighthouse | gsc | serp | site_audit | analytics | conversations | ops | quality | market
created_by: agent/seo-auditor             # 書くエージェント（source との対応は README の表）
target_ref: "E-05 url_path=/"             # 対象の E-ID と識別子
measured_at: 2026-10-04T06:00:00+09:00    # データが表す時刻（GSC は range.to の側。Lighthouse は計測時刻）
metrics:                                  # キーは DA-02 の指標 ID。取れなかった値は入れない
  LH-seo: 1.0
  LH-performance: 0.98
fetch:
  outcome: ok                             # ok | empty_but_ok | timeout | unreachable | auth_failed | permission_denied | rate_limited | truncated | invalid_response
  attempts: 1
  correlation_id: 01JBQZ8F3K7XN2M5V9TWRC4HED   # プロンプトの CORRELATION_ID: 行の値
  measured_at: 2026-10-04T06:00:05+09:00  # 取得を完了した時刻
  range:                                  # 期間を持たない観測では range ごと省略
    from: 2026-09-04
    to: 2026-10-03
  note: ''                                # outcome が ok 以外のときだけ補足を書く
raw_ref: ".lighthouse/lhr-1759525200000.json"   # 任意。個人情報を含むファイルを指さない
---

# 観測の補足

人間が読む補足だけを書く。個人情報（氏名・メールアドレス・電話番号）と、会話・フォームの本文を書かない。人は ID で指す。
