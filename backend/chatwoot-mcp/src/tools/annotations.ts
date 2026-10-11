/** 参照のみ（Chatwoot の状態を変更しない） */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** 新規作成（既存データは変更しないが、呼ぶたびにレコードやメッセージが増える） */
export const CREATE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** 既存データの上書き・削除（クライアントが実行前に確認を求められるよう destructive とする） */
export const DESTRUCTIVE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;
