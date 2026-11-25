// 受付時間外（2026-11-25。ユーザーの決定。docs/superpowers/specs/2026-11-25-night-stop-chatwoot-mautic-design.md）。
// 本番の Chatwoot・Mautic は毎日 0 時〜7 時 50 分（日本時間）に 0 台になる。時刻の正本は cloud/template.yaml の
// NightlyStopSchedule・NightlyStartSchedule。公開サイトは 0〜8 時を受付時間外として、フォームの送信とチャットの読み込みをしない
// （7 時 50 分〜8 時はタスクの起動とヘルスチェックの待ち）。時刻を変えるときは、このファイルと template.yaml を一緒に直す。
//
// 判定はブラウザの時計で行う。静的に生成する HTML に結果を焼き込まないよう、呼び出しは水和の後（クライアント）に限る。

/** 受付時間外の時（JST）。start 以上 end 未満 */
export const SERVICE_CLOSED_HOURS_JST = { start: 0, end: 8 } as const;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** いまが受付時間外か。端末のタイムゾーンに関係なく JST の時で判定する */
export function isOutsideServiceHours(now: Date = new Date()): boolean {
  const hour = new Date(now.getTime() + JST_OFFSET_MS).getUTCHours();
  return (
    hour >= SERVICE_CLOSED_HOURS_JST.start &&
    hour < SERVICE_CLOSED_HOURS_JST.end
  );
}
