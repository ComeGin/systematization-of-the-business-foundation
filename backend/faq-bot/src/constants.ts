export const SERVER_NAME = "faq-bot";

// 入口のパス。Chatwoot のエージェントボットの outgoing_url は <関数 URL か http://host.docker.internal:3107>/webhook
export const WEBHOOK_PATH = "/webhook";
export const HEALTH_PATH = "/healthz";

export const MAX_BODY_BYTES = 64 * 1024;
// X-Chatwoot-Timestamp と現在時刻の差の許容（古い要求の再送を拒む）
export const SIGNATURE_TOLERANCE_SECONDS = 300;

// Lambda の打ち切り（4 秒）に収める。faq.json の取得と Chatwoot の API の 1 回ごとの上限
export const FAQ_FETCH_TIMEOUT_MS = 1_500;
export const CHATWOOT_TIMEOUT_MS = 2_000;

// 開発の入口（Node の HTTP サーバー）だけで使う
export const REQUEST_TIMEOUT_MS = 10_000;
export const SHUTDOWN_TIMEOUT_MS = 5_000;

// 長い貼り付けの照合を軽くするため、質問はこの文字数で切る
export const MAX_QUESTION_CHARS = 1_000;
export const MAX_CANDIDATES = 3;
// ウィジェットを開いたときの一覧（2026-10-12 の仕様）: トップページの FAQ（faq-export の id が「top-<順番>」）を最大 6 件
export const WELCOME_PAGE_KEY = "top";
export const MAX_WELCOME_ITEMS = 6;

export const DEFAULT_THRESHOLDS = { high: 0.5, low: 0.25, margin: 0.1 } as const;

// Chatwoot の push_event_data の message_type（0 incoming / 1 outgoing / 2 activity / 3 template）
export const MESSAGE_TYPE_OUTGOING = 1;
// Chatwoot が自動で足すメッセージ（ウィジェットの連絡先の入力欄など）。訪問者の発言ではない
export const MESSAGE_TYPE_TEMPLATE = 3;

export const LABELS = {
  answered: "faq-answered",
  unmatched: "faq-unmatched",
  handoff: "faq-handoff",
} as const;

// input_select の選択肢の値（FAQ の id と衝突しないよう __ で始める）
export const CHOICE = {
  none: "__none",
  handoff: "__handoff",
  resolved: "__resolved",
} as const;

// 文言は仮（仕様 14 節。R3 が見直す）
export const MESSAGES = {
  answerLinkPrefix: "詳しくは: ",
  candidatesPrompt: "次のどれに近いですか？",
  welcome: "よくあるご質問です。当てはまらなければ、ご質問をそのまま入力してください。",
  handoff: "担当者におつなぎします。順番にお返事しますので、このままお待ちください。",
  resolved: "お役に立ててよかったです。ほかにもご質問があれば、いつでもどうぞ。",
  choiceResolved: "解決しました",
  choiceHandoff: "担当者に相談する",
  choiceNone: "どれにも当てはまらない",
} as const;

// 照合の前に質問の末尾から削る定型句（長いものから順に試す）
export const QUESTION_SUFFIXES = [
  "教えてほしいです",
  "教えてください",
  "教えてほしい",
  "でしょうか",
  "ですか",
  "ますか",
  "ください",
  "下さい",
  "知りたい",
  "教えて",
  "について",
  "とは",
] as const;
