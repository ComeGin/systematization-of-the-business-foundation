export interface ChoiceItem {
  readonly title: string;
  readonly value: string;
}

/** 1 回の応答で送るメッセージ（1 通）。select は Chatwoot の input_select（ウィジェットにボタンが出る） */
export type Reply =
  | { readonly kind: "text"; readonly content: string }
  | { readonly kind: "select"; readonly content: string; readonly items: readonly ChoiceItem[] };

export type ConversationStatus = "open" | "resolved" | "pending" | "snoozed";

/** 会話の show の last_non_activity_message（活動メッセージを除いた最新の 1 件。仕様 7.4） */
export interface LastMessage {
  readonly id: number;
  readonly messageType: number;
  readonly senderType: string | null;
  /** content_attributes.in_reply_to（ボットは返事に必ず入れる。どの発言への返事かで、送信済みと古いイベントを見分ける） */
  readonly inReplyTo: number | null;
}

export interface ConversationView {
  readonly status: ConversationStatus;
  readonly labels: readonly string[];
  readonly lastMessage: LastMessage | null;
}
