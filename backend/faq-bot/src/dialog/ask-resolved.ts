import type { Reply } from "../chatwoot/types.js";
import { CHOICE, MESSAGES } from "../constants.js";

/** 担当者のマクロ「解決の確認を送る」で送るボタン（2026-10-12 の解決の確認の仕様 3 節）。押されると既存の［解決しました］の流れで閉じる */
export function askResolvedReply(): Reply {
  return { kind: "select", content: MESSAGES.askResolved, items: [{ title: MESSAGES.choiceResolved, value: CHOICE.resolved }] };
}
