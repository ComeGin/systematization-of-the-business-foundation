// タイムアウトの表（DD-01 の 7.2）。上流に固定の打ち切りがある場合は、必ずその内側で自分から切る。
export const TIMEOUT_SEC = {
  chatwootMcp: 12, // Rack::Timeout の 15 秒より内側
  mauticMcp: 30,
  strapiMcp: 20,
  umamiMcp: 20,
  posthogFlush: 5,
  formSubmit: 10,
  i13Github: 30,
  gscViaOpenseo: 30,
  openseoResearch: 90,
  sns: 10,
  unmineable: 30,
  thirdweb: 30,
} as const;

// DD-01 の表に無い、control-plane 自身の値（この層の判断。必要になったら見直す）
export const CONTROL_TIMEOUT_SEC = {
  /** 突き合わせで Chatwoot の API を読む（I-03 と同じ上流なので 12 秒に揃える） */
  chatwootRead: TIMEOUT_SEC.chatwootMcp,
  // 本番の n8n の Public API（n8n-export。一覧と本体の取得。1 回の呼び出しごと）
  n8nApi: 30,
  s3Put: 30,
  cloudwatchPut: 10,
} as const;

/** 手動の指示で起動するエージェントの既定（定期実行は定義の timeout_sec / max_turns を使う） */
export const MANUAL_AGENT_DEFAULTS = { timeoutSec: 900, maxTurns: 40 } as const;
