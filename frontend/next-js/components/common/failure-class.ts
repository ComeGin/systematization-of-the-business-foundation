// 失敗の分類 9 値（E-15 の failureClass と E-12 の fetch.outcome の両方）の日本語の意味。
// 正本は docs/audits/README.md と DD-01 の 4.4（判定順は backend/control-plane/src/constants/failure.ts）。

const OUTCOMES: Record<string, { label: string; meaning: string }> = {
  ok: { label: "取得できた", meaning: "取得できた" },
  empty_but_ok: { label: "取得できたが 0 件", meaning: "取得は成功したが、対象が 0 件だった" },
  timeout: { label: "時間切れ", meaning: "上限の時間までに応答が無かった" },
  unreachable: { label: "接続できない", meaning: "接続できなかった（名前解決・接続の拒否・ネットワーク）" },
  auth_failed: { label: "認証に失敗", meaning: "認証情報が通らなかった（期限切れ・誤り）" },
  permission_denied: { label: "権限が無い", meaning: "権限が無い、または対象が見つからない・一意に定められない（403 など）" },
  rate_limited: { label: "回数の制限", meaning: "上流の回数の制限に当たった（429）" },
  truncated: { label: "応答が削られた", meaning: "応答が上限で削られ、全部は取れなかった" },
  invalid_response: { label: "想定外の応答", meaning: "上流が 2xx 以外（5xx を含む）を返した、または解釈できない応答" },
};

const SUCCESS = new Set(["ok", "empty_but_ok"]);

export function describeOutcome(value: string | null): { label: string; meaning: string; ok: boolean } {
  if (value === null) return { label: "形が読めない", meaning: "観測の記録から取得の結果（fetch.outcome）を読めない", ok: false };
  const known = OUTCOMES[value];
  if (!known) return { label: value, meaning: "定義に無い分類", ok: false };
  return { ...known, ok: SUCCESS.has(value) };
}
