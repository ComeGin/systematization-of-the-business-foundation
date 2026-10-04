// docs/audits/README.md の表。1 つの source のディレクトリに書くエージェントは 1 本だけ（AA-03 の 4.3）。
export const AUDIT_SOURCES_BY_AGENT: Readonly<Record<string, readonly string[]>> = {
  "seo-auditor": ["lighthouse", "gsc", "serp", "site_audit"],
  "analytics-reporter": ["analytics"],
  "conversation-triage": ["conversations"],
  "ops-watcher": ["ops"],
  "quality-checker": ["quality"],
  "knowledge-scout": ["market"],
};
