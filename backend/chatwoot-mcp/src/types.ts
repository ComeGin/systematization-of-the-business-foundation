import type { ChatwootClient } from "./services/chatwoot-client.js";
import type { TimeZone } from "./services/time.js";

/** 各ツールの登録関数に渡す共有オブジェクト */
export interface ToolContext {
  client: ChatwootClient;
  tz: TimeZone;
}

export type ApiRecord = Record<string, unknown>;

/** メッセージの送信者（push_event_data）。type は user / contact / agent_bot / captain_assistant など */
export interface ChatwootSender {
  id: number;
  name?: string;
  available_name?: string;
  email?: string | null;
  phone_number?: string | null;
  identifier?: string | null;
  type?: string;
}

export interface ChatwootAttachment {
  id: number;
  file_type: string;
  data_url: string;
  file_size?: number;
  extension?: string | null;
}

export interface ChatwootMessage {
  id: number;
  content: string | null;
  /** 0: incoming, 1: outgoing, 2: activity, 3: template */
  message_type: number;
  content_type?: string;
  content_attributes?: ApiRecord;
  status?: string;
  private: boolean;
  created_at: number;
  sender?: ChatwootSender | null;
  attachments?: ChatwootAttachment[];
}

export interface ChatwootContactInbox {
  source_id: string;
  inbox?: { id: number; name: string; channel_type: string } | null;
}

export interface ChatwootContact {
  id: number;
  name: string | null;
  email: string | null;
  phone_number: string | null;
  identifier: string | null;
  blocked?: boolean;
  thumbnail?: string;
  availability_status?: string;
  additional_attributes: ApiRecord | null;
  custom_attributes: ApiRecord | null;
  created_at?: number;
  last_activity_at?: number;
  contact_inboxes?: ChatwootContactInbox[];
}

export interface ChatwootConversation {
  id: number;
  uuid: string;
  inbox_id: number;
  status: string;
  priority: string | null;
  labels: string[];
  muted: boolean;
  can_reply: boolean;
  unread_count: number;
  created_at: number;
  last_activity_at: number;
  waiting_since: number;
  first_reply_created_at: number;
  snoozed_until: string | null;
  custom_attributes: ApiRecord | null;
  additional_attributes: ApiRecord | null;
  last_non_activity_message?: ChatwootMessage | null;
  meta: {
    sender: ChatwootContact;
    channel: string | null;
    assignee?: { id: number; name?: string; available_name?: string } | null;
    assignee_type?: string;
    team?: { id: number; name: string } | null;
  };
}

/** 会話一覧・フィルタの件数（assignee_type ごと） */
export interface ConversationCounts {
  mine_count: number;
  assigned_count: number;
  unassigned_count: number;
  all_count: number;
}
